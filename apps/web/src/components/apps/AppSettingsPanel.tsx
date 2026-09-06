import { useEffect, useState } from "react";
import { Lock, SlidersHorizontal, X } from "lucide-react";
import type { AppSettingField, AppSettingValue, AppSettingsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { Button, Field, Input, Select, Toggle } from "../ui/controls.tsx";

/**
 * The settings form for one installed app.
 *
 * OpenNAS renders this, not the app. The fields come from the app's manifest but
 * the inputs live in the trusted UI, so whatever is typed here - an API key, a
 * password - never passes through the sandboxed iframe. The app only ever sees
 * the saved result, through `app.settings.all()`.
 */
export function AppSettingsPanel({
  appId, appName, onClose,
}: { appId: string; appName: string; onClose: () => void }) {
  const push = useNotifications((s) => s.push);
  const [data, setData] = useState<AppSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, AppSettingValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<AppSettingsResponse>(`/apps/${appId}/settings`);
      setData(res);
      setDraft(res.values);
    } catch {
      setData(null);
    }
  }
  useEffect(() => { void load(); }, [appId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<AppSettingsResponse>(`/apps/${appId}/settings`, { values: draft });
      setData(res);
      setDraft(res.values);
      push({ level: "success", title: "Settings saved", body: appName });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save those settings.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.values);
  const set = (key: string, v: AppSettingValue) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <div className="mt-2 rounded-xl bg-white p-3.5 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
          <SlidersHorizontal size={15} /> {appName} settings
        </h4>
        <button onClick={onClose} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint hover:bg-slate-100">
          <X size={15} />
        </button>
      </div>

      {data.fields.length === 0 ? (
        <p className="text-xs text-ink-faint">This app doesn't have any settings.</p>
      ) : (
        <div className="space-y-3">
          {data.fields.map((f: AppSettingField) => (
            <div key={f.key}>
              {f.type === "boolean" ? (
                <label className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-ink-soft">
                      {f.label}
                      {f.scope === "admin" && <AdminBadge />}
                    </span>
                    {f.description && <span className="block text-xs text-ink-faint">{f.description}</span>}
                  </span>
                  <Toggle checked={draft[f.key] === true} onChange={(v) => set(f.key, v)} label={f.label} />
                </label>
              ) : (
                <Field
                  label={
                    <span className="flex items-center gap-1.5">
                      {f.label}
                      {f.scope === "admin" && <AdminBadge />}
                    </span>
                  }
                  hint={f.description}
                >
                  {f.type === "select" ? (
                    <Select value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)} className="w-full">
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </Select>
                  ) : f.type === "number" ? (
                    <Input
                      type="number"
                      value={String(draft[f.key] ?? "")}
                      min={f.min}
                      max={f.max}
                      placeholder={f.placeholder}
                      onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                    />
                  ) : (
                    <Input
                      // A field the app marked secret is masked here and
                      // redacted in the audit log.
                      type={f.secret ? "password" : "text"}
                      value={String(draft[f.key] ?? "")}
                      placeholder={f.placeholder}
                      autoComplete={f.secret ? "new-password" : "off"}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  )}
                </Field>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      {data.fields.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <Button className="h-8 px-3 text-xs" loading={busy} onClick={save} disabled={!dirty}>Save</Button>
          {dirty && <span className="text-xs text-ink-faint">Unsaved changes</span>}
          <span className="flex-1" />
          {!data.canEditAdmin && (
            <span className="text-[11px] text-ink-faint">Some settings are only editable by an administrator.</span>
          )}
        </div>
      )}
    </div>
  );
}

function AdminBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 text-[10px] font-normal text-ink-faint"
      title="One value for everyone on this NAS; only an administrator can change it."
    >
      <Lock size={9} /> shared
    </span>
  );
}
