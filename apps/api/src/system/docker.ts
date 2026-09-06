import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerInfo, ContainerStats, DockerImage, DockerStatus } from "@opennas/shared";

const exec = promisify(execFile);

/** Run docker, returning stdout or null if it failed (binary missing / daemon down). */
async function docker(args: string[], timeoutMs = 12000): Promise<string | null> {
  try {
    return (await exec("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

/** Parse newline-delimited `{{json .}}` output into objects. */
function parseJsonLines<T>(out: string): T[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

interface PsJson {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  CreatedAt: string;
}

/** Whole-daemon status + the container list. */
export async function getDocker(): Promise<DockerStatus> {
  const version = await docker(["--version"], 4000);
  if (version == null) return { available: false, running: false, containers: [] };

  const ps = await docker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);
  if (ps == null) return { available: true, running: false, containers: [] };

  const containers: ContainerInfo[] = parseJsonLines<PsJson>(ps).map((c) => ({
    id: c.ID,
    name: c.Names.split(",")[0] ?? c.Names,
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: c.Ports || "",
    createdAt: c.CreatedAt,
  }));
  return { available: true, running: true, containers };
}

const ACTIONS = { start: "start", stop: "stop", restart: "restart" } as const;
export type ContainerAction = keyof typeof ACTIONS | "remove";

export async function containerAction(id: string, action: ContainerAction): Promise<{ ok: boolean; error?: string }> {
  const args = action === "remove" ? ["rm", "-f", id] : [ACTIONS[action], id];
  try {
    await exec("docker", args, { timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as { stderr?: string }).stderr?.trim().split("\n").pop() || "Command failed." };
  }
}

export async function containerLogs(id: string, tail: number): Promise<string[]> {
  const out = await docker(["logs", "--tail", String(Math.max(10, Math.min(2000, tail))), id], 8000);
  if (out == null) return [];
  return out.split("\n").filter(Boolean);
}

interface StatsJson {
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
}

export async function containerStats(id: string): Promise<ContainerStats | null> {
  const out = await docker(["stats", "--no-stream", "--format", "{{json .}}", id], 8000);
  if (!out) return null;
  const s = parseJsonLines<StatsJson>(out)[0];
  if (!s) return null;
  return { cpu: s.CPUPerc, mem: s.MemUsage, memPercent: s.MemPerc, netIO: s.NetIO, blockIO: s.BlockIO };
}

interface ImageJson {
  ID: string;
  Repository: string;
  Tag: string;
  Size: string;
  CreatedSince: string;
}

export async function listImages(): Promise<DockerImage[]> {
  const out = await docker(["images", "--format", "{{json .}}"]);
  if (out == null) return [];
  return parseJsonLines<ImageJson>(out).map((i) => ({
    id: i.ID,
    ref: i.Repository === "<none>" ? i.ID : `${i.Repository}:${i.Tag}`,
    size: i.Size,
    created: i.CreatedSince,
  }));
}

/** True if the docker daemon is reachable. */
export async function dockerRunning(): Promise<boolean> {
  return (await docker(["ps", "--format", "{{.ID}}"], 5000)) !== null;
}

export interface RunSpec {
  name: string;
  image: string;
  ports?: { host: number; container: number; proto?: "tcp" | "udp" }[];
  volumes?: { host: string; container: string }[];
  env?: Record<string, string>;
  restart?: string;
  args?: string[];
  /** CPU limit in cores, e.g. "1.5" (→ docker --cpus). */
  cpus?: string;
  /** Memory limit, e.g. "512m" / "2g" (→ docker --memory). */
  memory?: string;
  /** A Docker network to join instead of the default bridge. */
  network?: string;
}

/** `docker run -d` a container from a spec. Pulls the image if missing (slow). */
export async function runContainer(spec: RunSpec): Promise<{ ok: boolean; error?: string }> {
  const args = ["run", "-d", "--name", spec.name, "--restart", spec.restart ?? "unless-stopped"];
  for (const p of spec.ports ?? []) args.push("-p", `${p.host}:${p.container}${p.proto === "udp" ? "/udp" : ""}`);
  for (const v of spec.volumes ?? []) args.push("-v", `${v.host}:${v.container}`);
  for (const [k, val] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${val}`);
  if (spec.cpus) args.push("--cpus", spec.cpus);
  if (spec.memory) args.push("--memory", spec.memory);
  // Left off entirely when unset, so Docker's own default bridge applies rather
  // than this pinning containers to a network name that may not exist.
  if (spec.network) args.push("--network", spec.network);
  if (spec.args) args.push(...spec.args);
  args.push(spec.image);
  try {
    await exec("docker", args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as { stderr?: string }).stderr?.trim().split("\n").pop() || "docker run failed." };
  }
}

/** Look up a single container by exact name. */
export async function getContainerByName(name: string): Promise<ContainerInfo | null> {
  const out = await docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{json .}}"]);
  if (!out) return null;
  const c = parseJsonLines<PsJson>(out)[0];
  if (!c) return null;
  return { id: c.ID, name: c.Names.split(",")[0] ?? c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports || "", createdAt: c.CreatedAt };
}

/** Start an image pull in the background (it can take minutes). Returns immediately. */
export function pullImage(ref: string): void {
  const child = spawn("docker", ["pull", ref], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
