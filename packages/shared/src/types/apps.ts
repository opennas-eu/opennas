/**
 * App registry contracts.
 *
 * Everything the desktop can launch is an "app". Built-in apps (System Monitor,
 * Control Panel, Package Center) ship with OpenNAS; installed packages register
 * additional apps through this same shape. This is the seam Package Center
 * plugs into later.
 */

export type AppCategory = "system" | "utilities" | "media" | "productivity" | "developer";

/**
 * Capabilities a third-party (external) app may request in its manifest. The host
 * bridge and the backend both enforce these - an app can only use a capability it
 * has declared. Kept deliberately small for v1.
 */
export type AppPermission =
  | "notifications"
  | "storage"
  | "user"
  | "files"
  | "system"
  | "fetch"
  | "schedule"
  /**
   * Browse and read the user's real shared folders, everywhere that user can.
   * Deliberately separate from `files`, which is a private per-app sandbox:
   * this one reaches the actual NAS contents. Most apps should not ask for it -
   * `shares.pick()` needs no permission at all and gives the app only the folder
   * the user chose. This exists for the apps that genuinely have to scan, like a
   * media indexer.
   */
  | "shares:read"
  /** Create, modify and delete inside the user's shared folders. Implies read. */
  | "shares:write";

export const APP_PERMISSIONS: AppPermission[] = [
  "notifications",
  "storage",
  "user",
  "files",
  "system",
  "fetch",
  "schedule",
  "shares:read",
  "shares:write",
];

export interface AppManifest {
  /** Stable id, e.g. "system-monitor". */
  id: string;
  name: string;
  /**
   * Built-ins/packages: a lucide-react icon name (e.g. "Activity"). External apps
   * may instead ship an image file in the package (e.g. "icon.png") - anything
   * containing a "." is treated as a packaged image served from /app-content.
   */
  icon: string;
  /** Tailwind gradient classes for the icon tile, e.g. "from-sky-400 to-blue-600". */
  iconGradient: string;
  category: AppCategory;
  description: string;
  /**
   * builtin = compiled in; package = bundled component gated by install; external
   * = a third-party web app installed at runtime and rendered in a sandboxed iframe.
   */
  kind: "builtin" | "package" | "external";
  /** Minimum role required to launch. */
  minRole: "admin" | "user";
  /** Default window geometry hints. */
  window: {
    defaultWidth: number;
    defaultHeight: number;
    minWidth: number;
    minHeight: number;
    resizable: boolean;
  };
  /** Show an icon on the desktop by default. */
  showOnDesktop: boolean;

  // ---- External-app fields (kind === "external") --------------------------
  /** App version (semver-ish), e.g. "1.0.0". */
  version?: string;
  /** Author / publisher shown in App Center. */
  author?: string;
  /** Entry HTML loaded into the iframe, relative to the package root. */
  entry?: string;
  /** Capabilities the app declared (and the user therefore granted). */
  permissions?: AppPermission[];
  /** External apps: package carried a valid publisher signature. */
  signed?: boolean;
  /** Publisher key fingerprint (sha256 hex) when signed, else null. */
  publisherFingerprint?: string | null;
  /** Packaged screenshot image paths, shown on the app's detail page. */
  screenshots?: string[];
  /**
   * Hosts the app may reach through the fetch proxy, e.g. `["api.example.com",
   * "*.example.org"]`. Required when the app requests the "fetch" permission -
   * there is no wildcard-everything option, so an admin always approves a
   * concrete list.
   */
  fetchHosts?: string[];
  /**
   * Settings OpenNAS renders a form for. Declared here so the form lives in the
   * trusted UI; the app reads the resolved values with `app.settings.all()`.
   */
  settings?: AppSettingField[];
  /**
   * Development apps only: the dev server to load instead of packaged content.
   * Its presence is what marks an app as a development build.
   */
  devUrl?: string;
}

// ---- Development apps ------------------------------------------------------

/**
 * An app loaded live from a local dev server rather than from an installed
 * package, so a change is a refresh instead of a repack-and-reinstall.
 *
 * Same sandbox and same permission enforcement as a packaged app - only the
 * source of the bytes differs. Restricted to loopback, and admin-only.
 */
export interface DevApp {
  id: string;
  name: string;
  /** http(s) on localhost / 127.0.0.1 / ::1. */
  url: string;
  permissions: AppPermission[];
  enabled: boolean;
}

export interface DevAppsResponse {
  apps: DevApp[];
  /** False in production builds, where dev apps are refused outright. */
  available: boolean;
}

/** GET /api/apps - apps available to the current user. */
export interface AppsResponse {
  apps: AppManifest[];
}

/** POST /api/apps/install - result of installing a .onpkg. */
export interface AppInstallResponse {
  app: AppManifest;
}

/**
 * A validated package held server-side, waiting for an admin to approve what it
 * asks for. Returned with 202 by the install routes when there's something to
 * review; POST the token to /api/apps/install/confirm to go ahead.
 */
export interface PendingInstall {
  /** Single-use token for the staged package. Expires - see `expiresAt`. */
  token: string;
  appId: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** Everything this package requests. */
  permissions: AppPermission[];
  /**
   * Permissions the installed version doesn't already hold - all of them on a
   * fresh install. A non-empty list on an update means the app is asking for more
   * than the user originally granted it.
   */
  newPermissions: AppPermission[];
  /** True when this replaces an already-installed app. */
  isUpdate: boolean;
  signed: boolean;
  publisherFingerprint: string | null;
  /** Signed AND the publisher's key is already trusted. */
  verified: boolean;
  /** Hosts the app declared for the fetch proxy (empty unless it requests "fetch"). */
  fetchHosts: string[];
  expiresAt: string;
}

/** 202 from POST /api/apps/install and /api/apps/repo/install. */
export interface AppInstallPendingResponse {
  pending: PendingInstall;
}

/** What an install route returns: either it's done, or it needs review. */
export type AppInstallResult = AppInstallResponse | AppInstallPendingResponse;

/** Narrowing helper for `AppInstallResult`. */
export function isPendingInstall(r: AppInstallResult): r is AppInstallPendingResponse {
  return "pending" in r;
}

/** An installed external app with its admin state (App Center management view). */
export interface ManagedApp {
  manifest: AppManifest;
  enabled: boolean;
  installedAt: string;
  /** Signed AND the publisher's key is in the trusted set. */
  verified: boolean;
}

/** GET /api/apps/manage - all installed external apps (incl. disabled). */
export interface ManagedAppsResponse {
  apps: ManagedApp[];
}

/** GET /api/apps/:id/storage - all key/value pairs for the current user. */
export interface AppStorageListResponse {
  values: Record<string, string>;
}

/** GET /api/apps/:id/storage/:key */
export interface AppStorageValueResponse {
  /** null when the key isn't set. */
  value: string | null;
}

/** The signed-in user, exposed to an app that holds the "user" permission. */
export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
}

/** An entry in an app's private data folder ("files" permission). */
export interface AppFileEntry {
  name: string;
  type: "file" | "dir";
  sizeBytes: number;
  modifiedAt: string;
}

export interface AppFilesListResponse {
  entries: AppFileEntry[];
}

export interface AppFileReadResponse {
  /** File contents, or null if the file doesn't exist. */
  content: string | null;
}

/**
 * Read-only system snapshot for apps holding the "system" permission.
 *
 * Deliberately narrower than the admin dashboard: no hostname, no process list,
 * no per-interface or per-mount detail. Those either identify the box or reveal
 * what's running on it, and a widget showing CPU load doesn't need them. Storage
 * and network are aggregated for the same reason.
 */
export interface AppSystemInfo {
  os: { platform: string; distro: string; release: string; arch: string };
  cpu: {
    brand: string;
    cores: number;
    /** Overall load, 0-100. */
    loadPercent: number;
    /** Per-core load, 0-100. */
    perCorePercent: number[];
    /** Package temperature in °C, or null when unreadable. */
    temperatureC: number | null;
  };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number };
  /** Totalled across data volumes - individual mounts aren't exposed. */
  storage: { totalBytes: number; usedBytes: number; freeBytes: number };
  /** Totalled across interfaces - interface names aren't exposed. */
  network: { rxBytesPerSec: number; txBytesPerSec: number };
  uptimeSeconds: number;
  /** OpenNAS version. */
  version: string;
}

/** GET /api/apps/:id/system */
export interface AppSystemResponse {
  system: AppSystemInfo;
}

/** POST /api/apps/:id/fetch - an outbound request an app asked OpenNAS to make. */
export interface AppFetchRequest {
  url: string;
  /** GET (default), HEAD, POST, PUT, PATCH or DELETE. */
  method?: string;
  /** Extra request headers. Hop-by-hop, `host` and `cookie` are dropped. */
  headers?: Record<string, string>;
  /** Request body for methods that take one. Max 1 MB. */
  body?: string;
}

export interface AppFetchResponse {
  status: number;
  statusText: string;
  /** Response headers, minus cookies and hop-by-hop ones. */
  headers: Record<string, string>;
  /** Text response as-is; anything else base64 - see `encoding`. */
  body: string;
  encoding: "utf8" | "base64";
  /** The final URL, which differs from the request when redirects were followed. */
  url: string;
}

export type PackageType = "app" | "service";

/** A package as listed in Package Center. "app" packages register a desktop app
 *  on install; "service" packages are container/daemon-based and managed
 *  externally (Docker) on the host. */
export interface PackageInfo {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  category: AppCategory;
  icon: string;
  iconGradient: string;
  type: PackageType;
  /** Service packages need Docker on the host to actually run. */
  requiresDocker: boolean;
  installed: boolean;
  /** running = app/container up; stopped = container down; external = tracked only. */
  status: "running" | "stopped" | "external" | null;
  /** Host port for the service's web UI, when running (for an "Open" link). */
  webPort?: number | null;
}

export interface PackagesResponse {
  packages: PackageInfo[];
  /** Whether the Docker daemon is reachable (service packages can run). */
  dockerRunning: boolean;
}

// ---- App repository (remote catalog, e.g. repo.opennas.eu) -----------------

/** One app from a remote repository catalogue, as surfaced to the App Center. */
export interface RepoApp {
  id: string;
  /** Which configured repository offered this app. */
  repoId: string;
  repoName: string;
  name: string;
  version: string;
  description: string;
  category: string;
  author: string;
  icon: string;
  iconGradient: string;
  signed: boolean;
  publisherFingerprint: string | null;
  downloads: number;
  /** API-relative proxied icon path (`/apps/repo/asset?...`), or null for a lucide name. */
  iconUrl: string | null;
  /** API-relative proxied screenshot paths. */
  screenshots: string[];
  /** Capabilities the app requests, shown for review before installing. */
  permissions: AppPermission[];
  /** Already installed on this NAS. */
  installed: boolean;
}

export interface RepoCatalogResponse {
  /** Name of the first reachable repository - kept for the single-repo header. */
  repository: string;
  url: string;
  apps: RepoApp[];
  /** Per-repository outcome, so the UI can say which one is down rather than "offline". */
  sources: RepoSourceStatus[];
}

/** How one configured repository fared on the last catalogue fetch. */
export interface RepoSourceStatus {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  reachable: boolean;
  /** Apps contributed to the merged catalogue (after duplicates are resolved). */
  appCount: number;
  /** Apps this repo also offers that a higher-priority repo already provided. */
  shadowed: number;
  error: string | null;
}

/**
 * One configured app repository. Order is priority: when two repositories offer
 * the same app id, the earlier one wins and the later is reported as shadowed.
 */
export interface AppRepo {
  /** Stable id derived from the URL; recorded against installed apps. */
  id: string;
  url: string;
  /** Name the repository reports for itself, once it has been reached. */
  name: string;
  enabled: boolean;
}

export interface RepoConfigResponse {
  repos: AppRepo[];
  /** The first enabled repository's URL - what older single-repo callers expect. */
  url: string;
}

// ---- App updates (installed apps vs. the repository catalogue) --------------

/** An installed app that the repository offers a newer version of. */
export interface AppUpdate {
  id: string;
  name: string;
  /** Version currently installed on this NAS. */
  installedVersion: string;
  /** Newer version offered by the repository. */
  availableVersion: string;
  /** Lucide icon name or packaged image path, mirroring the catalogue entry. */
  icon: string;
  iconGradient: string;
  /** API-relative proxied icon path (`/apps/repo/asset?...`), or null for a lucide name. */
  iconUrl: string | null;
  /** The offered package carries a valid publisher signature. */
  signed: boolean;
  /**
   * Permissions the new version wants that the installed one wasn't granted.
   * Non-empty means the update needs explicit approval and will NOT be applied
   * by the automatic updater.
   */
  newPermissions: AppPermission[];
}

/** GET /api/apps/repo/updates */
export interface AppUpdatesResponse {
  updates: AppUpdate[];
  /** ISO timestamp of the last check that actually reached the repository. */
  checkedAt: string | null;
  /** False when the most recent check couldn't reach the repository. */
  repoReachable: boolean;
  /** Whether updates are installed automatically in the background. */
  autoUpdate: boolean;
}

/** POST /api/apps/repo/updates/apply */
export interface AppUpdateApplyResponse {
  updated: { id: string; name: string; version: string }[];
  failed: { id: string; message: string }[];
  /**
   * Updates that ask for permissions the installed version wasn't granted. These
   * are staged, not installed - confirm each via /api/apps/install/confirm.
   */
  pending: PendingInstall[];
}

// ---- Per-app settings ------------------------------------------------------

/**
 * A field an app declares in its manifest so OpenNAS can render a settings form
 * for it. The app never draws this itself - it reads the resolved values through
 * `app.settings.all()`, which keeps the form inside the trusted UI rather than
 * inside the sandbox.
 */
export type AppSettingType = "text" | "number" | "boolean" | "select";

/**
 * "user"  - every account configures its own copy (the default).
 * "admin" - one shared value for the whole box; only an admin may change it.
 */
export type AppSettingScope = "user" | "admin";

export interface AppSettingField {
  key: string;
  label: string;
  type: AppSettingType;
  scope: AppSettingScope;
  description?: string;
  /** Used when nothing has been saved yet. */
  default?: string | number | boolean;
  /** For `select`. */
  options?: { value: string; label: string }[];
  /** For `number`. */
  min?: number;
  max?: number;
  /** For `text`: rendered as a password field and redacted in the audit log. */
  secret?: boolean;
  placeholder?: string;
}

export type AppSettingValue = string | number | boolean;

/** GET /api/apps/:id/settings */
export interface AppSettingsResponse {
  appId: string;
  fields: AppSettingField[];
  /** Resolved values: saved where set, the field default otherwise. */
  values: Record<string, AppSettingValue>;
  /** True when the caller may change admin-scoped fields. */
  canEditAdmin: boolean;
}

/** PUT /api/apps/:id/settings */
export interface AppSettingsUpdateRequest {
  values: Record<string, AppSettingValue>;
}


// ---- Shared-folder access --------------------------------------------------

/**
 * A folder or file the user handed to an app through the host-drawn picker.
 *
 * `handle` is what the app passes back on later calls; `path` and `name` are for
 * showing the user what it has. A grant never outranks the person who gave it -
 * the server re-checks their own access to the path on every use, so revoking a
 * share or a folder rule takes effect immediately regardless of grants.
 */
export interface AppShareGrant {
  handle: string;
  /** Virtual path, e.g. "/Photos/2024". */
  path: string;
  /** Last segment of the path, for display. */
  name: string;
  type: "file" | "dir";
  mode: "read" | "readwrite";
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AppShareGrantsResponse {
  grants: AppShareGrant[];
}

/** One entry inside a shared folder, as an app sees it. */
export interface AppShareEntry {
  name: string;
  type: "file" | "dir";
  sizeBytes: number;
  modifiedAt: string;
  mime: string | null;
  /** Whether this user may write here - apps should grey out rather than fail. */
  writable: boolean;
}

export interface AppShareListResponse {
  path: string;
  entries: AppShareEntry[];
  writable: boolean;
}

/** A grant plus which app holds it, for the user's own review screen. */
export interface UserAppGrant extends AppShareGrant {
  appId: string;
  /** The app's display name, or its id if it is no longer installed. */
  appName: string;
  /** False when the app that holds this is gone - the row is dead weight. */
  appInstalled: boolean;
}

export interface UserAppGrantsResponse {
  grants: UserAppGrant[];
}
