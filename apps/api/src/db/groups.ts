import { nanoid } from "nanoid";
import type { Group, GroupMember } from "@opennas/shared";
import { db } from "./index.js";

/**
 * User groups.
 *
 * Every permission in OpenNAS used to name one account, which does not survive
 * a household or a team of any size: adding a person meant editing every share
 * they should reach, and removing them meant remembering all of them. A group is
 * the indirection that fixes that, and it is deliberately flat - no nesting, so
 * "who can read this?" is always answerable by looking at one level.
 *
 * The name doubles as a system group name on the appliance, so Samba can be told
 * `valid users = @editors`; that is why it is validated to the same character
 * set as a username.
 */

interface GroupRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    memberCount: (
      db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?").get(row.id) as { n: number }
    ).n,
  };
}

export function listGroups(): Group[] {
  return (db.prepare("SELECT * FROM groups ORDER BY name").all() as GroupRow[]).map(toGroup);
}

export function getGroupById(id: string): Group | null {
  const row = db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  return row ? toGroup(row) : null;
}

export function getGroupByName(name: string): Group | null {
  const row = db.prepare("SELECT * FROM groups WHERE lower(name) = lower(?)").get(name) as GroupRow | undefined;
  return row ? toGroup(row) : null;
}

export function createGroup(name: string, description: string): Group {
  const id = nanoid();
  db.prepare("INSERT INTO groups (id, name, description, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, description, new Date().toISOString());
  return getGroupById(id)!;
}

export function updateGroup(id: string, fields: { name?: string; description?: string }): void {
  const sets: string[] = [];
  const p: Record<string, unknown> = { id };
  if (fields.name !== undefined) { sets.push("name = @name"); p.name = fields.name; }
  if (fields.description !== undefined) { sets.push("description = @description"); p.description = fields.description; }
  if (sets.length) db.prepare(`UPDATE groups SET ${sets.join(", ")} WHERE id = @id`).run(p);
}

export function deleteGroup(id: string): void {
  // Cascades clear the memberships, the share grants and any folder rules that
  // named this group; a rule with no subject would otherwise deny silently.
  db.prepare("DELETE FROM folder_acls WHERE subject_type = 'group' AND subject_id = ?").run(id);
  db.prepare("DELETE FROM groups WHERE id = ?").run(id);
}

// ---- Membership -----------------------------------------------------------

export function listMembers(groupId: string): GroupMember[] {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_color
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? ORDER BY u.username`,
    )
    .all(groupId)
    .map((r) => {
      const row = r as { id: string; username: string; display_name: string; avatar_color: string };
      return { userId: row.id, username: row.username, displayName: row.display_name, avatarColor: row.avatar_color };
    });
}

export function setMembers(groupId: string, userIds: string[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
    const ins = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)");
    for (const id of userIds) ins.run(groupId, id);
  })();
}

/** Group ids a user belongs to. Hot path - every permission check calls it. */
export function groupIdsForUser(userId: string): string[] {
  return (db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(userId) as { group_id: string }[])
    .map((r) => r.group_id);
}

/** Group *names* a user belongs to, for the file-sharing daemon configs. */
export function groupNamesForUser(userId: string): string[] {
  return (
    db
      .prepare(
        "SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ? ORDER BY g.name",
      )
      .all(userId) as { name: string }[]
  ).map((r) => r.name);
}

/** Usernames in a group - Samba needs the members, not just the group name. */
export function usernamesInGroup(groupId: string): string[] {
  return (
    db
      .prepare(
        "SELECT u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.username",
      )
      .all(groupId) as { username: string }[]
  ).map((r) => r.username);
}
