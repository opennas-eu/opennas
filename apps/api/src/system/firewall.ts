import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { FirewallConfig, FirewallService, FirewallServiceId } from "@opennas/shared";
import { getSettingOr, setSetting } from "../db/settings.js";
// Imported under another name: `config` is already the parameter name for a
// firewall configuration throughout this module.
import { config as appConfig } from "../config.js";

const execFile = promisify(execFileCb);

/**
 * Host firewall.
 *
 * A NAS is the machine on the network most worth getting into, and OpenNAS
 * previously shipped with every listening port wide open to anything that could
 * route to it. This generates an nftables ruleset from a small, explicit model
 * - default-deny inbound, with a named toggle per thing OpenNAS actually
 * listens on - and hands it to the privileged helper to load.
 *
 * The model is deliberately coarse. A NAS admin wants "let Windows machines see
 * my shares, don't let anything else in"; they do not want to hand-write a
 * packet filter, and a UI that made them would get switched off entirely.
 */

const SETTING = "firewall";

/**
 * The ports OpenNAS itself listens on, grouped the way an admin thinks about
 * them. Anything not listed here is simply not opened - there is no "allow
 * everything else" escape hatch, because that is the state we are leaving.
 */
export const FIREWALL_SERVICES: FirewallService[] = [
  {
    id: "web",
    name: "Web interface",
    description: "This admin interface, over HTTP and HTTPS.",
    ports: [
      { proto: "tcp", port: 80 },
      { proto: "tcp", port: 443 },
    ],
    /** Closing this locks the admin out of the box, so it is not offered. */
    alwaysOn: true,
  },
  {
    id: "ssh",
    name: "SSH",
    description: "Console access for the admin account.",
    ports: [{ proto: "tcp", port: 22 }],
  },
  {
    id: "smb",
    name: "SMB / CIFS",
    description: "File sharing for Windows, macOS and most file managers.",
    ports: [
      { proto: "tcp", port: 445 },
      { proto: "tcp", port: 139 },
    ],
  },
  {
    id: "nfs",
    name: "NFS",
    description: "File sharing for Unix and Linux hosts.",
    ports: [
      { proto: "tcp", port: 2049 },
      { proto: "udp", port: 2049 },
      { proto: "tcp", port: 111 },
      { proto: "udp", port: 111 },
    ],
  },
  {
    id: "afp",
    name: "AFP",
    description: "Legacy Apple file sharing (Time Machine on older macOS).",
    ports: [{ proto: "tcp", port: 548 }],
  },
  {
    id: "discovery",
    name: "Network discovery",
    description: "Lets this NAS appear by name in Finder and Windows Explorer (mDNS, WS-Discovery).",
    ports: [
      { proto: "udp", port: 5353 },
      { proto: "udp", port: 3702 },
      { proto: "tcp", port: 5357 },
    ],
  },
];

export const DEFAULT_FIREWALL: FirewallConfig = {
  enabled: false,
  // Everything the box serves, on by default: switching the firewall on should
  // close what nobody asked for, not break what already worked.
  allowed: ["web", "ssh", "smb", "nfs", "afp", "discovery"],
  trustedNetworks: [],
  restrictToTrusted: false,
};

export function getFirewallConfig(): FirewallConfig {
  try {
    const parsed = JSON.parse(getSettingOr(SETTING, "")) as Partial<FirewallConfig>;
    return {
      enabled: parsed.enabled === true,
      allowed: Array.isArray(parsed.allowed)
        ? parsed.allowed.filter((id): id is FirewallServiceId =>
            FIREWALL_SERVICES.some((s) => s.id === id))
        : DEFAULT_FIREWALL.allowed,
      trustedNetworks: Array.isArray(parsed.trustedNetworks) ? parsed.trustedNetworks.filter(isValidCidr) : [],
      restrictToTrusted: parsed.restrictToTrusted === true,
    };
  } catch {
    return { ...DEFAULT_FIREWALL };
  }
}

export function setFirewallConfig(config: FirewallConfig): void {
  setSetting(SETTING, JSON.stringify(config));
}

/**
 * Accepts an IPv4 or IPv6 address, with or without a prefix length. Deliberately
 * strict - this string is interpolated into a ruleset, so anything that isn't
 * obviously an address is refused rather than escaped.
 */
export function isValidCidr(value: string): boolean {
  const text = value.trim();
  const [addr, prefix, ...rest] = text.split("/");
  if (rest.length > 0 || !addr) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith("0")))) return false;
    if (prefix === undefined) return true;
    return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32;
  }
  // IPv6: hex groups and at most one "::". Loose on the grouping, strict on the
  // alphabet, which is what matters for safe interpolation.
  if (!/^[0-9a-fA-F:]+$/.test(addr) || (addr.match(/::/g) ?? []).length > 1) return false;
  if (!addr.includes(":")) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= 128;
}

function family(cidr: string): "ip" | "ip6" {
  return cidr.includes(":") ? "ip6" : "ip";
}

/**
 * Render the nftables ruleset. One `inet` table so a single set of rules covers
 * IPv4 and IPv6 - the alternative is two near-identical rulesets that drift.
 */
export function generateRuleset(config: FirewallConfig): string {
  const enabledServices = FIREWALL_SERVICES.filter(
    (s) => s.alwaysOn || config.allowed.includes(s.id),
  );

  const v4 = config.trustedNetworks.filter((n) => family(n) === "ip");
  const v6 = config.trustedNetworks.filter((n) => family(n) === "ip6");
  const restricted = config.restrictToTrusted && config.trustedNetworks.length > 0;

  const lines: string[] = [
    "#!/usr/sbin/nft -f",
    "# Generated by OpenNAS - do not edit by hand.",
    "",
    "# Replace only *our* table, atomically. `flush ruleset` would be simpler and",
    "# would also delete the tables Docker and libvirt install for container and",
    "# VM networking - applying a firewall would silently break both. The bare",
    "# `table` line creates it when absent so the delete can't fail on first run.",
    "table inet opennas",
    "delete table inet opennas",
    "",
    "table inet opennas {",
  ];

  if (config.trustedNetworks.length > 0) {
    // Empty sets are legal but `elements = { }` is not, so only emit what exists.
    if (v4.length > 0) {
      lines.push(
        "  set trusted4 {",
        "    type ipv4_addr",
        "    flags interval",
        `    elements = { ${v4.join(", ")} }`,
        "  }",
      );
    }
    if (v6.length > 0) {
      lines.push(
        "  set trusted6 {",
        "    type ipv6_addr",
        "    flags interval",
        `    elements = { ${v6.join(", ")} }`,
        "  }",
      );
    }
    lines.push("");
  }

  // Addresses banned for repeated failed sign-ins.
  //
  // A *dynamic* set with a per-element timeout, so the kernel expires bans on
  // its own: no sweeper job, and nothing to go wrong if OpenNAS is not running
  // when a ban should end. Adding a ban is then one `nft add element`, rather
  // than regenerating and reloading the whole ruleset for every failed login.
  // The sets are always declared, even when empty, so a ban never has to wait
  // for the ruleset to be rebuilt first.
  lines.push(
    "  set banned4 {",
    "    type ipv4_addr",
    "    flags dynamic,timeout",
    "  }",
    "",
    "  set banned6 {",
    "    type ipv6_addr",
    "    flags dynamic,timeout",
    "  }",
    "",
  );

  lines.push(
    "  chain input {",
    "    type filter hook input priority filter; policy drop;",
    "",
    "    # Anything the box started itself, and its own loopback.",
    "    ct state established,related accept",
    "    ct state invalid drop",
    "    iif lo accept",
    "",
    "    # Banned for repeated failed sign-ins. Placed after the loopback and",
    "    # established-connection rules so a ban can never cut the box off from",
    "    # itself or kill a connection that was already accepted, and before",
    "    # every accept below so it actually takes effect.",
    "    ip saddr @banned4 drop",
    "    ip6 saddr @banned6 drop",
    "",
    "    # ICMP, including the bits IPv6 stops working without.",
    "    ip protocol icmp accept",
    "    meta l4proto ipv6-icmp accept",
    "",
    "    # DHCP replies, or the box loses its lease and disappears.",
    "    udp sport 67 udp dport 68 accept",
    "    udp sport 547 udp dport 546 accept",
    "",
  );

  if (restricted) {
    lines.push("    # Everything below is limited to the trusted networks.");
    const guards: string[] = [];
    if (v4.length > 0) guards.push("ip saddr @trusted4");
    if (v6.length > 0) guards.push("ip6 saddr @trusted6");
    for (const service of enabledServices) {
      lines.push(`    # ${service.name}`);
      for (const p of service.ports) {
        for (const guard of guards) {
          lines.push(`    ${guard} ${p.proto} dport ${p.port} accept`);
        }
      }
    }
  } else {
    if (config.trustedNetworks.length > 0) {
      lines.push("    # Trusted networks reach everything, whatever is toggled below.");
      if (v4.length > 0) lines.push("    ip saddr @trusted4 accept");
      if (v6.length > 0) lines.push("    ip6 saddr @trusted6 accept");
      lines.push("");
    }
    for (const service of enabledServices) {
      lines.push(`    # ${service.name}`);
      for (const p of service.ports) {
        lines.push(`    ${p.proto} dport ${p.port} accept`);
      }
    }
  }

  lines.push(
    "  }",
    "",
    "  # Containers and VMs do their own forwarding; leave that alone rather than",
    "  # breaking Docker's and libvirt's chains, which live in other tables.",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    "  }",
    "",
    "  chain output {",
    "    type filter hook output priority filter; policy accept;",
    "  }",
    "}",
    "",
  );

  return lines.join("\n");
}


// ---- Bans ------------------------------------------------------------------

/**
 * Add, lift and read the kernel's ban set.
 *
 * The nftables set is the source of truth for what is *actually* blocked: it
 * survives OpenNAS restarting and expires entries on its own, and it is cleared
 * by a reboot. Reading it back rather than the database is what keeps the UI
 * from claiming an address is blocked when nothing is blocking it.
 */

/** Ban an address at the firewall. Returns false when nothing enforced it. */
export async function banAddress(address: string, seconds: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFile(appConfig.firewallHelper, ["ban", address, String(seconds)], { timeout: 10_000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    return { ok: false, error: e.stderr?.trim() || "Could not apply the ban." };
  }
}

export async function unbanAddress(address: string): Promise<void> {
  try {
    await execFile(appConfig.firewallHelper, ["unban", address], { timeout: 10_000 });
  } catch {
    // An address whose ban had already expired is not a failure - the end state
    // is the one that was asked for.
  }
}

/** Addresses the kernel is currently dropping, as `address` → seconds left. */
export async function activeBans(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { stdout } = await execFile(appConfig.firewallHelper, ["bans"], { timeout: 10_000 });
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // "203.0.113.7 timeout 2m expires 1m59s946ms"
      const address = trimmed.split(/\s+/)[0];
      if (!address) continue;
      const expires = /expires ([0-9hmsd]+)/.exec(trimmed)?.[1];
      out.set(address.toLowerCase(), expires ? parseDuration(expires) : 0);
    }
  } catch {
    // Firewall off, helper missing, or not on the appliance: nothing is enforced.
  }
  return out;
}

/** nft's compact duration form - "1m59s946ms" - as whole seconds. */
export function parseDuration(text: string): number {
  let total = 0;
  for (const [, value, unit] of text.matchAll(/(\d+)(ms|[dhms])/g)) {
    const n = Number(value);
    if (unit === "d") total += n * 86400;
    else if (unit === "h") total += n * 3600;
    else if (unit === "m") total += n * 60;
    else if (unit === "s") total += n;
    // Milliseconds are deliberately dropped rather than rounded up: "expires in
    // 0 seconds" is the honest answer for something with 400ms left.
  }
  return total;
}
