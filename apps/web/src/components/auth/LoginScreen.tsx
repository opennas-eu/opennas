import { useEffect, useState } from "react";
import { ArrowLeft, Fingerprint, KeyRound, LogIn, ShieldCheck } from "lucide-react";
import type { LoginResponse } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../lib/api.ts";
import { useAuth } from "../../store/auth.ts";
import { loginWithPasskey, passkeysSupported } from "../../lib/webauthn.ts";
import { useT } from "../../i18n/index.ts";
import { Logo } from "../Logo.tsx";
import { Button, Field, Input } from "../ui/controls.tsx";
import { Clock } from "../desktop/Clock.tsx";

export function LoginScreen() {
  const setSession = useAuth((s) => s.setSession);
  const bootstrap = useAuth((s) => s.bootstrap);

  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | "code" | null>(null);
  // Set when the password checked out but the account also wants a code. The
  // ticket stands in for the password from here on; it is not a session.
  const [mfa, setMfa] = useState<{ ticket: string; recoveryCodesAvailable: boolean } | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const sso = params.get("sso_error");
    if (sso === "not_provisioned") setError("Your SSO account isn't permitted on this server.");
    else if (sso) setError("SSO sign-in failed. Please try again.");
    if (sso) window.history.replaceState({}, "", location.pathname);
  }, []);

  async function passwordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("password");
    try {
      const res = await api.post<LoginResponse>("/auth/login/password", { username, password });
      if (res.mfaRequired) {
        setMfa({ ticket: res.ticket, recoveryCodesAvailable: res.recoveryCodesAvailable });
        setPassword("");
      } else if (res.session) {
        setSession(res.session);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(null);
    }
  }

  async function passkeyLogin() {
    setError(null);
    setBusy("passkey");
    try {
      const session = await loginWithPasskey(username.trim() || undefined);
      setSession(session);
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof DOMException && err.name === "NotAllowedError") setError(null);
      else setError("Passkey sign-in failed.");
    } finally {
      setBusy(null);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!mfa) return;
    setError(null);
    setBusy("code");
    try {
      const res = await api.post<LoginResponse>("/auth/login/totp", { ticket: mfa.ticket, code: code.trim() });
      if (res.session) setSession(res.session);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : "Sign-in failed.";
      // An expired or spent ticket means starting over, not retrying the code.
      if (err instanceof ApiRequestError && err.code === "ticket") setMfa(null);
      setCode("");
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  function backToPassword() {
    setMfa(null);
    setCode("");
    setError(null);
  }

  return (
    <div className="opennas-wallpaper relative flex h-full w-full items-center justify-center p-6">
      <div className="absolute left-8 top-7 hidden md:block">
        <Logo size={34} withWordmark />
      </div>
      <div className="absolute right-8 top-6 hidden text-right md:block">
        <Clock className="text-white" />
      </div>

      <div className="animate-fade-in w-full max-w-sm">
        <div className="rounded-2xl glass-light p-7 shadow-2xl">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 w-fit md:hidden">
              <Logo size={40} />
            </div>
            <h1 className="text-xl font-semibold text-ink">{bootstrap?.instanceName ?? "OpenNAS"}</h1>
            <p className="text-sm text-ink-faint">
              {mfa ? "Two-factor authentication" : t("auth.subtitle")}
            </p>
          </div>

          {mfa ? (
            <form onSubmit={submitCode} className="space-y-4">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-100 text-brand-600">
                <ShieldCheck size={24} />
              </span>
              <p className="text-center text-sm text-ink-faint">
                Enter the six-digit code from your authenticator app
                {mfa.recoveryCodesAvailable ? ", or one of your recovery codes." : "."}
              </p>
              <Field label="Code">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  // Digits on a phone keypad, but recovery codes have letters,
                  // so this can't be a numeric-only input.
                  inputMode={mfa.recoveryCodesAvailable ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoFocus
                  className="text-center text-lg tracking-[0.3em]"
                />
              </Field>

              {error && (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{error}</p>
              )}

              <Button type="submit" loading={busy === "code"} className="w-full" disabled={code.trim().length === 0}>
                <LogIn size={16} /> Verify
              </Button>
              <button
                type="button"
                onClick={backToPassword}
                className="flex w-full items-center justify-center gap-1 text-xs text-ink-faint transition hover:text-ink-soft"
              >
                <ArrowLeft size={12} /> Use a different account
              </button>
            </form>
          ) : (
          <form onSubmit={passwordLogin} className="space-y-4">
            <Field label={t("auth.username")}>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("auth.usernamePlaceholder")}
                autoComplete="username webauthn"
                autoFocus
              />
            </Field>
            <Field label={t("auth.password")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </Field>

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">
                {error}
              </p>
            )}

            <Button type="submit" loading={busy === "password"} className="w-full">
              <LogIn size={16} /> {t("auth.signIn")}
            </Button>
          </form>

          )}

          {!mfa && (passkeysSupported || bootstrap?.oidc) && (
            <div className="my-5 flex items-center gap-3 text-xs text-ink-faint">
              <span className="h-px flex-1 bg-slate-300/70" />
              {t("auth.or")}
              <span className="h-px flex-1 bg-slate-300/70" />
            </div>
          )}

          <div className={mfa ? "hidden" : "space-y-2.5"}>
            {passkeysSupported && (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                loading={busy === "passkey"}
                onClick={passkeyLogin}
              >
                <Fingerprint size={16} /> {t("auth.passkey")}
              </Button>
            )}

            {bootstrap?.oidc?.enabled && (
              <a
                href={apiUrl("/auth/oidc/start")}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft"
              >
                <KeyRound size={16} /> {bootstrap.oidc.buttonLabel}
              </a>
            )}
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-white/45">{t("auth.poweredBy")}</p>
      </div>
    </div>
  );
}
