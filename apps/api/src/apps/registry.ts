import type { AppManifest, User } from "@opennas/shared";
import { installedIds } from "../db/packages.js";
import { devManifests } from "./dev-apps.js";
import { canUseApp } from "../db/app-access.js";
import { listInstalledApps } from "../db/installed-apps.js";
import { manifestsForInstalled } from "../packages/catalog.js";

/**
 * Built-in apps. Installed packages will later contribute additional manifests
 * with kind: "package" through this same list - the desktop doesn't care which.
 */
export const BUILTIN_APPS: AppManifest[] = [
  {
    id: "dashboard",
    name: "Dashboard",
    icon: "LayoutDashboard",
    iconGradient: "from-indigo-400 to-violet-600",
    category: "system",
    description: "At-a-glance system health and live widgets.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 880, defaultHeight: 640, minWidth: 560, minHeight: 460, resizable: true },
    showOnDesktop: true,
  },
  {
    id: "file-station",
    name: "Files",
    icon: "FolderOpen",
    iconGradient: "from-sky-400 to-blue-600",
    category: "utilities",
    description: "Browse, upload, download and organise your files.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 900, defaultHeight: 620, minWidth: 560, minHeight: 400, resizable: true },
    showOnDesktop: true,
  },
  {
    id: "task-manager",
    name: "Task Manager",
    icon: "Gauge",
    iconGradient: "from-rose-400 to-pink-600",
    category: "system",
    description: "Live process list with CPU and memory usage.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 820, defaultHeight: 580, minWidth: 560, minHeight: 380, resizable: true },
    showOnDesktop: false,
  },
  {
    id: "system-monitor",
    name: "Resource Monitor",
    icon: "Activity",
    iconGradient: "from-emerald-400 to-teal-600",
    category: "system",
    description: "Live CPU, memory, network and thermal telemetry.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 760, defaultHeight: 560, minWidth: 480, minHeight: 360, resizable: true },
    showOnDesktop: true,
  },
  {
    id: "control-panel",
    name: "Control Panel",
    icon: "SlidersHorizontal",
    iconGradient: "from-slate-400 to-slate-600",
    category: "system",
    description: "System settings, users, security and SSO.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 820, defaultHeight: 600, minWidth: 560, minHeight: 420, resizable: true },
    showOnDesktop: true,
  },
  {
    id: "package-center",
    name: "Package Center",
    icon: "Package",
    iconGradient: "from-amber-400 to-orange-600",
    category: "system",
    description: "Browse and install add-on packages, and manage your own apps.",
    kind: "builtin",
    minRole: "admin",
    window: { defaultWidth: 880, defaultHeight: 620, minWidth: 600, minHeight: 440, resizable: true },
    showOnDesktop: true,
  },
  {
    id: "info-center",
    name: "Info Center",
    icon: "Info",
    iconGradient: "from-sky-400 to-blue-600",
    category: "system",
    description: "Hardware and system information at a glance.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 680, defaultHeight: 520, minWidth: 440, minHeight: 360, resizable: true },
    showOnDesktop: true,
  },
  {
    id: "about",
    name: "About OpenNAS",
    icon: "Sparkles",
    iconGradient: "from-fuchsia-400 to-purple-600",
    category: "system",
    description: "About this OpenNAS instance.",
    kind: "builtin",
    minRole: "user",
    window: { defaultWidth: 460, defaultHeight: 420, minWidth: 460, minHeight: 420, resizable: false },
    showOnDesktop: false,
  },
];

export function appsForRole(role: "admin" | "user"): AppManifest[] {
  // Built-ins + bundled packages + installed third-party (external) apps, plus
  // any development builds an admin has registered (they carry minRole "admin",
  // so the filter below keeps them away from everyone else).
  const externals = listInstalledApps().filter((a) => a.enabled).map((a) => a.manifest);
  const all = [...BUILTIN_APPS, ...manifestsForInstalled(installedIds()), ...externals, ...devManifests()];
  if (role === "admin") return all;
  return all.filter((a) => a.minRole !== "admin");
}

/**
 * The apps a specific person may use.
 *
 * The per-user allow-list on top of the role filter. This is what the launcher
 * renders, but it is emphatically *not* where the restriction is enforced - an
 * app's routes and its static files are reachable without going near this list,
 * so both check `canUseApp` themselves. Filtering here only keeps the desktop
 * from showing someone an icon that would refuse them.
 */
export function appsForUser(user: Pick<User, "id" | "role">): AppManifest[] {
  return appsForRole(user.role).filter((a) => canUseApp(user, a.id));
}
