import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import type {
  ZfsDataset,
  ZfsLayout,
  ZfsLayoutInfo,
  ZfsPool,
  ZfsSnapshot,
  ZfsStatus,
  ZfsVdev,
  ZfsVdevMember,
} from "@opennas/shared";
import { config } from "../config.js";

const exec = promisify(execFile);

/**
 * ZFS pools, datasets and snapshots.
 *
 * OpenNAS already had mdadm, which does redundancy and nothing else - a RAID 5
 * array will happily hand back a silently corrupted block, because parity is
 * only consulted when a disk *says* it failed. ZFS checksums every block and
 * repairs from redundancy when the checksum disagrees, which on a box whose
 * whole purpose is keeping files for years is a different class of promise.
 *
 * It also brings the thing btrfs could not: a dataset is a real filesystem, so a
 * share placed on one gets a **per-share quota the kernel enforces**, rather
 * than the project-quota trick that only works on ext4 and xfs.
 *
 * ## Everything privileged goes through the helper
 *
 * Nothing here runs `zpool` directly. Reads and writes both go through
 * `opennas-zfs` under doas, for the usual reason: the backend is reachable from
 * the network, and `zpool create` on the wrong device is unrecoverable. The
 * helper re-validates every argument rather than trusting that this side did.
 *
 * ## Parsing
 *
 * `zpool list -Hp` and `zfs list -Hp` are stable, tab-separated and exact-byte -
 * those are parsed field by field. `zpool status` is not machine-readable and
 * never has been, so it is parsed defensively: anything unrecognised is skipped
 * rather than guessed at, and the raw summary line is passed through so the UI
 * can always fall back on ZFS's own words.
 */

const HELPER = config.zfsHelper;

/** What each layout costs and survives. Single source of truth for the UI. */
export const ZFS_LAYOUTS: ZfsLayoutInfo[] = [
  {
    id: "mirror",
    name: "Mirror",
    minDisks: 2,
    faultTolerance: 1,
    note: "Every disk holds the same data. Survives losing all but one, and rebuilds fastest.",
  },
  {
    id: "raidz1",
    name: "RAIDZ1 - single parity",
    minDisks: 3,
    faultTolerance: 1,
    note: "One disk's worth of parity. Survives one failure.",
  },
  {
    id: "raidz2",
    name: "RAIDZ2 - double parity",
    minDisks: 4,
    faultTolerance: 2,
    note: "Survives two disk failures. Useful for large disks, where a rebuild can take a long time.",
  },
  {
    id: "raidz3",
    name: "RAIDZ3 - triple parity",
    minDisks: 5,
    faultTolerance: 3,
    note: "Survives three failures. For wide arrays where rebuilds take days.",
  },
  {
    id: "stripe",
    name: "Stripe - no redundancy",
    minDisks: 1,
    faultTolerance: 0,
    note: "No redundancy at all: losing any disk loses everything on the pool. Capacity and speed only.",
  },
];

export function layoutInfo(id: string): ZfsLayoutInfo | null {
  return ZFS_LAYOUTS.find((l) => l.id === id) ?? null;
}

async function helper(args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string; error: string }> {
  try {
    const { stdout } = await exec("doas", [HELPER, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: stdout, error: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      out: e.stdout ?? "",
      // The helper's last line is the message written for a person to read.
      error: (e.stderr ?? "").trim().split("\n").pop() || e.message || "The command failed.",
    };
  }
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Whether ZFS can be used here, and what to say when it can't. */
export async function zfsStatus(): Promise<ZfsStatus> {
  if (config.systemMode !== "linux") {
    return {
      state: "absent",
      reason: "ZFS is only available on an installed OpenNAS appliance.",
      version: "",
      raidzExpansion: false,
    };
  }
  const r = await helper(["status"], 15_000);
  if (!r.ok && !r.out) {
    return { state: "absent", reason: r.error, version: "", raidzExpansion: false };
  }
  const fields = new Map<string, string>();
  for (const line of r.out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const state = fields.get("state");
  return {
    state: state === "ready" || state === "no-module" ? state : "absent",
    reason: fields.get("reason") ?? "",
    version: fields.get("version") ?? "",
    raidzExpansion: fields.get("raidzExpansion") === "yes",
  };
}

/**
 * Parse `zpool status <pool>`.
 *
 * The format is meant for people, not programs, and has no stable contract - so
 * this reads what it recognises and drops the rest rather than inventing
 * structure. The config section is an indented tree:
 *
 *     NAME        STATE     READ WRITE CKSUM
 *     tank        ONLINE       0     0     0
 *       raidz2-0  ONLINE       0     0     0
 *         sda     ONLINE       0     0     0
 *
 * **Depth is measured relative to the `NAME` header, not against fixed
 * columns.** The first version of this used absolute indentation and broke the
 * moment the output was tab-indented rather than space-indented - it read the
 * pool's own row as a disk and invented a second vdev to hold it. Whatever the
 * base indent turns out to be, the pool sits at it, top-level vdevs one step
 * in, and members one step further.
 *
 * A bare disk directly under the pool is a stripe member - ZFS prints no
 * grouping row for those - so a synthetic "stripe" vdev is created rather than
 * dropping the disk. `replacing-N` and `spare-N` are containers ZFS shows during
 * a disk swap; their children are real devices and are kept, the container row
 * itself is not.
 */
export function parsePoolStatus(text: string): {
  vdevs: ZfsVdev[];
  scan: ZfsPool["scan"];
  statusNote: string;
} {
  const lines = text.split("\n");
  const vdevs: ZfsVdev[] = [];
  let scan: ZfsPool["scan"] = null;
  let statusNote = "";

  // "status:" and "scan:" continue onto following indented lines.
  let section: "none" | "status" | "scan" | "config" = "none";
  let scanText = "";
  // Indent of the NAME header, and therefore of the pool's own row.
  let base: number | null = null;
  // Set once a section header like "logs"/"cache"/"spares" is seen; those hold
  // devices that are not part of the data layout and are not shown as vdevs.
  let auxiliary = false;

  const indentOf = (l: string) => l.length - l.replace(/^[ \t]+/, "").length;

  for (const raw of lines) {
    // Tabs are one column of indent as far as ZFS's own alignment goes, but two
    // spaces as far as the tree is concerned; normalising here means the depth
    // maths works for both.
    const line = raw.replace(/\t/g, "  ").replace(/\s+$/, "");
    if (!line.trim()) continue;

    const header = line.match(/^\s{0,4}(pool|state|status|action|scan|config|errors|see):\s*(.*)$/);
    if (header) {
      const key = header[1]!;
      const rest = header[2] ?? "";
      section = key === "status" ? "status" : key === "scan" ? "scan" : key === "config" ? "config" : "none";
      if (key === "status") statusNote = rest.trim();
      if (key === "scan") scanText = rest.trim();
      if (key === "errors" && !statusNote) statusNote = rest.trim();
      continue;
    }

    if (section === "status") {
      statusNote = `${statusNote} ${line.trim()}`.trim();
      continue;
    }
    if (section === "scan") {
      scanText = `${scanText} ${line.trim()}`.trim();
      continue;
    }
    if (section !== "config") continue;

    const indent = indentOf(line);
    const cols = line.trim().split(/\s+/);
    const name = cols[0]!;

    if (name === "NAME") {
      base = indent;
      continue;
    }
    if (base === null) continue;

    // A lone word at vdev depth with no state column: "logs", "cache",
    // "spares". Everything under it is auxiliary, not part of the data layout.
    if (cols.length === 1) {
      auxiliary = true;
      continue;
    }

    const depth = indent - base;
    if (depth <= 0) continue; // the pool's own row
    if (auxiliary) continue;

    const isContainer = /^(replacing|spare)(-\d+)?$/.test(name);
    const isVdevRow = /^(mirror|raidz[123]?)(-\d+)?$/.test(name);

    if (depth <= 2 && !isContainer) {
      if (isVdevRow) {
        vdevs.push({ name, type: name.replace(/-\d+$/, ""), state: cols[1] ?? "UNKNOWN", members: [] });
      } else {
        // A bare device directly under the pool: a stripe member.
        let stripe = vdevs.find((v) => v.type === "stripe");
        if (!stripe) {
          stripe = { name: "stripe", type: "stripe", state: "ONLINE", members: [] };
          vdevs.push(stripe);
        }
        stripe.members.push(member(cols));
      }
      continue;
    }

    // Deeper than a vdev row. The container rows ZFS shows mid-replacement are
    // not devices; their children are.
    if (isContainer) continue;
    const parent = vdevs[vdevs.length - 1];
    if (parent) parent.members.push(member(cols));
  }

  if (scanText) {
    const percent = scanText.match(/([\d.]+)%\s+done/);
    const kind = /resilver/i.test(scanText) ? "resilver" : /scrub/i.test(scanText) ? "scrub" : "scan";
    if (/in progress/i.test(scanText)) {
      scan = { kind, percent: percent ? parseFloat(percent[1]!) : null, note: scanText };
    }
  }

  return { vdevs, scan, statusNote };
}

function member(cols: string[]): ZfsVdevMember {
  return {
    name: cols[0]!,
    state: cols[1] ?? "UNKNOWN",
    errors: { read: num(cols[2]), write: num(cols[3]), checksum: num(cols[4]) },
  };
}

/** Parse the tab-separated output of `zpool list -Hp`. */
export function parsePoolList(text: string): Omit<ZfsPool, "vdevs" | "scan" | "statusNote" | "mountpoint">[] {
  const pools: Omit<ZfsPool, "vdevs" | "scan" | "statusNote" | "mountpoint">[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 5 || !f[0]) continue;
    pools.push({
      name: f[0],
      sizeBytes: num(f[1]),
      allocatedBytes: num(f[2]),
      freeBytes: num(f[3]),
      health: f[4] || "UNKNOWN",
      // `-` where ZFS has no figure; num() turns that into 0, which is right.
      fragmentationPercent: num(f[5]?.replace("%", "")),
      capacityPercent: num(f[6]?.replace("%", "")),
      dedupRatio: num(f[7]?.replace("x", "")),
    });
  }
  return pools;
}

/** Parse `zfs list -Hp -o name,used,available,quota,mountpoint,compression`. */
export function parseDatasetList(text: string): ZfsDataset[] {
  const out: ZfsDataset[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 5 || !f[0]) continue;
    out.push({
      name: f[0],
      usedBytes: num(f[1]),
      availableBytes: num(f[2]),
      quotaBytes: num(f[3]),
      mountpoint: f[4] ?? "",
      compression: f[5] ?? "off",
    });
  }
  return out;
}

/** Parse `zfs list -Hp -t snapshot -o name,used,creation,referenced`. */
export function parseSnapshotList(text: string): ZfsSnapshot[] {
  const out: ZfsSnapshot[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    const full = f[0];
    if (!full || !full.includes("@")) continue;
    const at = full.indexOf("@");
    out.push({
      name: full,
      dataset: full.slice(0, at),
      snapshot: full.slice(at + 1),
      usedBytes: num(f[1]),
      // `creation` with -p is a unix timestamp in seconds.
      createdAt: new Date(num(f[2]) * 1000).toISOString(),
      referencedBytes: num(f[3]),
    });
  }
  return out;
}

/** Parse the pool names out of `zpool import`'s human-readable output. */
export function parseImportable(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*pool:\s*(\S+)\s*$/);
    if (m) names.push(m[1]!);
  }
  return names;
}

// ---- Reads -----------------------------------------------------------------

export async function listPools(): Promise<ZfsPool[]> {
  const list = await helper(["pools"], 20_000);
  if (!list.ok) return [];
  const base = parsePoolList(list.out);
  const pools: ZfsPool[] = [];
  for (const p of base) {
    const st = await helper(["pool-status", p.name], 20_000);
    // `zpool status` exits non-zero for a faulted pool while still printing the
    // status - which is exactly when the detail matters most, so the output is
    // parsed either way.
    const parsed = parsePoolStatus(st.out || st.error);
    pools.push({
      ...p,
      ...parsed,
      mountpoint: `${config.volumesRoot}/${p.name}`,
    });
  }
  return pools;
}

export async function listDatasets(): Promise<ZfsDataset[]> {
  const r = await helper(["datasets"], 20_000);
  return r.ok ? parseDatasetList(r.out) : [];
}

export async function listSnapshots(dataset?: string): Promise<ZfsSnapshot[]> {
  const r = await helper(dataset ? ["snapshots", dataset] : ["snapshots"], 20_000);
  return r.ok ? parseSnapshotList(r.out) : [];
}

export async function listImportable(): Promise<string[]> {
  const r = await helper(["importable"], 30_000);
  return parseImportable(r.out);
}

// ---- Writes ----------------------------------------------------------------

type Result = { ok: boolean; error?: string; message?: string };

function done(r: { ok: boolean; out: string; error: string }, log: FastifyBaseLogger, what: string): Result {
  if (!r.ok) {
    log.warn({ what, err: r.error }, "zfs operation failed");
    return { ok: false, error: r.error };
  }
  return { ok: true, message: r.out.trim().split("\n").pop() ?? "" };
}

/**
 * Build a pool.
 *
 * The disk count is checked here as well as in the helper. Not redundancy for
 * its own sake: this side can say *why* in a sentence the UI shows, while the
 * helper's job is to be unfoolable rather than friendly.
 */
export async function createPool(
  log: FastifyBaseLogger,
  name: string,
  layout: ZfsLayout,
  disks: string[],
): Promise<Result> {
  const info = layoutInfo(layout);
  if (!info) return { ok: false, error: "Unknown layout." };
  if (disks.length < info.minDisks) {
    return {
      ok: false,
      error: `${info.name} needs at least ${info.minDisks} disk${info.minDisks === 1 ? "" : "s"}; ${disks.length} selected.`,
    };
  }
  log.warn({ name, layout, disks }, "creating a ZFS pool - this erases the member disks");
  return done(await helper(["pool-create", name, layout, ...disks], 300_000), log, "pool-create");
}

export async function destroyPool(log: FastifyBaseLogger, name: string): Promise<Result> {
  log.warn({ name }, "destroying a ZFS pool");
  return done(await helper(["pool-destroy", name], 120_000), log, "pool-destroy");
}

export async function exportPool(log: FastifyBaseLogger, name: string): Promise<Result> {
  return done(await helper(["pool-export", name], 120_000), log, "pool-export");
}

export async function importPool(log: FastifyBaseLogger, name?: string): Promise<Result> {
  return done(await helper(name ? ["pool-import", name] : ["pool-import"], 300_000), log, "pool-import");
}

export async function scrubPool(log: FastifyBaseLogger, name: string, stop = false): Promise<Result> {
  return done(await helper(stop ? ["scrub", name, "stop"] : ["scrub", name], 30_000), log, "scrub");
}

export async function createDataset(log: FastifyBaseLogger, name: string): Promise<Result> {
  return done(await helper(["dataset-create", name], 60_000), log, "dataset-create");
}

export async function destroyDataset(log: FastifyBaseLogger, name: string): Promise<Result> {
  log.warn({ name }, "destroying a ZFS dataset and its snapshots");
  return done(await helper(["dataset-destroy", name], 120_000), log, "dataset-destroy");
}

export async function setDatasetQuota(log: FastifyBaseLogger, name: string, bytes: number | null): Promise<Result> {
  return done(
    await helper(["dataset-quota", name, bytes === null || bytes <= 0 ? "none" : String(Math.floor(bytes))], 30_000),
    log,
    "dataset-quota",
  );
}

export async function createSnapshot(log: FastifyBaseLogger, dataset: string, snapshot: string): Promise<Result> {
  return done(await helper(["snapshot-create", dataset, snapshot], 60_000), log, "snapshot-create");
}

export async function destroySnapshot(log: FastifyBaseLogger, full: string): Promise<Result> {
  return done(await helper(["snapshot-destroy", full], 60_000), log, "snapshot-destroy");
}

export async function rollbackSnapshot(log: FastifyBaseLogger, full: string): Promise<Result> {
  log.warn({ full }, "rolling a dataset back - newer snapshots are discarded");
  return done(await helper(["rollback", full], 120_000), log, "rollback");
}
