import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "../config.js";

/**
 * Image thumbnail cache for File Station's grid view. Rather than shipping a
 * full-resolution photo per tile (a folder of 20 MB images = 20 MB per tile),
 * the grid requests small WebP thumbnails that are generated once with sharp
 * (libvips) and cached on disk under `config.thumbsDir`.
 *
 * The cache key hashes the real path together with the file's mtime + size, so
 * editing or replacing an image transparently invalidates its old thumbnail -
 * there's never a stale tile, and the cache can be deleted at any time.
 */

/** Longest edge of a generated thumbnail, in CSS-ish px. Clamped by the route. */
export const DEFAULT_THUMB_SIZE = 256;

/** Don't even attempt to decode sources larger than this (protects memory). */
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

/** Cap the on-disk thumbnail cache. Browsing big image folders generates one
 *  tiny WebP per image; without a ceiling the cache grows forever. When we cross
 *  this budget we evict the least-recently-used entries down to {@link CACHE_LOW_WATER}. */
const CACHE_MAX_BYTES = 512 * 1024 * 1024;
const CACHE_LOW_WATER = Math.floor(CACHE_MAX_BYTES * 0.8);

/** MIME types sharp can reliably decode on a stock build. */
const THUMBABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/tiff",
]);

export function isThumbable(mime: string | null): boolean {
  return !!mime && THUMBABLE.has(mime);
}

export class ThumbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbError";
  }
}

/**
 * Return the WebP thumbnail bytes for a real image path, generating and caching
 * it on first use. Throws {@link ThumbError} for oversized sources or images
 * sharp can't decode (the route turns that into a clean 415 so the client falls
 * back to a generic icon).
 */
export async function getThumbnail(
  realPath: string,
  size: number,
  mtimeMs: number,
  fileSize: number,
): Promise<Buffer> {
  const key = createHash("sha1")
    .update(`${realPath}\0${mtimeMs}\0${fileSize}\0${size}`)
    .digest("hex");
  const cacheFile = join(config.thumbsDir, `${key}.webp`);

  const cached = await readFile(cacheFile).catch(() => null);
  if (cached) return cached;

  if (fileSize > MAX_SOURCE_BYTES) {
    throw new ThumbError("Image is too large to thumbnail.");
  }

  let out: Buffer;
  try {
    out = await sharp(realPath, { failOn: "none", animated: false })
      .rotate() // honor EXIF orientation before resizing
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch {
    throw new ThumbError("Could not decode this image.");
  }

  // Best-effort cache write - a failure here just means we regenerate next time.
  await writeFile(cacheFile, out).catch(() => {});
  void pruneCache();
  return out;
}

/**
 * Keep the thumbnail cache under {@link CACHE_MAX_BYTES} by evicting the
 * least-recently-used entries (oldest access time first) whenever it overflows.
 * Runs at most once at a time and never throws into the request path - a failed
 * prune just means we try again after the next thumbnail is written.
 */
let pruning = false;
async function pruneCache(): Promise<void> {
  if (pruning) return;
  pruning = true;
  try {
    const names = await readdir(config.thumbsDir);
    const entries: { path: string; size: number; atimeMs: number }[] = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".webp")) continue;
      const p = join(config.thumbsDir, name);
      const s = await stat(p).catch(() => null);
      if (!s?.isFile()) continue;
      entries.push({ path: p, size: s.size, atimeMs: s.atimeMs });
      total += s.size;
    }
    if (total <= CACHE_MAX_BYTES) return;

    // Evict oldest-accessed first until we're back under the low-water mark.
    entries.sort((a, b) => a.atimeMs - b.atimeMs);
    for (const e of entries) {
      if (total <= CACHE_LOW_WATER) break;
      await rm(e.path, { force: true }).catch(() => {});
      total -= e.size;
    }
  } catch {
    /* best-effort - cache is safe to leave as-is */
  } finally {
    pruning = false;
  }
}
