import { nanoid } from "nanoid";
import { db } from "./index.js";
import { decryptSecret, encryptSecret, hashToken } from "./secrets.js";
import { hashRecoveryCode, normalizeRecoveryCode } from "../auth/totp.js";

/**
 * Two-factor enrolment state.
 *
 * A secret exists from the moment setup begins, but only counts as *enabled*
 * once `confirmed_at` is set - that is, once the user has proved they can read
 * a code from it. Without that split, a user who scanned a QR into the wrong
 * app, or closed the tab halfway, would be locked out of their own account.
 */

export interface TotpRecord {
  secret: string;
  confirmedAt: string | null;
  lastUsedStep: number | null;
}

interface TotpRow {
  user_id: string;
  secret: string;
  confirmed_at: string | null;
  created_at: string;
  last_used_step: number | null;
}

export function getTotp(userId: string): TotpRecord | null {
  const row = db.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(userId) as TotpRow | undefined;
  if (!row) return null;
  // Sealed at rest - a database read must not hand over the ability to mint
  // valid codes. A row written before encryption existed decrypts to itself, so
  // an upgrade doesn't lock anyone out of their own account.
  const secret = decryptSecret(row.secret);
  if (secret === null) return null;
  return { secret, confirmedAt: row.confirmed_at, lastUsedStep: row.last_used_step };
}

/** True only for a finished enrolment - an unconfirmed secret must not gate login. */
export function totpEnabled(userId: string): boolean {
  return getTotp(userId)?.confirmedAt != null;
}

/** Begin (or restart) enrolment. Replaces any unconfirmed secret. */
export function startTotpEnrolment(userId: string, secret: string): void {
  db.prepare(
    `INSERT INTO user_totp (user_id, secret, confirmed_at, created_at, last_used_step)
     VALUES (?, ?, NULL, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, confirmed_at = NULL,
                                        created_at = excluded.created_at, last_used_step = NULL`,
  ).run(userId, encryptSecret(secret), new Date().toISOString());
}

export function confirmTotp(userId: string, step: number): void {
  db.prepare("UPDATE user_totp SET confirmed_at = ?, last_used_step = ? WHERE user_id = ?")
    .run(new Date().toISOString(), step, userId);
}

/**
 * Record the time step a code was accepted at, refusing to go backwards. The
 * caller must reject a step that is not greater than `lastUsedStep`, so a code
 * observed over someone's shoulder can't be replayed inside its 30-second life.
 */
export function noteTotpStep(userId: string, step: number): void {
  db.prepare("UPDATE user_totp SET last_used_step = ? WHERE user_id = ?").run(step, userId);
}

export function disableTotp(userId: string): void {
  db.prepare("DELETE FROM user_totp WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM totp_recovery_codes WHERE user_id = ?").run(userId);
}

// ---- Recovery codes -------------------------------------------------------

export function replaceRecoveryCodes(userId: string, codes: string[]): void {
  const insert = db.prepare("INSERT OR REPLACE INTO totp_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)");
  db.transaction(() => {
    db.prepare("DELETE FROM totp_recovery_codes WHERE user_id = ?").run(userId);
    for (const code of codes) insert.run(userId, hashRecoveryCode(code));
  })();
}

export function countUnusedRecoveryCodes(userId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL")
      .get(userId) as { n: number }
  ).n;
}

/**
 * Spend a recovery code. Returns false if it doesn't exist or was already used;
 * the UPDATE's own row count is what makes it single-use even under two
 * simultaneous attempts.
 */
export function consumeRecoveryCode(userId: string, code: string): boolean {
  if (normalizeRecoveryCode(code).length === 0) return false;
  const result = db
    .prepare("UPDATE totp_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .run(new Date().toISOString(), userId, hashRecoveryCode(code));
  return result.changes === 1;
}

// ---- MFA tickets ----------------------------------------------------------

const TICKET_TTL_MS = 5 * 60 * 1000;
/** Wrong codes tolerated on one ticket before the password step must be redone. */
const TICKET_MAX_ATTEMPTS = 5;

/** Issued once a password checks out, exchanged for a session by the second factor. */
/**
 * A ticket proving the password step passed, to be spent with a second factor.
 *
 * The client gets the raw value; the database keeps only its hash, so a readable
 * database yields no usable half-finished logins.
 */
export function createMfaTicket(userId: string): string {
  const ticket = nanoid(32);
  db.prepare("INSERT INTO mfa_tickets (id, user_id, created_at) VALUES (?, ?, ?)")
    .run(hashToken(ticket), userId, Date.now());
  return ticket;
}

/**
 * Look up a ticket without spending it. Mistyping a six-digit code is common
 * enough that burning the ticket on the first wrong digit would just push people
 * back to the password screen; `failMfaTicket` caps how forgiving that is.
 */
export function peekMfaTicket(ticket: string): string | null {
  const id = hashToken(ticket);
  const row = db.prepare("SELECT * FROM mfa_tickets WHERE id = ?").get(id) as
    | { user_id: string; created_at: number; attempts: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > TICKET_TTL_MS || row.attempts >= TICKET_MAX_ATTEMPTS) {
    db.prepare("DELETE FROM mfa_tickets WHERE id = ?").run(id);
    return null;
  }
  return row.user_id;
}

/** Count a wrong code against the ticket, discarding it once it runs out of tries. */
export function failMfaTicket(ticket: string): void {
  const id = hashToken(ticket);
  db.prepare("UPDATE mfa_tickets SET attempts = attempts + 1 WHERE id = ?").run(id);
  db.prepare("DELETE FROM mfa_tickets WHERE id = ? AND attempts >= ?").run(id, TICKET_MAX_ATTEMPTS);
}

export function consumeMfaTicket(ticket: string): void {
  db.prepare("DELETE FROM mfa_tickets WHERE id = ?").run(hashToken(ticket));
}

/** Drop every pending ticket for a user - used when 2FA is turned off. */
export function clearMfaTickets(userId: string): void {
  db.prepare("DELETE FROM mfa_tickets WHERE user_id = ?").run(userId);
}
