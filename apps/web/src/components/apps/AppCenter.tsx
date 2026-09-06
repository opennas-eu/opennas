import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { Activity, AlertTriangle, ArrowUpCircle, Bell, Blocks, CalendarClock, Check, Download, FolderCog, FolderLock, FolderSearch, Globe, IdCard, ImageOff, Package, Pencil, Puzzle, RefreshCw, Save, Search, ShieldAlert, ShieldCheck, SlidersHorizontal, Store, Trash2, Upload, X } from "lucide-react";
import type { AppCategory, AppInstallResult, AppPermission, AppRepo, AppUpdateApplyResponse, AppUpdatesResponse, ManagedApp, ManagedAppsResponse, PendingInstall, RepoApp, RepoCatalogResponse, RepoConfigResponse, RepoSourceStatus } from "@opennas/shared";
import { isPendingInstall } from "@opennas/shared";
import { api, apiUrl, appContentUrl, ApiRequestError } from "../../lib/api.ts";
import { useApps } from "../../store/apps.ts";
import { useNotifications } from "../../store/notifications.ts";
import { useAuth } from "../../store/auth.ts";
import { RepoSettings } from "./RepoSettings.tsx";
import { AppSettingsPanel } from "./AppSettingsPanel.tsx";
import { DevApps } from "./DevApps.tsx";
import { confirmDialog } from "../../store/dialogs.ts";
import { Button, Toggle } from "../ui/controls.tsx";
import { AppIcon, ManifestIcon } from "../ui/Icon.tsx";
import { formatRelative } from "../../lib/format.ts";

export function AppCenter({ embedded = false }: { embedded?: boolean }) {
  const reloadLauncher = useApps((s) => s.load);
  const push = useNotifications((s) => s.push);
  const [managed, setManaged] = useState<ManagedApp[] | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<AppCategory | "all">("all");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [detail, setDetail] = useState<ManagedApp | null>(null);
  // Bumped whenever the installed set changes, so the updates panel re-checks.
  const [installedRev, setInstalledRev] = useState(0);
  // Packages waiting on the admin's approval, reviewed one at a time.
  const [consentQueue, setConsentQueue] = useState<PendingInstall[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  function enqueueConsent(p: PendingInstall | PendingInstall[]) {
    setConsentQueue((q) => [...q, ...(Array.isArray(p) ? p : [p])]);
  }

  async function reloadAll() {
    setManaged((await api.get<ManagedAppsResponse>("/apps/manage")).apps);
    setInstalledRev((n) => n + 1);
    await reloadLauncher(); // keep the launcher/desktop in sync
  }
  useEffect(() => { void reloadAll(); }, []);

  async function install(file: File) {
    if (!/\.onpkg$|\.zip$/i.test(file.name)) {
      push({ level: "warning", title: "Not an app package", body: "Choose a .onpkg file." });
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch(apiUrl("/apps/install"), { method: "POST", body: fd, credentials: "include" });
      const body = (await res.json().catch(() => null)) as AppInstallResult | { message?: string } | null;
      if (!res.ok) throw new Error((body as { message?: string })?.message ?? "Install failed.");
      // 202 = the package wants something the admin hasn't granted, or comes from
      // a publisher we don't know yet. Nothing is on disk until they approve it.
      if (body && isPendingInstall(body as AppInstallResult)) {
        enqueueConsent((body as { pending: PendingInstall }).pending);
        return;
      }
      const app = (body as { app: { name: string } }).app;
      push({ level: "success", title: "App installed", body: `"${app.name}" is ready to open from the launcher.` });
      await reloadAll();
    } catch (err) {
      push({ level: "warning", title: "Couldn't install app", body: err instanceof Error ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(app: ManagedApp, enabled: boolean) {
    try {
      await api.post(`/apps/${app.manifest.id}/enabled`, { enabled });
      await reloadAll();
    } catch (err) {
      push({ level: "warning", title: "Couldn't update app", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function setTrust(a: ManagedApp, trusted: boolean) {
    try {
      await api.post(`/apps/${a.manifest.id}/trust`, { trusted });
      await reloadAll();
    } catch (err) {
      push({ level: "warning", title: "Couldn't update trust", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function uninstall(app: ManagedApp) {
    const ok = await confirmDialog({
      title: `Uninstall "${app.manifest.name}"?`,
      message: "The app and its stored data are removed.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/apps/${app.manifest.id}`);
      push({ level: "success", title: "App uninstalled", body: app.manifest.name });
      await reloadAll();
    } catch (err) {
      push({ level: "warning", title: "Couldn't uninstall", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  // Which installed app has its settings panel open, if any.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const isAdmin = useAuth((s) => s.session?.user.role === "admin");

  const categories = useMemo(() => {
    const set = new Set<AppCategory>((managed ?? []).map((a) => a.manifest.category));
    return ["all", ...Array.from(set)] as (AppCategory | "all")[];
  }, [managed]);

  const filtered = (managed ?? []).filter(
    (a) =>
      (cat === "all" || a.manifest.category === cat) &&
      (query === "" || `${a.manifest.name} ${a.manifest.description} ${a.manifest.author ?? ""}`.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <div className={clsx("relative flex h-full flex-col", !embedded && "bg-white")}>
      {!embedded && (
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Blocks size={20} /> App Center</h2>
          <p className="text-sm text-ink-faint">Install apps built with the OpenNAS app framework, or manage the ones you've added.</p>
        </div>
      )}

      <div className="opennas-scroll min-h-0 flex-1 space-y-5 overflow-auto p-6">
        {/* Pending updates for installed apps */}
        <UpdatesPanel hasApps={(managed?.length ?? 0) > 0} rev={installedRev} onApplied={reloadAll} onPending={enqueueConsent} />

        {/* Browse the app repository */}
        <RepoBrowser onInstalled={reloadAll} onPending={enqueueConsent} />

        {/* Install dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) void install(f);
          }}
          className={`grid place-items-center rounded-2xl border-2 border-dashed p-8 text-center transition ${dragOver ? "border-brand-400 bg-brand-50/70" : "border-slate-300 bg-slate-50"}`}
        >
          <Upload size={28} className="mb-2 text-slate-400" />
          <p className="text-sm font-medium text-ink-soft">Drop a <code className="rounded bg-slate-200 px-1 text-xs">.onpkg</code> package here</p>
          <p className="mb-3 text-xs text-ink-faint">or choose one from your computer</p>
          <Button className="h-9" loading={busy} onClick={() => fileInput.current?.click()}>
            <Upload size={15} /> Install app
          </Button>
          <input ref={fileInput} type="file" accept=".onpkg,.zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void install(f); e.target.value = ""; }} />
        </div>

        {/* Installed apps + search/filter */}
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-soft">Installed apps</h3>
            <span className="flex-1" />
            {(managed?.length ?? 0) > 0 && (
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-40 rounded-lg bg-slate-100 pl-8 pr-2 text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
            )}
          </div>

          {categories.length > 2 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {categories.map((c) => (
                <button key={c} onClick={() => setCat(c)} className={clsx("rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors", cat === c ? "bg-brand-600 text-white" : "bg-slate-100 text-ink-faint hover:bg-slate-200")}>
                  {c}
                </button>
              ))}
            </div>
          )}

          {managed === null ? (
            <p className="text-sm text-ink-faint">Loading...</p>
          ) : managed.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
              No third-party apps installed yet. Install one above to get started.
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">No apps match your search.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((a) => (
                <div key={a.manifest.id} className={clsx("rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70", !a.enabled && "opacity-60")}>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setDetail(a)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    title="View details"
                  >
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white ${a.manifest.iconGradient}`}>
                    <AppIcon app={a.manifest} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-ink-soft">{a.manifest.name}</span>
                      {a.manifest.version && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">v{a.manifest.version}</span>}
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium capitalize text-ink-soft">{a.manifest.category}</span>
                      {a.verified ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"><ShieldCheck size={11} /> Verified</span>
                      ) : a.manifest.signed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium text-brand-700"><ShieldCheck size={11} /> Signed</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"><ShieldAlert size={11} /> Unsigned</span>
                      )}
                      {!a.enabled && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">Disabled</span>}
                    </div>
                    <div className="truncate text-xs text-ink-faint">
                      {a.manifest.author ? `${a.manifest.author} - ` : ""}{a.manifest.description || "No description"}
                      {a.manifest.publisherFingerprint ? ` - key ${a.manifest.publisherFingerprint.slice(0, 12)}...` : ""}
                    </div>
                  </div>
                  </button>
                  {a.manifest.signed && (
                    a.verified ? (
                      <button onClick={() => void setTrust(a, false)} className="rounded-md px-2 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50" title="Untrust this publisher">Trusted</button>
                    ) : (
                      <button onClick={() => void setTrust(a, true)} className="rounded-md px-2 py-1 text-xs font-medium text-brand-600 transition hover:bg-brand-50" title="Trust this publisher's key">Trust publisher</button>
                    )
                  )}
                  {(a.manifest.settings?.length ?? 0) > 0 && (
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      title={`${a.manifest.name} settings`}
                      onClick={() => setSettingsFor((cur) => (cur === a.manifest.id ? null : a.manifest.id))}
                    >
                      <SlidersHorizontal size={15} />
                    </Button>
                  )}
                  <Toggle checked={a.enabled} onChange={(v) => void setEnabled(a, v)} label={`Enable ${a.manifest.name}`} />
                  <Button variant="ghost" className="h-8 px-2 text-rose-600 hover:bg-rose-50" onClick={() => uninstall(a)}>
                    <Trash2 size={15} />
                  </Button>
                </div>
                {settingsFor === a.manifest.id && (
                  <AppSettingsPanel
                    appId={a.manifest.id}
                    appName={a.manifest.name}
                    onClose={() => setSettingsFor(null)}
                  />
                )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Development apps - admin only, and the section is the doorway to it. */}
        {isAdmin && <DevApps onChanged={reloadAll} />}

        {/* Developer note */}
        <div className="rounded-xl bg-brand-50/60 p-4 text-sm text-ink-soft ring-1 ring-brand-100">
          <p className="mb-1 flex items-center gap-2 font-semibold text-brand-700"><Puzzle size={16} /> Build your own app</p>
          <p className="text-xs text-ink-faint">
            An OpenNAS app contains HTML, JavaScript, CSS and an <code className="rounded bg-white px-1">opennas-app.json</code> manifest, loaded with{" "}
            <code className="rounded bg-white px-1">&lt;script src="/app-sdk/opennas.js"&gt;</code>. Zip your files into a{" "}
            <code className="rounded bg-white px-1">.onpkg</code> and install it here. See the developer guide in the{" "}
            <code className="rounded bg-white px-1">@opennas/app-sdk</code> README.
          </p>
        </div>
      </div>

      {consentQueue[0] && (
        <PermissionConsent
          pending={consentQueue[0]}
          onSettled={async (installed) => {
            setConsentQueue((q) => q.slice(1));
            if (installed) await reloadAll();
          }}
        />
      )}

      {detail && <AppDetailModal app={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/**
 * What each capability actually lets an app do, in plain language.
 *
 * The wording carries real weight here - this is the screen someone decides on.
 * "files" sounds alarming but is a private folder of the app's own, while
 * `shares:read` genuinely reaches everything you can see, so the two must not
 * read alike. Most apps need neither: `shares.pick()` asks you for one folder
 * at the moment it's needed and appears in no manifest at all.
 */
const PERMISSION_INFO: Record<AppPermission, { label: string; detail: string; icon: typeof Bell }> = {
  notifications: {
    label: "Send you notifications",
    detail: "Post messages to your notification centre.",
    icon: Bell,
  },
  storage: {
    label: "Save its own settings",
    detail: "Keep small values (preferences, progress) for your account.",
    icon: Save,
  },
  user: {
    label: "See who you are",
    detail: "Read your username, display name and role. This does not include your password or email.",
    icon: IdCard,
  },
  files: {
    label: "Use a private folder",
    detail: "Read and write files in a folder of its own. It cannot reach your shared folders.",
    icon: FolderLock,
  },
  "shares:read": {
    label: "Read all your shared folders",
    detail:
      "Read all folders you have access to without asking each time. Only allow this if the app needs access to all your files.",
    icon: FolderSearch,
  },
  "shares:write": {
    label: "Change files in all your shared folders",
    detail:
      "Write anywhere you can, without asking each time. The widest thing an app can be given.",
    icon: FolderCog,
  },
  system: {
    label: "Read system stats",
    detail: "View CPU, memory, storage and network usage. This does not allow changes or access to the process list.",
    icon: Activity,
  },
  fetch: {
    label: "Contact the internet",
    detail: "Connect to the hosts listed below. Connections to your NAS and local network are blocked.",
    icon: Globe,
  },
  schedule: {
    label: "Run on a schedule",
    detail: "Run background tasks while the app is closed, at most once every 15 minutes. Tasks use the app's existing permissions.",
    icon: CalendarClock,
  },
};

/**
 * Install-time permission review. The server has already validated the package
 * and is holding it; nothing has been written to disk. Confirming commits it,
 * cancelling discards it, and the token expires on its own either way.
 */
function PermissionConsent({ pending, onSettled }: { pending: PendingInstall; onSettled: (installed: boolean) => Promise<void> }) {
  const push = useNotifications((s) => s.push);
  const [busy, setBusy] = useState<"install" | "cancel" | null>(null);

  async function confirm() {
    setBusy("install");
    try {
      await api.post("/apps/install/confirm", { token: pending.token });
      push({
        level: "success",
        title: pending.isUpdate ? "App updated" : "App installed",
        body: `${pending.name} v${pending.version}`,
      });
      await onSettled(true);
    } catch (err) {
      push({ level: "warning", title: "Couldn't install", body: err instanceof ApiRequestError ? err.message : "Failed." });
      await onSettled(false);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      await api.post("/apps/install/cancel", { token: pending.token });
    } catch {
      /* it expires on its own - nothing was installed either way */
    } finally {
      setBusy(null);
      await onSettled(false);
    }
  }

  const wants = pending.permissions;
  const isNew = (p: AppPermission) => pending.newPermissions.includes(p);
  const verb = pending.isUpdate ? "Update" : "Install";

  return (
    <div className="animate-fade-in absolute inset-0 z-40 flex flex-col bg-slate-950/50 p-4 backdrop-blur-sm">
      <div className="mx-auto flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-lg font-semibold text-ink">
            {verb} '{pending.name}'?
          </h2>
          <p className="text-sm text-ink-faint">
            v{pending.version}
            {pending.author ? ` - ${pending.author}` : ""}
            {pending.isUpdate ? " - update to an installed app" : ""}
          </p>
        </div>

        <div className="opennas-scroll min-h-0 flex-1 space-y-4 overflow-auto p-5">
          {/* Publisher trust - the other half of "should I run this?" */}
          {pending.verified ? (
            <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800 ring-1 ring-emerald-200">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" />
              <span>Signed by a publisher you've already trusted.</span>
            </div>
          ) : pending.signed ? (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-800 ring-1 ring-amber-200">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                Signed, but by a publisher you haven't trusted yet
                {pending.publisherFingerprint ? ` (key ${pending.publisherFingerprint.slice(0, 12)}...)` : ""}. You can trust
                them from the installed-apps list afterwards.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-800 ring-1 ring-rose-200">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                <strong className="font-semibold">Not signed.</strong> Nothing proves who built this package or that it
                hasn't been altered. Only install packages you got from somewhere you trust.
              </span>
            </div>
          )}

          {pending.description && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{pending.description}</p>
          )}

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              {wants.length === 0 ? "Permissions" : `This app will be able to`}
            </h3>
            {wants.length === 0 ? (
              <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-ink-faint ring-1 ring-slate-200/70">
                This app requests no permissions. It runs in a sandbox without access to OpenNAS.
              </p>
            ) : (
              <ul className="space-y-2">
                {wants.map((perm) => {
                  const info = PERMISSION_INFO[perm];
                  const Icon = info?.icon ?? Package;
                  const fresh = pending.isUpdate && isNew(perm);
                  return (
                    <li
                      key={perm}
                      className={clsx(
                        "flex items-start gap-2.5 rounded-xl px-3 py-2.5 ring-1",
                        fresh ? "bg-amber-50 ring-amber-200" : "bg-slate-50 ring-slate-200/70",
                      )}
                    >
                      <Icon size={16} className={clsx("mt-0.5 shrink-0", fresh ? "text-amber-700" : "text-ink-faint")} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink-soft">
                          {info?.label ?? perm}
                          {fresh && (
                            <span className="rounded-full bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                              New
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-faint">{info?.detail ?? "An OpenNAS capability."}</p>
                        {/* "can reach the internet" is meaningless without the list. */}
                        {perm === "fetch" && (
                          <ul className="mt-1.5 flex flex-wrap gap-1">
                            {pending.fetchHosts.map((host) => (
                              <li key={host} className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft ring-1 ring-slate-200">
                                {host}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {pending.isUpdate && pending.newPermissions.length > 0 && (
            <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-800 ring-1 ring-amber-200">
              This update asks for more than the version you installed. Automatic updates skipped it for that reason.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
          <Button variant="ghost" disabled={busy !== null} onClick={cancel}>
            Cancel
          </Button>
          <Button loading={busy === "install"} disabled={busy !== null} onClick={confirm}>
            {verb}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pending app updates. The backend diffs installed versions against the
 * repository catalogue (cached, so opening App Center doesn't hammer the repo);
 * applying one re-downloads and reinstalls the package through the same
 * verification path as a fresh install, keeping the app's data and enabled state.
 */
function UpdatesPanel({ hasApps, rev, onApplied, onPending }: { hasApps: boolean; rev: number; onApplied: () => Promise<void>; onPending: (p: PendingInstall[]) => void }) {
  const push = useNotifications((s) => s.push);
  const [state, setState] = useState<AppUpdatesResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(refresh = false) {
    setChecking(true);
    try {
      setState(await api.get<AppUpdatesResponse>(`/apps/repo/updates${refresh ? "?refresh=1" : ""}`));
    } catch {
      setState(null); // repo unreachable or check failed - stay quiet, the panel just hides
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    if (hasApps) void load();
  }, [hasApps, rev]);

  async function apply(ids?: string[]) {
    setBusy(ids?.length === 1 ? ids[0]! : "all");
    try {
      const res = await api.post<AppUpdateApplyResponse>("/apps/repo/updates/apply", ids ? { ids } : {});
      // Updates that want new permissions are staged, not installed - review them.
      if (res.pending.length > 0) onPending(res.pending);
      if (res.updated.length > 0) {
        push({
          level: "success",
          title: res.updated.length === 1 ? "App updated" : `${res.updated.length} apps updated`,
          body: res.updated.map((u) => `${u.name} → v${u.version}`).join(", "),
        });
      }
      for (const f of res.failed) {
        push({ level: "warning", title: "Couldn't update app", body: `${f.id}: ${f.message}` });
      }
      await load(true);
      await onApplied();
    } catch (err) {
      push({ level: "warning", title: "Couldn't update", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function setAuto(enabled: boolean) {
    setState((s) => (s ? { ...s, autoUpdate: enabled } : s)); // optimistic - it's a checkbox
    try {
      await api.put("/apps/repo/updates/auto", { enabled });
    } catch (err) {
      push({ level: "warning", title: "Couldn't change setting", body: err instanceof ApiRequestError ? err.message : "Failed." });
      await load();
    }
  }

  if (!hasApps || !state) return null;
  const pending = state.updates;
  const working = busy !== null;

  return (
    <section
      className={clsx(
        "rounded-2xl p-4 ring-1",
        pending.length > 0 ? "bg-brand-50/60 ring-brand-200" : "bg-slate-50 ring-slate-200/70",
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
          <ArrowUpCircle size={15} className={pending.length > 0 ? "text-brand-600" : undefined} />
          {pending.length > 0 ? `${pending.length} update${pending.length === 1 ? "" : "s"} available` : "Apps are up to date"}
        </h3>
        <span className="flex-1" />
        {pending.length > 1 && (
          <Button className="h-8 px-2.5 text-xs" loading={busy === "all"} disabled={working} onClick={() => void apply()}>
            <Download size={13} /> Update all
          </Button>
        )}
        <button
          onClick={() => void load(true)}
          className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-200"
          title="Check for updates now"
        >
          <RefreshCw size={15} className={checking ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        <span>Checked {formatRelative(state.checkedAt)}</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={state.autoUpdate}
            onChange={(e) => void setAuto(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Install updates automatically
        </label>
      </div>

      {!state.repoReachable && (
        <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
          The last repository check failed. This list may be out of date.
        </p>
      )}

      {pending.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {pending.map((u) => (
            <div key={u.id} className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200/70">
              <span className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br text-white ${u.iconGradient}`}>
                {u.iconUrl ? <img src={apiUrl(u.iconUrl)} alt="" className="h-full w-full object-cover" /> : <ManifestIcon name={u.icon} className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-ink-soft">{u.name}</span>
                  {u.signed ? (
                    <ShieldCheck size={12} className="shrink-0 text-emerald-600" aria-label="Signed" />
                  ) : (
                    <ShieldAlert size={12} className="shrink-0 text-amber-500" aria-label="Unsigned" />
                  )}
                </div>
                <p className="truncate text-xs text-ink-faint">
                  v{u.installedVersion} → <span className="font-medium text-brand-700">v{u.availableVersion}</span>
                  {u.newPermissions.length > 0 && (
                    <span className="ml-1.5 text-amber-700" title={`Wants: ${u.newPermissions.join(", ")}`}>
                      - needs approval
                    </span>
                  )}
                </p>
              </div>
              <Button className="h-8 px-2.5 text-xs" loading={busy === u.id} disabled={working} onClick={() => void apply([u.id])}>
                <Download size={13} /> Update
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RepoBrowser({ onInstalled, onPending }: { onInstalled: () => Promise<void>; onPending: (p: PendingInstall) => void }) {
  const push = useNotifications((s) => s.push);
  const [repos, setRepos] = useState<AppRepo[]>([]);
  const [sources, setSources] = useState<RepoSourceStatus[]>([]);
  const [editing, setEditing] = useState(false);
  const [apps, setApps] = useState<RepoApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const cfg = await api.get<RepoConfigResponse>("/apps/repo");
      setRepos(cfg.repos);
      const cat = await api.get<RepoCatalogResponse>("/apps/repo/catalog");
      setApps(cat.apps);
      setSources(cat.sources);
    } catch (err) {
      setApps([]);
      setSources([]);
      setError(err instanceof ApiRequestError ? err.message : "Couldn't reach the repository.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function install(a: RepoApp) {
    setBusy(a.id);
    try {
      const res = await api.post<AppInstallResult>("/apps/repo/install", { id: a.id, repo: a.repoId });
      // 202 → the package asks for something that needs the admin's approval.
      if (isPendingInstall(res)) {
        onPending(res.pending);
        return;
      }
      push({ level: "success", title: "App installed", body: `"${a.name}" - find it in the launcher.` });
      await load();
      await onInstalled();
    } catch (err) {
      push({ level: "warning", title: "Couldn't install", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  const filtered = (apps ?? []).filter((a) => query === "" || `${a.name} ${a.description} ${a.author}`.toLowerCase().includes(query.toLowerCase()));
  // Only worth flagging when something else *did* work; a total outage is
  // already reported by the error message below.
  const unreachable = sources.filter((s) => !s.reachable);

  return (
    <section className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
          <Store size={15} /> App {repos.length === 1 ? "repository" : "repositories"}
        </h3>
        <button
          onClick={() => setEditing((v) => !v)}
          className="inline-flex items-center gap-1 truncate rounded-md bg-white px-2 py-1 text-xs text-ink-faint ring-1 ring-slate-200 hover:text-ink-soft"
          title="Manage repositories"
        >
          <span className="max-w-[220px] truncate">
            {repos.length === 0
              ? "none configured"
              : repos.length === 1
                ? repos[0]!.url.replace(/^https?:\/\//, "")
                : `${repos.length} configured`}
          </span>
          <Pencil size={11} />
        </button>
        {unreachable.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-200"
            title={unreachable.map((s) => s.url).join(", ")}
          >
            <AlertTriangle size={10} /> {unreachable.length} unreachable
          </span>
        )}
        <span className="flex-1" />
        {(apps?.length ?? 0) > 0 && (
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-32 rounded-lg bg-white pl-8 pr-2 text-sm text-ink ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
        )}
        <button onClick={() => void load()} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-200" title="Refresh">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {editing && (
        <RepoSettings repos={repos} sources={sources} onChanged={load} onClose={() => setEditing(false)} />
      )}

      {apps === null ? (
        <p className="text-sm text-ink-faint">Loading the repository...</p>
      ) : error ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-ink-faint">{apps.length === 0 ? "No apps published to this repository yet." : "No apps match your search."}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {filtered.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200/70">
              <span className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br text-white ${a.iconGradient}`}>
                {a.iconUrl ? <img src={apiUrl(a.iconUrl)} alt="" className="h-full w-full object-cover" /> : <ManifestIcon name={a.icon} className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-ink-soft">{a.name}</span>
                  {a.version && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-ink-faint">v{a.version}</span>}
                  {a.signed ? (
                    <ShieldCheck size={12} className="shrink-0 text-emerald-600" aria-label="Signed" />
                  ) : (
                    <ShieldAlert size={12} className="shrink-0 text-amber-500" aria-label="Unsigned" />
                  )}
                </div>
                <p className="truncate text-xs text-ink-faint">{a.author ? `${a.author} - ` : ""}{a.description || "No description"}</p>
                {a.permissions.length > 0 && (
                  <p className="truncate text-[11px] text-ink-faint" title={a.permissions.join(", ")}>
                    Wants: {a.permissions.map((perm) => PERMISSION_INFO[perm]?.label ?? perm).join(", ").toLowerCase()}
                  </p>
                )}
              </div>
              {a.installed ? (
                <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-700"><Check size={13} /> Installed</span>
              ) : (
                <Button className="h-8 px-2.5 text-xs" loading={busy === a.id} onClick={() => void install(a)}>
                  <Download size={13} /> Install
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AppDetailModal({ app, onClose }: { app: ManagedApp; onClose: () => void }) {
  const m = app.manifest;
  const shots = (m.screenshots ?? []).map((s) => appContentUrl(m.id, s));
  return (
    <div
      className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="mx-auto flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
        <div className="flex items-start gap-3 border-b border-slate-200 p-5">
          <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-white ${m.iconGradient}`}>
            <AppIcon app={m} className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold text-ink">{m.name}</h2>
            <p className="text-sm text-ink-faint">
              {m.version ? `v${m.version}` : ""}{m.author ? `${m.version ? " - " : ""}${m.author}` : ""}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium capitalize text-ink-soft">{m.category}</span>
              {app.verified ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"><ShieldCheck size={11} /> Verified</span>
              ) : m.signed ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium text-brand-700"><ShieldCheck size={11} /> Signed</span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"><ShieldAlert size={11} /> Unsigned</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100" title="Close"><X size={18} /></button>
        </div>

        <div className="opennas-scroll min-h-0 flex-1 space-y-4 overflow-auto p-5">
          {shots.length > 0 ? (
            <div className="opennas-scroll -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
              {shots.map((src, i) => (
                <img key={i} src={src} alt={`${m.name} screenshot ${i + 1}`} className="h-52 shrink-0 rounded-xl bg-slate-100 object-cover ring-1 ring-slate-200/70" loading="lazy" />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-3 text-xs text-ink-faint ring-1 ring-slate-200/70">
              <ImageOff size={14} /> This app didn't include any screenshots.
            </div>
          )}

          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">About</h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{m.description || "No description provided."}</p>
          </div>

          {(m.permissions?.length ?? 0) > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Permissions</h3>
              <div className="flex flex-wrap gap-1.5">
                {m.permissions!.map((p) => (
                  <span key={p} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-ink-soft">{p}</span>
                ))}
              </div>
            </div>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-faint">App ID</dt>
            <dd className="font-mono text-ink-soft">{m.id}</dd>
            {m.publisherFingerprint && (<>
              <dt className="text-ink-faint">Publisher key</dt>
              <dd className="break-all font-mono text-ink-soft">{m.publisherFingerprint}</dd>
            </>)}
          </dl>
        </div>
      </div>
    </div>
  );
}
