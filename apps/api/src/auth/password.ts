import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// promisify(scrypt) drops the options overload, so wrap it by hand to keep N/r/p.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived as Buffer),
    );
  });
}

const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1 } as const;

/**
 * Password hashing with scrypt from Node's stdlib - no native dep, memory-hard.
 * Format: scrypt$N$r$p$<saltB64>$<hashB64>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, PARAMS)) as Buffer;
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const actual = (await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
    N,
    r,
    p,
  })) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Lightweight strength gate; the UI does the friendly nudging. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 256) return "Password is too long.";
  return null;
}
