import { randomBytes } from "node:crypto";

/**
 * Short-lived OIDC artefacts kept in memory: authorization codes (≤60s, single
 * use) and access tokens (1h). They don't need to survive a restart - a client
 * just repeats the flow - so this avoids extra DB tables.
 */

export interface AuthCode {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  nonce: string | null;
  codeChallenge: string | null;
  authTime: number;
  exp: number;
}

export interface AccessToken {
  userId: string;
  clientId: string;
  scope: string;
  exp: number;
}

const codes = new Map<string, AuthCode>();
const tokens = new Map<string, AccessToken>();

export function issueCode(data: Omit<AuthCode, "exp">): string {
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { ...data, exp: Date.now() + 60_000 });
  return code;
}

/** One-time: returns + deletes the code if valid + unexpired. */
export function consumeCode(code: string): AuthCode | null {
  const c = codes.get(code);
  if (!c) return null;
  codes.delete(code);
  return c.exp > Date.now() ? c : null;
}

export function issueAccessToken(data: Omit<AccessToken, "exp">, ttlSec = 3600): { token: string; exp: number } {
  const token = randomBytes(32).toString("base64url");
  const exp = Date.now() + ttlSec * 1000;
  tokens.set(token, { ...data, exp });
  return { token, exp };
}

export function getAccessToken(token: string): AccessToken | null {
  const t = tokens.get(token);
  if (!t) return null;
  if (t.exp <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  return t;
}

/** Periodic cleanup of expired artefacts. */
export function pruneOidc(): void {
  const now = Date.now();
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
  for (const [k, v] of tokens) if (v.exp <= now) tokens.delete(k);
}
