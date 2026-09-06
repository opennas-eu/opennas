import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type {
  User,
  AppFetchResponse,
  AppFileEntry,
  AppFileReadResponse,
  AppFilesListResponse,
  AppInstallPendingResponse,
  AppInstallResponse,
  AppManifest,
  AppPermission,
  AppSettingsResponse,
  AppShareEntry,
  AppShareGrantsResponse,
  AppShareListResponse,
  UserAppGrantsResponse,
  AppStorageListResponse,
  AppStorageValueResponse,
  AppSystemInfo,
  AppSystemResponse,
  AppsResponse,
  DevAppsResponse,
  ManagedAppsResponse,
  ScheduledAction,
  ScheduledTasksResponse,
} from "@opennas/shared";
import { APP_PERMISSIONS } from "@opennas/shared";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { config } from "../config.js";
import { appsForUser } from "./registry.js";
import { canUseApp, forgetApp } from "../db/app-access.js";
import { getDisks, getStaticInfo, sample } from "../system/collector.js";
import { AppError, commitPackage, resolveAppDataPath, uninstallApp } from "./framework.js";
import { discardStaged, discardStagedFor, prepareInstall, takeStaged } from "./staging.js";
import { coerceValue, resolveSettings, setAppSetting } from "../db/app-settings.js";
import { MAX_DEV_APPS, devManifests, isValidDevUrl, listDevApps, saveDevApps } from "./dev-apps.js";
import { FetchDenied, proxyFetch } from "./fetch-proxy.js";
import { MAX_INTERVAL_SECONDS, MAX_TASKS_PER_APP, MIN_INTERVAL_SECONDS } from "./scheduler.js";
import { countTasks, deleteTask, deleteTasksForApp, getTask, listTasks, upsertTask } from "../db/scheduled-tasks.js";
import { repoRoutes } from "./repo.js";
import { isTrusted, setTrusted } from "./trust.js";
import {
  grantPath,
  listAllGrantsForUser,
  listGrants,
  resolveGrant,
  revokeAllForApp,
  revokeGrant,
  revokeGrantForUser,
} from "../db/app-grants.js";
import { accessibleShareNames, pathAccess } from "../files/access.js";
import { isShareRoot, resolveSafe } from "../files/paths.js";
import { mimeOf } from "../files/mime.js";

/**
 * Apps read and write shared files as text through the bridge, which carries
 * everything as JSON over postMessage - so the cap is about what is sane to send
 * through that, not what the filesystem can hold. Bigger files are what File
 * Station is for.
 */
const MAX_SHARE_READ_BYTES = 4 * 1024 * 1024;
import {
  deleteAppStorage,
  getAppStorage,
  getInstalledApp,
  listAppStorage,
  listInstalledApps,
  setAppEnabled,
  setAppStorage,
} from "../db/installed-apps.js";

/**
 * Run a package through the install pipeline and reply: 201 when it installed,
 * 202 + a PendingInstall when the admin needs to approve what it asks for.
 * Shared by the upload route and the repo's one-click install.
 */
async function beginInstall(
  req: FastifyRequest,
  reply: FastifyReply,
  buf: Buffer,
): Promise<AppInstallResponse | AppInstallPendingResponse> {
  try {
    const outcome = await prepareInstall(buf);
    if (outcome.kind === "pending") return reply.code(202).send({ pending: outcome.pending }) as never;
    return reply.code(201).send({ app: outcome.manifest }) as never;
  } catch (err) {
    if (err instanceof AppError) return reply.code(400).send({ error: "bad_package", message: err.message }) as never;
    req.log.error({ err }, "app install failed");
    return reply.code(500).send({ error: "install_failed", message: "Could not install the app." }) as never;
  }
}

export async function appsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Map path-safety errors (e.g. an app trying to escape its data folder) to 400.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(400).send({ error: "bad_path", message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid", message: "Invalid request." });
    req.log.error({ err }, "apps route error");
    return reply.code(500).send({ error: "server_error", message: "Something went wrong." });
  });

  app.get("/", async (req): Promise<AppsResponse> => {
    return { apps: appsForUser(req.auth!.user) };
  });

  // Remote app repository (browse + one-click install). Admin-only; nested at /apps/repo.
  await app.register(repoRoutes, { prefix: "/repo" });

  // ---- Install / uninstall (admin) --------------------------------------
  app.post("/install", { preHandler: requireAdmin }, async (req, reply): Promise<AppInstallResponse | AppInstallPendingResponse> => {
    // Cap the *compressed* upload here; validatePackage pre-checks the declared
    // *uncompressed* size before decompressing (zip-bomb defense).
    const part = await req.file({ limits: { fileSize: 64 * 1024 * 1024 } }).catch(() => null);
    if (!part) return reply.code(400).send({ error: "no_file", message: "Upload a .onpkg package." }) as never;
    const buf = await part.toBuffer();
    if (part.file.truncated) {
      return reply.code(413).send({ error: "too_large", message: "That package is too large." }) as never;
    }
    return beginInstall(req, reply, buf);
  });

  /**
   * Commit a package the admin reviewed and approved. The token is single-use and
   * short-lived; the permissions are re-derived from the staged package here, so
   * approving one package can never install a different one.
   */
  app.post("/install/confirm", { preHandler: requireAdmin }, async (req, reply): Promise<AppInstallResponse> => {
    const parsed = z.object({ token: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide the pending install token." }) as never;
    const s = takeStaged(parsed.data.token);
    if (!s) {
      return reply.code(410).send({ error: "expired", message: "That install expired. Start it again." }) as never;
    }
    // The token alone says nothing; the point of the entry is *what was granted*.
    req.audit({
      app: s.pending.appId,
      version: s.pending.version,
      permissions: s.pending.permissions,
      newPermissions: s.pending.newPermissions,
      fetchHosts: s.pending.fetchHosts,
      signed: s.pending.signed,
      verified: s.pending.verified,
      isUpdate: s.pending.isUpdate,
    });
    try {
      const manifest = await commitPackage(s.pkg, s.sourceRepo);
      return reply.code(201).send({ app: manifest });
    } catch (err) {
      req.log.error({ err, app: s.pending.appId }, "app install failed after approval");
      return reply.code(500).send({ error: "install_failed", message: "Could not install the app." }) as never;
    }
  });

  /** Decline a pending install - drops the staged package immediately. */
  app.post("/install/cancel", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ token: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide the pending install token." });
    return { ok: discardStaged(parsed.data.token) };
  });

  app.delete("/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const installed = getInstalledApp(id);
    if (!installed) return reply.code(404).send({ error: "not_found", message: "App not installed." });
    req.audit({ app: id, version: installed.version, name: installed.manifest.name });
    await uninstallApp(id);
    deleteTasksForApp(id); // no app left to schedule work for
    revokeAllForApp(id); // folders granted to it die with it, for every user
    discardStagedFor(id); // a staged update for a now-gone app would be an install
    // Otherwise reinstalling later would silently restore whatever access the
    // app had the first time, to people an admin has since excluded.
    forgetApp(id);
    return { ok: true };
  });

  // Management view (admin): ALL installed external apps, incl. disabled ones.
  app.get("/manage", { preHandler: requireAdmin }, async (): Promise<ManagedAppsResponse> => ({
    apps: listInstalledApps().map((a) => ({
      manifest: a.manifest,
      enabled: a.enabled,
      installedAt: a.installedAt,
      verified: !!a.manifest.signed && isTrusted(a.manifest.publisherFingerprint),
    })),
  }));

  // Trust / untrust an app's publisher (its key fingerprint), admin.
  app.post("/:id/trust", { preHandler: requireAdmin }, async (req, reply) => {
    const installed = getInstalledApp((req.params as { id: string }).id);
    if (!installed) return reply.code(404).send({ error: "not_found", message: "App not installed." });
    const fp = installed.manifest.publisherFingerprint;
    if (!installed.manifest.signed || !fp) {
      return reply.code(400).send({ error: "unsigned", message: "This app isn't signed, so its publisher can't be trusted." });
    }
    const parsed = z.object({ trusted: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid request." });
    // A trust decision is the thing that makes future installs silent, so the
    // fingerprint it applies to belongs in the record.
    req.audit({ app: installed.manifest.id, publisher: installed.manifest.author, fingerprint: fp });
    setTrusted(fp, parsed.data.trusted);
    return { ok: true, trusted: parsed.data.trusted };
  });

  app.post("/:id/enabled", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getInstalledApp(id)) return reply.code(404).send({ error: "not_found", message: "App not installed." });
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid request." });
    setAppEnabled(id, parsed.data.enabled);
    return { ok: true, enabled: parsed.data.enabled };
  });

  /**
   * The app behind a capability request, whether it was installed from a
   * package or registered as a development build.
   *
   * Every capability gate below asks this rather than `getInstalledApp`
   * directly: a dev app is exactly the thing an author is trying to exercise,
   * and one that can't reach storage or files is useless for developing an app
   * that uses them. Permissions are still read from the manifest, so a dev app
   * only gets what the admin granted it when registering it.
   */
  /**
   * The app behind an `:id` in a route, or null.
   *
   * Every per-app route goes through here, which is why the access check lives
   * here too rather than in each of them. A user who isn't allowed an app gets
   * exactly the same answer as one asking for an app that doesn't exist - the
   * 404 is deliberate, since "you may not use this" and "this isn't installed"
   * are the same fact from the caller's side, and distinguishing them would tell
   * a restricted user what else is on the machine.
   */
  function resolveApp(id: string, user: Pick<User, "id" | "role">): { manifest: AppManifest; isDev: boolean } | null {
    const found = lookupApp(id);
    if (!found) return null;
    return canUseApp(user, id) ? found : null;
  }

  /**
   * The app behind an id, with no access check.
   *
   * Only for turning an id into a display name. Every place that decides what
   * someone may *do* goes through `resolveApp` instead - this exists so a grant
   * the user made earlier still reads as "Notes" rather than as a bare id after
   * an admin narrows their app list.
   */
  function lookupApp(id: string): { manifest: AppManifest; isDev: boolean } | null {
    const installed = getInstalledApp(id);
    if (installed) return { manifest: installed.manifest, isDev: false };
    const dev = devManifests().find((m) => m.id === id);
    return dev ? { manifest: dev, isDev: true } : null;
  }

  // ---- Development apps ---------------------------------------------------
  //
  // Admin-only, off by default, and restricted to loopback. The sandbox and the
  // permission checks are exactly the same as for a packaged app - the only
  // difference is that the iframe loads from a dev server, which is why each
  // entry widens the desktop's `frame-src` by precisely one origin.

  app.get("/dev", { preHandler: requireAdmin }, async (): Promise<DevAppsResponse> => ({
    apps: listDevApps(),
    available: true,
  }));

  app.put("/dev", { preHandler: requireAdmin }, async (req, reply): Promise<DevAppsResponse> => {
    const parsed = z
      .object({
        apps: z
          .array(
            z.object({
              id: z.string().trim().min(2).max(64),
              name: z.string().trim().min(1).max(64),
              url: z.string().trim().min(1).max(255),
              permissions: z
                .array(z.string().refine((p) => (APP_PERMISSIONS as readonly string[]).includes(p)))
                .max(APP_PERMISSIONS.length)
                .optional(),
              enabled: z.boolean().optional(),
            }),
          )
          .max(MAX_DEV_APPS),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: `Provide up to ${MAX_DEV_APPS} development apps.` }) as never;
    }
    const badUrl = parsed.data.apps.find((a) => !isValidDevUrl(a.url.replace(/\/+$/, "")));
    if (badUrl) {
      return reply.code(400).send({
        error: "bad_url",
        message: `"${badUrl.url}" isn't usable - a development app must be served from localhost over http or https.`,
      }) as never;
    }
    // An id that collides with something installed would shadow it in the
    // launcher, which is a confusing way to lose a real app.
    const clash = parsed.data.apps.find((a) => getInstalledApp(a.id.toLowerCase()) !== null);
    if (clash) {
      return reply.code(409).send({
        error: "id_taken",
        message: `"${clash.id}" is already an installed app - give the development build a different id.`,
      }) as never;
    }
    req.audit({ apps: parsed.data.apps.map((a) => ({ id: a.id, url: a.url, permissions: a.permissions ?? [] })) });
    const saved = saveDevApps(
      parsed.data.apps.map((a) => ({
        id: a.id.toLowerCase(),
        name: a.name,
        url: a.url.replace(/\/+$/, ""),
        permissions: (a.permissions ?? []) as AppPermission[],
        enabled: a.enabled !== false,
      })),
    );
    return { apps: saved, available: true };
  });

  // ---- Per-app settings ---------------------------------------------------
  //
  // The form itself is rendered by OpenNAS, not by the app: the fields are
  // declared in the manifest and the inputs live in the trusted UI, so an app
  // never sees what is typed into its own settings until it is saved - and an
  // admin-scoped field is never editable by a regular user, whatever the app
  // asks for.

  app.get("/:id/settings", async (req, reply): Promise<AppSettingsResponse> => {
    const id = (req.params as { id: string }).id;
    const app_ = resolveApp(id, req.auth!.user);
    if (!app_) return reply.code(404).send({ error: "not_found", message: "App not installed." }) as never;
    const fields = app_.manifest.settings ?? [];
    const isAdmin = req.auth!.user.role === "admin";
    return {
      appId: id,
      // A regular user is not shown admin-scoped fields at all - a disabled
      // input still discloses the value, which for a secret field is the whole
      // thing worth protecting.
      fields: isAdmin ? fields : fields.filter((f) => f.scope !== "admin"),
      values: resolveSettings(id, isAdmin ? fields : fields.filter((f) => f.scope !== "admin"), req.auth!.user.id),
      canEditAdmin: isAdmin,
    };
  });

  app.put("/:id/settings", async (req, reply): Promise<AppSettingsResponse> => {
    const id = (req.params as { id: string }).id;
    const app_ = resolveApp(id, req.auth!.user);
    if (!app_) return reply.code(404).send({ error: "not_found", message: "App not installed." }) as never;
    const parsed = z.object({ values: z.record(z.unknown()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a values object." }) as never;

    const fields = app_.manifest.settings ?? [];
    const isAdmin = req.auth!.user.role === "admin";
    const rejected: string[] = [];
    const applied: string[] = [];

    for (const [key, raw] of Object.entries(parsed.data.values)) {
      const field = fields.find((f) => f.key === key);
      // A key the app doesn't declare is dropped rather than stored: otherwise
      // this is an unbounded key/value store with no quota behind it.
      if (!field) { rejected.push(key); continue; }
      if (field.scope === "admin" && !isAdmin) { rejected.push(key); continue; }
      const value = coerceValue(field, raw);
      if (value === null) { rejected.push(key); continue; }
      setAppSetting(id, field, req.auth!.user.id, value);
      applied.push(key);
    }

    if (applied.length === 0 && rejected.length > 0) {
      return reply.code(400).send({
        error: "invalid_values",
        message: `Nothing could be saved - check: ${rejected.slice(0, 5).join(", ")}.`,
      }) as never;
    }
    // Secret fields are redacted by the audit hook's key matching; the keys
    // themselves are what makes the entry worth reading.
    req.audit({ app: id, keys: applied, rejected });

    const visible = isAdmin ? fields : fields.filter((f) => f.scope !== "admin");
    return { appId: id, fields: visible, values: resolveSettings(id, visible, req.auth!.user.id), canEditAdmin: isAdmin };
  });

  // ---- Per-app key/value storage (SDK "storage" permission) -------------
  // Require the app to be installed AND to have declared the "storage" capability;
  // values are always scoped to the calling user.
  function requireStorageApp(id: string, user: Pick<User, "id" | "role">): { ok: true } | { ok: false; code: number; message: string } {
    const app_ = resolveApp(id, user);
    if (!app_) return { ok: false, code: 404, message: "App not installed." };
    if (!app_.manifest.permissions?.includes("storage")) {
      return { ok: false, code: 403, message: "This app didn't request storage access." };
    }
    return { ok: true };
  }

  const keyParam = z.object({ key: z.string().min(1).max(256) });

  app.get("/:id/storage", async (req, reply): Promise<AppStorageListResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireStorageApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    return { values: listAppStorage(id, req.auth!.user.id) };
  });

  app.get("/:id/storage/:key", async (req, reply): Promise<AppStorageValueResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireStorageApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    const p = keyParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid", message: "Bad key." }) as never;
    return { value: getAppStorage(id, req.auth!.user.id, p.data.key) };
  });

  app.put("/:id/storage/:key", async (req, reply): Promise<AppStorageValueResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireStorageApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    const p = keyParam.safeParse(req.params);
    const body = z.object({ value: z.string().max(256 * 1024) }).safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: "invalid", message: "Bad key or value." }) as never;
    setAppStorage(id, req.auth!.user.id, p.data.key, body.data.value);
    return { value: body.data.value };
  });

  app.delete("/:id/storage/:key", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const gate = requireStorageApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });
    const p = keyParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid", message: "Bad key." });
    deleteAppStorage(id, req.auth!.user.id, p.data.key);
    return { ok: true };
  });

  // ---- Read-only system stats (SDK "system" permission) ------------------

  function requireSystemApp(id: string, user: Pick<User, "id" | "role">): { ok: true } | { ok: false; code: number; message: string } {
    const app_ = resolveApp(id, user);
    if (!app_) return { ok: false, code: 404, message: "App not installed." };
    if (!app_.manifest.permissions?.includes("system")) {
      return { ok: false, code: 403, message: "This app didn't request system access." };
    }
    return { ok: true };
  }

  /**
   * Shared 1-second snapshot. Sampling spawns real work (systeminformation shells
   * out for some of it), so an app polling in a tight loop - or several apps
   * polling at once - collapses onto one sample rather than one per request.
   */
  let snapshot: { at: number; value: Promise<AppSystemInfo> } | null = null;

  async function buildSystemInfo(): Promise<AppSystemInfo> {
    const [staticInfo, live, disks] = await Promise.all([getStaticInfo(), sample(), getDisks()]);
    const storage = disks.reduce(
      (acc, d) => ({ totalBytes: acc.totalBytes + d.sizeBytes, usedBytes: acc.usedBytes + d.usedBytes }),
      { totalBytes: 0, usedBytes: 0 },
    );
    const network = live.network.reduce(
      (acc, n) => ({ rxBytesPerSec: acc.rxBytesPerSec + n.rxBytesPerSec, txBytesPerSec: acc.txBytesPerSec + n.txBytesPerSec }),
      { rxBytesPerSec: 0, txBytesPerSec: 0 },
    );
    return {
      os: staticInfo.os,
      cpu: {
        brand: staticInfo.cpu.brand,
        cores: staticInfo.cpu.cores,
        loadPercent: live.cpu.total,
        perCorePercent: live.cpu.perCore,
        temperatureC: live.temperature.mainC,
      },
      memory: {
        totalBytes: live.memory.totalBytes,
        usedBytes: live.memory.usedBytes,
        freeBytes: live.memory.freeBytes,
      },
      storage: { ...storage, freeBytes: Math.max(0, storage.totalBytes - storage.usedBytes) },
      network,
      uptimeSeconds: live.uptimeSeconds,
      version: config.version,
    };
  }

  app.get("/:id/system", async (req, reply): Promise<AppSystemResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireSystemApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    if (!snapshot || Date.now() - snapshot.at > 1000) {
      snapshot = { at: Date.now(), value: buildSystemInfo() };
    }
    try {
      return { system: await snapshot.value };
    } catch (err) {
      snapshot = null; // don't cache a rejected sample
      req.log.warn({ err }, "system snapshot failed");
      return reply.code(503).send({ error: "unavailable", message: "System stats aren't available right now." }) as never;
    }
  });

  // ---- Outbound HTTP (SDK "fetch" permission) ----------------------------

  /**
   * Per-app call budget. The global limiter is per-IP, and every app request
   * arrives from the same browser, so a runaway app would otherwise be free to
   * hammer a third party using the NAS's address.
   */
  const FETCH_PER_MINUTE = 120;
  const fetchCalls = new Map<string, { windowStart: number; count: number }>();

  function withinFetchBudget(id: string): boolean {
    const now = Date.now();
    const entry = fetchCalls.get(id);
    if (!entry || now - entry.windowStart >= 60_000) {
      fetchCalls.set(id, { windowStart: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= FETCH_PER_MINUTE;
  }

  const fetchBody = z.object({
    url: z.string().min(1).max(2048),
    method: z.string().max(10).optional(),
    headers: z.record(z.string().max(4096)).optional(),
    body: z.string().max(1024 * 1024).optional(),
  });

  app.post("/:id/fetch", async (req, reply): Promise<AppFetchResponse> => {
    const id = (req.params as { id: string }).id;
    const app_ = resolveApp(id, req.auth!.user);
    if (!app_) return reply.code(404).send({ error: "not_found", message: "App not installed." }) as never;
    if (!app_.manifest.permissions?.includes("fetch")) {
      return reply.code(403).send({ error: "forbidden", message: "This app didn't request network access." }) as never;
    }
    const allowed = app_.manifest.fetchHosts ?? [];
    if (allowed.length === 0) {
      return reply.code(403).send({ error: "forbidden", message: "This app has no allowed hosts." }) as never;
    }
    const parsed = fetchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid fetch request." }) as never;
    if (!withinFetchBudget(id)) {
      return reply.code(429).send({ error: "rate_limited", message: "This app is making too many requests." }) as never;
    }

    try {
      return await proxyFetch(parsed.data, allowed);
    } catch (err) {
      if (err instanceof FetchDenied) {
        return reply.code(403).send({ error: "fetch_denied", message: err.message }) as never;
      }
      req.log.error({ err, app: id }, "app fetch failed");
      return reply.code(502).send({ error: "fetch_failed", message: "The request could not be completed." }) as never;
    }
  });

  // ---- Scheduled tasks (SDK "schedule" permission) -----------------------

  const actionSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("notify"),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(1000).optional(),
      level: z.enum(["info", "success", "warning", "critical"]).optional(),
    }),
    z.object({
      kind: z.literal("fetch"),
      url: z.string().min(1).max(2048),
      method: z.string().max(10).optional(),
      headers: z.record(z.string().max(4096)).optional(),
      storeAs: z.string().min(1).max(256),
    }),
  ]);

  const taskSchema = z.object({
    name: z.string().trim().min(1).max(64),
    intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
    action: actionSchema,
    enabled: z.boolean().optional(),
  });

  /**
   * Scheduling is not authority of its own - it defers work the app could already
   * do. So a task is only accepted if the app holds the permission its action
   * needs, and the scheduler re-checks that again at run time.
   */
  function gateSchedule(
    id: string,
    user: Pick<User, "id" | "role">,
    action?: ScheduledAction,
  ): { ok: true } | { ok: false; code: number; message: string } {
    const app_ = resolveApp(id, user);
    if (!app_) return { ok: false, code: 404, message: "App not installed." };
    const held = app_.manifest.permissions ?? [];
    if (!held.includes("schedule")) {
      return { ok: false, code: 403, message: "This app didn't request scheduling." };
    }
    if (action?.kind === "notify" && !held.includes("notifications")) {
      return { ok: false, code: 403, message: "A notify task needs the notifications permission." };
    }
    if (action?.kind === "fetch") {
      if (!held.includes("fetch")) return { ok: false, code: 403, message: "A fetch task needs the fetch permission." };
      if (!held.includes("storage")) return { ok: false, code: 403, message: "A fetch task needs the storage permission." };
    }
    return { ok: true };
  }

  app.get("/:id/schedule", async (req, reply): Promise<ScheduledTasksResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = gateSchedule(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    return { tasks: listTasks(id, req.auth!.user.id) };
  });

  app.put("/:id/schedule", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: "invalid",
        message: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid task.",
      });
    }
    const gate = gateSchedule(id, req.auth!.user, parsed.data.action);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });

    const userId = req.auth!.user.id;
    // Only count against the cap when it's a genuinely new task.
    if (!getTask(id, userId, parsed.data.name) && countTasks(id, userId) >= MAX_TASKS_PER_APP) {
      return reply.code(409).send({ error: "too_many", message: `An app may have at most ${MAX_TASKS_PER_APP} scheduled tasks.` });
    }
    return { task: upsertTask({ appId: id, userId, ...parsed.data }) };
  });

  app.delete("/:id/schedule/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const gate = gateSchedule(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });
    if (!deleteTask(id, req.auth!.user.id, name)) {
      return reply.code(404).send({ error: "not_found", message: "No such task." });
    }
    return { ok: true };
  });

  // ---- Per-app, per-user file storage (SDK "files" permission) -----------
  // Scoped entirely to <appDataDir>/<id>/<userId>/ - never the user's shares.
  function requireFilesApp(id: string, user: Pick<User, "id" | "role">): { ok: true } | { ok: false; code: number; message: string } {
    const app_ = resolveApp(id, user);
    if (!app_) return { ok: false, code: 404, message: "App not installed." };
    if (!app_.manifest.permissions?.includes("files")) {
      return { ok: false, code: 403, message: "This app didn't request file access." };
    }
    return { ok: true };
  }

  app.get("/:id/files", async (req, reply): Promise<AppFilesListResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    const real = resolveAppDataPath(id, req.auth!.user.id, (req.query as { path?: string }).path ?? "/");
    const dirents = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!dirents) return { entries: [] }; // folder doesn't exist yet → empty
    const entries: AppFileEntry[] = [];
    for (const d of dirents) {
      const s = await stat(`${real}/${d.name}`).catch(() => null);
      if (!s) continue;
      entries.push({
        name: d.name,
        type: d.isDirectory() ? "dir" : "file",
        sizeBytes: d.isDirectory() ? 0 : s.size,
        modifiedAt: s.mtime.toISOString(),
      });
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    return { entries };
  });

  app.get("/:id/files/content", async (req, reply): Promise<AppFileReadResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    const real = resolveAppDataPath(id, req.auth!.user.id, (req.query as { path?: string }).path ?? "");
    const s = await stat(real).catch(() => null);
    if (!s) return { content: null };
    if (s.isDirectory()) return reply.code(400).send({ error: "is_dir", message: "That path is a folder." }) as never;
    if (s.size > 4 * 1024 * 1024) return reply.code(413).send({ error: "too_large", message: "File is too large to read." }) as never;
    return { content: await readFile(real, "utf8") };
  });

  const writeBody = z.object({ content: z.string().max(1024 * 1024) });
  app.put("/:id/files", async (req, reply): Promise<AppFileReadResponse> => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message }) as never;
    const body = writeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", message: "Provide string content (≤ 1 MB)." }) as never;
    const real = resolveAppDataPath(id, req.auth!.user.id, (req.query as { path?: string }).path ?? "");
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, body.data.content, "utf8");
    return { content: body.data.content };
  });

  app.post("/:id/files/mkdir", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });
    const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", message: "Provide a folder path." });
    await mkdir(resolveAppDataPath(id, req.auth!.user.id, body.data.path), { recursive: true });
    return { ok: true };
  });

  app.delete("/:id/files", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });
    const real = resolveAppDataPath(id, req.auth!.user.id, (req.query as { path?: string }).path ?? "");
    await rm(real, { recursive: true, force: true });
    return { ok: true };
  });



  // ---- Binary and large files ----------------------------------------------
  //
  // Text through the SDK bridge is capped at a few megabytes, which rules out
  // most of what anyone would actually write for a NAS: a photo tool, an audio
  // player, anything that produces or consumes a file rather than a string. The
  // two routes below are the bytes path - an upload that streams to disk instead
  // of being buffered as a JSON string, and a download that streams back.
  //
  // Nothing here widens what an app may *reach*. Both go through exactly the
  // same gates as their text equivalents: the private ones are confined to
  // `<appDataDir>/<id>/<userId>/`, and the share ones end at `resolveGrant`,
  // which re-checks the user's own access on every call.

  /**
   * Serve a file's bytes, with a header set that assumes the content is hostile.
   *
   * The same treatment `/api/files/raw` gives user content, and for the same
   * reason: these bytes are served from the OpenNAS origin, and an app that
   * could get an HTML file rendered there rather than downloaded would have
   * escaped its sandbox. `sandbox` with no allow-list, a null default-src and
   * nosniff between them mean the browser will store it and nothing else.
   *
   * Range requests are honoured so an app can put a video in a `<video>` and
   * have seeking work, rather than pulling the whole file to play the end.
   */
  async function sendBytes(req: FastifyRequest, reply: FastifyReply, real: string, name: string) {
    const st = await stat(real).catch(() => null);
    if (!st || !st.isFile()) {
      return reply.code(404).send({ error: "not_found", message: "No such file." });
    }
    const total = st.size;
    reply
      .header("Content-Type", mimeOf(name) ?? "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`)
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "private, max-age=0")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");

    const m = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null;
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : NaN;
      if (Number.isNaN(start)) {
        start = Math.max(0, total - end);
        end = total - 1;
      } else if (Number.isNaN(end)) {
        end = total - 1;
      }
      if (start > end || start >= total || total === 0) {
        return reply.code(416).header("Content-Range", `bytes */${total}`).send();
      }
      end = Math.min(end, total - 1);
      return reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${total}`)
        .header("Content-Length", end - start + 1)
        .send(createReadStream(real, { start, end }));
    }

    return reply.header("Content-Length", total).send(createReadStream(real));
  }

  /**
   * Take the one uploaded file from a multipart request and stream it to `real`.
   *
   * Written to a sibling temp name and renamed into place, so a connection that
   * drops halfway leaves the previous version intact rather than a truncated
   * file that looks complete. `limitBytes` is enforced by the stream itself
   * rather than by trusting a declared length, which a client writes.
   */
  async function receiveBytes(
    req: FastifyRequest,
    real: string,
    limitBytes: number,
  ): Promise<{ ok: true; bytes: number } | { ok: false; code: number; message: string }> {
    const part = await req.file().catch(() => null);
    if (!part) return { ok: false, code: 400, message: "Send the file as multipart form data." };

    await mkdir(dirname(real), { recursive: true });
    const temp = `${real}.part-${randomUUID().slice(0, 8)}`;
    let bytes = 0;
    let tooBig = false;
    try {
      const sink = createWriteStream(temp, { mode: 0o600 });
      part.file.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limitBytes) tooBig = true;
      });
      await pipeline(part.file, sink);
      // `truncated` is fastify-multipart's own limit; `tooBig` is ours.
      if (tooBig || part.file.truncated) {
        await rm(temp, { force: true });
        return { ok: false, code: 413, message: "That file is larger than an app may write here." };
      }
      await rename(temp, real);
      return { ok: true, bytes };
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  /**
   * How much one file an app writes into its own sandbox may weigh.
   *
   * A cap exists because the app sandbox lives on the system partition, and an
   * app that can write without bound there can fill the disk OpenNAS itself runs
   * from. Files the *user* picked are a different matter - those land in their
   * own shares, on their own storage, and are bounded by the share quota.
   *
   * Note this is per file and not a total: there is no per-app storage quota
   * yet, so a determined app can still write many files. That is worth having
   * and isn't here.
   */
  const MAX_APP_FILE_BYTES = 512 * 1024 * 1024;

  app.post("/:id/files/upload", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });
    const path = (req.query as { path?: string }).path ?? "";
    if (!path) return reply.code(400).send({ error: "invalid", message: "Provide a path." });
    const real = resolveAppDataPath(id, req.auth!.user.id, path);
    const result = await receiveBytes(req, real, MAX_APP_FILE_BYTES);
    if (!result.ok) return reply.code(result.code).send({ error: "upload_failed", message: result.message });
    return { ok: true, bytes: result.bytes };
  });

  app.get("/:id/files/raw", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const gate = requireFilesApp(id, req.auth!.user);
    if (!gate.ok) return reply.code(gate.code).send({ error: "forbidden", message: gate.message });
    const path = (req.query as { path?: string }).path ?? "";
    const real = resolveAppDataPath(id, req.auth!.user.id, path);
    return sendBytes(req, reply, real, basename(path) || "download");
  });

  // ---- What the signed-in user has given to apps ----------------------------

  // Per-user and app-agnostic, because "which folders can apps see?" is a
  // question about the person, not about one app. Lives here rather than under
  // /:id so it doesn't collide with an app id.

  app.get("/grants", async (req): Promise<UserAppGrantsResponse> => {
    const grants = listAllGrantsForUser(req.auth!.user.id).map((g) => {
      const resolved = lookupApp(g.appId);
      return {
        ...g,
        appName: resolved?.manifest.name ?? g.appId,
        // An uninstalled app's row grants nothing, but showing it lets someone
        // tidy up rather than wonder what it was.
        appInstalled: resolved !== null,
      };
    });
    return { grants };
  });

  app.delete("/grants/:handle", async (req): Promise<UserAppGrantsResponse> => {
    const handle = (req.params as { handle: string }).handle;
    req.audit({ handle });
    revokeGrantForUser(req.auth!.user.id, handle);
    const grants = listAllGrantsForUser(req.auth!.user.id).map((g) => {
      const resolved = lookupApp(g.appId);
      return { ...g, appName: resolved?.manifest.name ?? g.appId, appInstalled: resolved !== null };
    });
    return { grants };
  });

  // ---- The user's real shared folders ---------------------------------------

  // Distinct from `/:id/files`, which is a private per-app sandbox. These reach
  // the actual NAS contents, so every one of them ends at `resolveGrant`, which
  // re-checks the *user's* own access on each call - a grant only ever narrows
  // what they could already do.

  /** What this app is allowed to ask for, from its manifest. */
  function sharePermissions(id: string, user: Pick<User, "id" | "role">): { read: boolean; write: boolean } | null {
    const app_ = resolveApp(id, user);
    if (!app_) return null;
    const perms = app_.manifest.permissions ?? [];
    const write = perms.includes("shares:write");
    // Write implies read: an app that can modify a folder can obviously see it,
    // and making a manifest declare both would just be a trap.
    return { read: write || perms.includes("shares:read"), write };
  }

  /** Resolve a request to a path + rights, or answer 403 once for every reason. */
  function resolveShareRequest(
    req: FastifyRequest,
    id: string,
    handle: string | undefined,
    path: string | undefined,
  ) {
    const perms = sharePermissions(id, req.auth!.user);
    if (!perms) return null;
    return resolveGrant(req.auth!.user, id, {
      handle,
      path,
      hasReadPermission: perms.read,
      hasWritePermission: perms.write,
    });
  }

  const DENIED = { error: "forbidden", message: "This app doesn't have access to that folder." };

  app.get("/:id/shares/grants", async (req, reply): Promise<AppShareGrantsResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    if (!resolveApp(id, req.auth!.user)) return reply.code(404).send({ error: "not_found", message: "App not installed." }) as never;
    return { grants: listGrants(id, req.auth!.user.id) };
  });

  /**
   * Record a folder the user picked.
   *
   * The picker is drawn by OpenNAS, not the app, but the *request* still arrives
   * over the app's session - so the path is checked against the user's own
   * access here as well. An app that tried to grant itself a folder the user
   * never chose still cannot exceed what that user could have picked.
   */
  app.post("/:id/shares/grants", async (req, reply): Promise<AppShareGrantsResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    if (!resolveApp(id, req.auth!.user)) return reply.code(404).send({ error: "not_found", message: "App not installed." }) as never;
    const body = z
      .object({
        path: z.string().min(1).max(4096),
        type: z.enum(["file", "dir"]).default("dir"),
        mode: z.enum(["read", "readwrite"]).default("read"),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", message: "Provide a folder to grant." }) as never;

    const access = pathAccess(req.auth!.user, body.data.path);
    if (!access.read) return reply.code(403).send(DENIED) as never;
    // Never hand out write on a folder the user themselves can only read.
    const mode = body.data.mode === "readwrite" && access.write ? "readwrite" : "read";

    req.audit({ app: id, path: body.data.path, mode });
    grantPath(id, req.auth!.user.id, body.data.path, body.data.type, mode);
    return { grants: listGrants(id, req.auth!.user.id) };
  });

  app.delete("/:id/shares/grants/:handle", async (req, reply): Promise<AppShareGrantsResponse | undefined> => {
    const { id, handle } = req.params as { id: string; handle: string };
    if (!resolveApp(id, req.auth!.user)) return reply.code(404).send({ error: "not_found", message: "App not installed." }) as never;
    req.audit({ app: id, handle });
    revokeGrant(id, req.auth!.user.id, handle);
    return { grants: listGrants(id, req.auth!.user.id) };
  });

  app.get("/:id/shares/list", async (req, reply): Promise<AppShareListResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { path?: string; handle?: string };
    const target = resolveShareRequest(req, id, q.handle, q.path);
    if (!target) return reply.code(403).send(DENIED) as never;

    // The virtual root is the share list, which has no single real directory -
    // synthesise it the way File Station does.
    if (target.path === "/") {
      const entries: AppShareEntry[] = [];
      for (const name of accessibleShareNames(req.auth!.user)) {
        entries.push({
          name,
          type: "dir",
          sizeBytes: 0,
          modifiedAt: await stat(resolveSafe("/" + name)).then((s) => s.mtime.toISOString(), () => new Date().toISOString()),
          mime: null,
          writable: pathAccess(req.auth!.user, "/" + name).write,
        });
      }
      return { path: "/", entries, writable: false };
    }

    const real = resolveSafe(target.path);
    const dirents = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!dirents) return reply.code(404).send({ error: "not_found", message: "Folder not found." }) as never;

    const entries: AppShareEntry[] = [];
    for (const d of dirents) {
      const st = await lstat(`${real}/${d.name}`).catch(() => null);
      if (!st) continue;
      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue; // skip symlinks, sockets, fifos
      // A folder rule can narrow access below this directory, so each child is
      // resolved on its own rather than inheriting the parent's answer.
      const childAccess = pathAccess(req.auth!.user, `${target.path}/${d.name}`);
      if (!childAccess.read) continue;
      entries.push({
        name: d.name,
        type: isDir ? "dir" : "file",
        sizeBytes: isDir ? 0 : st.size,
        modifiedAt: st.mtime.toISOString(),
        mime: isDir ? null : mimeOf(d.name),
        writable: target.write && childAccess.write,
      });
    }
    entries.sort((a, b) =>
      a.type !== b.type
        ? a.type === "dir" ? -1 : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    return { path: target.path, entries, writable: target.write };
  });

  app.get("/:id/shares/content", async (req, reply): Promise<{ content: string | null } | undefined> => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { path?: string; handle?: string };
    const target = resolveShareRequest(req, id, q.handle, q.path);
    if (!target) return reply.code(403).send(DENIED) as never;

    const real = resolveSafe(target.path);
    const st = await stat(real).catch(() => null);
    if (!st || !st.isFile()) return { content: null };
    if (st.size > MAX_SHARE_READ_BYTES) {
      return reply
        .code(413)
        .send({ error: "too_large", message: "That file is too large for an app to read as text." }) as never;
    }
    return { content: await readFile(real, "utf8") };
  });

  app.put("/:id/shares/content", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { path?: string; handle?: string };
    const target = resolveShareRequest(req, id, q.handle, q.path);
    if (!target) return reply.code(403).send(DENIED);
    if (!target.write) return reply.code(403).send({ error: "read_only", message: "This app has read-only access there." });
    const body = z.object({ content: z.string().max(MAX_SHARE_READ_BYTES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", message: "Provide the file content." });

    const real = resolveSafe(target.path);
    req.audit({ app: id, path: target.path });
    await writeFile(real, body.data.content, "utf8");
    return { ok: true };
  });

  app.post("/:id/shares/mkdir", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ path: z.string().min(1).max(4096), handle: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid", message: "Provide a folder path." });
    const target = resolveShareRequest(req, id, body.data.handle, body.data.path);
    if (!target) return reply.code(403).send(DENIED);
    if (!target.write) return reply.code(403).send({ error: "read_only", message: "This app has read-only access there." });
    req.audit({ app: id, path: target.path });
    await mkdir(resolveSafe(target.path), { recursive: true });
    return { ok: true };
  });

  app.delete("/:id/shares/content", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { path?: string; handle?: string };
    const target = resolveShareRequest(req, id, q.handle, q.path);
    if (!target) return reply.code(403).send(DENIED);
    if (!target.write) return reply.code(403).send({ error: "read_only", message: "This app has read-only access there." });
    // Never the granted root itself: an app given a folder may empty it, but
    // deleting the thing it was handed is not something it was handed.
    if (isShareRoot(target.path)) {
      return reply.code(403).send({ error: "forbidden", message: "An app can't delete a shared folder itself." });
    }
    req.audit({ app: id, path: target.path });
    await rm(resolveSafe(target.path), { recursive: true, force: true });
    return { ok: true };
  });

  app.post("/:id/shares/upload", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { path?: string; handle?: string };
    const target = resolveShareRequest(req, id, q.handle, q.path);
    if (!target) return reply.code(403).send(DENIED);
    if (!target.write) return reply.code(403).send({ error: "read_only", message: "This app has read-only access there." });
    if (isShareRoot(target.path)) {
      return reply.code(400).send({ error: "invalid", message: "Give the file a name inside the folder." });
    }
    req.audit({ app: id, path: target.path });
    // No cap of our own: this is the user's own storage, in a folder they chose,
    // and the share quota is what governs it. The multipart limit still applies.
    const result = await receiveBytes(req, resolveSafe(target.path), Number.MAX_SAFE_INTEGER);
    if (!result.ok) return reply.code(result.code).send({ error: "upload_failed", message: result.message });
    return { ok: true, bytes: result.bytes };
  });

  app.get("/:id/shares/raw", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { path?: string; handle?: string };
    const target = resolveShareRequest(req, id, q.handle, q.path);
    if (!target) return reply.code(403).send(DENIED) as never;
    return sendBytes(req, reply, resolveSafe(target.path), basename(target.path) || "download");
  });
}
