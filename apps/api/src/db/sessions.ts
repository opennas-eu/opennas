import { randomBytes } from "node:crypto";
import type { AuthMethod } from "@opennas/shared";
import { config } from "../config.js";
import { hashToken } from "./secrets.js";
import { db } from "./index.js";

export interface SessionRecord {
  /**
   * The session's identity *as stored* - a hash of the token, not the token.
   * Safe to show a client and to compare against, and useless as a credential.
   */
  id: string;
  userId: string;
  authMethods: AuthMethod[];
  createdAt: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  auth_methods: string;
  created_at: string;
  expires_at: string;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    authMethods: safeParse(row.auth_methods),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function safeParse(json: string): AuthMethod[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AuthMethod[]) : [];
  } catch {
    return [];
  }
}

/** A new session, plus the one-time token that goes in the cookie. */
export interface NewSession extends SessionRecord {
  /**
   * The value to put in the cookie. Returned exactly once, from here - it is
   * never stored, so it cannot be recovered afterwards from the database.
   */
  token: string;
}

/**
 * Start a session.
 *
 * The cookie carries 32 random bytes; the database stores only a hash of them.
 * Previously the two were the same string, which made a readable database a bag
 * of working session cookies - anyone who could read the file could resume any
 * signed-in session without a password and without the second factor.
 */
export function createSession(
  userId: string,
  authMethods: AuthMethod[],
  meta: { userAgent?: string; ip?: string } = {},
): NewSession {
  const token = randomBytes(32).toString("base64url");
  const id = hashToken(token);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + config.sessionTtlMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, auth_methods, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    JSON.stringify(authMethods),
    meta.userAgent ?? null,
    meta.ip ?? null,
    createdAt,
    expiresAt,
  );
  return { id, token, userId, authMethods, createdAt, expiresAt };
}

/**
 * Resolve a cookie value to its session.
 *
 * Takes the *raw* token from the cookie and hashes it to find the row, so the
 * stored form is never the thing being presented.
 */
export function getValidSession(token: string): SessionRecord | null {
  const id = hashToken(token);
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | SessionRow
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    deleteSession(id);
    return null;
  }
  return toRecord(row);
}

export function deleteSession(id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * Throw away every session that was created by automatic sign-in.
 *
 * Called whenever the autologin rules change. Without it, narrowing the network
 * list or switching the account would leave live sessions behind that the new
 * rules would never have granted - the setting would appear to take effect while
 * the old access quietly continued until it expired.
 */
export function deleteAutologinSessions(): number {
  return db
    .prepare("DELETE FROM sessions WHERE auth_methods LIKE '%\"autologin\"%'")
    .run().changes;
}

export function deleteAllForUser(userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

/** One of a user's active sessions, with the device metadata captured at login. */
export interface SessionDetail extends SessionRecord {
  userAgent: string | null;
  ip: string | null;
}

/** A user's non-expired sessions, newest first. */
export function listForUser(userId: string): SessionDetail[] {
  const rows = db
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .all(userId, new Date().toISOString()) as (SessionRow & { user_agent: string | null; ip: string | null })[];
  return rows.map((row) => ({ ...toRecord(row), userAgent: row.user_agent, ip: row.ip }));
}

/**
 * Delete one session, but only if it belongs to `userId`. Scoping the delete to
 * the owner means a guessed/stale session id can't be used to sign someone else out.
 */
export function deleteOwnedSession(userId: string, sessionId: string): boolean {
  const res = db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").run(sessionId, userId);
  return res.changes > 0;
}

/** Sign the user out everywhere except the session they're calling from. */
export function deleteOtherSessionsForUser(userId: string, keepSessionId: string): number {
  return db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId).changes;
}
