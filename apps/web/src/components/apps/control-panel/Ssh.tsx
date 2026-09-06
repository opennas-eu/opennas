import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import type { SshConfig, SshResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Toggle } from "../../ui/controls.tsx";

export function Ssh() {
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
      push({ level: "success", title: `SSH ${enabled ? "enabled" : "disabled"}` });
    } catch (err) {
      push({ level: "warning", title: "Couldn't change SSH", body: err instanceof ApiRequestError ? err.message : "Failed." });
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
      push({ level: "success", title: "Key added" });
    } catch (err) {
      push({ level: "warning", title: "Couldn't add key", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey(id: string) {
    try {
      setSsh((await api.del<SshResponse>(`/admin/ssh/keys/${id}`)).ssh);
    } catch (err) {
      push({ level: "warning", title: "Couldn't remove key", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  if (!ssh) return <p className="text-sm text-ink-faint">Loading...</p>;

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-ink">SSH</h2>
        <p className="text-sm text-ink-faint">
          Remote shell access {ssh.user ? <>for <span className="font-medium text-ink-soft">{ssh.user}</span></> : ""}. Use public-key auth.
        </p>
      </div>

      {!ssh.available && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-amber-200">
          SSH management is only available on the installed appliance.
        </p>
      )}

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
        <div>
          <div className="text-sm font-medium text-ink-soft">Enable SSH server</div>
          <div className="text-xs text-ink-faint">{ssh.enabled ? "Running - accepting connections" : "Stopped"}</div>
        </div>
        <Toggle checked={ssh.enabled} onChange={(v) => void toggle(v)} disabled={!ssh.available || busy} label="Enable SSH" />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink-soft">Authorized keys</h3>
        <div className="space-y-1.5">
          {ssh.keys.length === 0 && <p className="text-sm text-ink-faint">No keys yet. Add one below to log in without a password.</p>}
          {ssh.keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs ring-1 ring-slate-200/70">
              <KeyRound size={14} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-ink-soft" title={k.value}>
                {k.comment || k.value.split(" ").slice(0, 2).join(" ").slice(0, 40) + "..."}
              </span>
              <button onClick={() => void removeKey(k.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-rose-500 hover:text-white" title="Remove key">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <Field label="Add a public key" hint="Paste an ssh-ed25519 / ssh-rsa public key line">
          <textarea
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="ssh-ed25519 AAAA... user@host"
            rows={3}
            className="opennas-scroll w-full resize-y rounded-lg bg-white px-3 py-2 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </Field>
        <Button className="h-9" loading={busy} onClick={addKey} disabled={!newKey.trim()}>
          <Plus size={16} /> Add key
        </Button>
      </div>
    </div>
  );
}
