import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AppRepo,
  RepoSourceStatus,
  AppInstallPendingResponse,
  AppInstallResponse,
  AppPermission,
  PendingInstall,
  AppUpdate,
  AppUpdateApplyResponse,
  AppUpdatesResponse,
  RepoApp,
  RepoCatalogResponse,
  RepoConfigResponse,
} from "@opennas/shared";
import { APP_PERMISSIONS } from "@opennas/shared";
import { requireAdmin } from "../auth/plugin.js";
import { getSettingOr, setSetting } from "../db/settings.js";
import {
  DEFAULT_REPO,
  MAX_REPOS,
  enabledRepos,
  getRepo,
  isValidRepoUrl,
  listRepos,
  noteRepoName,
  normalizeUrl,
  repoIdFor,
  repoLabel,
  saveRepos,
} from "./repos.js";
import { getInstalledApp, listInstalledApps } from "../db/installed-apps.js";
import { AppError, commitPackage, validatePackage } from "./framework.js";
import { prepareInstall, reviewPackage, stagePackage } from "./staging.js";
import { notifyAdmins } from "../notifications/hub.js";

/**
 * Client for the configured app repositories (the default mirror is
 * repo.opennas.eu). Browsing + installing is admin-only. The backend fetches
 * catalogues and downloads packages server-side - a package then goes through
 * exactly the same validate → review → commit pipeline as a manual upload - and
 * proxies repo images so the SPA stays same-origin (tight CSP, no SSRF to
 * arbitrary hosts).
 *
 * Several repositories can be configured at once. They are merged in priority
 * order, and every app carries the id of the repository it came from so that
 * downloads, asset proxying and updates all go back to the right place.
 */

const AUTO_UPDATE_SETTING = "app_auto_update";
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** The primary (first enabled) repository - what single-repo callers mean. */
function repoUrl(): string {
  return enabledRepos()[0]?.url ?? DEFAULT_REPO;
}

async function repoFetch(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/** A repository failure the caller should surface with a specific status code. */
class RepoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

/** Normalise one catalogue entry from one repository. */
function toRepoApp(raw: unknown, repo: AppRepo, installed: Set<string>): RepoApp | null {
  const a = raw as Record<string, unknown>;
  const id = String(a.id ?? "");
  if (!ID_RE.test(id)) return null;
  const shots = Array.isArray(a.screenshots) ? a.screenshots : [];
  const asset = (kind: string, n?: number) =>
    `/apps/repo/asset?repo=${encodeURIComponent(repo.id)}&app=${encodeURIComponent(id)}&kind=${kind}` +
    (n === undefined ? "" : `&n=${n}`);
  return {
    id,
    repoId: repo.id,
    repoName: repoLabel(repo),
    name: String(a.name ?? id),
    version: String(a.version ?? ""),
    description: String(a.description ?? ""),
    category: String(a.category ?? "utilities"),
    author: String(a.author ?? ""),
    icon: String(a.icon ?? ""),
    iconGradient: String(a.iconGradient ?? "from-slate-400 to-slate-600"),
    signed: !!a.signed,
    publisherFingerprint: a.publisherFingerprint ? String(a.publisherFingerprint) : null,
    downloads: Number(a.downloads ?? 0),
    iconUrl: a.iconUrl ? asset("icon") : null,
    screenshots: shots.map((_, i) => asset("shot", i)),
    // Informational only - the authoritative list is read from the package
    // itself at install time, so a repo can't understate what an app wants.
    permissions: (Array.isArray(a.permissions) ? a.permissions : []).filter(
      (p): p is AppPermission => typeof p === "string" && (APP_PERMISSIONS as string[]).includes(p),
    ),
    installed: installed.has(id),
  };
}

/** Fetch one repository's catalogue. Never throws - the caller merges outcomes. */
async function loadOne(repo: AppRepo, installed: Set<string>): Promise<{ apps: RepoApp[]; name: string; error: string | null }> {
  try {
    const res = await repoFetch(`${repo.url}/v1/catalog`, 8000);
    if (!res.ok) return { apps: [], name: "", error: `The repository answered with HTTP ${res.status}.` };
    const data = (await res.json()) as { repository?: string; apps?: unknown[] };
    const apps = (Array.isArray(data.apps) ? data.apps : [])
      .map((raw) => toRepoApp(raw, repo, installed))
      .filter((a): a is RepoApp => a !== null);
    return { apps, name: String(data.repository ?? ""), error: null };
  } catch {
    return { apps: [], name: "", error: "Couldn't reach the repository." };
  }
}

/**
 * Fetch every enabled repository in parallel and merge them in priority order.
 *
 * One unreachable repository must not blank the catalogue - the others are
 * still perfectly usable - so failures are reported per repository in `sources`
 * rather than thrown. The only hard failure is having nothing to show at all.
 */
async function loadCatalog(): Promise<RepoCatalogResponse> {
  const repos = enabledRepos();
  if (repos.length === 0) {
    throw new RepoError(400, "no_repos", "No app repositories are configured.");
  }
  const installed = new Set(listInstalledApps().map((a) => a.manifest.id));
  const results = await Promise.all(repos.map((r) => loadOne(r, installed)));

  const apps: RepoApp[] = [];
  const claimed = new Set<string>();
  const sources: RepoSourceStatus[] = [];

  results.forEach((result, i) => {
    const repo = repos[i]!;
    if (result.name) noteRepoName(repo.id, result.name);
    let contributed = 0;
    let shadowed = 0;
    for (const app of result.apps) {
      // First repository to offer an id keeps it. Anything after is reported,
      // not merged: silently preferring a later repo's copy of an app id is how
      // a new repository takes over somebody else's app.
      if (claimed.has(app.id)) {
        shadowed++;
        continue;
      }
      claimed.add(app.id);
      apps.push(app);
      contributed++;
    }
    sources.push({
      id: repo.id,
      name: result.name || repoLabel(repo),
      url: repo.url,
      enabled: true,
      reachable: result.error === null,
      appCount: contributed,
      shadowed,
      error: result.error,
    });
  });

  if (sources.every((s) => !s.reachable)) {
    const where = sources.length === 1 ? ` at ${sources[0]!.url}` : "";
    throw new RepoError(502, "repo_unreachable", `Couldn't reach the app repository${where}.`);
  }

  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const primary = sources.find((s) => s.reachable) ?? sources[0]!;
  return { repository: primary.name, url: primary.url, apps, sources };
}

/**
 * Download one package. `repoId` says which repository to ask; when it's absent
 * or no longer configured the enabled repositories are tried in priority order,
 * which is what keeps an app installed before a repo was removed updatable.
 */
async function downloadPackage(id: string, repoId?: string | null): Promise<{ buf: Buffer; repoId: string }> {
  const pinned = repoId ? getRepo(repoId) : null;
  const candidates = pinned && pinned.enabled ? [pinned] : enabledRepos();
  if (candidates.length === 0) {
    throw new RepoError(400, "no_repos", "No app repositories are configured.");
  }
  let lastError: RepoError | null = null;
  for (const repo of candidates) {
    try {
      const res = await repoFetch(`${repo.url}/v1/apps/${id}/download`, 30000);
      if (!res.ok) {
        lastError = new RepoError(404, "not_found", "That app isn't on the repository.");
        continue;
      }
      const ab = await res.arrayBuffer();
      if (ab.byteLength > 64 * 1024 * 1024) throw new RepoError(413, "too_large", "That package is too large.");
      return { buf: Buffer.from(ab), repoId: repo.id };
    } catch (err) {
      if (err instanceof RepoError && err.code === "too_large") throw err;
      lastError = new RepoError(502, "repo_unreachable", "Couldn't download from the repository.");
    }
  }
  throw lastError ?? new RepoError(502, "repo_unreachable", "Couldn't download from the repository.");
}

// ---- Update checking -------------------------------------------------------

/**
 * Compare two semver-ish version strings; returns > 0 when `a` is newer than `b`.
 * Dotted numeric segments compare numerically and a trailing pre-release suffix
 * ("1.2.0-beta.1") sorts *before* the matching release. Versions we can't parse
 * compare as equal, so an odd version string never triggers a spurious update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? "" } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! - pb.nums[i]!;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a release outranks its own pre-releases
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

interface UpdateCheck {
  /** When this check ran (success or failure). */
  at: number;
  /** When the repository was last actually reached, or null. */
  successAt: number | null;
  updates: AppUpdate[];
  reachable: boolean;
}

/** Cached so opening App Center (or several admins doing so) doesn't hammer the repo. */
let lastCheck: UpdateCheck | null = null;
const CHECK_TTL_MS = 15 * 60 * 1000;
/** Retry sooner after a failure - a brief outage shouldn't blank updates for 15 min. */
const FAIL_TTL_MS = 60 * 1000;

/**
 * Diff installed app versions against the repository catalogue. Cached; pass
 * `force` to bypass the TTL. On an unreachable repo the previous result is kept
 * (flagged `reachable: false`) rather than reporting "no updates".
 */
async function checkForUpdates(force = false): Promise<UpdateCheck> {
  if (!force && lastCheck) {
    const ttl = lastCheck.reachable ? CHECK_TTL_MS : FAIL_TTL_MS;
    if (Date.now() - lastCheck.at < ttl) return lastCheck;
  }
  let apps: RepoApp[];
  try {
    apps = (await loadCatalog()).apps;
  } catch {
    lastCheck = {
      at: Date.now(),
      successAt: lastCheck?.successAt ?? null,
      updates: lastCheck?.updates ?? [],
      reachable: false,
    };
    return lastCheck;
  }
  const remoteById = new Map(apps.map((a) => [a.id, a]));
  const updates: AppUpdate[] = [];
  for (const installed of listInstalledApps()) {
    const remote = remoteById.get(installed.id);
    if (!remote || !remote.version) continue;
    // An app installed from repository A is not updated because repository B
    // happens to publish a higher version of the same id. Apps with no recorded
    // source (installed before this existed, or uploaded by hand) are matched
    // by id, which is the old behaviour and the best that can be done for them.
    if (installed.sourceRepo && remote.repoId !== installed.sourceRepo) continue;
    if (compareVersions(remote.version, installed.version) <= 0) continue;
    // Advisory: taken from the catalogue so the UI can flag "needs approval"
    // without downloading. The binding check is re-done from the real package
    // in applyUpdate, so a repo understating this changes nothing.
    const granted = installed.manifest.permissions ?? [];
    updates.push({
      newPermissions: (remote.permissions ?? []).filter((p) => !granted.includes(p)),
      id: installed.id,
      name: remote.name || installed.manifest.name,
      installedVersion: installed.version,
      availableVersion: remote.version,
      icon: remote.icon,
      iconGradient: remote.iconGradient,
      iconUrl: remote.iconUrl,
      signed: remote.signed,
    });
  }
  const now = Date.now();
  lastCheck = { at: now, successAt: now, updates, reachable: true };
  return lastCheck;
}

function autoUpdateEnabled(): boolean {
  return getSettingOr(AUTO_UPDATE_SETTING, "false") === "true";
}

/** Outcome of updating one app: it went in, or it's waiting for approval. */
type UpdateOutcome =
  | { kind: "updated"; id: string; name: string; version: string }
  | { kind: "pending"; pending: PendingInstall };

/**
 * Install the current repository version of one app. Same pipeline as a fresh
 * install - download, validate + verify, then commit - so the app's files are
 * replaced while the DB upsert keeps its enabled state and per-user data.
 *
 * The permission check is re-derived from the downloaded package here (not from
 * the catalogue), so a new version that quietly asks for more than the user
 * granted is staged for review instead of installed.
 */
async function applyUpdate(id: string): Promise<UpdateOutcome> {
  // Pinned to the repository this app was installed from. Without that, adding
  // a second repository that publishes the same app id at a higher version
  // would hand the app to a different publisher on the next update.
  const source = getInstalledApp(id)?.sourceRepo ?? null;
  const { buf, repoId } = await downloadPackage(id, source);
  const pkg = validatePackage(buf);
  const { needsConsent, details } = reviewPackage(pkg);
  // An update from an already-trusted publisher that asks for nothing new goes
  // straight in; anything else needs a person to look at it.
  if (needsConsent && details.newPermissions.length > 0) {
    return { kind: "pending", pending: stagePackage(pkg, details) };
  }
  const manifest = await commitPackage(pkg, repoId);
  return { kind: "updated", id: manifest.id, name: manifest.name, version: manifest.version ?? "0.0.0" };
}

/**
 * Background update checker. Runs shortly after boot and every 6 h thereafter;
 * when the admin has opted into automatic updates it also installs whatever the
 * check found. Returns a stop function for the server's onClose hook.
 */
export function startAppUpdateChecker(log: FastifyBaseLogger): () => void {
  const run = async (): Promise<void> => {
    const check = await checkForUpdates(true);
    if (!check.reachable || check.updates.length === 0) return;
    if (!autoUpdateEnabled()) {
      log.info({ count: check.updates.length }, "app updates available");
      notifyAdmins({
        level: "info",
        title: check.updates.length === 1 ? "An app update is available" : `${check.updates.length} app updates are available`,
        body: check.updates.map((u) => `${u.name} v${u.availableVersion}`).join(", "),
        appId: "app-center",
        dedupeKey: "app-updates-available",
      });
      return;
    }
    for (const u of check.updates) {
      try {
        const done = await applyUpdate(u.id);
        if (done.kind === "pending") {
          // Never silently widen what an app is allowed to do. This one waits
          // for an admin to approve it in App Center.
          log.warn(
            { app: u.id, wants: done.pending.newPermissions },
            "app update needs permission approval - not auto-installed",
          );
          notifyAdmins({
            level: "warning",
            title: `${u.name} v${u.availableVersion} needs your approval`,
            body: `The update asks for new permissions (${done.pending.newPermissions.join(", ")}), so it wasn't installed automatically. Review it in App Center.`,
            appId: "app-center",
            dedupeKey: `app-update-consent:${u.id}`,
          });
          continue;
        }
        log.info({ app: done.id, from: u.installedVersion, to: done.version }, "app auto-updated");
        notifyAdmins({
          level: "success",
          title: `${done.name} updated to v${done.version}`,
          body: `Automatically updated from v${u.installedVersion}.`,
          appId: "app-center",
        });
      } catch (err) {
        log.warn({ err, app: u.id }, "app auto-update failed");
      }
    }
    await checkForUpdates(true); // refresh the cache so the UI reflects the installs
  };
  const safeRun = () => void run().catch((err: unknown) => log.warn({ err }, "app update check failed"));

  const first = setTimeout(safeRun, 60_000);
  const timer = setInterval(safeRun, 6 * 60 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export async function repoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/", async (): Promise<RepoConfigResponse> => ({ repos: listRepos(), url: repoUrl() }));

  /**
   * Replace the whole list. Order is priority, so the client sends the list it
   * wants rather than patching entries - reordering is the common edit and a
   * patch API for it would be worse than a rewrite.
   */
  app.put("/", async (req, reply): Promise<RepoConfigResponse> => {
    const parsed = z
      .object({
        repos: z
          .array(
            z.object({
              url: z.string().trim().min(1).max(255),
              name: z.string().trim().max(64).optional(),
              enabled: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(MAX_REPOS),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: `Provide 1 to ${MAX_REPOS} repositories.` }) as never;
    }
    const bad = parsed.data.repos.find((r) => !isValidRepoUrl(normalizeUrl(r.url)));
    if (bad) {
      return reply.code(400).send({ error: "invalid_url", message: `"${bad.url}" isn't a valid http(s) repository URL.` }) as never;
    }
    if (!parsed.data.repos.some((r) => r.enabled !== false)) {
      return reply.code(400).send({
        error: "none_enabled",
        message: "At least one repository has to stay enabled, or App Center has nothing to show.",
      }) as never;
    }
    req.audit({ repos: parsed.data.repos.map((r) => r.url) });
    const saved = saveRepos(
      parsed.data.repos.map((r) => ({
        id: repoIdFor(normalizeUrl(r.url)),
        url: normalizeUrl(r.url),
        name: r.name ?? "",
        enabled: r.enabled !== false,
      })),
    );
    lastCheck = null; // a changed repo list makes the cached update diff meaningless
    return { repos: saved, url: repoUrl() };
  });

  app.get("/catalog", async (_req, reply): Promise<RepoCatalogResponse> => {
    try {
      return await loadCatalog();
    } catch (err) {
      const e = err as RepoError;
      return reply.code(e.status ?? 502).send({ error: e.code ?? "repo_unreachable", message: e.message }) as never;
    }
  });

  // Proxy a repo image (icon/screenshot) → same-origin so the SPA's CSP is happy.
  // The id/kind/n are validated and the URL is built from the trusted repo base,
  // so a client can't point this at an arbitrary host (no SSRF).
  app.get("/asset", async (req, reply) => {
    const q = z
      .object({
        app: z.string().regex(ID_RE),
        kind: z.enum(["icon", "shot"]),
        n: z.coerce.number().int().min(0).max(20).optional(),
        repo: z.string().regex(/^[a-f0-9]{12}$/).optional(),
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid", message: "Bad asset request." });
    // The base always comes from a *configured* repository, never from the
    // query - the id only selects among them, so this can't be pointed at an
    // arbitrary host.
    const repo = q.data.repo ? getRepo(q.data.repo) : enabledRepos()[0];
    if (!repo) return reply.code(404).send({ error: "not_found", message: "Unknown repository." });
    const path = q.data.kind === "icon" ? "icon" : `screenshot/${q.data.n ?? 0}`;
    try {
      const res = await repoFetch(`${repo.url}/v1/apps/${q.data.app}/${path}`, 8000);
      if (!res.ok) return reply.code(404).send({ error: "not_found", message: "Asset not found." });
      const buf = Buffer.from(await res.arrayBuffer());
      reply.header("Content-Type", res.headers.get("content-type") ?? "application/octet-stream");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "public, max-age=3600");
      return reply.send(buf);
    } catch {
      return reply.code(502).send({ error: "repo_unreachable", message: "Couldn't fetch the asset." });
    }
  });

  // One-click install from the repository. Replies 201 when it installed, or 202
  // with a PendingInstall when the admin has to approve what the app asks for -
  // the client then confirms via POST /apps/install/confirm.
  app.post("/install", async (req, reply): Promise<AppInstallResponse | AppInstallPendingResponse> => {
    const parsed = z
      .object({ id: z.string().regex(ID_RE), repo: z.string().regex(/^[a-f0-9]{12}$/).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a valid app id." }) as never;
    let buf: Buffer;
    let fromRepo: string;
    try {
      ({ buf, repoId: fromRepo } = await downloadPackage(parsed.data.id, parsed.data.repo));
    } catch (err) {
      const e = err as RepoError;
      return reply.code(e.status).send({ error: e.code, message: e.message }) as never;
    }
    try {
      const outcome = await prepareInstall(buf, fromRepo);
      if (outcome.kind === "pending") return reply.code(202).send({ pending: outcome.pending }) as never;
      lastCheck = null; // installed set changed → recompute on the next check
      return reply.code(201).send({ app: outcome.manifest }) as never;
    } catch (err) {
      if (err instanceof AppError) return reply.code(400).send({ error: "bad_package", message: err.message }) as never;
      req.log.error({ err }, "repo install failed");
      return reply.code(500).send({ error: "install_failed", message: "Could not install the app." }) as never;
    }
  });

  // ---- Updates ------------------------------------------------------------

  app.get("/updates", async (req): Promise<AppUpdatesResponse> => {
    const refresh = (req.query as { refresh?: string }).refresh === "1";
    const check = await checkForUpdates(refresh);
    return {
      updates: check.updates,
      checkedAt: check.successAt ? new Date(check.successAt).toISOString() : null,
      repoReachable: check.reachable,
      autoUpdate: autoUpdateEnabled(),
    };
  });

  app.put("/updates/auto", async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid request." });
    setSetting(AUTO_UPDATE_SETTING, parsed.data.enabled ? "true" : "false");
    return { ok: true, autoUpdate: parsed.data.enabled };
  });

  // Apply some or all pending updates. `ids` is filtered against the apps that
  // actually have an update pending, so this can't be used to install something
  // that isn't already on the box.
  app.post("/updates/apply", async (req, reply): Promise<AppUpdateApplyResponse> => {
    const parsed = z.object({ ids: z.array(z.string().regex(ID_RE)).max(64).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid request." }) as never;

    const check = await checkForUpdates(true);
    if (!check.reachable) {
      return reply.code(502).send({ error: "repo_unreachable", message: `Couldn't reach the repository at ${repoUrl()}.` }) as never;
    }
    const wanted = parsed.data.ids ? new Set(parsed.data.ids) : null;
    const targets = check.updates.filter((u) => !wanted || wanted.has(u.id));
    if (targets.length === 0) {
      return reply.code(404).send({ error: "no_updates", message: "There's nothing to update." }) as never;
    }

    const updated: AppUpdateApplyResponse["updated"] = [];
    const failed: AppUpdateApplyResponse["failed"] = [];
    const pending: PendingInstall[] = [];
    for (const target of targets) {
      try {
        const outcome = await applyUpdate(target.id);
        if (outcome.kind === "pending") pending.push(outcome.pending);
        else updated.push({ id: outcome.id, name: outcome.name, version: outcome.version });
      } catch (err) {
        const message =
          err instanceof RepoError || err instanceof AppError ? err.message : "Could not install the update.";
        if (!(err instanceof RepoError) && !(err instanceof AppError)) {
          req.log.error({ err, app: target.id }, "app update failed");
        }
        failed.push({ id: target.id, message });
      }
    }
    await checkForUpdates(true);
    return { updated, failed, pending };
  });
}
