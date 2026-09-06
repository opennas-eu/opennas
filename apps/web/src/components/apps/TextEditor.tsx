import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import { ArrowUp, File as FileIcon, FolderOpen, RefreshCw, Save } from "lucide-react";
import type { FileListResponse } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { Button } from "../ui/controls.tsx";

export function TextEditor() {
  const [path, setPath] = useState("/");
  const [listing, setListing] = useState<FileListResponse | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const push = useNotifications((s) => s.push);

  const dirty = current !== null && content !== original;
  const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";

  const loadDir = useCallback(async (p: string) => {
    try {
      const res = await api.get<FileListResponse>(`/files/list?path=${encodeURIComponent(p)}`);
      setListing(res);
      setPath(res.path);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { void loadDir("/"); }, [loadDir]);

  async function openFile(name: string) {
    if (dirty && !(await confirmDialog({
      title: "Discard unsaved changes?",
      message: "Your current edits will be lost.",
      confirmLabel: "Discard",
      danger: true,
    }))) return;
    const filePath = path === "/" ? `/${name}` : `${path}/${name}`;
    setLoadingFile(true);
    try {
      const res = await fetch(apiUrl(`/files/raw?path=${encodeURIComponent(filePath)}`), { credentials: "include" });
      if (!res.ok) throw new Error("Could not open file.");
      const text = await res.text();
      setContent(text);
      setOriginal(text);
      setCurrent(filePath);
    } catch (err) {
      push({ level: "warning", title: "Couldn't open file", body: err instanceof Error ? err.message : "Failed." });
    } finally {
      setLoadingFile(false);
    }
  }

  async function save() {
    if (!current) return;
    setSaving(true);
    try {
      await api.put("/files/write", { path: current, content });
      setOriginal(content);
      push({ level: "success", title: "Saved", body: current });
    } catch (err) {
      push({ level: "warning", title: "Save failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (dirty) void save();
    }
  }

  return (
    <div className="flex h-full bg-white">
      {/* File picker */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
        <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-2">
          <button onClick={() => parent && loadDir(parent)} disabled={!parent} className="grid h-7 w-7 place-items-center rounded text-ink-soft hover:bg-slate-200 disabled:opacity-40" title="Up">
            <ArrowUp size={15} />
          </button>
          <span className="flex-1 truncate text-xs text-ink-faint" title={path}>{path}</span>
          <button onClick={() => loadDir(path)} className="grid h-7 w-7 place-items-center rounded text-ink-soft hover:bg-slate-200" title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-1">
          {listing?.entries.map((e) => (
            <button
              key={e.name}
              onClick={() => (e.type === "dir" ? loadDir(path === "/" ? `/${e.name}` : `${path}/${e.name}`) : openFile(e.name))}
              className={clsx(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-slate-200/60",
                current === (path === "/" ? `/${e.name}` : `${path}/${e.name}`) && "bg-brand-100 text-brand-700",
              )}
            >
              {e.type === "dir" ? <FolderOpen size={15} className="shrink-0 text-sky-500" /> : <FileIcon size={15} className="shrink-0 text-slate-400" />}
              <span className="truncate">{e.name}</span>
            </button>
          ))}
          {listing?.entries.length === 0 && <p className="px-2 py-3 text-xs text-ink-faint">Empty folder.</p>}
        </div>
      </aside>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
          <span className="truncate text-sm font-medium text-ink-soft">
            {current ?? "No file open"}
            {dirty && <span className="ml-1 text-amber-500">●</span>}
          </span>
          <Button className="ml-auto h-8 px-3 py-0 text-xs" disabled={!dirty} loading={saving} onClick={save}>
            <Save size={14} /> Save
          </Button>
        </div>
        {current ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            className="opennas-scroll min-h-0 flex-1 resize-none bg-white p-4 font-mono text-sm text-ink outline-none"
            placeholder="Empty file"
          />
        ) : (
          <div className="grid flex-1 place-items-center text-center text-sm text-ink-faint">
            <div>
              <FolderOpen size={28} className="mx-auto mb-2 text-slate-300" />
              {loadingFile ? "Opening..." : "Select a file to edit"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
