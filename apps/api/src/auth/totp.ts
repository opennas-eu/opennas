import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * TOTP (RFC 6238) over HMAC-SHA1, plus the base32 encoding authenticator apps
 * expect. Written by hand rather than pulled in: the whole algorithm is a HMAC,
 * a truncation and a modulo, and the dependency surface of an auth primitive is
 * worth keeping at zero.
 *
 * SHA-1 is not a security weakness here - HMAC-SHA1 is unbroken, and it is what
 * every authenticator app implements. Codes are 6 digits over 30-second steps,
 * which is the only combination Google Authenticator and friends read from a
 * QR without silently ignoring the parameters.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;
/** Accept the neighbouring steps, so a clock off by up to ±30s still works. */
const WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret - the key length RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The HOTP code for one counter value. Exported for the RFC test vectors. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  // Counters never come close to 2^53, so splitting into two 32-bit halves is
  // exact and avoids needing BigInt.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function currentStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/**
 * Verify a submitted code, returning the time step it matched so the caller can
 * refuse to accept that step again. Without that replay guard a code shoulder-
 * surfed (or captured by a proxy) stays valid for the rest of its 30 seconds.
 */
export function verifyTotp(secretB32: string, code: string, atMs = Date.now()): number | null {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== DIGITS) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretB32);
  } catch {
    return null;
  }
  const now = currentStep(atMs);
  const submitted = Buffer.from(digits);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = now + offset;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (expected.length === submitted.length && timingSafeEqual(expected, submitted)) return step;
  }
  return null;
}

/** The otpauth:// URI an authenticator app scans. */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- Recovery codes -------------------------------------------------------

const RECOVERY_COUNT = 10;
/** Crockford-ish: no I/L/O/U, so a code read off paper can't be mistyped. */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Ten single-use codes, each ~50 bits. Returned once, in plaintext, at setup. */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const bytes = randomBytes(10);
    let s = "";
    for (const b of bytes) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/**
 * Recovery codes are hashed with plain SHA-256, not scrypt. They're generated
 * here with ~50 bits of entropy, so there is no dictionary to attack and no
 * reason to pay a memory-hard KDF ten times per login attempt - unlike a
 * user-chosen password, which is why that path still uses scrypt.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}
