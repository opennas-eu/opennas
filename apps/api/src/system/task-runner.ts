import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import type { SystemTask } from "@opennas/shared";
import { config } from "../config.js";
import { exportConfig } from "./config-backup.js";
import {
  clearInterruptedTasks,
  dueSystemTasks,
  markTaskFinished,
  markTaskStarted,
} from "../db/system-tasks.js";

const exec = promisify(execFile);

/**
 * Runs scheduled maintenance.
 *
 * Two things shape this. First, the work is slow - a scrub on a full array is
 * hours - so a task is re-armed the moment it starts rather than when it
 * finishes, and a tick never waits for one. Second, everything it can run comes
 * from a fixed catalogue: the target is validated here as well as at the API,
 * because these arguments reach a root helper and a scheduler is exactly the
 * place a bad value sits unnoticed until 3am.
 */

const TICK_MS = 60_000;
/** How long a single task may run before it is given up on. */
const TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Config backups to keep before the oldest is pruned. */
export const KEEP_BACKUPS = 14;

const LABEL_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DISK_RE = /^\/dev\/[a-zA-Z0-9/_-]{1,64}$/;

function backupDir(): string {
  return join(config.dataDir, "backups");
}

/** Run one task to completion and record what happened. */
export async function runTask(task: SystemTask, log: FastifyBaseLogger): Promise<void> {
  try {
    const output = await performTask(task);
    markTaskFinished(task.id, "ok", output || "Completed.");
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    const message = e.killed
      ? "Gave up waiting after six hours."
      : (e.stderr?.trim() || e.stdout?.trim() || e.message || "Failed.");
    markTaskFinished(task.id, "error", message);
    log.warn({ task: task.id, kind: task.kind, err }, "scheduled task failed");
  }
}

async function performTask(task: SystemTask): Promise<string> {
  switch (task.kind) {
    case "config-backup":
      return await runConfigBackup();

    case "scrub": {
      if (!LABEL_RE.test(task.target)) throw new Error("That volume name isn't valid.");
      const { stdout } = await exec("doas", ["/usr/lib/opennas/opennas-storage", "scrub", task.target], {
        timeout: TASK_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim();
    }

    case "trim": {
      if (!LABEL_RE.test(task.target)) throw new Error("That volume name isn't valid.");
      const { stdout } = await exec("doas", ["/usr/lib/opennas/opennas-storage", "trim", task.target], {
        timeout: 30 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    }

    case "smart-test": {
      if (!DISK_RE.test(task.target)) throw new Error("That disk path isn't valid.");
      // The drive runs the test itself, so this returns as soon as it is
      // accepted - the result is read from the disk's SMART page afterwards,
      // not from here. Saying so avoids "completed" reading as "passed".
      const { stdout } = await exec(
        "doas",
        ["/usr/lib/opennas/opennas-storage", "smart-test", task.target, "long"],
        { timeout: 60_000 },
      );
      return `${stdout.trim()}\n\nThe drive runs this itself in the background. Check its SMART health in Storage once it has had time to finish.`;
    }

    default:
      throw new Error("Unknown task kind.");
  }
}

/**
 * Write a timestamped config backup and prune the oldest.
 *
 * Kept on the NAS itself, which is worth being clear-eyed about: it protects
 * against a bad change, not against losing the machine. The UI says so - a
 * backup whose only copy is on the thing it backs up is a comfort, not a plan.
 */
async function runConfigBackup(): Promise<string> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `opennas-config-${stamp}.json`;
  const body = JSON.stringify(exportConfig(), null, 2);
  await writeFile(join(dir, name), body, { encoding: "utf8", mode: 0o600 });

  const existing = (await readdir(dir))
    .filter((f) => f.startsWith("opennas-config-") && f.endsWith(".json"))
    .sort();
  let pruned = 0;
  for (const old of existing.slice(0, Math.max(0, existing.length - KEEP_BACKUPS))) {
    await rm(join(dir, old), { force: true });
    pruned++;
  }
  const size = Buffer.byteLength(body);
  return `Saved ${name} (${size.toLocaleString()} bytes).${pruned > 0 ? ` Pruned ${pruned} older backup${pruned === 1 ? "" : "s"}.` : ""}`;
}

/** List the config backups on disk, newest first. */
export async function listConfigBackups(): Promise<{ name: string; savedAt: string }[]> {
  try {
    const files = await readdir(backupDir());
    return files
      .filter((f) => f.startsWith("opennas-config-") && f.endsWith(".json"))
      .sort()
      .reverse()
      .map((name) => ({
        name,
        // The timestamp is in the filename, so no stat call is needed to sort or
        // display them.
        savedAt: name.slice("opennas-config-".length, -".json".length).replace(/-/g, (_dash, i: number) => (i > 9 ? ":" : "-")),
      }));
  } catch {
    return [];
  }
}

/**
 * Start the once-a-minute tick. Returns a stop function for the onClose hook.
 */
export function startTaskRunner(log: FastifyBaseLogger): () => void {
  // Anything the previous process was midway through is gone with it.
  const interrupted = clearInterruptedTasks();
  if (interrupted > 0) log.info({ interrupted }, "cleared scheduled tasks interrupted by a restart");

  // Tasks in flight, so a slow scrub isn't started again by the next tick.
  const running = new Set<string>();

  const tick = () => {
    let due: SystemTask[];
    try {
      due = dueSystemTasks();
    } catch (err) {
      log.warn({ err }, "could not read scheduled tasks");
      return;
    }
    for (const task of due) {
      if (running.has(task.id)) continue;
      running.add(task.id);
      // Re-armed before the work starts: a scrub can run for hours, and a task
      // still marked due for that whole time would be picked up by every tick
      // in between.
      markTaskStarted(task.id);
      log.info({ task: task.id, kind: task.kind, target: task.target }, "running scheduled task");
      void runTask(task, log).finally(() => running.delete(task.id));
    }
  };

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
