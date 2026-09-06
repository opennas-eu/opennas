import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign as cryptoSign,
} from "node:crypto";
import { config } from "../config.js";

/**
 * RS256 signing key for the OIDC provider. Generated once and persisted (the kid
 * is derived from the key, so it survives restarts and clients keep validating).
 */

const KEY_PATH = resolve(config.oidcDir, "private.pem");

function loadOrCreate(): KeyObject {
  if (existsSync(KEY_PATH)) {
    return createPrivateKey(readFileSync(KEY_PATH));
  }
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  return privateKey;
}

const privateKey = loadOrCreate();
const publicKey = createPublicKey(privateKey);

/** Stable key id: first 16 bytes of the SHA-256 of the public key (DER), hex. */
export const kid = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 32);

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a JWT (RS256) from a claims payload. */
export function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(cryptoSign("RSA-SHA256", Buffer.from(data), privateKey));
  return `${data}.${sig}`;
}

/** Public JWKS document (one RSA key). */
export function jwks(): { keys: Record<string, unknown>[] } {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
}
