import { spawn } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";

/**
 * Real-OS integration adapter. In "demo" mode every function is a safe no-op
 * (so dev and non-root installs never touch the host); in "linux" mode it drives
 * the actual file-sharing daemons. OpenNAS still *generates* the config files
 * elsewhere (services.ts) - this module reloads the daemons and syncs the Samba
 * user database so those configs take effect.
 *
 * All operations are best-effort: failures are logged, never thrown, so a flaky
 * daemon can't break the API.
 */

export function linuxMode(): boolean {
  return config.systemMode === "linux";
}

const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/;

interface RunResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

function run(cmd: string, args: string[], input?: string, env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => resolve({ ok: false, code: null, stderr: `failed to spawn ${cmd}` }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Like `run`, but keeps stdout. Used only where the *output* is the point (the
 * group database); everything else deliberately discards it.
 */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

async function tryRun(log: FastifyBaseLogger, cmd: string, args: string[], input?: string): Promise<boolean> {
  const r = await run(cmd, args, input);
  if (!r.ok) {
    log.warn({ cmd, args: input ? [...args, "<stdin>"] : args, code: r.code, stderr: r.stderr.slice(0, 300) }, "system command failed");
  }
  return r.ok;
}

/**
 * Run a privileged command. The backend runs as the unprivileged `opennas` user;
 * `doas` (scoped in /etc/doas.d/opennas.conf to exactly these tools) elevates it.
 */
function priv(log: FastifyBaseLogger, cmd: string, args: string[], input?: string): Promise<boolean> {
  return tryRun(log, "doas", [cmd, ...args], input);
}

/** Reload the file-sharing daemons so freshly-written configs take effect. */
export async function reloadFileServices(log: FastifyBaseLogger): Promise<void> {
  if (!linuxMode()) return;
  // Samba: re-read smb.conf without dropping client connections.
  await priv(log, "smbcontrol", ["all", "reload-config"]);
  // NFS: re-export everything in /etc/exports.
  await priv(log, "exportfs", ["-ra"]);
  // AFP/netatalk: reload (no-op if not installed/running).
  await priv(log, "rc-service", ["netatalk", "reload"]);
}

/** OpenRC service unit for each OpenNAS file-sharing service. */
const FILE_SERVICE_UNIT: Record<"smb" | "nfs" | "afp", string> = {
  smb: "samba",
  nfs: "nfs",
  afp: "netatalk",
};

/**
 * Make each file-sharing daemon's running + boot state match the OpenNAS services
 * config: enabled → add to the default runlevel and start; disabled → stop and
 * remove. This is what makes a service toggled off in the UI actually stop (and
 * stay off across reboots) instead of running by default. Best-effort; the
 * appliance installer no longer auto-enables these, so OpenNAS is the only owner.
 * Called on every services change and once at startup. No-op in demo mode.
 */
export async function applyServiceStates(
  log: FastifyBaseLogger,
  state: { smb?: boolean; nfs?: boolean; afp?: boolean },
): Promise<void> {
  if (!linuxMode()) return;
  for (const key of ["smb", "nfs", "afp"] as const) {
    const enabled = state[key];
    if (enabled === undefined) continue;
    const unit = FILE_SERVICE_UNIT[key];
    if (enabled) {
      await priv(log, "rc-update", ["add", unit]);
      await priv(log, "rc-service", [unit, "start"]);
    } else {
      await priv(log, "rc-service", [unit, "stop"]);
      await priv(log, "rc-update", ["del", unit]);
    }
  }
}

/**
 * Ensure a system + Samba account exists for an OpenNAS user, with the given
 * password - so SMB `valid users = <name>` can authenticate them. Called whenever
 * a password is set (create / admin reset / first-run setup), since OpenNAS only
 * has the plaintext at that moment (it stores a scrypt hash, not the NT hash).
 */
export async function syncShareUser(log: FastifyBaseLogger, username: string, password: string): Promise<void> {
  if (!linuxMode()) return;
  if (!SAFE_NAME.test(username)) {
    log.warn({ username }, "refusing to sync share user with unsafe name");
    return;
  }
  // Create a locked, login-less system user if it doesn't exist yet.
  const exists = await run("id", [username]);
  if (!exists.ok) {
    await priv(log, "adduser", ["-S", "-D", "-H", "-s", "/sbin/nologin", username]);
  }
  // Set + enable the Samba password (smbpasswd reads "new\nconfirm\n" on stdin).
  await priv(log, "smbpasswd", ["-s", "-a", username], `${password}\n${password}\n`);
  await priv(log, "smbpasswd", ["-e", username]);
}

/**
 * Mirror an OpenNAS group into a system group, with the right members.
 *
 * Samba resolves `valid users = @editors` through the system group database,
 * not through anything OpenNAS keeps, so the group has to exist there and its
 * membership has to match. Members are reconciled rather than appended: someone
 * removed from the group in the UI must actually lose access.
 */
export async function syncShareGroup(
  log: FastifyBaseLogger,
  groupName: string,
  usernames: string[],
): Promise<void> {
  if (!linuxMode()) return;
  if (!SAFE_NAME.test(groupName)) {
    log.warn({ groupName }, "refusing to sync share group with unsafe name");
    return;
  }
  const exists = await run("getent", ["group", groupName]);
  if (!exists.ok) await priv(log, "addgroup", ["-S", groupName]);

  // Current members, so this converges instead of only ever growing.
  const current = new Set<string>();
  const entry = await runCapture("getent", ["group", groupName]);
  const members = entry.split(":")[3]?.trim();
  if (members) for (const m of members.split(",")) if (m) current.add(m);

  const wanted = new Set(usernames.filter((u) => SAFE_NAME.test(u)));
  for (const user of wanted) if (!current.has(user)) await priv(log, "addgroup", [user, groupName]);
  for (const user of current) if (!wanted.has(user)) await priv(log, "delgroup", [user, groupName]);
}

/** Remove the system group behind a deleted OpenNAS group. */
export async function removeShareGroup(log: FastifyBaseLogger, groupName: string): Promise<void> {
  if (!linuxMode()) return;
  if (!SAFE_NAME.test(groupName)) return;
  await priv(log, "delgroup", [groupName]);
}

/** Remove the Samba + system account for a deleted OpenNAS user. */
export async function removeShareUser(log: FastifyBaseLogger, username: string): Promise<void> {
  if (!linuxMode()) return;
  if (!SAFE_NAME.test(username)) return;
  await priv(log, "smbpasswd", ["-x", username]);
  await priv(log, "deluser", [username]);
}

/** Reload the web reverse proxy (nginx) - e.g. after replacing the TLS cert. */
export async function reloadWebProxy(log: FastifyBaseLogger): Promise<void> {
  if (!linuxMode()) return;
  await priv(log, "rc-service", ["nginx", "reload"]);
}

/** Reboot or power off the whole NAS. */
export async function powerAction(log: FastifyBaseLogger, action: "reboot" | "poweroff"): Promise<boolean> {
  if (!linuxMode()) {
    log.warn({ action }, "power action requested in demo mode - ignored");
    return false;
  }
  // Give the HTTP response a moment to flush before the box goes down.
  setTimeout(() => void priv(log, action, []), 800);
  return true;
}

/**
 * Initialize a blank disk: GPT + one partition + filesystem + mount it as a data
 * volume. Delegated to the privileged opennas-storage helper (scoped via doas).
 * DESTRUCTIVE - the caller must confirm the disk is unconfigured first.
 */
export async function initializeDisk(
  log: FastifyBaseLogger,
  disk: string,
  fsType: string,
  label: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!linuxMode()) {
    log.warn({ disk }, "disk init requested in demo mode - ignored");
    return { ok: false, error: "Disk management is only available on the installed appliance." };
  }
  const r = await run("doas", ["/usr/lib/opennas/opennas-storage", "init", disk, fsType, label]);
  if (!r.ok) {
    log.warn({ disk, code: r.code, stderr: r.stderr.slice(0, 400) }, "disk init failed");
    return { ok: false, error: r.stderr.trim().split("\n").pop() || "Disk initialization failed." };
  }
  return { ok: true };
}

/**
 * Claim a disk's unallocated space as a new data volume, leaving every existing
 * partition alone. Unlike initializeDisk this is allowed on the system disk -
 * on a single-disk machine that's the only place a data volume can come from.
 */
export async function expandDisk(
  log: FastifyBaseLogger,
  disk: string,
  fsType: string,
  label: string,
  size?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!linuxMode()) {
    log.warn({ disk }, "disk expand requested in demo mode - ignored");
    return { ok: false, error: "Disk management is only available on the installed appliance." };
  }
  const args = ["/usr/lib/opennas/opennas-storage", "init-free", disk, fsType, label];
  if (size) args.push(size);
  const r = await run("doas", args);
  if (!r.ok) {
    log.warn({ disk, code: r.code, stderr: r.stderr.slice(0, 400) }, "disk expand failed");
    return { ok: false, error: r.stderr.trim().split("\n").pop() || "Could not create the volume." };
  }
  return { ok: true };
}

const SYSCTL = "/usr/lib/opennas/opennas-sysctl";
const STORAGE = "/usr/lib/opennas/opennas-storage";
const FIREWALL = config.firewallHelper;

/** Run a privileged opennas helper and return success + last error line. */
async function helper(log: FastifyBaseLogger, bin: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!linuxMode()) {
    log.warn({ bin, args }, "system change requested in demo mode - ignored");
    return { ok: false, error: "Only available on the installed appliance." };
  }
  const r = await run("doas", [bin, ...args]);
  if (!r.ok) {
    log.warn({ bin, args, code: r.code, stderr: r.stderr.slice(0, 400) }, "helper failed");
    return { ok: false, error: r.stderr.trim().split("\n").pop() || "Command failed." };
  }
  return { ok: true };
}

/** Start the Docker daemon (linux mode) so the Container manager can reach it. */
export const startDockerDaemon = (log: FastifyBaseLogger) => helper(log, "rc-service", ["docker", "start"]);

/** Enable/disable + start/stop the SSH daemon (linux mode). */
export const setSshService = (log: FastifyBaseLogger, enabled: boolean) =>
  helper(log, SYSCTL, ["ssh", enabled ? "enable" : "disable"]);

/** Write the SSH user's authorized_keys (keys piped on stdin via the helper). */
export async function applySshKeys(log: FastifyBaseLogger, user: string, body: string): Promise<boolean> {
  if (!linuxMode() || !user) return false;
  return priv(log, SYSCTL, ["ssh", "keys", user], body);
}

export const setHostname = (log: FastifyBaseLogger, name: string) => helper(log, SYSCTL, ["hostname", name]);
export const setTimezone = (log: FastifyBaseLogger, tz: string) => helper(log, SYSCTL, ["timezone", tz]);
export const setNtpServer = (log: FastifyBaseLogger, server: string) => helper(log, SYSCTL, ["ntp", server]);
export const runSystemUpdate = (log: FastifyBaseLogger) => helper(log, SYSCTL, ["update"]);

export function setInterface(
  log: FastifyBaseLogger,
  iface: string,
  cfg: { mode: "dhcp" | "static"; ip?: string; cidr?: string; gateway?: string; dns?: string },
): Promise<{ ok: boolean; error?: string }> {
  const args =
    cfg.mode === "static"
      ? ["iface", iface, "static", cfg.ip ?? "", cfg.cidr ?? "", cfg.gateway ?? "", cfg.dns ?? ""]
      : ["iface", iface, "dhcp"];
  return helper(log, SYSCTL, args);
}

// ---- Per-share quotas ------------------------------------------------------

export interface QuotaStatus {
  fstype: string;
  supported: boolean;
  active: boolean;
  reason: string;
}

/** Parse the helper's `key=value` lines into an object. */
function parseKv(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

/** Whether a volume can take project quotas, and whether they're switched on. */
export async function quotaStatus(label: string): Promise<QuotaStatus> {
  if (!linuxMode()) {
    return { fstype: "", supported: false, active: false, reason: "Only available on the installed appliance." };
  }
  const out = await runCapture("doas", [STORAGE, "quota-status", label]);
  const kv = parseKv(out);
  return {
    fstype: kv.fstype ?? "",
    supported: kv.supported === "yes",
    active: kv.active === "yes",
    reason: kv.reason ?? "",
  };
}

export const enableQuotas = (log: FastifyBaseLogger, label: string) =>
  helper(log, STORAGE, ["quota-enable", label]);

export const setShareQuota = (log: FastifyBaseLogger, label: string, share: string, projectId: number, bytes: number) =>
  helper(log, STORAGE, ["quota-set", label, share, String(projectId), String(Math.max(0, Math.floor(bytes)))]);

/** Bytes used and the limit in force, straight from the filesystem. */
export async function getShareQuota(label: string, projectId: number): Promise<{ usedBytes: number; limitBytes: number }> {
  if (!linuxMode()) return { usedBytes: 0, limitBytes: 0 };
  const kv = parseKv(await runCapture("doas", [STORAGE, "quota-get", label, String(projectId)]));
  return { usedBytes: Number(kv.used ?? 0) || 0, limitBytes: Number(kv.limit ?? 0) || 0 };
}

export const mountVolume = (log: FastifyBaseLogger, label: string) => helper(log, STORAGE, ["mount", label]);
export const unmountVolume = (log: FastifyBaseLogger, label: string) => helper(log, STORAGE, ["unmount", label]);
export const eraseVolume = (log: FastifyBaseLogger, label: string) => helper(log, STORAGE, ["erase", label]);

/**
 * Build an mdadm RAID array from blank disks, then format + mount it as a data
 * volume. DESTRUCTIVE - the caller must confirm every member disk is unconfigured.
 */
export const createRaid = (
  log: FastifyBaseLogger,
  opts: { level: string; label: string; fsType: string; disks: string[] },
) => helper(log, STORAGE, ["raid-create", opts.level, opts.label, opts.fsType, ...opts.disks]);

/** Stop + remove a RAID array (by md device, e.g. "md0") and zero its members. */
export const destroyRaid = (log: FastifyBaseLogger, md: string) => helper(log, STORAGE, ["raid-destroy", md]);

/** Add a blank disk to an array - rebuilds a degraded array or adds a hot spare. */
export const raidAddDisk = (log: FastifyBaseLogger, md: string, disk: string) =>
  helper(log, STORAGE, ["raid-add", md, disk]);

/** Fail + remove a member from an array (and zero it), e.g. to drop a dead disk. */
export const raidRemoveDisk = (log: FastifyBaseLogger, md: string, disk: string) =>
  helper(log, STORAGE, ["raid-remove", md, disk]);

// ---- Firewall --------------------------------------------------------------

/**
 * Load a generated nftables ruleset. The helper validates it with `nft -c`
 * before loading and only persists it after a successful load, so a ruleset
 * that would take the box off the network can never be the one that survives a
 * reboot.
 */
export async function applyFirewall(
  log: FastifyBaseLogger,
  rulesetPath: string,
): Promise<{ ok: boolean; error?: string }> {
  return helper(log, FIREWALL, ["apply", rulesetPath]);
}

/** Remove OpenNAS's table, leaving Docker's and libvirt's in place. */
export async function disableFirewall(log: FastifyBaseLogger): Promise<{ ok: boolean; error?: string }> {
  return helper(log, FIREWALL, ["disable"]);
}

/** "active" | "inactive" | "unavailable" - the last when nftables isn't installed. */
export async function firewallStatus(): Promise<"active" | "inactive" | "unavailable"> {
  if (!linuxMode()) return "unavailable";
  const out = (await runCapture("doas", [FIREWALL, "status"])).trim();
  return out === "active" || out === "inactive" ? out : "unavailable";
}

/** (Re)generate the self-signed TLS certificate, then reload nginx. */
export async function regenerateSelfSignedCert(log: FastifyBaseLogger): Promise<boolean> {
  if (!linuxMode()) {
    log.warn("self-signed regen requested in demo mode - ignored");
    return false;
  }
  const r = await run(config.genCertScript, [], undefined, { FORCE: "1" });
  if (!r.ok) {
    log.warn({ code: r.code, stderr: r.stderr.slice(0, 300) }, "self-signed cert regen failed");
    return false;
  }
  await reloadWebProxy(log);
  return true;
}
