import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type { SystemTask, SystemTaskFrequency, SystemTaskKind, SystemTasksResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input, Select, Toggle } from "../../ui/controls.tsx";
import { useLocale, useT, type MessageKey } from "../../../i18n/index.ts";

type T = ReturnType<typeof useT>;

/**
 * Maintenance the NAS runs on a timer.
 *
 * There is deliberately no "run this script" here. The kinds are a fixed list,
 * which is both safer - a scheduled arbitrary command is a straight path from an
 * admin session to root - and more useful, because each one can then explain
 * what it actually does and what it can't.
 */

const KINDS: { id: SystemTaskKind; label: MessageKey; blurb: MessageKey; needs: "volume" | "disk" | "none" }[] = [
  {
    id: "config-backup",
    label: "cp.tasks.kind.configBackup",
    blurb: "cp.tasks.kind.configBackupBlurb",
    needs: "none",
  },
  {
    id: "scrub",
    label: "cp.tasks.kind.scrub",
    blurb: "cp.tasks.kind.scrubBlurb",
    needs: "volume",
  },
  {
    id: "trim",
    label: "cp.tasks.kind.trim",
    blurb: "cp.tasks.kind.trimBlurb",
    needs: "volume",
  },
  {
    id: "smart-test",
    label: "cp.tasks.kind.smartTest",
    blurb: "cp.tasks.kind.smartTestBlurb",
    needs: "disk",
  },
];

/** Weekday names in the active language, Sunday first (index = JS getDay()). */
function weekdayNames(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "long" });
  // 1 January 2023 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
}

/** "1st", "2nd"... - or "1." - picked by the language's ordinal rules. */
function ordinal(t: T, locale: string, n: number): string {
  const rule = new Intl.PluralRules(locale, { type: "ordinal" }).select(n);
  const key: MessageKey =
    rule === "one" ? "cp.tasks.ordinal.one" : rule === "two" ? "cp.tasks.ordinal.two" : rule === "few" ? "cp.tasks.ordinal.few" : "cp.tasks.ordinal.other";
  return t(key, { n });
}

/** The schedule as a sentence, which is the whole reason for not using cron. */
function describe(task: SystemTask, t: T, locale: string): string {
  const at = `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
  if (task.frequency === "daily") return t("cp.tasks.everyDayAt", { at });
  const days = weekdayNames(locale);
  if (task.frequency === "weekly") return t("cp.tasks.everyWeekdayAt", { day: days[task.weekday] ?? days[0]!, at });
  return t("cp.tasks.monthlyAt", { nth: ordinal(t, locale, task.dayOfMonth), at });
}

export function ScheduledTasks() {
  const t = useT();
  const locale = useLocale();
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
    if (!data?.tasks.some((x) => x.lastStatus === "running")) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [data, load]);

  function fail(err: unknown, title: string) {
    push({ level: "warning", title, body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
  }

  async function toggle(task: SystemTask, enabled: boolean) {
    setBusy(task.id);
    try {
      await api.patch(`/admin/tasks/${task.id}`, { enabled });
      await load();
    } catch (err) {
      fail(err, t("cp.tasks.changeFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function runNow(task: SystemTask) {
    setBusy(task.id);
    try {
      await api.post(`/admin/tasks/${task.id}/run`, {});
      push({ level: "info", title: t("cp.tasks.started"), body: t("cp.tasks.startedBody", { name: task.name }) });
      await load();
    } catch (err) {
      fail(err, t("cp.tasks.startFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function remove(task: SystemTask) {
    const ok = await confirmDialog({
      title: t("cp.tasks.deleteTitle", { name: task.name }),
      message: t("cp.tasks.deleteMessage"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusy(task.id);
    try {
      await api.del(`/admin/tasks/${task.id}`);
      await load();
    } catch (err) {
      fail(err, t("cp.tasks.deleteFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (data === null) return null;

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <CalendarClock size={15} /> {t("tasks.title")}
        </h3>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> {t("tasks.new")}
          </Button>
        )}
      </div>

      {adding && (
        <TaskForm
          volumes={data.volumes}
          disks={data.disks}
          onDone={() => { setAdding(false); void load(); }}
          onCancel={() => setAdding(false)}
          onError={(m) => push({ level: "warning", title: t("cp.tasks.createFailed"), body: m })}
        />
      )}

      {data.tasks.length === 0 && !adding ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          {t("cp.tasks.empty")}
        </p>
      ) : (
        <div className="space-y-2">
          {data.tasks.map((task) => {
            const kind = KINDS.find((k) => k.id === task.kind);
            return (
              <div key={task.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-ink-soft">{task.name}</span>
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">
                        {kind ? t(kind.label) : task.kind}
                      </span>
                      {task.target && <span className="font-mono text-[11px] text-ink-faint">{task.target}</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-faint">
                      {describe(task, t, locale)}
                      {" - "}
                      {task.enabled ? t("tasks.nextRun", { when: new Date(task.nextRunAt).toLocaleString() }) : t("tasks.paused")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Toggle checked={task.enabled} onChange={(v) => void toggle(task, v)} label={t("cp.tasks.enableLabel", { name: task.name })} />
                    <button
                      onClick={() => void runNow(task)}
                      disabled={busy === task.id || task.lastStatus === "running"}
                      title={t("tasks.runNow")}
                      className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-slate-200 disabled:opacity-40"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => void remove(task)}
                      disabled={busy === task.id}
                      title={t("cp.tasks.deleteTask")}
                      className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {task.lastStatus && (
                  <div
                    className={clsx(
                      "mt-2 flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ring-1",
                      task.lastStatus === "ok"
                        ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                        : task.lastStatus === "running"
                          ? "bg-slate-100 text-ink-soft ring-slate-200"
                          : "bg-rose-50 text-rose-700 ring-rose-200",
                    )}
                  >
                    {task.lastStatus === "ok" ? (
                      <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                    ) : task.lastStatus === "running" ? (
                      <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />
                    ) : (
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      {task.lastRunAt && (
                        <span className="opacity-70">{new Date(task.lastRunAt).toLocaleString()} - </span>
                      )}
                      {task.lastStatus === "running" ? t("tasks.running") : <span className="whitespace-pre-wrap">{task.lastOutput}</span>}
                    </span>
                  </div>
                )}

                {kind && <p className="mt-1.5 text-[11px] text-ink-faint">{t(kind.blurb)}</p>}
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
  const t = useT();
  const locale = useLocale();
  const days = weekdayNames(locale);
  const [kind, setKind] = useState<SystemTaskKind>("config-backup");
  const [name, setName] = useState(() => t("cp.tasks.defaultName"));
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
      onError(err instanceof ApiRequestError ? err.message : t("cp.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-2.5 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("cp.tasks.whatToDo")}>
          <Select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as SystemTaskKind;
              setKind(next);
              setTarget("");
              // A default name that matches what was just chosen, rather than
              // leaving "Nightly settings backup" on a scrub.
              const nextKind = KINDS.find((k) => k.id === next);
              setName(nextKind ? t(nextKind.label) : "");
            }}
            className="w-full"
          >
            {KINDS.map((k) => <option key={k.id} value={k.id}>{t(k.label)}</option>)}
          </Select>
        </Field>
        <Field label={t("common.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>

      <p className="mt-2 text-[11px] text-ink-faint">{t(meta.blurb)}</p>

      {needsTarget && (
        <div className="mt-3">
          <Field label={meta.needs === "volume" ? t("cp.tasks.volume") : t("cp.tasks.disk")}>
            {options.length === 0 ? (
              <p className="rounded-lg bg-white px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
                {meta.needs === "volume"
                  ? t("cp.tasks.noVolumes")
                  : t("cp.tasks.noDisks")}
              </p>
            ) : (
              <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full">
                <option value="">{t("cp.tasks.chooseOne")}</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            )}
          </Field>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label={t("cp.tasks.howOften")}>
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value as SystemTaskFrequency)} className="w-full">
            <option value="daily">{t("cp.tasks.everyDay")}</option>
            <option value="weekly">{t("cp.tasks.everyWeek")}</option>
            <option value="monthly">{t("cp.tasks.everyMonth")}</option>
          </Select>
        </Field>
        {frequency === "weekly" && (
          <Field label={t("cp.tasks.day")}>
            <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="w-full">
              {days.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </Select>
          </Field>
        )}
        {frequency === "monthly" && (
          <Field label={t("cp.tasks.dayOfMonth")}>
            <Input
              type="number"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
            />
          </Field>
        )}
        <Field label={t("cp.tasks.at")}>
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>

      {frequency === "monthly" && dayOfMonth > 28 && (
        <p className="mt-2 text-[11px] text-ink-faint">
          {t("cp.tasks.shortMonths")}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          className="h-8 px-3 text-xs"
          loading={busy}
          disabled={!name.trim() || (needsTarget && !target)}
          onClick={() => void create()}
        >
          {t("cp.tasks.createTask")}
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}
