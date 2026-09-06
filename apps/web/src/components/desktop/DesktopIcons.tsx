import type { AppManifest } from "@opennas/shared";
import { clsx } from "clsx";
import { AppIcon } from "../ui/Icon.tsx";
import { useApps } from "../../store/apps.ts";
import { useWindows } from "../../store/windows.ts";
import { TASKBAR_HEIGHT } from "../../store/windows.ts";

/** Clickable app shortcuts laid out down the left edge, DSM-style. */
export function DesktopIcons() {
  // Select the stable array reference; derive the filtered view in render.
  // (Filtering inside the selector returns a fresh array every call, which
  // makes useSyncExternalStore loop forever.)
  const allApps = useApps((s) => s.apps);
  const apps = allApps.filter((a) => a.showOnDesktop);
  const openApp = useWindows((s) => s.openApp);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-0 flex flex-col flex-wrap content-start gap-1 p-3"
      style={{ paddingTop: TASKBAR_HEIGHT + 12, maxHeight: "100%" }}
    >
      {apps.map((app) => (
        <DesktopIcon key={app.id} app={app} onOpen={() => openApp(app)} />
      ))}
    </div>
  );
}

function DesktopIcon({ app, onOpen }: { app: AppManifest; onOpen: () => void }) {
  return (
    <button
      onDoubleClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="pointer-events-auto group flex w-20 flex-col items-center gap-1.5 rounded-lg p-2 text-center transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
      title={`${app.name} - double-click to open`}
    >
      <span
        className={clsx(
          "grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br text-white shadow-lg ring-1 ring-white/20 transition-transform group-hover:scale-105",
          app.iconGradient,
        )}
      >
        <AppIcon app={app} className="h-6 w-6" />
      </span>
      <span className="line-clamp-2 text-[11px] font-medium text-white drop-shadow">{app.name}</span>
    </button>
  );
}
