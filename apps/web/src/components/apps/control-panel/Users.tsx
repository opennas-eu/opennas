import { useEffect, useState } from "react";
import { Fingerprint, KeyRound, LayoutGrid, Plus, ShieldAlert, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import type { AdminUser, CreateUserRequest, PasswordPolicyResponse, UserRole } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useAuth } from "../../../store/auth.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog, promptDialog } from "../../../store/dialogs.ts";
import { UserApps } from "./UserApps.tsx";
import { Autologin } from "./Autologin.tsx";
import { initialsOf } from "../../../lib/format.ts";
import { Button, Field, Input, Select, Toggle } from "../../ui/controls.tsx";

export function Users() {
  const [appsOpen, setAppsOpen] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [blockPwned, setBlockPwned] = useState(false);
  const [requirePasskey, setRequirePasskey] = useState(false);
  const me = useAuth((s) => s.session?.user.id);
  const push = useNotifications((s) => s.push);

  async function load() {
    const [res, policy] = await Promise.all([
      api.get<{ users: AdminUser[] }>("/admin/users"),
      api
        .get<PasswordPolicyResponse>("/admin/security/password-policy")
        .catch(() => ({ blockPwned: false, requirePasskey: false })),
    ]);
    setUsers(res.users);
    setBlockPwned(policy.blockPwned);
    setRequirePasskey(policy.requirePasskey);
  }
  useEffect(() => { void load(); }, []);

  async function togglePolicy(v: boolean) {
    setBlockPwned(v);
    try {
      await api.put<PasswordPolicyResponse>("/admin/security/password-policy", { blockPwned: v });
    } catch (err) {
      setBlockPwned(!v);
      push({ level: "warning", title: "Couldn't update policy", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function togglePasskeyPolicy(v: boolean) {
    setRequirePasskey(v);
    try {
      await api.put<PasswordPolicyResponse>("/admin/security/password-policy", { requirePasskey: v });
      await load();
    } catch (err) {
      setRequirePasskey(!v);
      // The server refuses to switch this on for an admin who has no passkey,
      // because it would strand them at the enrolment screen.
      push({ level: "warning", title: "Couldn't update policy", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  /** Clear a user's 2FA - the lost-phone path, when recovery codes are gone too. */
  async function resetTwoFactor(u: AdminUser) {
    if (!(await confirmDialog({
      title: `Turn off two-factor for @${u.username}?`,
      message: "They'll sign in with just a password until they set it up again. Only do this if you're sure who you're talking to.",
      confirmLabel: "Turn off",
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/users/${u.id}/totp`);
      push({ level: "success", title: "Two-factor turned off", body: `@${u.username} can sign in with a password.` });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't turn it off", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  const pwnedCount = (users ?? []).filter((u) => u.passwordPwned).length;
  const noPasskeyCount = (users ?? []).filter((u) => u.passkeyCount === 0).length;

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api.patch(`/admin/users/${id}`, body);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Update failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function resetPassword(u: AdminUser) {
    const pw = await promptDialog({
      title: `Reset password for @${u.username}`,
      message: "Enter a new password (at least 8 characters).",
      confirmLabel: "Set password",
      placeholder: "New password",
      inputType: "password",
    });
    if (!pw) return;
    try {
      // Temporary by default: a password an admin typed and then read out is
      // already shared, so the account is held at a change gate on next sign-in.
      await api.post(`/admin/users/${u.id}/password`, { password: pw, temporary: true });
      await load();
      push({
        level: "success",
        title: "Temporary password set",
        body: `@${u.username} must choose their own password at their next sign-in.`,
      });
    } catch (err) {
      push({ level: "warning", title: "Couldn't reset password", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function remove(u: AdminUser) {
    if (!(await confirmDialog({
      title: `Delete user "${u.displayName}"?`,
      message: `@${u.username} will be removed. This can't be undone.`,
      confirmLabel: "Delete user",
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/users/${u.id}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't delete user", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Users</h2>
          <p className="text-sm text-ink-faint">Create accounts and manage roles & access.</p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate((s) => !s)}>
          <UserPlus size={16} /> New user
        </Button>
      </div>

      {showCreate && <CreateUserForm onDone={async () => { setShowCreate(false); await load(); }} />}

      {/* Password breach policy (HaveIBeenPwned) */}
      <div className="mb-4 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-200"><ShieldAlert size={17} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-soft">Block breached passwords</div>
            <div className="text-xs text-ink-faint">Reject passwords found in a known data breach (checked privately via HaveIBeenPwned at set time).</div>
          </div>
          <Toggle checked={blockPwned} onChange={(v) => void togglePolicy(v)} label="Block breached passwords" />
        </div>
        {pwnedCount > 0 && (
          <p className="mt-2 text-xs text-amber-700">{pwnedCount} user{pwnedCount === 1 ? "'s" : "s'"} password was found in a breach - reset it below.</p>
        )}

        <div className="mt-3 flex items-center gap-3 border-t border-slate-200 pt-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-brand-200"><Fingerprint size={17} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-soft">Require a passkey</div>
            <div className="text-xs text-ink-faint">
              Everyone must enrol one. Accounts without a passkey can do nothing but register one until they have.
            </div>
          </div>
          <Toggle checked={requirePasskey} onChange={(v) => void togglePasskeyPolicy(v)} label="Require a passkey" />
        </div>
        {requirePasskey && noPasskeyCount > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            {noPasskeyCount} account{noPasskeyCount === 1 ? " has" : "s have"} no passkey yet and will be held at the
            enrolment screen on their next sign-in.
          </p>
        )}
      </div>

      <Autologin />

      <div className="space-y-2">
        {users === null && <p className="text-sm text-ink-faint">Loading...</p>}
        {users?.map((u) => (
          <div key={u.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: u.avatarColor }}>
              {initialsOf(u.displayName)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-ink-soft">{u.displayName}</span>
                {u.activeSessions > 0 && !u.disabled && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />online</span>}
                {u.disabled && <span className="rounded-full bg-slate-200 px-1.5 text-[11px] text-ink-faint">disabled</span>}
                {u.passwordPwned && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 text-[11px] text-amber-700 ring-1 ring-amber-200" title="This password was found in a known data breach"><ShieldAlert size={11} /> breached</span>}
                {u.twoFactorEnabled && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 text-[11px] text-emerald-700 ring-1 ring-emerald-200" title="Two-factor authentication is on"><ShieldCheck size={11} /> 2FA</span>}
                {u.mustChangePassword && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-800" title="Holds a temporary password and must change it at next sign-in">temporary password</span>}
                {u.appsRestricted && <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-1.5 text-[11px] text-ink-faint" title="This account can only use some apps"><LayoutGrid size={11} /> limited apps</span>}
                {u.id === me && <span className="rounded-full bg-brand-100 px-1.5 text-[11px] text-brand-700">you</span>}
              </div>
              <div className="text-xs text-ink-faint">@{u.username} - {u.passkeyCount} passkey{u.passkeyCount === 1 ? "" : "s"} - {u.source === "local" ? "local" : "SSO"}</div>
            </div>

            <Select value={u.role} onChange={(e) => void patch(u.id, { role: e.target.value as UserRole })} className="h-9 py-0">
              <option value="admin">Admin</option>
              <option value="user">User</option>
            </Select>

            <Button variant="ghost" className="h-9 px-2" title="Set a temporary password" onClick={() => void resetPassword(u)}>
              <KeyRound size={16} />
            </Button>

            {u.role !== "admin" && (
              <Button
                variant="ghost"
                className={`h-9 px-2 ${appsOpen === u.id ? "bg-slate-200" : ""}`}
                title="Choose which apps this account can use"
                onClick={() => setAppsOpen((cur) => (cur === u.id ? null : u.id))}
              >
                <LayoutGrid size={16} />
              </Button>
            )}

            {u.twoFactorEnabled && (
              <Button variant="ghost" className="h-9 px-2" title="Turn off two-factor (lost device)" onClick={() => void resetTwoFactor(u)}>
                <ShieldCheck size={16} />
              </Button>
            )}

            <Button
              variant="secondary"
              className="h-9 px-3 text-xs"
              disabled={u.id === me}
              onClick={() => void patch(u.id, { disabled: !u.disabled })}
            >
              {u.disabled ? "Enable" : "Disable"}
            </Button>

            <Button variant="ghost" className="h-9 px-2 text-rose-600 hover:bg-rose-50" title="Delete" disabled={u.id === me} onClick={() => void remove(u)}>
              <Trash2 size={16} />
            </Button>
          </div>

          {/*
            Only offered for regular accounts. An admin restricted out of Control
            Panel would have no way to undo it, so the server refuses it - and a
            control that always fails is worse than no control.
          */}
          {u.role !== "admin" && appsOpen === u.id && (
            <UserApps userId={u.id} onChanged={() => void load()} />
          )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<CreateUserRequest>({ username: "", displayName: "", email: "", role: "user", password: "", temporaryPassword: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  function up<K extends keyof CreateUserRequest>(k: K, v: CreateUserRequest[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api.post("/admin/users", form);
      push({ level: "success", title: "User created", body: `@${form.username} can now sign in.` });
      onDone();
    } catch (err) {
      if (err instanceof ApiRequestError) setErrors(err.fields ?? { _: err.message });
      else setErrors({ _: "Failed to create user." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" error={errors.displayName}>
          <Input value={form.displayName} onChange={(e) => up("displayName", e.target.value)} placeholder="Family" />
        </Field>
        <Field label="Username" error={errors.username}>
          <Input value={form.username} onChange={(e) => up("username", e.target.value.replace(/\s/g, ""))} placeholder="family" />
        </Field>
        <Field label="Email (optional)" error={errors.email}>
          <Input type="email" value={form.email ?? ""} onChange={(e) => up("email", e.target.value)} placeholder="family@example.com" />
        </Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => up("role", e.target.value as UserRole)} className="w-full">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
      </div>
      <Field label="Password" error={errors.password}>
        <Input type="password" value={form.password} onChange={(e) => up("password", e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
      </Field>
      <label className="flex items-start gap-2.5 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={form.temporaryPassword ?? true}
          onChange={(e) => up("temporaryPassword", e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600"
        />
        <span>
          Temporary password
          <span className="block text-xs text-ink-faint">
            They'll have to choose their own before they can use anything.
          </span>
        </span>
      </label>
      {errors._ && <p className="text-sm text-rose-600">{errors._}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}><Plus size={16} /> Create user</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
