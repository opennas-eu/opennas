import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./index.js";

/** Registered OIDC relying parties (clients). Secrets are stored as a SHA-256
 *  (they're already high-entropy random, so a fast hash is sufficient). */

export interface OidcClientRow {
  client_id: string;
  secret_hash: string;
  name: string;
  redirect_uris: string;
  scopes: string;
  created_at: string;
}

export interface OidcClientRecord {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  createdAt: string;
}

function toRecord(r: OidcClientRow): OidcClientRecord {
  return {
    clientId: r.client_id,
    name: r.name,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    scopes: r.scopes.split(/\s+/).filter(Boolean),
    createdAt: r.created_at,
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function listClients(): OidcClientRecord[] {
  return (db.prepare("SELECT * FROM oidc_clients ORDER BY created_at").all() as OidcClientRow[]).map(toRecord);
}

export function getClient(clientId: string): OidcClientRecord | null {
  const r = db.prepare("SELECT * FROM oidc_clients WHERE client_id = ?").get(clientId) as OidcClientRow | undefined;
  return r ? toRecord(r) : null;
}

/** Create a client; returns the record + the one-time plaintext secret. */
export function createClient(name: string, redirectUris: string[], scopes: string[]): { record: OidcClientRecord; secret: string } {
  const clientId = "onc_" + randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO oidc_clients (client_id, secret_hash, name, redirect_uris, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(clientId, sha256(secret), name, JSON.stringify(redirectUris), scopes.join(" "), new Date().toISOString());
  return { record: getClient(clientId)!, secret };
}

export function deleteClient(clientId: string): boolean {
  return db.prepare("DELETE FROM oidc_clients WHERE client_id = ?").run(clientId).changes > 0;
}

/** Constant-time client-secret check. */
export function verifyClientSecret(clientId: string, secret: string): boolean {
  const r = db.prepare("SELECT secret_hash FROM oidc_clients WHERE client_id = ?").get(clientId) as { secret_hash: string } | undefined;
  if (!r) return false;
  const a = Buffer.from(sha256(secret));
  const b = Buffer.from(r.secret_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
