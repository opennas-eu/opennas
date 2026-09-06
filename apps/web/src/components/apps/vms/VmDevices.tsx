import { useCallback, useEffect, useState } from "react";
import { Cable, Construction, Plug, Unplug, Usb } from "lucide-react";
import type { HostDevice, HostDevicesResponse, VmDevicesResponse, VmInfo } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Select } from "../../ui/controls.tsx";

/**
 * Handing a physical device to a VM.
 *
 * **USB only for now.** The PCI side is written and its refusals are proven -
 * the host's own disk controllers, live NICs and anything sharing their IOMMU
 * group are all rejected - but handing a card to a booting guest has never been
 * verified on hardware that could spare one, and PCI passthrough is not
 * something to let people discover is half-finished by losing a disk to it. So
 * PCI devices are listed read-only, with their eligibility shown, and can't be
 * attached until that verification happens.
 *
 * The list still leads with what *can't* be passed through and why: on a typical
 * board most PCI devices share an IOMMU group with something the host needs, and
 * an admin who doesn't know that reads a failure as a bug.
 */
export function VmDevices({ vm }: { vm: VmInfo }) {
  const [host, setHost] = useState<HostDevicesResponse | null>(null);
  const [attached, setAttached] = useState<HostDevice[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    const [h, a] = await Promise.all([
      api.get<HostDevicesResponse>("/vms/host-devices").catch(() => null),
      api.get<VmDevicesResponse>(`/vms/${vm.name}/devices`).catch(() => ({ attached: [] })),
    ]);
    setHost(h);
    setAttached(a.attached);
  }, [vm.name]);

  useEffect(() => { void load(); }, [load]);

  if (host === null) return <p className="text-xs text-ink-faint">Loading devices...</p>;

  const attachedIds = new Set(attached.map((d) => `${d.kind}:${d.id.toLowerCase()}`));
  const all = [...host.usb, ...host.pci];
  // Only USB can be attached today; see the note above.
  const available = host.usb.filter((d) => d.eligible && !attachedIds.has(`usb:${d.id.toLowerCase()}`));
  const pciEligible = host.pci.filter((d) => d.eligible);
  const blocked = host.pci.filter((d) => !d.eligible && !d.reason.startsWith("This is a PCI bridge"));
  const selected = available.find((d) => `${d.kind}:${d.id}` === pick);

  async function attach() {
    if (!selected) return;
    const companions = selected.groupMembers;
    const ok = await confirmDialog({
      title: `Pass ${selected.description} to ${vm.name}?`,
      message:
        (selected.kind === "pci"
          ? "The host gives this device up while the VM is defined to use it - it will disappear from the NAS itself. "
          : "The VM gets this USB device whenever it is plugged in; the host stops using it. ") +
        (companions.length > 0
          ? `Everything in IOMMU group ${selected.iommuGroup} moves together, so ${companions.join(", ")} ${companions.length === 1 ? "goes" : "go"} as well. `
          : "") +
        "The VM has to be restarted before it takes effect.",
      confirmLabel: "Pass through",
    });
    if (!ok) return;
    setBusy("attach");
    try {
      await api.post(`/vms/${vm.name}/devices`, { kind: selected.kind, id: selected.id });
      setPick("");
      push({ level: "success", title: "Device attached", body: `${selected.description} → ${vm.name}. Restart the VM to use it.` });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't attach the device", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function detach(d: HostDevice) {
    setBusy(d.id);
    try {
      await api.del(`/vms/${vm.name}/devices/${d.kind}/${encodeURIComponent(d.id)}`);
      push({ level: "success", title: "Device detached", body: "Restart the VM to release it fully." });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't detach the device", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {attached.length > 0 && (
        <ul className="space-y-1.5">
          {attached.map((d) => (
            <li key={`${d.kind}:${d.id}`} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200/70">
              {d.kind === "usb" ? <Usb size={14} className="shrink-0 text-ink-faint" /> : <Cable size={14} className="shrink-0 text-ink-faint" />}
              <div className="min-w-0 flex-1">
                <span className="truncate text-xs font-medium text-ink-soft">
                  {all.find((h) => h.kind === d.kind && h.id.toLowerCase() === d.id.toLowerCase())?.description ?? d.description}
                </span>
                <span className="block font-mono text-[11px] text-ink-faint">{d.id}</span>
              </div>
              <button
                onClick={() => void detach(d)}
                disabled={busy === d.id}
                title="Detach"
                className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <Unplug size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 max-w-xs flex-1 py-0 text-xs">
          <option value="">{available.length > 0 ? "Choose a USB device..." : "No USB devices available"}</option>
          {available.map((d) => (
            <option key={d.id} value={`usb:${d.id}`}>{d.description} ({d.id})</option>
          ))}
        </Select>
        <Button className="h-8 px-3 text-xs" loading={busy === "attach"} disabled={!selected} onClick={() => void attach()}>
          <Plug size={13} /> Pass through
        </Button>
      </div>

      <div className="rounded-lg bg-slate-50 p-2.5 ring-1 ring-slate-200/70 opacity-70">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-soft">
          <Construction size={12} className="shrink-0" />
          PCI passthrough - work in progress
        </p>
        <p className="text-[11px] text-ink-faint">
          Graphics cards and other PCI devices can't be attached yet - it works, but hasn't been proven on real
          hardware, so it stays off rather than half-working.
          {host.status.iommuActive
            ? ` This machine has an active IOMMU with ${host.status.iommuGroups} groups, and ${pciEligible.length} of ${host.pci.length} PCI devices would be candidates.`
            : ` ${host.status.reason}`}
        </p>
        {pciEligible.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {pciEligible.map((d) => (
              <li key={d.id} className="text-[11px] text-ink-faint">
                <span className="font-mono">{d.id}</span> {d.description}
                {d.iommuGroup !== null && ` - group ${d.iommuGroup}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && selected.groupMembers.length > 0 && (
        <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-ink-faint ring-1 ring-slate-200/70">
          IOMMU group {selected.iommuGroup} also holds {selected.groupMembers.join(", ")}. They move to the VM together -
          that's normal for a graphics card, which brings its audio and USB functions with it.
        </p>
      )}

      {blocked.length > 0 && (
        <details className="text-[11px] text-ink-faint">
          <summary className="cursor-pointer select-none">
            {blocked.length} PCI {blocked.length === 1 ? "device isn't" : "devices aren't"} available for passthrough
          </summary>
          <ul className="mt-1.5 space-y-1 pl-1">
            {blocked.map((d) => (
              <li key={d.id}>
                <span className="font-mono">{d.id}</span> {d.description} - {d.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
