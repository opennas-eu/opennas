/** System / hardware telemetry contracts. */

export interface SystemStaticInfo {
  hostname: string;
  os: { platform: string; distro: string; release: string; arch: string };
  cpu: { manufacturer: string; brand: string; cores: number; physicalCores: number; speedGHz: number };
  memoryTotalBytes: number;
  uptimeSeconds: number;
  opennasVersion: string;
}

export interface CpuLoad {
  /** Overall load 0..100. */
  total: number;
  /** Per-logical-core load 0..100. */
  perCore: number[];
}

export interface MemoryStat {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** Used by apps (excludes cache/buffers) when available. */
  activeBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface DiskVolume {
  fs: string;
  mount: string;
  type: string;
  sizeBytes: number;
  usedBytes: number;
  usePercent: number;
}

// ---- Storage manager (physical disks) -------------------------------------

export interface StoragePartition {
  name: string; // e.g. /dev/sda1
  sizeBytes: number;
  fsType: string | null;
  mountpoint: string | null;
  label: string | null;
  /** Filesystem usage when mounted (null otherwise). */
  usedBytes: number | null;
  freeBytes: number | null;
}

/** S.M.A.R.T. health summary for a disk (null when unavailable). */
export interface SmartInfo {
  status: "passed" | "failed" | "unknown";
  temperatureC: number | null;
  powerOnHours: number | null;
  /** Reallocated sector count (ATA); null for NVMe / unknown. */
  reallocatedSectors: number | null;
}

export interface StorageDisk {
  name: string; // e.g. /dev/sda
  model: string | null;
  serial: string | null;
  sizeBytes: number;
  /** true = spinning HDD, false = SSD/flash. */
  rotational: boolean;
  removable: boolean;
  /** system = holds the OS; data = has a usable filesystem; unconfigured = blank. */
  state: "system" | "data" | "unconfigured";
  /** S.M.A.R.T. health, when readable (linux mode + smartctl). */
  smart: SmartInfo | null;
  /**
   * Unallocated space on the disk, in bytes (null when it couldn't be read).
   *
   * This is what makes a single-disk machine usable: the OS disk can't be wiped
   * into a data volume, but the space left after the system partition can be
   * claimed as one without touching anything that's already there.
   */
  unallocatedBytes: number | null;
  partitions: StoragePartition[];
}

export interface StorageResponse {
  disks: StorageDisk[];
}

// ---- RAID (mdadm, read-only status) ---------------------------------------

export interface RaidMember {
  name: string; // e.g. /dev/sda1
  state: "active" | "faulty" | "spare";
}

export interface RaidArray {
  name: string; // e.g. /dev/md0
  level: string; // raid1, raid5...
  /** active | degraded | recovery | resync | reshape | check ... */
  state: string;
  sizeBytes: number | null;
  totalDevices: number;
  activeDevices: number;
  members: RaidMember[];
  /** Rebuild/resync progress 0-100, or null when not syncing. */
  syncPercent: number | null;
}

export interface RaidResponse {
  arrays: RaidArray[];
}

export type RaidLevel = "raid0" | "raid1" | "raid5" | "raid6" | "raid10";

export interface CreateRaidRequest {
  level: RaidLevel;
  /** Volume label (also the mount dir name and the array's filesystem label). */
  label: string;
  fsType: "ext4" | "btrfs" | "xfs";
  /** Member disks, e.g. ["/dev/sdb", "/dev/sdc"]. Must all be unconfigured. */
  disks: string[];
}

/** Somewhere a new VM, stack or service can put its data. */
export interface StorageTarget {
  /** Data-volume label, or "" for the configured default location. */
  label: string;
  name: string;
  path: string;
}

/** GET /api/admin/storage/targets */
export interface StorageTargetsResponse {
  targets: StorageTarget[];
}

/** POST /api/admin/storage/expand - claim a disk's unallocated space. */
export interface ExpandDiskRequest {
  disk: string;
  label: string;
  fsType: "ext4" | "btrfs" | "xfs";
  /** e.g. "500G". Omit to use all remaining free space. */
  size?: string;
}

export interface InitDiskRequest {
  disk: string;
  fsType: "ext4" | "btrfs" | "xfs";
  label: string;
}

// ---- Network / time / update management -----------------------------------

export interface NetIface {
  name: string;
  mac: string;
  ip4: string;
  ip4subnet: string;
  state: string;
  dhcp: boolean;
  speedMbps: number | null;
}

export interface NetworkInfo {
  hostname: string;
  gateway: string;
  dns: string[];
  interfaces: NetIface[];
  /**
   * The name this NAS answers to on the local network, e.g. "opennas.local".
   * Null when mDNS isn't running, in which case the box can only be reached by
   * IP and the UI should say so rather than print a name that won't resolve.
   */
  mdnsName: string | null;
}

export interface NetworkResponse { network: NetworkInfo }

export interface TimeInfo {
  timezone: string;
  /** ISO timestamp of the server's current time. */
  now: string;
  ntpServer: string | null;
}

export interface TimeResponse { time: TimeInfo }

export interface UpdateInfo {
  opennasVersion: string;
  alpineVersion: string;
  uptimeSeconds: number;
  kernel: string;
}

export interface UpdateResponse { update: UpdateInfo }

export interface NetworkStat {
  iface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxTotalBytes: number;
  txTotalBytes: number;
}

export interface TemperatureStat {
  /** Main package temp in °C, or null if unreadable. */
  mainC: number | null;
  coresC: number[];
}

/** A single running process, as shown in the Task Manager. */
export interface ProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  /** CPU usage 0..100 (can exceed 100 across multiple cores). */
  cpu: number;
  /** Memory usage 0..100 of total RAM. */
  memPercent: number;
  memBytes: number;
  user: string;
  state: string;
  command: string;
}

export interface ProcessListResponse {
  processes: ProcessInfo[];
  total: number;
  /** Whether the current user may end processes. */
  canKill: boolean;
}

/** A single point-in-time telemetry sample, streamed over WS. */
export interface SystemSample {
  timestamp: number;
  cpu: CpuLoad;
  memory: MemoryStat;
  network: NetworkStat[];
  temperature: TemperatureStat;
  uptimeSeconds: number;
  /** Number of currently logged-in / active processes-ish summary. */
  processes: { total: number; running: number };
}

// ---- Admin essentials: SSH, SMTP, logs ------------------------------------

export interface SshKey {
  id: string;
  comment: string;
  /** The full public key line. */
  value: string;
}

export interface SshConfig {
  /** sshd present + the appliance can manage it (linux mode). */
  available: boolean;
  /** Enabled at boot + currently running. */
  enabled: boolean;
  /** The account authorized keys apply to (the console admin), or null. */
  user: string | null;
  keys: SshKey[];
}

export interface SshResponse {
  ssh: SshConfig;
}

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Use TLS (true) or STARTTLS/none (false). */
  secure: boolean;
  username: string;
  /** A password is stored - the value itself is never returned. */
  hasPassword: boolean;
  /** From address. */
  from: string;
  /** Default alert recipient. */
  to: string;
  /** Email the recipient when a disk reports a S.M.A.R.T. problem. */
  alertDiskHealth: boolean;
}

export interface SmtpResponse {
  smtp: SmtpConfig;
}

export type LogSourceId = "system" | "opennas" | "nginx" | "auth";

export interface LogSourceInfo {
  id: LogSourceId;
  label: string;
  available: boolean;
}

export interface LogsResponse {
  source: LogSourceId;
  sources: LogSourceInfo[];
  /** Most-recent lines (oldest first). */
  lines: string[];
}

// ---- Containers (Docker) --------------------------------------------------

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** running | exited | created | paused ... */
  state: string;
  /** Human status, e.g. "Up 2 hours". */
  status: string;
  /** Raw port mapping string, e.g. "0.0.0.0:8096->8096/tcp". */
  ports: string;
  createdAt: string;
}

export interface ContainerStats {
  cpu: string;
  mem: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
}

export interface DockerImage {
  id: string;
  ref: string;
  size: string;
  created: string;
}

export interface DockerStatus {
  /** docker binary present. */
  available: boolean;
  /** daemon reachable. */
  running: boolean;
  containers: ContainerInfo[];
}

export interface ContainersResponse {
  docker: DockerStatus;
}

export interface ContainerStatsResponse {
  stats: ContainerStats | null;
}

export interface ImagesResponse {
  images: DockerImage[];
}

// ---- Compose stacks -------------------------------------------------------

export interface StackInfo {
  name: string;
  /** Total service containers in the stack. */
  services: number;
  /** How many are running. */
  running: number;
}

export interface StacksResponse {
  stacks: StackInfo[];
}

export interface StackComposeResponse {
  compose: string;
}

// ---- Firewall --------------------------------------------------------------

export type FirewallServiceId = "web" | "ssh" | "smb" | "nfs" | "afp" | "discovery";

export interface FirewallPort {
  proto: "tcp" | "udp";
  port: number;
}

/** One thing OpenNAS listens on, named the way an admin thinks about it. */
export interface FirewallService {
  id: FirewallServiceId;
  name: string;
  description: string;
  ports: FirewallPort[];
  /** Closing this would lock the admin out, so the UI must not offer to. */
  alwaysOn?: boolean;
}

export interface FirewallConfig {
  enabled: boolean;
  allowed: FirewallServiceId[];
  /** CIDRs (or bare addresses) that get special treatment; see restrictToTrusted. */
  trustedNetworks: string[];
  /**
   * false - trusted networks reach everything, everyone else gets the toggles.
   * true  - *only* trusted networks get in at all. Much stricter, and the reason
   * applying a change needs confirming from a working connection.
   */
  restrictToTrusted: boolean;
}

export interface FirewallResponse {
  config: FirewallConfig;
  services: FirewallService[];
  /** True when the appliance can actually enforce this (nftables present). */
  available: boolean;
  /** Why not, when it can't. */
  unavailableReason: string | null;
  /** The ruleset that would be (or is) loaded - shown for review. */
  preview: string;
}

/**
 * Applying a firewall change can cut off the connection making the request, so
 * a change is staged: it is loaded, and then reverted automatically unless it
 * is confirmed from a connection that still works.
 */
export interface FirewallApplyResponse {
  config: FirewallConfig;
  /** Present when a confirmation is outstanding. */
  pending: { token: string; revertsInSeconds: number } | null;
  preview: string;
}

// ---- ACME / Let's Encrypt --------------------------------------------------

export interface AcmeSettings {
  enabled: boolean;
  /** Names to request. The first is the certificate's common name. */
  domains: string[];
  /** Contact address the CA uses for expiry warnings. */
  email: string;
  /** Directory URL - production, staging, or another ACME CA. */
  directoryUrl: string;
  /** The admin has accepted the CA's terms of service. */
  agreedTos: boolean;
}

export type AcmeRunStatus = "never" | "running" | "ok" | "error";

export interface AcmeState {
  status: AcmeRunStatus;
  lastRunAt: string | null;
  lastError: string | null;
  /** Expiry of the certificate currently installed, when it came from ACME. */
  certExpiresAt: string | null;
  /** Names on the installed ACME certificate. */
  certDomains: string[];
}

export interface AcmeResponse {
  settings: AcmeSettings;
  state: AcmeState;
  /** Whether this build can write certificates and reload the proxy. */
  available: boolean;
  unavailableReason: string | null;
  /** Terms of service URL advertised by the configured CA, when reachable. */
  termsOfService: string | null;
}

// ---- Private container registries -----------------------------------------

/**
 * A registry OpenNAS can pull from. The password is deliberately absent:
 * `docker login` keeps it in Docker's own credential store, and a second copy
 * in the OpenNAS database would be a re-usable secret with nothing to use it.
 */
export interface ContainerRegistry {
  /** Hostname (with optional port), or "docker.io" for Docker Hub. */
  host: string;
  username: string;
  /** Whether Docker currently holds a credential for this host. */
  loggedIn: boolean;
  lastLoginAt: string | null;
}

export interface RegistriesResponse {
  registries: ContainerRegistry[];
  /** False when Docker isn't installed or isn't running. */
  dockerAvailable: boolean;
}

// ---- Scheduled system maintenance ------------------------------------------

/**
 * What a scheduled task does. A fixed catalogue rather than an arbitrary
 * command: scheduling a script from the web UI would turn an admin session into
 * root code execution, and these four cover what a NAS actually needs run on a
 * timer.
 */
export type SystemTaskKind = "config-backup" | "scrub" | "trim" | "smart-test";

export type SystemTaskFrequency = "daily" | "weekly" | "monthly";

export interface SystemTask {
  id: string;
  name: string;
  kind: SystemTaskKind;
  /** Volume label, or disk path for a SMART test. Empty for kinds that need none. */
  target: string;
  frequency: SystemTaskFrequency;
  /** Local time - "3am" means 3am where the NAS is. */
  hour: number;
  minute: number;
  /** 0 = Sunday. Only meaningful for a weekly task. */
  weekday: number;
  /** Clamped to the length of the month, so "31" works in February. */
  dayOfMonth: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "running" | null;
  lastOutput: string | null;
  createdAt: string;
}

export interface SystemTasksResponse {
  tasks: SystemTask[];
  /** Volume labels a scrub or trim can target. */
  volumes: string[];
  /** Disk paths a SMART test can target. */
  disks: string[];
}


/** An address blocked for repeated failed sign-ins. */
export interface IpBan {
  address: string;
  reason: string;
  /** How many failures earned the ban. */
  failures: number;
  bannedAt: string;
  expiresAt: string;
  /** Whether the kernel is actually enforcing it right now. */
  active: boolean;
}

export interface IpBansResponse {
  bans: IpBan[];
  honeypot: HoneypotConfig;
  /**
   * False when the firewall is off. Bans are recorded either way, but nothing
   * enforces them until it is on - which the UI has to say rather than showing
   * a list of blocks that aren't happening.
   */
  enforced: boolean;
}

/**
 * The decoy trap.
 *
 * Separate from the firewall's own settings because it is a different decision:
 * the firewall is about which ports are open, this is about what happens when
 * something asks for a path only a scanner would ask for.
 */
export interface HoneypotConfig {
  enabled: boolean;
  /** How long a decoy hit is blocked for, in seconds. */
  banSeconds: number;
  /** A few of the watched paths, so the UI can show what this actually means. */
  examples: string[];
}

// ---- ZFS --------------------------------------------------------------------

/**
 * Whether ZFS can be used on this machine at all.
 *
 * Three states rather than a boolean, because "installed but the module isn't
 * loaded" is a real and recoverable situation - it is what a kernel update that
 * outran `zfs-lts` looks like - and it needs a different sentence from "this
 * build doesn't have ZFS".
 */
export interface ZfsStatus {
  state: "ready" | "no-module" | "absent";
  /** Empty when ready; otherwise what to tell the admin. */
  reason: string;
  version: string;
  /**
   * Whether a raidz vdev can gain a disk. False below OpenZFS 2.3, which is
   * what Alpine currently ships - the most surprising limitation for anyone
   * arriving from mdadm, so the UI says it before a pool is created rather
   * than after.
   */
  raidzExpansion: boolean;
}

export type ZfsLayout = "stripe" | "mirror" | "raidz1" | "raidz2" | "raidz3";

export interface ZfsVdevMember {
  name: string;
  state: string;
  /** Read/write/checksum error counts, as ZFS reports them. */
  errors: { read: number; write: number; checksum: number };
}

export interface ZfsVdev {
  /** "raidz2-0", "mirror-1", or a bare device for a stripe. */
  name: string;
  type: string;
  state: string;
  members: ZfsVdevMember[];
}

export interface ZfsPool {
  name: string;
  sizeBytes: number;
  allocatedBytes: number;
  freeBytes: number;
  /** ONLINE, DEGRADED, FAULTED, UNAVAIL... straight from ZFS. */
  health: string;
  fragmentationPercent: number;
  capacityPercent: number;
  dedupRatio: number;
  vdevs: ZfsVdev[];
  /** A scrub or resilver in progress, if any. */
  scan: { kind: string; percent: number | null; note: string } | null;
  /** ZFS's own summary line - the honest answer to "is anything wrong". */
  statusNote: string;
  mountpoint: string;
}

export interface ZfsDataset {
  name: string;
  usedBytes: number;
  availableBytes: number;
  /** 0 means no quota. */
  quotaBytes: number;
  mountpoint: string;
  compression: string;
}

export interface ZfsSnapshot {
  /** Full name, dataset@snapshot. */
  name: string;
  dataset: string;
  snapshot: string;
  usedBytes: number;
  referencedBytes: number;
  createdAt: string;
}

export interface ZfsResponse {
  status: ZfsStatus;
  pools: ZfsPool[];
  datasets: ZfsDataset[];
  /** Pools found on disk but not imported - after a reinstall, or moved disks. */
  importable: string[];
}

export interface ZfsSnapshotsResponse {
  snapshots: ZfsSnapshot[];
}

/** What each layout costs and survives, so the UI never has to hardcode it. */
export interface ZfsLayoutInfo {
  id: ZfsLayout;
  name: string;
  minDisks: number;
  /** How many disks may fail before the pool is lost. -1 = any one loses it. */
  faultTolerance: number;
  note: string;
}

// ---- Dynamic DNS -----------------------------------------------------------

/**
 * Which protocol to speak. `dyndns2` is the old DynDNS interface that No-IP,
 * Dynu, Namecheap and many others still implement, so one entry covers most
 * providers that aren't DuckDNS or Cloudflare.
 */
export type DdnsProviderId = "duckdns" | "dyndns2" | "cloudflare";

export interface DdnsConfig {
  enabled: boolean;
  provider: DdnsProviderId;
  /** The name being kept current, e.g. "home.example.com". */
  hostname: string;
  /** dyndns2 only. */
  username: string;
  /** dyndns2 only: the provider's update host. */
  server: string;
  /** Cloudflare only: the zone id the record lives in. */
  zone: string;
  /** Whether a token or password is stored. The value itself never leaves the server. */
  hasSecret: boolean;
}

export interface DdnsStatus {
  config: DdnsConfig;
  /** The public address last seen, or "" before the first successful check. */
  lastIp: string;
  lastCheckedAt: string;
  lastUpdatedAt: string;
  lastStatus: "ok" | "error" | "never";
  lastMessage: string;
}

export interface DdnsResponse {
  ddns: DdnsStatus;
}

// ---- Self-update -----------------------------------------------------------

/** A release the update channel is offering. */
export interface UpdateRelease {
  version: string;
  releasedAt: string;
  notes: string;
  bundleUrl: string;
  signatureUrl: string;
  /** Checked before the bundle is handed on, so a truncated download fails clearly. */
  sha256: string;
}

/** What the privileged updater last did. */
export interface UpdateState {
  state: "idle" | "running" | "ok" | "failed" | "rolled_back";
  message: string;
  at: string;
}

export interface SelfUpdateResponse {
  /** The version actually running, read from the payload on disk. */
  current: string;
  /** Null when nothing newer is offered. */
  available: UpdateRelease | null;
  /** Why a check didn't produce an answer, if it didn't. */
  error: string;
  /** False when this install has no privileged updater - a manual build, say. */
  supported: boolean;
  channel: string;
  status: UpdateState;
}
