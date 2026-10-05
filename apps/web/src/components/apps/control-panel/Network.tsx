import { useEffect, useState } from "react";
import { Copy, Network as NetIcon, Save } from "lucide-react";
import type { NetIface, NetworkInfo, NetworkResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";
import { Ddns } from "./Ddns.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";

export function Network() {
  const t = useT();
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
      push({ level: "success", title: t("cp.network.hostnameUpdated"), body: t("cp.network.hostnameNow", { name: hostname }) });
    } catch (err) {
      push({ level: "warning", title: t("cp.network.hostnameFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setSavingHost(false);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">{t("cp.network")}</h2>
        <p className="text-sm text-ink-faint">{t("cp.network.subtitle")}</p>
      </div>

      <section className="mb-6 max-w-md">
        <Field label={t("cp.network.hostname")}>
          <div className="flex gap-2">
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} />
            <Button className="shrink-0" loading={savingHost} onClick={saveHostname}><Save size={15} /> {t("common.save")}</Button>
          </div>
        </Field>
        {net?.mdnsName && (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(`https://${net.mdnsName}`).then(
              () => push({ level: "success", title: t("cp.network.copied"), body: `https://${net.mdnsName}` }),
              () => {},
            )}
            className="mt-2 flex w-full items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-left text-[11px] text-ink-faint ring-1 ring-slate-200/70 transition hover:bg-slate-100"
          >
            <Copy size={12} className="mt-0.5 shrink-0" />
            <span>
              {fillElements(t("cp.network.reachAt"), {
                url: <strong className="text-ink-soft">https://{net.mdnsName}</strong>,
              })}
            </span>
          </button>
        )}
      </section>

      <Ddns />

      <h3 className="mb-2 text-sm font-semibold text-ink-soft">{t("cp.network.interfaces")}</h3>
      {net === null ? (
        <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>
      ) : net.interfaces.length === 0 ? (
        <p className="text-sm text-ink-faint">{t("cp.network.noInterfaces")}</p>
      ) : (
        <div className="space-y-2.5">
          {net.interfaces.map((i) => <IfaceCard key={i.name} iface={i} dns={net.dns[0] ?? ""} gateway={net.gateway} onSaved={load} />)}
        </div>
      )}
    </div>
  );
}

function IfaceCard({ iface, dns, gateway, onSaved }: { iface: NetIface; dns: string; gateway: string; onSaved: () => Promise<void> }) {
  const t = useT();
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
      title: t("cp.network.changeTitle"),
      message: t("cp.network.changeMessage"),
      confirmLabel: t("cp.network.apply"),
      danger: true,
    }))) return;
    setBusy(true);
    try {
      await api.post("/admin/network/interface", { iface: iface.name, mode, ip, cidr, gateway: gw, dns: d });
      push({ level: "success", title: t("cp.network.updated"), body: t("cp.network.reconfigured", { name: iface.name }) });
      setEdit(false);
      await onSaved();
    } catch (err) {
      push({ level: "warning", title: t("cp.network.changeFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
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
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">{iface.dhcp ? "DHCP" : t("cp.network.static")}</span>
          </div>
          <div className="text-xs text-ink-faint">{iface.ip4 || t("cp.network.noAddress")}{iface.speedMbps ? ` - ${iface.speedMbps} Mbps` : ""} - {iface.mac}</div>
        </div>
        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEdit((e) => !e)}>{t("cp.network.configure")}</Button>
      </div>
      {edit && (
        <div className="space-y-3 border-t border-slate-200 bg-white p-4">
          <Field label={t("cp.network.method")}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as "dhcp" | "static")} className="w-full">
              <option value="dhcp">{t("cp.network.dhcp")}</option>
              <option value="static">{t("cp.network.manual")}</option>
            </Select>
          </Field>
          {mode === "static" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("cp.network.ip")}><Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" /></Field>
              <Field label={t("cp.network.prefix")}><Input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="24" /></Field>
              <Field label={t("cp.network.gateway")}><Input value={gw} onChange={(e) => setGw(e.target.value)} placeholder="192.168.1.1" /></Field>
              <Field label="DNS"><Input value={d} onChange={(e) => setD(e.target.value)} placeholder="1.1.1.1" /></Field>
            </div>
          )}
          <div className="flex gap-2">
            <Button loading={busy} onClick={save}>{t("cp.network.apply")}</Button>
            <Button variant="ghost" onClick={() => setEdit(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
