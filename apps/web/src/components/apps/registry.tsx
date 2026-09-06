import type { ComponentType } from "react";
import type { AppProps } from "./types.ts";
import { SystemMonitor } from "./SystemMonitor.tsx";
import { ControlPanel } from "./ControlPanel.tsx";
import { PackageCenter } from "./PackageCenter.tsx";
import { Containers } from "./Containers.tsx";
import { VirtualMachines } from "./VirtualMachines.tsx";
import { InfoCenter } from "./InfoCenter.tsx";
import { About } from "./About.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { FileStation } from "./FileStation.tsx";
import { TaskManager } from "./TaskManager.tsx";
import { TextEditor } from "./TextEditor.tsx";
import { Notes } from "./Notes.tsx";

/** Maps a built-in app id to the component rendered inside its window. */
export const APP_COMPONENTS: Record<string, ComponentType<AppProps>> = {
  dashboard: Dashboard,
  "file-station": FileStation,
  "task-manager": TaskManager,
  "system-monitor": SystemMonitor,
  "control-panel": ControlPanel,
  "package-center": PackageCenter,
  containers: Containers,
  "virtual-machines": VirtualMachines,
  "info-center": InfoCenter,
  about: About,
  // App-packages (appear once installed via Package Center):
  "text-editor": TextEditor,
  notes: Notes,
};

export function UnknownApp() {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-sm text-ink-faint">
      This app isn't available yet.
    </div>
  );
}
