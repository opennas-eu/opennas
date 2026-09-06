import { resolve, sep, normalize, posix } from "node:path";
import { config } from "../config.js";
import { getShareRowByName, listShares } from "../db/shares.js";

const FILES_ROOT = resolve(config.filesRoot);
const VOLUMES_ROOT = resolve(config.volumesRoot);

/**
 * File Station presents shared folders as the top level: the FIRST path segment
 * is a share name, the rest is a path inside that share. A share's real folder
 * lives either under the default files root or on a data volume (kept in sync
 * with services.shareBasePath). This module is the single chokepoint that maps a
 * virtual path onto the real filesystem and enforces that it can't escape the
 * owning share.
 */

/** Real base directory for a share, or null if no such share exists. */
function shareBaseReal(name: string): string | null {
  const row = getShareRowByName(name);
  if (!row) return null;
  return row.volume ? resolve(VOLUMES_ROOT, row.volume, row.name) : resolve(FILES_ROOT, row.name);
}

/** Normalize a virtual path for display/echo (leading slash, no trailing). */
export function normalizeVirtual(virtualPath: string): string {
  return posix.normalize("/" + (virtualPath || "/")).replace(/\/+$/, "") || "/";
}

/** Path segments of a virtual path: "/Media/Movies" -> ["Media", "Movies"]. */
export function virtualSegments(virtualPath: string): string[] {
  return normalizeVirtual(virtualPath).split("/").filter(Boolean);
}

/** True when the path points at a shared-folder root (exactly one segment). */
export function isShareRoot(virtualPath: string): boolean {
  return virtualSegments(virtualPath).length === 1;
}

/**
 * Translate a user-supplied virtual path into a real filesystem path, guaranteed
 * to stay inside the owning share. Throws on the bare root ("/", which is the
 * share list and has no single real path), an unknown share, or any traversal.
 */
export function resolveSafe(virtualPath: string): string {
  const clean = normalizeVirtual(virtualPath);
  if (clean.includes("\0")) throw new PathError("Invalid path.");
  const segs = clean.split("/").filter(Boolean);
  if (segs.length === 0) throw new PathError("The share root is not a real folder.");

  const base = shareBaseReal(segs[0]!);
  if (!base) throw new PathError("No such shared folder.");

  const rest = segs.slice(1).join("/");
  const real = rest ? resolve(base, "." + "/" + rest) : base;
  if (real !== base && !real.startsWith(base + sep)) {
    throw new PathError("Path escapes the shared folder.");
  }
  return real;
}

/** Convert a real path back to the virtual (share-rooted) path shown to the user. */
export function toVirtual(realPath: string): string {
  const real = resolve(realPath);
  for (const s of listShares()) {
    const base = s.volume ? resolve(VOLUMES_ROOT, s.volume, s.name) : resolve(FILES_ROOT, s.name);
    if (real === base) return "/" + s.name;
    if (real.startsWith(base + sep)) {
      const rel = real.slice(base.length).split(sep).filter(Boolean).join("/");
      return "/" + s.name + "/" + rel;
    }
  }
  return "/"; // not inside any share
}

/** Reject names that would break out of a directory or hit reserved chars. */
export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") throw new PathError("Invalid name.");
  if (/[\\/\0]/.test(trimmed)) throw new PathError("Name cannot contain slashes.");
  if (normalize(trimmed) !== trimmed) throw new PathError("Invalid name.");
  if (trimmed.length > 255) throw new PathError("Name is too long.");
  return trimmed;
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}
