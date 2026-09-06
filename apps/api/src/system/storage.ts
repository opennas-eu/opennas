import { execFile } from "node:child_process";
import { readFile, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RaidArray,
  RaidMember,
  SmartInfo,
  StorageDisk,
  StoragePartition,
  StorageVolume,
} from "@opennas/shared";
import { config } from "../config.js";

const exec = promisify(execFile);

/** Run a command, returning its stdout even when it exits non-zero (smartctl
 *  signals SMART warnings via the exit status while still printing valid JSON). */
async function execCapture(cmd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  try {
    return (await exec(cmd, args, { timeout: timeoutMs })).stdout;
  } catch (err) {
    const out = (err as { stdout?: string }).stdout;
    return typeof out === "string" && out.trim() ? out : null;
  }
}

/** Raw lsblk node (the fields we request). */
interface LsblkNode {
  name: string;
  size: number;
  type: string;
  fstype: string | null;
  mountpoint: string | null;
  model: string | null;
  serial: string | null;
  rota: boolean;
  rm: boolean;
  label: string | null;
  children?: LsblkNode[];
}

function dev(name: string): string {
  return name.startsWith("/dev/") ? name : `/dev/${name}`;
}

/** All mountpoints anywhere in a node's subtree (so RAID/LVM members count). */
function subtreeMounts(node: LsblkNode): string[] {
  const out: string[] = [];
  if (node.mountpoint) out.push(node.mountpoint);
  for (const c of node.children ?? []) out.push(...subtreeMounts(c));
  return out;
}

/**
 * Filesystem types anywhere in a node's subtree. Lets us tell a disk that's
 * genuinely formatted (has a real filesystem / RAID / LVM member) from one that
 * only carries an empty, unformatted partition table.
 */
function subtreeFsTypes(node: LsblkNode): string[] {
  const out: string[] = [];
  if (node.fstype) out.push(node.fstype);
  for (const c of node.children ?? []) out.push(...subtreeFsTypes(c));
  return out;
}

function classify(disk: LsblkNode): StorageDisk["state"] {
  const mounts = subtreeMounts(disk);
  if (mounts.some((m) => m === "/" || m === "/boot" || m === "/boot/efi")) return "system";
  // Unconfigured = nothing on it we'd lose: no mounted filesystems and no
  // formatted partitions anywhere. A blank disk OR one that only has an empty
  // (unformatted) partition table both qualify, so either can be initialized.
  if (mounts.length === 0 && subtreeFsTypes(disk).length === 0) return "unconfigured";
  return "data";
}

/**
 * Enumerate physical disks (and their partitions) via lsblk, classifying each as
 * the system disk, a configured data disk, or an unconfigured (blank) one ready
 * to be initialized. Read-only and safe to call anywhere lsblk exists.
 */
export async function listStorage(): Promise<StorageDisk[]> {
  let stdout: string;
  try {
    const r = await exec("lsblk", [
      "-J", "-b", "-o",
      "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL,ROTA,RM,LABEL",
    ]);
    stdout = r.stdout;
  } catch {
    return [];
  }

  let parsed: { blockdevices?: LsblkNode[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  return (parsed.blockdevices ?? [])
    .filter((d) => d.type === "disk" && !/^(loop|zram|sr|ram)/.test(d.name))
    .map((d): StorageDisk => ({
      name: dev(d.name),
      model: d.model?.trim() || null,
      serial: d.serial?.trim() || null,
      sizeBytes: Number(d.size) || 0,
      rotational: !!d.rota,
      removable: !!d.rm,
      state: classify(d),
      unallocatedBytes: null, // filled in by listStorageWithHealth
      smart: null,
      partitions: (d.children ?? []).map((p): StoragePartition => ({
        name: dev(p.name),
        sizeBytes: Number(p.size) || 0,
        fsType: p.fstype || null,
        mountpoint: p.mountpoint || null,
        label: p.label || null,
        usedBytes: null,
        freeBytes: null,
      })),
    }));
}

// ---- S.M.A.R.T. health + filesystem usage ---------------------------------

interface SmartJson {
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  power_on_hours?: number;
  ata_smart_attributes?: { table?: { id: number; raw?: { value?: number } }[] };
}

/**
 * Unallocated bytes on a disk, via the privileged helper (linux mode only).
 * Returns null when it can't be determined, which the UI treats as "unknown"
 * rather than "none" - offering to claim space we couldn't measure would be worse.
 */
async function unallocatedFor(disk: string): Promise<number | null> {
  if (config.systemMode !== "linux") return null;
  const out = await execCapture("doas", ["/usr/lib/opennas/opennas-storage", "freespace", disk]);
  if (!out) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read a disk's S.M.A.R.T. health via smartctl (privileged; linux mode only). */
async function smartFor(disk: string): Promise<SmartInfo | null> {
  if (config.systemMode !== "linux") return null;
  const out = await execCapture("doas", ["smartctl", "-j", "-H", "-A", "-i", disk]);
  if (!out) return null;
  let j: SmartJson;
  try {
    j = JSON.parse(out) as SmartJson;
  } catch {
    return null;
  }
  const passed = j.smart_status?.passed;
  const realloc = j.ata_smart_attributes?.table?.find((a) => a.id === 5)?.raw?.value;
  return {
    status: passed === true ? "passed" : passed === false ? "failed" : "unknown",
    temperatureC: j.temperature?.current ?? null,
    powerOnHours: j.power_on_time?.hours ?? j.power_on_hours ?? null,
    reallocatedSectors: typeof realloc === "number" ? realloc : null,
  };
}

/** Filesystem used/free for a mountpoint (best-effort via statfs). */
async function usageFor(mountpoint: string): Promise<{ usedBytes: number; freeBytes: number } | null> {
  try {
    const s = await statfs(mountpoint);
    const bsize = Number(s.bsize);
    return {
      usedBytes: (Number(s.blocks) - Number(s.bfree)) * bsize,
      freeBytes: Number(s.bavail) * bsize,
    };
  } catch {
    return null;
  }
}

/**
 * Like listStorage(), but enriched with S.M.A.R.T. health per disk and live
 * filesystem usage per mounted partition. Slower (spawns smartctl), so used only
 * by the Storage dashboard - the disk-init re-checks still use the plain version.
 */
export async function listStorageWithHealth(): Promise<StorageDisk[]> {
  const disks = await listStorage();
  await Promise.all(
    disks.map(async (d) => {
      d.smart = await smartFor(d.name);
      d.unallocatedBytes = await unallocatedFor(d.name);
      await Promise.all(
        d.partitions.map(async (p) => {
          if (!p.mountpoint) return;
          const u = await usageFor(p.mountpoint);
          if (u) {
            p.usedBytes = u.usedBytes;
            p.freeBytes = u.freeBytes;
          }
        }),
      );
    }),
  );
  return disks;
}

// ---- RAID (mdadm) - read-only status from /proc/mdstat --------------------

/** Parse the contents of /proc/mdstat into structured array status. */
export function parseMdstat(content: string): RaidArray[] {
  const lines = content.split("\n");
  const arrays: RaidArray[] = [];
  for (let i = 0; i < lines.length; i++) {
    // "md0 : active raid1 sdb1[1] sda1[0](F)"
    const head = lines[i]!.match(/^(md\d+)\s*:\s*(\S+)\s+(\S+)\s+(.*)$/);
    if (!head) continue;
    const [, name, activeState, level, rest] = head;
    const members: RaidMember[] = [];
    for (const tok of rest!.trim().split(/\s+/)) {
      const m = tok.match(/^([A-Za-z0-9]+)\[\d+\](?:\(([FSW])\))?$/);
      if (!m) continue;
      members.push({
        name: "/dev/" + m[1],
        state: m[2] === "F" ? "faulty" : m[2] === "S" || m[2] === "W" ? "spare" : "active",
      });
    }
    let state = activeState!;
    let totalDevices = members.length;
    let activeDevices = members.filter((m) => m.state === "active").length;
    let sizeBytes: number | null = null;
    let syncPercent: number | null = null;

    const detail = lines[i + 1] ?? "";
    const counts = detail.match(/\[(\d+)\/(\d+)\]/); // [total/active]
    if (counts) {
      totalDevices = Number(counts[1]);
      activeDevices = Number(counts[2]);
    }
    const blocks = detail.match(/(\d+)\s+blocks/);
    if (blocks) sizeBytes = Number(blocks[1]) * 1024; // mdstat blocks are 1 KiB
    const upmap = detail.match(/\[([U_]+)\]/);
    if (upmap && upmap[1]!.includes("_")) state = "degraded";

    const sync = (lines[i + 2] ?? "").match(/(resync|recovery|reshape|check)\s*=\s*([\d.]+)%/);
    if (sync) {
      state = sync[1]!;
      syncPercent = parseFloat(sync[2]!);
    }

    arrays.push({ name: "/dev/" + name, level: level!, state, sizeBytes, totalDevices, activeDevices, members, syncPercent });
  }
  return arrays;
}

/** Current RAID arrays from /proc/mdstat (no privilege needed; [] if none). */
export async function listRaidArrays(): Promise<RaidArray[]> {
  const content = await readFile("/proc/mdstat", "utf8").catch(() => "");
  return content ? parseMdstat(content) : [];
}

/**
 * List the data volumes a shared folder can be placed on. Each is a sub-directory
 * of the volumes root (the Storage Manager mounts disks there, one per label).
 * Read-only; capacity is filled in best-effort via statfs.
 */
export async function listVolumes(): Promise<StorageVolume[]> {
  const entries = await readdir(config.volumesRoot, { withFileTypes: true }).catch(() => []);
  const volumes: StorageVolume[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(config.volumesRoot, e.name);
    let sizeBytes: number | null = null;
    let freeBytes: number | null = null;
    try {
      const s = await statfs(path);
      sizeBytes = Number(s.blocks) * Number(s.bsize);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      /* not a mounted fs / no access - still listable by label */
    }
    volumes.push({ label: e.name, path, sizeBytes, freeBytes });
  }
  return volumes.sort((a, b) => a.label.localeCompare(b.label));
}
