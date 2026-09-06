import { useCallback, useEffect, useState } from "react";
import { Info, Network, Plus, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type { NetworksResponse, VirtNetwork } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";

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

  const load = useCallback(async () => {
    setNets(await api.get<NetworksResponse>("/vms/networks").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy("create");
    try {
      const res = await api.post<{ ok: boolean; warning?: string }>("/vms/networks", { name: name.trim(), mode, subnet });
      if (res.warning) push({ level: "info", title: "Network defined", body: res.warning });
      else push({ level: "success", title: "Network created", body: name.trim() });
      setAdding(false);
      setName("");
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't create the network", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(n: VirtNetwork) {
    const ok = await confirmDialog({
      title: `Delete network "${n.name}"?`,
      message: "Any VM still attached to it will fail to start until you point it at another network.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(n.name);
    try {
      await api.del(`/vms/networks/${n.name}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't delete the network", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  if (nets === null) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-soft">Virtual networks</h3>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setAdding(true)}>
            <Plus size={13} /> New network
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-2.5 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="lab" className="h-8 text-xs" />
            </Field>
            <Field label="Type">
              <Select value={mode} onChange={(e) => setMode(e.target.value as "nat" | "isolated")} className="h-8 py-0 text-xs">
                <option value="nat">NAT - guests reach the LAN through the NAS</option>
                <option value="isolated">Isolated - guests reach only each other</option>
              </Select>
            </Field>
            <Field label="Subnet">
              <Input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="192.168.140.0/24" className="h-8 text-xs" />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            Pick a /24 that isn't already in use on your LAN, or guests will get addresses that clash with real machines.
            DHCP is handed out from .100 to .254.
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button className="h-8 px-3 text-xs" loading={busy === "create"} disabled={!name.trim()} onClick={() => void create()}>
              Create
            </Button>
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setAdding(false)}>Cancel</Button>
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
                {n.builtin && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">built in</span>}
                {n.autostart && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-ink-soft">autostart</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-faint">
                {n.ipAddress && <span>gateway {n.ipAddress}</span>}
                {n.bridge && <span>bridge {n.bridge}</span>}
                {!n.active && <span>stopped</span>}
              </div>
            </div>
            {!n.builtin && (
              <button
                onClick={() => void remove(n)}
                disabled={busy === n.name}
                title="Delete network"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
        {nets.virt.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-ink-faint">
            No virtual networks. libvirt normally provides a <strong>default</strong> NAT network; if it's missing, create one here.
          </p>
        )}
      </div>

      {nets.hostBridges.length > 0 && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-ink-faint ring-1 ring-slate-200/70">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            This host also has {nets.hostBridges.length === 1 ? "the bridge" : "bridges"}{" "}
            <strong className="text-ink-soft">{nets.hostBridges.join(", ")}</strong>, which a VM can be put on to sit
            directly on your LAN. OpenNAS doesn't create bridges itself - building one re-plumbs the NAS's own network
            connection, and a mistake there is only fixable from the console.
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

  const load = useCallback(async () => {
    setNets(await api.get<NetworksResponse>("/vms/networks").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy("create");
    try {
      await api.post("/containers/networks", { name: name.trim() });
      push({ level: "success", title: "Network created", body: name.trim() });
      setName("");
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't create the network", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(name: string) {
    const ok = await confirmDialog({
      title: `Delete network "${name}"?`,
      message: "Containers attached to it lose the addresses they reach each other by.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(name);
    try {
      await api.del(`/containers/networks/${name}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't delete the network", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  if (nets === null || !nets.dockerAvailable) return null;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-ink-soft">Networks</h3>
      <p className="mb-2 text-[11px] text-ink-faint">
        Containers on the same user-defined network can reach each other by container name, which is what an app and its
        database usually need. Docker's built-in <strong>bridge</strong> doesn't do that.
      </p>

      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void create(); }}
          placeholder="Network name"
          className="h-8 w-48 text-xs"
        />
        <Button className="h-8 px-3 text-xs" loading={busy === "create"} disabled={!name.trim()} onClick={() => void create()}>
          <Plus size={13} /> Create
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
                {n.builtin && <span className="rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-medium text-indigo-700">built in</span>}
              </div>
              <span className="text-[11px] text-ink-faint">
                {n.containers === 0 ? "no containers" : `${n.containers} container${n.containers === 1 ? "" : "s"}`}
              </span>
            </div>
            {!n.builtin && (
              <button
                onClick={() => void remove(n.name)}
                disabled={busy === n.name || n.containers > 0}
                title={n.containers > 0 ? "Detach its containers first" : "Delete network"}
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
