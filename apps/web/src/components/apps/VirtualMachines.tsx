import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  ChevronDown,
  Cable,
  Camera,
  Cpu,
  Disc3,
  HardDrive,
  MemoryStick,
  Monitor,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  } from "lucide-react";
import type { CreateVmRequest, IsoFile, IsosResponse, VirtStatus, VmAction, VmInfo } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../lib/api.ts";
import { formatBytes } from "../../lib/format.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { Button, Field, Input } from "../ui/controls.tsx";
import { StorageTargetField } from "../ui/StorageTargetField.tsx";
import { VirtNetworks } from "./vms/VirtNetworks.tsx";
import { VmDevices } from "./vms/VmDevices.tsx";
import { VmSnapshots } from "./vms/VmSnapshots.tsx";
import { useT } from "../../i18n/index.ts";
import { fillNodes } from "./vms/VirtNetworks.tsx";

// noVNC is heavy and only needed when a console is opened - load it on demand so
// it lands in its own chunk, out of the main bundle.
const VmConsole = lazy(() => import("./VmConsole.tsx").then((m) => ({ default: m.VmConsole })));

const STATE_DOT: Record<VmInfo["state"], string> = {
  running: "bg-emerald-500",
  paused: "bg-amber-500",
  shutoff: "bg-slate-400",
  crashed: "bg-rose-500",
  other: "bg-slate-400",
};

const STATE_LABEL = {
  running: "app.vms.stateRunning",
  paused: "app.vms.statePaused",
  shutoff: "app.vms.stateShutoff",
  crashed: "app.vms.stateCrashed",
  other: "app.vms.stateOther",
} as const satisfies Record<VmInfo["state"], string>;

const ACTION_DONE = {
  start: "app.vms.started",
  shutdown: "app.vms.shuttingDown",
  reboot: "app.vms.rebooting",
  destroy: "app.vms.forcedOff",
  suspend: "app.vms.suspended",
  resume: "app.vms.resumed",
} as const satisfies Record<VmAction, string>;

const ACTION_FAILED = {
  start: "app.vms.startFailed",
  shutdown: "app.vms.shutdownFailed",
  reboot: "app.vms.rebootFailed",
  destroy: "app.vms.forceOffFailed",
  suspend: "app.vms.suspendFailed",
  resume: "app.vms.resumeFailed",
} as const satisfies Record<VmAction, string>;

export function VirtualMachines() {
  const [virt, setVirt] = useState<VirtStatus | null>(null);
  const [isos, setIsos] = useState<IsoFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [consoleVm, setConsoleVm] = useState<VmInfo | null>(null);
  const push = useNotifications((s) => s.push);
  const t = useT();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ virt: VirtStatus }>("/vms");
      setVirt(res.virt);
      if (res.virt.available) {
        const iso = await api.get<IsosResponse>("/vms/isos").catch(() => ({ isos: [] }));
        setIsos(iso.isos);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(vm: VmInfo, action: VmAction) {
    if (action === "destroy" && !(await confirmDialog({ title: t("app.vms.forceOffConfirm", { name: vm.name }), message: t("app.vms.forceOffConfirmBody"), confirmLabel: t("app.vms.forceOff"), danger: true }))) return;
    try {
      await api.post(`/vms/${vm.name}/${action}`);
      push({ level: "success", title: t(ACTION_DONE[action]), body: vm.name });
      await load();
    } catch (err) {
      push({ level: "warning", title: t(ACTION_FAILED[action]), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    }
  }

  async function removeVm(vm: VmInfo) {
    const ok = await confirmDialog({
      title: t("app.vms.deleteConfirm", { name: vm.name }),
      message: t("app.vms.deleteConfirmBody"),
      confirmLabel: t("app.vms.deleteWithDisk"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/vms/${vm.name}?disk=1`);
      push({ level: "success", title: t("app.vms.deleted"), body: vm.name });
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.deleteFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
        <MonitorPlay size={20} className="text-ink-soft" />
        <h2 className="flex-1 font-semibold text-ink">{t("app.vms.title")}</h2>
        {virt?.available && (
          <Button variant="secondary" className="h-8 px-2.5 text-xs" onClick={() => setShowCreate((v) => !v)}>
            <Plus size={14} /> {t("app.vms.newVm")}
          </Button>
        )}
        <button onClick={() => void load()} className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title={t("desktop.refresh")}>
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-5">
        {virt === null ? (
          <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>
        ) : !virt.available ? (
          <Notice title={t("app.vms.notAvailable")} body={t("app.vms.notAvailableBody")} />
        ) : !virt.running ? (
          <Notice title={t("app.vms.notRunning")} body={t("app.vms.notRunningBody")} />
        ) : (
          <div className="space-y-6">
            {!virt.kvm && (
              <div className="rounded-xl bg-amber-50 px-4 py-2.5 text-xs text-amber-800 ring-1 ring-amber-200">
                {t("app.vms.noKvm")}
              </div>
            )}

            {showCreate && (
              <CreateVmForm
                isos={isos}
                onDone={() => { setShowCreate(false); void load(); }}
                onCancel={() => setShowCreate(false)}
                onError={(m) => push({ level: "warning", title: t("app.vms.createFailed"), body: m })}
                onWarning={(m) => push({ level: "info", title: t("app.vms.created"), body: m })}
              />
            )}

            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink-soft">{t("app.vms.machines", { count: virt.vms.length })}</h3>
              {virt.vms.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">{fillNodes(t("app.vms.empty"), { newVm: <strong>{t("app.vms.newVm")}</strong> })}</p>
              ) : (
                <div className="space-y-2">
                  {virt.vms.map((vm) => (
                    <VmCard key={vm.uuid || vm.name} vm={vm} onAction={act} onDelete={() => void removeVm(vm)} onConsole={() => setConsoleVm(vm)} />
                  ))}
                </div>
              )}
            </section>

            <VirtNetworks />

            <IsoLibrary isos={isos} onChanged={load} onError={(m) => push({ level: "warning", title: t("app.vms.isoError"), body: m })} />
          </div>
        )}
      </div>

      {consoleVm && (
        <Suspense fallback={null}>
          <VmConsole vm={consoleVm} onClose={() => setConsoleVm(null)} />
        </Suspense>
      )}
    </div>
  );
}

function VmCard({ vm, onAction, onDelete, onConsole }: { vm: VmInfo; onAction: (vm: VmInfo, a: VmAction) => void; onDelete: () => void; onConsole: () => void }) {
  const t = useT();
  const running = vm.state === "running";
  const paused = vm.state === "paused";
  // Snapshots and passthrough are per-VM and rarely needed, so they stay folded
  // away rather than making every card three times as tall.
  const [open, setOpen] = useState<"snapshots" | "devices" | null>(null);
  return (
    <div className="rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3">
        <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", STATE_DOT[vm.state])} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink-soft">{vm.name}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">{t(STATE_LABEL[vm.state])}</span>
            {vm.autostart && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{t("app.vms.autostart")}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-faint">
            <span className="inline-flex items-center gap-1"><Cpu size={11} /> {vm.vcpus} vCPU</span>
            <span className="inline-flex items-center gap-1"><MemoryStick size={11} /> {vm.memoryMiB} MiB</span>
            {running && vm.vncPort && <span className="inline-flex items-center gap-1"><MonitorPlay size={11} /> VNC :{vm.vncPort - 5900}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {running ? (
            <>
              <IconBtn label={t("app.vms.console")} onClick={onConsole}><Monitor size={15} /></IconBtn>
              <IconBtn label={t("app.vms.suspend")} onClick={() => onAction(vm, "suspend")}><Pause size={15} /></IconBtn>
              <IconBtn label={t("app.vms.reboot")} onClick={() => onAction(vm, "reboot")}><RotateCcw size={15} /></IconBtn>
              <IconBtn label={t("app.vms.shutDown")} onClick={() => onAction(vm, "shutdown")}><Power size={15} /></IconBtn>
            </>
          ) : paused ? (
            <IconBtn label={t("app.vms.resume")} onClick={() => onAction(vm, "resume")}><Play size={15} /></IconBtn>
          ) : (
            <IconBtn label={t("app.vms.start")} onClick={() => onAction(vm, "start")}><Play size={15} /></IconBtn>
          )}
          <IconBtn label={t("app.vms.deleteVm")} danger onClick={onDelete}><Trash2 size={15} /></IconBtn>
        </div>
      </div>

      <div className="mt-2 flex gap-1 border-t border-slate-200/70 pt-2">
        {(["snapshots", "devices"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setOpen(open === tab ? null : tab)}
            className={clsx(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
              open === tab ? "bg-slate-200 text-ink-soft" : "text-ink-faint hover:bg-slate-100",
            )}
          >
            {tab === "snapshots" ? <Camera size={12} /> : <Cable size={12} />}
            {t(tab === "snapshots" ? "app.vms.snapshots" : "app.vms.devices")}
            <ChevronDown size={11} className={clsx("transition", open === tab && "rotate-180")} />
          </button>
        ))}
      </div>

      {open === "snapshots" && <div className="mt-2"><VmSnapshots vm={vm} /></div>}
      {open === "devices" && <div className="mt-2"><VmDevices vm={vm} /></div>}
    </div>
  );
}

function CreateVmForm({
  isos,
  onDone,
  onCancel,
  onError,
  onWarning,
}: {
  isos: IsoFile[];
  onDone: () => void;
  onCancel: () => void;
  onError: (m: string) => void;
  onWarning: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [vcpus, setVcpus] = useState(2);
  const [memoryMiB, setMemoryMiB] = useState(2048);
  const [diskGiB, setDiskGiB] = useState(20);
  const [iso, setIso] = useState("");
  const [volume, setVolume] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();

  async function create() {
    setBusy(true);
    try {
      const body: CreateVmRequest = { name: name.trim(), vcpus, memoryMiB, diskGiB, iso: iso || null, volume: volume || null };
      const res = await api.post<{ ok: boolean; warning?: string }>("/vms", body);
      if (res.warning) onWarning(res.warning);
      onDone();
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : t("common.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <h3 className="text-sm font-semibold text-ink-soft">{t("app.vms.newVmTitle")}</h3>
      <Field label={t("common.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("app.vms.namePlaceholder")} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("app.vms.vcpus")}>
          <Input type="number" min={1} max={64} value={vcpus} onChange={(e) => setVcpus(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={t("app.vms.memoryMib")}>
          <Input type="number" min={256} step={256} value={memoryMiB} onChange={(e) => setMemoryMiB(Math.max(256, Number(e.target.value) || 256))} />
        </Field>
        <Field label={t("app.vms.diskGib")}>
          <Input type="number" min={1} max={8192} value={diskGiB} onChange={(e) => setDiskGiB(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={t("app.vms.bootIso")}>
          <select
            value={iso}
            onChange={(e) => setIso(e.target.value)}
            className="h-[42px] w-full rounded-lg bg-white px-3 text-sm text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">{t("app.vms.noIso")}</option>
            {isos.map((i) => (
              <option key={i.name} value={i.name}>{i.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <StorageTargetField
        value={volume}
        onChange={setVolume}
        label={t("app.vms.diskStorage")}
        hint={t("app.vms.diskStorageHint")}
      />
      <p className="text-[11px] text-ink-faint">{t("app.vms.diskGrows")}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-9 text-sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button className="h-9 text-sm" loading={busy} disabled={!name.trim()} onClick={create}>{t("app.containers.createAndStart")}</Button>
      </div>
    </div>
  );
}

function IsoLibrary({ isos, onChanged, onError }: { isos: IsoFile[]; onChanged: () => Promise<void> | void; onError: (m: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = useT();

  async function upload(file: File) {
    if (!file.name.toLowerCase().endsWith(".iso")) {
      onError(t("app.vms.chooseIso"));
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(apiUrl("/vms/isos"), { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? t("app.vms.uploadFailedStatus", { status: res.status }));
      }
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("app.vms.uploadFailed"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(name: string) {
    if (!(await confirmDialog({ title: t("app.vms.deleteIsoConfirm", { name }), message: t("app.vms.deleteIsoConfirmBody"), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api.del(`/vms/isos/${encodeURIComponent(name)}`);
      await onChanged();
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : t("common.failed"));
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft"><Disc3 size={15} /> {t("app.vms.isoLibrary")}</h3>
        <span className="flex-1" />
        <input ref={fileRef} type="file" accept=".iso" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <Button variant="secondary" className="h-8 px-2.5 text-xs" loading={uploading} onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> {t("app.vms.uploadIso")}
        </Button>
      </div>
      {isos.length === 0 ? (
        <p className="text-sm text-ink-faint">{t("app.vms.noIsos")}</p>
      ) : (
        <div className="space-y-1">
          {isos.map((i) => (
            <div key={i.name} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs ring-1 ring-slate-200/70">
              <HardDrive size={13} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{i.name}</span>
              <span className="shrink-0 text-ink-faint">{formatBytes(i.sizeBytes)}</span>
              <button onClick={() => void remove(i.name)} className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-rose-500 hover:text-white" title={t("app.vms.deleteIso")}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function IconBtn({ children, onClick, label, danger }: { children: React.ReactNode; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={clsx("grid h-7 w-7 place-items-center rounded-md text-slate-400 transition", danger ? "hover:bg-rose-500 hover:text-white" : "hover:bg-slate-200 hover:text-ink-soft")}>
      {children}
    </button>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl bg-slate-50 p-8 text-center ring-1 ring-slate-200/70">
      <MonitorPlay size={32} className="mx-auto mb-3 text-slate-300" />
      <h3 className="font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-sm text-ink-faint">{body}</p>
    </div>
  );
}
