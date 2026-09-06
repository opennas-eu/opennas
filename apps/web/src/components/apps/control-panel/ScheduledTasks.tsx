import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type { SystemTask, SystemTaskFrequency, SystemTaskKind, SystemTasksResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input, Select, Toggle } from "../../ui/controls.tsx";

/**
 * Maintenance the NAS runs on a timer.
 *
 * There is deliberately no "run this script" here. The kinds are a fixed list,
 * which is both safer - a scheduled arbitrary command is a straight path from an
 * admin session to root - and more useful, because each one can then explain
 * what it actually does and what it can't.
 */

const KINDS: { id: SystemTaskKind; label: string; blurb: string; needs: "volume" | "disk" | "none" }[] = [
  {
    id: "config-backup",
    label: "Back up settings",
    blurb: "Saves users, shares and settings on this NAS. Keep a separate copy elsewhere in case the NAS fails.",
    needs: "none",
  },
  {
    id: "scrub",
    label: "Scrub a volume",
    blurb: "Reads everything back and checks it, so quiet corruption is caught early. btrfs, XFS and ZFS only.",
    needs: "volume",
  },
  {
    id: "trim",
    label: "Trim a volume",
    blurb: "Keeps an SSD fast as it fills up. Pointless on a hard disk, but harmless.",
    needs: "volume",
  },
  {
    id: "smart-test",
    label: "SMART self-test",
    blurb: "Starts the drive's self-test. View the result under Storage once the drive finishes.",
    needs: "disk",
  },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The schedule as a sentence, which is the whole reason for not using cron. */
function describe(task: SystemTask): string {
  const at = `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
  if (task.frequency === "daily") return `Every day at ${at}`;
  if (task.frequency === "weekly") return `Every ${DAYS[task.weekday] ?? "Sunday"} at ${at}`;
  const n = task.dayOfMonth;
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `The ${n}${suffix} of each month at ${at}`;
}

export function ScheduledTasks() {
  const [data, setData] = useState<SystemTasksResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    setData(await api.get<SystemTasksResponse>("/admin/tasks").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  // A running task finishes without telling anyone, so poll while one is.
  useEffect(() => {
    if (!data?.tasks.some((t) => t.lastStatus === "running")) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [data, load]);

  function fail(err: unknown, title: string) {
    push({ level: "warning", title, body: err instanceof ApiRequestError ? err.message : "Failed." });
  }

  async function toggle(task: SystemTask, enabled: boolean) {
    setBusy(task.id);
    try {
      await api.patch(`/admin/tasks/${task.id}`, { enabled });
      await load();
    } catch (err) {
      fail(err, "Couldn't change that task");
    } finally {
      setBusy(null);
    }
  }

  async function runNow(task: SystemTask) {
    setBusy(task.id);
    try {
      await api.post(`/admin/tasks/${task.id}/run`, {});
      push({ level: "info", title: "Started", body: `${task.name} is running now; its schedule is unchanged.` });
      await load();
    } catch (err) {
      fail(err, "Couldn't start that task");
    } finally {
      setBusy(null);
    }
  }

  async function remove(task: SystemTask) {
    const ok = await confirmDialog({
      title: `Delete "${task.name}"?`,
      message: "Removes the schedule. Existing backups and completed checks are kept.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(task.id);
    try {
      await api.del(`/admin/tasks/${task.id}`);
      await load();
    } catch (err) {
      fail(err, "Couldn't delete that task");
    } finally {
      setBusy(null);
    }
  }

  if (data === null) return null;

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <CalendarClock size={15} /> Scheduled tasks
        </h3>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> New task
          </Button>
        )}
      </div>

      {adding && (
        <TaskForm
          volumes={data.volumes}
          disks={data.disks}
          onDone={() => { setAdding(false); void load(); }}
          onCancel={() => setAdding(false)}
          onError={(m) => push({ level: "warning", title: "Couldn't create that task", body: m })}
        />
      )}

      {data.tasks.length === 0 && !adding ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          Nothing scheduled. A nightly settings backup and a monthly scrub are the two most worth having.
        </p>
      ) : (
        <div className="space-y-2">
          {data.tasks.map((t) => {
            const kind = KINDS.find((k) => k.id === t.kind);
            return (
              <div key={t.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-ink-soft">{t.name}</span>
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">
                        {kind?.label ?? t.kind}
                      </span>
                      {t.target && <span className="font-mono text-[11px] text-ink-faint">{t.target}</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-faint">
                      {describe(t)}
                      {t.enabled ? ` - next ${new Date(t.nextRunAt).toLocaleString()}` : " - paused"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Toggle checked={t.enabled} onChange={(v) => void toggle(t, v)} label={`Enable ${t.name}`} />
                    <button
                      onClick={() => void runNow(t)}
                      disabled={busy === t.id || t.lastStatus === "running"}
                      title="Run now"
                      className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-slate-200 disabled:opacity-40"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => void remove(t)}
                      disabled={busy === t.id}
                      title="Delete task"
                      className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {t.lastStatus && (
                  <div
                    className={clsx(
                      "mt-2 flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ring-1",
                      t.lastStatus === "ok"
                        ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                        : t.lastStatus === "running"
                          ? "bg-slate-100 text-ink-soft ring-slate-200"
                          : "bg-rose-50 text-rose-700 ring-rose-200",
                    )}
                  >
                    {t.lastStatus === "ok" ? (
                      <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                    ) : t.lastStatus === "running" ? (
                      <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />
                    ) : (
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      {t.lastRunAt && (
                        <span className="opacity-70">{new Date(t.lastRunAt).toLocaleString()} - </span>
                      )}
                      {t.lastStatus === "running" ? "Running now..." : <span className="whitespace-pre-wrap">{t.lastOutput}</span>}
                    </span>
                  </div>
                )}

                {kind && <p className="mt-1.5 text-[11px] text-ink-faint">{kind.blurb}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TaskForm({ volumes, disks, onDone, onCancel, onError }: {
  volumes: string[];
  disks: string[];
  onDone: () => void;
  onCancel: () => void;
  onError: (m: string) => void;
}) {
  const [kind, setKind] = useState<SystemTaskKind>("config-backup");
  const [name, setName] = useState("Nightly settings backup");
  const [target, setTarget] = useState("");
  const [frequency, setFrequency] = useState<SystemTaskFrequency>("daily");
  const [time, setTime] = useState("03:00");
  const [weekday, setWeekday] = useState(0);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [busy, setBusy] = useState(false);

  const meta = KINDS.find((k) => k.id === kind)!;
  const options = meta.needs === "volume" ? volumes : meta.needs === "disk" ? disks : [];
  const needsTarget = meta.needs !== "none";

  async function create() {
    setBusy(true);
    const [h, m] = time.split(":");
    try {
      await api.post("/admin/tasks", {
        name: name.trim(),
        kind,
        target: needsTarget ? target : "",
        frequency,
        hour: Number(h) || 0,
        minute: Number(m) || 0,
        weekday,
        dayOfMonth,
        enabled: true,
      });
      onDone();
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-2.5 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What to do">
          <Select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as SystemTaskKind;
              setKind(next);
              setTarget("");
              // A default name that matches what was just chosen, rather than
              // leaving "Nightly settings backup" on a scrub.
              setName(KINDS.find((k) => k.id === next)?.label ?? "");
            }}
            className="w-full"
          >
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>

      <p className="mt-2 text-[11px] text-ink-faint">{meta.blurb}</p>

      {needsTarget && (
        <div className="mt-3">
          <Field label={meta.needs === "volume" ? "Volume" : "Disk"}>
            {options.length === 0 ? (
              <p className="rounded-lg bg-white px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
                {meta.needs === "volume"
                  ? "Create a data volume under Storage first."
                  : "No disks were detected."}
              </p>
            ) : (
              <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full">
                <option value="">Choose one...</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            )}
          </Field>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="How often">
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value as SystemTaskFrequency)} className="w-full">
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </Select>
        </Field>
        {frequency === "weekly" && (
          <Field label="Day">
            <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="w-full">
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select>
          </Field>
        )}
        {frequency === "monthly" && (
          <Field label="Day of month">
            <Input
              type="number"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
            />
          </Field>
        )}
        <Field label="At">
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>

      {frequency === "monthly" && dayOfMonth > 28 && (
        <p className="mt-2 text-[11px] text-ink-faint">
          Months shorter than that run it on their last day instead of skipping it.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          className="h-8 px-3 text-xs"
          loading={busy}
          disabled={!name.trim() || (needsTarget && !target)}
          onClick={() => void create()}
        >
          Create task
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
