import { db } from "./index.js";

/** OIDC login transaction state (PKCE verifier + nonce), keyed by `state`. */
export function putOidcState(
  state: string,
  codeVerifier: string,
  nonce: string,
): void {
  db.prepare(
    "INSERT INTO oidc_states (state, code_verifier, nonce, created_at) VALUES (?, ?, ?, ?)",
  ).run(state, codeVerifier, nonce, Date.now());
}

export interface OidcStateRecord {
  codeVerifier: string;
  nonce: string;
}

export function takeOidcState(state: string): OidcStateRecord | null {
  const row = db.prepare("SELECT * FROM oidc_states WHERE state = ?").get(state) as
    | { code_verifier: string; nonce: string; created_at: number }
    | undefined;
  db.prepare("DELETE FROM oidc_states WHERE state = ?").run(state);
  if (!row) return null;
  if (Date.now() - row.created_at > 10 * 60 * 1000) return null; // 10 min TTL
  return { codeVerifier: row.code_verifier, nonce: row.nonce };
}

/** Link table between an IdP identity and a local user. */
export function getUserIdByOidc(provider: string, subject: string): string | null {
  const row = db
    .prepare("SELECT user_id FROM oidc_identities WHERE provider = ? AND subject = ?")
    .get(provider, subject) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function linkOidcIdentity(
  provider: string,
  subject: string,
  userId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO oidc_identities (provider, subject, user_id) VALUES (?, ?, ?)",
  ).run(provider, subject, userId);
}
