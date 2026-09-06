import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { Cpu, Info, Layers, LayoutGrid, LogOut, MemoryStick, Power, RotateCcw, Search, User as UserIcon, X } from "lucide-react";
import { AppIcon } from "../ui/Icon.tsx";
import { Avatar } from "../ui/Avatar.tsx";
import { api } from "../../lib/api.ts";
import { Clock } from "./Clock.tsx";
import { NotificationBell } from "./NotificationBell.tsx";
import { useAuth } from "../../store/auth.ts";
import { useApps } from "../../store/apps.ts";
import { useSystem } from "../../store/system.ts";
import { useWindows, TASKBAR_HEIGHT } from "../../store/windows.ts";
import { useNotifications } from "../../store/notifications.ts";
import { useT } from "../../i18n/index.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { useIsPhone } from "../../lib/viewport.ts";

export function Taskbar() {
  const windows = useWindows((s) => s.windows);
  const setSearch = useWindows((s) => s.setSearch);
  const focusedId = useWindows((s) => s.focusedId);
  const toggleMinimize = useWindows((s) => s.toggleMinimize);
  const setLauncher = useWindows((s) => s.setLauncher);
  const launcherOpen = useWindows((s) => s.launcherOpen);
  const instanceName = useAuth((s) => s.bootstrap?.instanceName ?? "OpenNAS");
  const phone = useIsPhone();

  if (phone) return <PhoneBar />;

  return (
    <header
      className="glass absolute left-0 right-0 top-0 z-[8000] flex items-center gap-2 px-2 text-white"
      style={{ height: TASKBAR_HEIGHT }}
    >
      <button
        onClick={() => setLauncher(!launcherOpen)}
        className={clsx(
          "flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
          launcherOpen ? "bg-white/20" : "hover:bg-white/10",
        )}
        title="Main menu"
      >
        <LayoutGrid size={18} />
        <span className="hidden sm:inline">{instanceName}</span>
      </button>

      <div className="h-6 w-px bg-white/15" />

      {/* Open windows */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {windows.map((w) => (
          <button
            key={w.id}
            onClick={() => toggleMinimize(w.id)}
            className={clsx(
              "flex h-9 min-w-0 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors",
              focusedId === w.id && !w.minimized ? "bg-white/20" : "hover:bg-white/10",
              w.minimized && "opacity-60",
            )}
            title={w.title}
          >
            <span className={clsx("relative grid h-5 w-5 place-items-center rounded bg-gradient-to-br", w.app.iconGradient)}>
              <AppIcon app={w.app} className="h-3 w-3" />
              {w.badge !== null && (
                <span
                  className="absolute -right-1.5 -top-1 min-w-3.5 rounded-full bg-rose-500 px-1 text-[9px] font-semibold leading-[14px] text-white ring-1 ring-slate-900/20"
                  title={`${w.badge} waiting`}
                >
                  {w.badge > 99 ? "99+" : w.badge}
                </span>
              )}
            </span>
            <span className="hidden max-w-32 truncate md:inline">{w.title}</span>
            {focusedId === w.id && !w.minimized && (
              <span className="h-1 w-1 rounded-full bg-white" />
            )}
          </button>
        ))}
      </div>

      <SystemIndicator />
      <button
        onClick={() => setSearch(true)}
        className="grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-white/10"
        title="Search (Ctrl+K)"
        aria-label="Search"
      >
        <Search size={18} />
      </button>
      <NotificationBell />
      <Clock className="px-2 text-right" />
      <UserMenu />
    </header>
  );
}

/**
 * The phone bar.
 *
 * At the *bottom*, which is the whole point - a top bar on a phone is a stretch
 * for a thumb, and every mobile OS moved its primary controls down years ago.
 * Five fixed targets rather than a scrolling list of open windows: on a screen
 * this size, "which apps are open" is a question worth a dedicated switcher, not
 * a row of buttons two of which fit.
 *
 * Padded for the home indicator with `env(safe-area-inset-bottom)`, so the last
 * row of buttons is not sitting under the gesture bar.
 */
function PhoneBar() {
  const t = useT();
  const windows = useWindows((s) => s.windows);
  const setSearch = useWindows((s) => s.setSearch);
  const setLauncher = useWindows((s) => s.setLauncher);
  const launcherOpen = useWindows((s) => s.launcherOpen);
  const [switcher, setSwitcher] = useState(false);
  const open = windows.filter((w) => !w.closing);

  return (
    <>
      {switcher && <AppSwitcher onClose={() => setSwitcher(false)} />}
      <nav
        className="glass fixed inset-x-0 bottom-0 z-[8000] flex items-stretch justify-around text-white"
        style={{
          height: TASKBAR_HEIGHT,
          paddingBottom: "env(safe-area-inset-bottom)",
          // The bar grows by the inset, so the buttons stay TASKBAR_HEIGHT tall.
          boxSizing: "content-box",
        }}
      >
        <BarButton
          label={t("desktop.apps")}
          active={launcherOpen}
          onClick={() => {
            setSwitcher(false);
            setLauncher(!launcherOpen);
          }}
        >
          <LayoutGrid size={20} />
        </BarButton>
        <BarButton
          label={t("desktop.openApps")}
          active={switcher}
          badge={open.length || undefined}
          onClick={() => {
            setLauncher(false);
            setSwitcher((v) => !v);
          }}
        >
          <Layers size={20} />
        </BarButton>
        <BarButton label={t("desktop.search")} onClick={() => setSearch(true)}>
          <Search size={20} />
        </BarButton>
        <div className="grid flex-1 place-items-center">
          <NotificationBell />
        </div>
        <div className="grid flex-1 place-items-center">
          <UserMenu compact />
        </div>
      </nav>
    </>
  );
}

function BarButton({
  children,
  label,
  onClick,
  active,
  badge,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={clsx(
        "relative grid flex-1 place-items-center transition-colors",
        active ? "text-white" : "text-white/70",
      )}
    >
      <span className={clsx("grid h-10 w-10 place-items-center rounded-xl", active && "bg-white/20")}>
        {children}
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute right-1/2 top-1 translate-x-4 rounded-full bg-brand-500 px-1.5 text-[10px] font-semibold leading-4">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}

/**
 * Which apps are open, as a list you can actually hit.
 *
 * A phone has no taskbar row to glance at, so this is where "go back to the
 * thing I was doing" lives. Closing is here too, because the full-screen app
 * chrome only has room for one button and that button goes back.
 */
function AppSwitcher({ onClose }: { onClose: () => void }) {
  const t = useT();
  const windows = useWindows((s) => s.windows);
  const focusedId = useWindows((s) => s.focusedId);
  const focus = useWindows((s) => s.focus);
  const close = useWindows((s) => s.close);
  const open = windows.filter((w) => !w.closing);

  return (
    <div
      // Below the bar, not above it. At a higher z-index the sheet covered the
      // very button that opened it, so the only way out was tapping the
      // backdrop - and a control that cannot be un-pressed reads as broken.
      className="animate-fade-in fixed inset-0 z-[7900] flex flex-col justify-end bg-slate-950/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] overflow-y-auto rounded-t-2xl bg-white p-3"
        style={{ paddingBottom: `calc(${TASKBAR_HEIGHT}px + env(safe-area-inset-bottom) + 0.75rem)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
        {open.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">{t("desktop.noOpenApps")}</p>
        ) : (
          <ul className="space-y-1">
            {open.map((w) => (
              <li key={w.id} className="flex items-center gap-3 rounded-xl px-2 py-2 active:bg-slate-100">
                <button
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => {
                    focus(w.id);
                    onClose();
                  }}
                >
                  <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white", w.app.iconGradient)}>
                    <AppIcon app={w.app} className="h-4.5 w-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-soft">{w.title}</span>
                    {focusedId === w.id && <span className="text-[11px] text-brand-600">{t("desktop.inFront")}</span>}
                  </span>
                </button>
                <button
                  aria-label={t("desktop.close")}
                  onClick={() => close(w.id)}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-faint active:bg-slate-200"
                >
                  <X size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SystemIndicator() {
  const latest = useSystem((s) => s.latest);
  const openApp = useWindows((s) => s.openApp);
  const monitor = useApps((s) => s.byId("system-monitor"));
  if (!latest) return null;
  const memPct = Math.round((latest.memory.usedBytes / latest.memory.totalBytes) * 100);

  return (
    <button
      onClick={() => monitor && openApp(monitor)}
      className="hidden items-center gap-3 rounded-lg px-2.5 py-1 text-xs hover:bg-white/10 lg:flex"
      title="Open Resource Monitor"
    >
      <span className="flex items-center gap-1">
        <Cpu size={14} className="text-emerald-300" />
        <span className="tabular-nums">{Math.round(latest.cpu.total)}%</span>
      </span>
      <span className="flex items-center gap-1">
        <MemoryStick size={14} className="text-sky-300" />
        <span className="tabular-nums">{memPct}%</span>
      </span>
    </button>
  );
}

function UserMenu({ compact }: { compact?: boolean } = {}) {
  const t = useT();
  const user = useAuth((s) => s.session?.user);
  const logout = useAuth((s) => s.logout);
  const openApp = useWindows((s) => s.openApp);
  const aboutApp = useApps((s) => s.byId("about"));
  const controlPanel = useApps((s) => s.byId("control-panel"));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const push = useNotifications((s) => s.push);
  const isAdmin = user?.role === "admin";
  async function power(action: "reboot" | "poweroff") {
    const label = action === "reboot" ? "restart" : "shut down";
    const ok = await confirmDialog({
      title: `${label === "restart" ? "Restart" : "Shut down"} the NAS?`,
      message: `The system will ${label} now. You'll lose connection until it's back${action === "reboot" ? " up" : " on"}.`,
      confirmLabel: label === "restart" ? "Restart" : "Shut down",
      danger: true,
    });
    if (!ok) return;
    setOpen(false);
    try {
      await api.post(`/admin/power/${action}`);
      push({ level: "info", title: `The NAS is ${action === "reboot" ? "restarting" : "shutting down"}...` });
    } catch {
      push({ level: "warning", title: `Could not ${label} the NAS.` });
    }
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (!user) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={user.displayName}
        className={clsx(
          "flex items-center gap-2 rounded-lg transition-colors hover:bg-white/10",
          compact ? "h-10 w-10 justify-center" : "h-9 pl-1 pr-2",
        )}
      >
        <Avatar user={user} className="h-7 w-7 text-xs" />
        {!compact && <span className="hidden text-sm sm:inline">{user.displayName.split(" ")[0]}</span>}
      </button>

      {open && (
        <div
          className={clsx(
            "animate-pop absolute w-56 overflow-hidden rounded-xl bg-white text-ink shadow-2xl ring-1 ring-black/5",
            // In the bottom bar the menu has to open upwards, or it renders off
            // the bottom of the screen where nobody can reach it.
            compact ? "bottom-12 right-0" : "right-0 top-11",
          )}
        >
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="text-sm font-semibold">{user.displayName}</div>
            <div className="text-xs text-ink-faint">@{user.username}</div>
          </div>
          <div className="p-1.5">
            <MenuItem icon={<UserIcon size={16} />} onClick={() => { controlPanel && openApp(controlPanel); setOpen(false); }}>
              {t("desktop.accountSettings")}
            </MenuItem>
            <MenuItem icon={<Info size={16} />} onClick={() => { aboutApp && openApp(aboutApp); setOpen(false); }}>
              {t("desktop.about")}
            </MenuItem>
            {isAdmin && (
              <>
                <div className="my-1 h-px bg-slate-100" />
                <MenuItem icon={<RotateCcw size={16} />} onClick={() => void power("reboot")}>
                  {t("desktop.restartNas")}
                </MenuItem>
                <MenuItem icon={<Power size={16} />} onClick={() => void power("poweroff")}>
                  {t("desktop.shutDownNas")}
                </MenuItem>
              </>
            )}
            <div className="my-1 h-px bg-slate-100" />
            <MenuItem icon={<LogOut size={16} />} danger onClick={() => void logout()}>
              {t("auth.signOut")}
            </MenuItem>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
        danger ? "text-rose-600 hover:bg-rose-50" : "text-ink-soft hover:bg-slate-100",
      )}
    >
      {icon} {children}
    </button>
  );
}
