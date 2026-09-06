/** Administration contracts: user management, shared folders, services. */

import type { User, UserRole } from "./auth.js";

export interface AdminUser extends User {
  disabled: boolean;
  passkeyCount: number;
  /** Active (non-expired) session count - a rough "online" signal. */
  activeSessions: number;
  /** Their password was found in a known breach at its last set (HIBP). */
  passwordPwned: boolean;
  /** They have finished enrolling an authenticator app. */
  twoFactorEnabled: boolean;
  /** They hold a temporary password and must replace it before doing anything. */
  mustChangePassword: boolean;
  /** Their app list is being enforced. Always false for an admin. */
  appsRestricted: boolean;
}

/**
 * Which apps one person may use.
 *
 * `restricted: false` - the default, and what every account had before this
 * existed - means every app their role allows. `restricted: true` means only
 * `appIds`, plus the few an allow-list can never take away.
 */
export interface AppAccess {
  restricted: boolean;
  appIds: string[];
}

export interface UserAppAccessResponse extends AppAccess {
  userId: string;
  /** Every app that could be offered to this user, for the admin to choose from. */
  available: { id: string; name: string; category: string }[];
  /**
   * Apps the list cannot remove - Control Panel and About. A user who cannot
   * reach Control Panel cannot change their own password or enrol a passkey.
   */
  alwaysAvailable: string[];
}

export interface PasswordPolicyResponse {
  /** Reject passwords found in a known breach (HaveIBeenPwned) on set. */
  blockPwned: boolean;
  /**
   * Require every account to enrol a passkey. Users without one are held at a
   * setup gate on their next request rather than merely nagged.
   */
  requirePasskey: boolean;
}

// ---- Built-in OIDC identity provider --------------------------------------

export interface OidcClientInfo {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  createdAt: string;
}

export interface OidcClientsResponse {
  clients: OidcClientInfo[];
  /** The provider's issuer URL (the discovery doc lives at issuer/.well-known/openid-configuration). */
  issuer: string;
}

export interface CreateOidcClientResponse {
  client: OidcClientInfo;
  /** The client secret - shown ONCE; it's stored hashed and can't be retrieved again. */
  clientSecret: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

export interface CreateUserRequest {
  username: string;
  displayName: string;
  email?: string | null;
  role: UserRole;
  password: string;
  /** Treat `password` as temporary: force a change at first sign-in. */
  temporaryPassword?: boolean;
}

/** POST /api/admin/users/:id/password */
export interface SetUserPasswordRequest {
  password: string;
  /** Force the user to choose their own the next time they sign in. */
  temporary?: boolean;
}

export interface UpdateUserRequest {
  displayName?: string;
  email?: string | null;
  role?: UserRole;
  disabled?: boolean;
}

export interface ResetPasswordRequest {
  password: string;
}

// ---- Shared folders -------------------------------------------------------

export type AccessLevel = "none" | "ro" | "rw";

export interface SharePermission {
  userId: string;
  username: string;
  displayName: string;
  level: "ro" | "rw";
}

/** A group granted access to a share, resolved through its members. */
export interface ShareGroupPermission {
  groupId: string;
  name: string;
  level: "ro" | "rw";
}

// ---- Groups ---------------------------------------------------------------

/**
 * A named set of users. Flat by design - no nesting - so "who can read this?"
 * is answerable by looking at one level. The name doubles as a system group on
 * the appliance, which is why it takes the same characters as a username.
 */
export interface Group {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  memberCount: number;
}

export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
}

export interface GroupsResponse {
  groups: Group[];
}

export interface GroupDetailResponse {
  group: Group;
  members: GroupMember[];
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

// ---- Folder-level access rules --------------------------------------------

export type FolderAclSubject = "user" | "group";

/**
 * One rule for one subject on one folder below a share root. The rule closest
 * to a file decides, a user rule beats a group rule at the same depth, and the
 * most restrictive of several group rules at one depth applies.
 */
export interface FolderAcl {
  id: string;
  shareId: string;
  /** Relative to the share root, no leading or trailing slash. */
  path: string;
  subjectType: FolderAclSubject;
  subjectId: string;
  /** Username or group name. */
  subjectName: string;
  /** Display name for a user, or the group name. */
  subjectLabel: string;
  level: AccessLevel;
  createdAt: string;
}

export interface FolderAclsResponse {
  acls: FolderAcl[];
}

export interface SetFolderAclRequest {
  path: string;
  subjectType: FolderAclSubject;
  subjectId: string;
  level: AccessLevel;
}

/**
 * One NFS export rule: a client spec plus what it may do.
 *
 * NFS trusts the client's own idea of who its users are, so the address is the
 * access control. `rootSquash` maps a remote root down to `nobody`; turning it
 * off hands remote root ownership of everything in the share.
 */
export interface NfsRule {
  id: string;
  /** CIDR, address, hostname, wildcard domain, or "*". */
  network: string;
  level: "ro" | "rw";
  rootSquash: boolean;
}

export interface Share {
  id: string;
  name: string;
  comment: string;
  guestAccess: AccessLevel;
  smbEnabled: boolean;
  nfsEnabled: boolean;
  browseable: boolean;
  /** Data volume label this share lives on; null = the default share root. */
  volume: string | null;
  createdAt: string;
  permissions: SharePermission[];
  groupPermissions: ShareGroupPermission[];
  /**
   * Samba's `vfs_recycle`: a delete over SMB moves the file into the share's
   * own recycle folder rather than destroying it, matching the web UI.
   */
  recycleEnabled: boolean;
  /**
   * Offer this share to macOS as a Time Machine destination. Needs SMB on and
   * guest access off - Time Machine will not back up to a share anyone can
   * reach. The size cap, if the share has one, is passed to macOS so it stops
   * before filling the volume rather than being cut off mid-backup.
   */
  timeMachineEnabled: boolean;
  /**
   * Who may mount this share over NFS. Empty means the share falls back to the
   * global allowed-networks setting, which is how every share behaved before
   * per-share rules existed.
   */
  nfsRules: NfsRule[];
  /**
   * Size cap in bytes, 0 for none. Enforced by the filesystem (project quotas),
   * not by OpenNAS - so it applies to SMB and NFS writes as well as the web UI.
   */
  quotaBytes: number;
  /** Filesystem project id this share is accounted under, once one is assigned. */
  quotaProjectId: number | null;
  /** Bytes charged to the quota, read from the filesystem. Null when unknown. */
  quotaUsedBytes: number | null;
  /** Live folder stats (best-effort). */
  sizeBytes: number | null;
}

/** Whether a data volume can carry per-share quotas, and whether it does. */
export interface VolumeQuotaStatus {
  volume: string;
  fstype: string;
  supported: boolean;
  active: boolean;
  /** Why not, when it isn't supported or isn't on. */
  reason: string;
}

export interface QuotasResponse {
  volumes: VolumeQuotaStatus[];
  /**
   * Why per-*user* quotas aren't offered. Stated in the API so the UI doesn't
   * have to invent the explanation.
   */
  perUserNote: string;
}

export interface SharesResponse {
  shares: Share[];
}

export interface CreateShareRequest {
  name: string;
  comment?: string;
  guestAccess?: AccessLevel;
  smbEnabled?: boolean;
  nfsEnabled?: boolean;
  browseable?: boolean;
  /** Place the share on this data volume (its label). Omit for the default root. */
  volume?: string;
  recycleEnabled?: boolean;
  quotaBytes?: number;
}

/** A mounted data volume a share can be placed on. */
export interface StorageVolume {
  /** Volume label (also the directory name under the volumes root). */
  label: string;
  /** Absolute mount path on the appliance. */
  path: string;
  /** Total capacity in bytes (best-effort). */
  sizeBytes: number | null;
  /** Free space in bytes (best-effort). */
  freeBytes: number | null;
}

export interface VolumesResponse {
  volumes: StorageVolume[];
}

/**
 * Where OpenNAS places the data it manages for VMs and containers. Each is a
 * base directory; null means "use the built-in default under the data dir".
 * VM disks + ISOs go under `<vm>/disks` and `<vm>/iso`; container service
 * volumes + compose stacks go under `<containers>/services` and `.../stacks`.
 */
export interface StorageLocations {
  vm: string | null;
  containers: string | null;
}

export interface StorageLocationsResponse {
  locations: StorageLocations;
  /** Built-in defaults (shown when a location is unset). */
  defaults: { vm: string; containers: string };
  /** Mounted data volumes the user can pick as a base directory. */
  volumes: StorageVolume[];
}

export interface UpdateShareRequest {
  comment?: string;
  guestAccess?: AccessLevel;
  smbEnabled?: boolean;
  nfsEnabled?: boolean;
  browseable?: boolean;
  /** Replace the full permission set. */
  permissions?: { userId: string; level: "ro" | "rw" }[];
}

// ---- Services -------------------------------------------------------------

export interface ServicesConfig {
  smb: {
    enabled: boolean;
    workgroup: string;
    serverString: string;
    /** Allow unauthenticated guest access to guest-enabled shares. */
    allowGuest: boolean;
  };
  nfs: {
    enabled: boolean;
    /** Comma-separated allowed client networks, e.g. "192.168.1.0/24". */
    allowedNetworks: string;
  };
  afp: {
    enabled: boolean;
  };
}

export interface ServicesResponse {
  config: ServicesConfig;
  /** Generated config previews so the user can see exactly what would apply. */
  generated: { smbConf: string; exports: string };
  /** Whether OpenNAS detected the relevant daemons on this host. */
  daemons: { smbd: boolean; nfsd: boolean; afpd: boolean };
}

// ---- TLS certificate ------------------------------------------------------

export interface TlsInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256 fingerprint. */
  fingerprint: string;
  /** True when issuer === subject (the default self-signed cert). */
  selfSigned: boolean;
  /** subjectAltName string, if any. */
  altNames: string | null;
}

export interface TlsResponse {
  tls: TlsInfo | null;
}

export interface ReplaceTlsRequest {
  /** PEM-encoded certificate (chain allowed). */
  cert: string;
  /** PEM-encoded private key matching the certificate. */
  key: string;
}

// ---- Power ----------------------------------------------------------------

export type PowerAction = "reboot" | "poweroff";
