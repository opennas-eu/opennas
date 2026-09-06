import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useNotifications, type NotificationLevel } from "../../store/notifications.ts";
import { useApps } from "../../store/apps.ts";
import { useWindows } from "../../store/windows.ts";
import { formatRelative } from "../../lib/format.ts";

const LEVEL_ICON: Record<NotificationLevel, React.ReactNode> = {
  info: <Info size={16} className="text-brand-500" />,
  success: <CircleCheck size={16} className="text-emerald-500" />,
  warning: <TriangleAlert size={16} className="text-amber-500" />,
  critical: <CircleAlert size={16} className="text-rose-500" />,
};

export function NotificationBell() {
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const remove = useNotifications((s) => s.remove);
  const clear = useNotifications((s) => s.clear);
  const openApp = useWindows((s) => s.openApp);
  const byId = useApps((s) => s.byId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const unread = items.filter((i) => !i.read).length;

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function toggle() {
    setOpen((o) => {
      if (!o) setTimeout(markAllRead, 1200); // mark read shortly after opening
      return !o;
    });
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className={clsx("relative grid h-9 w-9 place-items-center rounded-lg transition-colors", open ? "bg-white/20" : "hover:bg-white/10")}
        title="Notifications"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="animate-pop absolute right-0 top-11 w-80 overflow-hidden rounded-xl bg-white text-ink shadow-2xl ring-1 ring-black/5">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {items.length > 0 && (
              <button onClick={clear} className="flex items-center gap-1 text-xs text-ink-faint hover:text-ink">
                <CheckCheck size={13} /> Clear all
              </button>
            )}
          </div>

          <div className="opennas-scroll max-h-96 overflow-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-ink-faint">
                <Bell size={22} className="text-slate-300" />
                You're all caught up.
              </div>
            ) : (
              items.map((n) => {
                const app = n.appId ? byId(n.appId) : undefined;
                return (
                  <div
                    key={n.id}
                    className={clsx(
                      "group flex gap-3 border-b border-slate-50 px-4 py-3 last:border-0",
                      !n.read && "bg-brand-50/40",
                      app && "cursor-pointer hover:bg-slate-50",
                    )}
                    onClick={() => {
                      if (app) {
                        openApp(app);
                        setOpen(false);
                      }
                    }}
                  >
                    <span className="mt-0.5 shrink-0">{LEVEL_ICON[n.level]}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink-soft">{n.title}</div>
                      {n.body && <div className="truncate text-xs text-ink-faint">{n.body}</div>}
                      <div className="mt-0.5 text-[11px] text-slate-400">{formatRelative(new Date(n.createdAt).toISOString())}</div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); remove(n.id); }}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-300 opacity-0 transition hover:bg-slate-200 hover:text-ink-soft group-hover:opacity-100"
                      aria-label="Dismiss"
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
