import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileSearchHit, User } from "@opennas/shared";
import { accessibleShareNames, pathAccess } from "./access.js";
import { resolveSafe } from "./paths.js";
import { mimeOf } from "./mime.js";

/**
 * Filename search across the shares a user may read.
 *
 * A NAS can hold millions of files and there's no index, so this is deliberately
 * a bounded best-effort walk rather than a promise of completeness: it stops at
 * a result cap, a visited-directory cap and a wall-clock deadline, and reports
 * whether it ran out. Breadth-first, so the shallow matches people usually want
 * come back before it starts descending into deep trees.
 *
 * Access is re-checked on every directory it enters, not just at the share root:
 * folder rules can close a branch below a share the user otherwise has, and a
 * search that walked past them would be a way to read the names of things you
 * cannot open. A file inherits its folder's access, so one check per directory
 * is enough - but a directory that is itself a *hit* is checked on its own,
 * since it would otherwise be listed by name from the parent it sits in.
 */

const MAX_HITS = 40;
const MAX_DIRS = 4000;
const DEADLINE_MS = 2500;
/** Directories never worth walking - noise, and often enormous. */
const SKIP_DIRS = new Set(["@eaDir", ".git", "node_modules", ".Trash", "#recycle", ".opennas-trash"]);

export interface FileSearchResult {
  hits: FileSearchHit[];
  /** True when a cap or the deadline stopped the walk before it finished. */
  truncated: boolean;
}

export async function searchFiles(user: User, query: string): Promise<FileSearchResult> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return { hits: [], truncated: false };

  const deadline = Date.now() + DEADLINE_MS;
  const hits: FileSearchHit[] = [];
  let dirsVisited = 0;
  let truncated = false;

  // Start at every share the user can read; the queue keeps this breadth-first.
  const queue: string[] = accessibleShareNames(user)
    .map((name) => `/${name}`)
    .filter((v) => pathAccess(user, v).read);

  while (queue.length > 0) {
    if (hits.length >= MAX_HITS || dirsVisited >= MAX_DIRS || Date.now() > deadline) {
      truncated = queue.length > 0;
      break;
    }
    const virtualDir = queue.shift()!;
    if (!pathAccess(user, virtualDir).read) continue; // a folder rule closed this branch
    let real: string;
    try {
      real = resolveSafe(virtualDir);
    } catch {
      continue; // path escaped the root - skip rather than fail the whole search
    }
    dirsVisited++;

    const entries = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue; // hidden files
      const childVirtual = `${virtualDir}/${entry.name}`;
      const isDir = entry.isDirectory();

      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(childVirtual);
      }
      if (hits.length >= MAX_HITS) continue;
      if (!entry.name.toLowerCase().includes(needle)) continue;
      // The parent was readable, which is what lets a *file* be a hit. A folder
      // has its own rules, and being visible in a listing isn't the same as
      // being open.
      if (isDir && !pathAccess(user, childVirtual).read) continue;

      const info = await stat(join(real, entry.name)).catch(() => null);
      hits.push({
        name: entry.name,
        path: childVirtual,
        /** The folder to open in File Station to reveal this hit. */
        parent: virtualDir,
        type: isDir ? "dir" : "file",
        sizeBytes: isDir ? 0 : (info?.size ?? 0),
        modifiedAt: info ? info.mtime.toISOString() : null,
        mime: isDir ? null : mimeOf(entry.name),
      });
    }
  }

  // Prefer names that start with the query, then shorter names - both are good
  // proxies for "the thing you actually meant".
  hits.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  });

  return { hits, truncated: truncated || hits.length >= MAX_HITS };
}
