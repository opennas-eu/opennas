import { useEffect, useState } from "react";
import { BadgeCheck, Copy, KeyRound, Plus, Trash2, X } from "lucide-react";
import type { CreateOidcClientResponse, OidcClientInfo, OidcClientsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Input } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";

function CopyField({ label, value }: { label: string; value: string }) {
  const t = useT();
  const push = useNotifications((s) => s.push);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-faint">{label}</div>
      <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">{value}</code>
        <button
          onClick={() => { void navigator.clipboard?.writeText(value); push({ level: "info", title: t("cp.idp.copied") }); }}
          className="shrink-0 text-ink-faint transition hover:text-ink-soft"
          title={t("cp.idp.copy")}
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

export function IdentityProvider() {
  const t = useT();
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
    if (!(await confirmDialog({ title: t("cp.idp.deleteTitle", { name: c.name }), message: t("cp.idp.deleteMessage"), confirmLabel: t("cp.idp.deleteClient"), danger: true }))) return;
    try {
      await api.del(`/admin/oidc/clients/${c.clientId}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.idp.deleteFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  const discovery = `${issuer}/.well-known/openid-configuration`;

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><BadgeCheck size={20} /> {t("cp.identityProvider")}</h2>
          <p className="text-sm text-ink-faint">{t("cp.idp.subtitle")}</p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate(true)}><Plus size={16} /> {t("cp.idp.newClient")}</Button>
      </div>

      <div className="mb-5 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <p className="mb-2 text-sm font-medium text-ink-soft">{t("cp.idp.pointAt")}</p>
        <CopyField label={t("cp.idp.discoveryUrl")} value={discovery} />
        <p className="mt-2 text-xs text-ink-faint">{t("cp.idp.needs")}</p>
      </div>

      <h3 className="mb-2 text-sm font-semibold text-ink-soft">{t("cp.idp.registeredApps")}</h3>
      <div className="space-y-2">
        {clients === null && <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>}
        {clients?.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            {t("cp.idp.empty")}
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
            <Button variant="ghost" className="h-8 px-2 text-rose-600 hover:bg-rose-50" title={t("common.delete")} onClick={() => void remove(c)}><Trash2 size={15} /></Button>
          </div>
        ))}
      </div>

      {showCreate && <CreateClientForm onClose={() => setShowCreate(false)} onCreated={async (r) => { setShowCreate(false); setCreated(r); await load(); }} onError={(m) => push({ level: "warning", title: t("cp.idp.createFailed"), body: m })} />}
      {created && <CredentialsModal data={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function CreateClientForm({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (r: CreateOidcClientResponse) => void; onError: (m: string) => void }) {
  const t = useT();
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
      onError(err instanceof ApiRequestError ? err.message : t("cp.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-ink">{t("cp.idp.registerApp")}</h2>
          <button onClick={onClose} aria-label={t("desktop.close")} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-soft">{t("cp.idp.appName")}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cp.idp.appNamePlaceholder")} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-ink-soft">{t("cp.idp.redirectUris")} <span className="text-ink-faint">{t("cp.idp.onePerLine")}</span></label>
            <textarea value={uris} onChange={(e) => setUris(e.target.value)} rows={3} placeholder={"https://cloud.example.com/oidc/callback"} className="opennas-scroll w-full resize-y rounded-lg bg-slate-50 p-3 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <p className="mt-1 text-xs text-ink-faint">{t("cp.idp.redirectHint")}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button loading={busy} disabled={!name.trim() || !uris.trim()} onClick={create}>{t("common.create")}</Button>
        </div>
      </div>
    </div>
  );
}

function CredentialsModal({ data, onClose }: { data: CreateOidcClientResponse; onClose: () => void }) {
  const t = useT();
  return (
    <div className="animate-fade-in absolute inset-0 z-40 flex flex-col bg-slate-950/50 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex-1 font-semibold text-ink">{t("cp.idp.created", { name: data.client.name })}</h2>
          <button onClick={onClose} aria-label={t("desktop.close")} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100"><X size={18} /></button>
        </div>
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
          {t("cp.idp.copySecretNow")}
        </p>
        <div className="space-y-3">
          <CopyField label={t("cp.idp.clientId")} value={data.client.clientId} />
          <CopyField label={t("cp.idp.clientSecret")} value={data.clientSecret} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>{t("cp.idp.done")}</Button>
        </div>
      </div>
    </div>
  );
}
