import { useEffect, useState } from "react";
import { Copy, Network as NetIcon, Save } from "lucide-react";
import type { NetIface, NetworkInfo, NetworkResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";
import { Ddns } from "./Ddns.tsx";

export function Network() {
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [hostname, setHostname] = useState("");
  const [savingHost, setSavingHost] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    const res = await api.get<NetworkResponse>("/admin/network");
    setNet(res.network);
    setHostname(res.network.hostname);
  }
  useEffect(() => { void load(); }, []);

  async function saveHostname() {
    setSavingHost(true);
    try {
      await api.post("/admin/network/hostname", { hostname });
      push({ level: "success", title: "Hostname updated", body: `Now '${hostname}'.` });
    } catch (err) {
      push({ level: "warning", title: "Couldn't set hostname", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setSavingHost(false);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">Network</h2>
        <p className="text-sm text-ink-faint">Hostname and network interfaces.</p>
      </div>

      <section className="mb-6 max-w-md">
        <Field label="Hostname">
          <div className="flex gap-2">
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} />
            <Button className="shrink-0" loading={savingHost} onClick={saveHostname}><Save size={15} /> Save</Button>
          </div>
        </Field>
        {net?.mdnsName && (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(`https://${net.mdnsName}`).then(
              () => push({ level: "success", title: "Copied", body: `https://${net.mdnsName}` }),
              () => {},
            )}
            className="mt-2 flex w-full items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-left text-[11px] text-ink-faint ring-1 ring-slate-200/70 transition hover:bg-slate-100"
          >
            <Copy size={12} className="mt-0.5 shrink-0" />
            <span>
              Reach it at <strong className="text-ink-soft">https://{net.mdnsName}</strong> on your network - no IP
              needed. Tap to copy.
            </span>
          </button>
        )}
      </section>

      <Ddns />

      <h3 className="mb-2 text-sm font-semibold text-ink-soft">Interfaces</h3>
      {net === null ? (
        <p className="text-sm text-ink-faint">Loading...</p>
      ) : net.interfaces.length === 0 ? (
        <p className="text-sm text-ink-faint">No interfaces found.</p>
      ) : (
        <div className="space-y-2.5">
          {net.interfaces.map((i) => <IfaceCard key={i.name} iface={i} dns={net.dns[0] ?? ""} gateway={net.gateway} onSaved={load} />)}
        </div>
      )}
    </div>
  );
}

function IfaceCard({ iface, dns, gateway, onSaved }: { iface: NetIface; dns: string; gateway: string; onSaved: () => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [mode, setMode] = useState<"dhcp" | "static">(iface.dhcp ? "dhcp" : "static");
  const [ip, setIp] = useState(iface.ip4 || "");
  const [cidr, setCidr] = useState("24");
  const [gw, setGw] = useState(gateway);
  const [d, setD] = useState(dns);
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function save() {
    if (!(await confirmDialog({
      title: "Change network settings?",
      message: "Reconfiguring this interface may drop your connection until it reconnects.",
      confirmLabel: "Apply",
      danger: true,
    }))) return;
    setBusy(true);
    try {
      await api.post("/admin/network/interface", { iface: iface.name, mode, ip, cidr, gateway: gw, dns: d });
      push({ level: "success", title: "Network updated", body: `${iface.name} reconfigured.` });
      setEdit(false);
      await onSaved();
    } catch (err) {
      push({ level: "warning", title: "Network change failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3 p-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-white"><NetIcon size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-soft">{iface.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${iface.state === "up" ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-ink-faint"}`}>{iface.state}</span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">{iface.dhcp ? "DHCP" : "static"}</span>
          </div>
          <div className="text-xs text-ink-faint">{iface.ip4 || "no address"}{iface.speedMbps ? ` - ${iface.speedMbps} Mbps` : ""} - {iface.mac}</div>
        </div>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEdit((e) => !e)}>Configure</Button>
      </div>
      {edit && (
        <div className="space-y-3 border-t border-slate-200 bg-white p-4">
          <Field label="Method">
            <Select value={mode} onChange={(e) => setMode(e.target.value as "dhcp" | "static")} className="w-full">
              <option value="dhcp">Automatic (DHCP)</option>
              <option value="static">Manual (static IP)</option>
            </Select>
          </Field>
          {mode === "static" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="IP address"><Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" /></Field>
              <Field label="Prefix (CIDR)"><Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="24" /></Field>
              <Field label="Gateway"><Input value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" /></Field>
              <Field label="DNS"><Input value={d} onChange={(e) => setD(e.target.value)} placeholder="1.1.1.1" /></Field>
            </div>
          )}
          <div className="flex gap-2">
            <Button loading={busy} onClick={save}>Apply</Button>
            <Button variant="ghost" onClick={() => setEdit(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
