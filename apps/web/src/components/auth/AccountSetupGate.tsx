import { useState } from "react";
import { Fingerprint, KeyRound, ShieldAlert } from "lucide-react";
import type { MeResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useAuth } from "../../store/auth.ts";
import { useT } from "../../i18n/index.ts";
import { registerPasskey, passkeysSupported } from "../../lib/webauthn.ts";
import { Logo } from "../Logo.tsx";
import { Button, Field, Input } from "../ui/controls.tsx";

/**
 * Shown instead of the desktop when the account has mandatory setup left: a
 * temporary password to replace, or a passkey the server requires.
 *
 * It replaces the desktop rather than sitting on top of it because the server
 * refuses every other route while something is pending - a desktop behind this
 * would just be a screen of failed requests. Signing out is always available,
 * so nobody is trapped here.
 */
export function AccountSetupGate() {
  const session = useAuth((s) => s.session);
  const refresh = useAuth((s) => s.refresh);
  const logout = useAuth((s) => s.logout);
  const t = useT();
  const pending = session?.pendingActions ?? [];
  // Password first: it's the one that came with a deadline attached.
  const step = pending.includes("password") ? "password" : "passkey";

  return (
    <div className="opennas-wallpaper relative flex h-full w-full items-center justify-center p-6">
      <div className="absolute left-8 top-7 hidden md:block">
        <Logo size={34} withWordmark />
      </div>
      <div className="animate-fade-in w-full max-w-sm">
        <div className="rounded-2xl glass-light p-7 shadow-2xl">
          {step === "password" ? <ChangePasswordStep onDone={refresh} /> : <PasskeyStep onDone={refresh} />}
          <button
            onClick={() => void logout()}
            className="mt-5 w-full text-center text-xs text-ink-faint transition hover:text-ink-soft"
          >
            {t("ui.gate.signOutInstead")}
          </button>
        </div>
        <p className="mt-5 text-center text-xs text-white/45">{t("auth.poweredBy")}</p>
      </div>
    </div>
  );
}

function ChangePasswordStep({ onDone }: { onDone: () => Promise<void> }) {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setError(t("ui.gate.passwordMismatch")); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post<MeResponse>("/auth/me/password", { currentPassword: current, newPassword: next });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("ui.gate.passwordFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="mb-5 text-center">
        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-amber-100 text-amber-600">
          <ShieldAlert size={24} />
        </span>
        <h1 className="text-lg font-semibold text-ink">{t("ui.gate.passwordTitle")}</h1>
        <p className="text-sm text-ink-faint">
          {t("ui.gate.passwordBody")}
        </p>
      </div>
      <div className="space-y-4">
        <Field label={t("ui.gate.currentPassword")}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
        </Field>
        <Field label={t("ui.gate.newPassword")}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t("ui.gate.confirmNewPassword")}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">
          <KeyRound size={16} /> {t("ui.gate.setPassword")}
        </Button>
      </div>
    </form>
  );
}

function PasskeyStep({ onDone }: { onDone: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey("Passkey");
      await onDone();
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof DOMException && err.name === "NotAllowedError") setError(t("ui.gate.passkeyCancelled"));
      else setError(t("ui.gate.passkeyFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-5 text-center">
        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand-100 text-brand-600">
          <Fingerprint size={24} />
        </span>
        <h1 className="text-lg font-semibold text-ink">{t("ui.gate.passkeyTitle")}</h1>
        <p className="text-sm text-ink-faint">
          {t("ui.gate.passkeyBody")}
        </p>
      </div>
      {!passkeysSupported ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-amber-200">
          {t("ui.gate.passkeyUnsupported")}
        </p>
      ) : (
        <>
          {error && <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{error}</p>}
          <Button loading={busy} onClick={add} className="w-full">
            <Fingerprint size={16} /> {t("ui.gate.createPasskey")}
          </Button>
        </>
      )}
    </div>
  );
}
