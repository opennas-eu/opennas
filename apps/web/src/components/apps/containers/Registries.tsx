import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogIn, LogOut, Plus, ShieldCheck } from "lucide-react";
import type { ContainerRegistry, RegistriesResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input } from "../../ui/controls.tsx";
import { useT, useLocale } from "../../../i18n/index.ts";
import { fillNodes } from "../vms/VirtNetworks.tsx";

/**
 * Signing in to private container registries.
 *
 * OpenNAS keeps the host and username; the password goes straight to
 * `docker login`, which stores it in its own credential file, and is never
 * written to the OpenNAS database. That's said on screen, because "where did my
 * registry password end up" is a fair question to have about a NAS.
 */
export function Registries() {
  const [state, setState] = useState<RegistriesResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);
  const t = useT();
  const locale = useLocale();

  const load = useCallback(async () => {
    setState(await api.get<RegistriesResponse>("/containers/registries").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function signIn() {
    setBusy("add");
    try {
      const res = await api.post<RegistriesResponse>("/containers/registries", {
        host: host.trim(),
        username: username.trim(),
        password,
      });
      setState(res);
      // Clear the password from component state the moment it's been used.
      setPassword("");
      setHost("");
      setUsername("");
      setAdding(false);
      push({ level: "success", title: t("app.registries.signedInToast"), body: t("app.registries.signedInToastBody") });
    } catch (err) {
      push({ level: "warning", title: t("app.registries.signInFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  async function signOut(reg: ContainerRegistry) {
    const ok = await confirmDialog({
      title: t("app.registries.signOutConfirm", { host: reg.host }),
      message: t("app.registries.signOutConfirmBody"),
      confirmLabel: t("auth.signOut"),
    });
    if (!ok) return;
    setBusy(reg.host);
    try {
      setState(await api.del<RegistriesResponse>(`/containers/registries/${encodeURIComponent(reg.host)}`));
    } catch (err) {
      push({ level: "warning", title: t("app.registries.signOutFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  if (state === null) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-soft">{t("app.registries.title")}</h3>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> {t("app.registries.add")}
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-2.5 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("app.registries.registry")}>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="ghcr.io"
                autoComplete="off"
                className="h-8 text-xs"
              />
            </Field>
            <Field label={t("auth.username")}>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className="h-8 text-xs" />
            </Field>
            <Field label={t("app.registries.passwordOrToken")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="h-8 text-xs"
              />
            </Field>
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-faint">
            <ShieldCheck size={12} className="mt-0.5 shrink-0" />
            <span>
              {fillNodes(t("app.registries.passwordHint"), { host: <code>docker.io</code> })}
            </span>
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button
              className="h-8 px-3 text-xs"
              loading={busy === "add"}
              disabled={!host.trim() || !username.trim() || !password}
              onClick={() => void signIn()}
            >
              <LogIn size={13} /> {t("auth.signIn")}
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-3 text-xs"
              onClick={() => { setAdding(false); setPassword(""); }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      {state.registries.length === 0 ? (
        !adding && (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-ink-faint">
            {t("app.registries.empty")}
          </p>
        )
      ) : (
        <div className="space-y-1.5">
          {state.registries.map((r) => (
            <div key={r.host} className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
              <KeyRound size={14} className="shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-ink-soft">{r.host}</span>
                  {r.loggedIn ? (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-medium text-emerald-700">{t("app.registries.signedIn")}</span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-800">{t("app.registries.signedOut")}</span>
                  )}
                </div>
                <span className="text-[11px] text-ink-faint">
                  {r.username}
                  {r.lastLoginAt && ` - ${t("app.registries.since", { date: new Date(r.lastLoginAt).toLocaleDateString(locale) })}`}
                </span>
              </div>
              <button
                onClick={() => void signOut(r)}
                disabled={busy === r.host}
                title={t("app.registries.signOutForget")}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <LogOut size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
