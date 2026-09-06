import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CreateVmRequest, VirtStatus, VmAction, VmInfo, VmSnapshot, VmState } from "@opennas/shared";
import { isoDir, vmDisksDirFor } from "./storage-paths.js";

const exec = promisify(execFile);

/**
 * KVM/QEMU virtual machines, driven through libvirt's `virsh` CLI against the
 * system instance (`qemu:///system`). Mirrors the Docker adapter: every call
 * shells out to the host tool and returns an empty/unavailable result when the
 * binary is missing or libvirtd is down, so dev boxes and non-virt appliances
 * degrade gracefully instead of erroring.
 *
 * The backend runs as the unprivileged `opennas` user, which the installer adds
 * to the `libvirt`/`kvm` groups - that membership is what lets these commands
 * reach the system hypervisor without `doas`.
 */

const URI = "qemu:///system";

/** VM names must be filesystem- and shell-safe (used in disk paths + XML). */
export const VM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

/** Run virsh, returning stdout or null on any failure (missing binary / daemon). */
async function virsh(args: string[], timeoutMs = 12000): Promise<string | null> {
  try {
    return (await exec("virsh", ["-c", URI, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

/** Run virsh for a mutating action, surfacing the last stderr line on failure. */
async function virshDo(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec("virsh", ["-c", URI, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim().split("\n").pop();
    return { ok: false, error: stderr || "virsh command failed." };
  }
}

function mapState(raw: string): VmState {
  const s = raw.trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "paused" || s === "pmsuspended") return "paused";
  if (s === "shut off" || s === "shutoff") return "shutoff";
  if (s === "crashed") return "crashed";
  return "other";
}

/** Parse `virsh dominfo` key/value output. */
function parseDominfo(out: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return info;
}

/** The VNC port a running graphical VM listens on (5900 + display), else null. */
async function vncPort(name: string): Promise<number | null> {
  const out = await virsh(["vncdisplay", name], 6000);
  if (!out) return null;
  // Output looks like ":0" or "127.0.0.1:0".
  const m = out.trim().match(/:(\d+)\s*$/);
  if (!m) return null;
  return 5900 + Number(m[1]);
}

async function describe(name: string): Promise<VmInfo | null> {
  const out = await virsh(["dominfo", name]);
  if (!out) return null;
  const info = parseDominfo(out);
  const state = mapState(info.State ?? "");
  // "Max memory" is reported in KiB.
  const memKiB = Number.parseInt((info["Max memory"] ?? "").replace(/[^0-9]/g, ""), 10) || 0;
  return {
    name: info.Name ?? name,
    uuid: info.UUID ?? "",
    state,
    vcpus: Number.parseInt(info["CPU(s)"] ?? "", 10) || 0,
    memoryMiB: Math.round(memKiB / 1024),
    autostart: (info.Autostart ?? "").toLowerCase() === "enable",
    vncPort: state === "running" ? await vncPort(name) : null,
  };
}

/** Whole-subsystem status plus the list of defined domains. */
export async function getVirt(): Promise<VirtStatus> {
  const version = await virsh(["--version"], 4000);
  const kvm = existsSync("/dev/kvm");
  if (version == null) return { available: false, running: false, kvm, vms: [] };

  // `list --all --name` prints one domain name per line (blank line at the end).
  const names = await virsh(["list", "--all", "--name"]);
  if (names == null) return { available: true, running: false, kvm, vms: [] };

  const list = names.split("\n").map((l) => l.trim()).filter(Boolean);
  const vms = (await Promise.all(list.map((n) => describe(n)))).filter((v): v is VmInfo => v !== null);
  return { available: true, running: true, kvm, vms };
}

/** Look up one domain (used to resolve VNC port for the console proxy). */
export async function getVm(name: string): Promise<VmInfo | null> {
  if (!VM_NAME_RE.test(name)) return null;
  return describe(name);
}

const ACTION_ARGS: Record<VmAction, string[]> = {
  start: ["start"],
  shutdown: ["shutdown"], // graceful ACPI
  reboot: ["reboot"],
  destroy: ["destroy"], // force power-off
  suspend: ["suspend"],
  resume: ["resume"],
};

export async function vmAction(name: string, action: VmAction): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(name)) return { ok: false, error: "Invalid VM name." };
  const args = ACTION_ARGS[action];
  return virshDo([args[0]!, name, ...args.slice(1)]);
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/**
 * Build a libvirt domain XML for a new VM. KVM-accelerated when available (falls
 * back to plain QEMU emulation otherwise), virtio disk + NIC, and a VNC display
 * bound to loopback so only the OpenNAS console proxy can reach it.
 */
function domainXml(spec: {
  name: string; vcpus: number; memoryMiB: number; diskPath: string;
  isoPath?: string | null;
  /** A libvirt network name, or a host bridge to put the guest on the LAN. */
  network?: string | null;
  networkIsBridge?: boolean;
}): string {
  const domType = existsSync("/dev/kvm") ? "kvm" : "qemu";
  const cpuMode = domType === "kvm" ? "host-passthrough" : "host-model";
  const cdrom = spec.isoPath
    ? `
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='${xmlEscape(spec.isoPath)}'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>`
    : "";
  return `<domain type='${domType}'>
  <name>${xmlEscape(spec.name)}</name>
  <memory unit='MiB'>${spec.memoryMiB}</memory>
  <currentMemory unit='MiB'>${spec.memoryMiB}</currentMemory>
  <vcpu placement='static'>${spec.vcpus}</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='cdrom'/>
    <boot dev='hd'/>
  </os>
  <features><acpi/><apic/></features>
  <cpu mode='${cpuMode}'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${xmlEscape(spec.diskPath)}'/>
      <target dev='vda' bus='virtio'/>
    </disk>${cdrom}
    ${spec.networkIsBridge
      ? `<interface type='bridge'>
      <source bridge='${xmlEscape(spec.network ?? "br0")}'/>
      <model type='virtio'/>
    </interface>`
      : `<interface type='network'>
      <source network='${xmlEscape(spec.network || "default")}'/>
      <model type='virtio'/>
    </interface>`}
    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>
    <video><model type='virtio'/></video>
    <console type='pty'/>
    <input type='tablet' bus='usb'/>
    <channel type='unix'>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
    </channel>
  </devices>
</domain>
`;
}

/** Absolute, sandboxed path to a VM's primary disk image. */
function diskPathFor(name: string, target?: string | null): string {
  return resolve(vmDisksDirFor(target), `${name}.qcow2`);
}

/**
 * The disk images libvirt actually has attached to a domain.
 *
 * A VM's disk can be created on any data volume, so its path can't be
 * recomputed from the name - libvirt is the only thing that knows where it went.
 * Asking it is also correct for VMs defined outside OpenNAS.
 */
async function attachedDisks(name: string): Promise<string[]> {
  const out = await virsh(["domblklist", name, "--details"], 8000);
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    // "file disk vda /path/to.qcow2" - only real files we can remove.
    .filter((cols) => cols.length >= 4 && cols[0] === "file" && cols[1] === "disk" && cols[3]?.startsWith("/"))
    .map((cols) => cols[3]!);
}

/** Resolve + validate an ISO name to a path inside the ISO library. */
function isoPathFor(iso: string): string | null {
  if (iso.includes("/") || iso.includes("..") || !iso.toLowerCase().endsWith(".iso")) return null;
  const base = isoDir();
  const p = resolve(base, iso);
  if (!p.startsWith(resolve(base) + "/")) return null;
  return existsSync(p) ? p : null;
}

/**
 * Create + start a new VM: allocate a qcow2 disk, define the domain from
 * generated XML, then boot it. The qcow2 is sparse (grows on demand), so a large
 * virtual size costs little until used.
 */
export async function createVm(spec: CreateVmRequest): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(spec.name)) return { ok: false, error: "Use letters, digits, '-' or '_' (max 40)." };

  // Reject if a domain with this name already exists.
  if ((await virsh(["dominfo", spec.name], 6000)) !== null) {
    return { ok: false, error: "A VM with that name already exists." };
  }

  const diskPath = diskPathFor(spec.name, spec.volume);
  if (existsSync(diskPath)) return { ok: false, error: "A disk image for that name already exists." };

  let isoPath: string | null = null;
  if (spec.iso) {
    isoPath = isoPathFor(spec.iso);
    if (!isoPath) return { ok: false, error: "Selected ISO was not found." };
  }

  // 1) Allocate the virtual disk.
  try {
    await exec("qemu-img", ["create", "-f", "qcow2", diskPath, `${spec.diskGiB}G`], { timeout: 60000 });
  } catch (err) {
    return { ok: false, error: (err as { stderr?: string }).stderr?.trim().split("\n").pop() || "Could not create the disk image." };
  }

  // 2) Define the domain from a temp XML file, then start it.
  const dir = await mkdtemp(join(tmpdir(), "opennas-vm-"));
  const xmlPath = join(dir, "domain.xml");
  try {
    await writeFile(
      xmlPath,
      domainXml({
        name: spec.name,
        vcpus: spec.vcpus,
        memoryMiB: spec.memoryMiB,
        diskPath,
        isoPath,
        network: spec.network ?? null,
        networkIsBridge: spec.networkIsBridge === true,
      }),
    );
    const def = await virshDo(["define", xmlPath]);
    if (!def.ok) {
      await rm(diskPath, { force: true });
      return def;
    }
    const started = await virshDo(["start", spec.name]);
    if (!started.ok) {
      // Leave the defined (stopped) domain in place; the user can retry start.
      return { ok: true, error: `Defined, but could not start automatically: ${started.error ?? ""}`.trim() };
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Delete a VM: force-stop if running, undefine the domain (and its NVRAM), and
 * optionally remove the disk image. Destructive - the route confirms intent.
 */
export async function deleteVm(name: string, removeDisk: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(name)) return { ok: false, error: "Invalid VM name." };
  // Where the disks are must be read while the domain still exists.
  const disks = removeDisk ? await attachedDisks(name) : [];
  // Ignore destroy failure (it may already be off).
  await virshDo(["destroy", name], 15000);
  const undef = await virshDo(["undefine", name, "--nvram"]);
  if (!undef.ok) return undef;
  if (removeDisk) {
    // Read the paths BEFORE undefining, or libvirt no longer knows them.
    for (const disk of disks) await rm(disk, { force: true });
  }
  return { ok: true };
}

// ---- Snapshots -------------------------------------------------------------
//
// libvirt's internal snapshots, which qcow2 stores inside the disk image
// itself. A snapshot of a *running* VM also captures memory, so restoring puts
// the guest back mid-flight; one taken while it's off is disk-only and restores
// to a clean boot. Both are useful, and which you got is worth showing.

/** Snapshot names libvirt will accept, and the shape a bare-name listing has. */
export const SNAPSHOT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export async function listSnapshots(name: string): Promise<VmSnapshot[]> {
  if (!VM_NAME_RE.test(name)) return [];
  const out = await virsh(["snapshot-list", name, "--name"]);
  if (out == null) return [];
  // `--name` gives bare names, but a virsh that ignored it would hand back the
  // table instead and turn its header and rule into two phantom snapshots.
  const names = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && SNAPSHOT_NAME_RE.test(l));
  const snaps = await Promise.all(
    names.map(async (snap) => {
      const xml = (await virsh(["snapshot-dumpxml", name, snap])) ?? "";
      const created = /<creationTime>(\d+)<\/creationTime>/.exec(xml)?.[1];
      const state = /<state>([^<]+)<\/state>/.exec(xml)?.[1] ?? "";
      const description = /<description>([^<]*)<\/description>/.exec(xml)?.[1] ?? "";
      return {
        name: snap,
        createdAt: created ? new Date(Number(created) * 1000).toISOString() : null,
        // "shutoff" means disk only; anything else captured memory too.
        withMemory: state !== "shutoff" && state !== "",
        state,
        description,
      } satisfies VmSnapshot;
    }),
  );
  return snaps.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export async function createSnapshot(name: string, snapshot: string, description: string): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(name)) return { ok: false, error: "Invalid VM name." };
  if (!VM_NAME_RE.test(snapshot)) return { ok: false, error: "Invalid snapshot name." };
  const args = ["snapshot-create-as", "--domain", name, "--name", snapshot];
  if (description) args.push("--description", description.slice(0, 200));
  // Taking this can be slow on a running VM (it writes out memory), so allow
  // well past the usual command timeout.
  return virshDo(args, 300_000);
}

export async function revertSnapshot(name: string, snapshot: string): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(name) || !VM_NAME_RE.test(snapshot)) return { ok: false, error: "Invalid name." };
  return virshDo(["snapshot-revert", name, snapshot], 300_000);
}

export async function deleteSnapshot(name: string, snapshot: string): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(name) || !VM_NAME_RE.test(snapshot)) return { ok: false, error: "Invalid name." };
  return virshDo(["snapshot-delete", name, snapshot], 120_000);
}

/** Toggle whether a VM starts automatically when the host boots. */
export async function setAutostart(name: string, on: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!VM_NAME_RE.test(name)) return { ok: false, error: "Invalid VM name." };
  return virshDo(on ? ["autostart", name] : ["autostart", "--disable", name]);
}
