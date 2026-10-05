import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, ShieldCheck, ShieldOff, RefreshCw } from "lucide-react";
import type { TotpEnableResponse, TotpSetupResponse, TotpStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useAuth } from "../../../store/auth.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";

/**
 * The two parts of Security that are about credentials rather than devices:
 * changing your own password, and enrolling an authenticator app.
 */

export function ChangePasswordPanel() {
  const t = useT();
  const source = useAuth((s) => s.session?.user.source);
  const push = useNotifications((s) => s.push);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An SSO-provisioned account has no local password to change; its credentials
  // live at the identity provider.
  if (source && source !== "local") return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { setError(t("cp.password.mismatch")); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ revokedSessions: number }>("/auth/me/password", {
        currentPassword: current,
        newPassword: next,
      });
      setCurrent(""); setNext(""); setConfirm("");
      push({
        level: "success",
        title: t("cp.password.changed"),
        body: res.revokedSessions > 0
          ? t("cp.password.revoked", { count: res.revokedSessions })
          : undefined,
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.password.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <KeyRound size={16} /> {t("auth.password")}
      </h3>
      <form onSubmit={submit} className="max-w-sm space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <Field label={t("cp.password.current")}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label={t("cp.password.new")}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t("cp.password.confirm")}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <p className="text-xs text-ink-faint">{t("cp.password.hint")}</p>
        <Button type="submit" loading={busy} disabled={!current || !next}>{t("cp.password.change")}</Button>
      </form>
    </div>
  );
}

export function TwoFactorPanel() {
  const t = useT();
  const push = useNotifications((s) => s.push);
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setStatus(await api.get<TotpStatus>("/auth/totp"));
    } catch {
      setStatus(null);
    }
  }
  useEffect(() => { void load(); }, []);

  function reset() {
    setSetup(null); setCode(""); setPassword(""); setDisabling(false); setError(null);
  }

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.post<TotpSetupResponse>("/auth/totp/setup", {}));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.totp.setupFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<TotpEnableResponse>("/auth/totp/enable", { code: code.trim() });
      setCodes(res.recoveryCodes);
      reset();
      await load();
      push({ level: "success", title: t("cp.totp.turnedOn") });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.totp.onFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/totp/disable", { password });
      setCodes(null);
      reset();
      await load();
      push({ level: "success", title: t("cp.totp.turnedOff") });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.totp.offFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<TotpEnableResponse>("/auth/totp/recovery-codes", { password });
      setCodes(res.recoveryCodes);
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.totp.codesFailed"));
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled === true;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <ShieldCheck size={16} /> {t("cp.totp.title")}
        </h3>
        {status && !enabled && !setup && (
          <Button className="h-8 px-3 py-0 text-xs" loading={busy} onClick={begin}>{t("cp.totp.setUp")}</Button>
        )}
      </div>

      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      {/* --- enrolment --- */}
      {setup && (
        <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
          <p className="mb-3 text-sm text-ink-faint">
            {t("cp.totp.scan")}
          </p>
          <div className="flex flex-wrap items-start gap-4">
            {/* Rendered server-side, so nothing is fetched and no script runs. */}
            <div
              className="h-44 w-44 shrink-0 overflow-hidden rounded-lg bg-white p-1 ring-1 ring-slate-200"
              dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
            />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <div className="mb-1 text-xs font-medium text-ink-soft">{t("cp.totp.cantScan")}</div>
                <code className="block break-all rounded-lg bg-white px-2.5 py-2 font-mono text-xs text-ink-soft ring-1 ring-slate-200">
                  {setup.secret}
                </code>
              </div>
              <Field label={t("cp.totp.code")}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="tracking-[0.2em]"
                  onKeyDown={(e) => { if (e.key === "Enter") void enable(); }}
                />
              </Field>
              {error && <p className="text-sm text-rose-600">{error}</p>}
              <div className="flex gap-2">
                <Button loading={busy} onClick={enable} disabled={code.trim().length < 6}>{t("cp.totp.turnOn")}</Button>
                <Button variant="ghost" onClick={reset}>{t("common.cancel")}</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- steady state --- */}
      {!setup && (
        <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
          {status === null ? (
            <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>
          ) : enabled ? (
            <>
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-100 text-emerald-600">
                  <ShieldCheck size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-soft">{t("cp.totp.on")}</div>
                  <div className="text-xs text-ink-faint">
                    {t("cp.totp.codesLeft", { count: status.recoveryCodesRemaining })}
                  </div>
                </div>
              </div>
              {status.recoveryCodesRemaining <= 2 && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
                  {t("cp.totp.codesLow")}
                </p>
              )}
              {disabling ? (
                <div className="mt-3 max-w-xs space-y-2">
                  <Field label={t("cp.totp.confirmPassword")}>
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
                  </Field>
                  {error && <p className="text-sm text-rose-600">{error}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="danger" loading={busy} disabled={!password} onClick={disable}>{t("cp.totp.turnOff")}</Button>
                    <Button variant="secondary" loading={busy} disabled={!password} onClick={regenerate}>{t("cp.totp.newCodes")}</Button>
                    <Button variant="ghost" onClick={reset}>{t("common.cancel")}</Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={() => setDisabling(true)}>
                    <RefreshCw size={14} /> {t("cp.totp.newCodes")}
                  </Button>
                  <Button variant="ghost" className="h-8 px-3 py-0 text-xs" onClick={() => setDisabling(true)}>
                    <ShieldOff size={14} /> {t("cp.totp.turnOff")}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-200 text-ink-faint">
                <ShieldOff size={18} />
              </span>
              <div className="text-sm text-ink-faint">
                {t("cp.totp.offHint")}
              </div>
            </div>
          )}
          {error && !disabling && !setup && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Recovery codes, shown exactly once. The server keeps only their hashes, so
 * this panel is the single opportunity to save them - hence it refuses to go
 * away until the user says they have.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked - the codes are on screen to copy by hand */
    }
  }

  return (
    <div className="mb-4 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
      <h4 className="mb-1 text-sm font-semibold text-amber-900">{t("cp.totp.saveCodes")}</h4>
      <p className="mb-3 text-xs text-amber-800">
        {t("cp.totp.saveCodesHint")}
      </p>
      <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-white p-3 font-mono text-xs text-ink-soft ring-1 ring-amber-200">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("cp.totp.copied") : t("cp.totp.copy")}
        </Button>
        <Button className="h-8 px-3 py-0 text-xs" onClick={onDone}>{t("cp.totp.savedThem")}</Button>
      </div>
    </div>
  );
}
