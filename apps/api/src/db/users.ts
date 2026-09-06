import { nanoid } from "nanoid";
import type { User, UserRole } from "@opennas/shared";
import { db } from "./index.js";

/** Persistence shape (snake_case) -> API shape (camelCase) lives here. */
interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  source: string;
  password_hash: string | null;
  avatar_color: string;
  avatar_path: string | null;
  created_at: string;
  last_login_at: string | null;
  disabled: number;
  password_pwned: number;
  must_change_password: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: (row.role === "admin" ? "admin" : "user") as UserRole,
    source: row.source,
    avatarColor: row.avatar_color,
    // API-base-relative (the frontend prefixes its configured API base); the ?v=
    // cache-busts so a freshly-uploaded picture shows immediately.
    avatarUrl: row.avatar_path
      ? `/auth/avatars/${row.id}?v=${encodeURIComponent(row.avatar_path)}`
      : null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

const AVATAR_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#10b981",
  "#06b6d4", "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
];

function pickColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function getUserById(id: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUserRowByUsername(username: string): UserRow | null {
  return (
    (db
      .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
      .get(username) as UserRow | undefined) ?? null
  );
}

export function getUserByUsername(username: string): User | null {
  const row = getUserRowByUsername(username);
  return row ? toUser(row) : null;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string | null;
  role: UserRole;
  source?: string;
  passwordHash?: string | null;
}

export function createUser(input: CreateUserInput): User {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, display_name, email, role, source, password_hash, avatar_color, created_at)
     VALUES (@id, @username, @display_name, @email, @role, @source, @password_hash, @avatar_color, @created_at)`,
  ).run({
    id,
    username: input.username,
    display_name: input.displayName,
    email: input.email ?? null,
    role: input.role,
    source: input.source ?? "local",
    password_hash: input.passwordHash ?? null,
    avatar_color: pickColor(input.username),
    created_at: now,
  });
  return getUserById(id)!;
}

export function getPasswordHash(userId: string): string | null {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
    | { password_hash: string | null }
    | undefined;
  return row?.password_hash ?? null;
}

export function setPasswordHash(userId: string, hash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
}

/** Flag whether the user's current password was found in a known breach. */
export function setPasswordPwned(userId: string, pwned: boolean): void {
  db.prepare("UPDATE users SET password_pwned = ? WHERE id = ?").run(pwned ? 1 : 0, userId);
}

/** On-disk filename of the user's avatar (under config.avatarsDir), or null. */
export function getAvatarFilename(userId: string): string | null {
  const row = db.prepare("SELECT avatar_path FROM users WHERE id = ?").get(userId) as
    | { avatar_path: string | null }
    | undefined;
  return row?.avatar_path ?? null;
}

export function setAvatarFilename(userId: string, filename: string | null): void {
  db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(filename, userId);
}

/**
 * True when an admin issued this account a temporary password. Cleared the
 * moment the user sets one of their own; see `auth/pending.ts` for the gate
 * that makes the flag mean something.
 */
export function mustChangePassword(userId: string): boolean {
  const row = db.prepare("SELECT must_change_password FROM users WHERE id = ?").get(userId) as
    | { must_change_password: number }
    | undefined;
  return row?.must_change_password === 1;
}

export function setMustChangePassword(userId: string, required: boolean): void {
  db.prepare("UPDATE users SET must_change_password = ? WHERE id = ?").run(required ? 1 : 0, userId);
}

export function markLogin(userId: string): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    userId,
  );
}

// ---- Admin / multi-user ---------------------------------------------------

export interface AdminUserRow {
  user: User;
  disabled: boolean;
  passkeyCount: number;
  activeSessions: number;
  passwordPwned: boolean;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
}

export function isUserDisabled(id: string): boolean {
  const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(id) as
    | { disabled: number }
    | undefined;
  return row?.disabled === 1;
}

export function listUsers(): AdminUserRow[] {
  const rows = db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
  const now = new Date().toISOString();
  return rows.map((row) => ({
    user: toUser(row),
    disabled: row.disabled === 1,
    passkeyCount: (
      db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").get(row.id) as { n: number }
    ).n,
    activeSessions: (
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?")
        .get(row.id, now) as { n: number }
    ).n,
    passwordPwned: row.password_pwned === 1,
    twoFactorEnabled: (
      db
        .prepare("SELECT COUNT(*) AS n FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL")
        .get(row.id) as { n: number }
    ).n > 0,
    mustChangePassword: row.must_change_password === 1,
  }));
}

export function countAdmins(excludeId?: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
      .get(excludeId ?? "") as { n: number }
  ).n;
}

export interface UpdateUserFields {
  displayName?: string;
  email?: string | null;
  role?: UserRole;
  disabled?: boolean;
}

export function updateUser(id: string, fields: UpdateUserFields): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (fields.displayName !== undefined) { sets.push("display_name = @display_name"); params.display_name = fields.displayName; }
  if (fields.email !== undefined) { sets.push("email = @email"); params.email = fields.email; }
  if (fields.role !== undefined) { sets.push("role = @role"); params.role = fields.role; }
  if (fields.disabled !== undefined) { sets.push("disabled = @disabled"); params.disabled = fields.disabled ? 1 : 0; }
  if (sets.length === 0) return;
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function deleteUser(id: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  // app_settings has no foreign key (its user_id is '' for admin-scoped rows,
  // so it can't reference users), which means the per-user rows have to go here.
  db.prepare("DELETE FROM app_settings WHERE user_id = ?").run(id);
}
