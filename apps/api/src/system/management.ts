import { readFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import si from "systeminformation";
import type { NetworkInfo, TimeInfo, UpdateInfo } from "@opennas/shared";
import { config } from "../config.js";

/** Current network configuration (hostname, interfaces, gateway, DNS). */
export async function getNetwork(): Promise<NetworkInfo> {
  const [ifaces, gateway, dnsRaw] = await Promise.all([
    si.networkInterfaces(),
    si.networkGatewayDefault().catch(() => ""),
    readFile("/etc/resolv.conf", "utf8").catch(() => ""),
  ]);
  const dns = dnsRaw
    .split("\n")
    .filter((l) => l.trim().startsWith("nameserver"))
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((v): v is string => !!v);

  const list = Array.isArray(ifaces) ? ifaces : [ifaces];
  return {
    hostname: osHostname(),
    mdnsName: await mdnsName(),
    gateway: typeof gateway === "string" ? gateway : "",
    dns,
    interfaces: list
      .filter((i) => i.iface !== "lo" && !i.internal)
      .map((i) => ({
        name: i.iface,
        mac: i.mac,
        ip4: i.ip4,
        ip4subnet: i.ip4subnet,
        state: i.operstate,
        dhcp: !!i.dhcp,
        speedMbps: typeof i.speed === "number" && i.speed > 0 ? i.speed : null,
      })),
  };
}

/** Current time / timezone / NTP configuration. */
export async function getTimeInfo(): Promise<TimeInfo> {
  let timezone = "UTC";
  try {
    timezone = (await readFile("/etc/timezone", "utf8")).trim() || timezone;
  } catch {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  let ntpServer: string | null = null;
  for (const p of ["/etc/chrony/chrony.conf", "/etc/chrony.conf"]) {
    try {
      const conf = await readFile(p, "utf8");
      const m = conf.split("\n").find((l) => /^\s*(server|pool)\s+/.test(l));
      if (m) ntpServer = m.trim().split(/\s+/)[1] ?? null;
      break;
    } catch {
      /* try next */
    }
  }
  return { timezone, now: new Date().toISOString(), ntpServer };
}

/** Version / uptime info for the Update & Info panel. */
export async function getUpdateInfo(): Promise<UpdateInfo> {
  const alpineVersion = (await readFile("/etc/alpine-release", "utf8").catch(() => "")).trim() || "-";
  const time = si.time();
  const os = await si.osInfo();
  return {
    opennasVersion: config.version,
    alpineVersion,
    uptimeSeconds: Math.round(time.uptime ?? 0),
    kernel: os.kernel || "",
  };
}

/**
 * The `.local` name the box answers to, or null when nothing is publishing one.
 *
 * Gated on avahi actually running rather than assumed from the hostname:
 * printing "opennas.local" when mDNS is off would send people to a name that
 * doesn't resolve, which is worse than showing them only the IP address.
 * `avahi-daemon --check` exits 0 exactly when a daemon is live.
 */
/**
 * The name this machine is actually reachable by on the local network.
 *
 * Deriving it from the hostname is wrong often enough to matter: when the plain
 * name is already taken on the LAN, avahi resolves the conflict by claiming
 * `name-2.local`, `name-3.local` and so on, and the derived name then resolves
 * for nobody. So avahi is asked what it settled on, and if it can't be asked,
 * the guess is only reported once it has been shown to resolve - an mDNS name
 * in the UI is a promise that typing it into a browser works.
 */
async function mdnsName(): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  try {
    await exec("avahi-daemon", ["--check"], { timeout: 2000 });
  } catch {
    // Not installed, or installed and not running: either way nothing is
    // published and there is no name to offer.
    return null;
  }

  // The daemon's own answer, which accounts for any conflict suffix.
  try {
    const { stdout } = await exec(
      "dbus-send",
      ["--system", "--dest=org.freedesktop.Avahi", "--print-reply=literal", "/", "org.freedesktop.Avahi.Server.GetHostNameFqdn"],
      { timeout: 3000 },
    );
    const name = stdout.trim();
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.local$/.test(name)) return name;
  } catch {
    /* dbus-send missing or avahi not on the bus - fall through */
  }

  // No way to ask, so check the obvious candidate really answers before
  // claiming it does.
  const host = osHostname().split(".")[0];
  if (!host) return null;
  const candidate = `${host}.local`;
  try {
    const { stdout } = await exec("avahi-resolve", ["-4", "-n", candidate], { timeout: 3000 });
    return stdout.trim().length > 0 ? candidate : null;
  } catch {
    return null;
  }
}
