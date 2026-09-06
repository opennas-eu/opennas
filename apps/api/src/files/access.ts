import type { User } from "@opennas/shared";
import { effectiveAccess, getShareRowByName, listShares, visibleShareNames } from "../db/shares.js";
import { applyFolderAcls, shareHasAcls } from "../db/acls.js";
import { groupIdsForUser } from "../db/groups.js";
import { normalizeVirtual } from "./paths.js";

export interface Access {
  read: boolean;
  write: boolean;
}

/**
 * Resolve a user's access to a virtual path. File Station is scoped to shared
 * folders: the root is the list of shares (readable, never directly writable -
 * shares are created in Control Panel), and the share that owns the first path
 * segment decides read/write below it. Admins have full access everywhere.
 *
 * Below the share root, folder rules can narrow (or widen up to read-write)
 * what the share granted - see `db/acls.ts` for how a level is decided. This
 * function is the one place that answers "may they?", so every caller that goes
 * through it - listing, reading, writing, search, zip, thumbnails, share links,
 * the recycle bin - picks up folder rules without being changed.
 */
export function pathAccess(user: User, virtualPath: string): Access {
  const p = normalizeVirtual(virtualPath);
  if (p === "/") return { read: true, write: false };
  if (user.role === "admin") return { read: true, write: true };

  const segments = p.split("/").filter(Boolean);
  const shareName = segments[0];
  if (!shareName) return { read: true, write: false };

  const level = effectiveAccess(shareName, user.id);
  if (level === "none") return { read: false, write: false };

  // Most shares have no folder rules at all; skip the lookup entirely for them.
  const share = getShareRowByName(shareName);
  if (!share || segments.length === 1 || !shareHasAcls(share.id)) {
    return { read: true, write: level === "rw" };
  }

  const effective = applyFolderAcls(
    share.id,
    segments.slice(1).join("/"),
    user.id,
    groupIdsForUser(user.id),
    level,
  );
  if (effective === "none") return { read: false, write: false };
  return { read: true, write: effective === "rw" };
}

/** Shared folders shown at the File Station root - admins see all of them. */
export function accessibleShareNames(user: User): string[] {
  const names = user.role === "admin"
    ? listShares().map((s) => s.name)
    : [...visibleShareNames(user.id)];
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
