import { nanoid } from "nanoid";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { SECRET_SETTINGS } from "../db/settings.js";
import { normalizeAclPath } from "../db/acls.js";
import type { ConfigBackup, ConfigRestorePlan, ConfigRestoreResult } from "@opennas/shared";

/**
 * Export and import of OpenNAS configuration.
 *
 * **Secrets are deliberately not exported.** A backup file gets emailed to
 * yourself, dropped in a share, copied to a laptop - treating it as a secret
 * store would be a mistake waiting to happen. So password hashes, the SMTP
 * password, OIDC client secrets, TLS keys and the session-signing secret all
 * stay behind, and the file says so. What you get back is the *configuration*:
 * shares and who may use them (including groups and folder rules), services,
 * accounts and their roles, schedules,
 * app repository settings, personalisation.
 *
 * That means a restore onto a fresh box leaves accounts without passwords. They
 * come back disabled rather than open, so an import can never quietly create a
 * way in.
 */

const FORMAT = 1;

/** Settings keys holding a secret, or state that means nothing on another box. */
const EXCLUDED_SETTINGS = new Set([
  // Every setting that holds a credential, from the one list that tracks them.
  ...SECRET_SETTINGS,
  "disk_alert_state", // per-machine bookkeeping about specific disks
]);

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  disabled: number;
  avatar_color: string;
  created_at: string;
}

interface ShareRow {
  id: string;
  name: string;
  comment: string;
  guest_access: string;
  smb_enabled: number;
  nfs_enabled: number;
  browseable: number;
  volume: string | null;
  recycle_enabled: number;
}

export function exportConfig(): ConfigBackup {
  const settings: Record<string, string> = {};
  for (const row of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
    if (!EXCLUDED_SETTINGS.has(row.key)) settings[row.key] = row.value;
  }

  const users = (db
    .prepare("SELECT id, username, display_name, email, role, disabled, avatar_color, created_at FROM users ORDER BY created_at")
    .all() as UserRow[]).map((u) => ({
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role === "admin" ? ("admin" as const) : ("user" as const),
    disabled: u.disabled === 1,
    avatarColor: u.avatar_color,
  }));

  const shareRows = db.prepare("SELECT * FROM shares ORDER BY name").all() as ShareRow[];
  const permStmt = db.prepare(
    `SELECT u.username AS username, p.level AS level
       FROM share_permissions p JOIN users u ON u.id = p.user_id
      WHERE p.share_id = ?`,
  );
  // Group grants and folder rules travel by *name*, like everything else here -
  // ids are per-install and would silently point at nothing (or worse, at
  // something else) on the machine the backup is restored onto.
  const groupPermStmt = db.prepare(
    `SELECT g.name AS name, p.level AS level
       FROM share_group_permissions p JOIN groups g ON g.id = p.group_id
      WHERE p.share_id = ?`,
  );
  const aclStmt = db.prepare(
    `SELECT a.path, a.subject_type, a.level,
            CASE WHEN a.subject_type = 'user' THEN u.username ELSE g.name END AS subject
       FROM folder_acls a
       LEFT JOIN users  u ON a.subject_type = 'user'  AND u.id = a.subject_id
       LEFT JOIN groups g ON a.subject_type = 'group' AND g.id = a.subject_id
      WHERE a.share_id = ? ORDER BY a.path`,
  );

  const shares = shareRows.map((s) => ({
    name: s.name,
    comment: s.comment,
    guestAccess: s.guest_access as "none" | "ro" | "rw",
    smbEnabled: s.smb_enabled === 1,
    nfsEnabled: s.nfs_enabled === 1,
    browseable: s.browseable === 1,
    volume: s.volume,
    recycleEnabled: s.recycle_enabled === 1,
    // Permissions travel by username, not user id - ids are per-install.
    permissions: (permStmt.all(s.id) as { username: string; level: string }[]).map((p) => ({
      username: p.username,
      level: p.level as "ro" | "rw",
    })),
    groupPermissions: (groupPermStmt.all(s.id) as { name: string; level: string }[]).map((p) => ({
      group: p.name,
      level: p.level as "ro" | "rw",
    })),
    folderRules: (aclStmt.all(s.id) as { path: string; subject_type: string; subject: string | null; level: string }[])
      // A rule whose subject has already gone is not worth carrying forward.
      .filter((a) => a.subject !== null)
      .map((a) => ({
        path: a.path,
        subjectType: a.subject_type === "group" ? ("group" as const) : ("user" as const),
        subject: a.subject!,
        level: a.level as "none" | "ro" | "rw",
      })),
  }));

  const groups = (db.prepare("SELECT id, name, description FROM groups ORDER BY name").all() as
    { id: string; name: string; description: string }[]).map((g) => ({
    name: g.name,
    description: g.description,
    members: (
      db
        .prepare(
          "SELECT u.username AS username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.username",
        )
        .all(g.id) as { username: string }[]
    ).map((m) => m.username),
  }));

  const oidcClients = (db
    .prepare("SELECT client_id, name, redirect_uris, scopes FROM oidc_clients ORDER BY name")
    .all() as { client_id: string; name: string; redirect_uris: string; scopes: string }[]).map((c) => ({
    clientId: c.client_id,
    name: c.name,
    redirectUris: JSON.parse(c.redirect_uris) as string[],
    scopes: c.scopes,
  }));

  return {
    format: FORMAT,
    version: config.version,
    exportedAt: new Date().toISOString(),
    settings,
    users,
    groups,
    shares,
    oidcClients,
    excluded: [
      "user passwords (accounts restore disabled until a password is set)",
      "OIDC client secrets (re-issue them after restoring)",
      "SMTP password and the whole SMTP block",
      "TLS certificate and key",
      "passkeys (they're bound to this machine's origin)",
      "two-factor secrets and recovery codes (each account re-enrols)",
      "the session-signing secret",
    ],
  };
}

/** Shape check + a preview of what an import would change, without changing it. */
export function planRestore(input: unknown): ConfigRestorePlan {
  const problems: string[] = [];
  const backup = input as Partial<ConfigBackup> | null;

  if (!backup || typeof backup !== "object") {
    return {
      ok: false, problems: ["That isn't a valid OpenNAS backup file."],
      settings: 0, usersNew: 0, usersUpdated: 0, sharesNew: 0, sharesUpdated: 0,
      groupsNew: 0, groupsUpdated: 0, oidcClients: 0,
    };
  }
  if (backup.format !== FORMAT) {
    problems.push(`Unsupported backup format (expected ${FORMAT}, got ${String(backup.format)}).`);
  }

  const settings = backup.settings && typeof backup.settings === "object" ? Object.keys(backup.settings).length : 0;
  const users = Array.isArray(backup.users) ? backup.users : [];
  const shares = Array.isArray(backup.shares) ? backup.shares : [];
  // Older backups predate groups; treat a missing list as an empty one rather
  // than refusing the file.
  const groups = Array.isArray(backup.groups) ? backup.groups : [];
  const oidcClients = Array.isArray(backup.oidcClients) ? backup.oidcClients : [];

  const existingUsers = new Set(
    (db.prepare("SELECT lower(username) AS u FROM users").all() as { u: string }[]).map((r) => r.u),
  );
  const existingShares = new Set(
    (db.prepare("SELECT lower(name) AS n FROM shares").all() as { n: string }[]).map((r) => r.n),
  );
  const existingGroups = new Set(
    (db.prepare("SELECT lower(name) AS n FROM groups").all() as { n: string }[]).map((r) => r.n),
  );

  let usersNew = 0;
  let usersUpdated = 0;
  for (const u of users) {
    if (!u?.username) continue;
    if (existingUsers.has(u.username.toLowerCase())) usersUpdated++;
    else usersNew++;
  }
  let sharesNew = 0;
  let sharesUpdated = 0;
  for (const s of shares) {
    if (!s?.name) continue;
    if (existingShares.has(s.name.toLowerCase())) sharesUpdated++;
    else sharesNew++;
  }

  let groupsNew = 0;
  let groupsUpdated = 0;
  for (const g of groups) {
    if (!g?.name) continue;
    if (existingGroups.has(g.name.toLowerCase())) groupsUpdated++;
    else groupsNew++;
  }

  return {
    ok: problems.length === 0,
    problems,
    settings,
    usersNew,
    usersUpdated,
    sharesNew,
    sharesUpdated,
    groupsNew,
    groupsUpdated,
    oidcClients: oidcClients.length,
  };
}

/**
 * Apply a backup. Merges rather than replaces: existing accounts and shares are
 * updated in place and anything not mentioned is left alone, so an import can't
 * silently delete a share or an account you still need. Runs in one transaction,
 * so a malformed file leaves nothing half-applied.
 */
export function applyRestore(backup: ConfigBackup): ConfigRestoreResult {
  const result: ConfigRestoreResult = {
    settings: 0,
    usersCreated: 0,
    usersUpdated: 0,
    sharesCreated: 0,
    sharesUpdated: 0,
    groupsCreated: 0,
    groupsUpdated: 0,
    folderRules: 0,
    usersNeedingPassword: [],
    warnings: [],
  };

  const tx = db.transaction(() => {
    const setSetting = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of Object.entries(backup.settings ?? {})) {
      if (EXCLUDED_SETTINGS.has(key)) continue; // never import a secret slot
      setSetting.run(key, String(value));
      result.settings++;
    }

    // ---- Users ------------------------------------------------------------
    const findUser = db.prepare("SELECT id, role FROM users WHERE lower(username) = lower(?)");
    const insertUser = db.prepare(
      `INSERT INTO users (id, username, display_name, email, role, source, password_hash, avatar_color, created_at, disabled)
       VALUES (@id, @username, @displayName, @email, @role, 'local', NULL, @avatarColor, @now, 1)`,
    );
    // An account with no password must never come out of an import enabled -
    // including on a re-import, where the backup says "enabled" because it was
    // enabled on the machine it came from. The invariant is enforced here rather
    // than in the caller so there's no path around it.
    const updateUser = db.prepare(
      `UPDATE users
          SET display_name = @displayName, email = @email, role = @role,
              disabled = CASE WHEN password_hash IS NULL THEN 1 ELSE @disabled END
        WHERE id = @id`,
    );
    const hasPassword = db.prepare("SELECT password_hash IS NOT NULL AS ok FROM users WHERE id = ?");
    const now = new Date().toISOString();

    for (const u of backup.users ?? []) {
      if (!u?.username) continue;
      const existing = findUser.get(u.username) as { id: string; role: string } | undefined;
      if (existing) {
        updateUser.run({
          id: existing.id,
          displayName: u.displayName ?? u.username,
          email: u.email ?? null,
          role: u.role === "admin" ? "admin" : "user",
          disabled: u.disabled ? 1 : 0,
        });
        result.usersUpdated++;
        // Still passwordless (e.g. created by an earlier import), so still flag it.
        if (!(hasPassword.get(existing.id) as { ok: number } | undefined)?.ok) {
          result.usersNeedingPassword.push(u.username);
        }
      } else {
        // No password comes with a backup, so the account arrives disabled -
        // an import must never be a way to create a usable login.
        insertUser.run({
          id: nanoid(),
          username: u.username,
          displayName: u.displayName ?? u.username,
          email: u.email ?? null,
          role: u.role === "admin" ? "admin" : "user",
          avatarColor: u.avatarColor ?? "#64748b",
          now,
        });
        result.usersCreated++;
        result.usersNeedingPassword.push(u.username);
      }
    }

    // ---- Groups -----------------------------------------------------------
    // Restored before shares, because a share's grants and folder rules refer
    // to them by name.
    const findGroup = db.prepare("SELECT id FROM groups WHERE lower(name) = lower(?)");
    const insertGroup = db.prepare(
      "INSERT INTO groups (id, name, description, created_at) VALUES (@id, @name, @description, @now)",
    );
    const updateGroupRow = db.prepare("UPDATE groups SET description = @description WHERE id = @id");
    const clearMembers = db.prepare("DELETE FROM group_members WHERE group_id = ?");
    const addMember = db.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );

    for (const g of backup.groups ?? []) {
      if (!g?.name) continue;
      const existing = findGroup.get(g.name) as { id: string } | undefined;
      let groupId: string;
      if (existing) {
        groupId = existing.id;
        updateGroupRow.run({ id: groupId, description: g.description ?? "" });
        result.groupsUpdated++;
      } else {
        groupId = nanoid();
        insertGroup.run({ id: groupId, name: g.name, description: g.description ?? "", now });
        result.groupsCreated++;
      }
      clearMembers.run(groupId);
      for (const username of g.members ?? []) {
        const user = findUser.get(username) as { id: string } | undefined;
        if (!user) {
          result.warnings.push(`Group "${g.name}": no account named "${username}", membership skipped.`);
          continue;
        }
        addMember.run(groupId, user.id);
      }
    }

    // ---- Shares -----------------------------------------------------------
    const findShare = db.prepare("SELECT id FROM shares WHERE lower(name) = lower(?)");
    const insertShare = db.prepare(
      `INSERT INTO shares (id, name, comment, guest_access, smb_enabled, nfs_enabled, browseable, created_at, volume, recycle_enabled)
       VALUES (@id, @name, @comment, @guestAccess, @smb, @nfs, @browseable, @now, @volume, @recycle)`,
    );
    const updateShare = db.prepare(
      `UPDATE shares SET comment = @comment, guest_access = @guestAccess, smb_enabled = @smb,
              nfs_enabled = @nfs, browseable = @browseable, volume = @volume,
              recycle_enabled = @recycle WHERE id = @id`,
    );
    const clearPerms = db.prepare("DELETE FROM share_permissions WHERE share_id = ?");
    const addPerm = db.prepare(
      "INSERT INTO share_permissions (share_id, user_id, level) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    );
    const clearGroupPerms = db.prepare("DELETE FROM share_group_permissions WHERE share_id = ?");
    const addGroupPerm = db.prepare(
      "INSERT INTO share_group_permissions (share_id, group_id, level) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    );
    const clearAcls = db.prepare("DELETE FROM folder_acls WHERE share_id = ?");
    const addAcl = db.prepare(
      `INSERT INTO folder_acls (id, share_id, path, subject_type, subject_id, level, created_at)
       VALUES (@id, @share, @path, @type, @subject, @level, @now)
       ON CONFLICT(share_id, path, subject_type, subject_id) DO UPDATE SET level = excluded.level`,
    );

    for (const s of backup.shares ?? []) {
      if (!s?.name) continue;
      const fields = {
        name: s.name,
        comment: s.comment ?? "",
        guestAccess: ["none", "ro", "rw"].includes(s.guestAccess) ? s.guestAccess : "none",
        smb: s.smbEnabled === false ? 0 : 1,
        nfs: s.nfsEnabled ? 1 : 0,
        browseable: s.browseable === false ? 0 : 1,
        volume: s.volume ?? null,
        recycle: s.recycleEnabled ? 1 : 0,
      };
      const existing = findShare.get(s.name) as { id: string } | undefined;
      let shareId: string;
      if (existing) {
        shareId = existing.id;
        updateShare.run({ ...fields, id: shareId });
        result.sharesUpdated++;
      } else {
        shareId = nanoid();
        insertShare.run({ ...fields, id: shareId, now });
        result.sharesCreated++;
      }
      clearPerms.run(shareId);
      for (const p of s.permissions ?? []) {
        const user = findUser.get(p.username) as { id: string } | undefined;
        if (!user) {
          result.warnings.push(`Share "${s.name}": no account named "${p.username}", permission skipped.`);
          continue;
        }
        addPerm.run(shareId, user.id, p.level === "ro" ? "ro" : "rw");
      }

      clearGroupPerms.run(shareId);
      for (const p of s.groupPermissions ?? []) {
        const group = findGroup.get(p.group) as { id: string } | undefined;
        if (!group) {
          result.warnings.push(`Share "${s.name}": no group named "${p.group}", permission skipped.`);
          continue;
        }
        addGroupPerm.run(shareId, group.id, p.level === "ro" ? "ro" : "rw");
      }

      // Folder rules are replaced wholesale for the shares the backup mentions.
      // Merging them would leave a rule the backup dropped still in force, which
      // for a permission is the wrong way to be wrong.
      clearAcls.run(shareId);
      for (const rule of s.folderRules ?? []) {
        if (!rule?.path) continue;
        const subject = rule.subjectType === "group"
          ? (findGroup.get(rule.subject) as { id: string } | undefined)
          : (findUser.get(rule.subject) as { id: string } | undefined);
        if (!subject) {
          result.warnings.push(`Share "${s.name}": folder rule on "${rule.path}" names a missing ${rule.subjectType} "${rule.subject}", skipped.`);
          continue;
        }
        let path: string;
        try {
          path = normalizeAclPath(rule.path);
        } catch {
          result.warnings.push(`Share "${s.name}": folder rule path "${rule.path}" is not valid, skipped.`);
          continue;
        }
        if (!path) continue;
        addAcl.run({
          id: nanoid(),
          share: shareId,
          path,
          type: rule.subjectType === "group" ? "group" : "user",
          subject: subject.id,
          level: ["none", "ro", "rw"].includes(rule.level) ? rule.level : "none",
          now,
        });
        result.folderRules++;
      }
    }

    // ---- OIDC clients ------------------------------------------------------
    // Secrets aren't in the backup, so these are noted rather than recreated:
    // a client row with no usable secret would look configured but never work.
    for (const c of backup.oidcClients ?? []) {
      if (!c?.clientId) continue;
      const exists = db.prepare("SELECT 1 FROM oidc_clients WHERE client_id = ?").get(c.clientId);
      if (!exists) {
        result.warnings.push(`OIDC client "${c.name || c.clientId}" was not restored - re-create it to issue a new secret.`);
      }
    }
  });

  tx();
  return result;
}
