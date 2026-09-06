import { useEffect, useState } from "react";
import { AlertTriangle, Check, Plus, Trash2, Wrench } from "lucide-react";
import type { AppPermission, DevApp, DevAppsResponse } from "@opennas/shared";
import { APP_PERMISSIONS } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { Button, Field, Input, Toggle } from "../ui/controls.tsx";

/**
 * Development apps - load an app from a local dev server instead of repacking
 * and reinstalling a `.onpkg` for every change.
 *
 * The panel is explicit about the trade because the trade is the whole point:
 * this widens the desktop's `frame-src` by one origin per app, so it's
 * admin-only, restricted to localhost, and off unless somebody adds one.
 */
export function DevApps({ onChanged }: { onChanged: () => Promise<void> }) {
  const [apps, setApps] = useState<DevApp[] | null>(null);
  const [draft, setDraft] = useState<DevApp[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<DevApp>({ id: "", name: "", url: "http://localhost:5174", permissions: [], enabled: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<DevAppsResponse>("/apps/dev");
      setApps(res.apps);
      setDraft(res.apps);
    } catch {
      setApps([]);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(next: DevApp[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<DevAppsResponse>("/apps/dev", { apps: next });
      setApps(res.apps);
      setDraft(res.apps);
      setAdding(false);
      setForm({ id: "", name: "", url: "http://localhost:5174", permissions: [], enabled: true });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  if (apps === null) return null;

  function togglePerm(p: AppPermission) {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p],
    }));
  }

  return (
    <section className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
          <Wrench size={15} /> Development apps
        </h3>
        {!adding && (
          <Button variant="secondary" className="h-8 px-2.5 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-ink-faint">
        Run an app straight from your dev server - edit, refresh, no repacking. It gets the same sandbox and the same
        permission checks as an installed app; only the source of the files differs. Localhost only, and only
        administrators can see or launch them.
      </p>

      {adding && (
        <div className="mb-3 space-y-3 rounded-xl bg-white p-3.5 ring-1 ring-slate-200">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="App id" hint="Lowercase; must not clash with an installed app">
              <Input
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "") })}
                placeholder="my-app"
              />
            </Field>
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My App" />
            </Field>
            <Field label="Dev server URL">
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://localhost:5174" />
            </Field>
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium text-ink-soft">Permissions</div>
            <div className="flex flex-wrap gap-1.5">
              {APP_PERMISSIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => togglePerm(p)}
                  className={
                    "rounded-full px-2.5 py-1 text-xs ring-1 transition " +
                    (form.permissions.includes(p)
                      ? "bg-brand-600 text-white ring-brand-600"
                      : "bg-white text-ink-faint ring-slate-200 hover:text-ink-soft")
                  }
                >
                  {p}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              Grant only what you're testing - a development app is enforced exactly like any other.
            </p>
          </div>

          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex gap-2">
            <Button
              className="h-8 px-3 text-xs"
              loading={busy}
              disabled={form.id.length < 2 || !form.name.trim() || !form.url.trim()}
              onClick={() => save([...draft, form])}
            >
              <Check size={13} /> Add
            </Button>
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => { setAdding(false); setError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {apps.length === 0 && !adding ? (
        <p className="text-xs text-ink-faint">None registered.</p>
      ) : (
        <div className="space-y-1.5">
          {draft.map((a, i) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-white">
                <Wrench size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink-soft">{a.name}</span>
                  <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800">dev</span>
                  {a.permissions.length > 0 && (
                    <span className="truncate text-[10px] text-ink-faint">{a.permissions.join(", ")}</span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-ink-faint">{a.url}</div>
              </div>
              <Toggle
                checked={a.enabled}
                onChange={(v) => void save(draft.map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
                label={`Enable ${a.name}`}
              />
              <button
                aria-label={`Remove ${a.name}`}
                onClick={() => void save(draft.filter((_, j) => j !== i))}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {apps.length > 0 && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-amber-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            Each enabled entry lets the desktop frame that one origin. Remove them when you're done developing.
          </span>
        </div>
      )}
    </section>
  );
}
