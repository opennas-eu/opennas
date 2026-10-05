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
import { useT } from "../../../i18n/index.ts";

export function Users() {
  const t = useT();
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
      push({ level: "warning", title: t("cp.users.policyFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
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
      push({ level: "warning", title: t("cp.users.policyFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  /** Clear a user's 2FA - the lost-phone path, when recovery codes are gone too. */
  async function resetTwoFactor(u: AdminUser) {
    if (!(await confirmDialog({
      title: t("cp.users.twoFactorOffTitle", { username: u.username }),
      message: t("cp.users.twoFactorOffMessage"),
      confirmLabel: t("cp.users.turnOff"),
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/users/${u.id}/totp`);
      push({ level: "success", title: t("cp.users.twoFactorOff"), body: t("cp.users.twoFactorOffBody", { username: u.username }) });
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.users.turnOffFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  const pwnedCount = (users ?? []).filter((u) => u.passwordPwned).length;
  const noPasskeyCount = (users ?? []).filter((u) => u.passkeyCount === 0).length;

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api.patch(`/admin/users/${id}`, body);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.users.updateFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  async function resetPassword(u: AdminUser) {
    const pw = await promptDialog({
      title: t("cp.users.resetTitle", { username: u.username }),
      message: t("cp.users.resetMessage"),
      confirmLabel: t("cp.users.setPassword"),
      placeholder: t("cp.users.newPassword"),
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
        title: t("cp.users.tempSet"),
        body: t("cp.users.tempSetBody", { username: u.username }),
      });
    } catch (err) {
      push({ level: "warning", title: t("cp.users.resetFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  async function remove(u: AdminUser) {
    if (!(await confirmDialog({
      title: t("cp.users.deleteTitle", { name: u.displayName }),
      message: t("cp.users.deleteMessage", { username: u.username }),
      confirmLabel: t("cp.users.deleteUser"),
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/users/${u.id}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.users.deleteFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t("cp.users")}</h2>
          <p className="text-sm text-ink-faint">{t("cp.users.subtitle")}</p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate((s) => !s)}>
          <UserPlus size={16} /> {t("cp.users.newUser")}
        </Button>
      </div>

      {showCreate && <CreateUserForm onDone={async () => { setShowCreate(false); await load(); }} />}

      {/* Password breach policy (HaveIBeenPwned) */}
      <div className="mb-4 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-200"><ShieldAlert size={17} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-soft">{t("cp.users.blockBreached")}</div>
            <div className="text-xs text-ink-faint">{t("cp.users.blockBreachedHint")}</div>
          </div>
          <Toggle checked={blockPwned} onChange={(v) => void togglePolicy(v)} label={t("cp.users.blockBreached")} />
        </div>
        {pwnedCount > 0 && (
          <p className="mt-2 text-xs text-amber-700">{t("cp.users.pwnedCount", { count: pwnedCount })}</p>
        )}

        <div className="mt-3 flex items-center gap-3 border-t border-slate-200 pt-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-brand-200"><Fingerprint size={17} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink-soft">{t("cp.users.requirePasskey")}</div>
            <div className="text-xs text-ink-faint">
              {t("cp.users.requirePasskeyHint")}
            </div>
          </div>
          <Toggle checked={requirePasskey} onChange={(v) => void togglePasskeyPolicy(v)} label={t("cp.users.requirePasskey")} />
        </div>
        {requirePasskey && noPasskeyCount > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            {t("cp.users.noPasskeyCount", { count: noPasskeyCount })}
          </p>
        )}
      </div>

      <Autologin />

      <div className="space-y-2">
        {users === null && <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>}
        {users?.map((u) => (
          <div key={u.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: u.avatarColor }}>
              {initialsOf(u.displayName)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-ink-soft">{u.displayName}</span>
                {u.activeSessions > 0 && !u.disabled && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{t("cp.users.online")}</span>}
                {u.disabled && <span className="rounded-full bg-slate-200 px-1.5 text-[11px] text-ink-faint">{t("cp.users.disabledBadge")}</span>}
                {u.passwordPwned && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 text-[11px] text-amber-700 ring-1 ring-amber-200" title={t("cp.users.breachedTitle")}><ShieldAlert size={11} /> {t("cp.users.breached")}</span>}
                {u.twoFactorEnabled && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 text-[11px] text-emerald-700 ring-1 ring-emerald-200" title={t("cp.users.twoFactorOnTitle")}><ShieldCheck size={11} /> 2FA</span>}
                {u.mustChangePassword && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-800" title={t("cp.users.tempTitle")}>{t("cp.users.tempBadge")}</span>}
                {u.appsRestricted && <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-1.5 text-[11px] text-ink-faint" title={t("cp.users.limitedTitle")}><LayoutGrid size={11} /> {t("cp.users.limitedApps")}</span>}
                {u.id === me && <span className="rounded-full bg-brand-100 px-1.5 text-[11px] text-brand-700">{t("cp.users.you")}</span>}
              </div>
              <div className="text-xs text-ink-faint">@{u.username} - {t("cp.users.passkeyCount", { count: u.passkeyCount })} - {u.source === "local" ? t("cp.users.local") : "SSO"}</div>
            </div>

            <Select value={u.role} onChange={(e) => void patch(u.id, { role: e.target.value as UserRole })} className="h-9 py-0">
              <option value="admin">{t("cp.users.roleAdmin")}</option>
              <option value="user">{t("cp.users.roleUser")}</option>
            </Select>

            <Button variant="ghost" className="h-9 px-2" title={t("cp.users.setTempTitle")} onClick={() => void resetPassword(u)}>
              <KeyRound size={16} />
            </Button>

            {u.role !== "admin" && (
              <Button
                variant="ghost"
                className={`h-9 px-2 ${appsOpen === u.id ? "bg-slate-200" : ""}`}
                title={t("cp.users.chooseAppsTitle")}
                onClick={() => setAppsOpen((cur) => (cur === u.id ? null : u.id))}
              >
                <LayoutGrid size={16} />
              </Button>
            )}

            {u.twoFactorEnabled && (
              <Button variant="ghost" className="h-9 px-2" title={t("cp.users.twoFactorOffButton")} onClick={() => void resetTwoFactor(u)}>
                <ShieldCheck size={16} />
              </Button>
            )}

            <Button
              variant="secondary"
              className="h-9 px-3 text-xs"
              disabled={u.id === me}
              onClick={() => void patch(u.id, { disabled: !u.disabled })}
            >
              {u.disabled ? t("common.enable") : t("common.disable")}
            </Button>

            <Button variant="ghost" className="h-9 px-2 text-rose-600 hover:bg-rose-50" title={t("common.delete")} disabled={u.id === me} onClick={() => void remove(u)}>
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
  const t = useT();

  function up<K extends keyof CreateUserRequest>(k: K, v: CreateUserRequest[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api.post("/admin/users", form);
      push({ level: "success", title: t("cp.users.created"), body: t("cp.users.createdBody", { username: form.username }) });
      onDone();
    } catch (err) {
      if (err instanceof ApiRequestError) setErrors(err.fields ?? { _: err.message });
      else setErrors({ _: t("cp.users.createFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("cp.users.displayName")} error={errors.displayName}>
          <Input value={form.displayName} onChange={(e) => up("displayName", e.target.value)} placeholder={t("cp.users.displayNameExample")} />
        </Field>
        <Field label={t("auth.username")} error={errors.username}>
          <Input value={form.username} onChange={(e) => up("username", e.target.value.replace(/\s/g, ""))} placeholder={t("cp.users.usernameExample")} />
        </Field>
        <Field label={t("cp.users.emailOptional")} error={errors.email}>
          <Input type="email" value={form.email ?? ""} onChange={(e) => up("email", e.target.value)} placeholder="family@example.com" />
        </Field>
        <Field label={t("cp.users.role")}>
          <Select value={form.role} onChange={(e) => up("role", e.target.value as UserRole)} className="w-full">
            <option value="user">{t("cp.users.roleUser")}</option>
            <option value="admin">{t("cp.users.roleAdmin")}</option>
          </Select>
        </Field>
      </div>
      <Field label={t("auth.password")} error={errors.password}>
        <Input type="password" value={form.password} onChange={(e) => up("password", e.target.value)} placeholder={t("cp.users.passwordPlaceholder")} autoComplete="new-password" />
      </Field>
      <label className="flex items-start gap-2.5 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={form.temporaryPassword ?? true}
          onChange={(e) => up("temporaryPassword", e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600"
        />
        <span>
          {t("cp.users.tempPassword")}
          <span className="block text-xs text-ink-faint">
            {t("cp.users.tempPasswordHint")}
          </span>
        </span>
      </label>
      {errors._ && <p className="text-sm text-rose-600">{errors._}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}><Plus size={16} /> {t("cp.users.createUser")}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}
