import { nanoid } from "nanoid";
import type { AccessLevel, Share, SharePermission, ShareGroupPermission } from "@opennas/shared";
import { db } from "./index.js";
import { listNfsRules } from "./nfs-rules.js";
import { groupIdsForUser } from "./groups.js";

interface ShareRow {
  id: string;
  name: string;
  comment: string;
  guest_access: string;
  smb_enabled: number;
  nfs_enabled: number;
  browseable: number;
  volume: string;
  recycle_enabled: number;
  time_machine: number;
  quota_bytes: number;
  quota_project_id: number | null;
  created_at: string;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    name: row.name,
    comment: row.comment,
    guestAccess: normLevel(row.guest_access),
    smbEnabled: row.smb_enabled === 1,
    nfsEnabled: row.nfs_enabled === 1,
    browseable: row.browseable === 1,
    volume: row.volume || null,
    createdAt: row.created_at,
    permissions: getPermissions(row.id),
    groupPermissions: getGroupPermissions(row.id),
    recycleEnabled: row.recycle_enabled === 1,
    timeMachineEnabled: row.time_machine === 1,
    nfsRules: listNfsRules(row.id),
    quotaBytes: row.quota_bytes,
    quotaProjectId: row.quota_project_id,
    quotaUsedBytes: null,
    sizeBytes: null,
  };
}

function normLevel(v: string): AccessLevel {
  return v === "ro" || v === "rw" ? v : "none";
}

export function getPermissions(shareId: string): SharePermission[] {
  return db
    .prepare(
      `SELECT sp.user_id, sp.level, u.username, u.display_name
       FROM share_permissions sp JOIN users u ON u.id = sp.user_id
       WHERE sp.share_id = ? ORDER BY u.username`,
    )
    .all(shareId)
    .map((r) => {
      const row = r as { user_id: string; level: string; username: string; display_name: string };
      return {
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        level: row.level === "ro" ? "ro" : "rw",
      } satisfies SharePermission;
    });
}

export function getGroupPermissions(shareId: string): ShareGroupPermission[] {
  return db
    .prepare(
      `SELECT sgp.group_id, sgp.level, g.name
       FROM share_group_permissions sgp JOIN groups g ON g.id = sgp.group_id
       WHERE sgp.share_id = ? ORDER BY g.name`,
    )
    .all(shareId)
    .map((r) => {
      const row = r as { group_id: string; level: string; name: string };
      return { groupId: row.group_id, name: row.name, level: row.level === "ro" ? "ro" : "rw" } satisfies ShareGroupPermission;
    });
}

export function listShares(): Share[] {
  const rows = db.prepare("SELECT * FROM shares ORDER BY name").all() as ShareRow[];
  return rows.map(toShare);
}

export function getShareById(id: string): Share | null {
  const row = db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as ShareRow | undefined;
  return row ? toShare(row) : null;
}

export function getShareRowByName(name: string): ShareRow | null {
  return (db.prepare("SELECT * FROM shares WHERE name = ?").get(name) as ShareRow | undefined) ?? null;
}

export interface CreateShareInput {
  name: string;
  comment?: string;
  guestAccess?: AccessLevel;
  smbEnabled?: boolean;
  nfsEnabled?: boolean;
  browseable?: boolean;
  /** Data volume label this share lives on; empty/undefined = default share root. */
  volume?: string;
  /** Samba's vfs_recycle: deleting over SMB moves the file aside. */
  recycleEnabled?: boolean;
  timeMachineEnabled?: boolean;
}

export function createShare(input: CreateShareInput): Share {
  const id = nanoid();
  db.prepare(
    `INSERT INTO shares (id, name, comment, guest_access, smb_enabled, nfs_enabled, browseable, volume, recycle_enabled, time_machine, created_at)
     VALUES (@id, @name, @comment, @guest, @smb, @nfs, @browse, @volume, @recycle, @tm, @created)`,
  ).run({
    id,
    name: input.name,
    comment: input.comment ?? "",
    guest: input.guestAccess ?? "none",
    smb: input.smbEnabled === false ? 0 : 1,
    nfs: input.nfsEnabled ? 1 : 0,
    browse: input.browseable === false ? 0 : 1,
    volume: input.volume ?? "",
    recycle: input.recycleEnabled ? 1 : 0,
    tm: input.timeMachineEnabled ? 1 : 0,
    created: new Date().toISOString(),
  });
  return getShareById(id)!;
}

export interface UpdateShareFields {
  comment?: string;
  guestAccess?: AccessLevel;
  smbEnabled?: boolean;
  nfsEnabled?: boolean;
  browseable?: boolean;
  recycleEnabled?: boolean;
  timeMachineEnabled?: boolean;
  /** 0 removes the cap. */
  quotaBytes?: number;
}

export function updateShare(id: string, fields: UpdateShareFields): void {
  const sets: string[] = [];
  const p: Record<string, unknown> = { id };
  if (fields.comment !== undefined) { sets.push("comment = @comment"); p.comment = fields.comment; }
  if (fields.guestAccess !== undefined) { sets.push("guest_access = @guest"); p.guest = fields.guestAccess; }
  if (fields.smbEnabled !== undefined) { sets.push("smb_enabled = @smb"); p.smb = fields.smbEnabled ? 1 : 0; }
  if (fields.nfsEnabled !== undefined) { sets.push("nfs_enabled = @nfs"); p.nfs = fields.nfsEnabled ? 1 : 0; }
  if (fields.browseable !== undefined) { sets.push("browseable = @browse"); p.browse = fields.browseable ? 1 : 0; }
  if (fields.recycleEnabled !== undefined) { sets.push("recycle_enabled = @recycle"); p.recycle = fields.recycleEnabled ? 1 : 0; }
  if (fields.timeMachineEnabled !== undefined) { sets.push("time_machine = @tm"); p.tm = fields.timeMachineEnabled ? 1 : 0; }
  if (fields.quotaBytes !== undefined) { sets.push("quota_bytes = @quotaBytes"); p.quotaBytes = Math.max(0, Math.floor(fields.quotaBytes)); }
  if (sets.length) db.prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = @id`).run(p);
}

export function setPermissions(shareId: string, perms: { userId: string; level: "ro" | "rw" }[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM share_permissions WHERE share_id = ?").run(shareId);
    const ins = db.prepare("INSERT OR REPLACE INTO share_permissions (share_id, user_id, level) VALUES (?, ?, ?)");
    for (const p of perms) ins.run(shareId, p.userId, p.level === "ro" ? "ro" : "rw");
  });
  tx();
}

export function setGroupPermissions(shareId: string, perms: { groupId: string; level: "ro" | "rw" }[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM share_group_permissions WHERE share_id = ?").run(shareId);
    const ins = db.prepare("INSERT OR REPLACE INTO share_group_permissions (share_id, group_id, level) VALUES (?, ?, ?)");
    for (const p of perms) ins.run(shareId, p.groupId, p.level === "ro" ? "ro" : "rw");
  })();
}

/**
 * Allocate the filesystem project id a share's quota is tracked under.
 *
 * Stable and never reused: it is written into the directory tree's inode flags,
 * so handing the same number to a different share later would make the new
 * share inherit the old one's accounting. Ids start above 1000 to stay clear of
 * anything the distribution might use.
 */
export function ensureQuotaProjectId(shareId: string): number {
  const row = db.prepare("SELECT quota_project_id FROM shares WHERE id = ?").get(shareId) as
    | { quota_project_id: number | null }
    | undefined;
  if (row?.quota_project_id) return row.quota_project_id;
  const max = (db.prepare("SELECT MAX(quota_project_id) AS m FROM shares").get() as { m: number | null }).m ?? 1000;
  const next = Math.max(1000, max) + 1;
  db.prepare("UPDATE shares SET quota_project_id = ? WHERE id = ?").run(next, shareId);
  return next;
}

export function deleteShare(id: string): void {
  db.prepare("DELETE FROM shares WHERE id = ?").run(id);
}

/**
 * Effective access level for a user at a share's *root* (ignores admin; callers
 * grant admins full access separately).
 *
 * This is a grant model - the most permissive of the user's own entry, any of
 * their groups' entries, and the guest level. Folder rules below the root are a
 * separate, overriding layer; see `db/acls.ts`.
 */
export function effectiveAccess(shareName: string, userId: string): AccessLevel {
  const row = getShareRowByName(shareName);
  if (!row) return "none";
  return effectiveAccessForShareId(row.id, row.guest_access, userId);
}

export function effectiveAccessForShareId(shareId: string, guestAccess: string, userId: string): AccessLevel {
  const perm = db
    .prepare("SELECT level FROM share_permissions WHERE share_id = ? AND user_id = ?")
    .get(shareId, userId) as { level: string } | undefined;
  let level = maxLevel(perm ? normLevel(perm.level) : "none", normLevel(guestAccess));

  const groups = groupIdsForUser(userId);
  if (groups.length > 0) {
    const rows = db
      .prepare(
        `SELECT level FROM share_group_permissions
         WHERE share_id = ? AND group_id IN (${groups.map(() => "?").join(",")})`,
      )
      .all(shareId, ...groups) as { level: string }[];
    for (const r of rows) level = maxLevel(level, normLevel(r.level));
  }
  return level;
}

/** Names of shares a user can at least read. */
export function visibleShareNames(userId: string): Set<string> {
  const rows = db.prepare("SELECT * FROM shares").all() as ShareRow[];
  const out = new Set<string>();
  for (const r of rows) {
    if (effectiveAccess(r.name, userId) !== "none") out.add(r.name);
  }
  return out;
}

function maxLevel(a: AccessLevel, b: AccessLevel): AccessLevel {
  const rank = { none: 0, ro: 1, rw: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}
