import type { AppManifest, PackageInfo } from "@opennas/shared";

/**
 * The package catalog. "app" packages ship inside OpenNAS and register a real
 * desktop app when installed (via the AppManifest seam). "service" packages are
 * container/daemon-based and run on the host (Docker) - OpenNAS tracks them but
 * the workload itself lives outside the web process.
 */
/** How a one-click "service" package runs as a Docker container. */
export interface ServiceSpec {
  image: string;
  ports?: { host: number; container: number; proto?: "tcp" | "udp" }[];
  /** Named persistent dirs, bind-mounted from <servicesDir>/<id>/<name>. */
  volumes?: { name: string; container: string }[];
  /** Bind-mount a host path directly (e.g. the docker socket for Portainer). */
  hostMounts?: { host: string; container: string; readOnly?: boolean }[];
  env?: Record<string, string>;
  /** Extra raw `docker run` flags. */
  args?: string[];
  /** Host port for the "Open" web-UI link, if the service has a web UI. */
  webPort?: number;
}

export interface PackageDef {
  info: Omit<PackageInfo, "installed" | "status">;
  /** Present for type:"app" - registered into the desktop on install. */
  manifest?: AppManifest;
  /** Present for type:"service" - how to run it as a container (one-click). */
  service?: ServiceSpec;
}

export const CATALOG: PackageDef[] = [
  {
    info: {
      id: "text-editor",
      name: "Text Editor",
      version: "1.0.0",
      publisher: "OpenNAS",
      description: "A clean editor for text, Markdown, config and code files stored on your NAS.",
      category: "developer",
      icon: "FileText",
      iconGradient: "from-slate-500 to-slate-700",
      type: "app",
      requiresDocker: false,
    },
    manifest: {
      id: "text-editor",
      name: "Text Editor",
      icon: "FileText",
      iconGradient: "from-slate-500 to-slate-700",
      category: "developer",
      description: "Edit text files on your NAS.",
      kind: "package",
      minRole: "user",
      window: { defaultWidth: 820, defaultHeight: 600, minWidth: 520, minHeight: 360, resizable: true },
      showOnDesktop: true,
    },
  },
  {
    info: {
      id: "notes",
      name: "Notes",
      version: "1.0.0",
      publisher: "OpenNAS",
      description: "Jot down quick Markdown notes, synced to your account and searchable.",
      category: "productivity",
      icon: "StickyNote",
      iconGradient: "from-amber-300 to-yellow-500",
      type: "app",
      requiresDocker: false,
    },
    manifest: {
      id: "notes",
      name: "Notes",
      icon: "StickyNote",
      iconGradient: "from-amber-300 to-yellow-500",
      category: "productivity",
      description: "Quick Markdown notes.",
      kind: "package",
      minRole: "user",
      window: { defaultWidth: 820, defaultHeight: 600, minWidth: 540, minHeight: 380, resizable: true },
      showOnDesktop: true,
    },
  },

  {
    info: {
      id: "containers",
      name: "Container Manager",
      version: "1.0.0",
      publisher: "OpenNAS",
      description: "Manage Docker containers, images and compose stacks on your NAS. Install it only if you run containers.",
      category: "system",
      icon: "Boxes",
      iconGradient: "from-sky-400 to-cyan-600",
      type: "app",
      requiresDocker: true,
    },
    manifest: {
      id: "containers",
      name: "Containers",
      icon: "Boxes",
      iconGradient: "from-sky-400 to-cyan-600",
      category: "system",
      description: "Manage Docker containers and images on your NAS.",
      kind: "package",
      minRole: "admin",
      window: { defaultWidth: 860, defaultHeight: 640, minWidth: 560, minHeight: 420, resizable: true },
      showOnDesktop: true,
    },
  },
  {
    info: {
      id: "virtual-machines",
      name: "Virtual Machines",
      version: "1.0.0",
      publisher: "OpenNAS",
      description: "Create and run KVM/QEMU virtual machines with an in-browser console. Needs libvirt + KVM on the host.",
      category: "system",
      icon: "MonitorPlay",
      iconGradient: "from-violet-400 to-purple-600",
      type: "app",
      requiresDocker: false,
    },
    manifest: {
      id: "virtual-machines",
      name: "Virtual Machines",
      icon: "MonitorPlay",
      iconGradient: "from-violet-400 to-purple-600",
      category: "system",
      description: "Create and run KVM/QEMU virtual machines on your NAS.",
      kind: "package",
      minRole: "admin",
      window: { defaultWidth: 880, defaultHeight: 640, minWidth: 600, minHeight: 440, resizable: true },
      showOnDesktop: true,
    },
  },

  // ---- Container-based services (managed via Docker on the host) ----------
  {
    info: {
      id: "jellyfin",
      name: "Jellyfin",
      version: "10.9",
      publisher: "Jellyfin",
      description: "The free software media system - stream your movies, shows and music anywhere.",
      category: "media",
      icon: "Clapperboard",
      iconGradient: "from-violet-500 to-purple-700",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "jellyfin/jellyfin",
      ports: [{ host: 8096, container: 8096 }],
      volumes: [
        { name: "config", container: "/config" },
        { name: "cache", container: "/cache" },
        { name: "media", container: "/media" },
      ],
      webPort: 8096,
    },
  },
  {
    info: {
      id: "vaultwarden",
      name: "Vaultwarden",
      version: "1.32",
      publisher: "Community",
      description: "Lightweight, self-hosted Bitwarden-compatible password manager.",
      category: "utilities",
      icon: "ShieldCheck",
      iconGradient: "from-blue-500 to-indigo-700",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "vaultwarden/server:latest",
      ports: [{ host: 8222, container: 80 }],
      volumes: [{ name: "data", container: "/data" }],
      webPort: 8222,
    },
  },
  {
    info: {
      id: "gitea",
      name: "Gitea",
      version: "1.22",
      publisher: "Gitea",
      description: "Painless self-hosted Git service with a familiar web UI.",
      category: "developer",
      icon: "GitBranch",
      iconGradient: "from-emerald-500 to-teal-700",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "gitea/gitea:latest",
      ports: [{ host: 3000, container: 3000 }, { host: 2222, container: 22 }],
      volumes: [{ name: "data", container: "/data" }],
      webPort: 3000,
    },
  },
  {
    info: {
      id: "pihole",
      name: "Pi-hole",
      version: "6.0",
      publisher: "Pi-hole",
      description: "Network-wide ad blocking via a DNS sinkhole. Protect every device on your LAN.",
      category: "utilities",
      icon: "ShieldBan",
      iconGradient: "from-rose-500 to-red-700",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "pihole/pihole:latest",
      ports: [
        { host: 53, container: 53, proto: "tcp" },
        { host: 53, container: 53, proto: "udp" },
        { host: 8081, container: 80 },
      ],
      volumes: [
        { name: "etc-pihole", container: "/etc/pihole" },
        { name: "dnsmasq.d", container: "/etc/dnsmasq.d" },
      ],
      env: { TZ: "UTC", WEBPASSWORD: "changeme" },
      webPort: 8081,
    },
  },
  {
    info: {
      id: "nextcloud",
      name: "Nextcloud",
      version: "30",
      publisher: "Nextcloud",
      description: "Your own cloud: files, calendar, contacts and collaboration, fully self-hosted.",
      category: "productivity",
      icon: "Cloud",
      iconGradient: "from-sky-500 to-blue-700",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "nextcloud:latest",
      ports: [{ host: 8080, container: 80 }],
      volumes: [{ name: "html", container: "/var/www/html" }],
      webPort: 8080,
    },
  },
  {
    info: {
      id: "immich",
      name: "Immich",
      version: "1.118",
      publisher: "Immich",
      description: "High-performance photo and video backup - a self-hosted Google Photos alternative.",
      category: "media",
      icon: "Images",
      iconGradient: "from-fuchsia-500 to-pink-700",
      type: "service",
      requiresDocker: true,
    },
  },
  {
    info: {
      id: "home-assistant",
      name: "Home Assistant",
      version: "2025.6",
      publisher: "Open Home Foundation",
      description: "Open-source home automation that puts local control and privacy first.",
      category: "utilities",
      icon: "House",
      iconGradient: "from-cyan-500 to-sky-700",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "ghcr.io/home-assistant/home-assistant:stable",
      ports: [{ host: 8123, container: 8123 }],
      volumes: [{ name: "config", container: "/config" }],
      webPort: 8123,
    },
  },
  {
    info: {
      id: "portainer",
      name: "Portainer",
      version: "2.21",
      publisher: "Portainer",
      description: "A friendly web UI to manage your Docker containers, images, volumes and networks.",
      category: "developer",
      icon: "Boxes",
      iconGradient: "from-blue-400 to-cyan-600",
      type: "service",
      requiresDocker: true,
    },
    service: {
      image: "portainer/portainer-ce:latest",
      ports: [{ host: 9000, container: 9000 }],
      volumes: [{ name: "data", container: "/data" }],
      hostMounts: [{ host: "/var/run/docker.sock", container: "/var/run/docker.sock" }],
      webPort: 9000,
    },
  },
];

export function getPackageDef(id: string): PackageDef | undefined {
  return CATALOG.find((p) => p.info.id === id);
}

/** App manifests contributed by the given set of installed package ids. */
export function manifestsForInstalled(installedIds: Set<string>): AppManifest[] {
  return CATALOG.filter((p) => p.manifest && installedIds.has(p.info.id)).map((p) => p.manifest!);
}
