import { createHash } from "node:crypto";
import { getSettingOr } from "../db/settings.js";

/**
 * Compromised-password screening via the Have I Been Pwned "Pwned Passwords"
 * range API, using k-anonymity: we send only the first 5 hex chars of the
 * password's SHA-1 and match the suffix locally - the password (and its full
 * hash) never leave the box. OpenNAS stores scrypt hashes, so this can only run
 * when we have the plaintext (at set time), which is exactly when it's useful.
 */

export const BLOCK_PWNED_SETTING = "password_block_pwned";

/** Times the password appears in known breaches (0 = clean), or null if HIBP
 *  couldn't be reached (offline NAS) - callers must fail open in that case. */
export async function checkPwned(password: string): Promise<number | null> {
  const sha1 = createHash("sha1").update(password.normalize("NFKC")).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: ctrl.signal,
      headers: { "Add-Padding": "true", "User-Agent": "OpenNAS" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    for (const line of text.split("\n")) {
      const [suf, count] = line.trim().split(":");
      if (suf === suffix) return Number(count) || 0;
    }
    return 0;
  } catch {
    return null; // offline / blocked - don't penalise the user
  } finally {
    clearTimeout(timer);
  }
}

/** Whether breached passwords are rejected outright (admin policy). */
export function blockPwnedEnabled(): boolean {
  return getSettingOr(BLOCK_PWNED_SETTING, "false") === "true";
}

/**
 * Screen a password at set time: returns whether it's breached (for flagging the
 * account) and whether it must be rejected (only when the policy is on AND HIBP
 * actually found it - an unreachable HIBP never blocks).
 */
export async function screenPassword(password: string): Promise<{ pwned: boolean; blocked: boolean }> {
  const count = await checkPwned(password);
  const pwned = (count ?? 0) > 0;
  return { pwned, blocked: blockPwnedEnabled() && pwned };
}
