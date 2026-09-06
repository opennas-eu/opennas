import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StackInfo } from "@opennas/shared";
import { allBasesFor, stacksDirFor } from "./storage-paths.js";

const exec = promisify(execFile);

/** Stack names double as directory names - keep them strictly safe. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Where a stack lives.
 *
 * A stack can be created on any data volume, and nothing records which one, so
 * every lookup searches the candidate bases and takes the one that actually has
 * a compose file. Falling back to the default base means "where it would go if
 * created now", which is what the create path wants.
 */
function stackDir(name: string): string {
  for (const base of allBasesFor("containers")) {
    const dir = join(base, "stacks", name);
    if (existsSync(join(dir, "docker-compose.yml"))) return dir;
  }
  return join(stacksDirFor(null), name);
}
function composeFile(name: string): string {
  return join(stackDir(name), "docker-compose.yml");
}

async function countLines(args: string[]): Promise<number> {
  const out = await exec("docker", args, { timeout: 8000 }).then((r) => r.stdout).catch(() => "");
  return out.split("\n").map((l) => l.trim()).filter(Boolean).length;
}

export async function listStacks(): Promise<StackInfo[]> {
  // Stacks may sit on any volume, so every base is scanned. A name seen twice
  // is listed once - stackDir() decides which copy wins.
  const seen = new Set<string>();
  const stacks: StackInfo[] = [];
  for (const base of allBasesFor("containers")) {
    const entries = await readdir(join(base, "stacks"), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name) || !existsSync(composeFile(e.name))) continue;
      seen.add(e.name);
      const f = composeFile(e.name);
      const total = await countLines(["compose", "-f", f, "ps", "-a", "-q"]);
      const running = await countLines(["compose", "-f", f, "ps", "-q"]);
      stacks.push({ name: e.name, services: total, running });
    }
  }
  return stacks.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getStackCompose(name: string): Promise<string | null> {
  if (!NAME_RE.test(name)) return null;
  return readFile(composeFile(name), "utf8").catch(() => null);
}

export async function createStack(
  name: string,
  yaml: string,
  volume?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!NAME_RE.test(name)) return { ok: false, error: "Invalid stack name - use lowercase letters, digits, '-' or '_'." };
  if (existsSync(composeFile(name))) return { ok: false, error: "A stack with that name already exists." };
  // Create in the *chosen* location; every later lookup finds it by searching.
  const dir = join(stacksDirFor(volume), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "docker-compose.yml"), yaml, "utf8");
  return composeUp(name);
}

export async function composeUp(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!NAME_RE.test(name) || !existsSync(composeFile(name))) return { ok: false, error: "Stack not found." };
  try {
    await exec("docker", ["compose", "-f", composeFile(name), "up", "-d"], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as { stderr?: string }).stderr?.trim().split("\n").slice(-2).join(" ") || "compose up failed." };
  }
}

export async function composeDown(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!NAME_RE.test(name) || !existsSync(composeFile(name))) return { ok: false, error: "Stack not found." };
  try {
    await exec("docker", ["compose", "-f", composeFile(name), "down"], { timeout: 120000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as { stderr?: string }).stderr?.trim().split("\n").pop() || "compose down failed." };
  }
}

export async function removeStack(name: string): Promise<void> {
  if (!NAME_RE.test(name)) return;
  await composeDown(name).catch(() => {});
  await rm(stackDir(name), { recursive: true, force: true });
}
