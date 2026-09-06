import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { CornerDownLeft, FileText, Folder, Search, Settings2, SlidersHorizontal } from "lucide-react";
import type { FileSearchHit, FileSearchResponse } from "@opennas/shared";
import { api } from "../../lib/api.ts";
import { useApps } from "../../store/apps.ts";
import { useAuth } from "../../store/auth.ts";
import { useWindows } from "../../store/windows.ts";
import { useIntents } from "../../store/intents.ts";
import { SETTINGS_INDEX } from "../../lib/settings-index.ts";
import { AppIcon } from "../ui/Icon.tsx";
import { formatBytes } from "../../lib/format.ts";

/**
 * Search across apps, settings and files.
 *
 * Apps and settings resolve instantly from data already in the browser; files
 * need the server, so that half is debounced and arrives late. Results render
 * as soon as the local half is ready rather than waiting for the round trip -
 * typing "stor" should show the Storage panel immediately, not after a walk of
 * the shares finishes.
 */

type Result =
  | { kind: "app"; id: string; title: string; subtitle: string; appId: string }
  | { kind: "setting"; id: string; title: string; subtitle: string; section: string }
  | { kind: "file"; id: string; title: string; subtitle: string; hit: FileSearchHit };

const GROUP_LABEL: Record<Result["kind"], string> = {
  app: "Apps",
  setting: "Settings",
  file: "Files",
};

export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const apps = useApps((s) => s.apps);
  const isAdmin = useAuth((s) => s.session?.user.role === "admin");
  const openApp = useWindows((s) => s.openApp);
  const setIntent = useIntents((s) => s.set);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // File search is the only part that costs a round trip, so it waits for a
  // pause in typing and for enough characters to be worth walking the tree.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setFiles(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      void api
        .get<FileSearchResponse>(`/files/search?q=${encodeURIComponent(q)}`)
        .then(setFiles)
        .catch(() => setFiles(null))
        .finally(() => setSearching(false));
    }, 220);
    return () => { clearTimeout(t); setSearching(false); };
  }, [query]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Result[] = [];

    for (const app of apps) {
      const haystack = `${app.name} ${app.description} ${app.category}`.toLowerCase();
      if (haystack.includes(q)) {
        out.push({ kind: "app", id: `app:${app.id}`, title: app.name, subtitle: app.description || "App", appId: app.id });
      }
    }
    for (const entry of SETTINGS_INDEX) {
      if (entry.adminOnly && !isAdmin) continue;
      const haystack = `${entry.label} ${entry.description} ${entry.keywords.join(" ")}`.toLowerCase();
      if (haystack.includes(q)) {
        out.push({ kind: "setting", id: `set:${entry.section}`, title: entry.label, subtitle: entry.description, section: entry.section });
      }
    }
    for (const hit of files?.hits ?? []) {
      out.push({
        kind: "file",
        id: `file:${hit.path}`,
        title: hit.name,
        subtitle: hit.type === "dir" ? hit.parent : `${hit.parent} - ${formatBytes(hit.sizeBytes)}`,
        hit,
      });
    }
    return out;
  }, [query, apps, isAdmin, files]);

  // Any change to the result set invalidates the highlighted row.
  useEffect(() => { setActive(0); }, [query, files]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(result: Result) {
    if (result.kind === "app") {
      const app = apps.find((a) => a.id === result.appId);
      if (app) openApp(app);
    } else if (result.kind === "setting") {
      const panel = apps.find((a) => a.id === "control-panel");
      if (panel) {
        // Leave the destination behind for Control Panel to claim on mount.
        setIntent("control-panel", result.section);
        openApp(panel);
      }
    } else {
      const files = apps.find((a) => a.id === "file-station");
      if (files) {
        setIntent("file-station", result.hit.type === "dir" ? result.hit.path : result.hit.parent);
        openApp(files);
      }
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[active]; if (r) run(r); }
  }

  let lastKind: Result["kind"] | null = null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex justify-center bg-slate-950/40 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4">
          <Search size={18} className="shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps, settings and files..."
            className="h-14 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-slate-400"
            aria-label="Search"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-ink-faint sm:block">Esc</kbd>
        </div>

        <div ref={listRef} className="opennas-scroll min-h-0 flex-1 overflow-auto py-1">
          {query.trim() === "" ? (
            <p className="px-4 py-8 text-center text-sm text-ink-faint">
              Start typing to find an app, a setting or a file.
            </p>
          ) : results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-faint">
              {searching ? "Searching..." : "Nothing matches."}
            </p>
          ) : (
            results.map((r, i) => {
              const header = r.kind !== lastKind ? GROUP_LABEL[r.kind] : null;
              lastKind = r.kind;
              const app = r.kind === "app" ? apps.find((a) => a.id === r.appId) : undefined;
              return (
                <div key={r.id}>
                  {header && (
                    <div className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                      {header}
                    </div>
                  )}
                  <button
                    data-active={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => run(r)}
                    className={clsx(
                      "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                      i === active ? "bg-brand-50" : "hover:bg-slate-50",
                    )}
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-ink-soft">
                      {r.kind === "app" ? (
                        app ? <AppIcon app={app} className="h-4 w-4" /> : <SlidersHorizontal size={16} />
                      ) : r.kind === "setting" ? (
                        <SlidersHorizontal size={16} />
                      ) : r.hit.type === "dir" ? (
                        <Folder size={16} />
                      ) : (
                        <FileText size={16} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-soft">{r.title}</span>
                      <span className="block truncate text-xs text-ink-faint">{r.subtitle}</span>
                    </span>
                    {i === active && <CornerDownLeft size={14} className="shrink-0 text-ink-faint" />}
                  </button>
                </div>
              );
            })
          )}

          {files?.truncated && (
            <p className="px-4 py-2 text-center text-[11px] text-ink-faint">
              Showing the first matches. Refine your search to find other results.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-2 text-[11px] text-ink-faint">
          <span className="flex items-center gap-1"><Settings2 size={12} /> ↑↓ to move</span>
          <span className="flex items-center gap-1"><CornerDownLeft size={12} /> to open</span>
          {searching && <span className="ml-auto">Searching files...</span>}
        </div>
      </div>
    </div>
  );
}
