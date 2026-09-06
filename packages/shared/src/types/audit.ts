/** Audit log - who did what, when. */

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** null for unauthenticated requests (e.g. a failed login). */
  actorId: string | null;
  /** Username at the time - kept even after the account is deleted. */
  actorName: string;
  actorIp: string | null;
  /** Dotted action name, e.g. "user.delete". */
  action: string;
  /** What was acted on, when the route identifies one. */
  target: string | null;
  /** Request detail with secrets redacted. */
  detail?: Record<string, unknown>;
  outcome: AuditOutcome;
  /** HTTP status the request returned. */
  status: number;
}

/** GET /api/admin/audit */
export interface AuditResponse {
  entries: AuditEntry[];
  /** Total matching the filter, for paging. */
  total: number;
  /** Distinct action names present, for the filter dropdown. */
  actions: string[];
}

/** An account currently locked out after repeated failed sign-ins. */
export interface AccountLockout {
  username: string;
  failures: number;
  lastFailAt: string | null;
  /** ISO timestamp the lock expires on its own. */
  lockedUntil: string;
}

/** GET /api/admin/lockouts */
export interface LockoutsResponse {
  lockouts: AccountLockout[];
}

// ---- Configuration backup / restore ----------------------------------------

/** A user as carried in a config backup. Passwords are never included. */
export interface BackupUser {
  username: string;
  displayName: string;
  email: string | null;
  role: "admin" | "user";
  disabled: boolean;
  avatarColor: string;
}

/** A shared folder plus who may use it, keyed by username (ids are per-install). */
export interface BackupShare {
  name: string;
  comment: string;
  guestAccess: "none" | "ro" | "rw";
  smbEnabled: boolean;
  nfsEnabled: boolean;
  browseable: boolean;
  volume: string | null;
  recycleEnabled: boolean;
  permissions: { username: string; level: "ro" | "rw" }[];
  /** Group grants, keyed by group name for the same reason as usernames. */
  groupPermissions: { group: string; level: "ro" | "rw" }[];
  /** Folder rules below this share's root. */
  folderRules: {
    path: string;
    subjectType: "user" | "group";
    /** Username or group name - never an id, which is per-install. */
    subject: string;
    level: "none" | "ro" | "rw";
  }[];
}

/** A group and its members, by username. */
export interface BackupGroup {
  name: string;
  description: string;
  members: string[];
}

export interface BackupOidcClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string;
}

/** GET /api/admin/config/export */
export interface ConfigBackup {
  format: number;
  /** OpenNAS version that produced the file. */
  version: string;
  exportedAt: string;
  settings: Record<string, string>;
  users: BackupUser[];
  groups: BackupGroup[];
  shares: BackupShare[];
  oidcClients: BackupOidcClient[];
  /** Human-readable list of what this file deliberately does NOT contain. */
  excluded: string[];
}

/** POST /api/admin/config/plan - what an import would do, without doing it. */
export interface ConfigRestorePlan {
  ok: boolean;
  problems: string[];
  settings: number;
  usersNew: number;
  usersUpdated: number;
  sharesNew: number;
  sharesUpdated: number;
  groupsNew: number;
  groupsUpdated: number;
  oidcClients: number;
}

/** POST /api/admin/config/import */
export interface ConfigRestoreResult {
  settings: number;
  usersCreated: number;
  usersUpdated: number;
  sharesCreated: number;
  sharesUpdated: number;
  groupsCreated: number;
  groupsUpdated: number;
  folderRules: number;
  /** Accounts created without a password - they stay disabled until one is set. */
  usersNeedingPassword: string[];
  warnings: string[];
}
