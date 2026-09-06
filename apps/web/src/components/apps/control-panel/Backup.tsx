import { useRef, useState } from "react";
import { AlertTriangle, Download, Upload } from "lucide-react";
import type { ConfigBackup, ConfigRestorePlan, ConfigRestoreResult } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button } from "../../ui/controls.tsx";

export function Backup() {
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
        title: "Couldn't read that file",
        body: err instanceof ApiRequestError ? err.message : "It doesn't look like an OpenNAS backup.",
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
      push({ level: "success", title: "Configuration restored" });
    } catch (err) {
      push({ level: "warning", title: "Restore failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Download size={20} /> Backup &amp; restore</h2>
        <p className="text-sm text-ink-faint">Export your OpenNAS configuration to a file, or restore it from one.</p>
      </div>

      <section className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">Export</h3>
        <p className="mb-3 text-xs text-ink-faint">
          Shared folders with their permissions, groups and folder rules; accounts and roles; file services; app
          repository and personalisation.
        </p>
        {/* A plain link, so the browser handles the download and its filename. */}
        <a
          href={apiUrl("/admin/config/export")}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          <Download size={15} /> Download backup
        </a>
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-white px-3 py-2.5 text-xs text-ink-faint ring-1 ring-slate-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <strong className="font-medium text-ink-soft">Secrets are not included</strong> - passwords, passkeys,
            two-factor secrets, OIDC client secrets, the SMTP password and TLS keys all stay on this machine. That keeps the file safe to store,
            but it means restoring onto a fresh NAS brings accounts back <em>disabled</em> until you set a password.
          </div>
        </div>
      </section>

      <section className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">Restore</h3>
        <p className="mb-3 text-xs text-ink-faint">
          Merges into the current configuration: existing shares and accounts are updated, new ones added. Nothing is
          deleted.
        </p>
        <Button variant="secondary" onClick={() => input.current?.click()}>
          <Upload size={15} /> Choose a backup file
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
              <span className="font-medium text-ink-soft">{file.name}</span> - exported{" "}
              {new Date(file.backup.exportedAt).toLocaleString()} from OpenNAS {file.backup.version}
            </p>
            {plan.problems.length > 0 ? (
              <ul className="space-y-1 text-xs text-rose-700">
                {plan.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-ink-faint">Settings</dt><dd className="text-ink-soft">{plan.settings}</dd>
                  <dt className="text-ink-faint">Accounts</dt>
                  <dd className="text-ink-soft">{plan.usersNew} new, {plan.usersUpdated} updated</dd>
                  <dt className="text-ink-faint">Shared folders</dt>
                  <dd className="text-ink-soft">{plan.sharesNew} new, {plan.sharesUpdated} updated</dd>
                  <dt className="text-ink-faint">Groups</dt>
                  <dd className="text-ink-soft">{plan.groupsNew} new, {plan.groupsUpdated} updated</dd>
                </dl>
                <Button className="mt-3" loading={busy} onClick={restore}>Restore this configuration</Button>
              </>
            )}
          </div>
        )}

        {result && (
          <div className="mt-3 rounded-lg bg-white p-3 text-xs ring-1 ring-slate-200">
            <p className="mb-1.5 font-medium text-ink-soft">
              Restored {result.settings} settings, {result.usersCreated + result.usersUpdated} accounts,{" "}
              {result.groupsCreated + result.groupsUpdated} groups,{" "}
              {result.sharesCreated + result.sharesUpdated} shared folders
              {result.folderRules > 0 ? ` and ${result.folderRules} folder rule${result.folderRules === 1 ? "" : "s"}` : ""}.
            </p>
            {result.usersNeedingPassword.length > 0 && (
              <p className="mb-1.5 text-amber-700">
                These accounts have no password and stay disabled until you set one in Users:{" "}
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
