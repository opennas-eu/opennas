import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, ShieldCheck, ShieldOff, RefreshCw } from "lucide-react";
import type { TotpEnableResponse, TotpSetupResponse, TotpStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useAuth } from "../../../store/auth.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input } from "../../ui/controls.tsx";

/**
 * The two parts of Security that are about credentials rather than devices:
 * changing your own password, and enrolling an authenticator app.
 */

export function ChangePasswordPanel() {
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
    if (next !== confirm) { setError("The two new passwords don't match."); return; }
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
        title: "Password changed",
        body: res.revokedSessions > 0
          ? `Signed out ${res.revokedSessions} other device${res.revokedSessions === 1 ? "" : "s"}.`
          : undefined,
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't change your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <KeyRound size={16} /> Password
      </h3>
      <form onSubmit={submit} className="max-w-sm space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <p className="text-xs text-ink-faint">Changing your password signs out your other devices.</p>
        <Button type="submit" loading={busy} disabled={!current || !next}>Change password</Button>
      </form>
    </div>
  );
}

export function TwoFactorPanel() {
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
      setError(err instanceof ApiRequestError ? err.message : "Couldn't start setup.");
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
      push({ level: "success", title: "Two-factor authentication is on" });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't turn it on.");
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
      push({ level: "success", title: "Two-factor authentication is off" });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't turn it off.");
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
      setError(err instanceof ApiRequestError ? err.message : "Couldn't create new codes.");
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled === true;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <ShieldCheck size={16} /> Two-factor authentication
        </h3>
        {status && !enabled && !setup && (
          <Button className="h-8 px-3 py-0 text-xs" loading={busy} onClick={begin}>Set up</Button>
        )}
      </div>

      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      {/* --- enrolment --- */}
      {setup && (
        <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
          <p className="mb-3 text-sm text-ink-faint">
            Scan this with an authenticator app - Aegis, Ente Auth, 1Password, Google Authenticator - then enter the code
            it shows.
          </p>
          <div className="flex flex-wrap items-start gap-4">
            {/* Rendered server-side, so nothing is fetched and no script runs. */}
            <div
              className="h-44 w-44 shrink-0 overflow-hidden rounded-lg bg-white p-1 ring-1 ring-slate-200"
              dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
            />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <div className="mb-1 text-xs font-medium text-ink-soft">Can't scan? Enter this key instead</div>
                <code className="block break-all rounded-lg bg-white px-2.5 py-2 font-mono text-xs text-ink-soft ring-1 ring-slate-200">
                  {setup.secret}
                </code>
              </div>
              <Field label="Code from the app">
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
                <Button loading={busy} onClick={enable} disabled={code.trim().length < 6}>Turn on</Button>
                <Button variant="ghost" onClick={reset}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- steady state --- */}
      {!setup && (
        <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
          {status === null ? (
            <p className="text-sm text-ink-faint">Loading...</p>
          ) : enabled ? (
            <>
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-100 text-emerald-600">
                  <ShieldCheck size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-soft">On</div>
                  <div className="text-xs text-ink-faint">
                    {status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? "" : "s"} left
                  </div>
                </div>
              </div>
              {status.recoveryCodesRemaining <= 2 && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
                  You're nearly out of recovery codes. Generate a new set while you still have access to this account.
                </p>
              )}
              {disabling ? (
                <div className="mt-3 max-w-xs space-y-2">
                  <Field label="Confirm your password">
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
                  </Field>
                  {error && <p className="text-sm text-rose-600">{error}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="danger" loading={busy} disabled={!password} onClick={disable}>Turn off</Button>
                    <Button variant="secondary" loading={busy} disabled={!password} onClick={regenerate}>New recovery codes</Button>
                    <Button variant="ghost" onClick={reset}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={() => setDisabling(true)}>
                    <RefreshCw size={14} /> New recovery codes
                  </Button>
                  <Button variant="ghost" className="h-8 px-3 py-0 text-xs" onClick={() => setDisabling(true)}>
                    <ShieldOff size={14} /> Turn off
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
                Off. With it on, signing in with a password also needs a code from your phone.
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
      <h4 className="mb-1 text-sm font-semibold text-amber-900">Save your recovery codes</h4>
      <p className="mb-3 text-xs text-amber-800">
        Each one signs you in once if you lose your phone. They won't be shown again - only their hashes are stored.
      </p>
      <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-white p-3 font-mono text-xs text-ink-soft ring-1 ring-amber-200">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
        </Button>
        <Button className="h-8 px-3 py-0 text-xs" onClick={onDone}>I've saved them</Button>
      </div>
    </div>
  );
}
