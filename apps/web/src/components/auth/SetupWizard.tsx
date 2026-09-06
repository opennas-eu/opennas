import { useState } from "react";
import { HardDrive, ShieldCheck, User as UserIcon } from "lucide-react";
import type { MeResponse, SetupRequest } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useAuth } from "../../store/auth.ts";
import { Logo } from "../Logo.tsx";
import { Button, Field, Input } from "../ui/controls.tsx";

export function SetupWizard() {
  const setSession = useAuth((s) => s.setSession);
  const defaultName = useAuth((s) => s.bootstrap?.instanceName ?? "OpenNAS");

  const [form, setForm] = useState<SetupRequest>({
    instanceName: defaultName,
    displayName: "",
    username: "",
    password: "",
  });
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function update<K extends keyof SetupRequest>(key: K, value: SetupRequest[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (form.password.length < 8) local.password = "At least 8 characters.";
    if (form.password !== confirm) local.confirm = "Passwords do not match.";
    if (!form.username.trim()) local.username = "Required.";
    if (!form.displayName.trim()) local.displayName = "Required.";
    setErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      const res = await api.post<MeResponse>("/auth/setup", form);
      if (res.session) setSession(res.session);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrors(err.fields ?? { _: err.message });
      } else {
        setErrors({ _: "Something went wrong. Please try again." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="opennas-wallpaper flex h-full w-full items-center justify-center p-6">
      <div className="animate-fade-in w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="grid md:grid-cols-[1fr_1.2fr]">
          {/* Left rail - welcome / branding */}
          <aside className="hidden flex-col justify-between bg-gradient-to-br from-brand-600 via-indigo-600 to-purple-600 p-8 text-white md:flex">
            <Logo size={44} withWordmark />
            <div className="space-y-4">
              <h1 className="text-2xl font-bold leading-tight">
                Let's set up
                <br />
                your NAS.
              </h1>
              <ul className="space-y-3 text-sm text-white/85">
                <Bullet icon={<UserIcon size={16} />}>Create your administrator account</Bullet>
                <Bullet icon={<ShieldCheck size={16} />}>Add a passkey afterwards for fast, secure sign-in</Bullet>
                <Bullet icon={<HardDrive size={16} />}>Then explore your new desktop</Bullet>
              </ul>
            </div>
            <p className="text-xs text-white/60">OpenNAS - first-run setup</p>
          </aside>

          {/* Right - the form */}
          <form onSubmit={submit} className="space-y-4 p-8">
            <div className="md:hidden">
              <Logo size={36} withWordmark className="[&_span]:text-ink" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-ink">Administrator account</h2>
              <p className="text-sm text-ink-faint">This account has full control over OpenNAS.</p>
            </div>

            <Field label="Server name" hint="Shown across the desktop and login screen.">
              <Input
                value={form.instanceName}
                onChange={(e) => update("instanceName", e.target.value)}
                placeholder="e.g. Fujitsu Vault"
                autoComplete="off"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Display name" error={errors.displayName}>
                <Input
                  value={form.displayName}
                  onChange={(e) => update("displayName", e.target.value)}
                  placeholder="Name"
                  autoComplete="Last name"
                />
              </Field>
              <Field label="Username" error={errors.username}>
                <Input
                  value={form.username}
                  onChange={(e) => update("username", e.target.value.replace(/\s/g, ""))}
                  placeholder="admin"
                  autoComplete="username"
                />
              </Field>
            </div>

            <Field label="Password" error={errors.password}>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm password" error={errors.confirm}>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </Field>

            {errors._ && <p className="text-sm text-rose-600">{errors._}</p>}

            <Button type="submit" loading={busy} className="w-full">
              Create account & enter OpenNAS
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

function Bullet({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/15">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}
