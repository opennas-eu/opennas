import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import type { SelfUpdateResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button } from "../../ui/controls.tsx";

/**
 * Updating OpenNAS itself.
 *
 * Kept visibly separate from the Alpine package update below it, because they
 * are different things and conflating them is how someone ends up believing
 * they are on the latest OpenNAS when they have only refreshed the base system.
 *
 * The panel keeps polling while an update runs - the backend restarts partway
 * through, so requests will fail for a while, and treating that as an error
 * would report a *successful* update as a broken one.
 */
export function SelfUpdate() {
  const [data, setData] = useState<SelfUpdateResponse | null>(null);
  const [busy, setBusy] = useState<"check" | "apply" | "rollback" | null>(null);
  const [restarting, setRestarting] = useState(false);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    try {
      setData(await api.get<SelfUpdateResponse>("/admin/update/opennas"));
      setRestarting(false);
    } catch {
      // While the service is restarting this is expected, so it isn't surfaced.
      setData((d) => d);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Poll during an update, through the window where the backend is down.
  useEffect(() => {
    if (!restarting && data?.status.state !== "running") return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [restarting, data?.status.state, load]);

  async function check() {
    setBusy("check");
    try {
      setData(await api.get<SelfUpdateResponse>("/admin/update/opennas"));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!data?.available) return;
    const ok = await confirmDialog({
      title: `Update OpenNAS to ${data.available.version}?`,
      message:
        "The web interface goes away for up to a minute while it restarts. If the new version doesn't come back, " +
        "OpenNAS puts the previous one back by itself - you don't need to be here for that, and nothing on your disks is touched.",
      confirmLabel: "Update now",
    });
    if (!ok) return;
    setBusy("apply");
    try {
      await api.post("/admin/update/opennas", {});
      setRestarting(true);
      push({ level: "info", title: "Updating", body: "OpenNAS is restarting. This page will come back on its own." });
    } catch (err) {
      push({
        level: "warning",
        title: "Couldn't start the update",
        body: err instanceof ApiRequestError ? err.message : "Failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function rollback() {
    const ok = await confirmDialog({
      title: "Go back to the previous version?",
      message: "OpenNAS restarts on the version you were running before the last update.",
      confirmLabel: "Roll back",
      danger: true,
    });
    if (!ok) return;
    setBusy("rollback");
    try {
      await api.post("/admin/update/opennas/rollback", {});
      setRestarting(true);
    } catch (err) {
      push({
        level: "warning",
        title: "Couldn't roll back",
        body: err instanceof ApiRequestError ? err.message : "Failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  if (data === null) return null;
  const st = data.status;

  return (
    <section className="mb-6">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <ArrowUpCircle size={15} /> OpenNAS updates
      </h3>

      {!data.supported ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          Automatic updates are unavailable for this installation. Update it using the method you used to install it.
          Update it the same way you installed it.
        </p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-soft">
              Running <strong>{data.current}</strong>
            </span>
            {data.available ? (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                {data.available.version} available
              </span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                up to date
              </span>
            )}
          </div>

          {data.available?.notes && (
            <p className="mb-2 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-soft ring-1 ring-slate-200/70">
              {data.available.notes}
            </p>
          )}

          {(restarting || st.state === "running") && (
            <p className="mb-2 flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-ink-soft ring-1 ring-slate-200">
              <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
              <span>{st.message || "Updating..."} This page will reconnect automatically.</span>
            </p>
          )}
          {st.state === "ok" && !restarting && (
            <p className="mb-2 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
              <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> <span>{st.message}</span>
            </p>
          )}
          {st.state === "rolled_back" && (
            <p className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
              <RotateCcw size={13} className="mt-0.5 shrink-0" /> <span>{st.message}</span>
            </p>
          )}
          {st.state === "failed" && (
            <p className="mb-2 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{st.message}</span>
            </p>
          )}
          {data.error && (
            <p className="mb-2 text-xs text-ink-faint">{data.error}</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" className="h-8 px-3 text-xs" loading={busy === "check"} onClick={() => void check()}>
              Check now
            </Button>
            {data.available && (
              <Button className="h-8 px-3 text-xs" loading={busy === "apply"} disabled={restarting} onClick={() => void apply()}>
                <ArrowUpCircle size={13} /> Update to {data.available.version}
              </Button>
            )}
            {(st.state === "ok" || st.state === "failed") && (
              <Button variant="ghost" className="h-8 px-3 text-xs" loading={busy === "rollback"} onClick={() => void rollback()}>
                <RotateCcw size={13} /> Go back
              </Button>
            )}
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-faint">
            <ShieldCheck size={12} className="mt-0.5 shrink-0" />
            <span>
              Every update is signed, and the signature is checked by a part of the system the web interface can't
              reach - so a flaw in this page can't be turned into installing something. If a new version doesn't start,
              the previous one is restored automatically.
            </span>
          </p>
        </>
      )}
    </section>
  );
}
