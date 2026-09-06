import { useEffect, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { HardDrive, RefreshCw, Cpu, FolderCog, Layers, ShieldAlert, ShieldCheck, Thermometer } from "lucide-react";
import type { RaidArray, RaidResponse, SmartInfo, StorageDisk, StorageLocationsResponse, StorageResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { formatBytes } from "../../../lib/format.ts";
import { Button, Input, Select } from "../../ui/controls.tsx";
import { Zfs } from "./Zfs.tsx";

const STATE_BADGE: Record<StorageDisk["state"], { label: string; cls: string }> = {
  system: { label: "System", cls: "bg-brand-100 text-brand-700" },
  data: { label: "In use", cls: "bg-emerald-50 text-emerald-700" },
  unconfigured: { label: "Unconfigured", cls: "bg-amber-50 text-amber-700" },
};

function isDegraded(a: RaidArray): boolean {
  return a.state === "degraded" || a.activeDevices < a.totalDevices;
}

export function Storage() {
  const [disks, setDisks] = useState<StorageDisk[] | null>(null);
  const [raid, setRaid] = useState<RaidArray[]>([]);
  const [loading, setLoading] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        api.get<StorageResponse>("/admin/storage"),
        api.get<RaidResponse>("/admin/storage/raid").catch(() => ({ arrays: [] as RaidArray[] })),
      ]);
      setDisks(s.disks);
      setRaid(r.arrays);
      // Surface failing hardware (deduped per disk/array so it doesn't spam).
      for (const d of s.disks) {
        if (d.smart?.status === "failed") {
          push({ level: "critical", title: "Disk health alert", body: `${d.model || d.name} reports SMART FAILED - back up and replace it soon.` }, `smart-fail-${d.name}`);
        }
      }
      for (const a of r.arrays.filter(isDegraded)) {
        push({ level: "warning", title: "RAID array degraded", body: `${a.name} (${a.level}) is ${a.state}.` }, `raid-degraded-${a.name}`);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const unconfigured = disks?.filter((d) => d.state === "unconfigured") ?? [];

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Storage</h2>
          <p className="text-sm text-ink-faint">Physical disks, health and RAID. Initialize a new disk to use it for storage.</p>
        </div>
        <button onClick={() => void load()} className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Refresh">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <AppDataLocations />

      {raid.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-ink-soft">RAID arrays</h3>
          <div className="space-y-2">
            {raid.map((a) => <RaidCard key={a.name} array={a} spareDisks={unconfigured} onChanged={load} />)}
          </div>
        </div>
      )}

      {unconfigured.length >= 2 && <RaidCreate disks={unconfigured} onChanged={load} />}

      {/*
        ZFS sits below mdadm rather than replacing it. Both are legitimate: mdadm
        is simpler and works on any kernel, ZFS checksums and self-heals. The
        panel shows itself only where ZFS is actually usable, so a machine
        without it never sees an option it can't take.
      */}
      <Zfs disks={disks ?? []} onChanged={load} />

      {raid.length > 0 && <h3 className="mb-2 text-sm font-semibold text-ink-soft">Disks</h3>}
      <div className="space-y-2.5">
        {disks === null && <p className="text-sm text-ink-faint">Loading disks...</p>}
        {disks?.length === 0 && <p className="text-sm text-ink-faint">No disks detected.</p>}
        {disks?.map((d) => <DiskCard key={d.name} disk={d} onChanged={load} />)}
      </div>
    </div>
  );
}

const CUSTOM = "__custom__";

/** Map a stored base path (or null) to the select value + custom-input value. */
function pickFor(path: string | null, volumePaths: string[]): { sel: string; custom: string } {
  if (path == null) return { sel: "", custom: "" };
  if (volumePaths.includes(path)) return { sel: path, custom: "" };
  return { sel: CUSTOM, custom: path };
}

/** Admin-relocatable base directories for VM + container data. */
function AppDataLocations() {
  const [data, setData] = useState<StorageLocationsResponse | null>(null);
  const [vm, setVm] = useState({ sel: "", custom: "" });
  const [containers, setContainers] = useState({ sel: "", custom: "" });
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    const res = await api.get<StorageLocationsResponse>("/admin/storage/locations");
    const volPaths = res.volumes.map((v) => v.path);
    setData(res);
    setVm(pickFor(res.locations.vm, volPaths));
    setContainers(pickFor(res.locations.containers, volPaths));
  }
  useEffect(() => { void load(); }, []);

  if (!data) return null;

  const resolve = (s: { sel: string; custom: string }): string | null =>
    s.sel === "" ? null : s.sel === CUSTOM ? s.custom.trim() : s.sel;

  async function save() {
    setBusy(true);
    try {
      const res = await api.put<StorageLocationsResponse>("/admin/storage/locations", {
        vm: resolve(vm),
        containers: resolve(containers),
      });
      const volPaths = res.volumes.map((v) => v.path);
      setData(res);
      setVm(pickFor(res.locations.vm, volPaths));
      setContainers(pickFor(res.locations.containers, volPaths));
      push({ level: "success", title: "Storage locations saved", body: "New VMs and containers will be placed here." });
    } catch (err) {
      push({ level: "warning", title: "Couldn't save locations", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    resolve(vm) !== data.locations.vm || resolve(containers) !== data.locations.containers;

  return (
    <div className="mb-5 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-1 flex items-center gap-2">
        <FolderCog size={16} className="text-ink-soft" />
        <h3 className="text-sm font-semibold text-ink-soft">Application data location</h3>
      </div>
      <p className="mb-3 text-xs text-ink-faint">
        Choose where new <strong>VM disks &amp; ISOs</strong> and <strong>container volumes &amp; stacks</strong> are stored - keep them on a roomy data volume instead of the system disk. Changes apply to newly created items; existing ones stay where they are.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <LocationField
          label="Virtual machines"
          value={vm}
          onChange={setVm}
          volumes={data.volumes}
          defaultPath={data.defaults.vm}
          subdirs="disks/, iso/"
        />
        <LocationField
          label="Containers"
          value={containers}
          onChange={setContainers}
          volumes={data.volumes}
          defaultPath={data.defaults.containers}
          subdirs="services/, stacks/"
        />
      </div>
      <div className="mt-3 flex justify-end">
        <Button className="h-9 px-4 text-sm" loading={busy} disabled={!dirty} onClick={save}>Save locations</Button>
      </div>
    </div>
  );
}

function LocationField({
  label,
  value,
  onChange,
  volumes,
  defaultPath,
  subdirs,
}: {
  label: string;
  value: { sel: string; custom: string };
  onChange: (v: { sel: string; custom: string }) => void;
  volumes: { label: string; path: string }[];
  defaultPath: string;
  subdirs: string;
}) {
  const base = value.sel === "" ? defaultPath : value.sel === CUSTOM ? value.custom.trim() || "..." : value.sel;
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-soft">{label}</span>
      <Select value={value.sel} onChange={(e) => onChange({ ...value, sel: e.target.value })} className="w-full">
        <option value="">Default ({defaultPath})</option>
        {volumes.map((v) => (
          <option key={v.path} value={v.path}>{v.label} - {v.path}</option>
        ))}
        <option value={CUSTOM}>Custom path...</option>
      </Select>
      {value.sel === CUSTOM && (
        <Input
          className="mt-2"
          value={value.custom}
          onChange={(e) => onChange({ ...value, custom: e.target.value })}
          placeholder="/mnt/pool/opennas"
        />
      )}
      <span className="mt-1 block text-[11px] text-ink-faint">Creates {subdirs} under <span className="font-mono">{base}</span></span>
    </label>
  );
}

const MEMBER_DOT: Record<RaidArray["members"][number]["state"], string> = {
  active: "bg-emerald-500",
  spare: "bg-slate-400",
  faulty: "bg-rose-500",
};

function RaidCard({ array, spareDisks, onChanged }: { array: RaidArray; spareDisks: StorageDisk[]; onChanged: () => Promise<void> }) {
  const degraded = isDegraded(array);
  const syncing = array.syncPercent != null;
  const [busy, setBusy] = useState<string | null>(null);
  const [addDisk, setAddDisk] = useState("");
  const push = useNotifications((s) => s.push);
  const md = array.name.replace("/dev/", ""); // e.g. md0

  async function run(key: string, fn: () => Promise<void>, okTitle: string, failTitle: string) {
    setBusy(key);
    try {
      await fn();
      push({ level: "success", title: okTitle, body: array.name });
      await onChanged();
    } catch (err) {
      push({ level: "warning", title: failTitle, body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!(await confirmDialog({
      title: `Remove array ${array.name}?`,
      message: "The array is stopped and its disks are wiped. All data on the array is permanently lost.",
      confirmLabel: "Remove array",
      danger: true,
    }))) return;
    await run("array", () => api.del(`/admin/storage/raid/${md}`), "RAID array removed", "Couldn't remove array");
  }

  async function dropMember(disk: string) {
    if (!(await confirmDialog({
      title: `Remove ${disk.replace("/dev/", "")} from ${array.name}?`,
      message: "The disk is failed, removed and wiped. The array keeps running on the rest - add a replacement afterwards.",
      confirmLabel: "Remove member",
      danger: true,
    }))) return;
    await run(`rm-${disk}`, () => api.post(`/admin/storage/raid/${md}/remove`, { disk }), "Member removed", "Couldn't remove member");
  }

  async function add() {
    const disk = addDisk;
    if (!disk) return;
    if (!(await confirmDialog({
      title: `Add ${disk.replace("/dev/", "")} to ${array.name}?`,
      message: degraded ? "The disk is wiped and added - the array rebuilds onto it automatically." : "The disk is wiped and added as a spare. All existing data on it is lost.",
      confirmLabel: "Erase & add",
      danger: true,
    }))) return;
    setAddDisk("");
    await run("add", () => api.post(`/admin/storage/raid/${md}/add`, { disk }), "Disk added to array", "Couldn't add disk");
  }

  return (
    <div className="rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-400 to-violet-600 text-white">
          <Layers size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-soft">{array.name}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase text-ink-soft">{array.level}</span>
            <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-medium",
              degraded ? "bg-amber-50 text-amber-700" : syncing ? "bg-brand-100 text-brand-700" : "bg-emerald-50 text-emerald-700")}>
              {degraded ? `Degraded - ${array.state}` : syncing ? array.state : "Healthy"}
            </span>
          </div>
          <div className="text-xs text-ink-faint">
            {array.activeDevices}/{array.totalDevices} devices{array.sizeBytes ? ` - ${formatBytes(array.sizeBytes)}` : ""}
          </div>
        </div>
        <button onClick={remove} disabled={busy !== null} className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50" title="Remove array">
          {busy === "array" ? "..." : "Remove"}
        </button>
      </div>

      {/* Member chips - faulty ones get a remove action. */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {array.members.map((m) => (
          <span key={m.name} className="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-[11px] ring-1 ring-slate-200/70">
            <span className={clsx("h-2 w-2 rounded-full", MEMBER_DOT[m.state])} />
            <span className="font-mono text-ink-soft">{m.name.replace("/dev/", "")}</span>
            {m.state !== "active" && <span className="text-ink-faint capitalize">{m.state}</span>}
            <button
              onClick={() => void dropMember(m.name)}
              disabled={busy !== null}
              className="ml-0.5 text-slate-400 transition hover:text-rose-500 disabled:opacity-50"
              title={`Remove ${m.name} from the array`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>

      {/* Add a disk: rebuild a degraded array or add a spare. */}
      {spareDisks.length > 0 && (
        <div className="mt-2.5 flex items-center gap-2">
          <Select value={addDisk} onChange={(e) => setAddDisk(e.target.value)} className="h-8 flex-1 text-xs">
            <option value="">{degraded ? "Rebuild with a disk..." : "Add a spare disk..."}</option>
            {spareDisks.map((d) => (
              <option key={d.name} value={d.name}>{d.name.replace("/dev/", "")} - {formatBytes(d.sizeBytes)}</option>
            ))}
          </Select>
          <Button variant="secondary" className="h-8 px-2.5 text-xs" loading={busy === "add"} disabled={!addDisk} onClick={add}>
            {degraded ? "Rebuild" : "Add"}
          </Button>
        </div>
      )}

      {syncing && (
        <div className="mt-2.5">
          <div className="mb-1 flex justify-between text-[11px] text-ink-faint">
            <span className="capitalize">{array.state}...</span>
            <span>{array.syncPercent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${array.syncPercent}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

const RAID_LEVELS = [
  { id: "raid1", name: "RAID 1 - mirror", min: 2, note: "Mirrored copy - survives 1 disk failure." },
  { id: "raid0", name: "RAID 0 - stripe", min: 2, note: "No redundancy - max capacity & speed." },
  { id: "raid5", name: "RAID 5 - single parity", min: 3, note: "Survives 1 disk failure." },
  { id: "raid6", name: "RAID 6 - double parity", min: 4, note: "Survives 2 disk failures." },
  { id: "raid10", name: "RAID 10 - striped mirror", min: 4, note: "Fast and redundant (even disk count)." },
] as const;

/** Build a RAID array from the unconfigured disks. */
function RaidCreate({ disks, onChanged }: { disks: StorageDisk[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<string>("raid1");
  const [label, setLabel] = useState("raid1");
  const [fsType, setFsType] = useState("ext4");
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  const count = selected.size;
  const levelDef = RAID_LEVELS.find((l) => l.id === level)!;
  const enoughDisks = count >= levelDef.min;
  const canCreate = enoughDisks && label.trim().length > 0 && !busy;

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  async function create() {
    const members = [...selected];
    if (!(await confirmDialog({
      title: `Create ${levelDef.name.split(" - ")[0]} from ${members.length} disks?`,
      message: `This ERASES ${members.map((d) => d.replace("/dev/", "")).join(", ")} and builds the array. All existing data on those disks is lost.`,
      confirmLabel: "Erase & create",
      danger: true,
    }))) return;
    setBusy(true);
    try {
      await api.post("/admin/storage/raid", { level, label: label.trim(), fsType, disks: members });
      push({ level: "success", title: "RAID array created", body: `${levelDef.name} → ${label.trim()}` });
      setOpen(false);
      setSelected(new Set());
      await onChanged();
    } catch (err) {
      push({ level: "warning", title: "Couldn't create array", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-5">
        <Button variant="secondary" className="h-9 text-sm" onClick={() => setOpen(true)}>
          <Layers size={15} /> Create RAID array
        </Button>
        <p className="mt-1.5 text-[11px] text-ink-faint">{disks.length} unconfigured disks available to pool.</p>
      </div>
    );
  }

  return (
    <div className="mb-5 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-2">
        <Layers size={16} className="text-ink-soft" />
        <h3 className="flex-1 text-sm font-semibold text-ink-soft">Create RAID array</h3>
        <button onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink-soft">Cancel</button>
      </div>

      <div>
        <span className="mb-1.5 block text-xs font-medium text-ink-soft">Member disks ({count} selected)</span>
        <div className="space-y-1.5">
          {disks.map((d) => (
            <label key={d.name} className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-200/70">
              <input type="checkbox" checked={selected.has(d.name)} onChange={() => toggle(d.name)} className="h-4 w-4 accent-brand-600" />
              <span className="font-mono text-ink-soft">{d.name.replace("/dev/", "")}</span>
              <span className="text-ink-faint">{d.model || (d.rotational ? "HDD" : "SSD")}</span>
              <span className="ml-auto text-ink-faint">{formatBytes(d.sizeBytes)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">Level</span>
          <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-full">
            {RAID_LEVELS.map((l) => (
              <option key={l.id} value={l.id} disabled={count > 0 && count < l.min}>
                {l.name} (min {l.min})
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">Filesystem</span>
          <Select value={fsType} onChange={(e) => setFsType(e.target.value)} className="w-full">
            <option value="ext4">ext4</option>
            <option value="btrfs">Btrfs</option>
            <option value="xfs">XFS</option>
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">Volume label</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="raid1" />
        </label>
      </div>

      <p className="text-[11px] text-ink-faint">{levelDef.note}</p>
      {!enoughDisks && count > 0 && (
        <p className="text-[11px] text-amber-600">{levelDef.name.split(" - ")[0]} needs at least {levelDef.min} disks - {count} selected.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-9 text-sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="danger" className="h-9 text-sm" loading={busy} disabled={!canCreate} onClick={create}>Erase &amp; create</Button>
      </div>
    </div>
  );
}

const VOL_PREFIX = "/var/lib/opennas/volumes/";

/** The managed-volume label for a partition, or null if it isn't one. */
function volumeLabel(disk: StorageDisk, p: StorageDisk["partitions"][number]): string | null {
  if (p.mountpoint?.startsWith(VOL_PREFIX)) return p.mountpoint.slice(VOL_PREFIX.length);
  if (disk.state === "data" && p.label && p.fsType && !p.mountpoint) return p.label;
  return null;
}

function DiskCard({ disk, onChanged }: { disk: StorageDisk; onChanged: () => Promise<void> }) {
  const [initOpen, setInitOpen] = useState(false);
  const [expandOpen, setExpandOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);
  const badge = STATE_BADGE[disk.state];

  async function volAction(label: string, op: "mount" | "unmount" | "erase") {
    if (op === "erase" && !(await confirmDialog({
      title: `Erase volume "${label}"?`,
      message: "This destroys all data on the volume. This can't be undone.",
      confirmLabel: "Erase",
      danger: true,
    }))) return;
    setBusy(`${label}:${op}`);
    try {
      await api.post(`/admin/storage/volume/${label}/${op}`);
      push({ level: "success", title: `Volume ${op === "unmount" ? "unmounted" : op === "mount" ? "mounted" : "erased"}`, body: label });
      await onChanged();
    } catch (err) {
      push({ level: "warning", title: `Couldn't ${op} volume`, body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3 p-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-slate-500 to-slate-700 text-white">
          <HardDrive size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink-soft">{disk.model || disk.name}</span>
            <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-medium", badge.cls)}>{badge.label}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">{disk.rotational ? "HDD" : "SSD"}</span>
            {disk.removable && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">Removable</span>}
          </div>
          <div className="text-xs text-ink-faint">
            {disk.name} - {formatBytes(disk.sizeBytes)}{disk.serial ? ` - SN ${disk.serial}` : ""}
          </div>
          {disk.smart && <SmartRow smart={disk.smart} />}
        </div>
        {disk.state === "unconfigured" && (
          <Button className="h-8 px-3 py-0 text-xs" onClick={() => setInitOpen((o) => !o)}>Initialize</Button>
        )}
        {/* Free space is claimable on ANY disk, including the one holding the OS -
            on a single-disk machine that's the only place a volume can come from. */}
        {hasClaimableSpace(disk) && (
          <Button
            variant={disk.state === "unconfigured" ? "secondary" : "primary"}
            className="h-8 px-3 py-0 text-xs"
            onClick={() => setExpandOpen((o) => !o)}
          >
            Use free space
          </Button>
        )}
      </div>

      {disk.partitions.length > 0 && (
        <div className="border-t border-slate-200 bg-white px-4 py-2">
          {disk.partitions.map((p) => {
            const vol = volumeLabel(disk, p);
            const usage = p.usedBytes != null && p.freeBytes != null ? usagePct(p.usedBytes, p.freeBytes) : null;
            return (
              <div key={p.name} className="py-1 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-ink-soft">{p.name}</span>
                  <span className="flex items-center gap-2 text-ink-faint">
                    <span>
                      {usage != null ? `${formatBytes(p.usedBytes!)} / ${formatBytes(p.usedBytes! + p.freeBytes!)}` : formatBytes(p.sizeBytes)}
                      {p.fsType ? ` - ${p.fsType}` : " - unformatted"}
                      {p.mountpoint ? ` - ${p.mountpoint}` : ""}
                    </span>
                    {vol && (
                      <span className="flex items-center gap-1">
                        {p.mountpoint ? (
                          <VolBtn busy={busy === `${vol}:unmount`} onClick={() => volAction(vol, "unmount")}>Unmount</VolBtn>
                        ) : (
                          <VolBtn busy={busy === `${vol}:mount`} onClick={() => volAction(vol, "mount")}>Mount</VolBtn>
                        )}
                        <VolBtn danger busy={busy === `${vol}:erase`} onClick={() => volAction(vol, "erase")}>Erase</VolBtn>
                      </span>
                    )}
                  </span>
                </div>
                {usage != null && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={clsx("h-full", usage > 90 ? "bg-rose-500" : usage > 75 ? "bg-amber-500" : "bg-brand-500")}
                      style={{ width: `${usage}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasClaimableSpace(disk) && !expandOpen && (
        <div className="border-t border-slate-200 bg-white px-4 py-2 text-xs text-ink-faint">
          <span className="font-medium text-brand-700">{formatBytes(disk.unallocatedBytes!)}</span> unallocated -
          can be turned into a data volume without touching the partitions already on this disk.
        </div>
      )}

      {initOpen && disk.state === "unconfigured" && (
        <InitForm disk={disk} onDone={async () => { setInitOpen(false); await onChanged(); }} />
      )}

      {expandOpen && (
        <ExpandForm disk={disk} onDone={async () => { setExpandOpen(false); await onChanged(); }} />
      )}
    </div>
  );
}

function usagePct(used: number, free: number): number {
  const total = used + free;
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

function formatPoweredOn(hours: number): string {
  return hours >= 8760 ? `${(hours / 8760).toFixed(1)} yr powered on` : `${hours.toLocaleString()} h powered on`;
}

function SmartRow({ smart }: { smart: SmartInfo }) {
  const ok = smart.status === "passed";
  const bad = smart.status === "failed";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <span className={clsx("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium",
        bad ? "bg-rose-50 text-rose-700" : ok ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-ink-faint")}>
        {bad ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
        {bad ? "SMART FAILED" : ok ? "SMART OK" : "SMART n/a"}
      </span>
      {smart.temperatureC != null && (
        <span className="inline-flex items-center gap-1 text-ink-faint"><Thermometer size={11} />{smart.temperatureC}°C</span>
      )}
      {smart.powerOnHours != null && <span className="text-ink-faint">{formatPoweredOn(smart.powerOnHours)}</span>}
      {smart.reallocatedSectors != null && smart.reallocatedSectors > 0 && (
        <span className="font-medium text-amber-700">{smart.reallocatedSectors} reallocated</span>
      )}
    </div>
  );
}

function VolBtn({ children, onClick, busy, danger }: { children: ReactNode; onClick: () => void; busy?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={clsx(
        "rounded px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50",
        danger ? "text-rose-600 hover:bg-rose-50" : "text-brand-600 hover:bg-brand-50",
      )}
    >
      {busy ? "..." : children}
    </button>
  );
}

/**
 * Enough unallocated space to be worth a volume. Below a gigabyte it's almost
 * always GPT alignment slack rather than space someone meant to leave, and the
 * privileged helper refuses it anyway - so don't offer it.
 */
function hasClaimableSpace(disk: StorageDisk): boolean {
  return disk.unallocatedBytes !== null && disk.unallocatedBytes >= 1024 * 1024 * 1024;
}

/**
 * Claim a disk's free space as a data volume. Unlike Initialize this is
 * non-destructive - it appends a partition to space no partition claims - so it
 * is offered on the system disk too, and asks for no scary confirmation.
 */
function ExpandForm({ disk, onDone }: { disk: StorageDisk; onDone: () => Promise<void> }) {
  const [fsType, setFsType] = useState("ext4");
  const [label, setLabel] = useState("data");
  const [useAll, setUseAll] = useState(true);
  const [size, setSize] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/admin/storage/expand", {
        disk: disk.name,
        fsType,
        label,
        ...(useAll || !size.trim() ? {} : { size: size.trim() }),
      });
      push({
        level: "success",
        title: "Data volume created",
        body: `Mounted at /var/lib/opennas/volumes/${label}. Shares, VMs and containers can use it now.`,
      });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not create the volume.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-slate-200 bg-white p-4">
      <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 ring-1 ring-brand-200">
        Creates a new partition in the {formatBytes(disk.unallocatedBytes!)} of unallocated space on {disk.name}.
        Existing partitions - including the system - are left exactly as they are.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">Filesystem</span>
          <Select value={fsType} onChange={(e) => setFsType(e.target.value)} className="w-full">
            <option value="ext4">ext4</option>
            <option value="btrfs">Btrfs</option>
            <option value="xfs">XFS</option>
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">Volume label</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="data" />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={useAll}
          onChange={(e) => setUseAll(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        Use all {formatBytes(disk.unallocatedBytes!)}
      </label>
      {!useAll && (
        <label className="block max-w-xs">
          <span className="mb-1 block text-sm font-medium text-ink-soft">Size</span>
          <Input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 500G" />
          <span className="mt-1 block text-xs text-ink-faint">A number followed by G or M.</span>
        </label>
      )}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex gap-2">
        <Button loading={busy} onClick={submit}>Create data volume</Button>
        <Button variant="ghost" onClick={() => void onDone()}>Cancel</Button>
      </div>
    </div>
  );
}

function InitForm({ disk, onDone }: { disk: StorageDisk; onDone: () => Promise<void> }) {
  const [fsType, setFsType] = useState("ext4");
  const [label, setLabel] = useState("volume1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  async function submit() {
    if (!(await confirmDialog({
      title: `Erase and format ${disk.name}?`,
      message: `This wipes the disk and formats it as ${fsType}. All existing data on it is lost.`,
      confirmLabel: "Erase & format",
      danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/admin/storage/init", { disk: disk.name, fsType, label });
      push({ level: "success", title: "Disk initialized", body: `${disk.name} is now mounted at /var/lib/opennas/volumes/${label}.` });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Initialization failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-slate-200 bg-white p-4">
      <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
        <Cpu size={14} /> This will erase all data on {disk.name}.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">Filesystem</span>
          <Select value={fsType} onChange={(e) => setFsType(e.target.value)} className="w-full">
            <option value="ext4">ext4</option>
            <option value="btrfs">Btrfs</option>
            <option value="xfs">XFS</option>
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-soft">Volume label</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="volume1" />
        </label>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex gap-2">
        <Button variant="danger" loading={busy} onClick={submit}>Erase &amp; initialize</Button>
        <Button variant="ghost" onClick={() => void onDone()}>Cancel</Button>
      </div>
    </div>
  );
}
