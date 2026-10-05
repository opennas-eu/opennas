import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Info, Network, Plus, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type { NetworksResponse, VirtNetwork } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";

/**
 * Put React nodes into a translated string's `{name}` placeholders, for
 * messages with inline markup (a `<code>` or `<strong>`) in the middle.
 * Placeholders without a matching node are left as written.
 */
export function fillNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1]! in nodes ? nodes[m[1]!] : part}</Fragment>;
  });
}

/**
 * Virtual networks for VMs.
 *
 * Only NAT and isolated networks can be made here. A bridged network means
 * re-plumbing the host's own NIC, and getting it wrong takes the NAS off the
 * network with no web UI left to fix it from - so bridges an admin has already
 * built are listed and can be attached to, but none is ever created.
 */
export function VirtNetworks() {
  const [nets, setNets] = useState<NetworksResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"nat" | "isolated">("nat");
  const [subnet, setSubnet] = useState("192.168.140.0/24");
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);
  const t = useT();

  const load = useCallback(async () => {
    setNets(await api.get<NetworksResponse>("/vms/networks").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy("create");
    try {
      const res = await api.post<{ ok: boolean; warning?: string }>("/vms/networks", { name: name.trim(), mode, subnet });
      if (res.warning) push({ level: "info", title: t("app.vms.networkDefined"), body: res.warning });
      else push({ level: "success", title: t("app.vms.networkCreated"), body: name.trim() });
      setAdding(false);
      setName("");
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.networkCreateFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  async function remove(n: VirtNetwork) {
    const ok = await confirmDialog({
      title: t("app.vms.networkDeleteConfirm", { name: n.name }),
      message: t("app.vms.networkDeleteConfirmBody"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusy(n.name);
    try {
      await api.del(`/vms/networks/${n.name}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.networkDeleteFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  if (nets === null) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-soft">{t("app.vms.networks")}</h3>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> {t("app.vms.newNetwork")}
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-2.5 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("common.name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="lab" className="h-8 text-xs" />
            </Field>
            <Field label={t("app.vms.networkType")}>
              <Select value={mode} onChange={(e) => setMode(e.target.value as "nat" | "isolated")} className="h-8 py-0 text-xs">
                <option value="nat">{t("app.vms.networkNat")}</option>
                <option value="isolated">{t("app.vms.networkIsolated")}</option>
              </Select>
            </Field>
            <Field label={t("app.vms.subnet")}>
              <Input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="192.168.140.0/24" className="h-8 text-xs" />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            {t("app.vms.subnetHint")}
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button className="h-8 px-3 text-xs" loading={busy === "create"} disabled={!name.trim()} onClick={() => void create()}>
              {t("common.create")}
            </Button>
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {nets.virt.map((n) => (
          <div key={n.name} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
            <span className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", n.active ? "bg-emerald-500" : "bg-slate-400")} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium text-ink-soft">{n.name}</span>
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium capitalize text-ink-soft">{n.mode}</span>
                {n.builtin && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{t("app.vms.builtIn")}</span>}
                {n.autostart && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">{t("app.vms.autostart")}</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-faint">
                {n.ipAddress && <span>{t("app.vms.gateway", { ip: n.ipAddress })}</span>}
                {n.bridge && <span>{t("app.vms.bridge", { name: n.bridge })}</span>}
                {!n.active && <span>{t("app.vms.networkStopped")}</span>}
              </div>
            </div>
            {!n.builtin && (
              <button
                onClick={() => void remove(n)}
                disabled={busy === n.name}
                title={t("app.vms.deleteNetwork")}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
        {nets.virt.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-ink-faint">
            {fillNodes(t("app.vms.noNetworks"), { name: <strong>default</strong> })}
          </p>
        )}
      </div>

      {nets.hostBridges.length > 0 && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-ink-faint ring-1 ring-slate-200/70">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            {fillNodes(t("app.vms.hostBridges", { count: nets.hostBridges.length }), {
              bridges: <strong className="text-ink-soft">{nets.hostBridges.join(", ")}</strong>,
            })}
          </span>
        </p>
      )}
    </section>
  );
}

/** Docker's networks - same idea, different daemon, so it lives beside its app. */
export function DockerNetworks() {
  const [nets, setNets] = useState<NetworksResponse | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);
  const t = useT();

  const load = useCallback(async () => {
    setNets(await api.get<NetworksResponse>("/vms/networks").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy("create");
    try {
      await api.post("/containers/networks", { name: name.trim() });
      push({ level: "success", title: t("app.vms.networkCreated"), body: name.trim() });
      setName("");
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.networkCreateFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    const ok = await confirmDialog({
      title: t("app.vms.networkDeleteConfirm", { name }),
      message: t("app.containers.networkDeleteConfirmBody"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusy(name);
    try {
      await api.del(`/containers/networks/${name}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.networkDeleteFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  if (nets === null || !nets.dockerAvailable) return null;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-ink-soft">{t("app.containers.networks")}</h3>
      <p className="mb-2 text-[11px] text-ink-faint">
        {fillNodes(t("app.containers.networksHint"), { bridge: <strong>bridge</strong> })}
      </p>

      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void create(); }}
          placeholder={t("app.containers.networkName")}
          className="h-8 w-48 text-xs"
        />
        <Button className="h-8 px-3 text-xs" loading={busy === "create"} disabled={!name.trim()} onClick={() => void create()}>
          <Plus size={13} /> {t("common.create")}
        </Button>
      </div>

      <div className="space-y-1.5">
        {nets.docker.map((n) => (
          <div key={n.id} className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
            <Network size={14} className="shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-xs font-medium text-ink-soft">{n.name}</span>
                <span className="rounded-full bg-slate-200 px-1.5 py-px text-[10px] font-medium text-ink-soft">{n.driver}</span>
                {n.builtin && <span className="rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-medium text-indigo-700">{t("app.vms.builtIn")}</span>}
              </div>
              <span className="text-[11px] text-ink-faint">
                {n.containers === 0 ? t("app.containers.noContainers") : t("app.containers.containerCount", { count: n.containers })}
              </span>
            </div>
            {!n.builtin && (
              <button
                onClick={() => void remove(n.name)}
                disabled={busy === n.name || n.containers > 0}
                title={n.containers > 0 ? t("app.containers.detachFirst") : t("app.vms.deleteNetwork")}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-soft"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
