import { db } from "./index.js";
import { SECRET_SETTINGS, decryptSecret, encryptSecret } from "./secrets.js";

export { SECRET_SETTINGS };

/** Tiny key/value settings store (instance name, OIDC label overrides, ...). */


const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const setStmt = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getSetting(key: string): string | null {
  const row = getStmt.get(key) as { value: string } | undefined;
  if (row === undefined) return null;
  if (!SECRET_SETTINGS.has(key)) return row.value;
  // Sealed at rest. A value written before encryption existed comes back
  // unchanged, so an upgrade doesn't lose anyone's SMTP or DNS credentials; it
  // is re-sealed the next time it is saved, and the migration sweeps the rest.
  const opened = decryptSecret(row.value);
  // Null means the ciphertext didn't verify - a wrong key, or tampering. Treated
  // as absent rather than returned as garbage, so the caller falls back to its
  // defaults instead of trying to authenticate with nonsense.
  return opened;
}

export function getSettingOr(key: string, fallback: string): string {
  return getSetting(key) ?? fallback;
}

export function setSetting(key: string, value: string): void {
  setStmt.run(key, SECRET_SETTINGS.has(key) ? encryptSecret(value) : value);
}


