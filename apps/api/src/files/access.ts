import type { User } from "@opennas/shared";
import { effectiveAccess, getShareRowByName, listShares, visibleShareNames } from "../db/shares.js";
import { lstat } from "node:fs/promises";
import { sep } from "node:path";
import { aclPathsBelow, applyFolderAcls, shareHasAcls } from "../db/acls.js";
import { groupIdsForUser } from "../db/groups.js";
import { normalizeVirtual, resolveSafe } from "./paths.js";

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

/** The share row and in-share folder rules below a virtual path, if any apply. */
function rulesBelow(user: User, virtualPath: string): { share: string; paths: string[] } | null {
  if (user.role === "admin") return null;
  const segments = normalizeVirtual(virtualPath).split("/").filter(Boolean);
  const share = segments[0] ? getShareRowByName(segments[0]) : null;
  if (!share || !shareHasAcls(share.id)) return null;
  const paths = aclPathsBelow(share.id, segments.slice(1).join("/"));
  return paths.length > 0 ? { share: share.name, paths } : null;
}

/**
 * The first item at or below `virtualPath` the user lacks `need` on, or null
 * when the whole subtree is fine.
 *
 * `pathAccess` answers for one path, which is not the question an operation on
 * a whole folder asks: deleting or moving `/Team` also deletes or moves
 * `/Team/HR`, and a folder rule making `HR` read-only has to stop that just as
 * it stops deleting `HR` directly. A subtree can only differ from its root where
 * a rule sits, so the check walks the rules rather than the disk.
 */
export async function subtreeDenial(user: User, virtualPath: string, need: keyof Access): Promise<string | null> {
  const top = normalizeVirtual(virtualPath);
  if (!pathAccess(user, top)[need]) return top;
  const rules = rulesBelow(user, top);
  if (!rules) return null;
  for (const rel of rules.paths) {
    const v = `/${rules.share}/${rel}`;
    if (pathAccess(user, v)[need]) continue;
    try {
      // A rule on a folder that doesn't exist guards nothing in this tree.
      if (!(await lstat(resolveSafe(v)).catch(() => null))) continue;
    } catch {
      /* unresolvable (e.g. escapes the share) - count it as present and denied */
    }
    return v;
  }
  return null;
}

/**
 * A per-entry read check for walking `virtualPath` (whose real path is
 * `realTop`), taking real paths as the walker produces them - or null when
 * nothing below can be less readable than the top, which is the common case and
 * lets the caller skip the per-entry lookups. Used by zip, copy and share links,
 * which read a whole tree on the strength of a check on its root.
 */
export function subtreeReadFilter(
  user: User,
  virtualPath: string,
  realTop: string,
): ((realPath: string) => boolean) | null {
  const top = normalizeVirtual(virtualPath);
  if (!rulesBelow(user, top)) return null;
  return (realPath: string) => {
    if (realPath !== realTop && !realPath.startsWith(realTop + sep)) return false;
    const rest = realPath.slice(realTop.length).split(sep).filter(Boolean).join("/");
    return pathAccess(user, rest ? `${top}/${rest}` : top).read;
  };
}
