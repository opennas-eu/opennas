/** Authentication & identity contracts. */

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: UserRole;
  /** "local" account, or the id of the OIDC provider that owns this identity. */
  source: "local" | string;
  avatarColor: string;
  /** URL to an uploaded profile picture, or null to fall back to initials. */
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  user: User;
  /** Methods this session was authenticated with (audit/debug + UI hints). */
  authMethods: AuthMethod[];
  expiresAt: string;
  /**
   * Mandatory account setup still outstanding. While this is non-empty the API
   * refuses everything except the routes that clear it, so the desktop has to
   * deal with it rather than merely mentioning it.
   */
  pendingActions: PendingAction[];
}

export type AuthMethod = "password" | "passkey" | "oidc" | "totp" | "recovery-code" | "autologin";

/**
 * Signing in automatically from a known network - a dashboard on a wall, where
 * typing a password on every reload defeats the purpose.
 *
 * `networks` is the whole of the restriction, so an empty list means disabled
 * however `enabled` reads. The account can never be an administrator, and never
 * one with two-factor enabled.
 */
export interface AutologinConfig {
  enabled: boolean;
  /** The account to sign in. Never an admin. */
  userId: string | null;
  /** CIDRs the request must come from. Empty means nobody. */
  networks: string[];
}

export interface AutologinResponse {
  autologin: AutologinConfig;
  /** Accounts that are eligible, with why the others aren't. */
  candidates: { id: string; username: string; displayName: string; eligible: boolean; reason: string }[];
}

/**
 * "password" - an admin issued a temporary one and it has to be replaced.
 * "passkey"  - the server requires every account to have a passkey enrolled.
 */
export type PendingAction = "password" | "passkey";

/** One active sign-in, as shown in Control Panel → Security → Signed-in devices. */
export interface SessionSummary {
  id: string;
  /** Friendly device string derived from the user agent, e.g. "Firefox on Linux". */
  device: string;
  /** Raw user agent, for when the friendly string isn't enough. */
  userAgent: string | null;
  /** IP the session was created from. */
  ip: string | null;
  authMethods: AuthMethod[];
  createdAt: string;
  expiresAt: string;
  /** True for the session making the request - the UI must not offer to revoke it silently. */
  current: boolean;
}

/** GET /api/auth/sessions */
export interface SessionsResponse {
  sessions: SessionSummary[];
}

/** GET /api/auth/me - current session, or null when logged out. */
export type MeResponse = { session: SessionInfo | null };

/**
 * A password sign-in either completes, or stops half-way and asks for a second
 * factor. The ticket stands in for the verified password while that happens -
 * it is single-purpose, expires in five minutes and tolerates a few wrong codes
 * before the password has to be entered again.
 */
export type LoginResponse =
  | { session: SessionInfo; mfaRequired?: false }
  | { session: null; mfaRequired: true; ticket: string; recoveryCodesAvailable: boolean };

/** POST /api/auth/login/totp */
export interface LoginTotpRequest {
  ticket: string;
  /** A six-digit code from the authenticator, or one of the recovery codes. */
  code: string;
}

/** GET /api/auth/totp - the caller's own two-factor state. */
export interface TotpStatus {
  enabled: boolean;
  confirmedAt: string | null;
  /** Recovery codes not yet spent; a warning is due when this gets low. */
  recoveryCodesRemaining: number;
}

/** POST /api/auth/totp/setup - everything needed to enrol an authenticator. */
export interface TotpSetupResponse {
  /** Base32, for typing in by hand when a camera isn't an option. */
  secret: string;
  /** The otpauth:// URI encoded in the QR, exposed for copy-paste and testing. */
  uri: string;
  /** Inline SVG of the QR code. Rendered server-side; no scripts, no fetches. */
  qrSvg: string;
}

/** POST /api/auth/totp/enable - enrolment finished; codes are shown once. */
export interface TotpEnableResponse {
  ok: true;
  recoveryCodes: string[];
}

/** POST /api/auth/me/password */
export interface ChangePasswordRequest {
  /** Omitted only when the account has no password yet (SSO-provisioned). */
  currentPassword?: string;
  newPassword: string;
}

/** Server bootstrap state, drives the first-run setup wizard vs login screen. */
export interface BootstrapState {
  /** True until the first admin account exists. */
  needsSetup: boolean;
  instanceName: string;
  /** Whether "Login with SSO" should be offered, and under what label. */
  oidc: { enabled: boolean; buttonLabel: string } | null;
  /** Whether the current device/browser may attempt a passkey login. */
  passkeysEnabled: boolean;
}

export interface LoginPasswordRequest {
  username: string;
  password: string;
}

export interface SetupRequest {
  instanceName: string;
  username: string;
  displayName: string;
  password: string;
}

/** A registered WebAuthn credential, as shown in account settings. */
export interface PasskeySummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** e.g. "platform" (Touch ID / Windows Hello) vs "cross-platform" (USB key). */
  deviceType: string;
  backedUp: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  /** Optional field-level validation details. */
  fields?: Record<string, string>;
}
