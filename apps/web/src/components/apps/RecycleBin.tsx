import { useEffect, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import type { TrashItem, TrashListResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { formatBytes, formatRelative } from "../../lib/format.ts";
import { Button } from "../ui/controls.tsx";

export function RecycleBin({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<void> }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const push = useNotifications((s) => s.push);

  async function load() {
    setItems((await api.get<TrashListResponse>("/files/trash")).items);
  }
  useEffect(() => { void load(); }, []);

  async function restore(it: TrashItem) {
    try {
      await api.post(`/files/trash/${it.id}/restore`);
      push({ level: "success", title: "Restored", body: it.name });
      await load();
      await onChanged();
    } catch (err) {
      push({ level: "warning", title: "Couldn't restore", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function purge(it: TrashItem) {
    if (!(await confirmDialog({ title: `Permanently delete "${it.name}"?`, message: "This can't be undone.", confirmLabel: "Delete forever", danger: true }))) return;
    await api.del(`/files/trash/${it.id}`);
    await load();
  }

  async function empty() {
    if (!items?.length) return;
    if (!(await confirmDialog({ title: "Empty recycle bin?", message: `Permanently delete all ${items.length} item${items.length > 1 ? "s" : ""}. This can't be undone.`, confirmLabel: "Empty bin", danger: true }))) return;
    await api.post("/files/trash/empty");
    await load();
  }

  return (
    <div className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mx-auto flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <Trash2 size={18} className="text-ink-soft" />
          <h2 className="flex-1 font-semibold text-ink">Recycle Bin</h2>
          {(items?.length ?? 0) > 0 && (
            <Button variant="ghost" className="h-8 px-2 text-rose-600 hover:bg-rose-50" onClick={empty}>Empty bin</Button>
          )}
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100" title="Close"><X size={18} /></button>
        </div>

        <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-3">
          {items === null ? (
            <p className="p-6 text-center text-sm text-ink-faint">Loading...</p>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-ink-faint">The recycle bin is empty.</p>
          ) : (
            <div className="space-y-1.5">
              {items.map((it) => (
                <div key={it.id} className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink-soft">{it.name}{it.isDir ? "/" : ""}</div>
                    <div className="truncate text-xs text-ink-faint">{it.originalPath} - {it.isDir ? "folder" : formatBytes(it.sizeBytes)} - deleted {formatRelative(it.deletedAt)}</div>
                  </div>
                  <button onClick={() => void restore(it)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 transition hover:bg-brand-50" title="Restore"><RotateCcw size={13} /> Restore</button>
                  <button onClick={() => void purge(it)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-rose-500 hover:text-white" title="Delete forever"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
