import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  Archive,
  BadgeCheck,
  Camera,
  ChevronLeft,
  Clock,
  Download,
  Fingerprint,
  FolderCog,
  Globe,
  HardDrive,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Mail,
  Palette,
  Plus,
  ScrollText,
  Server,
  TerminalSquare,
  ShieldCheck,
  Trash2,
  User as UserIcon,
  Users as UsersIcon,
} from "lucide-react";
import type { PasskeySummary, SessionsResponse, SessionSummary, User } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../lib/api.ts";
import { registerPasskey, passkeysSupported } from "../../lib/webauthn.ts";
import { useAuth } from "../../store/auth.ts";
import { useNotifications } from "../../store/notifications.ts";
import { useIsPhone } from "../../lib/viewport.ts";
import { useIntents } from "../../store/intents.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { formatRelative } from "../../lib/format.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Button, Input } from "../ui/controls.tsx";
import { Personalization } from "./control-panel/Personalization.tsx";
import { Users } from "./control-panel/Users.tsx";
import { Groups } from "./control-panel/Groups.tsx";
import { IdentityProvider } from "./control-panel/IdentityProvider.tsx";
import { SharedFolders } from "./control-panel/SharedFolders.tsx";
import { Services } from "./control-panel/Services.tsx";
import { Certificate } from "./control-panel/Certificate.tsx";
import { Storage } from "./control-panel/Storage.tsx";
import { Network } from "./control-panel/Network.tsx";
import { Regional } from "./control-panel/Regional.tsx";
import { Update } from "./control-panel/Update.tsx";
import { Ssh } from "./control-panel/Ssh.tsx";
import { Email } from "./control-panel/Email.tsx";
import { Logs } from "./control-panel/Logs.tsx";
import { Audit } from "./control-panel/Audit.tsx";
import { Backup } from "./control-panel/Backup.tsx";
import { ScheduledTasks } from "./control-panel/ScheduledTasks.tsx";
import { useT } from "../../i18n/index.ts";
import { Firewall } from "./control-panel/Firewall.tsx";
import { ChangePasswordPanel, TwoFactorPanel } from "./control-panel/AccountSecurity.tsx";
import { AppFolderAccess } from "./control-panel/AppFolderAccess.tsx";

type Section =
  | "account"
  | "security"
  | "personalization"
  | "connectivity"
  | "users"
  | "groups"
  | "identity"
  | "storage"
  | "shares"
  | "services"
  | "certificate"
  | "network"
  | "firewall"
  | "regional"
  | "update"
  | "ssh"
  | "email"
  | "audit"
  | "backup"
  | "logs";

export function ControlPanel() {
  const t = useT();
  const phone = useIsPhone();
  // Null means "showing the list of sections", which only happens on a phone.
  // A desktop always has one selected, because the sidebar is always visible.
  const [section, setSection] = useState<Section | null>(phone ? null : "account");

  // Coming back to a wide screen with nothing selected would show an empty pane
  // beside the nav, so a default is restored on the way out of phone mode.
  useEffect(() => {
    if (!phone && section === null) setSection("account");
  }, [phone, section]);
  const isAdmin = useAuth((s) => s.session?.user.role === "admin");
  const takeIntent = useIntents((s) => s.take);

  // Global search can ask for a specific page; claim that once on mount.
  useEffect(() => {
    const wanted = takeIntent("control-panel");
    if (wanted) setSection(wanted as Section);
  }, [takeIntent]);

  /**
   * On a phone the sidebar becomes a drill-down.
   *
   * A 208px nav beside content on a 390px screen leaves 180px for the content,
   * which is not a layout - it is two unusable columns. So the list of sections
   * *is* the page until one is chosen, and choosing one replaces it. Going back
   * is a row at the top of the section, because the window chrome's only button
   * already means "close the app".
   */
  const showNav = !phone || section === null;
  const showBody = !phone || section !== null;

  return (
    <div className="flex h-full bg-white">
      <nav
        className={clsx(
          "opennas-scroll space-y-0.5 overflow-y-auto bg-slate-50/60 p-3",
          phone ? "w-full" : "w-52 shrink-0 border-r border-slate-200",
          showNav ? "" : "hidden",
        )}
      >
        <NavLabel>{t("cp.personal")}</NavLabel>
        <NavItem active={section === "account"} onClick={() => setSection("account")} icon={<UserIcon size={16} />}>{t("cp.account")}</NavItem>
        <NavItem active={section === "security"} onClick={() => setSection("security")} icon={<ShieldCheck size={16} />}>{t("cp.security")}</NavItem>
        <NavItem active={section === "personalization"} onClick={() => setSection("personalization")} icon={<Palette size={16} />}>{t("cp.personalization")}</NavItem>
        <NavItem active={section === "connectivity"} onClick={() => setSection("connectivity")} icon={<KeyRound size={16} />}>{t("cp.sso")}</NavItem>

        {isAdmin && (
          <>
            <NavLabel>{t("cp.system")}</NavLabel>
            <NavItem active={section === "users"} onClick={() => setSection("users")} icon={<UsersIcon size={16} />}>{t("cp.users")}</NavItem>
            <NavItem active={section === "groups"} onClick={() => setSection("groups")} icon={<UsersIcon size={16} />}>{t("cp.groups")}</NavItem>
            <NavItem active={section === "identity"} onClick={() => setSection("identity")} icon={<BadgeCheck size={16} />}>{t("cp.identityProvider")}</NavItem>
            <NavItem active={section === "storage"} onClick={() => setSection("storage")} icon={<HardDrive size={16} />}>{t("cp.storage")}</NavItem>
            <NavItem active={section === "shares"} onClick={() => setSection("shares")} icon={<FolderCog size={16} />}>{t("cp.sharedFolders")}</NavItem>
            <NavItem active={section === "services"} onClick={() => setSection("services")} icon={<Server size={16} />}>{t("cp.fileServices")}</NavItem>
            <NavItem active={section === "network"} onClick={() => setSection("network")} icon={<Globe size={16} />}>{t("cp.network")}</NavItem>
            <NavItem active={section === "firewall"} onClick={() => setSection("firewall")} icon={<ShieldCheck size={16} />}>{t("cp.firewall")}</NavItem>
            <NavItem active={section === "ssh"} onClick={() => setSection("ssh")} icon={<TerminalSquare size={16} />}>{t("cp.ssh")}</NavItem>
            <NavItem active={section === "email"} onClick={() => setSection("email")} icon={<Mail size={16} />}>{t("cp.email")}</NavItem>
            <NavItem active={section === "regional"} onClick={() => setSection("regional")} icon={<Clock size={16} />}>{t("cp.regional")}</NavItem>
            <NavItem active={section === "certificate"} onClick={() => setSection("certificate")} icon={<Lock size={16} />}>{t("cp.certificate")}</NavItem>
            <NavItem active={section === "audit"} onClick={() => setSection("audit")} icon={<ShieldCheck size={16} />}>{t("cp.auditLog")}</NavItem>
            <NavItem active={section === "logs"} onClick={() => setSection("logs")} icon={<ScrollText size={16} />}>{t("cp.logs")}</NavItem>
            <NavItem active={section === "backup"} onClick={() => setSection("backup")} icon={<Archive size={16} />}>{t("cp.backup")}</NavItem>
            <NavItem active={section === "update"} onClick={() => setSection("update")} icon={<Download size={16} />}>{t("cp.update")}</NavItem>
          </>
        )}
      </nav>
      <div className={clsx("opennas-scroll min-h-0 flex-1 overflow-auto", phone ? "p-4" : "p-6", showBody ? "" : "hidden")}>
        {phone && (
          <button
            onClick={() => setSection(null)}
            className="mb-3 -ml-1 flex items-center gap-1 rounded-lg px-1 py-1.5 text-sm font-medium text-brand-600 active:bg-slate-100"
          >
            <ChevronLeft size={16} /> {t("cp.allSettings")}
          </button>
        )}
        {section === "account" && <AccountSection />}
        {section === "security" && <SecuritySection />}
        {section === "personalization" && <Personalization />}
        {section === "connectivity" && <ConnectivitySection />}
        {section === "users" && isAdmin && <Users />}
        {section === "groups" && isAdmin && <Groups />}
        {section === "identity" && isAdmin && <IdentityProvider />}
        {section === "shares" && isAdmin && <SharedFolders />}
        {section === "services" && isAdmin && <Services />}
        {section === "storage" && isAdmin && <Storage />}
        {section === "network" && isAdmin && <Network />}
        {section === "firewall" && isAdmin && <Firewall />}
        {section === "ssh" && isAdmin && <Ssh />}
        {section === "email" && isAdmin && <Email />}
        {section === "regional" && isAdmin && <Regional />}
        {section === "certificate" && isAdmin && <Certificate />}
        {section === "audit" && isAdmin && <Audit />}
        {section === "logs" && isAdmin && <Logs />}
        {section === "backup" && isAdmin && (<><ScheduledTasks /><Backup /></>)}
        {section === "update" && isAdmin && <Update />}
      </div>
    </div>
  );
}

function NavLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}

function NavItem({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
        active ? "bg-brand-600 text-white" : "text-ink-soft hover:bg-slate-200/60"
      }`}
    >
      {/* The icon must not be squeezed out by a long label, and a translation
          can easily be one long unbreakable word - German's
          "Überwachungsprotokoll" pushed the icon off the row and clipped itself
          against the panel edge. `min-w-0` plus a break lets the text wrap or
          break mid-word instead of overflowing. */}
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </button>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="text-sm text-ink-faint">{subtitle}</p>
    </div>
  );
}

function AccountSection() {
  const session = useAuth((s) => s.session);
  const setUser = useAuth((s) => s.setUser);
  const logout = useAuth((s) => s.logout);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = session?.user;
  if (!user) return null;

  async function uploadAvatar(file: File) {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file, file.name);
    try {
      const res = await fetch(apiUrl("/auth/me/avatar"), { method: "POST", body: fd, credentials: "include" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? "Upload failed.");
      if (data?.user) setUser(data.user as User);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update your picture.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAvatar() {
    setBusy(true);
    setError(null);
    try {
      const { user: updated } = await api.del<{ user: User }>("/auth/me/avatar");
      setUser(updated);
    } catch {
      setError("Could not remove your picture.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionTitle title="Account" subtitle="Your profile and sign-in details." />
      <div className="flex items-center gap-4 rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200/70">
        <div className="group relative">
          <Avatar user={user} className="h-16 w-16 text-xl" />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            title="Change profile picture"
            aria-label="Change profile picture"
            className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition group-hover:opacity-100 disabled:opacity-0"
          >
            <Camera size={18} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ""; }}
          />
        </div>
        <div>
          <div className="text-lg font-semibold text-ink">{user.displayName}</div>
          <div className="text-sm text-ink-faint">@{user.username}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Tag>{user.role === "admin" ? "Administrator" : "User"}</Tag>
            <Tag>{user.source === "local" ? "Local account" : "SSO account"}</Tag>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
            >
              {user.avatarUrl ? "Change picture" : "Add picture"}
            </button>
            {user.avatarUrl && (
              <button type="button" onClick={() => void removeAvatar()} disabled={busy} className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50">
                Remove
              </button>
            )}
          </div>
          {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
        </div>
      </div>

      <dl className="mt-4 divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200/70">
        <Row label="Email" value={user.email ?? "-"} />
        <Row label="Member since" value={new Date(user.createdAt).toLocaleDateString()} />
        <Row label="This session" value={session.authMethods.join(", ") || "-"} />
      </dl>

      <div className="mt-6">
        <Button variant="secondary" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function SecuritySection() {
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    const res = await api.get<{ passkeys: PasskeySummary[] }>("/auth/passkeys");
    setPasskeys(res.passkeys);
  }
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    setError(null);
    setAdding(true);
    try {
      await registerPasskey(label.trim() || "Passkey");
      setLabel("");
      setShowAdd(false);
      await load();
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof DOMException && err.name === "NotAllowedError") setError("Registration was cancelled.");
      else setError("Could not add passkey.");
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string) {
    await api.del(`/auth/passkeys/${id}`);
    await load();
  }

  return (
    <div>
      <SectionTitle title="Security" subtitle="Passkeys, two-factor codes, your password, and the devices you're signed in on." />

      {!passkeysSupported && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-amber-200">
          This browser doesn't support passkeys.
        </p>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <Fingerprint size={16} /> Your passkeys
        </h3>
        {passkeysSupported && !showAdd && (
          <Button className="h-8 px-3 py-0 text-xs" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Add passkey
          </Button>
        )}
      </div>

      {showAdd && (
        <div className="mb-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
          <label className="mb-1.5 block text-sm font-medium text-ink-soft">Passkey name</label>
          <div className="flex gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. MacBook Touch ID" />
            <Button loading={adding} onClick={add} className="shrink-0">
              Create
            </Button>
            <Button variant="ghost" onClick={() => { setShowAdd(false); setError(null); }} className="shrink-0">
              Cancel
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        </div>
      )}

      <div className="space-y-2">
        {passkeys === null && <p className="text-sm text-ink-faint">Loading...</p>}
        {passkeys?.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            No passkeys yet. Add one for faster, phishing-resistant sign-in.
          </div>
        )}
        {passkeys?.map((pk) => (
          <div key={pk.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-100 text-brand-600">
              <KeyRound size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink-soft">{pk.label}</div>
              <div className="text-xs text-ink-faint">
                {pk.deviceType}
                {pk.backedUp ? " - synced" : ""} - added {formatRelative(pk.createdAt)}
                {pk.lastUsedAt ? ` - last used ${formatRelative(pk.lastUsedAt)}` : ""}
              </div>
            </div>
            <button
              aria-label="Remove passkey"
              onClick={() => void remove(pk.id)}
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <TwoFactorPanel />
      <ChangePasswordPanel />
      <AppFolderAccess />
      <SessionsPanel />
    </div>
  );
}

/**
 * Active sign-ins for the current user, with per-device revocation. Sessions are
 * server-side records, so revoking one takes effect on that device's next request.
 */
function SessionsPanel() {
  const push = useNotifications((s) => s.push);
  const signOut = useAuth((s) => s.logout);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setSessions((await api.get<SessionsResponse>("/auth/sessions")).sessions);
    } catch {
      setSessions([]);
    }
  }
  useEffect(() => { void load(); }, []);

  async function revoke(s: SessionSummary) {
    if (s.current) {
      const ok = await confirmDialog({
        title: "Sign out of this device?",
        message: "You'll be returned to the login screen.",
        confirmLabel: "Sign out",
        danger: true,
      });
      if (!ok) return;
      await signOut();
      return;
    }
    setBusy(s.id);
    try {
      await api.del(`/auth/sessions/${encodeURIComponent(s.id)}`);
      push({ level: "success", title: "Device signed out", body: s.device });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't sign out that device", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    const ok = await confirmDialog({
      title: "Sign out everywhere else?",
      message: "Every other browser and device will have to sign in again. This one stays signed in.",
      confirmLabel: "Sign out others",
      danger: true,
    });
    if (!ok) return;
    setBusy("others");
    try {
      const res = await api.post<{ revoked: number }>("/auth/sessions/revoke-others", {});
      push({
        level: "success",
        title: res.revoked === 0 ? "No other devices were signed in" : `Signed out ${res.revoked} device${res.revoked === 1 ? "" : "s"}`,
      });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't sign out other devices", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <Laptop size={16} /> Signed-in devices
        </h3>
        {others > 0 && (
          <Button variant="secondary" className="h-8 px-3 py-0 text-xs" loading={busy === "others"} onClick={revokeOthers}>
            <LogOut size={14} /> Sign out others
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {sessions === null && <p className="text-sm text-ink-faint">Loading...</p>}
        {sessions?.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            No active sessions found.
          </div>
        )}
        {sessions?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-200 text-ink-soft">
              <Laptop size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-ink-soft">{s.device}</span>
                {s.current && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">This device</span>
                )}
              </div>
              <div className="truncate text-xs text-ink-faint">
                {s.ip ? `${s.ip} - ` : ""}signed in {formatRelative(s.createdAt)}
                {s.authMethods.length > 0 ? ` - ${s.authMethods.join(", ")}` : ""}
              </div>
            </div>
            <button
              aria-label={s.current ? "Sign out of this device" : `Sign out ${s.device}`}
              title={s.current ? "Sign out of this device" : "Sign out this device"}
              disabled={busy === s.id}
              onClick={() => void revoke(s)}
              className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white disabled:opacity-50"
            >
              <LogOut size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectivitySection() {
  const bootstrap = useAuth((s) => s.bootstrap);
  const oidc = bootstrap?.oidc;
  return (
    <div>
      <SectionTitle title="SSO & Access" subtitle="Single sign-on lets you log in with your existing identity provider." />
      <div className="rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200/70">
        <div className="flex items-center gap-3">
          <span className={`grid h-11 w-11 place-items-center rounded-xl text-white ${oidc?.enabled ? "bg-emerald-500" : "bg-slate-400"}`}>
            <KeyRound size={22} />
          </span>
          <div>
            <div className="font-semibold text-ink">OpenID Connect (OIDC)</div>
            <div className="text-sm text-ink-faint">
              {oidc?.enabled ? `Enabled - "${oidc.buttonLabel}" shown on login` : "Not configured"}
            </div>
          </div>
          <span className={`ml-auto rounded-full px-2.5 py-1 text-xs font-medium ${oidc?.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-ink-faint"}`}>
            {oidc?.enabled ? "Active" : "Off"}
          </span>
        </div>

        {!oidc?.enabled && (
          <div className="mt-4 rounded-lg bg-white p-4 text-sm text-ink-faint ring-1 ring-slate-200">
            <p className="mb-2 font-medium text-ink-soft">To connect your SSO (Authentik, Keycloak, Authelia...):</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Register OpenNAS as an OIDC client in your IdP.</li>
              <li>
                Set the redirect URI to{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{location.origin}/api/auth/oidc/callback</code>
              </li>
              <li>
                Provide <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">OPENNAS_OIDC_ISSUER</code>,{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">OPENNAS_OIDC_CLIENT_ID</code> and secret, then restart.
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between px-4 py-3 text-sm">
      <span className="text-ink-faint">{label}</span>
      <span className="font-medium text-ink-soft">{value}</span>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-ink-soft">{children}</span>;
}
