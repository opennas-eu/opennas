import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/**
 * Runtime configuration, sourced from environment variables with sane defaults
 * for local development. On a real NAS deploy these come from the systemd unit
 * or a Docker env file.
 */

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

/**
 * A directory only the service account may enter.
 *
 * `mkdir` applies the process umask, so asking for 0700 on a box with the usual
 * 022 umask still yields 0755 - the mode has to be set explicitly afterwards,
 * and on every start rather than only at creation, so an install made before
 * this existed is repaired rather than left open.
 */
function ensurePrivateDir(path: string): string {
  ensureDir(path);
  try {
    chmodSync(path, 0o700);
  } catch {
    // Not fatal: an operator may have deliberately given the directory to a
    // group, and refusing to start over a permission we only tightened would be
    // worse than the exposure we are closing.
  }
  return path;
}

/**
 * The data directory holds the database, and the database holds TOTP secrets in
 * the clear, session ids that *are* the session cookie, and the SMTP password.
 * It was being created 0755 with a 0644 database inside it, so any other local
 * account could read all three - enough to mint valid second-factor codes and
 * to impersonate anyone currently signed in.
 */
const dataDir = ensurePrivateDir(resolve(env("OPENNAS_DATA_DIR", "./data")));

/**
 * How OpenNAS touches the host OS. "demo" only *generates* configs (safe for dev
 * and non-root); "linux" applies them to the real system - writes the daemon
 * config files, reloads smbd/nfsd/netatalk, and syncs Samba users. Set to
 * "linux" on the installed appliance (the installer does this).
 */
const systemMode: "demo" | "linux" =
  env("OPENNAS_SYSTEM_MODE", "demo") === "linux" ? "linux" : "demo";

/**
 * The running version, read from the VERSION file the build lays down beside
 * the server bundle.
 *
 * Read at startup rather than compiled in: after a self-update the payload on
 * disk is a different version, and a hardcoded string would have the About
 * screen and the update checker both confidently reporting the old one.
 */
function readVersion(): string {
  for (const candidate of [
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "VERSION"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "VERSION"),
  ]) {
    try {
      const v = readFileSync(candidate, "utf8").trim();
      if (v) return v;
    } catch {
      /* try the next */
    }
  }
  return env("OPENNAS_VERSION", "0.0.0-dev");
}

export const config = {
  /** Version of the payload actually running. Surfaced in System Info + updates. */
  version: readVersion(),

  host: env("OPENNAS_HOST", "0.0.0.0"),
  /**
   * Whose `X-Forwarded-For` to believe.
   *
   * This was `true`, meaning *anyone's*. The API binds every interface so nginx
   * can reach it, which also means anything on the LAN can - and a request
   * arriving there with a forged header was taken at its word. That let a
   * client write whatever source address it liked into the audit log, get a
   * fresh allowance from the per-IP rate limiter on every request by rotating
   * the header, and (once failed sign-ins started earning a firewall ban) aim
   * that ban at an address of its choosing.
   *
   * `loopback` is proxy-addr's name for 127.0.0.1/8 and ::1 - exactly nginx on
   * this machine, which is the only proxy in front of OpenNAS by default.
   * Override it only when a real proxy sits on a different host.
   */
  trustedProxies: env("OPENNAS_TRUSTED_PROXIES", "loopback"),
  port: intEnv("OPENNAS_PORT", 4174),

  dataDir,
  dbPath: resolve(dataDir, env("OPENNAS_DB_FILE", "opennas.sqlite")),

  /**
   * Root directory exposed by the Files app. Everything the UI can see lives
   * under here; path traversal outside it is rejected. Defaults to a "shared"
   * folder inside the data dir for safe out-of-the-box behaviour.
   */
  filesRoot: ensureDir(resolve(dataDir, env("OPENNAS_FILES_ROOT", "shared"))),

  /**
   * Where mounted data volumes live, one sub-directory per volume label (the
   * Storage Manager mounts disks at `<volumesRoot>/<label>`). A shared folder can
   * be placed on a specific volume instead of the default share root; its files
   * then live at `<volumesRoot>/<label>/<shareName>`.
   */
  volumesRoot: ensureDir(
    resolve(env("OPENNAS_VOLUMES_ROOT", systemMode === "linux" ? "/var/lib/opennas/volumes" : resolve(dataDir, "volumes"))),
  ),

  /**
   * System account that owns the shared data tree. Samba `force user`/`force
   * group` map every connection to it, so an authenticated user can actually read
   * and write the folders (which are owned by this account on disk) regardless of
   * their own uid. Empty disables forcing (demo: no real daemons to satisfy).
   */
  shareOwner: env("OPENNAS_SHARE_USER", systemMode === "linux" ? "opennas" : ""),

  /** Console/recovery admin account SSH access + authorized keys apply to (the
   *  non-root user the installer creates). Empty disables SSH key management. */
  sshUser: env("OPENNAS_SSH_USER", ""),

  /** Where uploaded user profile pictures are stored. */
  avatarsDir: ensureDir(resolve(dataDir, "avatars")),

  /** Recycle bin: soft-deleted files/folders are moved here (one entry per id),
   *  tracked in the `trash_items` table, until restored or permanently removed. */
  trashDir: ensureDir(resolve(dataDir, "recycle")),

  /** On-disk cache of File Station image thumbnails. Files are keyed by a hash of
   *  the source path + mtime + size, so a re-uploaded image regenerates itself.
   *  Safe to wipe at any time - entries are lazily rebuilt on next request. */
  thumbsDir: ensureDir(resolve(dataDir, "thumbs")),

  /**
   * Container service volumes + compose stacks, and VM disks + ISOs, all default
   * to sub-dirs of the data dir but are admin-relocatable to any mounted volume
   * at runtime - see `system/storage-paths.ts`, which owns the effective paths
   * (`servicesDir()` / `stacksDir()` / `vmDisksDir()` / `isoDir()`). Kept out of
   * this static config so a changed location takes effect without a restart.
   */

  /**
   * Installed third-party apps (the app framework). Each app is extracted to
   * `<appsDir>/<id>/` and served read-only at /app-content/<id>/... into a
   * sandboxed iframe. Lives under the data dir so it's owned by the service user.
   */
  appsDir: ensureDir(resolve(dataDir, "apps")),

  /**
   * Installed custom themes (`.onthm`). Each is extracted to `<themesDir>/<id>/`;
   * any packaged wallpaper image is served read-only at /theme-content/<id>/....
   */
  themesDir: ensureDir(resolve(dataDir, "themes")),

  /** Built-in OIDC identity provider - holds the persisted RS256 signing key. */
  oidcDir: ensureDir(resolve(dataDir, "oidc")),

  /**
   * Private file storage for installed apps (the "files" capability), one folder
   * per app *and* per user: `<appDataDir>/<appId>/<userId>/...`. Never served
   * publicly - apps reach it only through the scoped /apps/:id/files API.
   */
  appDataDir: ensureDir(resolve(dataDir, "app-data")),

  /**
   * File-sharing configs OpenNAS generates from your shares are mirrored here on
   * every change, so they can be symlinked/included by the real daemons.
   */
  generatedDir: ensureDir(resolve(dataDir, "generated")),

  /**
   * Optional real paths for the generated configs. When set (and writable),
   * OpenNAS writes smb.conf / exports straight to the daemon locations so a
   * created share is live without any manual copying.
   */
  /** demo = generate configs only; linux = apply to the real OS + reload daemons. */
  systemMode,
  smbConfPath: env("OPENNAS_SMB_CONF", systemMode === "linux" ? "/etc/samba/smb.conf" : ""),
  nfsExportsPath: env("OPENNAS_NFS_EXPORTS", systemMode === "linux" ? "/etc/exports" : ""),
  /**
   * Where the generated Time Machine mDNS advertisement goes. Separate from the
   * static `opennas.service` file so regenerating it as shares change can never
   * damage the machine's own advertisement - avahi reads every file in the
   * directory independently.
   */
  timeMachineAvahiPath: env(
    "OPENNAS_TM_AVAHI",
    systemMode === "linux" ? "/etc/avahi/services/opennas-timemachine.service" : "",
  ),

  /** Where the TLS cert/key the reverse proxy serves live (cert.pem / key.pem). */
  tlsDir: env("OPENNAS_TLS_DIR", systemMode === "linux" ? "/etc/opennas/tls" : resolve(dataDir, "tls")),
  /** Script that (re)generates the self-signed certificate on the appliance. */
  genCertScript: env("OPENNAS_GENCERT", "/usr/lib/opennas/gen-self-signed-cert.sh"),
  firewallHelper: env("OPENNAS_FIREWALL_HELPER", "/usr/lib/opennas/opennas-firewall"),
  updateHelper: env("OPENNAS_UPDATE_HELPER", "/usr/lib/opennas/opennas-update"),
  zfsHelper: env("OPENNAS_ZFS_HELPER", "/usr/lib/opennas/opennas-zfs"),
  /**
   * How long a firewall change stays live before reverting itself unless it is
   * confirmed. Long enough to notice a working page, short enough that a
   * lock-out resolves before anyone reaches for a keyboard and monitor.
   */
  firewallRevertSeconds: Math.min(600, Math.max(15, intEnv("OPENNAS_FIREWALL_REVERT_SECONDS", 90))),

  /**
   * Secret used to sign session cookies. Auto-generated and persisted on first
   * run so sessions survive restarts; override in prod for multi-node.
   */
  sessionSecret: loadOrCreateSecret(resolve(dataDir, ".session-secret")),

  /** Session lifetime. */
  sessionTtlMs: intEnv("OPENNAS_SESSION_TTL_HOURS", 24 * 7) * 60 * 60 * 1000,

  /** Send the Secure cookie flag (requires HTTPS). Auto-off in dev. */
  cookieSecure: env("OPENNAS_COOKIE_SECURE", "auto"),

  /**
   * Allowed browser origins for the decoupled frontend. Empty = same-origin only
   * (the default reverse-proxy topology, where the proxy serves the SPA and
   * forwards /api). Set a comma-separated list to let a frontend on a *different*
   * origin call the API with credentials - this also switches the session cookie
   * to SameSite=None;Secure (so it requires HTTPS on both ends).
   */
  corsOrigins: env("OPENNAS_CORS_ORIGINS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * WebAuthn relying party. rpID must equal the site's effective domain
   * (no scheme/port); origin must be the full origin the browser sees.
   */
  webauthn: {
    rpName: env("OPENNAS_RP_NAME", "OpenNAS"),
    rpID: env("OPENNAS_RP_ID", "localhost"),
    origin: env("OPENNAS_ORIGIN", "http://localhost:5173"),
  },

  /**
   * OIDC client ("Login with SSO"). Disabled unless issuer + client id given.
   * Point this at Authentik / Keycloak / Authelia / etc.
   */
  oidc: {
    enabled: Boolean(process.env.OPENNAS_OIDC_ISSUER && process.env.OPENNAS_OIDC_CLIENT_ID),
    issuer: env("OPENNAS_OIDC_ISSUER", ""),
    clientId: env("OPENNAS_OIDC_CLIENT_ID", ""),
    clientSecret: env("OPENNAS_OIDC_CLIENT_SECRET", ""),
    /** Must be registered in the IdP exactly. */
    redirectUri: env("OPENNAS_OIDC_REDIRECT_URI", "http://localhost:5173/api/auth/oidc/callback"),
    scopes: env("OPENNAS_OIDC_SCOPES", "openid profile email"),
    buttonLabel: env("OPENNAS_OIDC_BUTTON_LABEL", "Login with SSO"),
    /** Auto-provision a local user on first SSO login. */
    autoCreateUsers: env("OPENNAS_OIDC_AUTOCREATE", "true") === "true",
  },

  /** Path to the built web UI, served as static files in production. */
  webDist: resolve(env("OPENNAS_WEB_DIST", "../web/dist")),

  isProd: env("NODE_ENV", "development") === "production",
} as const;

function loadOrCreateSecret(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  } catch {
    /* fall through to regenerate */
  }
  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, secret, { mode: 0o600 });
  } catch {
    /* non-fatal: fall back to in-memory secret */
  }
  return secret;
}

/** True when a frontend on a different origin is allowed to call the API. */
export function isCrossOrigin(): boolean {
  return config.corsOrigins.length > 0;
}

export function shouldUseSecureCookie(isHttps?: boolean): boolean {
  // SameSite=None (cross-origin) mandates Secure, so force it on in that mode.
  if (isCrossOrigin()) return true;
  if (config.cookieSecure === "true") return true;
  if (config.cookieSecure === "false") return false;
  // "auto": only mark the cookie Secure when the client is actually on HTTPS -
  // otherwise an appliance served over plain HTTP would have its cookie rejected.
  // (Falls back to NODE_ENV if the request protocol is unknown.)
  return isHttps ?? config.isProd;
}
