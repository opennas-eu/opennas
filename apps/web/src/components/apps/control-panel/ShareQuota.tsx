import { useState } from "react";
import { AlertTriangle, Gauge, Info } from "lucide-react";
import type { Share, VolumeQuotaStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { formatBytes } from "../../../lib/format.ts";
import { Button, Input, Select } from "../../ui/controls.tsx";

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
        push({ level: "success", title: bytes > 0 ? "Quota set" : "Quota removed", body: share.name });
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't set that quota.");
    } finally {
      setBusy(null);
    }
  }

  async function enable() {
    if (!share.volume) return;
    const ok = await confirmDialog({
      title: `Turn on quotas for "${share.volume}"?`,
      message:
        "The volume is unmounted and remounted to switch this on, so anything reading from it - a copy in progress, " +
        "a running container - will be interrupted for a moment. Nothing is erased.",
      confirmLabel: "Enable quotas",
    });
    if (!ok) return;
    setBusy("enable");
    setError(null);
    try {
      await api.post(`/admin/quotas/${share.volume}/enable`, {});
      push({ level: "success", title: "Quotas enabled", body: share.volume });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't enable quotas on that volume.");
    } finally {
      setBusy(null);
    }
  }

  const used = share.quotaUsedBytes;
  const pct = share.quotaBytes > 0 && used != null ? Math.min(100, (used / share.quotaBytes) * 100) : null;

  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Gauge size={15} /> Size limit
      </h4>

      {onDefaultRoot ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          This folder lives in the default share root rather than on a data volume, and a quota needs a volume of its
          own to account against. Create the share on a data volume to cap it.
        </p>
      ) : !status?.supported ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{status?.reason || "Quotas aren't available on this volume."}</span>
        </p>
      ) : !status.active ? (
        <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200/70">
          <p className="mb-2 text-xs text-ink-faint">
            Quotas aren't switched on for <strong className="text-ink-soft">{share.volume}</strong> yet. Turning them on
            remounts the volume once; after that, every share on it can have its own limit.
          </p>
          <Button variant="secondary" className="h-8 px-3 text-xs" loading={busy === "enable"} onClick={enable}>
            Enable quotas on {share.volume}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200/70">
          {share.quotaBytes > 0 && (
            <div className="mb-2.5">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-ink-soft">
                  {used != null ? formatBytes(used) : "-"} of {formatBytes(share.quotaBytes)}
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
              placeholder="No limit"
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
              Set limit
            </Button>
            {share.quotaBytes > 0 && (
              <Button variant="ghost" className="h-8 px-3 text-xs" loading={busy === "save"} onClick={() => save(0)}>
                Remove
              </Button>
            )}
          </div>

          <p className="mt-2 text-[11px] text-ink-faint">
            Enforced by the filesystem, so it applies to SMB and NFS writes as well as the web interface.
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
