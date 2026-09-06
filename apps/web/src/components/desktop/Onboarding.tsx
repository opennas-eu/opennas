import { useState } from "react";
import { clsx } from "clsx";
import { Check, FolderPlus, Palette, Server, Sparkles } from "lucide-react";
import type { SharesResponse, ServicesResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useAuth } from "../../store/auth.ts";
import { usePrefs } from "../../store/prefs.ts";
import { useApps } from "../../store/apps.ts";
import { useWindows } from "../../store/windows.ts";
import { useIntents } from "../../store/intents.ts";
import { Button, Input, Toggle } from "../ui/controls.tsx";
import { ACCENTS } from "../../lib/accents.ts";
import { useT } from "../../i18n/index.ts";

/**
 * First-run wizard.
 *
 * Helps admins create a share, enable file services and choose an accent colour.
 * Every step is optional. Regular users cannot manage shares or services, so
 * they do not see this wizard.
 */

type Step = "welcome" | "share" | "services" | "look" | "done";

const STEPS: Step[] = ["welcome", "share", "services", "look", "done"];

export function Onboarding({ onClose }: { onClose: () => void }) {
  const t = useT();
  const user = useAuth((s) => s.session?.user);
  const preferences = usePrefs((s) => s.preferences);
  const save = usePrefs((s) => s.update);
  const apps = useApps((s) => s.apps);
  const openApp = useWindows((s) => s.openApp);
  const setIntent = useIntents((s) => s.set);

  const [step, setStep] = useState<Step>("welcome");
  const [shareName, setShareName] = useState("");
  const [shareCreated, setShareCreated] = useState<string | null>(null);
  const [smb, setSmb] = useState(true);
  const [nfs, setNfs] = useState(false);
  const [servicesSaved, setServicesSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const index = STEPS.indexOf(step);

  async function finish() {
    // Persist first, so a failure here doesn't mean seeing the wizard forever.
    await save({ onboarded: true }).catch(() => {});
    onClose();
  }

  async function createShare() {
    const name = shareName.trim();
    if (!name) { setStep("services"); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post<SharesResponse>("/admin/shares", {
        name,
        comment: "",
        guestAccess: "none",
        smbEnabled: true,
        nfsEnabled: false,
        browseable: true,
      });
      setShareCreated(name);
      setStep("services");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("ob.shareFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveServices() {
    setBusy(true);
    setError(null);
    try {
      await api.put<ServicesResponse>("/admin/services", { smb: { enabled: smb }, nfs: { enabled: nfs } });
      setServicesSaved(true);
      setStep("look");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("ob.servicesFailed"));
    } finally {
      setBusy(false);
    }
  }

  function openControlPanel(section: string) {
    const panel = apps.find((a) => a.id === "control-panel");
    if (panel) {
      setIntent("control-panel", section);
      openApp(panel);
    }
    void finish();
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[70] grid place-items-center bg-slate-950/50 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
        <div className="flex items-center gap-1.5 border-b border-slate-200 px-5 py-3">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={clsx(
                "h-1 flex-1 rounded-full transition-colors",
                i <= index ? "bg-brand-500" : "bg-slate-200",
              )}
            />
          ))}
        </div>

        <div className="min-h-[19rem] p-6">
          {step === "welcome" && (
            <div className="text-center">
              <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-100 text-brand-600">
                <Sparkles size={26} />
              </span>
              <h2 className="mb-1 text-xl font-semibold text-ink">{user ? t("ob.welcomeName", { name: user.displayName }) : t("ob.welcome")}</h2>
              <p className="mx-auto max-w-sm text-sm text-ink-faint">
{t("ob.intro")}
              </p>
            </div>
          )}

          {step === "share" && (
            <div>
              <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand-100 text-brand-600">
                <FolderPlus size={22} />
              </span>
              <h2 className="mb-1 text-lg font-semibold text-ink">{t("ob.createShare")}</h2>
              <p className="mb-4 text-sm text-ink-faint">
                Use shared folders for documents, media and backups. You can add more folders later and
                set access permissions for each one.
              </p>
              <Input
                value={shareName}
                onChange={(e) => setShareName(e.target.value)}
                placeholder="e.g. documents"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") void createShare(); }}
              />
              <p className="mt-2 text-xs text-ink-faint">{t("ob.nameHint")}</p>
            </div>
          )}

          {step === "services" && (
            <div>
              <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand-100 text-brand-600">
                <Server size={22} />
              </span>
              <h2 className="mb-1 text-lg font-semibold text-ink">{t("ob.reachIt")}</h2>
              <p className="mb-4 text-sm text-ink-faint">
                {shareCreated
                  ? <>{t("ob.reachItReady", { name: shareCreated })}</>
                  : t("ob.reachItPlain")}
              </p>
              <div className="space-y-2">
                <label className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
                  <span>
                    <span className="block text-sm font-medium text-ink-soft">SMB</span>
                    <span className="block text-xs text-ink-faint">{t("ob.smbHint")}</span>
                  </span>
                  <Toggle checked={smb} onChange={setSmb} label={t("ob.enableSmb")} />
                </label>
                <label className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
                  <span>
                    <span className="block text-sm font-medium text-ink-soft">NFS</span>
                    <span className="block text-xs text-ink-faint">{t("ob.nfsHint")}</span>
                  </span>
                  <Toggle checked={nfs} onChange={setNfs} label={t("ob.enableNfs")} />
                </label>
              </div>
            </div>
          )}

          {step === "look" && (
            <div>
              <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand-100 text-brand-600">
                <Palette size={22} />
              </span>
              <h2 className="mb-1 text-lg font-semibold text-ink">{t("ob.makeItYours")}</h2>
              <p className="mb-4 text-sm text-ink-faint">
{t("ob.accentHint")}
              </p>
              <div className="flex flex-wrap gap-2">
                {ACCENTS.map((a) => (
                  <button
                    key={a.value}
                    onClick={() => void save({ accent: a.value })}
                    aria-label={a.name}
                    title={a.name}
                    className={clsx(
                      "h-9 w-9 rounded-full ring-2 ring-offset-2 transition",
                      preferences.accent === a.value ? "ring-ink-soft" : "ring-transparent hover:ring-slate-300",
                    )}
                    style={{ background: a.value }}
                  />
                ))}
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="text-center">
              <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-100 text-emerald-600">
                <Check size={26} />
              </span>
              <h2 className="mb-1 text-xl font-semibold text-ink">{t("ob.done")}</h2>
              <p className="mx-auto mb-4 max-w-sm text-sm text-ink-faint">
                {shareCreated ? t("ob.doneShare", { name: shareCreated }) : ""}
                {servicesSaved && (smb || nfs) ? t("ob.doneSharing") : ""}
                Press <kbd className="rounded border border-slate-200 px-1 text-[11px]">Ctrl</kbd>+
                <kbd className="rounded border border-slate-200 px-1 text-[11px]">K</kbd> any time to search apps,
                settings and files.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => openControlPanel("users")}>
                  {t("ob.addUser")}
                </Button>
                <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => openControlPanel("storage")}>
                  Check disks
                </Button>
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-200 px-5 py-3">
          <button onClick={() => void finish()} className="text-xs text-ink-faint transition hover:text-ink-soft">
            {t("ob.skipSetup")}
          </button>
          <span className="flex-1" />
          {index > 0 && step !== "done" && (
            <Button variant="ghost" onClick={() => setStep(STEPS[index - 1]!)} disabled={busy}>
              Back
            </Button>
          )}
          {step === "welcome" && <Button onClick={() => setStep("share")}>{t("ob.getStarted")}</Button>}
          {step === "share" && (
            <Button loading={busy} onClick={createShare}>{shareName.trim() ? t("ob.createFolder") : t("ob.skip")}</Button>
          )}
          {step === "services" && <Button loading={busy} onClick={saveServices}>{t("ob.continue")}</Button>}
          {step === "look" && <Button onClick={() => setStep("done")}>{t("ob.continue")}</Button>}
          {step === "done" && <Button onClick={() => void finish()}>{t("ob.finish")}</Button>}
        </div>
      </div>
    </div>
  );
}
