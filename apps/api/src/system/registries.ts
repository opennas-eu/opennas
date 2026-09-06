import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerRegistry } from "@opennas/shared";
import { getSettingOr, setSetting } from "../db/settings.js";

const exec = promisify(execFile);

/**
 * Private container registries.
 *
 * OpenNAS stores the registry list - hostname, username, whether a login has
 * succeeded - but **not the password**. `docker login` writes its own
 * credential file (`~/.docker/config.json` for the service account), and that
 * is the only place the secret lives. Keeping a second copy would mean holding
 * a re-usable credential in the OpenNAS database for no benefit: nothing here
 * ever needs to replay it, because Docker already has it.
 *
 * The practical consequence is that a registry's entry can say "signed in"
 * without OpenNAS being able to prove it still is; `refreshStatus` re-reads
 * Docker's own config so the list reflects reality rather than history.
 */

const SETTING = "container_registries";
export const MAX_REGISTRIES = 10;

/** Docker Hub is addressed by this name in `docker login`, not by a URL. */
export const DOCKER_HUB = "docker.io";

/**
 * A registry host: a hostname with an optional port, or Docker Hub's name.
 * Deliberately not a URL - `docker login` takes a host, and accepting a URL
 * would invite a scheme or path that it silently ignores.
 */
export function isValidRegistryHost(host: string): boolean {
  const h = host.trim();
  if (h.length === 0 || h.length > 253) return false;
  if (h === DOCKER_HUB) return true;
  const [name, port, ...rest] = h.split(":");
  if (rest.length > 0 || !name) return false;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return false;
  return name
    .split(".")
    .every((label) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function coerce(raw: unknown): ContainerRegistry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const host = String(r.host ?? "").trim();
  if (!isValidRegistryHost(host)) return null;
  return {
    host,
    username: String(r.username ?? "").slice(0, 128),
    loggedIn: r.loggedIn === true,
    lastLoginAt: typeof r.lastLoginAt === "string" ? r.lastLoginAt : null,
  };
}

export function listRegistries(): ContainerRegistry[] {
  try {
    const parsed = JSON.parse(getSettingOr(SETTING, "[]")) as unknown[];
    const out: ContainerRegistry[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      const reg = coerce(raw);
      if (!reg || seen.has(reg.host)) continue;
      seen.add(reg.host);
      out.push(reg);
    }
    return out.slice(0, MAX_REGISTRIES);
  } catch {
    return [];
  }
}

function save(regs: ContainerRegistry[]): void {
  setSetting(SETTING, JSON.stringify(regs.slice(0, MAX_REGISTRIES)));
}

export function upsertRegistry(reg: ContainerRegistry): ContainerRegistry[] {
  const regs = listRegistries().filter((r) => r.host !== reg.host);
  regs.push(reg);
  save(regs);
  return regs;
}

export function removeRegistry(host: string): ContainerRegistry[] {
  const regs = listRegistries().filter((r) => r.host !== host);
  save(regs);
  return regs;
}

/**
 * Sign in to a registry. The password goes to `docker login` on **stdin**, not
 * as an argument - an argument would be visible in the process list to every
 * account on the box for as long as the command runs.
 */
export async function dockerLogin(
  host: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const target = host === DOCKER_HUB ? [] : [host];
  try {
    const child = execFile(
      "docker",
      ["login", "--username", username, "--password-stdin", ...target],
      { timeout: 30_000 },
      () => {},
    );
    const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
      let err = "";
      child.stderr?.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("error", () => resolve({ code: null, err: "docker is not available" }));
      child.on("close", (code) => resolve({ code, err }));
      child.stdin?.end(password);
    });
    if (result.code === 0) return { ok: true };
    const line = result.err.trim().split("\n").filter(Boolean).pop() ?? "Sign-in failed.";
    return { ok: false, error: line.slice(0, 200) };
  } catch {
    return { ok: false, error: "Could not run docker login." };
  }
}

export async function dockerLogout(host: string): Promise<{ ok: boolean; error?: string }> {
  const target = host === DOCKER_HUB ? [] : [host];
  try {
    await exec("docker", ["logout", ...target], { timeout: 15_000 });
    return { ok: true };
  } catch {
    // Logging out of something we aren't logged in to is not a failure worth
    // reporting - the end state is what was asked for either way.
    return { ok: true };
  }
}

/**
 * Re-read Docker's own credential store so the list reflects what Docker
 * actually holds, not what OpenNAS last wrote down. Someone can `docker logout`
 * from a shell, and the UI should not keep claiming a live session.
 */
export async function refreshStatus(): Promise<ContainerRegistry[]> {
  let config: { auths?: Record<string, unknown> } = {};
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    config = JSON.parse(await readFile(join(homedir(), ".docker", "config.json"), "utf8")) as typeof config;
  } catch {
    // No config file means nothing is signed in, which is a real answer.
  }
  const auths = Object.keys(config.auths ?? {});
  const regs = listRegistries().map((r) => ({
    ...r,
    loggedIn: auths.some((a) => a === r.host || a.includes(r.host) || (r.host === DOCKER_HUB && a.includes("docker.io"))),
  }));
  save(regs);
  return regs;
}
