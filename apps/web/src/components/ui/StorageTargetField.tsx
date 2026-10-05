import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import type { StorageTarget, StorageTargetsResponse } from "@opennas/shared";
import { api } from "../../lib/api.ts";
import { Select } from "./controls.tsx";
import { useT } from "../../i18n/index.ts";

/**
 * "Where should this live?" for anything that allocates real storage.
 *
 * Asked per item rather than read from a global setting, because the answer
 * genuinely differs per item - a big VM belongs on the big disk even when
 * everything else defaults to the SSD. The configured default is always the
 * first option, so accepting it is one keystroke.
 *
 * Renders nothing when the machine has only the default location: a picker with
 * one choice is just a question with no answer.
 */
export function StorageTargetField({
  value,
  onChange,
  label,
  hint,
}: {
  value: string;
  onChange: (label: string) => void;
  label?: string;
  hint?: string;
}) {
  const t = useT();
  const [targets, setTargets] = useState<StorageTarget[] | null>(null);

  useEffect(() => {
    void api
      .get<StorageTargetsResponse>("/admin/storage/targets")
      .then((r) => setTargets(r.targets))
      .catch(() => setTargets([]));
  }, []);

  if (!targets || targets.length <= 1) return null;

  const selected = targets.find((target) => target.label === value) ?? targets[0]!;

  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-soft">{label ?? t("ui.storageTarget.label")}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
        {targets.map((target) => (
          <option key={target.label || "__default"} value={target.label}>
            {target.label ? t("ui.storageTarget.volume", { name: target.name }) : t("ui.storageTarget.default")}
          </option>
        ))}
      </Select>
      <span className="mt-1 flex items-center gap-1 text-xs text-ink-faint">
        <HardDrive size={11} /> <span className="truncate font-mono">{selected.path}</span>
      </span>
      {hint && <span className="mt-0.5 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}
