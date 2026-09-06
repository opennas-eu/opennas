import { useEffect, useState } from "react";
import { Check, Copy, FileCode, Server, X } from "lucide-react";
import { clsx } from "clsx";
import type { ServicesConfig, ServicesResponse } from "@opennas/shared";
import { api } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Toggle } from "../../ui/controls.tsx";

export function Services() {
  const [data, setData] = useState<ServicesResponse | null>(null);
  const [cfg, setCfg] = useState<ServicesConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"smb" | "exports">("smb");
  const push = useNotifications((s) => s.push);

  async function load() {
    const res = await api.get<ServicesResponse>("/admin/services");
    setData(res);
    setCfg(res.config);
    setDirty(false);
  }
  useEffect(() => { void load(); }, []);

  function patch(next: Partial<ServicesConfig>) {
    setCfg((c) => (c ? { ...c, ...next } : c));
    setDirty(true);
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    try {
      const res = await api.put<ServicesResponse>("/admin/services", cfg);
      setData(res);
      setCfg(res.config);
      setDirty(false);
      push({ level: "success", title: "Services updated", body: "Configuration saved and regenerated." });
    } catch {
      push({ level: "warning", title: "Save failed", body: "Could not update services." });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg || !data) return <p className="text-sm text-ink-faint">Loading...</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">File Services</h2>
          <p className="text-sm text-ink-faint">Enable network protocols and review the generated configuration.</p>
        </div>
        {dirty && <Button loading={busy} onClick={save}>Apply</Button>}
      </div>

      {/* SMB */}
      <ServiceCard
        title="SMB / CIFS"
        subtitle="Windows & macOS file sharing (Samba)"
        enabled={cfg.smb.enabled}
        onToggle={(v) => patch({ smb: { ...cfg.smb, enabled: v } })}
        detected={data.daemons.smbd}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Workgroup">
            <Input value={cfg.smb.workgroup} onChange={(e) => patch({ smb: { ...cfg.smb, workgroup: e.target.value } })} />
          </Field>
          <Field label="Server description">
            <Input value={cfg.smb.serverString} onChange={(e) => patch({ smb: { ...cfg.smb, serverString: e.target.value } })} />
          </Field>
        </div>
        <label className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-sm text-ink-soft">Allow guest access to guest-enabled shares</span>
          <Toggle checked={cfg.smb.allowGuest} onChange={(v) => patch({ smb: { ...cfg.smb, allowGuest: v } })} />
        </label>
      </ServiceCard>

      {/* NFS */}
      <ServiceCard
        title="NFS"
        subtitle="Unix & Linux file sharing"
        enabled={cfg.nfs.enabled}
        onToggle={(v) => patch({ nfs: { ...cfg.nfs, enabled: v } })}
        detected={data.daemons.nfsd}
      >
        <Field label="Allowed client networks" hint="Comma-separated, e.g. 192.168.1.0/24, 10.0.0.0/8. Leave blank for any.">
          <Input value={cfg.nfs.allowedNetworks} onChange={(e) => patch({ nfs: { ...cfg.nfs, allowedNetworks: e.target.value } })} placeholder="*" />
        </Field>
      </ServiceCard>

      {/* AFP */}
      <ServiceCard
        title="AFP"
        subtitle="Legacy Apple Filing Protocol (Netatalk)"
        enabled={cfg.afp.enabled}
        onToggle={(v) => patch({ afp: { ...cfg.afp, enabled: v } })}
        detected={data.daemons.afpd}
      >
        <p className="text-xs text-ink-faint">Use SMB for current versions of macOS. Enable AFP only for older devices that need it.</p>
      </ServiceCard>

      {/* Generated config */}
      <div className="rounded-xl bg-slate-900 text-slate-100 ring-1 ring-slate-700">
        <div className="flex items-center gap-2 border-b border-slate-700 px-4 py-2.5">
          <FileCode size={16} className="text-slate-400" />
          <span className="text-sm font-medium">Generated configuration</span>
          <div className="ml-auto flex gap-1">
            <TabBtn active={tab === "smb"} onClick={() => setTab("smb")}>smb.conf</TabBtn>
            <TabBtn active={tab === "exports"} onClick={() => setTab("exports")}>exports</TabBtn>
            <CopyBtn text={tab === "smb" ? data.generated.smbConf : data.generated.exports} />
          </div>
        </div>
        <pre className="opennas-scroll max-h-72 overflow-auto px-4 py-3 text-xs leading-relaxed">
          <code>{(tab === "smb" ? data.generated.smbConf : data.generated.exports) || "# nothing to export yet"}</code>
        </pre>
        <p className="border-t border-slate-700 px-4 py-2 text-[11px] text-slate-400">
          OpenNAS generates this from your shares & settings. On the NAS, point Samba/NFS at these files (or have OpenNAS write them) and reload the daemon to apply.
        </p>
      </div>
    </div>
  );
}

function ServiceCard({ title, subtitle, enabled, onToggle, detected, children }: {
  title: string; subtitle: string; enabled: boolean; onToggle: (v: boolean) => void; detected: boolean; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3">
        <span className={clsx("grid h-10 w-10 place-items-center rounded-xl text-white", enabled ? "bg-brand-600" : "bg-slate-400")}>
          <Server size={20} />
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink">{title}</span>
            <span className={clsx("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", detected ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
              {detected ? <Check size={10} /> : <X size={10} />} daemon {detected ? "detected" : "not found"}
            </span>
          </div>
          <div className="text-xs text-ink-faint">{subtitle}</div>
        </div>
        <Toggle checked={enabled} onChange={onToggle} label={title} />
      </div>
      {enabled && <div className="mt-4">{children}</div>}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("rounded px-2 py-1 text-xs font-medium transition", active ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}>
      {children}
    </button>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="rounded px-2 py-1 text-xs text-slate-400 transition hover:text-slate-200"
      title="Copy"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
