import { useEffect, useState } from "react";
import { BadgeCheck, Copy, KeyRound, Plus, Trash2, X } from "lucide-react";
import type { CreateOidcClientResponse, OidcClientInfo, OidcClientsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Input } from "../../ui/controls.tsx";

function CopyField({ label, value }: { label: string; value: string }) {
  const push = useNotifications((s) => s.push);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-faint">{label}</div>
      <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">{value}</code>
        <button
          onClick={() => { void navigator.clipboard?.writeText(value); push({ level: "info", title: "Copied" }); }}
          className="shrink-0 text-ink-faint transition hover:text-ink-soft"
          title="Copy"
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

export function IdentityProvider() {
  const push = useNotifications((s) => s.push);
  const [clients, setClients] = useState<OidcClientInfo[] | null>(null);
  const [issuer, setIssuer] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreateOidcClientResponse | null>(null);

  async function load() {
    const res = await api.get<OidcClientsResponse>("/admin/oidc/clients");
    setClients(res.clients);
    setIssuer(res.issuer);
  }
  useEffect(() => { void load(); }, []);

  async function remove(c: OidcClientInfo) {
    if (!(await confirmDialog({ title: `Delete "${c.name}"?`, message: "Apps using this client will no longer be able to sign users in.", confirmLabel: "Delete client", danger: true }))) return;
    try {
      await api.del(`/admin/oidc/clients/${c.clientId}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't delete", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  const discovery = `${issuer}/.well-known/openid-configuration`;

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><BadgeCheck size={20} /> Identity Provider</h2>
          <p className="text-sm text-ink-faint">Let your self-hosted apps sign people in with their OpenNAS account (OpenID Connect).</p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate(true)}><Plus size={16} /> New client</Button>
      </div>

      <div className="mb-5 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <p className="mb-2 text-sm font-medium text-ink-soft">Point your app's OIDC settings at:</p>
        <CopyField label="Discovery / issuer URL" value={discovery} />
        <p className="mt-2 text-xs text-ink-faint">Most apps need this URL, a client ID and a client secret.</p>
      </div>

      <h3 className="mb-2 text-sm font-semibold text-ink-soft">Registered apps</h3>
      <div className="space-y-2">
        {clients === null && <p className="text-sm text-ink-faint">Loading...</p>}
        {clients?.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            No apps registered yet. Add one to let it use OpenNAS for sign-in.
          </div>
        )}
        {clients?.map((c) => (
          <div key={c.clientId} className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-400 to-violet-600 text-white"><KeyRound size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink-soft">{c.name}</div>
              <div className="truncate font-mono text-xs text-ink-faint">{c.clientId}</div>
              <div className="mt-0.5 truncate text-xs text-ink-faint">{c.redirectUris.join(", ")}</div>
            </div>
            <Button variant="ghost" className="h-8 px-2 text-rose-600 hover:bg-rose-50" title="Delete" onClick={() => void remove(c)}><Trash2 size={15} /></Button>
          </div>
        ))}
      </div>

      {showCreate && <CreateClientForm onClose={() => setShowCreate(false)} onCreated={async (r) => { setShowCreate(false); setCreated(r); await load(); }} onError={(m) => push({ level: "warning", title: "Couldn't create client", body: m })} />}
      {created && <CredentialsModal data={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function CreateClientForm({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (r: CreateOidcClientResponse) => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [uris, setUris] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const redirectUris = uris.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!name.trim() || redirectUris.length === 0) return;
    setBusy(true);
    try {
      const res = await api.post<CreateOidcClientResponse>("/admin/oidc/clients", { name: name.trim(), redirectUris });
      onCreated(res);
    } catch (err) {
      onError(err instanceof ApiRequestError ? err.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-ink">Register an app</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-soft">App name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nextcloud" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-soft">Redirect URIs <span className="text-ink-faint">(one per line)</span></label>
            <textarea value={uris} onChange={(e) => setUris(e.target.value)} rows={3} placeholder={"https://cloud.example.com/oidc/callback"} className="opennas-scroll w-full resize-y rounded-lg bg-slate-50 p-3 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <p className="mt-1 text-xs text-ink-faint">Where the app receives the response. Must match exactly.</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!name.trim() || !uris.trim()} onClick={create}>Create</Button>
        </div>
      </div>
    </div>
  );
}

function CredentialsModal({ data, onClose }: { data: CreateOidcClientResponse; onClose: () => void }) {
  return (
    <div className="animate-fade-in absolute inset-0 z-40 flex flex-col bg-slate-950/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-ink">"{data.client.name}" created</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100"><X size={18} /></button>
        </div>
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
          Copy the secret now. You won't be able to view it again.
        </p>
        <div className="space-y-3">
          <CopyField label="Client ID" value={data.client.clientId} />
          <CopyField label="Client secret" value={data.clientSecret} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
