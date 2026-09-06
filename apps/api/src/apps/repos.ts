import { createHash } from "node:crypto";
import type { AppRepo } from "@opennas/shared";
import { getSettingOr, setSetting } from "../db/settings.js";

/**
 * The configured app repositories.
 *
 * Order is priority: when two repositories publish the same app id, the earlier
 * one wins. That matters beyond tidiness - an app is only ever *updated* from
 * the repository it was installed from (see `installed_apps.source_repo`), so a
 * repository added later can offer a higher version of an app id somebody else
 * already publishes without quietly taking it over.
 *
 * Stored as JSON in one setting rather than a table: it's a short, ordered,
 * wholly-rewritten list, which is exactly what a table is bad at.
 */

const SETTING = "app_repos";
/** The pre-multi-repo setting, read once to carry an existing choice forward. */
const LEGACY_SETTING = "app_repo_url";
export const DEFAULT_REPO = "https://repo.opennas.eu";

export const MAX_REPOS = 8;

/** A stable id for a URL, so it survives renames and reordering. */
export function repoIdFor(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 12);
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isValidRepoUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return u.hostname.length > 0;
  } catch {
    return false;
  }
}

function coerce(raw: unknown): AppRepo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = normalizeUrl(String(r.url ?? ""));
  if (!isValidRepoUrl(url)) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : repoIdFor(url),
    url,
    name: typeof r.name === "string" ? r.name : "",
    enabled: r.enabled !== false,
  };
}

export function listRepos(): AppRepo[] {
  const raw = getSettingOr(SETTING, "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown[];
      const repos = (Array.isArray(parsed) ? parsed : []).map(coerce).filter((r): r is AppRepo => r !== null);
      if (repos.length > 0) return dedupe(repos);
    } catch {
      /* fall through to the default below */
    }
  }
  // First run after the upgrade: carry over whichever single repository was
  // configured, so an admin who pointed at their own mirror keeps it.
  const legacy = normalizeUrl(getSettingOr(LEGACY_SETTING, DEFAULT_REPO));
  const url = isValidRepoUrl(legacy) ? legacy : DEFAULT_REPO;
  return [{ id: repoIdFor(url), url, name: "", enabled: true }];
}

/** Same URL twice is always a mistake; keep the first and its position. */
function dedupe(repos: AppRepo[]): AppRepo[] {
  const seen = new Set<string>();
  const out: AppRepo[] = [];
  for (const r of repos) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out.slice(0, MAX_REPOS);
}

export function saveRepos(repos: AppRepo[]): AppRepo[] {
  const clean = dedupe(repos.map((r) => ({ ...r, url: normalizeUrl(r.url), id: repoIdFor(r.url) })));
  setSetting(SETTING, JSON.stringify(clean));
  // Keep the legacy key pointing at the primary, so anything still reading it
  // (an older running process mid-upgrade) sees something sensible.
  const primary = clean.find((r) => r.enabled) ?? clean[0];
  if (primary) setSetting(LEGACY_SETTING, primary.url);
  return clean;
}

export function enabledRepos(): AppRepo[] {
  return listRepos().filter((r) => r.enabled);
}

export function getRepo(id: string): AppRepo | null {
  return listRepos().find((r) => r.id === id) ?? null;
}

/** Remember the name a repository reported, so the list isn't all URLs. */
export function noteRepoName(id: string, name: string): void {
  if (!name) return;
  const repos = listRepos();
  const repo = repos.find((r) => r.id === id);
  if (!repo || repo.name === name) return;
  repo.name = name;
  setSetting(SETTING, JSON.stringify(repos));
}

/** A human label for a repository, falling back to its host. */
export function repoLabel(repo: AppRepo): string {
  if (repo.name) return repo.name;
  try {
    return new URL(repo.url).host;
  } catch {
    return repo.url;
  }
}
