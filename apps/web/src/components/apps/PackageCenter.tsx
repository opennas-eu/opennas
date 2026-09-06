import { useEffect, useMemo, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Blocks, Check, Container, Download, ExternalLink, Package, Play, Search, Square, Trash2 } from "lucide-react";
import type { AppCategory, PackageInfo, PackagesResponse, StorageTargetsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useAuth } from "../../store/auth.ts";
import { useApps } from "../../store/apps.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { ManifestIcon } from "../ui/Icon.tsx";
import { Button, Input } from "../ui/controls.tsx";
import { StorageTargetField } from "../ui/StorageTargetField.tsx";
import { AppCenter } from "./AppCenter.tsx";

const CATEGORIES: (AppCategory | "all")[] = ["all", "utilities", "media", "productivity", "developer"];

type Tab = "packages" | "apps";

export function PackageCenter() {
  const [tab, setTab] = useState<Tab>("packages");
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center gap-1 border-b border-slate-200 px-3 pt-2.5">
        <TabButton active={tab === "packages"} onClick={() => setTab("packages")} icon={<Package size={15} />}>Packages</TabButton>
        <TabButton active={tab === "apps"} onClick={() => setTab("apps")} icon={<Blocks size={15} />}>App Center</TabButton>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "packages" ? <PackagesTab /> : <AppCenter embedded />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active ? "border-brand-600 text-brand-700" : "border-transparent text-ink-faint hover:text-ink-soft",
      )}
    >
      {icon} {children}
    </button>
  );
}

function PackagesTab() {
  const [packages, setPackages] = useState<PackageInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<AppCategory | "all">("all");
  const [working, setWorking] = useState<string | null>(null);
  const isAdmin = useAuth((s) => s.session?.user.role === "admin");
  const reloadApps = useApps((s) => s.load);
  const push = useNotifications((s) => s.push);

  const [dockerRunning, setDockerRunning] = useState(false);
  /** Service package waiting for the admin to pick a storage location. */
  const [choosing, setChoosing] = useState<PackageInfo | null>(null);

  async function load() {
    const res = await api.get<PackagesResponse>("/packages");
    setPackages(res.packages);
    setDockerRunning(res.dockerRunning);
  }
  useEffect(() => { void load(); }, []);

  /**
   * Service packages write persistent data to disk, so they get to ask where -
   * but only when there's more than one place to put it. On a machine with a
   * single location the question has one answer, and one-click stays one-click.
   */
  async function install(p: PackageInfo, volume?: string) {
    if (p.type === "service" && volume === undefined && (await hasStorageChoice())) {
      setChoosing(p);
      return;
    }
    setChoosing(null);
    setWorking(p.id);
    try {
      const res = await api.post<{ status: string }>(`/packages/${p.id}/install`, volume ? { volume } : {});
      await load();
      await reloadApps(); // newly-installed app appears on the desktop
      push({
        level: "success",
        title: `${p.name} installed`,
        body:
          p.type === "app"
            ? "Find it on your desktop and in the app launcher."
            : res.status === "running"
              ? "Container is running."
              : "Tracked as an external service (Docker isn't running).",
        appId: p.type === "app" ? p.id : undefined,
      });
    } catch (err) {
      push({ level: "warning", title: "Install failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setWorking(null);
    }
  }

  async function serviceAction(p: PackageInfo, action: "start" | "stop") {
    setWorking(p.id);
    try {
      await api.post(`/packages/${p.id}/${action}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: `Couldn't ${action}`, body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setWorking(null);
    }
  }

  async function uninstall(p: PackageInfo) {
    if (!(await confirmDialog({ title: `Uninstall ${p.name}?`, confirmLabel: "Uninstall", danger: true }))) return;
    setWorking(p.id);
    try {
      await api.post(`/packages/${p.id}/uninstall`);
      await load();
      await reloadApps();
    } catch (err) {
      push({ level: "warning", title: "Uninstall failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setWorking(null);
    }
  }

  const filtered = useMemo(
    () =>
      (packages ?? []).filter(
        (p) =>
          (cat === "all" || p.category === cat) &&
          (query === "" || `${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [packages, cat, query],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-3 border-b border-slate-200 px-5 py-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search packages" className="pl-9" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={clsx(
                "rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
                cat === c ? "bg-brand-600 text-white" : "bg-slate-100 text-ink-faint hover:bg-slate-200",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </header>

      <div className="opennas-scroll grid min-h-0 flex-1 auto-rows-min gap-3 overflow-auto p-5 sm:grid-cols-2">
        {packages === null && <p className="col-span-full py-10 text-center text-sm text-ink-faint">Loading catalog...</p>}
        {filtered.map((p) => (
          <div key={p.id} className="flex gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
            <div className={clsx("grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white", p.iconGradient)}>
              <ManifestIcon name={p.icon} className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="truncate font-semibold text-ink">{p.name}</h3>
                <span className="shrink-0 text-[11px] text-ink-faint">v{p.version}</span>
              </div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
                <span>{p.publisher}</span>
                {p.requiresDocker && (
                  <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">
                    <Container size={10} /> Docker
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-xs text-ink-faint">{p.description}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {p.installed ? (
                  <>
                    <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
                      p.status === "running" ? "bg-emerald-50 text-emerald-700" : p.status === "stopped" ? "bg-slate-200 text-ink-soft" : "bg-emerald-50 text-emerald-700")}>
                      <Check size={13} /> {p.status === "running" ? "Running" : p.status === "stopped" ? "Stopped" : p.status === "external" ? "Installed (external)" : "Installed"}
                    </span>
                    {p.status === "running" && p.webPort && (
                      <a href={`http://${location.hostname}:${p.webPort}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 transition hover:bg-brand-50">
                        <ExternalLink size={13} /> Open
                      </a>
                    )}
                    {isAdmin && p.type === "service" && p.status === "running" && (
                      <Button variant="ghost" className="h-7 px-2 text-xs" loading={working === p.id} onClick={() => void serviceAction(p, "stop")}><Square size={13} /> Stop</Button>
                    )}
                    {isAdmin && p.type === "service" && p.status === "stopped" && (
                      <Button variant="ghost" className="h-7 px-2 text-xs text-emerald-700" loading={working === p.id} onClick={() => void serviceAction(p, "start")}><Play size={13} /> Start</Button>
                    )}
                    {isAdmin && (
                      <Button variant="ghost" className="h-7 px-2 text-xs text-rose-600 hover:bg-rose-50" loading={working === p.id} onClick={() => void uninstall(p)}>
                        <Trash2 size={13} /> Uninstall
                      </Button>
                    )}
                  </>
                ) : (
                  <Button className="h-8 px-3 py-0 text-xs" disabled={!isAdmin} loading={working === p.id} onClick={() => void install(p)} title={isAdmin ? undefined : "Admins only"}>
                    <Download size={14} /> {p.type === "service" && !dockerRunning && p.requiresDocker ? "Install (Docker off)" : "Install"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
        {packages !== null && filtered.length === 0 && (
          <p className="col-span-full py-10 text-center text-sm text-ink-faint">No packages match your search.</p>
        )}
      </div>

      {!isAdmin && (
        <footer className="border-t border-slate-200 px-5 py-2 text-xs text-ink-faint">Installing packages requires administrator access.</footer>
      )}
      {choosing && (
        <StorageChooser
          pkg={choosing}
          onCancel={() => setChoosing(null)}
          onConfirm={(v) => void install(choosing, v)}
        />
      )}
    </div>
  );
}

/** True when the machine offers more than the default storage location. */
async function hasStorageChoice(): Promise<boolean> {
  try {
    const r = await api.get<StorageTargetsResponse>("/admin/storage/targets");
    return r.targets.length > 1;
  } catch {
    return false; // can't ask (non-admin, or no volumes) - just install
  }
}

function StorageChooser({
  pkg,
  onCancel,
  onConfirm,
}: {
  pkg: PackageInfo;
  onCancel: () => void;
  onConfirm: (volume: string) => void;
}) {
  const [volume, setVolume] = useState("");
  return (
    <div
      className="animate-fade-in absolute inset-0 z-30 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <h2 className="mb-1 text-base font-semibold text-ink">Install {pkg.name}</h2>
        <p className="mb-4 text-sm text-ink-faint">
          This service keeps data on disk. Choose where it should live - it can't be moved afterwards without
          reinstalling.
        </p>
        <StorageTargetField value={volume} onChange={setVolume} label="Store data on" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onConfirm(volume)}>Install</Button>
        </div>
      </div>
    </div>
  );
}
