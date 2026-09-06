import si from "systeminformation";
import { hostname } from "node:os";
import type {
  DiskVolume,
  ProcessInfo,
  SystemSample,
  SystemStaticInfo,
} from "@opennas/shared";
import { config } from "../config.js";

/**
 * Thin wrapper over `systeminformation`. Static info is fetched once and cached;
 * samples are cheap enough to poll once a second for the live charts.
 */

let staticCache: SystemStaticInfo | null = null;

export async function getStaticInfo(): Promise<SystemStaticInfo> {
  if (staticCache) return staticCache;
  const [os, cpu, mem, time] = await Promise.all([
    si.osInfo(),
    si.cpu(),
    si.mem(),
    Promise.resolve(si.time()),
  ]);
  staticCache = {
    hostname: os.hostname || hostname(),
    os: { platform: os.platform, distro: os.distro, release: os.release, arch: os.arch },
    cpu: {
      manufacturer: cpu.manufacturer,
      brand: cpu.brand,
      cores: cpu.cores,
      physicalCores: cpu.physicalCores,
      speedGHz: cpu.speed,
    },
    memoryTotalBytes: mem.total,
    uptimeSeconds: Math.round(time.uptime ?? 0),
    opennasVersion: config.version,
  };
  return staticCache;
}

export async function sample(): Promise<SystemSample> {
  const [load, mem, net, temp, procs] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.networkStats(),
    si.cpuTemperature().catch(() => ({ main: null, cores: [] as number[] })),
    si.processes().catch(() => ({ all: 0, running: 0 })),
  ]);

  return {
    timestamp: Date.now(),
    cpu: {
      total: round1(load.currentLoad),
      perCore: load.cpus.map((c) => round1(c.load)),
    },
    memory: {
      totalBytes: mem.total,
      usedBytes: mem.total - mem.available,
      freeBytes: mem.available,
      activeBytes: mem.active,
      swapTotalBytes: mem.swaptotal,
      swapUsedBytes: mem.swapused,
    },
    network: net.map((n) => ({
      iface: n.iface,
      rxBytesPerSec: Math.max(0, Math.round(n.rx_sec ?? 0)),
      txBytesPerSec: Math.max(0, Math.round(n.tx_sec ?? 0)),
      rxTotalBytes: n.rx_bytes,
      txTotalBytes: n.tx_bytes,
    })),
    temperature: {
      mainC: typeof temp.main === "number" && temp.main > 0 ? round1(temp.main) : null,
      coresC: Array.isArray(temp.cores) ? temp.cores.map((c) => round1(c)) : [],
    },
    uptimeSeconds: Math.round(si.time().uptime ?? 0),
    processes: { total: procs.all ?? 0, running: procs.running ?? 0 },
  };
}

/** Pseudo/virtual filesystems that aren't real storage volumes. */
const PSEUDO_FS = new Set([
  "tmpfs", "devtmpfs", "overlay", "squashfs", "efivarfs", "sysfs", "proc",
  "cgroup", "cgroup2", "ramfs", "debugfs", "mqueue", "devpts", "autofs",
  "pstore", "bpf", "tracefs", "configfs", "securityfs", "fusectl", "nsfs",
  "binfmt_misc", "hugetlbfs", "fuse.gvfsd-fuse",
]);

/** Mounts that are part of the OS itself, not user storage. */
function isSystemMount(mount: string): boolean {
  if (mount === "/" || mount === "/boot" || mount === "/boot/efi") return true;
  return ["/sys", "/proc", "/dev", "/run", "/boot/"].some((p) => mount.startsWith(p));
}

export async function getDisks(): Promise<DiskVolume[]> {
  const fs = await si.fsSize();
  return fs
    .filter((f) => f.size > 0)
    .filter((f) => !PSEUDO_FS.has((f.type ?? "").toLowerCase()) && !isSystemMount(f.mount))
    .map((f) => ({
      fs: f.fs,
      mount: f.mount,
      type: f.type,
      sizeBytes: f.size,
      usedBytes: f.used,
      usePercent: round1(f.use),
    }));
}

/** Top processes by CPU, with a hard cap so the payload stays small. */
export async function getProcesses(limit = 60): Promise<{ list: ProcessInfo[]; total: number }> {
  const procs = await si.processes();
  const list = procs.list
    .map((p): ProcessInfo => ({
      pid: p.pid,
      parentPid: p.parentPid,
      name: p.name,
      cpu: round1(p.cpu),
      memPercent: round1(p.mem),
      // si reports memRss in KB on Linux.
      memBytes: Math.max(0, Math.round((p.memRss ?? 0) * 1024)),
      user: p.user || "-",
      state: p.state || "",
      command: p.command || p.name,
    }))
    .sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes)
    .slice(0, limit);
  return { list, total: procs.all ?? procs.list.length };
}

function round1(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}
