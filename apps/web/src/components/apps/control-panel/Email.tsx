import { useEffect, useState } from "react";
import { Mail, Send } from "lucide-react";
import type { SmtpConfig, SmtpResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Toggle } from "../../ui/controls.tsx";

export function Email() {
  const [cfg, setCfg] = useState<SmtpConfig | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const push = useNotifications((s) => s.push);

  useEffect(() => {
    void api.get<SmtpResponse>("/admin/smtp").then((r) => setCfg(r.smtp));
  }, []);

  function set<K extends keyof SmtpConfig>(key: K, value: SmtpConfig[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  /** Body for save/test: include the typed password only if one was entered. */
  function payload() {
    if (!cfg) return {};
    const { hasPassword: _hp, ...rest } = cfg;
    return { ...rest, ...(password ? { password } : {}) };
  }

  async function save() {
    setBusy("save");
    try {
      const r = await api.put<SmtpResponse>("/admin/smtp", payload());
      setCfg(r.smtp);
      setPassword("");
      push({ level: "success", title: "Email settings saved" });
    } catch (err) {
      push({ level: "warning", title: "Couldn't save", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      await api.post("/admin/smtp/test", payload());
      push({ level: "success", title: "Test email sent", body: `Check ${cfg?.to || "the recipient inbox"}.` });
    } catch (err) {
      push({ level: "warning", title: "Test failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  if (!cfg) return <p className="text-sm text-ink-faint">Loading...</p>;

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Mail size={20} /> Email (SMTP)</h2>
        <p className="text-sm text-ink-faint">Send alerts (e.g. disk health) by email through your SMTP server.</p>
      </div>

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
        <div>
          <div className="text-sm font-medium text-ink-soft">Enable email alerts</div>
          <div className="text-xs text-ink-faint">When off, no email is sent.</div>
        </div>
        <Toggle checked={cfg.enabled} onChange={(v) => set("enabled", v)} label="Enable email" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SMTP host"><Input value={cfg.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" /></Field>
        <Field label="Port"><Input type="number" value={cfg.port} onChange={(e) => set("port", Number(e.target.value) || 0)} /></Field>
        <Field label="Username"><Input value={cfg.username} onChange={(e) => set("username", e.target.value)} placeholder="you@example.com" autoComplete="off" /></Field>
        <Field label="Password" hint={cfg.hasPassword ? "A password is saved - leave blank to keep it" : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={cfg.hasPassword ? "••••••••" : ""} autoComplete="new-password" />
        </Field>
        <Field label="From address"><Input value={cfg.from} onChange={(e) => set("from", e.target.value)} placeholder="opennas@example.com" /></Field>
        <Field label="Alert recipient (To)"><Input value={cfg.to} onChange={(e) => set("to", e.target.value)} placeholder="admin@example.com" /></Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <Toggle checked={cfg.secure} onChange={(v) => set("secure", v)} label="Use TLS" />
        Use implicit TLS (port 465). Leave off for STARTTLS (587).
      </label>

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
        <div>
          <div className="text-sm font-medium text-ink-soft">Disk health alerts</div>
          <div className="text-xs text-ink-faint">
            Email the recipient when a disk reports a S.M.A.R.T. failure, reallocated sectors, or runs hot.
            Checked every 6 hours; reminders at most once a week per disk.
          </div>
        </div>
        <Toggle checked={cfg.alertDiskHealth} onChange={(v) => set("alertDiskHealth", v)} label="Disk health alerts" />
      </div>

      <div className="flex gap-2">
        <Button loading={busy === "save"} onClick={save}>Save</Button>
        <Button variant="secondary" loading={busy === "test"} onClick={test}><Send size={15} /> Send test email</Button>
      </div>
    </div>
  );
}
