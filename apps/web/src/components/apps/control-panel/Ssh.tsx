import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import type { SshConfig, SshResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Toggle } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";

export function Ssh() {
  const t = useT();
  const [ssh, setSsh] = useState<SshConfig | null>(null);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    setSsh((await api.get<SshResponse>("/admin/ssh")).ssh);
  }
  useEffect(() => { void load(); }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      setSsh((await api.post<SshResponse>("/admin/ssh", { enabled })).ssh);
      push({ level: "success", title: enabled ? t("cp.ssh.enabled") : t("cp.ssh.disabled") });
    } catch (err) {
      push({ level: "warning", title: t("cp.ssh.changeFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(false);
    }
  }

  async function addKey() {
    const key = newKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      setSsh((await api.post<SshResponse>("/admin/ssh/keys", { key })).ssh);
      setNewKey("");
      push({ level: "success", title: t("cp.ssh.keyAdded") });
    } catch (err) {
      push({ level: "warning", title: t("cp.ssh.addFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey(id: string) {
    try {
      setSsh((await api.del<SshResponse>(`/admin/ssh/keys/${id}`)).ssh);
    } catch (err) {
      push({ level: "warning", title: t("cp.ssh.removeFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  if (!ssh) return <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>;

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t("cp.ssh")}</h2>
        <p className="text-sm text-ink-faint">
          {ssh.user
            ? fillElements(t("cp.ssh.subtitleFor"), { user: <span className="font-medium text-ink-soft">{ssh.user}</span> })
            : t("cp.ssh.subtitle")}
        </p>
      </div>

      {!ssh.available && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-amber-200">
          {t("cp.ssh.unavailable")}
        </p>
      )}

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
        <div>
          <div className="text-sm font-medium text-ink-soft">{t("cp.ssh.enableServer")}</div>
          <div className="text-xs text-ink-faint">{ssh.enabled ? t("cp.ssh.running") : t("cp.ssh.stopped")}</div>
        </div>
        <Toggle checked={ssh.enabled} onChange={(v) => void toggle(v)} disabled={!ssh.available || busy} label={t("cp.ssh.enable")} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink-soft">{t("cp.ssh.authorizedKeys")}</h3>
        <div className="space-y-1.5">
          {ssh.keys.length === 0 && <p className="text-sm text-ink-faint">{t("cp.ssh.noKeys")}</p>}
          {ssh.keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs ring-1 ring-slate-200/70">
              <KeyRound size={14} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft" title={k.value}>
                {k.comment || k.value.split(" ").slice(0, 2).join(" ").slice(0, 40) + "..."}
              </span>
              <button onClick={() => void removeKey(k.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-rose-500 hover:text-white" title={t("cp.ssh.removeKey")}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <Field label={t("cp.ssh.addPublicKey")} hint={t("cp.ssh.addPublicKeyHint")}>
          <textarea
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="ssh-ed25519 AAAA... user@host"
            rows={3}
            className="opennas-scroll w-full resize-y rounded-lg bg-white px-3 py-2 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </Field>
        <Button className="h-9" loading={busy} onClick={addKey} disabled={!newKey.trim()}>
          <Plus size={16} /> {t("cp.ssh.addKey")}
        </Button>
      </div>
    </div>
  );
}
