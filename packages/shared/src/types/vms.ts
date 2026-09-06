/**
 * Virtual machines (KVM/QEMU via libvirt). The API drives `virsh` on the host;
 * when libvirt isn't installed the whole subsystem reports `available: false`
 * and the UI shows an "unavailable" state (same demo-safe pattern as Docker).
 */

export type VmState = "running" | "paused" | "shutoff" | "crashed" | "other";

export interface VmInfo {
  name: string;
  uuid: string;
  state: VmState;
  /** Allocated virtual CPUs. */
  vcpus: number;
  /** Allocated memory in MiB. */
  memoryMiB: number;
  /** Start automatically when the host boots. */
  autostart: boolean;
  /**
   * VNC display port (5900 + display number) when the VM is running with a
   * graphical console, else null. Bound to 127.0.0.1 - reachable only through
   * the OpenNAS console proxy, never exposed on the network.
   */
  vncPort: number | null;
}

export interface VirtStatus {
  /** `virsh` binary present on the host. */
  available: boolean;
  /** libvirtd reachable (we could enumerate domains). */
  running: boolean;
  /** Hardware virtualization (/dev/kvm) present - VMs run at native speed. */
  kvm: boolean;
  vms: VmInfo[];
}

export interface VmsResponse {
  virt: VirtStatus;
}

/** An installer image available to boot a new VM from. */
export interface IsoFile {
  name: string;
  sizeBytes: number;
}

export interface IsosResponse {
  isos: IsoFile[];
}

export interface CreateVmRequest {
  name: string;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  /** File name (within the ISO library) to attach as a boot CD-ROM, if any. */
  iso?: string | null;
  /**
   * Data-volume label to store this VM's disk on; omit/"" for the default
   * location. Chosen per VM, so a big VM can live on the big disk.
   */
  volume?: string | null;
  /**
   * Network to attach the guest to. A libvirt network name (e.g. "default"),
   * or a host bridge name when `networkIsBridge` is set - the latter puts the
   * VM directly on the LAN with its own address.
   */
  network?: string | null;
  networkIsBridge?: boolean;
}

export type VmAction = "start" | "shutdown" | "reboot" | "destroy" | "suspend" | "resume";

// ---- Virtual networks ------------------------------------------------------

/** A libvirt network a VM can be attached to. */
export interface VirtNetwork {
  name: string;
  active: boolean;
  autostart: boolean;
  /** Host bridge libvirt created for it, when it has one. */
  bridge: string | null;
  /** "nat", "bridge", "route", or "isolated" when there's no forwarding at all. */
  mode: string;
  /** The host's address on the network, for NAT networks. */
  ipAddress: string | null;
  /** libvirt's own `default` network, which OpenNAS won't remove. */
  builtin: boolean;
}

/** A Docker network containers can be attached to. */
export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  /** One of Docker's own (bridge/host/none), which can't be removed. */
  builtin: boolean;
  /** Attached containers - what makes "is this safe to delete?" answerable. */
  containers: number;
}

export interface NetworksResponse {
  virt: VirtNetwork[];
  docker: DockerNetwork[];
  /**
   * Bridges the host already has. A VM can be put straight onto one to sit on
   * the LAN; OpenNAS does not create them, because building a host bridge
   * re-plumbs the NIC and a mistake takes the NAS off the network entirely.
   */
  hostBridges: string[];
  virtAvailable: boolean;
  dockerAvailable: boolean;
}

export interface CreateVirtNetworkRequest {
  name: string;
  mode: "nat" | "isolated";
  /** A /24, e.g. "192.168.140.0/24". */
  subnet: string;
}

// ---- VM snapshots ----------------------------------------------------------

/**
 * A libvirt snapshot, stored inside the qcow2 disk image.
 *
 * One taken while the VM is running also captures memory, so reverting puts the
 * guest back mid-flight; one taken while it's off is disk-only and reverts to a
 * clean boot. `withMemory` says which you got, because the difference matters
 * when you come to restore.
 */
export interface VmSnapshot {
  name: string;
  createdAt: string | null;
  withMemory: boolean;
  /** libvirt's own state word, e.g. "running" or "shutoff". */
  state: string;
  description: string;
}

export interface VmSnapshotsResponse {
  snapshots: VmSnapshot[];
}

// ---- Device passthrough ----------------------------------------------------

/**
 * A host device that could be handed to a VM.
 *
 * USB and PCI are very different propositions and this type covers both, so
 * `eligible`/`reason` carry the difference: USB works anywhere, while PCI needs
 * an active IOMMU and must never be a device the host itself is relying on.
 */
export interface HostDevice {
  kind: "pci" | "usb";
  /** PCI address ("0000:03:00.0") or USB "vendor:product". */
  id: string;
  vendorId: string;
  productId: string;
  description: string;
  /** The host driver currently bound, for PCI devices. */
  driver: string | null;
  iommuGroup: number | null;
  /**
   * Other devices in the same IOMMU group. vfio binds a group as a unit, so
   * these move to the guest along with it - which is why a GPU normally brings
   * its audio function, and why a device sharing a group with the boot disk's
   * controller can't be passed through at all.
   */
  groupMembers: string[];
  eligible: boolean;
  /** Why it isn't eligible - shown to the admin verbatim. */
  reason: string;
}

/** Whether this machine can do PCI passthrough at all. */
export interface PassthroughStatus {
  iommuActive: boolean;
  iommuGroups: number;
  vfioAvailable: boolean;
  /** What to change to make PCI passthrough possible, when it isn't. */
  reason: string;
}

export interface HostDevicesResponse {
  status: PassthroughStatus;
  pci: HostDevice[];
  usb: HostDevice[];
}

export interface VmDevicesResponse {
  attached: HostDevice[];
}
