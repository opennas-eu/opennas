import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Plus, Store, Trash2, X } from "lucide-react";
import type { AppRepo, RepoConfigResponse, RepoSourceStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { Button, Input, Toggle } from "../ui/controls.tsx";

/**
 * The configured app repositories.
 *
 * Order is priority and that is load-bearing, not cosmetic: when two
 * repositories publish the same app id the one nearer the top wins, so the list
 * is reorderable and says so. Per-repository status comes from the last
 * catalogue fetch, which is what lets this say "that one is down" instead of
 * the whole App Center going dark.
 */
export function RepoSettings({
  repos, sources, onChanged, onClose,
}: {
  repos: AppRepo[];
  sources: RepoSourceStatus[];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const push = useNotifications((s) => s.push);
  const [draft, setDraft] = useState<AppRepo[]>(repos);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusFor = (r: AppRepo) => sources.find((s) => s.url === r.url);

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setDraft(next);
  }

  function add() {
    const url = adding.trim().replace(/\/+$/, "");
    if (!url) return;
    if (draft.some((r) => r.url === url)) { setError("That repository is already in the list."); return; }
    setDraft([...draft, { id: "", url, name: "", enabled: true }]);
    setAdding("");
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put<RepoConfigResponse>("/apps/repo", {
        repos: draft.map((r) => ({ url: r.url, name: r.name, enabled: r.enabled })),
      });
      push({ level: "success", title: "Repositories updated" });
      await onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save the repository list.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 rounded-xl bg-white p-3.5 ring-1 ring-slate-200">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
          <Store size={15} /> App repositories
        </h4>
        <button onClick={onClose} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint hover:bg-slate-100">
          <X size={15} />
        </button>
      </div>
      <p className="mb-3 text-xs text-ink-faint">
        Checked in order. If two repositories publish the same app, the one higher up wins - and an app is only ever
        updated from the repository it was installed from.
      </p>

      <div className="space-y-1.5">
        {draft.map((r, i) => {
          const st = statusFor(r);
          return (
            <div key={r.url} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
              <div className="flex flex-col">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"
                        className="text-ink-faint transition hover:text-ink-soft disabled:opacity-25">
                  <ArrowUp size={12} />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Move down"
                        className="text-ink-faint transition hover:text-ink-soft disabled:opacity-25">
                  <ArrowDown size={12} />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink-soft">{r.name || st?.name || new URL(r.url).host}</span>
                  {i === 0 && r.enabled && <span className="rounded-full bg-brand-100 px-1.5 text-[10px] text-brand-700">primary</span>}
                  {st && !st.reachable && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 text-[10px] text-rose-700 ring-1 ring-rose-200">
                      <AlertTriangle size={9} /> unreachable
                    </span>
                  )}
                  {st?.reachable && (
                    <span className="text-[10px] text-ink-faint">
                      {st.appCount} app{st.appCount === 1 ? "" : "s"}
                      {st.shadowed > 0 ? ` - ${st.shadowed} hidden by a higher repo` : ""}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-ink-faint">{r.url}</div>
              </div>
              <Toggle
                checked={r.enabled}
                onChange={(v) => setDraft(draft.map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
                label={`Enable ${r.url}`}
              />
              <button
                aria-label={`Remove ${r.url}`}
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex gap-2">
        <Input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="https://repo.example.com"
          className="h-8 text-xs"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <Button variant="secondary" className="h-8 shrink-0 px-2.5 text-xs" onClick={add} disabled={!adding.trim()}>
          <Plus size={13} /> Add
        </Button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      <div className="mt-3 flex gap-2">
        <Button className="h-8 px-3 text-xs" loading={busy} onClick={save} disabled={draft.length === 0}>
          <Check size={13} /> Save
        </Button>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
