import { useCallback, useEffect, useState } from "react";
import { Camera, RotateCcw, Trash2 } from "lucide-react";
import type { VmInfo, VmSnapshot, VmSnapshotsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Input } from "../../ui/controls.tsx";

/**
 * Snapshots of one VM.
 *
 * The thing worth being clear about in the UI is that reverting is destructive
 * in a direction people don't expect: everything the guest has written since the
 * snapshot goes, and there is no undo unless a newer snapshot exists. So the
 * confirmation names the snapshot and says so plainly rather than asking "are
 * you sure?".
 */
export function VmSnapshots({ vm }: { vm: VmInfo }) {
  const [snapshots, setSnapshots] = useState<VmSnapshot[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    const res = await api
      .get<VmSnapshotsResponse>(`/vms/${vm.name}/snapshots`)
      .catch(() => ({ snapshots: [] }));
    setSnapshots(res.snapshots);
  }, [vm.name]);

  useEffect(() => { void load(); }, [load]);

  function fail(err: unknown, title: string) {
    push({ level: "warning", title, body: err instanceof ApiRequestError ? err.message : "Failed." });
  }

  async function take() {
    const snap = name.trim();
    if (!snap) return;
    setBusy("create");
    try {
      await api.post(`/vms/${vm.name}/snapshots`, { snapshot: snap });
      setName("");
      push({
        level: "success",
        title: "Snapshot taken",
        // Which kind you got depends on whether the VM was running, and it
        // changes what reverting does - so say it at the moment it's decided.
        body: vm.state === "running" ? `${snap} - includes memory, so reverting resumes mid-run.` : `${snap} - disk only.`,
      });
      await load();
    } catch (err) {
      fail(err, "Couldn't take the snapshot");
    } finally {
      setBusy(null);
    }
  }

  async function revert(snap: VmSnapshot) {
    const ok = await confirmDialog({
      title: `Revert to "${snap.name}"?`,
      message:
        `Everything ${vm.name} has written since this snapshot was taken will be lost - files, logs, database rows, all of it. ` +
        (snap.withMemory
          ? "The VM will resume from the exact moment the snapshot was taken."
          : "The VM will be back at a clean boot from that point.") +
        " This can't be undone unless you take a snapshot first.",
      confirmLabel: "Revert",
      danger: true,
    });
    if (!ok) return;
    setBusy(snap.name);
    try {
      await api.post(`/vms/${vm.name}/snapshots/${snap.name}/revert`, {});
      push({ level: "success", title: "Reverted", body: `${vm.name} is back at ${snap.name}.` });
      await load();
    } catch (err) {
      fail(err, "Couldn't revert");
    } finally {
      setBusy(null);
    }
  }

  async function remove(snap: VmSnapshot) {
    const ok = await confirmDialog({
      title: `Delete snapshot "${snap.name}"?`,
      message: "The VM keeps running as it is; only the saved point is removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(snap.name);
    try {
      await api.del(`/vms/${vm.name}/snapshots/${snap.name}`);
      await load();
    } catch (err) {
      fail(err, "Couldn't delete the snapshot");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void take(); }}
          placeholder="Snapshot name"
          className="h-8 w-48 text-xs"
        />
        <Button className="h-8 px-3 text-xs" loading={busy === "create"} disabled={!name.trim()} onClick={() => void take()}>
          <Camera size={13} /> Take snapshot
        </Button>
        <span className="text-[11px] text-ink-faint">
          {vm.state === "running"
            ? "Taken live, so memory is included and the VM pauses for a moment."
            : "The VM is off, so this captures the disk only."}
        </span>
      </div>

      {snapshots === null ? (
        <p className="text-xs text-ink-faint">Loading...</p>
      ) : snapshots.length === 0 ? (
        <p className="text-xs text-ink-faint">No snapshots yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {snapshots.map((s) => (
            <li key={s.name} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200/70">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-ink-soft">{s.name}</span>
                  {s.withMemory && (
                    <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-px text-[10px] font-medium text-indigo-700">
                      with memory
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-ink-faint">
                  {s.createdAt ? new Date(s.createdAt).toLocaleString() : "-"} - {s.state}
                </span>
              </div>
              <button
                onClick={() => void revert(s)}
                disabled={busy === s.name}
                title="Revert to this snapshot"
                className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-slate-100 disabled:opacity-50"
              >
                <RotateCcw size={14} />
              </button>
              <button
                onClick={() => void remove(s)}
                disabled={busy === s.name}
                title="Delete snapshot"
                className="grid h-7 w-7 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
