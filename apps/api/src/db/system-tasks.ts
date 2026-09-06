import { nanoid } from "nanoid";
import type { SystemTask, SystemTaskFrequency, SystemTaskKind } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Maintenance the NAS runs to a schedule.
 *
 * The schedule is deliberately not cron. A NAS needs "every night at 3", "every
 * Sunday", "the 1st of the month" - and a five-field expression is both harder
 * to get right and impossible to show back to someone in a sentence. The three
 * shapes here cover what people actually schedule, and `nextRunAt` is computed
 * once and stored, so a restart doesn't lose or double-fire anything.
 */

export const TASK_KINDS: SystemTaskKind[] = ["config-backup", "scrub", "trim", "smart-test"];
export const MAX_TASKS = 20;
/** Enough of a scrub's output to diagnose it, without turning the row into a log file. */
export const MAX_OUTPUT_CHARS = 4000;

interface Row {
  id: string;
  name: string;
  kind: SystemTaskKind;
  target: string;
  options: string;
  frequency: SystemTaskFrequency;
  hour: number;
  minute: number;
  weekday: number;
  day_of_month: number;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_status: "ok" | "error" | "running" | null;
  last_output: string | null;
  created_at: string;
}

function toTask(r: Row): SystemTask {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    target: r.target,
    frequency: r.frequency,
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    dayOfMonth: r.day_of_month,
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastOutput: r.last_output,
    createdAt: r.created_at,
  };
}

export interface Schedule {
  frequency: SystemTaskFrequency;
  hour: number;
  minute: number;
  weekday: number;
  dayOfMonth: number;
}

/**
 * When this schedule next comes round, strictly after `from`.
 *
 * Works in local time, because "3am" means 3am where the NAS is - a backup
 * window chosen to be quiet is chosen against the household's clock, not UTC.
 * `setDate` past the end of a month rolls forward on its own, which is what
 * makes "the 31st" behave sanely in February rather than being skipped.
 */
export function nextRun(schedule: Schedule, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(schedule.hour, schedule.minute);

  if (schedule.frequency === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (schedule.frequency === "weekly") {
    const target = ((schedule.weekday % 7) + 7) % 7;
    let delta = (target - next.getDay() + 7) % 7;
    // Same weekday but the time has already gone by today → next week.
    if (delta === 0 && next <= from) delta = 7;
    next.setDate(next.getDate() + delta);
    return next;
  }

  // Monthly. Clamp to the length of the target month so "the 31st" lands on the
  // last day of a short month instead of silently jumping into the next one.
  const day = Math.min(Math.max(1, schedule.dayOfMonth), 31);
  next.setDate(1);
  const place = (d: Date) => {
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  };
  place(next);
  if (next <= from) {
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    place(next);
  }
  return next;
}

export function listSystemTasks(): SystemTask[] {
  const rows = db.prepare("SELECT * FROM system_tasks ORDER BY created_at ASC").all() as Row[];
  return rows.map(toTask);
}

export function getSystemTask(id: string): SystemTask | null {
  const row = db.prepare("SELECT * FROM system_tasks WHERE id = ?").get(id) as Row | undefined;
  return row ? toTask(row) : null;
}

export function countSystemTasks(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM system_tasks").get() as { n: number }).n;
}

export interface CreateTaskInput extends Schedule {
  name: string;
  kind: SystemTaskKind;
  target: string;
  enabled: boolean;
}

export function createSystemTask(input: CreateTaskInput): SystemTask {
  const row: Row = {
    id: nanoid(),
    name: input.name,
    kind: input.kind,
    target: input.target,
    options: "{}",
    frequency: input.frequency,
    hour: input.hour,
    minute: input.minute,
    weekday: input.weekday,
    day_of_month: input.dayOfMonth,
    enabled: input.enabled ? 1 : 0,
    next_run_at: nextRun(input).toISOString(),
    last_run_at: null,
    last_status: null,
    last_output: null,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO system_tasks
       (id, name, kind, target, options, frequency, hour, minute, weekday, day_of_month,
        enabled, next_run_at, last_run_at, last_status, last_output, created_at)
     VALUES
       (@id, @name, @kind, @target, @options, @frequency, @hour, @minute, @weekday, @day_of_month,
        @enabled, @next_run_at, @last_run_at, @last_status, @last_output, @created_at)`,
  ).run(row);
  return toTask(row);
}

export interface UpdateTaskInput extends Partial<Schedule> {
  name?: string;
  target?: string;
  enabled?: boolean;
}

export function updateSystemTask(id: string, fields: UpdateTaskInput): SystemTask | null {
  const current = db.prepare("SELECT * FROM system_tasks WHERE id = ?").get(id) as Row | undefined;
  if (!current) return null;

  const schedule: Schedule = {
    frequency: fields.frequency ?? current.frequency,
    hour: fields.hour ?? current.hour,
    minute: fields.minute ?? current.minute,
    weekday: fields.weekday ?? current.weekday,
    dayOfMonth: fields.dayOfMonth ?? current.day_of_month,
  };
  const scheduleChanged =
    schedule.frequency !== current.frequency ||
    schedule.hour !== current.hour ||
    schedule.minute !== current.minute ||
    schedule.weekday !== current.weekday ||
    schedule.dayOfMonth !== current.day_of_month;

  // Re-arm only when the schedule actually moved, or when a disabled task is
  // switched back on - otherwise renaming a task at 02:59 would push its 03:00
  // run to tomorrow.
  const reArm = scheduleChanged || (fields.enabled === true && current.enabled === 0);

  db.prepare(
    `UPDATE system_tasks SET
       name = @name, target = @target, frequency = @frequency, hour = @hour, minute = @minute,
       weekday = @weekday, day_of_month = @day_of_month, enabled = @enabled, next_run_at = @next_run_at
     WHERE id = @id`,
  ).run({
    id,
    name: fields.name ?? current.name,
    target: fields.target ?? current.target,
    frequency: schedule.frequency,
    hour: schedule.hour,
    minute: schedule.minute,
    weekday: schedule.weekday,
    day_of_month: schedule.dayOfMonth,
    enabled: (fields.enabled ?? current.enabled === 1) ? 1 : 0,
    next_run_at: reArm ? nextRun(schedule).toISOString() : current.next_run_at,
  });
  return getSystemTask(id);
}

export function deleteSystemTask(id: string): boolean {
  return db.prepare("DELETE FROM system_tasks WHERE id = ?").run(id).changes > 0;
}

/** Enabled tasks whose time has come. */
export function dueSystemTasks(now: Date = new Date()): SystemTask[] {
  const rows = db
    .prepare("SELECT * FROM system_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(now.toISOString()) as Row[];
  return rows.map(toTask);
}

/**
 * Mark a task as started and move its next run forward.
 *
 * The re-arm happens *before* the work runs, not after: a scrub can take hours,
 * and a task still marked due for that whole time would be picked up again by
 * every tick in between.
 */
export function markTaskStarted(id: string, now: Date = new Date()): void {
  const row = db.prepare("SELECT * FROM system_tasks WHERE id = ?").get(id) as Row | undefined;
  if (!row) return;
  const next = nextRun(
    {
      frequency: row.frequency,
      hour: row.hour,
      minute: row.minute,
      weekday: row.weekday,
      dayOfMonth: row.day_of_month,
    },
    now,
  );
  db.prepare(
    "UPDATE system_tasks SET last_run_at = ?, last_status = 'running', last_output = NULL, next_run_at = ? WHERE id = ?",
  ).run(now.toISOString(), next.toISOString(), id);
}

export function markTaskFinished(id: string, status: "ok" | "error", output: string): void {
  db.prepare("UPDATE system_tasks SET last_status = ?, last_output = ? WHERE id = ?").run(
    status,
    output.slice(0, MAX_OUTPUT_CHARS),
    id,
  );
}

/**
 * Clear any task left mid-run by a restart.
 *
 * Nothing survives the process that started it, so a row still saying "running"
 * at startup is a task that was interrupted - reporting that is more honest than
 * leaving a spinner that never resolves.
 */
export function clearInterruptedTasks(): number {
  return db
    .prepare(
      "UPDATE system_tasks SET last_status = 'error', last_output = ? WHERE last_status = 'running'",
    )
    .run("Interrupted - OpenNAS restarted while this was running.").changes;
}
