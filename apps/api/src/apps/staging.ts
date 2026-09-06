import { randomBytes } from "node:crypto";
import type { AppManifest, AppPermission, PendingInstall } from "@opennas/shared";
import { getInstalledApp } from "../db/installed-apps.js";
import { isTrusted } from "./trust.js";
import { commitPackage, validatePackage, type ValidatedPackage } from "./framework.js";

/**
 * Packages that passed validation and are waiting for an admin to approve what
 * they ask for.
 *
 * An app declares its capabilities in its manifest, and the bridge enforces them
 * for the life of the install - so the install itself is the only place a person
 * gets to say yes. Staging the validated package (rather than installing and
 * warning afterwards) means the review happens *before* anything reaches disk,
 * and means what's shown is read from the real package, not from a catalogue
 * entry the repository could get wrong.
 *
 * Held in memory: a staged package is tens of MB at most, and losing one across a
 * restart just means the admin clicks install again.
 */

interface Staged {
  pkg: ValidatedPackage;
  pending: PendingInstall;
  expiresAt: number;
  /** Repository it came from, carried through so the approval records it too. */
  sourceRepo: string | null;
}

const TTL_MS = 5 * 60 * 1000;
/** Bound on how much unconfirmed package data we're willing to hold. */
const MAX_STAGED = 5;

const staged = new Map<string, Staged>();

function prune(): void {
  const now = Date.now();
  for (const [token, s] of staged) {
    if (s.expiresAt <= now) staged.delete(token);
  }
}

/** What the installed version of this app was already granted. */
function grantedPermissions(appId: string): AppPermission[] {
  return getInstalledApp(appId)?.manifest.permissions ?? [];
}

/**
 * Decide whether a package can be installed straight away, and what a reviewer
 * would need to see if not.
 *
 * Consent is required when the package asks for a capability the installed
 * version doesn't already hold (every capability, on a fresh install), or when it
 * isn't from a publisher the admin has already trusted. A signed, trusted update
 * that asks for nothing new installs silently - that's what keeps one-click
 * installs and automatic updates one-click.
 */
export function reviewPackage(pkg: ValidatedPackage): { needsConsent: boolean; details: Omit<PendingInstall, "token" | "expiresAt"> } {
  const m = pkg.manifest;
  const installed = getInstalledApp(m.id);
  const granted = grantedPermissions(m.id);
  const permissions = m.permissions ?? [];
  const newPermissions = permissions.filter((p) => !granted.includes(p));
  const verified = !!m.signed && isTrusted(m.publisherFingerprint);

  return {
    needsConsent: newPermissions.length > 0 || !verified,
    details: {
      appId: m.id,
      name: m.name,
      version: m.version ?? "0.0.0",
      author: m.author ?? "",
      description: m.description,
      permissions,
      newPermissions,
      isUpdate: !!installed,
      signed: !!m.signed,
      publisherFingerprint: m.publisherFingerprint ?? null,
      verified,
      fetchHosts: m.fetchHosts ?? [],
    },
  };
}

/** Hold a validated package for review. Returns the PendingInstall to reply with. */
export function stagePackage(
  pkg: ValidatedPackage,
  details: Omit<PendingInstall, "token" | "expiresAt">,
  sourceRepo?: string | null,
): PendingInstall {
  prune();
  // Drop the oldest if we're at the cap, so a stream of uploads can't grow this.
  while (staged.size >= MAX_STAGED) {
    const oldest = [...staged.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) break;
    staged.delete(oldest[0]);
  }
  const expiresAt = Date.now() + TTL_MS;
  const pending: PendingInstall = {
    ...details,
    token: randomBytes(24).toString("base64url"),
    expiresAt: new Date(expiresAt).toISOString(),
  };
  staged.set(pending.token, { pkg, pending, expiresAt, sourceRepo: sourceRepo ?? null });
  return pending;
}

/**
 * Claim a staged package. Single-use: the token is consumed whether or not the
 * commit that follows succeeds, so one approval can't install twice.
 */
export function takeStaged(token: string): Staged | null {
  prune();
  const s = staged.get(token);
  if (!s) return null;
  staged.delete(token);
  return s;
}

/** Discard a staged package the admin declined. */
export function discardStaged(token: string): boolean {
  return staged.delete(token);
}

/** Drop everything staged for one app id (e.g. after it's uninstalled). */
export function discardStagedFor(appId: string): void {
  for (const [token, s] of staged) {
    if (s.pending.appId === appId) staged.delete(token);
  }
}

/** Either the package went straight in, or it's staged awaiting review. */
export type InstallOutcome =
  | { kind: "installed"; manifest: AppManifest }
  | { kind: "pending"; pending: PendingInstall };

/**
 * The one entry point every install path goes through - uploaded `.onpkg`,
 * one-click repo install, and applying an update. Validates, then either commits
 * (nothing new to approve) or stages for the admin to review.
 *
 * Throws AppError from validatePackage for anything the user should see.
 */
export async function prepareInstall(
  buf: Buffer | Uint8Array,
  sourceRepo?: string | null,
): Promise<InstallOutcome> {
  const pkg = validatePackage(buf);
  const { needsConsent, details } = reviewPackage(pkg);
  if (!needsConsent) return { kind: "installed", manifest: await commitPackage(pkg, sourceRepo) };
  return { kind: "pending", pending: stagePackage(pkg, details, sourceRepo) };
}
