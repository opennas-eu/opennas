import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";

/**
 * Protecting the things in the database that are worth stealing.
 *
 * Two mechanisms, because there are two different problems:
 *
 * **Hashing**, for anything the server only ever has to *recognise*. A session
 * cookie, a share-link token, a login ticket: the client presents it and we look
 * it up. Storing it verbatim means a copy of the database is a bag of working
 * credentials. Storing a hash means it is a bag of nothing - and costs nothing,
 * because we never needed the original back. These are 32 bytes of randomness,
 * so a plain SHA-256 is the right tool; there is no dictionary to grind and a
 * slow KDF would only add latency to every request.
 *
 * **Encryption**, for the few things the server genuinely has to read back. A
 * TOTP secret has to go into the HMAC on every sign-in; an SMTP password has to
 * be handed to the mail server. Those cannot be hashed, so they are sealed with
 * AES-256-GCM under a key in a file only the service account can read.
 *
 * ## What the encryption is and isn't worth
 *
 * The key sits on the same machine as the data it protects. There is no way
 * around that on an appliance that has to come back up unattended after a power
 * cut - anything else means someone typing a passphrase at the console on every
 * boot, which nobody would do.
 *
 * So it defends against the database being read *without* the key file:
 *
 * - a backup, snapshot or disk image copied off the machine
 * - a bug that discloses a file but not the whole filesystem
 * - the config export, which never carries the key
 * - a disk sold, returned under warranty, or thrown away
 *
 * It does **not** defend against someone who already has root, or the `opennas`
 * account, on a running machine: they can read the key and use it exactly as the
 * service does. Saying otherwise would be a lie, and the honest framing matters
 * - this narrows the blast radius of a leaked file, it does not make the NAS
 * safe to hand to an attacker.
 */

/**
 * Settings whose value contains a credential.
 *
 * Kept here, next to the settings store itself, rather than in whichever
 * consumer happened to need it first - a config backup that quietly exports a
 * password is the sort of bug that only shows up once the file has already been
 * emailed somewhere. Anything added to `settings` that holds a secret belongs in
 * this list on the same commit.
 *
 * It is a deny-list, which is the weaker shape: a new secret-bearing setting is
 * exported until someone remembers. An allow-list would be safer but would
 * silently *drop* settings from backups instead, which fails in a direction
 * people notice much later. The mitigation is that this list lives where the
 * keys are defined and is asserted by the backup tests.
 */
export const SECRET_SETTINGS = new Set([
  "smtp", // SMTP password
  "ddns", // dynamic-DNS provider token or password
]);

// ---- Hashing ---------------------------------------------------------------

/**
 * The stored form of a bearer token.
 *
 * Prefixed so a row's format is self-evident, and so the migration that
 * converted existing rows can be told apart from one that didn't run.
 */
export function hashToken(token: string): string {
  return `h1:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

/** Whether a stored value is already hashed, as opposed to a legacy raw token. */
export function isHashed(stored: string): boolean {
  return stored.startsWith("h1:");
}

/**
 * Constant-time comparison of two stored hashes.
 *
 * Lookups go through the primary-key index rather than through this, but where a
 * value is compared directly it should not leak its prefix through timing.
 */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---- Encryption ------------------------------------------------------------

const KEY_FILE = "secret.key";
const PREFIX_V1 = "enc1:";
const PREFIX = "enc2:";

/**
 * How long a value stays under one (key, nonce) pair.
 *
 * AES-GCM's nonce is 96 bits, and a repeat under the same key is not a
 * degradation — it is catastrophic. The repeated nonce leaks GHASH's `H`, and
 * from there an attacker can forge *any* message under that key forever. That is
 * the "forbidden attack", and it is why AES-GCM has a reputation as a footgun.
 *
 * A random 96-bit nonce is fine for a bounded number of messages and awful for
 * an unbounded one. OpenNAS is squarely in the first case — a few hundred values
 * over the life of a machine against a conservative ceiling of 2^32 — so `enc1:`
 * was never in danger. But the key never rotates, the count only ever grows, and
 * the failure is silent, so "we are far from the limit" is a fact with an expiry
 * date on it.
 *
 * `enc2:` removes the question instead of answering it. Every value gets a fresh
 * random 256-bit salt, and the key actually used is derived from the master key
 * and that salt with HKDF. Two values now share a GHASH `H` only if their
 * *salts* collide as well as their nonces — a 256-bit birthday bound rather than
 * a 96-bit one. It is the same idea as XChaCha20's extended nonce, built out of
 * what Node already ships rather than a new dependency.
 *
 * The cost is 32 bytes per stored secret, for a handful of secrets.
 */
const SALT_BYTES = 32;
const HKDF_INFO = "opennas-secret-v2";

let cachedKey: Buffer | null = null;

/**
 * The encryption key, created on first use.
 *
 * Deliberately its own file rather than a reuse of the session secret: rotating
 * one should not silently destroy the other. If the session secret is replaced,
 * everyone signs in again; if this one were lost, every TOTP enrolment and every
 * stored password would become unreadable.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const path = join(config.dataDir, KEY_FILE);
  try {
    const existing = readFileSync(path);
    if (existing.length === 32) {
      cachedKey = existing;
      return cachedKey;
    }
    // A truncated or corrupt key is not something to paper over by generating a
    // new one - that would silently orphan everything already encrypted.
    throw new Error(`${path} is not a 32-byte key`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fresh = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fresh, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* already written with the right mode; this is belt and braces */
  }
  cachedKey = fresh;
  return fresh;
}

/** True once a key exists - used by the UI to report the state honestly. */
export function encryptionReady(): boolean {
  return existsSync(join(config.dataDir, KEY_FILE));
}

/** The per-value key: HKDF-SHA256 over the master key and this value's salt. */
function subkey(salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", key(), salt, Buffer.from(HKDF_INFO, "utf8"), 32));
}

/**
 * Seal a value. Returns `enc2:<salt>:<iv>:<tag>:<ciphertext>`, all base64url.
 *
 * GCM rather than CBC so the ciphertext is authenticated: a database an attacker
 * can *write* to should not let them flip bits in an SMTP password and have it
 * silently decrypt to something else. The per-value salt is explained above —
 * it makes a nonce repeat harmless rather than fatal.
 */
export function encryptSecret(plaintext: string): string {
  if (plaintext === "") return "";
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subkey(salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX + salt.toString("base64url"),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}

/**
 * Open a sealed value.
 *
 * A value without the marker is returned unchanged: that is a row written before
 * encryption existed, and refusing to read it would lock people out of their own
 * accounts on upgrade. Callers re-seal on next write, and the migration sweeps
 * the rest.
 *
 * A value that *is* marked but fails to open returns null rather than throwing -
 * the caller decides whether that means "prompt again" or "this setting is
 * unusable", and neither should be a 500.
 */
export function decryptSecret(stored: string): string | null {
  if (stored === "") return "";

  // `enc1:` is still read, and always will be: an upgrade must never lock
  // somebody out of their own authenticator. Values are rewritten as `enc2:`
  // when they are next saved, and the boot pass converts the rest.
  if (stored.startsWith(PREFIX_V1)) return openV1(stored);
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext

  const [saltB64, ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
  if (!saltB64 || !ivB64 || !tagB64 || !ctB64) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      subkey(Buffer.from(saltB64, "base64url")),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or the ciphertext was tampered with. Both mean the same thing
    // to a caller: this value cannot be trusted.
    return null;
  }
}

/** Read a value written before the per-value salt existed. */
function openV1(stored: string): string | null {
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX_V1.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Whether a stored value is sealed at all, in either format. */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX) || stored.startsWith(PREFIX_V1);
}

/** Whether a sealed value is still in the old single-key format. */
export function needsUpgrade(stored: string): boolean {
  return stored.startsWith(PREFIX_V1);
}
