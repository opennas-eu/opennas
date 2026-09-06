import { nanoid } from "nanoid";
import type { ScheduledAction, ScheduledTask } from "@opennas/shared";
import { db } from "./index.js";

/** Work an installed app asked OpenNAS to perform on a timer, per user. */

interface Row {
  id: string;
  app_id: string;
  user_id: string;
  name: string;
  interval_sec: number;
  action: string;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

/** A due task, with the owning app and user needed to carry it out. */
export interface DueTask extends ScheduledTask {
  appId: string;
  userId: string;
}

function toTask(row: Row): DueTask {
  return {
    id: row.id,
    appId: row.app_id,
    userId: row.user_id,
    name: row.name,
    intervalSeconds: row.interval_sec,
    action: JSON.parse(row.action) as ScheduledAction,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: (row.last_status as "ok" | "error" | null) ?? null,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

/** Strip the internal ownership columns - the caller already knows both. */
function toPublic(task: DueTask): ScheduledTask {
  const { appId: _appId, userId: _userId, ...rest } = task;
  return rest;
}

export function listTasks(appId: string, userId: string): ScheduledTask[] {
  const rows = db
    .prepare("SELECT * FROM scheduled_tasks WHERE app_id = ? AND user_id = ? ORDER BY name")
    .all(appId, userId) as Row[];
  return rows.map((r) => toPublic(toTask(r)));
}

export function countTasks(appId: string, userId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE app_id = ? AND user_id = ?").get(appId, userId) as {
      n: number;
    }
  ).n;
}

export function getTask(appId: string, userId: string, name: string): ScheduledTask | null {
  const row = db
    .prepare("SELECT * FROM scheduled_tasks WHERE app_id = ? AND user_id = ? AND name = ?")
    .get(appId, userId, name) as Row | undefined;
  return row ? toPublic(toTask(row)) : null;
}

export interface UpsertTask {
  appId: string;
  userId: string;
  name: string;
  intervalSeconds: number;
  action: ScheduledAction;
  enabled?: boolean;
}

/**
 * Register or update a task. The first run is one interval away - registering a
 * task on every app launch shouldn't fire it every time the user opens the app.
 */
export function upsertTask(input: UpsertTask): ScheduledTask {
  const now = Date.now();
  const nextRunAt = new Date(now + input.intervalSeconds * 1000).toISOString();
  const existing = getTask(input.appId, input.userId, input.name);
  db.prepare(
    `INSERT INTO scheduled_tasks (id, app_id, user_id, name, interval_sec, action, enabled, next_run_at, created_at)
     VALUES (@id, @appId, @userId, @name, @intervalSeconds, @action, @enabled, @nextRunAt, @createdAt)
     ON CONFLICT(app_id, user_id, name) DO UPDATE SET
       interval_sec = excluded.interval_sec,
       action       = excluded.action,
       enabled      = excluded.enabled,
       -- Only re-arm the timer when the schedule itself changed, so an app that
       -- re-registers an unchanged task on every launch can't starve it.
       next_run_at  = CASE WHEN scheduled_tasks.interval_sec != excluded.interval_sec
                           THEN excluded.next_run_at ELSE scheduled_tasks.next_run_at END`,
  ).run({
    id: existing?.id ?? nanoid(),
    appId: input.appId,
    userId: input.userId,
    name: input.name,
    intervalSeconds: input.intervalSeconds,
    action: JSON.stringify(input.action),
    enabled: input.enabled === false ? 0 : 1,
    nextRunAt,
    createdAt: new Date(now).toISOString(),
  });
  return getTask(input.appId, input.userId, input.name)!;
}

export function deleteTask(appId: string, userId: string, name: string): boolean {
  return db
    .prepare("DELETE FROM scheduled_tasks WHERE app_id = ? AND user_id = ? AND name = ?")
    .run(appId, userId, name).changes > 0;
}

/** Drop every task belonging to an app - used when it's uninstalled. */
export function deleteTasksForApp(appId: string): number {
  return db.prepare("DELETE FROM scheduled_tasks WHERE app_id = ?").run(appId).changes;
}

/** Tasks whose time has come. Capped so one tick can't run away with the box. */
export function dueTasks(limit = 25): DueTask[] {
  const rows = db
    .prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?")
    .all(new Date().toISOString(), limit) as Row[];
  return rows.map(toTask);
}

/** Record the outcome and arm the next run. */
export function completeRun(id: string, intervalSeconds: number, status: "ok" | "error", error?: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE scheduled_tasks
        SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ?
      WHERE id = ?`,
  ).run(
    new Date(now).toISOString(),
    status,
    error?.slice(0, 500) ?? null,
    new Date(now + intervalSeconds * 1000).toISOString(),
    id,
  );
}
