import { clsx } from "clsx";
import {
  Activity,
  Info,
  Package,
  SlidersHorizontal,
  Sparkles,
  LayoutDashboard,
  FolderOpen,
  Gauge,
  FileText,
  StickyNote,
  Clapperboard,
  ShieldCheck,
  GitBranch,
  ShieldBan,
  AppWindow,
  Blocks,
  Cloud,
  House,
  Images,
  Boxes,
  Database,
  Download,
  MonitorPlay,
  type LucideIcon,
} from "lucide-react";
import type { AppManifest } from "@opennas/shared";
import { appContentUrl } from "../../lib/api.ts";

/**
 * Maps the icon names used in app manifests to concrete lucide components.
 * Keeping it explicit (vs. dynamic import) means perfect tree-shaking and no
 * runtime surprises when a package ships an unknown icon name.
 */
const ICONS: Record<string, LucideIcon> = {
  Activity,
  Info,
  Package,
  SlidersHorizontal,
  Sparkles,
  LayoutDashboard,
  FolderOpen,
  Gauge,
  FileText,
  StickyNote,
  Clapperboard,
  ShieldCheck,
  GitBranch,
  ShieldBan,
  Cloud,
  House,
  Images,
  Boxes,
  Database,
  Download,
  Blocks,
  MonitorPlay,
};

export function ManifestIcon({
  name,
  className,
  strokeWidth = 1.9,
}: {
  name: string;
  className?: string;
  strokeWidth?: number;
}) {
  const Cmp = ICONS[name] ?? AppWindow;
  return <Cmp className={className} strokeWidth={strokeWidth} />;
}

/** An app manifest's icon may be a packaged image (external apps) - anything with
 *  a file extension is rendered from /app-content; otherwise it's a lucide name. */
function isImageIcon(icon: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(icon);
}

/** Render an app's icon - handles both lucide-name icons and packaged images. */
export function AppIcon({
  app,
  className,
  strokeWidth,
}: {
  app: Pick<AppManifest, "id" | "icon" | "kind">;
  className?: string;
  strokeWidth?: number;
}) {
  if (app.kind === "external" && isImageIcon(app.icon)) {
    return (
      <img
        src={appContentUrl(app.id, app.icon)}
        alt=""
        draggable={false}
        className={clsx("object-contain", className)}
      />
    );
  }
  return <ManifestIcon name={app.icon} className={className} strokeWidth={strokeWidth} />;
}
