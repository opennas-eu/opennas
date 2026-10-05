import { useRef, useState } from "react";
import { AlertTriangle, Download, Upload } from "lucide-react";
import type { ConfigBackup, ConfigRestorePlan, ConfigRestoreResult } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";

export function Backup() {
  const t = useT();
  const push = useNotifications((s) => s.push);
  const [file, setFile] = useState<{ name: string; backup: ConfigBackup } | null>(null);
  const [plan, setPlan] = useState<ConfigRestorePlan | null>(null);
  const [result, setResult] = useState<ConfigRestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function choose(picked: File) {
    setResult(null);
    setPlan(null);
    setFile(null);
    try {
      const backup = JSON.parse(await picked.text()) as ConfigBackup;
      setFile({ name: picked.name, backup });
      // Dry run before anything is touched, so the confirm button has a preview.
      setPlan(await api.post<ConfigRestorePlan>("/admin/config/plan", backup));
    } catch (err) {
      push({
        level: "warning",
        title: t("cp.backup.readFailed"),
        body: err instanceof ApiRequestError ? err.message : t("cp.backup.notABackup"),
      });
    }
  }

  async function restore() {
    if (!file) return;
    setBusy(true);
    try {
      const res = await api.post<ConfigRestoreResult>("/admin/config/import", file.backup);
      setResult(res);
      setPlan(null);
      push({ level: "success", title: t("cp.backup.restoredTitle") });
    } catch (err) {
      push({ level: "warning", title: t("cp.backup.restoreFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Download size={20} /> {t("cp.backup.title")}</h2>
        <p className="text-sm text-ink-faint">{t("cp.backup.subtitle")}</p>
      </div>

      <section className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">{t("cp.backup.export")}</h3>
        <p className="mb-3 text-xs text-ink-faint">
          {t("cp.backup.exportHint")}
        </p>
        {/* A plain link, so the browser handles the download and its filename. */}
        <a
          href={apiUrl("/admin/config/export")}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          <Download size={15} /> {t("cp.backup.download")}
        </a>
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-white px-3 py-2.5 text-xs text-ink-faint ring-1 ring-slate-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            {fillElements(t("cp.backup.secretsNote"), {
              secrets: <strong className="font-medium text-ink-soft">{t("cp.backup.secretsNotIncluded")}</strong>,
              disabled: <em>{t("cp.backup.disabledWord")}</em>,
            })}
          </div>
        </div>
      </section>

      <section className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">{t("cp.backup.restore")}</h3>
        <p className="mb-3 text-xs text-ink-faint">
          {t("cp.backup.restoreHint")}
        </p>
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <Upload size={15} /> {t("cp.backup.chooseFile")}
        </Button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ""; }}
        />

        {file && plan && (
          <div className="mt-3 rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <p className="mb-2 text-xs text-ink-faint">
              {fillElements(
                t("cp.backup.fileInfo", { date: new Date(file.backup.exportedAt).toLocaleString(), version: file.backup.version }),
                { file: <span className="font-medium text-ink-soft">{file.name}</span> },
              )}
            </p>
            {plan.problems.length > 0 ? (
              <ul className="space-y-1 text-xs text-rose-700">
                {plan.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-ink-faint">{t("cp.backup.settings")}</dt><dd className="text-ink-soft">{plan.settings}</dd>
                  <dt className="text-ink-faint">{t("cp.backup.accounts")}</dt>
                  <dd className="text-ink-soft">{t("cp.backup.newUpdated", { new: plan.usersNew, updated: plan.usersUpdated })}</dd>
                  <dt className="text-ink-faint">{t("cp.sharedFolders")}</dt>
                  <dd className="text-ink-soft">{t("cp.backup.newUpdated", { new: plan.sharesNew, updated: plan.sharesUpdated })}</dd>
                  <dt className="text-ink-faint">{t("cp.groups")}</dt>
                  <dd className="text-ink-soft">{t("cp.backup.newUpdated", { new: plan.groupsNew, updated: plan.groupsUpdated })}</dd>
                </dl>
                <Button className="mt-3" loading={busy} onClick={restore}>{t("cp.backup.restoreThis")}</Button>
              </>
            )}
          </div>
        )}

        {result && (
          <div className="mt-3 rounded-lg bg-white p-3 text-xs ring-1 ring-slate-200">
            <p className="mb-1.5 font-medium text-ink-soft">
              {t("cp.backup.restoredSummary", {
                items: [
                  t("cp.backup.nSettings", { count: result.settings }),
                  t("cp.backup.nAccounts", { count: result.usersCreated + result.usersUpdated }),
                  t("cp.backup.nGroups", { count: result.groupsCreated + result.groupsUpdated }),
                  t("shares.count", { count: result.sharesCreated + result.sharesUpdated }),
                ].join(", "),
                rules: result.folderRules > 0 ? t("cp.backup.andFolderRules", { count: result.folderRules }) : "",
              })}
            </p>
            {result.usersNeedingPassword.length > 0 && (
              <p className="mb-1.5 text-amber-700">
                {t("cp.backup.needPassword")}{" "}
                <span className="font-medium">{result.usersNeedingPassword.join(", ")}</span>
              </p>
            )}
            {result.warnings.map((w) => <p key={w} className="text-ink-faint">{w}</p>)}
          </div>
        )}
      </section>
    </div>
  );
}
