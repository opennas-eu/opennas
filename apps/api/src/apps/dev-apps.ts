import type { AppManifest, AppPermission, DevApp } from "@opennas/shared";
import { APP_PERMISSIONS } from "@opennas/shared";
import { getSettingOr, setSetting } from "../db/settings.js";

/**
 * Development apps: an app loaded live from a dev server instead of from an
 * installed package, so an author can edit and refresh rather than repack and
 * reinstall for every change.
 *
 * The isolation model is deliberately *unchanged*. A dev app renders in the same
 * sandboxed iframe as a packaged one - no `allow-same-origin`, so it still gets
 * an opaque origin - and the postMessage broker still identifies apps by the
 * iframe's window object rather than by origin, which is what makes that safe
 * across origins. The only thing that differs is where the bytes come from.
 *
 * What *does* change is CSP: the desktop's `frame-src` has to name the dev
 * origin, so each configured dev app widens it by exactly one origin. That's
 * why this is admin-only, off by default, and stored as an explicit list rather
 * than a wildcard.
 */

const SETTING = "dev_apps";
export const MAX_DEV_APPS = 5;

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Only loopback: a dev server is something the developer is running locally. */
export function isValidDevUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // A remote origin here would be a third-party site running inside the
  // desktop with whatever permissions were granted - that is what installing a
  // package is for, with its signature and review. Dev mode is for localhost.
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
}

/** The origin CSP has to allow for this app to render at all. */
export function devOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function coerce(raw: unknown): DevApp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").toLowerCase();
  const url = String(r.url ?? "").replace(/\/+$/, "");
  if (!ID_RE.test(id) || !isValidDevUrl(url)) return null;
  return {
    id,
    name: String(r.name ?? id).slice(0, 64) || id,
    url,
    permissions: (Array.isArray(r.permissions) ? r.permissions : []).filter(
      (p): p is AppPermission => typeof p === "string" && (APP_PERMISSIONS as readonly string[]).includes(p),
    ),
    enabled: r.enabled !== false,
  };
}

export function listDevApps(): DevApp[] {
  try {
    const parsed = JSON.parse(getSettingOr(SETTING, "[]")) as unknown[];
    const out: DevApp[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      const app = coerce(raw);
      if (!app || seen.has(app.id)) continue;
      seen.add(app.id);
      out.push(app);
    }
    return out.slice(0, MAX_DEV_APPS);
  } catch {
    return [];
  }
}

export function saveDevApps(apps: DevApp[]): DevApp[] {
  const clean: DevApp[] = [];
  const seen = new Set<string>();
  for (const raw of apps) {
    const app = coerce(raw);
    if (!app || seen.has(app.id)) continue;
    seen.add(app.id);
    clean.push(app);
  }
  const limited = clean.slice(0, MAX_DEV_APPS);
  setSetting(SETTING, JSON.stringify(limited));
  return limited;
}

/** The `frame-src` additions the desktop needs, or an empty list when off. */
export function devFrameOrigins(): string[] {
  const origins = new Set<string>();
  for (const app of listDevApps()) {
    if (!app.enabled) continue;
    const origin = devOrigin(app.url);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

/**
 * Present a dev app to the desktop as an ordinary manifest, so the launcher,
 * the window manager and the SDK broker need no special case. `devUrl` is the
 * one field that marks it, and it's what AppFrame loads instead of packaged
 * content.
 */
export function devManifests(): AppManifest[] {
  return listDevApps()
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      name: a.name,
      icon: "Wrench",
      iconGradient: "from-amber-400 to-orange-600",
      category: "developer" as const,
      description: `Development build served from ${a.url}`,
      kind: "external" as const,
      // Admin-only, always: a half-finished app being developed is not
      // something to put in front of everyone with an account.
      minRole: "admin" as const,
      window: { defaultWidth: 900, defaultHeight: 640, minWidth: 420, minHeight: 320, resizable: true },
      showOnDesktop: false,
      version: "dev",
      author: "Development",
      entry: "",
      permissions: a.permissions,
      signed: false,
      publisherFingerprint: null,
      devUrl: a.url,
    }));
}
