/**
 * The searchable catalogue of Control Panel destinations.
 *
 * Kept as data next to the panel rather than derived from it, so search can
 * match on words a user would actually type ("password", "certificate", "wifi")
 * rather than only on the nav label they'd have to already know.
 */
export interface SettingsEntry {
  /** Control Panel section id - matches the `Section` union in ControlPanel.tsx. */
  section: string;
  label: string;
  description: string;
  /** Extra words that should match this entry. */
  keywords: string[];
  /** Only offered to admins. */
  adminOnly: boolean;
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  { section: "account", label: "Account", description: "Your profile, display name and picture", keywords: ["profile", "avatar", "name", "email", "me"], adminOnly: false },
  { section: "security", label: "Security", description: "Passkeys, two-factor codes, your password and signed-in devices", keywords: ["passkey", "webauthn", "password", "change password", "sessions", "devices", "sign out", "2fa", "two-factor", "two factor", "mfa", "totp", "authenticator", "otp", "recovery codes", "touch id"], adminOnly: false },
  { section: "personalization", label: "Personalization", description: "Wallpaper, accent colour and theme", keywords: ["wallpaper", "theme", "dark mode", "light", "accent", "colour", "color", "appearance", "background"], adminOnly: false },
  { section: "connectivity", label: "SSO & Access", description: "Single sign-on with an external provider", keywords: ["sso", "oidc", "login", "identity", "authentik", "keycloak"], adminOnly: false },
  { section: "users", label: "Users", description: "Create and manage accounts and roles", keywords: ["account", "add user", "admin", "role", "disable", "reset password", "temporary password", "require passkey", "people"], adminOnly: true },
  { section: "groups", label: "Groups", description: "Grant access to a set of people at once", keywords: ["group", "team", "family", "members", "membership", "permissions", "access"], adminOnly: true },
  { section: "identity", label: "Identity Provider", description: "Let other apps sign in with OpenNAS", keywords: ["oidc", "provider", "client", "sso", "openid"], adminOnly: true },
  { section: "storage", label: "Storage", description: "Disks, volumes, RAID and disk health", keywords: ["disk", "drive", "raid", "smart", "volume", "mount", "format", "health", "hdd", "ssd"], adminOnly: true },
  { section: "shares", label: "Shared Folders", description: "Create shares and set who can use them", keywords: ["share", "folder", "permission", "access", "smb", "nfs", "acl", "folder rules", "recycle bin", "group"], adminOnly: true },
  { section: "services", label: "File Services", description: "SMB, NFS and AFP file sharing", keywords: ["smb", "samba", "nfs", "afp", "windows", "network share", "protocol"], adminOnly: true },
  { section: "network", label: "Network", description: "Hostname, interfaces and addresses", keywords: ["ip", "hostname", "dhcp", "static", "ethernet", "interface", "dns"], adminOnly: true },
  { section: "firewall", label: "Firewall", description: "Choose what this NAS accepts from the network", keywords: ["firewall", "ports", "nftables", "block", "allow", "security", "network", "open ports"], adminOnly: true },
  { section: "ssh", label: "SSH", description: "Remote shell access and authorized keys", keywords: ["ssh", "shell", "terminal", "key", "remote"], adminOnly: true },
  { section: "email", label: "Email", description: "SMTP server and alert notifications", keywords: ["smtp", "mail", "alert", "notification", "send"], adminOnly: true },
  { section: "regional", label: "Time & Region", description: "Timezone and time synchronisation", keywords: ["time", "timezone", "ntp", "clock", "date", "region"], adminOnly: true },
  { section: "certificate", label: "Certificate", description: "HTTPS certificate, including automatic Let's Encrypt", keywords: ["tls", "ssl", "https", "cert", "certificate", "encryption", "acme", "lets encrypt", "let's encrypt", "renew", "self-signed"], adminOnly: true },
  { section: "audit", label: "Audit log", description: "Who changed what, and when", keywords: ["audit", "log", "history", "who", "security", "lockout", "locked"], adminOnly: true },
  { section: "logs", label: "Logs", description: "System and service logs", keywords: ["log", "syslog", "nginx", "debug", "error"], adminOnly: true },
  { section: "backup", label: "Backup & restore", description: "Export or restore the configuration", keywords: ["backup", "restore", "export", "import", "config", "settings"], adminOnly: true },
  { section: "update", label: "Update", description: "Check for and install system updates", keywords: ["update", "upgrade", "version", "patch"], adminOnly: true },
];
