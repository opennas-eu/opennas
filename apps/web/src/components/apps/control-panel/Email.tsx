import { useEffect, useState } from "react";
import { Mail, Send } from "lucide-react";
import type { SmtpConfig, SmtpResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Toggle } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";

export function Email() {
  const t = useT();
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
      push({ level: "success", title: t("cp.email.saved") });
    } catch (err) {
      push({ level: "warning", title: t("cp.couldntSave"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      await api.post("/admin/smtp/test", payload());
      push({ level: "success", title: t("cp.email.testSent"), body: t("cp.email.testSentBody", { target: cfg?.to || t("cp.email.recipientInbox") }) });
    } catch (err) {
      push({ level: "warning", title: t("cp.email.testFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(null);
    }
  }

  if (!cfg) return <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>;

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Mail size={20} /> {t("cp.email.title")}</h2>
        <p className="text-sm text-ink-faint">{t("cp.email.subtitle")}</p>
      </div>

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
        <div>
          <div className="text-sm font-medium text-ink-soft">{t("cp.email.enableAlerts")}</div>
          <div className="text-xs text-ink-faint">{t("cp.email.enableHint")}</div>
        </div>
        <Toggle checked={cfg.enabled} onChange={(v) => set("enabled", v)} label={t("cp.email.enable")} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("cp.email.host")}><Input value={cfg.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" /></Field>
        <Field label={t("cp.email.port")}><Input type="number" value={cfg.port} onChange={(e) => set("port", Number(e.target.value) || 0)} /></Field>
        <Field label={t("auth.username")}><Input value={cfg.username} onChange={(e) => set("username", e.target.value)} placeholder="you@example.com" autoComplete="off" /></Field>
        <Field label={t("auth.password")} hint={cfg.hasPassword ? t("cp.email.passwordSaved") : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={cfg.hasPassword ? "••••••••" : ""} autoComplete="new-password" />
        </Field>
        <Field label={t("cp.email.from")}><Input value={cfg.from} onChange={(e) => set("from", e.target.value)} placeholder="opennas@example.com" /></Field>
        <Field label={t("cp.email.to")}><Input value={cfg.to} onChange={(e) => set("to", e.target.value)} placeholder="admin@example.com" /></Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <Toggle checked={cfg.secure} onChange={(v) => set("secure", v)} label={t("cp.email.useTls")} />
        {t("cp.email.tlsHint")}
      </label>

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
        <div>
          <div className="text-sm font-medium text-ink-soft">{t("cp.email.diskAlerts")}</div>
          <div className="text-xs text-ink-faint">
            {t("cp.email.diskAlertsHint")}
          </div>
        </div>
        <Toggle checked={cfg.alertDiskHealth} onChange={(v) => set("alertDiskHealth", v)} label={t("cp.email.diskAlerts")} />
      </div>

      <div className="flex gap-2">
        <Button loading={busy === "save"} onClick={save}>{t("common.save")}</Button>
        <Button variant="secondary" loading={busy === "test"} onClick={test}><Send size={15} /> {t("cp.email.sendTest")}</Button>
      </div>
    </div>
  );
}
