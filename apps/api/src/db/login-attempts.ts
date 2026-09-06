import type { AccountLockout } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Per-account failed sign-in tracking.
 *
 * The existing per-IP rate limit does nothing about a slow attack, or one spread
 * across many addresses, aimed at a single account. This adds the other axis.
 *
 * The obvious hazard is that account lockout is itself a denial of service:
 * anyone who knows a username could keep an admin locked out forever. Two things
 * keep that in check - the lockout is short and self-clearing (it never needs an
 * admin to intervene, capped at `MAX_LOCK_MS`), and an admin can clear one
 * explicitly. The goal is to make brute force impractically slow, not to make a
 * username a weapon.
 */

/** Failures tolerated before the first lockout. */
const THRESHOLD = 8;
/** Failures older than this are forgotten, so occasional typos never accumulate. */
const WINDOW_MS = 15 * 60 * 1000;
const BASE_LOCK_MS = 60 * 1000;
/** Ceiling on a lockout - long enough to ruin brute force, short enough to wait out. */
const MAX_LOCK_MS = 15 * 60 * 1000;

interface Row {
  username: string;
  failures: number;
  first_fail_at: string | null;
  last_fail_at: string | null;
  locked_until: string | null;
}

function key(username: string): string {
  return username.trim().toLowerCase();
}

function getRow(username: string): Row | undefined {
  return db.prepare("SELECT * FROM login_attempts WHERE username = ?").get(key(username)) as Row | undefined;
}

/**
 * How long the caller must wait, in seconds, or 0 if they may try now.
 *
 * Called for every attempt - including for usernames that don't exist, so the
 * response can't be used to tell which accounts are real.
 */
export function lockoutRemainingSeconds(username: string): number {
  const row = getRow(username);
  if (!row?.locked_until) return 0;
  const remaining = Date.parse(row.locked_until) - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Record a failed attempt and return the lockout it caused, in seconds (0 if
 * none yet). Each failure past the threshold doubles the wait, up to the cap.
 */
export function recordFailure(username: string): number {
  const name = key(username);
  const now = Date.now();
  const row = getRow(name);

  // Start a fresh window if the last failure is old news.
  const stale = row?.last_fail_at ? now - Date.parse(row.last_fail_at) > WINDOW_MS : true;
  const failures = stale ? 1 : (row?.failures ?? 0) + 1;

  let lockedUntil: string | null = null;
  if (failures >= THRESHOLD) {
    const over = failures - THRESHOLD;
    lockedUntil = new Date(now + Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS)).toISOString();
  }

  db.prepare(
    `INSERT INTO login_attempts (username, failures, first_fail_at, last_fail_at, locked_until)
     VALUES (@name, @failures, @now, @now, @lockedUntil)
     ON CONFLICT(username) DO UPDATE SET
       failures = @failures,
       first_fail_at = CASE WHEN @failures = 1 THEN @now ELSE login_attempts.first_fail_at END,
       last_fail_at = @now,
       locked_until = @lockedUntil`,
  ).run({ name, failures, now: new Date(now).toISOString(), lockedUntil });

  return lockedUntil ? Math.ceil((Date.parse(lockedUntil) - now) / 1000) : 0;
}

/** Clear the counter after a successful sign-in. */
export function recordSuccess(username: string): void {
  db.prepare("DELETE FROM login_attempts WHERE username = ?").run(key(username));
}

/** Accounts currently locked, for the admin view. */
export function listLockouts(): AccountLockout[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare("SELECT * FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until > ? ORDER BY locked_until DESC")
    .all(now) as Row[];
  return rows.map((r) => ({
    username: r.username,
    failures: r.failures,
    lastFailAt: r.last_fail_at,
    lockedUntil: r.locked_until!,
  }));
}

/** Admin override - lets someone back in without waiting out the timer. */
export function clearLockout(username: string): boolean {
  return db.prepare("DELETE FROM login_attempts WHERE username = ?").run(key(username)).changes > 0;
}
