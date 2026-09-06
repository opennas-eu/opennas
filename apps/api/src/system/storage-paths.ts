import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { StorageLocations } from "@opennas/shared";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db/settings.js";

/**
 * Configurable storage locations for the data OpenNAS manages on behalf of VMs
 * and containers, so an admin can keep the big stuff on a data volume instead of
 * the (often small) OS disk.
 *
 * Each setting is a *base directory*; the concrete sub-dirs are resolved under
 * it on demand (and created if missing). Unset = the built-in default under the
 * data dir. Changing a location affects *newly created* items - existing VM
 * disks and container bind-mounts keep their absolute paths and are not moved.
 */

const KEY = "storage_locations";

/** Built-in defaults, surfaced in the UI as the fallback for an unset location. */
export const storageDefaults = {
  vm: resolve(config.dataDir, "vm"),
  containers: config.dataDir,
} as const;

function read(): StorageLocations {
  try {
    const raw = getSetting(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<StorageLocations>;
      return { vm: p.vm ?? null, containers: p.containers ?? null };
    }
  } catch {
    /* malformed setting - fall back to defaults */
  }
  return { vm: null, containers: null };
}

function ensure(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Pseudo / kernel filesystems that must never be a data location. Beyond being
 * nonsensical, a `mkdirSync` under `/proc` actually *blocks* (the syscall never
 * returns) - so we reject these before touching the filesystem at all.
 */
const PSEUDO_FS = ["/proc", "/sys", "/dev", "/run"];

function isPseudoFs(path: string): boolean {
  return PSEUDO_FS.some((p) => path === p || path.startsWith(p + "/"));
}

/** Walk up until we hit a path that exists (so we can probe a real ancestor). */
function nearestExisting(path: string): string {
  let p = path;
  while (!existsSync(p)) {
    const parent = dirname(p);
    if (parent === p) return p;
    p = parent;
  }
  return p;
}

/** Current configured base dirs (null = default). */
export function getStorageLocations(): StorageLocations {
  return read();
}

function vmBase(): string {
  return ensure(read().vm ?? storageDefaults.vm);
}
function containerBase(): string {
  return ensure(read().containers ?? storageDefaults.containers);
}

// Effective directories, used by the virt / services / compose modules.
export function vmDisksDir(): string {
  return ensure(resolve(vmBase(), "disks"));
}
export function isoDir(): string {
  return ensure(resolve(vmBase(), "iso"));
}
export function servicesDir(): string {
  return ensure(resolve(containerBase(), "services"));
}
export function stacksDir(): string {
  return ensure(resolve(containerBase(), "stacks"));
}

/**
 * Validate + persist new base dirs. For each provided key: an empty/null value
 * clears it back to the default; otherwise the path must be absolute and
 * creatable + writable by the service user (so a typo or a path on an unmounted
 * volume is rejected up front rather than failing later at create time).
 */
export function setStorageLocations(input: { vm?: string | null; containers?: string | null }): {
  ok: boolean;
  error?: string;
} {
  const next = read();
  for (const key of ["vm", "containers"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value == null || value.trim() === "") {
      next[key] = null;
      continue;
    }
    const raw = value.trim();
    if (!isAbsolute(raw)) return { ok: false, error: `The path must be absolute (start with "/").` };
    const path = resolve(raw); // normalize (collapse "." / "..")
    if (isPseudoFs(path)) return { ok: false, error: `"${path}" is a system path, not a storage location.` };
    // Probe the nearest existing ancestor for write access BEFORE any mkdir, so a
    // permission problem (or a path on an unmounted volume) fails fast and can't
    // block on a pseudo-fs. Only create the directory once the anchor is writable.
    try {
      accessSync(nearestExisting(path), constants.W_OK);
    } catch {
      return { ok: false, error: `Can't write under "${path}". Pick a path on a mounted, writable volume.` };
    }
    try {
      ensure(path);
    } catch {
      return { ok: false, error: `Couldn't create "${path}".` };
    }
    next[key] = path;
  }
  setSetting(KEY, JSON.stringify(next));
  return { ok: true };
}

// ---- Per-item storage targets ---------------------------------------------

/**
 * Where a *single* VM or container's data can be put, chosen when it's created.
 *
 * The configured locations above are defaults; this is the per-item override.
 * The two exist for different reasons: the default is "where new things go
 * unless told otherwise", while a target answers "this 2 TB VM should live on
 * the big disk, even though everything else goes on the SSD".
 *
 * A target is a data-volume label, or "" meaning the configured default. Labels
 * rather than paths, because a label is stable and safe to accept from a client
 * - an arbitrary path from a request would be a way to write anywhere the
 * service user can reach.
 */

/** Absolute path of a data volume by label, or null if it isn't a real volume. */
function volumePath(label: string): string | null {
  if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) return null;
  const path = resolve(config.volumesRoot, label);
  // resolve() collapses any traversal; confirm it really is directly under the
  // volumes root and exists as a directory.
  if (dirname(path) !== resolve(config.volumesRoot)) return null;
  return existsSync(path) ? path : null;
}

/** Every place a new VM or container may be stored, for the create forms. */
export function listStorageTargets(): { label: string; name: string; path: string }[] {
  const targets = [
    { label: "", name: "Default location", path: read().vm ?? storageDefaults.vm },
  ];
  try {
    for (const entry of readdirSync(config.volumesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      targets.push({
        label: entry.name,
        name: entry.name,
        path: resolve(config.volumesRoot, entry.name),
      });
    }
  } catch {
    /* no volumes root yet - the default is still offered */
  }
  return targets;
}

/**
 * Resolve a target label to the base directory for a given kind of data.
 * An unknown or empty label falls back to the configured default, so a stale
 * label (a volume that was removed) degrades to "somewhere that works" rather
 * than failing the create.
 */
function targetBase(target: string | null | undefined, kind: "vm" | "containers"): string {
  const vol = target ? volumePath(target) : null;
  if (vol) return ensure(resolve(vol, "opennas", kind));
  return kind === "vm" ? vmBase() : containerBase();
}

export function vmDisksDirFor(target?: string | null): string {
  return ensure(resolve(targetBase(target, "vm"), "disks"));
}
export function servicesDirFor(target?: string | null): string {
  return ensure(resolve(targetBase(target, "containers"), "services"));
}
export function stacksDirFor(target?: string | null): string {
  return ensure(resolve(targetBase(target, "containers"), "stacks"));
}

/**
 * Every base directory a given kind of data might live in - the configured
 * default plus one per volume. Listing has to look in all of them, because an
 * item's target was chosen when it was created and isn't recorded anywhere else.
 */
export function allBasesFor(kind: "vm" | "containers"): string[] {
  const bases = new Set<string>();
  bases.add(kind === "vm" ? (read().vm ?? storageDefaults.vm) : (read().containers ?? storageDefaults.containers));
  for (const t of listStorageTargets()) {
    if (!t.label) continue;
    bases.add(resolve(t.path, "opennas", kind));
  }
  return [...bases];
}
