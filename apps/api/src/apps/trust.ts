import { getSetting, setSetting } from "../db/settings.js";

/** Publisher key fingerprints the admin has marked as trusted. */
export function trustedFingerprints(): string[] {
  try {
    return JSON.parse(getSetting("trusted_publishers") || "[]") as string[];
  } catch {
    return [];
  }
}

export function isTrusted(fingerprint: string | null | undefined): boolean {
  return !!fingerprint && trustedFingerprints().includes(fingerprint);
}

export function setTrusted(fingerprint: string, trusted: boolean): void {
  const set = new Set(trustedFingerprints());
  if (trusted) set.add(fingerprint);
  else set.delete(fingerprint);
  setSetting("trusted_publishers", JSON.stringify([...set]));
}
