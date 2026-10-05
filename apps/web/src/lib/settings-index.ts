/**
 * The searchable catalogue of Control Panel destinations.
 *
 * Kept as data next to the panel rather than derived from it, so search can
 * match on words a user would actually type ("password", "certificate", "wifi")
 * rather than only on the nav label they'd have to already know.
 */
import type { MessageKey } from "../i18n/index.ts";

export interface SettingsEntry {
  /** Control Panel section id - matches the `Section` union in ControlPanel.tsx. */
  section: string;
  /** Catalogue keys; search matches the translated text and the English. */
  label: MessageKey;
  description: MessageKey;
  /** Extra words that should match this entry. */
  keywords: string[];
  /** Only offered to admins. */
  adminOnly: boolean;
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  { section: "account", label: "cp.account", description: "ui.settings.account", keywords: ["profile", "avatar", "name", "email", "me"], adminOnly: false },
  { section: "security", label: "cp.security", description: "ui.settings.security", keywords: ["passkey", "webauthn", "password", "change password", "sessions", "devices", "sign out", "2fa", "two-factor", "two factor", "mfa", "totp", "authenticator", "otp", "recovery codes", "touch id"], adminOnly: false },
  { section: "personalization", label: "cp.personalization", description: "ui.settings.personalization", keywords: ["wallpaper", "theme", "dark mode", "light", "accent", "colour", "color", "appearance", "background"], adminOnly: false },
  { section: "connectivity", label: "cp.sso", description: "ui.settings.connectivity", keywords: ["sso", "oidc", "login", "identity", "authentik", "keycloak"], adminOnly: false },
  { section: "users", label: "cp.users", description: "ui.settings.users", keywords: ["account", "add user", "admin", "role", "disable", "reset password", "temporary password", "require passkey", "people"], adminOnly: true },
  { section: "groups", label: "cp.groups", description: "ui.settings.groups", keywords: ["group", "team", "family", "members", "membership", "permissions", "access"], adminOnly: true },
  { section: "identity", label: "cp.identityProvider", description: "ui.settings.identity", keywords: ["oidc", "provider", "client", "sso", "openid"], adminOnly: true },
  { section: "storage", label: "cp.storage", description: "ui.settings.storage", keywords: ["disk", "drive", "raid", "smart", "volume", "mount", "format", "health", "hdd", "ssd"], adminOnly: true },
  { section: "shares", label: "cp.sharedFolders", description: "ui.settings.shares", keywords: ["share", "folder", "permission", "access", "smb", "nfs", "acl", "folder rules", "recycle bin", "group"], adminOnly: true },
  { section: "services", label: "cp.fileServices", description: "ui.settings.services", keywords: ["smb", "samba", "nfs", "afp", "windows", "network share", "protocol"], adminOnly: true },
  { section: "network", label: "cp.network", description: "ui.settings.network", keywords: ["ip", "hostname", "dhcp", "static", "ethernet", "interface", "dns"], adminOnly: true },
  { section: "firewall", label: "cp.firewall", description: "ui.settings.firewall", keywords: ["firewall", "ports", "nftables", "block", "allow", "security", "network", "open ports"], adminOnly: true },
  { section: "ssh", label: "cp.ssh", description: "ui.settings.ssh", keywords: ["ssh", "shell", "terminal", "key", "remote"], adminOnly: true },
  { section: "email", label: "cp.email", description: "ui.settings.email", keywords: ["smtp", "mail", "alert", "notification", "send"], adminOnly: true },
  { section: "regional", label: "cp.regional", description: "ui.settings.regional", keywords: ["time", "timezone", "ntp", "clock", "date", "region"], adminOnly: true },
  { section: "certificate", label: "cp.certificate", description: "ui.settings.certificate", keywords: ["tls", "ssl", "https", "cert", "certificate", "encryption", "acme", "lets encrypt", "let's encrypt", "renew", "self-signed"], adminOnly: true },
  { section: "audit", label: "cp.auditLog", description: "ui.settings.audit", keywords: ["audit", "log", "history", "who", "security", "lockout", "locked"], adminOnly: true },
  { section: "logs", label: "cp.logs", description: "ui.settings.logs", keywords: ["log", "syslog", "nginx", "debug", "error"], adminOnly: true },
  { section: "backup", label: "ui.settings.backupLabel", description: "ui.settings.backup", keywords: ["backup", "restore", "export", "import", "config", "settings"], adminOnly: true },
  { section: "update", label: "cp.update", description: "ui.settings.update", keywords: ["update", "upgrade", "version", "patch"], adminOnly: true },
];
