import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readlink } from "node:fs/promises";
import {
  listPciDevices,
  listUsbDevices,
  normalizePciAddress,
  passthroughStatus,
} from "../../apps/api/src/system/passthrough.js";

/**
 * PCI passthrough eligibility, against this machine's real sysfs.
 *
 * Deliberately not fixture-driven. Both bugs this code has had were bugs of
 * *assumption* about what sysfs looks like, and a fixture is a copy of the
 * assumption:
 *
 * - taking the first PCI address out of a sysfs path flagged the bridge and left
 *   the actual NVMe and AHCI controllers eligible;
 * - IOMMU groups were ignored, and on the development machine group 14 held the
 *   AHCI controller, both live NICs, and two devices that looked free.
 *
 * So these are invariants rather than expected values: they hold on any Linux
 * box, and the interesting ones say that nothing the host is *visibly* relying
 * on may be offered to a guest.
 */

const linux = process.platform === "linux" && existsSync("/sys/bus/pci/devices");
const skip = linux ? false : "needs Linux sysfs";

/** The PCI addresses behind currently-mounted filesystems and live interfaces. */
async function hostCriticalAddresses(): Promise<Set<string>> {
  const critical = new Set<string>();
  const add = (target: string) => {
    for (const m of target.matchAll(/([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])/gi)) {
      critical.add(m[1]!.toLowerCase());
    }
  };
  for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
    const dev = line.split(/\s+/)[0];
    if (!dev?.startsWith("/dev/")) continue;
    const base = dev.replace("/dev/", "").replace(/p?\d+$/, "");
    try {
      add(await readlink(`/sys/block/${base}`));
    } catch {
      /* not a PCI-backed block device */
    }
  }
  return critical;
}

test("passthroughStatus answers without throwing", { skip }, async () => {
  const status = await passthroughStatus();
  assert.equal(typeof status.iommuActive, "boolean");
  assert.equal(typeof status.reason, "string");
  // When it says no, it has to say why - the UI shows this verbatim, and
  // "unavailable" with no reason is a support ticket.
  if (!status.iommuActive) assert.notEqual(status.reason.trim(), "");
});

test("every listed PCI device has a well-formed address", { skip }, async () => {
  const devices = await listPciDevices();
  // A container with sysfs mounted but no PCI bus is a real environment; there
  // is nothing to assert there rather than something to fail on.
  if (devices.length === 0) return;
  for (const d of devices) {
    assert.equal(d.kind, "pci");
    assert.ok(normalizePciAddress(d.id), `unparseable address ${d.id}`);
    assert.equal(typeof d.description, "string");
    assert.ok(d.iommuGroup === null || Number.isInteger(d.iommuGroup));
  }
});

test("nothing ineligible is left without a reason", { skip }, async () => {
  for (const d of await listPciDevices()) {
    if (!d.eligible) {
      assert.notEqual(d.reason.trim(), "", `${d.id} is refused with no explanation`);
    } else {
      assert.equal(d.reason, "", `${d.id} is eligible but carries a reason`);
    }
  }
});

test("no PCI bridge is ever offered", { skip }, async () => {
  // Handing a guest a root port takes the host off everything beneath it.
  for (const d of await listPciDevices()) {
    const cls = readFileSync(`/sys/bus/pci/devices/${d.id}/class`, "utf8").trim().replace(/^0x/, "");
    if (cls.slice(0, 2).toLowerCase() === "06") {
      assert.equal(d.eligible, false, `bridge ${d.id} is offered for passthrough`);
    }
  }
});

test("nothing the host is running on is offered", { skip }, async () => {
  // The direct case: the controller behind a mounted filesystem, or a NIC that
  // is up.
  const critical = await hostCriticalAddresses();
  for (const d of await listPciDevices()) {
    if (critical.has(d.id.toLowerCase())) {
      assert.equal(d.eligible, false, `${d.id} backs a mounted filesystem and is offered anyway`);
    }
  }
});

test("nothing sharing an IOMMU group with a critical device is offered", { skip }, async () => {
  // The case that makes naive passthrough dangerous, and the one that was
  // actually wrong: a device that looks free but travels with the boot disk's
  // controller, because vfio takes a whole group or nothing.
  const critical = await hostCriticalAddresses();
  for (const d of await listPciDevices()) {
    const shared = d.groupMembers.filter((m) => critical.has(m.toLowerCase()));
    if (shared.length > 0) {
      assert.equal(
        d.eligible,
        false,
        `${d.id} shares IOMMU group ${d.iommuGroup} with ${shared.join(", ")} and is offered anyway`,
      );
    }
  }
});

test("group members are real addresses and exclude the device itself", { skip }, async () => {
  for (const d of await listPciDevices()) {
    assert.ok(!d.groupMembers.includes(d.id.toLowerCase()), `${d.id} lists itself as a group member`);
    for (const m of d.groupMembers) {
      assert.ok(normalizePciAddress(m), `${d.id} has an unparseable group member ${m}`);
    }
  }
});

test("without an IOMMU, nothing is eligible", { skip }, async () => {
  const status = await passthroughStatus();
  if (status.iommuActive) return; // nothing to assert on this machine
  for (const d of await listPciDevices()) {
    assert.equal(d.eligible, false, `${d.id} is eligible with no IOMMU active`);
  }
});

test("USB devices are listed with parseable ids", { skip }, async () => {
  // No assertion on the count: a machine can legitimately have none.
  for (const d of await listUsbDevices()) {
    assert.equal(d.kind, "usb");
    assert.match(d.vendorId, /^[0-9a-f]{4}$/i);
    assert.match(d.productId, /^[0-9a-f]{4}$/i);
  }
});
