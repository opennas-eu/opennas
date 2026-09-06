import { nanoid } from "nanoid";
import type { AccessLevel, FolderAcl, FolderAclSubject } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Folder-level access rules below a share root.
 *
 * ## How a level is decided
 *
 * The share grant is the starting point, and it is a *grant* model: a user's
 * share level is the most permissive of their own entry, their groups' entries
 * and the guest level. Folder rules are then an *override* model laid on top -
 * they exist precisely to carve exceptions out of a share, so the rule closest
 * to the file wins:
 *
 *   1. Walk from the share root down to the folder in question.
 *   2. At each step, a rule naming the user beats a rule naming a group - the
 *      more specific subject is the more deliberate one.
 *   3. Among several group rules at the same depth, the **most restrictive**
 *      applies. Someone who sets a group to "no access" on a folder means it.
 *   4. The deepest step that had any rule at all decides.
 *
 * ## What a folder rule cannot do
 *
 * It cannot let someone into a share they have no access to. The share is the
 * unit of visibility everywhere else - File Station's root listing, `smb.conf`,
 * `/etc/exports` - and a rule that granted access below a share the user cannot
 * enter would be honoured by the web UI and by nothing else. Rules may restrict
 * freely, and may raise read-only to read-write, but "none" at the share is the
 * end of the conversation.
 */

const RANK: Record<AccessLevel, number> = { none: 0, ro: 1, rw: 2 };

interface AclRow {
  id: string;
  share_id: string;
  path: string;
  subject_type: string;
  subject_id: string;
  level: string;
  created_at: string;
}

function normLevel(v: string): AccessLevel {
  return v === "ro" || v === "rw" ? v : "none";
}

/**
 * Canonical form of a rule path: relative to the share root, no leading or
 * trailing slash, no empty or dot segments. Throws on anything that tries to
 * climb out - a rule that escaped its share would apply to the wrong tree.
 */
export function normalizeAclPath(input: string): string {
  const parts = input.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error("path escapes the share");
  return parts.join("/");
}

/** Every ancestor path from the shallowest folder down to `path` itself. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

export function listAcls(shareId: string): FolderAcl[] {
  const rows = db
    .prepare(
      `SELECT a.*,
              CASE WHEN a.subject_type = 'user' THEN u.username ELSE g.name END AS subject_name,
              CASE WHEN a.subject_type = 'user' THEN u.display_name ELSE g.name END AS subject_label
       FROM folder_acls a
       LEFT JOIN users  u ON a.subject_type = 'user'  AND u.id = a.subject_id
       LEFT JOIN groups g ON a.subject_type = 'group' AND g.id = a.subject_id
       WHERE a.share_id = ?
       ORDER BY a.path, a.subject_type, subject_name`,
    )
    .all(shareId) as (AclRow & { subject_name: string | null; subject_label: string | null })[];

  return rows.map((r) => ({
    id: r.id,
    shareId: r.share_id,
    path: r.path,
    subjectType: r.subject_type === "group" ? "group" : "user",
    subjectId: r.subject_id,
    // A subject deleted out from under the rule; the route layer prunes these,
    // but a stale row must never render as a blank line in the UI.
    subjectName: r.subject_name ?? "(deleted)",
    subjectLabel: r.subject_label ?? "(deleted)",
    level: normLevel(r.level),
    createdAt: r.created_at,
  }));
}

export interface SetAclInput {
  shareId: string;
  path: string;
  subjectType: FolderAclSubject;
  subjectId: string;
  level: AccessLevel;
}

/** Create or replace the one rule for this (folder, subject) pair. */
export function setAcl(input: SetAclInput): FolderAcl {
  const path = normalizeAclPath(input.path);
  if (!path) throw new Error("a folder rule needs a folder - the share root is set in the share's permissions");
  db.prepare(
    `INSERT INTO folder_acls (id, share_id, path, subject_type, subject_id, level, created_at)
     VALUES (@id, @share, @path, @type, @subject, @level, @created)
     ON CONFLICT(share_id, path, subject_type, subject_id) DO UPDATE SET level = excluded.level`,
  ).run({
    id: nanoid(),
    share: input.shareId,
    path,
    type: input.subjectType,
    subject: input.subjectId,
    level: input.level,
    created: new Date().toISOString(),
  });
  return listAcls(input.shareId).find(
    (a) => a.path === path && a.subjectType === input.subjectType && a.subjectId === input.subjectId,
  )!;
}

export function deleteAcl(shareId: string, id: string): boolean {
  return db.prepare("DELETE FROM folder_acls WHERE id = ? AND share_id = ?").run(id, shareId).changes === 1;
}

/** True when a share has any folder rules - lets callers skip the walk entirely. */
export function shareHasAcls(shareId: string): boolean {
  return (
    (db.prepare("SELECT COUNT(*) AS n FROM folder_acls WHERE share_id = ?").get(shareId) as { n: number }).n > 0
  );
}

/**
 * Apply a share's folder rules to one path. `shareLevel` is what the share grant
 * already decided; `relPath` is relative to the share root ("" for the root).
 */
export function applyFolderAcls(
  shareId: string,
  relPath: string,
  userId: string,
  groupIds: string[],
  shareLevel: AccessLevel,
): AccessLevel {
  if (shareLevel === "none") return "none"; // a folder rule can't open a closed share
  const path = normalizeAclPath(relPath);
  if (!path) return shareLevel;

  const chain = ancestorsOf(path);
  const placeholders = chain.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT path, subject_type, subject_id, level FROM folder_acls WHERE share_id = ? AND path IN (${placeholders})`)
    .all(shareId, ...chain) as { path: string; subject_type: string; subject_id: string; level: string }[];
  if (rows.length === 0) return shareLevel;

  const groups = new Set(groupIds);
  let level: AccessLevel = shareLevel;

  for (const step of chain) {
    const here = rows.filter((r) => r.path === step);
    const userRule = here.find((r) => r.subject_type === "user" && r.subject_id === userId);
    if (userRule) {
      level = normLevel(userRule.level);
      continue;
    }
    const groupRules = here.filter((r) => r.subject_type === "group" && groups.has(r.subject_id));
    if (groupRules.length > 0) {
      // Most restrictive wins: an explicit "no access" for one of someone's
      // groups is not something another group should quietly undo.
      level = groupRules
        .map((r) => normLevel(r.level))
        .reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
    }
  }
  return level;
}

/**
 * Drop rules whose subject no longer exists. Cheap, and it keeps a recycled id
 * from ever inheriting a rule written for someone else.
 */
export function pruneOrphanAcls(): number {
  return db.prepare(
    `DELETE FROM folder_acls
     WHERE (subject_type = 'user'  AND subject_id NOT IN (SELECT id FROM users))
        OR (subject_type = 'group' AND subject_id NOT IN (SELECT id FROM groups))`,
  ).run().changes;
}
