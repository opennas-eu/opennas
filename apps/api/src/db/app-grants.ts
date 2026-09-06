import { randomUUID } from "node:crypto";
import type { AppShareGrant, User } from "@opennas/shared";
import { db } from "./index.js";
import { pathAccess } from "../files/access.js";
import { normalizeVirtual } from "../files/paths.js";

/**
 * Folders a user has handed to an app through the host-drawn picker.
 *
 * The point of the picker is that an app can work with one folder without
 * holding a blanket grant over everything the user can see. A grant records
 * *which path the app may ask about* - it is never itself the authority to read
 * it. `resolveGrant` re-runs the user's own `pathAccess` on every call, so a
 * revoked share, a folder rule turned read-only, or an admin demoting the user
 * all take effect immediately, whatever grants are on file.
 */

interface Row {
  id: string;
  app_id: string;
  user_id: string;
  path: string;
  type: "file" | "dir";
  mode: "read" | "readwrite";
  created_at: string;
  last_used_at: string | null;
}

/** How many folders one app may hold for one user, so a picker loop can't grow unbounded. */
export const MAX_GRANTS_PER_APP = 32;

function toGrant(r: Row): AppShareGrant {
  return {
    handle: r.id,
    path: r.path,
    name: r.path.split("/").filter(Boolean).pop() ?? "/",
    type: r.type,
    mode: r.mode,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export function listGrants(appId: string, userId: string): AppShareGrant[] {
  const rows = db
    .prepare("SELECT * FROM app_share_grants WHERE app_id = ? AND user_id = ? ORDER BY created_at DESC")
    .all(appId, userId) as Row[];
  return rows.map(toGrant);
}

/**
 * Record a folder the user just picked.
 *
 * Re-picking the same path updates the existing row instead of adding another,
 * so the revoke list stays as short as the set of folders actually in use.
 */
export function grantPath(
  appId: string,
  userId: string,
  path: string,
  type: "file" | "dir",
  mode: "read" | "readwrite",
): AppShareGrant {
  const p = normalizeVirtual(path);
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT * FROM app_share_grants WHERE app_id = ? AND user_id = ? AND path = ?")
    .get(appId, userId, p) as Row | undefined;

  if (existing) {
    // A second pick that asks for write should widen; one that asks for read
    // shouldn't quietly take write away from a folder already in use.
    const next = existing.mode === "readwrite" || mode === "readwrite" ? "readwrite" : "read";
    db.prepare("UPDATE app_share_grants SET mode = ?, type = ? WHERE id = ?").run(next, type, existing.id);
    return toGrant({ ...existing, mode: next, type });
  }

  const count = db
    .prepare("SELECT COUNT(*) AS n FROM app_share_grants WHERE app_id = ? AND user_id = ?")
    .get(appId, userId) as { n: number };
  if (count.n >= MAX_GRANTS_PER_APP) {
    // Drop the least recently used rather than refusing: the user just asked
    // for this folder, and failing the pick they can see is worse than
    // forgetting one they haven't touched.
    db.prepare(
      `DELETE FROM app_share_grants WHERE id = (
         SELECT id FROM app_share_grants WHERE app_id = ? AND user_id = ?
         ORDER BY COALESCE(last_used_at, created_at) ASC LIMIT 1
       )`,
    ).run(appId, userId);
  }

  const row: Row = {
    id: randomUUID(),
    app_id: appId,
    user_id: userId,
    path: p,
    type,
    mode,
    created_at: now,
    last_used_at: null,
  };
  db.prepare(
    `INSERT INTO app_share_grants (id, app_id, user_id, path, type, mode, created_at, last_used_at)
     VALUES (@id, @app_id, @user_id, @path, @type, @mode, @created_at, @last_used_at)`,
  ).run(row);
  return toGrant(row);
}

/** Every grant this user has given to any app, newest first. */
export function listAllGrantsForUser(userId: string): (AppShareGrant & { appId: string })[] {
  const rows = db
    .prepare("SELECT * FROM app_share_grants WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as Row[];
  return rows.map((r) => ({ ...toGrant(r), appId: r.app_id }));
}

/** Revoke by handle alone, for the user's own "what can apps see" screen. */
export function revokeGrantForUser(userId: string, handle: string): boolean {
  return db.prepare("DELETE FROM app_share_grants WHERE id = ? AND user_id = ?").run(handle, userId).changes > 0;
}

export function revokeGrant(appId: string, userId: string, handle: string): boolean {
  const res = db
    .prepare("DELETE FROM app_share_grants WHERE id = ? AND app_id = ? AND user_id = ?")
    .run(handle, appId, userId);
  return res.changes > 0;
}

/** Forget everything an app held, for when it is uninstalled. */
export function revokeAllForApp(appId: string): number {
  return db.prepare("DELETE FROM app_share_grants WHERE app_id = ?").run(appId).changes;
}

export interface ResolvedPath {
  /** The absolute virtual path to act on. */
  path: string;
  read: boolean;
  write: boolean;
}

/**
 * Turn an app's request into a path plus what it may do there.
 *
 * Two routes in, and both end at the same `pathAccess` check:
 *
 * - **With a handle** the app names a path *relative to the granted folder*, and
 *   it is pinned inside it. This is the picker case and needs no permission.
 * - **Without one** the app is using its manifest grant and names an absolute
 *   virtual path.
 *
 * Returns null when the app may not touch the path at all, so callers can answer a
 * single 403 without having to distinguish "no grant" from "no access" - the
 * app learns nothing about paths it wasn't given either way.
 */
export function resolveGrant(
  user: User,
  appId: string,
  opts: { handle?: string; path?: string; hasReadPermission: boolean; hasWritePermission: boolean },
): ResolvedPath | null {
  const rel = opts.path ?? "";

  if (opts.handle) {
    const row = db
      .prepare("SELECT * FROM app_share_grants WHERE id = ? AND app_id = ? AND user_id = ?")
      .get(opts.handle, appId, user.id) as Row | undefined;
    if (!row) return null;

    // Join the relative path onto the granted root, then normalise - which
    // collapses any "..", so an app cannot climb out of the folder it was given.
    const joined = normalizeVirtual(`${row.path}/${rel}`);
    const root = row.path === "/" ? "/" : `${row.path}/`;
    if (joined !== row.path && !joined.startsWith(root)) return null;

    const access = pathAccess(user, joined);
    if (!access.read) return null;
    db.prepare("UPDATE app_share_grants SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return {
      path: joined,
      read: true,
      // The narrower of what the grant allows and what the user themselves has.
      write: access.write && row.mode === "readwrite",
    };
  }

  if (!opts.hasReadPermission) return null;
  const path = normalizeVirtual(rel || "/");
  const access = pathAccess(user, path);
  if (!access.read) return null;
  return { path, read: true, write: access.write && opts.hasWritePermission };
}
