import { useState } from "react";
import { AlertTriangle, Gauge, Info } from "lucide-react";
import type { Share, VolumeQuotaStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { formatBytes } from "../../../lib/format.ts";
import { Button, Input, Select } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";

/**
 * A size cap for one shared folder.
 *
 * Enforced by the filesystem, not by OpenNAS - which is the point: the cap
 * holds for SMB and NFS writes too, not only for what goes through the web UI.
 * That also means it needs the volume mounted with project quotas, which this
 * panel offers to switch on (and warns that doing so briefly remounts it).
 */

const UNITS: { label: string; bytes: number }[] = [
  { label: "GB", bytes: 1000 ** 3 },
  { label: "GiB", bytes: 1024 ** 3 },
  { label: "TB", bytes: 1000 ** 4 },
  { label: "TiB", bytes: 1024 ** 4 },
];

export function ShareQuota({
  share, status, perUserNote, onChanged,
}: {
  share: Share;
  status: VolumeQuotaStatus | null;
  perUserNote: string;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const push = useNotifications((s) => s.push);
  const [amount, setAmount] = useState(() => (share.quotaBytes > 0 ? String(share.quotaBytes / 1024 ** 3) : ""));
  const [unit, setUnit] = useState("GiB");
  const [busy, setBusy] = useState<"save" | "enable" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unitBytes = UNITS.find((u) => u.label === unit)?.bytes ?? 1024 ** 3;
  const onDefaultRoot = !share.volume;

  async function save(bytes: number) {
    setBusy("save");
    setError(null);
    try {
      const res = await api.patch<{ quotaWarning: string | null }>(`/admin/shares/${share.id}`, { quotaBytes: bytes });
      if (res.quotaWarning) {
        setError(res.quotaWarning);
      } else {
        push({ level: "success", title: bytes > 0 ? t("cp.quota.set") : t("cp.quota.removed"), body: share.name });
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.quota.setFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function enable() {
    if (!share.volume) return;
    const ok = await confirmDialog({
      title: t("cp.quota.enableTitle", { volume: share.volume }),
      message: t("cp.quota.enableMessage"),
      confirmLabel: t("cp.quota.enable"),
    });
    if (!ok) return;
    setBusy("enable");
    setError(null);
    try {
      await api.post(`/admin/quotas/${share.volume}/enable`, {});
      push({ level: "success", title: t("cp.quota.enabled"), body: share.volume });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.quota.enableFailed"));
    } finally {
      setBusy(null);
    }
  }

  const used = share.quotaUsedBytes;
  const pct = share.quotaBytes > 0 && used != null ? Math.min(100, (used / share.quotaBytes) * 100) : null;

  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Gauge size={15} /> {t("cp.quota.title")}
      </h4>

      {onDefaultRoot ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          {t("cp.quota.defaultRoot")}
        </p>
      ) : !status?.supported ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{status?.reason || t("cp.quota.unavailable")}</span>
        </p>
      ) : !status.active ? (
        <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200/70">
          <p className="mb-2 text-xs text-ink-faint">
            {fillElements(t("cp.quota.notActive"), { volume: <strong className="text-ink-soft">{share.volume}</strong> })}
          </p>
          <Button variant="secondary" className="h-8 px-3 text-xs" loading={busy === "enable"} onClick={enable}>
            {t("cp.quota.enableOn", { volume: share.volume ?? "" })}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200/70">
          {share.quotaBytes > 0 && (
            <div className="mb-2.5">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-ink-soft">
                  {t("storage.used", { used: used != null ? formatBytes(used) : "-", total: formatBytes(share.quotaBytes) })}
                </span>
                {pct != null && (
                  <span className={pct >= 90 ? "font-medium text-rose-600" : "text-ink-faint"}>{pct.toFixed(0)}%</span>
                )}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div
                  className={
                    "h-full rounded-full transition-all " +
                    (pct != null && pct >= 90 ? "bg-rose-500" : pct != null && pct >= 75 ? "bg-amber-500" : "bg-brand-500")
                  }
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={0}
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={t("cp.quota.noLimit")}
              className="h-8 w-28 text-xs"
            />
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} className="h-8 w-20 py-0 text-xs">
              {UNITS.map((u) => <option key={u.label} value={u.label}>{u.label}</option>)}
            </Select>
            <Button
              className="h-8 px-3 text-xs"
              loading={busy === "save"}
              onClick={() => save(Math.round(Number(amount) * unitBytes))}
              disabled={!amount || Number(amount) <= 0}
            >
              {t("cp.quota.setLimit")}
            </Button>
            {share.quotaBytes > 0 && (
              <Button variant="ghost" className="h-8 px-3 text-xs" loading={busy === "save"} onClick={() => save(0)}>
                {t("common.remove")}
              </Button>
            )}
          </div>

          <p className="mt-2 text-[11px] text-ink-faint">
            {t("cp.quota.enforced")}
          </p>
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-2 text-xs text-rose-600">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </p>
      )}

      {perUserNote && (
        <p className="mt-2 text-[11px] text-ink-faint">{perUserNote}</p>
      )}
    </div>
  );
}
