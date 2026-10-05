import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Database,
  HardDrive,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Waves,
} from "lucide-react";
import type {
  StorageDisk,
  ZfsDataset,
  ZfsLayoutInfo,
  ZfsPool,
  ZfsResponse,
  ZfsSnapshot,
  ZfsSnapshotsResponse,
} from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog, promptDialog } from "../../../store/dialogs.ts";
import { formatBytes } from "../../../lib/format.ts";
import { Button, Input, Select } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";

/**
 * ZFS pools, datasets and snapshots.
 *
 * Two things this panel is deliberately blunt about, because both are
 * irreversible and both are things people find out too late:
 *
 * **What a layout survives.** Every option says how many disks may fail, and
 * stripe says outright that losing one loses everything. A picker that only
 * listed names would be asking someone to know ZFS before they can use it.
 *
 * **That a raidz vdev cannot grow.** On the OpenZFS version Alpine ships, a
 * raidz pool gains capacity by adding whole vdevs, never by adding a disk to an
 * existing one. That is the single most surprising difference from mdadm, and it
 * is shown *while choosing a layout* rather than in documentation nobody reads
 * after their disks are already full.
 */
export function Zfs({ disks, onChanged }: { disks: StorageDisk[]; onChanged: () => Promise<void> }) {
  const t = useT();
  const [data, setData] = useState<ZfsResponse | null>(null);
  const [layouts, setLayouts] = useState<ZfsLayoutInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ZfsResponse>("/admin/zfs"));
    } catch {
      setData(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void api
      .get<{ layouts: ZfsLayoutInfo[] }>("/admin/zfs/layouts")
      .then((r) => setLayouts(r.layouts))
      .catch(() => {});
  }, [load]);

  // While a scrub or resilver runs, the numbers move - so the panel does too.
  useEffect(() => {
    const busyPool = data?.pools.some((p) => p.scan !== null);
    if (!busyPool) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [data, load]);

  function fail(err: unknown, title: string) {
    push({ level: "warning", title, body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
  }

  async function act(key: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(key);
    try {
      await fn();
      if (success) push({ level: "success", title: success });
      await load();
      await onChanged();
    } catch (err) {
      fail(err, t("cp.zfs.actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (data === null) return null;

  if (data.status.state !== "ready") {
    return (
      <section className="mt-6">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <Waves size={15} /> ZFS
        </h3>
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{data.status.reason || t("cp.zfs.unavailable")}</span>
        </p>
      </section>
    );
  }

  const free = disks.filter((d) => d.state === "unconfigured");

  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <Waves size={15} /> ZFS
        </h3>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-ink-faint">
          {data.status.version}
        </span>
      </div>

      <p className="mb-3 text-xs text-ink-faint">
        {t("cp.zfs.intro")}
      </p>

      {data.importable.length > 0 && (
        <div className="mb-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 ring-1 ring-brand-200">
          <div className="mb-1 font-medium">
            {t("cp.zfs.importable", { count: data.importable.length })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.importable.map((name) => (
              <Button
                key={name}
                variant="secondary"
                className="h-7 px-2 text-xs"
                loading={busy === `import-${name}`}
                onClick={() => void act(`import-${name}`, () => api.post("/admin/zfs/import", { name }), t("cp.zfs.imported", { name }))}
              >
                {t("cp.zfs.import", { name })}
              </Button>
            ))}
          </div>
        </div>
      )}

      {data.pools.length === 0 ? (
        <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          {t("cp.zfs.noPools")}
        </p>
      ) : (
        <div className="mb-3 space-y-2">
          {data.pools.map((p) => (
            <PoolCard
              key={p.name}
              pool={p}
              datasets={data.datasets.filter((d) => d.name === p.name || d.name.startsWith(`${p.name}/`))}
              busy={busy}
              act={act}
            />
          ))}
        </div>
      )}

      {free.length > 0 && layouts.length > 0 && (
        <PoolCreate
          disks={free}
          layouts={layouts}
          raidzExpansion={data.status.raidzExpansion}
          onCreated={async () => {
            await load();
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

function health(state: string): string {
  if (state === "ONLINE") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (state === "DEGRADED") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-rose-50 text-rose-700 ring-rose-200";
}

function PoolCard({
  pool,
  datasets,
  busy,
  act,
}: {
  pool: ZfsPool;
  datasets: ZfsDataset[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const t = useT();
  const [showSnaps, setShowSnaps] = useState(false);
  const degraded = pool.health !== "ONLINE";

  async function destroy() {
    if (
      !(await confirmDialog({
        title: t("cp.zfs.destroyPoolTitle", { name: pool.name }),
        message: t("cp.zfs.destroyPoolMessage"),
        confirmLabel: t("cp.zfs.erasePool"),
        danger: true,
      }))
    )
      return;
    await act(`destroy-${pool.name}`, () => api.del(`/admin/zfs/pools/${pool.name}`), t("cp.zfs.destroyed", { name: pool.name }));
  }

  async function newDataset() {
    const name = await promptDialog({
      title: t("cp.zfs.newDatasetTitle", { pool: pool.name }),
      message: t("cp.zfs.newDatasetMessage"),
      placeholder: t("cp.zfs.newDatasetPlaceholder"),
      confirmLabel: t("common.create"),
    });
    if (!name) return;
    await act(
      `ds-${pool.name}`,
      () => api.post("/admin/zfs/datasets", { name: `${pool.name}/${name.trim()}` }),
      t("cp.zfs.created", { name: `${pool.name}/${name.trim()}` }),
    );
  }

  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-ink-faint ring-1 ring-slate-200">
          <Database size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-soft">{pool.name}</span>
            <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ring-1 ${health(pool.health)}`}>
              {pool.health}
            </span>
            {pool.scan && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-1.5 py-px text-[10px] text-brand-700">
                <Loader2 size={9} className="animate-spin" />
                {pool.scan.kind}
                {pool.scan.percent !== null && ` ${pool.scan.percent}%`}
              </span>
            )}
          </div>
          <div className="text-xs text-ink-faint">
            {t("cp.zfs.poolUsage", {
              used: formatBytes(pool.allocatedBytes),
              total: formatBytes(pool.sizeBytes),
              percent: pool.capacityPercent,
              mountpoint: pool.mountpoint,
            })}
          </div>
        </div>
        <Button
          variant="secondary"
          className="h-8 px-2 text-xs"
          loading={busy === `scrub-${pool.name}`}
          onClick={() =>
            void act(`scrub-${pool.name}`, () => api.post(`/admin/zfs/pools/${pool.name}/scrub`, {}), t("cp.zfs.scrubStarted"))
          }
        >
          <ShieldCheck size={13} /> {t("cp.zfs.scrub")}
        </Button>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setShowSnaps((s) => !s)}>
          <Camera size={13} /> {t("cp.zfs.snapshots")}
        </Button>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => void newDataset()}>
          <Plus size={13} /> {t("cp.zfs.dataset")}
        </Button>
        <Button
          variant="ghost"
          className="h-8 px-2 text-rose-600 hover:bg-rose-50"
          title={t("cp.zfs.destroyPool")}
          loading={busy === `destroy-${pool.name}`}
          onClick={() => void destroy()}
        >
          <Trash2 size={15} />
        </Button>
      </div>

      {/* ZFS's own words, never paraphrased - if it says applications may be affected, so do we. */}
      {degraded && pool.statusNote && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{pool.statusNote}</span>
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        {pool.vdevs.map((v) => (
          <div key={v.name} className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200/70">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono text-ink-soft">{v.name}</span>
              <span className={`rounded-full px-1.5 text-[10px] ring-1 ${health(v.state)}`}>{v.state}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {v.members.map((m) => {
                const bad = m.state !== "ONLINE";
                const errs = m.errors.read + m.errors.write + m.errors.checksum;
                return (
                  <span
                    key={m.name}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10px] ring-1 ${
                      bad || errs > 0 ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-slate-50 text-ink-faint ring-slate-200"
                    }`}
                    title={t("cp.zfs.memberErrors", { state: m.state, read: m.errors.read, write: m.errors.write, checksum: m.errors.checksum })}
                  >
                    <HardDrive size={9} />
                    {m.name}
                    {errs > 0 && <span className="font-semibold">{t("cp.zfs.errorCount", { count: errs })}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {datasets.filter((d) => d.name !== pool.name).length > 0 && (
        <div className="mt-2 space-y-1">
          {datasets
            .filter((d) => d.name !== pool.name)
            .map((d) => (
              <DatasetRow key={d.name} dataset={d} busy={busy} act={act} />
            ))}
        </div>
      )}

      {showSnaps && <Snapshots pool={pool.name} datasets={datasets.map((d) => d.name)} busy={busy} act={act} />}
    </div>
  );
}

function DatasetRow({
  dataset,
  busy,
  act,
}: {
  dataset: ZfsDataset;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const t = useT();
  async function setQuota() {
    const answer = await promptDialog({
      title: t("cp.zfs.quotaTitle", { name: dataset.name }),
      message: t("cp.zfs.quotaMessage"),
      placeholder: dataset.quotaBytes > 0 ? String(Math.round(dataset.quotaBytes / 1024 ** 3)) : "",
      confirmLabel: t("common.save"),
    });
    if (answer === null) return;
    const gb = answer.trim() === "" ? null : Number(answer);
    if (gb !== null && (!Number.isFinite(gb) || gb <= 0)) return;
    await act(
      `quota-${dataset.name}`,
      () => api.put("/admin/zfs/datasets/quota", { name: dataset.name, bytes: gb === null ? null : Math.round(gb * 1024 ** 3) }),
      t("cp.zfs.quotaSaved"),
    );
  }

  async function destroy() {
    if (
      !(await confirmDialog({
        title: t("cp.zfs.destroyDatasetTitle", { name: dataset.name }),
        message: t("cp.zfs.destroyDatasetMessage"),
        confirmLabel: t("cp.zfs.erase"),
        danger: true,
      }))
    )
      return;
    await act(
      `dsdel-${dataset.name}`,
      () => api.del(`/admin/zfs/datasets?name=${encodeURIComponent(dataset.name)}`),
      t("cp.zfs.datasetDestroyed"),
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs ring-1 ring-slate-200/70">
      <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{dataset.name}</span>
      <span className="text-ink-faint">
        {formatBytes(dataset.usedBytes)}
        {dataset.quotaBytes > 0 && ` ${t("cp.zfs.ofQuota", { quota: formatBytes(dataset.quotaBytes) })}`}
      </span>
      <Button variant="ghost" className="h-6 px-1.5 text-[11px]" loading={busy === `quota-${dataset.name}`} onClick={() => void setQuota()}>
        {t("cp.zfs.quota")}
      </Button>
      <Button
        variant="ghost"
        className="h-6 px-1.5 text-[11px] text-rose-600 hover:bg-rose-50"
        loading={busy === `dsdel-${dataset.name}`}
        onClick={() => void destroy()}
      >
        {t("common.delete")}
      </Button>
    </div>
  );
}

function Snapshots({
  pool,
  datasets,
  busy,
  act,
}: {
  pool: string;
  datasets: string[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const t = useT();
  const [snaps, setSnaps] = useState<ZfsSnapshot[] | null>(null);
  const targets = datasets.filter((d) => d !== pool);

  const load = useCallback(async () => {
    const all = await Promise.all(
      targets.map((d) =>
        api
          .get<ZfsSnapshotsResponse>(`/admin/zfs/snapshots?dataset=${encodeURIComponent(d)}`)
          .then((r) => r.snapshots)
          .catch(() => []),
      ),
    );
    setSnaps(all.flat());
    // targets is derived from props each render; the join keeps the identity stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.join(",")]);

  useEffect(() => {
    void load();
  }, [load]);

  if (targets.length === 0) {
    return (
      <p className="mt-2 rounded-lg bg-white px-3 py-2 text-[11px] text-ink-faint ring-1 ring-slate-200/70">
        {t("cp.zfs.snapshotsNeedDataset")}
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-lg bg-white p-2.5 ring-1 ring-slate-200/70">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-soft">{t("cp.zfs.snapshots")}</span>
        {targets.map((d) => (
          <Button
            key={d}
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            loading={busy === `snap-${d}`}
            onClick={() =>
              void act(
                `snap-${d}`,
                () =>
                  api.post("/admin/zfs/snapshots", {
                    dataset: d,
                    // A name someone can read six months later, and one that sorts.
                    name: new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"),
                  }),
                t("cp.zfs.snapshotTaken"),
              ).then(load)
            }
          >
            <Camera size={11} /> {d.split("/").pop()}
          </Button>
        ))}
      </div>
      {snaps === null ? (
        <p className="text-[11px] text-ink-faint">{t("desktop.loading")}</p>
      ) : snaps.length === 0 ? (
        <p className="text-[11px] text-ink-faint">{t("cp.zfs.noSnapshots")}</p>
      ) : (
        <ul className="space-y-1">
          {snaps.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{s.name}</span>
              <span className="text-ink-faint">{formatBytes(s.usedBytes)}</span>
              <span className="text-ink-faint">{new Date(s.createdAt).toLocaleString()}</span>
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: t("cp.zfs.rollbackTitle", { dataset: s.dataset, snapshot: s.snapshot }),
                      message: t("cp.zfs.rollbackMessage"),
                      confirmLabel: t("cp.zfs.rollBack"),
                      danger: true,
                    }))
                  )
                    return;
                  await act(`rb-${s.name}`, () => api.post("/admin/zfs/snapshots/rollback", { name: s.name }), t("cp.zfs.rolledBack"));
                  await load();
                }}
              >
                <RotateCcw size={11} /> {t("cp.zfs.rollBack")}
              </Button>
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px] text-rose-600 hover:bg-rose-50"
                onClick={async () => {
                  await act(`sd-${s.name}`, () => api.del(`/admin/zfs/snapshots?name=${encodeURIComponent(s.name)}`));
                  await load();
                }}
              >
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PoolCreate({
  disks,
  layouts,
  raidzExpansion,
  onCreated,
}: {
  disks: StorageDisk[];
  layouts: ZfsLayoutInfo[];
  raidzExpansion: boolean;
  onCreated: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("tank");
  const [layout, setLayout] = useState("raidz2");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  const def = layouts.find((l) => l.id === layout) ?? layouts[0]!;
  const count = selected.size;
  const enough = count >= def.minDisks;
  const isRaidz = layout.startsWith("raidz");

  // Usable capacity, the way someone counting disks expects it.
  const smallest = Math.min(...[...selected].map((n) => disks.find((d) => d.name === n)?.sizeBytes ?? 0), Infinity);
  const parity = layout === "mirror" ? count - 1 : layout === "stripe" ? 0 : Number(layout.slice(-1));
  const usable = Number.isFinite(smallest) && count > 0 ? smallest * Math.max(0, count - parity) : 0;

  async function create() {
    const members = [...selected];
    if (
      !(await confirmDialog({
        title: t("cp.zfs.createTitle", { name, count: members.length }),
        message:
          t("cp.zfs.createErases", { disks: members.map((d) => d.replace("/dev/", "")).join(", ") }) +
          " " +
          (def.faultTolerance === 0
            ? t("cp.zfs.noRedundancy")
            : t("cp.zfs.survives", { count: def.faultTolerance })),
        confirmLabel: t("cp.zfs.eraseAndCreate"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.post("/admin/zfs/pools", { name: name.trim(), layout, disks: members });
      push({ level: "success", title: t("cp.zfs.poolCreated"), body: t("cp.zfs.poolReady", { name }) });
      setOpen(false);
      setSelected(new Set());
      await onCreated();
    } catch (err) {
      push({
        level: "warning",
        title: t("cp.zfs.createFailed"),
        body: err instanceof ApiRequestError ? err.message : t("cp.failed"),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setOpen(true)}>
        <Plus size={13} /> {t("cp.zfs.createPool")}
      </Button>
    );
  }

  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">{t("cp.zfs.poolName")}</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" placeholder="tank" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-soft">{t("cp.zfs.layout")}</label>
          <Select value={layout} onChange={(e) => setLayout(e.target.value)} className="h-8 w-full py-0 text-xs">
            {layouts.map((l) => (
              <option key={l.id} value={l.id}>
                {t("cp.zfs.layoutOption", { name: l.name, min: l.minDisks })}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p className="mb-2 text-[11px] text-ink-faint">{def.note}</p>

      {/*
        Said here, while the choice is still being made. A raidz pool that cannot
        take another disk is the thing people discover when they are already full,
        and by then the only fix is to rebuild the pool from a backup.
      */}
      {isRaidz && !raidzExpansion && (
        <p className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {t("cp.zfs.raidzWarning")}
          </span>
        </p>
      )}

      <div className="mb-2 grid gap-1 sm:grid-cols-2">
        {disks.map((d) => (
          <label
            key={d.name}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ink-soft hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selected.has(d.name)}
              onChange={(e) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(d.name);
                  else next.delete(d.name);
                  return next;
                })
              }
              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="font-mono">{d.name.replace("/dev/", "")}</span>
            <span className="text-ink-faint">{formatBytes(d.sizeBytes)}</span>
            <span className="truncate text-ink-faint">{d.model}</span>
          </label>
        ))}
      </div>

      <p className="mb-2 text-[11px] text-ink-faint">
        {t("cp.zfs.selected", { selected: count })}
        {!enough && ` - ${t("cp.zfs.needsAtLeast", { name: def.name, min: def.minDisks })}`}
        {enough && usable > 0 && ` - ${t("cp.zfs.usable", { size: formatBytes(usable), count: def.faultTolerance })}`}
      </p>

      <div className="flex items-center gap-2">
        <Button className="h-8 px-3 text-xs" disabled={!enough || !name.trim()} loading={busy} onClick={() => void create()}>
          {t("common.create")}
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
