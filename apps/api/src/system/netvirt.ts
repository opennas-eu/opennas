import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerNetwork, VirtNetwork } from "@opennas/shared";

const exec = promisify(execFile);
const URI = "qemu:///system";

/**
 * Virtual networks for VMs (libvirt) and containers (Docker).
 *
 * Two deliberate limits, both about not cutting the machine off the network:
 *
 * - OpenNAS creates **NAT** networks only. A bridged network re-plumbs the
 *   host's own NIC into a bridge, and getting that wrong takes the NAS off the
 *   network entirely - with no web UI left to fix it from. An existing host
 *   bridge (made by an admin who knew what they were doing) can be *attached*
 *   to, but one is never created here.
 * - Nothing removes a network that something is still using; libvirt and Docker
 *   both refuse, and that refusal is surfaced rather than forced.
 */

export const NET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

async function virsh(args: string[], timeoutMs = 12000): Promise<string | null> {
  try {
    return (await exec("virsh", ["-c", URI, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

async function virshDo(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec("virsh", ["-c", URI, ...args], { timeout: timeoutMs });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, error: e.stderr?.trim().split("\n").filter(Boolean).pop() || "virsh failed." };
  }
}

async function docker(args: string[], timeoutMs = 12000): Promise<string | null> {
  try {
    return (await exec("docker", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

// ---- libvirt networks ------------------------------------------------------

/** Bridges the host already has, which a VM may be attached to directly. */
export async function hostBridges(): Promise<string[]> {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const names = await readdir("/sys/class/net");
    const bridges: string[] = [];
    for (const n of names) {
      try {
        // A bridge is exactly an interface with a `bridge` directory.
        await stat(`/sys/class/net/${n}/bridge`);
        // virbr* belong to libvirt's own NAT networks; they're offered through
        // those instead, so listing them here would just be confusing.
        if (!n.startsWith("virbr")) bridges.push(n);
      } catch {
        /* not a bridge */
      }
    }
    return bridges;
  } catch {
    return [];
  }
}

export async function listVirtNetworks(): Promise<VirtNetwork[]> {
  const out = await virsh(["net-list", "--all", "--name"]);
  if (out == null) return [];
  const names = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const nets = await Promise.all(names.map(describeVirtNetwork));
  return nets.filter((n): n is VirtNetwork => n !== null);
}

async function describeVirtNetwork(name: string): Promise<VirtNetwork | null> {
  if (!NET_NAME_RE.test(name)) return null;
  const info = await virsh(["net-info", name]);
  if (info == null) return null;
  const kv: Record<string, string> = {};
  for (const line of info.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) kv[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const xml = (await virsh(["net-dumpxml", name])) ?? "";
  const bridge = /<bridge[^>]*name=['"]([^'"]+)['"]/.exec(xml)?.[1] ?? null;
  const forward = /<forward[^>]*mode=['"]([^'"]+)['"]/.exec(xml)?.[1] ?? null;
  const ip = /<ip[^>]*address=['"]([^'"]+)['"]/.exec(xml)?.[1] ?? null;
  return {
    name,
    active: (kv.active ?? "").toLowerCase() === "yes",
    autostart: (kv.autostart ?? "").toLowerCase() === "yes",
    bridge,
    // No <forward> at all means an isolated network: guests can reach each
    // other and nothing else.
    mode: forward ?? "isolated",
    ipAddress: ip,
    /** libvirt's stock network; removing it would surprise anyone expecting it. */
    builtin: name === "default",
  };
}

export interface CreateVirtNetwork {
  name: string;
  /** "nat" reaches the LAN through the host; "isolated" reaches only other guests. */
  mode: "nat" | "isolated";
  /** Host-side subnet, e.g. "192.168.140.0/24". */
  subnet: string;
}

/** Split a CIDR into the host address libvirt wants plus a netmask. */
function subnetParts(cidr: string): { address: string; netmask: string; dhcpStart: string; dhcpEnd: string } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits < 16 || bits > 30) return null;
  // Only /24-shaped networks are offered: it keeps the address maths obvious
  // and is more than any home NAS needs per virtual network.
  if (bits !== 24) return null;
  const base = `${octets[0]}.${octets[1]}.${octets[2]}`;
  return { address: `${base}.1`, netmask: "255.255.255.0", dhcpStart: `${base}.100`, dhcpEnd: `${base}.254` };
}

/**
 * `invalid` separates "you asked for something impossible" from "libvirt said
 * no", so the route can answer 400 instead of reporting a caller's typo as an
 * upstream failure.
 */
export interface NetworkResult {
  ok: boolean;
  error?: string;
  invalid?: boolean;
}

export async function createVirtNetwork(spec: CreateVirtNetwork): Promise<NetworkResult> {
  if (!NET_NAME_RE.test(spec.name)) return { ok: false, invalid: true, error: "Invalid network name." };
  const parts = subnetParts(spec.subnet);
  if (!parts) return { ok: false, invalid: true, error: "Use a /24 subnet such as 192.168.140.0/24." };
  if ((await listVirtNetworks()).some((n) => n.name === spec.name)) {
    return { ok: false, invalid: true, error: "A network with that name already exists." };
  }

  const forward = spec.mode === "nat" ? "\n  <forward mode='nat'/>" : "";
  const xml = `<network>
  <name>${spec.name}</name>${forward}
  <bridge name='onasbr-${spec.name.slice(0, 8)}' stp='on' delay='0'/>
  <ip address='${parts.address}' netmask='${parts.netmask}'>
    <dhcp>
      <range start='${parts.dhcpStart}' end='${parts.dhcpEnd}'/>
    </dhcp>
  </ip>
</network>
`;
  const dir = await mkdtemp(join(tmpdir(), "opennas-net-"));
  try {
    const path = join(dir, "net.xml");
    await writeFile(path, xml, "utf8");
    const defined = await virshDo(["net-define", path]);
    if (!defined.ok) return defined;
    // Autostart before start: if starting fails, the definition is still set up
    // to come back on the next boot rather than silently not existing.
    await virshDo(["net-autostart", spec.name]);
    const started = await virshDo(["net-start", spec.name]);
    if (!started.ok) {
      return { ok: true, error: `Defined, but could not start it: ${started.error ?? ""}`.trim() };
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeVirtNetwork(name: string): Promise<NetworkResult> {
  if (!NET_NAME_RE.test(name)) return { ok: false, invalid: true, error: "Invalid network name." };
  if (name === "default") {
    return { ok: false, invalid: true, error: "The default network is libvirt's own; it isn't removable here." };
  }
  await virshDo(["net-destroy", name], 15000); // may already be stopped
  return virshDo(["net-undefine", name]);
}

export const setVirtNetworkActive = (name: string, active: boolean) =>
  NET_NAME_RE.test(name)
    ? virshDo([active ? "net-start" : "net-destroy", name])
    : Promise.resolve({ ok: false, error: "Invalid network name." });

// ---- Docker networks -------------------------------------------------------

export async function listDockerNetworks(): Promise<DockerNetwork[]> {
  const out = await docker(["network", "ls", "--format", "{{json .}}"]);
  if (out == null) return [];
  const nets: DockerNetwork[] = [];
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const n = JSON.parse(line) as { ID: string; Name: string; Driver: string; Scope: string };
      nets.push({
        id: n.ID,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        // Docker makes these itself and refuses to remove them.
        builtin: ["bridge", "host", "none"].includes(n.Name),
        containers: 0,
      });
    } catch {
      /* skip a line docker didn't format as expected */
    }
  }
  // How many containers are attached is what makes "can I delete this?"
  // answerable, so it's worth the extra inspect.
  await Promise.all(
    nets.map(async (n) => {
      const out2 = await docker(["network", "inspect", n.name, "--format", "{{len .Containers}}"], 8000);
      n.containers = Number((out2 ?? "0").trim()) || 0;
    }),
  );
  return nets;
}

export async function createDockerNetwork(name: string, subnet?: string): Promise<NetworkResult> {
  if (!NET_NAME_RE.test(name)) return { ok: false, invalid: true, error: "Invalid network name." };
  const args = ["network", "create", "--driver", "bridge"];
  if (subnet) {
    if (!subnetParts(subnet)) return { ok: false, invalid: true, error: "Use a /24 subnet such as 172.30.0.0/24." };
    args.push("--subnet", subnet);
  }
  args.push(name);
  try {
    await exec("docker", args, { timeout: 30000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, error: e.stderr?.trim().split("\n").pop() || "Could not create the network." };
  }
}

export async function removeDockerNetwork(name: string): Promise<NetworkResult> {
  if (!NET_NAME_RE.test(name)) return { ok: false, invalid: true, error: "Invalid network name." };
  if (["bridge", "host", "none"].includes(name)) {
    return { ok: false, invalid: true, error: "That's one of Docker's built-in networks; it isn't removable." };
  }
  try {
    await exec("docker", ["network", "rm", name], { timeout: 20000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string };
    return { ok: false, error: e.stderr?.trim().split("\n").pop() || "Could not remove the network." };
  }
}
