import type { FastifyBaseLogger } from "fastify";
import type { ScheduledAction } from "@opennas/shared";
import { getInstalledApp, setAppStorage } from "../db/installed-apps.js";
import { completeRun, deleteTasksForApp, dueTasks, type DueTask } from "../db/scheduled-tasks.js";
import { notifyUser } from "../notifications/hub.js";
import { FetchDenied, proxyFetch } from "./fetch-proxy.js";

/**
 * Runs the work apps scheduled.
 *
 * An OpenNAS app is a sandboxed iframe, so there is no app code to run on a
 * timer - the server performs the action instead. That constraint is what shapes
 * the design: an action can only be something OpenNAS can do *on the app's
 * behalf*, using a capability the app already holds. Scheduling is therefore not
 * a privilege of its own; it's a way to defer capabilities the admin already
 * approved.
 *
 * Permissions are re-checked at run time, not just when the task was registered,
 * so an app that loses a capability (uninstalled and reinstalled with less)
 * stops doing that work immediately.
 */

/** Anything shorter would be a polling loop wearing a scheduler's clothes. */
export const MIN_INTERVAL_SECONDS = 15 * 60;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60; // a month
/** Per app, per user. Enough for a few feeds; not enough to be a cron farm. */
export const MAX_TASKS_PER_APP = 10;

const TICK_MS = 60_000;

/** A task failure worth recording against the task rather than logging as a crash. */
class TaskError extends Error {}

async function runAction(task: DueTask, action: ScheduledAction): Promise<void> {
  const installed = getInstalledApp(task.appId);
  if (!installed) throw new TaskError("The app is no longer installed.");
  if (!installed.enabled) throw new TaskError("The app is disabled.");
  const held = installed.manifest.permissions ?? [];

  if (action.kind === "notify") {
    if (!held.includes("notifications")) throw new TaskError("The app no longer has notification access.");
    notifyUser({
      userId: task.userId,
      level: action.level ?? "info",
      title: action.title,
      body: action.body,
      appId: task.appId,
      // One pending reminder per task: a daily task nobody opens shouldn't
      // stack up thirty identical rows.
      dedupeKey: `app-task:${task.appId}:${task.id}`,
    });
    return;
  }

  if (action.kind === "fetch") {
    if (!held.includes("fetch")) throw new TaskError("The app no longer has network access.");
    if (!held.includes("storage")) throw new TaskError("The app no longer has storage access.");
    const allowed = installed.manifest.fetchHosts ?? [];
    if (allowed.length === 0) throw new TaskError("The app has no allowed hosts.");
    // Same proxy as a live call - allowlist, SSRF checks, size and time caps.
    const res = await proxyFetch(
      { url: action.url, method: action.method, headers: action.headers },
      allowed,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new TaskError(`The request returned HTTP ${res.status}.`);
    }
    // App storage holds strings and is capped at 256 KB per key by the route;
    // apply the same ceiling here rather than letting the scheduler bypass it.
    if (res.body.length > 256 * 1024) throw new TaskError("The response is too large to store.");
    setAppStorage(task.appId, task.userId, action.storeAs, res.body);
    return;
  }

  throw new TaskError("Unknown action.");
}

/** Run everything currently due. Exported so a test can drive it directly. */
export async function runDueTasks(log: FastifyBaseLogger): Promise<{ ran: number; failed: number }> {
  const tasks = dueTasks();
  let ran = 0;
  let failed = 0;

  for (const task of tasks) {
    // A task whose app is gone would otherwise retry forever.
    if (!getInstalledApp(task.appId)) {
      deleteTasksForApp(task.appId);
      continue;
    }
    try {
      await runAction(task, task.action);
      completeRun(task.id, task.intervalSeconds, "ok");
      ran++;
    } catch (err) {
      const message =
        err instanceof TaskError || err instanceof FetchDenied ? err.message : "The task could not be completed.";
      if (!(err instanceof TaskError) && !(err instanceof FetchDenied)) {
        log.error({ err, app: task.appId, task: task.name }, "scheduled task crashed");
      } else {
        log.warn({ app: task.appId, task: task.name, reason: message }, "scheduled task failed");
      }
      // Still re-arm: a transient upstream failure shouldn't kill the schedule.
      completeRun(task.id, task.intervalSeconds, "error", message);
      failed++;
    }
  }
  return { ran, failed };
}

/** Start the once-a-minute tick. Returns a stop function for the onClose hook. */
export function startScheduler(log: FastifyBaseLogger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow batch must not overlap the next tick
    running = true;
    try {
      const { ran, failed } = await runDueTasks(log);
      if (ran > 0 || failed > 0) log.info({ ran, failed }, "ran scheduled app tasks");
    } catch (err) {
      log.warn({ err }, "scheduler tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
