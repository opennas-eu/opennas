import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { Search } from "lucide-react";
import { AppIcon } from "../ui/Icon.tsx";
import { useApps } from "../../store/apps.ts";
import { useT } from "../../i18n/index.ts";
import { useWindows } from "../../store/windows.ts";
import { useIsPhone } from "../../lib/viewport.ts";

/**
 * Full-screen "main menu" grid of every app available to the user.
 *
 * `alwaysOpen` is the phone home screen: with no windows open there is nothing
 * else to look at, so the grid stays up and is not dismissible by tapping away
 * from it - there would be nowhere to go.
 */
export function AppLauncher({ alwaysOpen = false }: { alwaysOpen?: boolean } = {}) {
  const t = useT();
  const phone = useIsPhone();
  const apps = useApps((s) => s.apps);
  const launcherOpen = useWindows((s) => s.launcherOpen);
  const open = launcherOpen || alwaysOpen;
  const setLauncher = useWindows((s) => s.setLauncher);
  const openApp = useWindows((s) => s.openApp);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLauncher(false);
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setLauncher]);

  if (!open) return null;

  const filtered = apps.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div
      className={clsx(
        "animate-fade-in absolute inset-0 flex flex-col items-center overflow-y-auto backdrop-blur-xl",
        alwaysOpen && "z-[10] bg-slate-950/25 pt-10",
        // Below the bottom bar on a phone (which lives at 8000), so the button
        // that opened the launcher can also close it. Above everything on a
        // desktop, where the taskbar is at the top and nothing overlaps.
        !alwaysOpen && (phone ? "z-[7800] bg-slate-950/40 pt-10" : "z-[9000] bg-slate-950/40 pt-24"),
      )}
      style={
        phone
          ? {
              paddingTop: "calc(2.5rem + env(safe-area-inset-top))",
              paddingBottom: "calc(3rem + env(safe-area-inset-bottom))",
            }
          : undefined
      }
      onClick={() => !alwaysOpen && setLauncher(false)}
    >
      <div className="w-full max-w-xl px-6" onClick={(e) => e.stopPropagation()}>
        <div className="relative mb-8">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("desktop.searchApps")}
            className="w-full rounded-xl bg-white/10 py-3 pl-11 pr-4 text-white ring-1 ring-white/15 placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/40"
          />
        </div>

        <div className={clsx("grid gap-3", phone ? "grid-cols-3" : "grid-cols-3 sm:grid-cols-4")}>
          {filtered.map((app) => (
            <button
              key={app.id}
              onClick={() => openApp(app)}
              className="group flex flex-col items-center gap-2 rounded-2xl p-4 transition-colors hover:bg-white/10"
            >
              <span
                className={clsx(
                  "grid place-items-center rounded-2xl bg-gradient-to-br text-white shadow-xl ring-1 ring-white/20 transition-transform group-hover:scale-105",
                  phone ? "h-[4.5rem] w-[4.5rem]" : "h-16 w-16",
                  app.iconGradient,
                )}
              >
                <AppIcon app={app} className="h-8 w-8" />
              </span>
              <span className="text-center text-xs font-medium text-white/90">{app.name}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full py-10 text-center text-sm text-white/60">No apps found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
