import { useCallback, useEffect, useState } from "react";
import { Cable, Construction, Plug, Unplug, Usb } from "lucide-react";
import type { HostDevice, HostDevicesResponse, VmDevicesResponse, VmInfo } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Select } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";

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
  const t = useT();

  const load = useCallback(async () => {
    const [h, a] = await Promise.all([
      api.get<HostDevicesResponse>("/vms/host-devices").catch(() => null),
      api.get<VmDevicesResponse>(`/vms/${vm.name}/devices`).catch(() => ({ attached: [] })),
    ]);
    setHost(h);
    setAttached(a.attached);
  }, [vm.name]);

  useEffect(() => { void load(); }, [load]);

  if (host === null) return <p className="text-xs text-ink-faint">{t("app.vms.loadingDevices")}</p>;

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
      title: t("app.vms.passConfirm", { device: selected.description, vm: vm.name }),
      message: [
        t(selected.kind === "pci" ? "app.vms.passPciBody" : "app.vms.passUsbBody"),
        companions.length > 0
          ? t("app.vms.passGroupBody", { group: String(selected.iommuGroup), devices: companions.join(", "), count: companions.length })
          : null,
        t("app.vms.passRestartBody"),
      ].filter(Boolean).join(" "),
      confirmLabel: t("app.vms.passThrough"),
    });
    if (!ok) return;
    setBusy("attach");
    try {
      await api.post(`/vms/${vm.name}/devices`, { kind: selected.kind, id: selected.id });
      setPick("");
      push({ level: "success", title: t("app.vms.deviceAttached"), body: t("app.vms.deviceAttachedBody", { device: selected.description, vm: vm.name }) });
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.attachFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
    } finally {
      setBusy(null);
    }
  }

  async function detach(d: HostDevice) {
    setBusy(d.id);
    try {
      await api.del(`/vms/${vm.name}/devices/${d.kind}/${encodeURIComponent(d.id)}`);
      push({ level: "success", title: t("app.vms.deviceDetached"), body: t("app.vms.deviceDetachedBody") });
      await load();
    } catch (err) {
      push({ level: "warning", title: t("app.vms.detachFailed"), body: err instanceof ApiRequestError ? err.message : t("common.failed") });
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
                title={t("app.vms.detach")}
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
          <option value="">{available.length > 0 ? t("app.vms.chooseUsb") : t("app.vms.noUsb")}</option>
          {available.map((d) => (
            <option key={d.id} value={`usb:${d.id}`}>{d.description} ({d.id})</option>
          ))}
        </Select>
        <Button className="h-8 px-3 text-xs" loading={busy === "attach"} disabled={!selected} onClick={() => void attach()}>
          <Plug size={13} /> {t("app.vms.passThrough")}
        </Button>
      </div>

      <div className="rounded-lg bg-slate-50 p-2.5 ring-1 ring-slate-200/70 opacity-70">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-soft">
          <Construction size={12} className="shrink-0" />
          {t("app.vms.pciWip")}
        </p>
        <p className="text-[11px] text-ink-faint">
          {t("app.vms.pciWipBody")}{" "}
          {host.status.iommuActive
            ? t("app.vms.pciIommu", { groups: host.status.iommuGroups, eligible: pciEligible.length, count: host.pci.length })
            : host.status.reason}
        </p>
        {pciEligible.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {pciEligible.map((d) => (
              <li key={d.id} className="text-[11px] text-ink-faint">
                <span className="font-mono">{d.id}</span> {d.description}
                {d.iommuGroup !== null && ` - ${t("app.vms.iommuGroupShort", { group: d.iommuGroup })}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && selected.groupMembers.length > 0 && (
        <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-ink-faint ring-1 ring-slate-200/70">
          {t("app.vms.groupNote", { group: String(selected.iommuGroup), devices: selected.groupMembers.join(", ") })}
        </p>
      )}

      {blocked.length > 0 && (
        <details className="text-[11px] text-ink-faint">
          <summary className="cursor-pointer select-none">
            {t("app.vms.pciBlocked", { count: blocked.length })}
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
