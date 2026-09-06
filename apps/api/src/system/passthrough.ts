import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { HostDevice, PassthroughStatus } from "@opennas/shared";

const exec = promisify(execFile);
const URI = "qemu:///system";

/**
 * Passing host devices through to a VM.
 *
 * Two very different mechanisms behind one idea:
 *
 * - **USB** works on any machine. The guest is given a vendor/product id and
 *   qemu forwards the device; nothing about the host has to be reconfigured,
 *   and unplugging it just makes it disappear from the guest.
 * - **PCI** needs the IOMMU switched on in firmware *and* on the kernel command
 *   line, and the device handed to `vfio-pci` - at which point the host loses
 *   it. Get the wrong device and the host loses its disk controller or its NIC,
 *   which on a NAS means losing the machine.
 *
 * So PCI devices are listed with their IOMMU group and a plain reason when they
 * are not eligible, and anything the host is visibly relying on is refused
 * outright rather than left to a confirmation dialog.
 */

export const USB_ID_RE = /^[0-9a-f]{4}:[0-9a-f]{4}$/i;
export const PCI_ADDR_RE = /^(?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;

/** Normalise a PCI address to the full `0000:03:00.0` form. */
export function normalizePciAddress(addr: string): string | null {
  const a = addr.trim().toLowerCase();
  if (!PCI_ADDR_RE.test(a)) return null;
  return a.includes(":") && a.split(":").length === 3 ? a : `0000:${a}`;
}

async function readTrimmed(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Whether the kernel has an IOMMU active - without it, PCI passthrough can't work. */
export async function passthroughStatus(): Promise<PassthroughStatus> {
  let iommuGroups = 0;
  try {
    iommuGroups = (await readdir("/sys/kernel/iommu_groups")).length;
  } catch {
    iommuGroups = 0;
  }
  const cmdline = await readTrimmed("/proc/cmdline");
  const requested = /\b(intel_iommu=on|amd_iommu=on|iommu=pt)\b/.test(cmdline);
  // libvirt loads vfio-pci itself when a managed hostdev starts, so what
  // matters is whether the kernel has it at all - not whether it is loaded now.
  let vfio = false;
  for (const path of ["/sys/bus/pci/drivers/vfio-pci", "/sys/module/vfio_pci"]) {
    try {
      await readdir(path);
      vfio = true;
      break;
    } catch {
      /* try the next */
    }
  }
  if (!vfio) {
    // Not loaded - but shipped as a module is enough, because libvirt loads it
    // itself when a managed hostdev starts.
    try {
      const { release } = await import("node:os");
      const files = await readdir(`/lib/modules/${release()}/kernel/drivers/vfio/pci`);
      vfio = files.some((f) => f.startsWith("vfio-pci."));
    } catch {
      /* no module tree to inspect */
    }
  }

  let reason = "";
  if (iommuGroups === 0) {
    reason = requested
      ? "The kernel was asked to enable an IOMMU but none came up - check that VT-d / AMD-Vi is enabled in the firmware."
      : "No IOMMU is active. Add intel_iommu=on (or amd_iommu=on) to the kernel command line and enable VT-d / AMD-Vi in the firmware.";
  }

  return { iommuActive: iommuGroups > 0, iommuGroups, vfioAvailable: vfio, reason };
}

/**
 * Every PCI address along a sysfs path, not just the first.
 *
 * A block device resolves through its root port and any switches above it -
 * `.../pci0000:00/0000:00:01.3/0000:04:00.0/nvme/...` - so taking the first
 * match found the bridge and left the controller itself looking passable. Both
 * ends of that chain matter: hand a guest the leaf and the host loses the disk,
 * hand it the bridge and the host loses everything beneath it.
 */
function addPciAncestors(target: string, into: Set<string>): void {
  for (const m of target.matchAll(/([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])/gi)) {
    into.add(m[1]!.toLowerCase());
  }
}

/** The devices the host is visibly depending on, which must never be passed through. */
async function criticalPciAddresses(): Promise<Set<string>> {
  const critical = new Set<string>();

  // Whatever backs a mounted filesystem: losing it takes the machine down.
  try {
    const mounts = await readFile("/proc/mounts", "utf8");
    const devices = mounts
      .split("\n")
      .map((l) => l.split(/\s+/)[0])
      .filter((d): d is string => !!d && d.startsWith("/dev/"));
    for (const dev of devices) {
      // sda2 → sda, nvme0n1p1 → nvme0n1: the partition's parent is what has a
      // PCI address.
      const base = dev.replace("/dev/", "").replace(/p?\d+$/, "");
      try {
        addPciAncestors(await readlink(`/sys/block/${base}`), critical);
      } catch {
        /* not a block device with a PCI parent */
      }
    }
  } catch {
    /* /proc/mounts unreadable - fall through, the NIC check still applies */
  }

  // Any network interface that is currently up.
  try {
    for (const iface of await readdir("/sys/class/net")) {
      if (iface === "lo") continue;
      if ((await readTrimmed(`/sys/class/net/${iface}/operstate`)) !== "up") continue;
      try {
        addPciAncestors(await readlink(`/sys/class/net/${iface}/device`), critical);
      } catch {
        /* virtual interface with no PCI device */
      }
    }
  } catch {
    /* no sysfs net - nothing to add */
  }

  return critical;
}

/** The other devices sharing a device's IOMMU group. */
async function groupMembers(group: number): Promise<string[]> {
  try {
    return (await readdir(`/sys/kernel/iommu_groups/${group}/devices`)).map((d) => d.toLowerCase());
  } catch {
    return [];
  }
}

/** PCI devices, annotated with whether passing each one through is safe. */
export async function listPciDevices(): Promise<HostDevice[]> {
  const status = await passthroughStatus();
  const critical = await criticalPciAddresses();
  let addresses: string[];
  try {
    addresses = await readdir("/sys/bus/pci/devices");
  } catch {
    return [];
  }

  const devices: HostDevice[] = [];
  for (const addr of addresses.sort()) {
    const base = `/sys/bus/pci/devices/${addr}`;
    const vendor = (await readTrimmed(`${base}/vendor`)).replace(/^0x/, "");
    const product = (await readTrimmed(`${base}/device`)).replace(/^0x/, "");
    const classCode = (await readTrimmed(`${base}/class`)).replace(/^0x/, "");
    const driver = await readlink(`${base}/driver`).then((t) => t.split("/").pop() ?? "", () => "");

    let group: number | null = null;
    try {
      const link = await readlink(`${base}/iommu_group`);
      const n = Number(link.split("/").pop());
      group = Number.isFinite(n) ? n : null;
    } catch {
      group = null;
    }

    // vfio takes an entire IOMMU group or nothing, so the group's companions
    // decide this device's fate as much as the device itself does.
    const members = group === null ? [] : (await groupMembers(group)).filter((m) => m !== addr.toLowerCase());
    const blockedBy = members.filter((m) => critical.has(m));

    let eligible = true;
    let reason = "";
    if (classCode.slice(0, 2).toLowerCase() === "06") {
      // A root port or switch is the path to other devices, not a device an OS
      // has any use for. Listing them as passable buries the few real
      // candidates in noise.
      eligible = false;
      reason = "This is a PCI bridge rather than a device.";
    } else if (critical.has(addr.toLowerCase())) {
      eligible = false;
      reason = "The host needs this device for storage or networking. Passing it through would disconnect the NAS from those resources.";
    } else if (!status.iommuActive) {
      eligible = false;
      reason = status.reason;
    } else if (group === null) {
      eligible = false;
      reason = "This device isn't in an IOMMU group, so it can't be isolated for a guest.";
    } else if (blockedBy.length > 0) {
      // The case that makes naive passthrough dangerous: a device that looks
      // free but shares a group with the boot disk's controller or a live NIC.
      eligible = false;
      reason =
        `It shares IOMMU group ${group} with ${blockedBy.join(", ")}, which the host is using. ` +
        "The whole group has to move to the guest together, so this can't be passed through without taking the NAS off its disks or its network.";
    }

    devices.push({
      kind: "pci",
      id: addr,
      vendorId: vendor,
      productId: product,
      description: describePciClass(classCode),
      driver: driver || null,
      iommuGroup: group,
      groupMembers: members,
      eligible,
      reason,
    });
  }
  return devices;
}

/** The broad class of a PCI device, from its class code's top byte. */
function describePciClass(classCode: string): string {
  const top = classCode.slice(0, 2).toLowerCase();
  const names: Record<string, string> = {
    "00": "Unclassified",
    "01": "Storage controller",
    "02": "Network controller",
    "03": "Display controller",
    "04": "Multimedia device",
    "05": "Memory controller",
    "06": "Bridge",
    "07": "Communication controller",
    "08": "System peripheral",
    "09": "Input device",
    "0a": "Docking station",
    "0b": "Processor",
    "0c": "Serial bus controller",
    "0d": "Wireless controller",
    "12": "Processing accelerator",
  };
  return names[top] ?? `PCI class ${classCode || "unknown"}`;
}

/** USB devices, read from sysfs so no extra tool has to be installed. */
export async function listUsbDevices(): Promise<HostDevice[]> {
  let entries: string[];
  try {
    entries = await readdir("/sys/bus/usb/devices");
  } catch {
    return [];
  }
  const devices: HostDevice[] = [];
  for (const entry of entries.sort()) {
    // Interfaces look like "1-1:1.0"; only whole devices have idVendor.
    if (entry.includes(":")) continue;
    const base = `/sys/bus/usb/devices/${entry}`;
    const vendorId = await readTrimmed(`${base}/idVendor`);
    const productId = await readTrimmed(`${base}/idProduct`);
    if (!vendorId || !productId) continue;
    const manufacturer = await readTrimmed(`${base}/manufacturer`);
    const product = await readTrimmed(`${base}/product`);
    const isHub = (await readTrimmed(`${base}/bDeviceClass`)) === "09";
    devices.push({
      kind: "usb",
      id: `${vendorId}:${productId}`,
      vendorId,
      productId,
      description: [manufacturer, product].filter(Boolean).join(" ") || "USB device",
      driver: null,
      iommuGroup: null,
      // USB has no IOMMU grouping: qemu forwards the single device.
      groupMembers: [],
      // Hubs are structure, not something anyone means to hand to a guest.
      eligible: !isHub,
      reason: isHub ? "This is a USB hub rather than a device." : "",
    });
  }
  return devices;
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

async function withTempXml<T>(xml: string, fn: (path: string) => Promise<T>): Promise<T> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "opennas-hostdev-"));
  try {
    const path = join(dir, "dev.xml");
    await writeFile(path, xml, "utf8");
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Attach a host device to a VM, persistently.
 *
 * `--config` rather than `--live`: a USB device the guest gains only until the
 * next reboot is a confusing thing to have configured, and a PCI device cannot
 * be hot-added to a running guest reliably anyway.
 */
export async function attachDevice(vm: string, device: HostDevice): Promise<{ ok: boolean; error?: string }> {
  if (!device.eligible) return { ok: false, error: device.reason || "That device can't be passed through." };

  if (device.kind === "usb") {
    const xml = usbHostdevXml(device);
    return withTempXml(xml, (path) => virshDo(["attach-device", vm, path, "--config"]));
  }

  // The rest of the IOMMU group has to go too - a GPU's audio function is the
  // everyday case - so they are attached together and a partial failure is
  // reported rather than left as a half-configured VM.
  for (const addr of [device.id, ...(device.groupMembers ?? [])]) {
    const xml = pciHostdevXml(addr);
    if (!xml) return { ok: false, error: "Invalid device address." };
    const res = await withTempXml(xml, (path) => virshDo(["attach-device", vm, path, "--config"]));
    if (!res.ok) {
      return {
        ok: false,
        error:
          addr === device.id
            ? (res.error ?? "Could not attach the device.")
            : `Attached ${device.id}, but its IOMMU group companion ${addr} failed: ${res.error ?? "unknown error"}. Detach the device and try again.`,
      };
    }
  }
  return { ok: true };
}

function usbHostdevXml(device: HostDevice): string {
  return `<hostdev mode='subsystem' type='usb' managed='yes'>
  <source>
    <vendor id='0x${device.vendorId}'/>
    <product id='0x${device.productId}'/>
  </source>
</hostdev>
`;
}

export async function detachDevice(vm: string, device: HostDevice): Promise<{ ok: boolean; error?: string }> {
  if (device.kind === "usb") {
    return withTempXml(usbHostdevXml(device), (path) => virshDo(["detach-device", vm, path, "--config"]));
  }
  // Only the named device: the companions are listed separately and detaching
  // them is a separate decision, so removing one doesn't silently strip others.
  const xml = pciHostdevXml(device.id);
  if (!xml) return { ok: false, error: "Invalid device address." };
  return withTempXml(xml, (path) => virshDo(["detach-device", vm, path, "--config"]));
}

function pciHostdevXml(address: string): string | null {
  const full = normalizePciAddress(address);
  if (!full) return null;
  const [domain, bus, rest] = full.split(":");
  const [slot, fn] = (rest ?? "").split(".");
  if (!domain || !bus || !slot || !fn) return null;
  // managed='yes' makes libvirt bind the device to vfio-pci on start and hand
  // it back to the host driver on shutdown, rather than leaving it detached.
  return `<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x${domain}' bus='0x${bus}' slot='0x${slot}' function='0x${fn}'/>
  </source>
</hostdev>
`;
}

/** Devices already attached to a VM, read back from its definition. */
export async function attachedDevices(vm: string): Promise<HostDevice[]> {
  let xml = "";
  try {
    xml = (await exec("virsh", ["-c", URI, "dumpxml", vm], { timeout: 8000 })).stdout;
  } catch {
    return [];
  }
  const out: HostDevice[] = [];
  for (const block of xml.split("<hostdev").slice(1)) {
    if (block.includes("type='usb'")) {
      const vendor = /<vendor id='0x([0-9a-fA-F]{4})'/.exec(block)?.[1];
      const product = /<product id='0x([0-9a-fA-F]{4})'/.exec(block)?.[1];
      if (vendor && product) {
        out.push({
          kind: "usb", id: `${vendor}:${product}`.toLowerCase(),
          vendorId: vendor.toLowerCase(), productId: product.toLowerCase(),
          description: "USB device", driver: null, iommuGroup: null, groupMembers: [], eligible: true, reason: "",
        });
      }
    } else if (block.includes("type='pci'")) {
      const m = /domain='0x([0-9a-f]+)'\s+bus='0x([0-9a-f]+)'\s+slot='0x([0-9a-f]+)'\s+function='0x([0-9a-f]+)'/i.exec(block);
      if (m) {
        const id = `${m[1]!.padStart(4, "0")}:${m[2]!.padStart(2, "0")}:${m[3]!.padStart(2, "0")}.${m[4]}`;
        out.push({
          kind: "pci", id, vendorId: "", productId: "",
          description: "PCI device", driver: null, iommuGroup: null, groupMembers: [], eligible: true, reason: "",
        });
      }
    }
  }
  return out;
}
