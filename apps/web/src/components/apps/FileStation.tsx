import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  Archive,
  ArrowLeft,
  ArrowUp,
  Check,
  PackageOpen,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FilePlus,
  FileText,
  FileVideo,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Link2,
  List as ListIcon,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { FileEntry, FileInfoResponse, FileListResponse } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { useIntents } from "../../store/intents.ts";
import { confirmDialog, promptDialog } from "../../store/dialogs.ts";
import { formatBytes, formatRelative } from "../../lib/format.ts";
import { Button, Input } from "../ui/controls.tsx";
import { ContextMenu, type MenuItem } from "./ContextMenu.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { RecycleBin } from "./RecycleBin.tsx";
import { ShareLinkDialog, ShareLinksManager } from "./ShareLinks.tsx";

type SortKey = "name" | "size" | "modified";
type ClipKind = "copy" | "cut";

function isPreviewable(e: FileEntry): boolean {
  if (e.type === "dir") return false;
  const m = e.mime ?? "";
  const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase();
  return (
    (m.startsWith("image/") && m !== "image/svg+xml") ||
    m.startsWith("video/") ||
    m.startsWith("audio/") ||
    m === "application/pdf" ||
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    [".docx", ".csv", ".tsv", ".md", ".log", ".yml", ".yaml", ".json", ".ts", ".tsx", ".js", ".jsx", ".css", ".py", ".sh"].includes(ext)
  );
}

export function FileStation() {
  const [path, setPath] = useState(() => useIntents.getState().take("file-station") ?? "/");
  const [listing, setListing] = useState<FileListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "grid">("list");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [clip, setClip] = useState<{ kind: ClipKind; dir: string; names: string[] } | null>(null);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [previewEdit, setPreviewEdit] = useState(false);
  const [propsFor, setPropsFor] = useState<FileEntry | null>(null);
  const [shareEntry, setShareEntry] = useState<FileEntry | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<FileListResponse>(`/files/list?path=${encodeURIComponent(p)}`);
      setListing(res);
      setPath(res.path);
      setSelected(new Set());
      setAnchor(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not open folder.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load("/"); }, [load]);

  const writable = listing?.writable ?? false;
  const join = (name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);
  const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";

  // Filter (search) + sort. Folders always group first.
  const displayed = useMemo(() => {
    const all = listing?.entries ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
    const dir = sortAsc ? 1 : -1;
    const cmp = (a: FileEntry, b: FileEntry) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1; // folders first, regardless of dir
      let r = 0;
      if (sortKey === "name") r = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      else if (sortKey === "size") r = a.sizeBytes - b.sizeBytes;
      else r = a.modifiedAt.localeCompare(b.modifiedAt);
      return r * dir;
    };
    return [...filtered].sort(cmp);
  }, [listing, query, sortKey, sortAsc]);

  const fileEntries = useMemo(() => displayed.filter((e) => e.type === "file"), [displayed]);
  const selectedEntries = displayed.filter((e) => selected.has(e.name));

  function openPreview(e: FileEntry, edit = false) {
    setPreviewEdit(edit);
    setPreview(e);
  }

  function openEntry(e: FileEntry) {
    if (e.type === "dir") void load(join(e.name));
    else if (isPreviewable(e)) openPreview(e);
    else window.open(apiUrl(`/files/download?path=${encodeURIComponent(join(e.name))}`), "_blank", "noopener");
  }

  function clickEntry(e: FileEntry, ev: React.MouseEvent) {
    if (ev.shiftKey && anchor) {
      const names = displayed.map((x) => x.name);
      const a = names.indexOf(anchor);
      const b = names.indexOf(e.name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(names.slice(lo, hi + 1)));
        return;
      }
    }
    if (ev.ctrlKey || ev.metaKey) {
      setSelected((s) => {
        const next = new Set(s);
        next.has(e.name) ? next.delete(e.name) : next.add(e.name);
        return next;
      });
      setAnchor(e.name);
      return;
    }
    setSelected(new Set([e.name]));
    setAnchor(e.name);
  }

  function onRowContext(e: FileEntry, ev: React.MouseEvent) {
    ev.preventDefault();
    if (!selected.has(e.name)) {
      setSelected(new Set([e.name]));
      setAnchor(e.name);
    }
    setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
  }

  function onBackgroundContext(ev: React.MouseEvent) {
    ev.preventDefault();
    setMenu({ x: ev.clientX, y: ev.clientY, entry: null });
  }

  async function createFolder() {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.post("/files/mkdir", { path, name });
      setNewName("");
      setCreating(false);
      await load(path);
    } catch (err) {
      push({ level: "warning", title: "Couldn't create folder", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function createTextFile() {
    const raw = await promptDialog({
      title: "New text file",
      message: "Create an empty text file and open it for editing.",
      confirmLabel: "Create",
      defaultValue: "untitled.txt",
      placeholder: "untitled.txt",
    });
    const base = raw?.trim();
    if (!base) return;
    // Default to a .txt extension when none was given.
    let name = /\.[^./\\]+$/.test(base) ? base : `${base}.txt`;
    // Avoid clobbering an existing file - /files/write overwrites in place.
    const existing = new Set((listing?.entries ?? []).map((e) => e.name));
    if (existing.has(name)) {
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
      const stem = ext ? name.slice(0, -ext.length) : name;
      let i = 2;
      while (existing.has(`${stem} (${i})${ext}`)) i++;
      name = `${stem} (${i})${ext}`;
    }
    try {
      await api.put("/files/write", { path: join(name), content: "" });
      await load(path);
      openPreview({ name, type: "file", sizeBytes: 0, modifiedAt: new Date().toISOString(), mime: null }, true);
    } catch (err) {
      push({ level: "warning", title: "Couldn't create file", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  function startRename(e: FileEntry) {
    setRenaming(e.name);
    setRenameValue(e.name);
  }

  async function commitRename() {
    const from = renaming;
    const next = renameValue.trim();
    setRenaming(null);
    if (!from || !next || next === from) return;
    try {
      await api.post("/files/rename", { path: join(from), newName: next });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: "Rename failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function deleteEntries(entries: FileEntry[]) {
    if (entries.length === 0) return;
    const ok = await confirmDialog({
      title: entries.length === 1 ? `Delete "${entries[0]!.name}"?` : `Delete ${entries.length} items?`,
      message: "Moved to the Recycle Bin - you can restore it from there.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const e of entries) {
      try {
        await api.del(`/files?path=${encodeURIComponent(join(e.name))}`);
      } catch {
        failed++;
      }
    }
    if (failed) push({ level: "warning", title: "Some items couldn't be deleted", body: `${failed} failed.` });
    await load(path);
  }

  function copySelection(kind: ClipKind, entries: FileEntry[]) {
    if (entries.length === 0) return;
    setClip({ kind, dir: path, names: entries.map((e) => e.name) });
    push({ level: "info", title: kind === "copy" ? "Copied" : "Cut", body: `${entries.length} item${entries.length > 1 ? "s" : ""} ready to paste.` });
  }

  async function paste() {
    if (!clip) return;
    const endpoint = clip.kind === "copy" ? "/files/copy" : "/files/move";
    let failed = 0;
    for (const name of clip.names) {
      const src = clip.dir === "/" ? `/${name}` : `${clip.dir}/${name}`;
      try {
        await api.post(endpoint, { path: src, toDir: path });
      } catch {
        failed++;
      }
    }
    if (clip.kind === "cut") setClip(null);
    if (failed) push({ level: "warning", title: "Some items couldn't be pasted", body: `${failed} failed (name clash or permissions).` });
    else push({ level: "success", title: clip.kind === "copy" ? "Copied here" : "Moved here", body: `${clip.names.length} item${clip.names.length > 1 ? "s" : ""}.` });
    await load(path);
  }

  function downloadEntries(entries: FileEntry[]) {
    const files = entries.filter((e) => e.type === "file");
    if (files.length === 0) {
      push({ level: "info", title: "Nothing to download", body: "For folders, use 'Download as ZIP'." });
      return;
    }
    for (const e of files) window.open(apiUrl(`/files/download?path=${encodeURIComponent(join(e.name))}`), "_blank");
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(files.length);
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    try {
      const res = await fetch(apiUrl(`/files/upload?path=${encodeURIComponent(path)}`), { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Upload failed.");
      }
      push({ level: "success", title: "Upload complete", body: `${files.length} item${files.length > 1 ? "s" : ""} uploaded to ${path}.` });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: "Upload failed", body: err instanceof Error ? err.message : "Failed." });
    } finally {
      setUploading(0);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void uploadFiles(files);
  }

  // ---- Archives -------------------------------------------------------
  function downloadFolderZip(e: FileEntry) {
    window.open(apiUrl(`/files/zip?path=${encodeURIComponent(join(e.name))}`), "_blank");
  }

  async function compressSelection(entries: FileEntry[]) {
    if (entries.length === 0) return;
    const def = entries.length === 1 ? entries[0]!.name.replace(/\.[^.]+$/, "") : "archive";
    const name = await promptDialog({
      title: "Compress to ZIP",
      message: `Create a .zip from ${entries.length} item${entries.length > 1 ? "s" : ""}.`,
      confirmLabel: "Compress",
      defaultValue: def,
      placeholder: "archive",
    });
    if (!name) return;
    try {
      await api.post("/files/compress", { dir: path, names: entries.map((e) => e.name), name });
      push({ level: "success", title: "Compressed", body: `${name.replace(/\.zip$/i, "")}.zip created.` });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: "Couldn't compress", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  async function extractEntry(e: FileEntry) {
    try {
      const res = await api.post<{ path: string }>("/files/extract", { path: join(e.name) });
      push({ level: "success", title: "Extracted", body: `"${e.name}" unpacked to ${res.path.split("/").pop()}.` });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: "Couldn't extract", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  // ---- Drag & drop move/copy between folders --------------------------
  function startDrag(e: FileEntry, ev: React.DragEvent) {
    const names = selected.has(e.name) ? [...selected] : [e.name];
    if (!selected.has(e.name)) setSelected(new Set([e.name]));
    setDragging(names);
    ev.dataTransfer.setData("application/x-opennas", "1");
    ev.dataTransfer.effectAllowed = "copyMove";
  }

  function onFolderDragOver(folder: FileEntry, ev: React.DragEvent) {
    if (!dragging || dragging.includes(folder.name)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = ev.ctrlKey || ev.altKey ? "copy" : "move";
    if (dropDir !== folder.name) setDropDir(folder.name);
  }

  async function onFolderDrop(folder: FileEntry, ev: React.DragEvent) {
    if (!dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    const names = dragging.filter((n) => n !== folder.name);
    const op: ClipKind = ev.ctrlKey || ev.altKey ? "copy" : "cut";
    setDragging(null);
    setDropDir(null);
    if (names.length === 0) return;
    let failed = 0;
    for (const n of names) {
      try {
        await api.post(op === "copy" ? "/files/copy" : "/files/move", { path: join(n), toDir: join(folder.name) });
      } catch {
        failed++;
      }
    }
    if (failed) push({ level: "warning", title: `Some items couldn't be ${op === "copy" ? "copied" : "moved"}`, body: `${failed} failed.` });
    else push({ level: "success", title: op === "copy" ? "Copied" : "Moved", body: `${names.length} item${names.length > 1 ? "s" : ""} into "${folder.name}".` });
    await load(path);
  }

  const isInternalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-opennas");

  function buildMenuItems(): MenuItem[] {
    const sel = selectedEntries;
    if (menu?.entry) {
      const e = menu.entry;
      const multi = sel.length > 1;
      const items: MenuItem[] = [];
      if (e.type === "dir") items.push({ label: "Open", icon: <FolderOpen size={15} />, onClick: () => openEntry(e) });
      else if (isPreviewable(e)) items.push({ label: "Preview", icon: <Eye size={15} />, onClick: () => openPreview(e) });
      if (sel.some((x) => x.type === "file")) {
        items.push({ label: multi ? "Download files" : "Download", icon: <Download size={15} />, onClick: () => downloadEntries(sel) });
      }
      if (!multi && e.type === "dir") {
        items.push({ label: "Download as ZIP", icon: <Download size={15} />, onClick: () => downloadFolderZip(e) });
      }
      if (!multi && e.type === "file" && /\.zip$/i.test(e.name) && writable) {
        items.push({ label: "Extract here", icon: <PackageOpen size={15} />, onClick: () => void extractEntry(e) });
      }
      if (writable) items.push({ label: multi ? `Compress ${sel.length} items` : "Compress to ZIP", icon: <Archive size={15} />, onClick: () => void compressSelection(sel) });
      items.push({ label: "Copy", icon: <Copy size={15} />, onClick: () => copySelection("copy", sel), separator: true });
      if (writable) items.push({ label: "Cut", icon: <Scissors size={15} />, onClick: () => copySelection("cut", sel) });
      if (writable && !multi) items.push({ label: "Rename", icon: <Pencil size={15} />, onClick: () => startRename(e) });
      if (!multi) items.push({ label: "Share link...", icon: <Link2 size={15} />, onClick: () => setShareEntry(e), separator: true });
      items.push({ label: "Properties", icon: <Info size={15} />, onClick: () => setPropsFor(e), separator: !multi ? false : true });
      if (writable) items.push({ label: multi ? `Delete ${sel.length} items` : "Delete", icon: <Trash2 size={15} />, danger: true, onClick: () => deleteEntries(sel), separator: true });
      return items;
    }
    // Background menu
    return [
      { label: "Paste", icon: <ClipboardPaste size={15} />, disabled: !clip || !writable, onClick: () => void paste() },
      { label: "New folder", icon: <FolderPlus size={15} />, disabled: !writable, onClick: () => setCreating(true), separator: true },
      { label: "New text file", icon: <FilePlus size={15} />, disabled: !writable, onClick: () => void createTextFile() },
      { label: "Upload files", icon: <Upload size={15} />, disabled: !writable, onClick: () => fileInput.current?.click() },
      { label: "Select all", icon: <Check size={15} />, onClick: () => setSelected(new Set(displayed.map((e) => e.name))), separator: true },
      { label: "Refresh", icon: <RefreshCw size={15} />, onClick: () => void load(path) },
    ];
  }

  const segments = path === "/" ? [] : path.split("/").filter(Boolean);

  return (
    <div
      className="relative flex h-full flex-col bg-white"
      onDragOver={(e) => { e.preventDefault(); if (!isInternalDrag(e)) setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { if (isInternalDrag(e)) { e.preventDefault(); setDragging(null); setDropDir(null); return; } onDrop(e); }}
    >
      {/* Toolbar */}
      <header className="flex items-center gap-1.5 border-b border-slate-200 px-3 py-2">
        <button onClick={() => parent && load(parent)} disabled={!parent} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title="Back">
          <ArrowLeft size={16} />
        </button>
        <button onClick={() => parent && load(parent)} disabled={!parent} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title="Up one level">
          <ArrowUp size={16} />
        </button>

        {/* Breadcrumb */}
        <nav className="opennas-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-1 text-sm">
          <Crumb onClick={() => load("/")} label="Shared Folders" active={path === "/"} />
          {segments.map((seg, i) => {
            const p = "/" + segments.slice(0, i + 1).join("/");
            return (
              <span key={p} className="flex items-center gap-0.5">
                <span className="text-slate-300">/</span>
                <Crumb onClick={() => load(p)} label={seg} active={i === segments.length - 1} />
              </span>
            );
          })}
        </nav>

        {/* Search */}
        <div className="relative hidden items-center sm:flex">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="h-8 w-36 rounded-lg bg-slate-100 pl-8 pr-2 text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-1.5 grid h-5 w-5 place-items-center rounded text-slate-400 hover:text-ink-soft" title="Clear">
              <X size={13} />
            </button>
          )}
        </div>

        <button onClick={() => setView((v) => (v === "list" ? "grid" : "list"))} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title={view === "list" ? "Grid view" : "List view"}>
          {view === "list" ? <LayoutGrid size={16} /> : <ListIcon size={16} />}
        </button>
        <button onClick={() => load(path)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Refresh">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
        <button onClick={() => setShowLinks(true)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Shared links">
          <Link2 size={16} />
        </button>
        <button onClick={() => setShowTrash(true)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title="Recycle Bin">
          <Trash2 size={16} />
        </button>
        {clip && (
          <button onClick={() => void paste()} disabled={!writable} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title={`Paste ${clip.names.length} item(s)`}>
            <ClipboardPaste size={16} /> <span className="hidden sm:inline">Paste</span>
          </button>
        )}
        <button onClick={() => setCreating((c) => !c)} disabled={!writable} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title="New folder">
          <FolderPlus size={16} /> <span className="hidden sm:inline">New</span>
        </button>
        <Button className="h-8 px-3 py-0 text-xs" onClick={() => fileInput.current?.click()} loading={uploading > 0} disabled={!writable}>
          <Upload size={15} /> Upload
        </Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void uploadFiles(Array.from(e.target.files)); e.target.value = ""; }} />
      </header>

      {creating && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
          <FolderPlus size={16} className="text-brand-500" />
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); if (e.key === "Escape") setCreating(false); }}
            placeholder="Folder name"
            className="h-8 max-w-xs py-0 text-sm"
          />
          <Button className="h-8 px-3 py-0 text-xs" onClick={createFolder}>Create</Button>
          <Button variant="ghost" className="h-8 px-2 py-0 text-xs" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      )}

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-brand-100 bg-brand-50/60 px-4 py-1.5 text-xs">
          <span className="font-medium text-brand-700">{selected.size} selected</span>
          <span className="flex-1" />
          <BarBtn onClick={() => downloadEntries(selectedEntries)}><Download size={13} /> Download</BarBtn>
          <BarBtn onClick={() => copySelection("copy", selectedEntries)}><Copy size={13} /> Copy</BarBtn>
          {writable && <BarBtn onClick={() => copySelection("cut", selectedEntries)}><Scissors size={13} /> Cut</BarBtn>}
          {writable && <BarBtn danger onClick={() => deleteEntries(selectedEntries)}><Trash2 size={13} /> Delete</BarBtn>}
          <BarBtn onClick={() => setSelected(new Set())}><X size={13} /> Clear</BarBtn>
        </div>
      )}

      {/* Listing */}
      <div className="opennas-scroll min-h-0 flex-1 overflow-auto" onContextMenu={onBackgroundContext} onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(new Set()); }}>
        {error ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-rose-600">{error}</div>
        ) : displayed.length === 0 && !loading ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="text-ink-faint">
              <FolderPlus size={32} className="mx-auto mb-2 text-slate-300" />
              <p className="text-sm">{query ? "No matches." : path === "/" ? "No shared folders yet." : "This folder is empty."}</p>
              {!query && (
                <p className="text-xs">
                  {path === "/" ? "Create one in Control Panel → Shared Folders." : "Drag files here or use the Upload button."}
                </p>
              )}
            </div>
          </div>
        ) : view === "list" ? (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-xs text-ink-faint shadow-[0_1px_0_rgb(0_0_0/0.06)]">
              <tr>
                <SortHead label="Name" col="name" sortKey={sortKey} sortAsc={sortAsc} onSort={setSort} className="px-4 py-2" />
                <SortHead label="Size" col="size" sortKey={sortKey} sortAsc={sortAsc} onSort={setSort} className="w-28 px-3 py-2 text-right" align="right" />
                <SortHead label="Modified" col="modified" sortKey={sortKey} sortAsc={sortAsc} onSort={setSort} className="hidden w-40 px-3 py-2 sm:table-cell" />
                <th className="w-24 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((e) => {
                const isSel = selected.has(e.name);
                const cut = clip?.kind === "cut" && clip.dir === path && clip.names.includes(e.name);
                return (
                  <tr
                    key={e.name}
                    draggable={renaming !== e.name}
                    onDragStart={(ev) => startDrag(e, ev)}
                    onDragEnd={() => { setDragging(null); setDropDir(null); }}
                    onClick={(ev) => renaming !== e.name && clickEntry(e, ev)}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={(ev) => { ev.stopPropagation(); onRowContext(e, ev); }}
                    {...(e.type === "dir" ? { onDragOver: (ev: React.DragEvent) => onFolderDragOver(e, ev), onDragLeave: () => setDropDir((d) => (d === e.name ? null : d)), onDrop: (ev: React.DragEvent) => void onFolderDrop(e, ev) } : {})}
                    className={clsx("group cursor-default border-b border-slate-50", dropDir === e.name ? "bg-brand-100 ring-1 ring-inset ring-brand-400" : isSel ? "bg-brand-50" : "hover:bg-slate-50/70", cut && "opacity-50")}
                  >
                    <td className="px-4 py-2">
                      {renaming === e.name ? (
                        <div className="flex min-w-0 items-center gap-2.5">
                          <EntryIcon entry={e} />
                          <Input
                            autoFocus
                            value={renameValue}
                            onChange={(ev) => setRenameValue(ev.target.value)}
                            onKeyDown={(ev) => { if (ev.key === "Enter") void commitRename(); if (ev.key === "Escape") setRenaming(null); }}
                            onFocus={(ev) => ev.target.select()}
                            onBlur={() => void commitRename()}
                            className="h-7 max-w-xs py-0 text-sm"
                          />
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-center gap-2.5" title={e.name}>
                          <EntryIcon entry={e} />
                          <span className="truncate font-medium text-ink-soft group-hover:text-ink">{e.name}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-faint">{e.type === "dir" ? "-" : formatBytes(e.sizeBytes)}</td>
                    <td className="hidden px-3 py-2 text-ink-faint sm:table-cell">{formatRelative(e.modifiedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
                        {e.type === "file" && (
                          <RowBtn label="Download" onClick={(ev) => { ev.stopPropagation(); window.open(apiUrl(`/files/download?path=${encodeURIComponent(join(e.name))}`), "_blank"); }}>
                            <Download size={15} />
                          </RowBtn>
                        )}
                        <RowBtn label="More" onClick={(ev) => { ev.stopPropagation(); if (!selected.has(e.name)) setSelected(new Set([e.name])); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}>
                          <Info size={15} />
                        </RowBtn>
                        {writable && (
                          <RowBtn label="Delete" danger onClick={(ev) => { ev.stopPropagation(); void deleteEntries([e]); }}>
                            <Trash2 size={15} />
                          </RowBtn>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-2 p-3">
            {displayed.map((e) => {
              const isSel = selected.has(e.name);
              const cut = clip?.kind === "cut" && clip.dir === path && clip.names.includes(e.name);
              return (
                <button
                  key={e.name}
                  draggable
                  onDragStart={(ev) => startDrag(e, ev)}
                  onDragEnd={() => { setDragging(null); setDropDir(null); }}
                  onClick={(ev) => clickEntry(e, ev)}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={(ev) => { ev.stopPropagation(); onRowContext(e, ev); }}
                  {...(e.type === "dir" ? { onDragOver: (ev: React.DragEvent) => onFolderDragOver(e, ev), onDragLeave: () => setDropDir((d) => (d === e.name ? null : d)), onDrop: (ev: React.DragEvent) => void onFolderDrop(e, ev) } : {})}
                  title={e.name}
                  className={clsx("flex flex-col items-center gap-1.5 rounded-xl p-2.5 text-center transition", dropDir === e.name ? "bg-brand-100 ring-1 ring-brand-400" : isSel ? "bg-brand-50 ring-1 ring-brand-300" : "hover:bg-slate-100", cut && "opacity-50")}
                >
                  <GridThumb entry={e} dir={path} />
                  <span className="line-clamp-2 w-full break-words text-xs font-medium text-ink-soft">{e.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-slate-200 px-4 py-1.5 text-xs text-ink-faint">
        <span>
          {listing ? `${displayed.length} item${displayed.length === 1 ? "" : "s"}` : "..."}
          {query && listing ? ` (filtered from ${listing.entries.length})` : ""}
          {!writable && listing ? " - read-only" : ""}
        </span>
        {uploading > 0 && <span className="text-brand-600">Uploading {uploading}...</span>}
      </footer>

      {/* Drag-drop overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 m-2 grid place-items-center rounded-xl border-2 border-dashed border-brand-400 bg-brand-50/80 backdrop-blur-sm">
          <div className="text-center text-brand-700">
            <Upload size={32} className="mx-auto mb-2" />
            <p className="font-semibold">Drop to upload</p>
            <p className="text-sm">to {path}</p>
          </div>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenuItems()} onClose={() => setMenu(null)} />}
      {preview && (
        <FilePreview
          dir={path}
          entry={preview}
          files={fileEntries}
          writable={writable}
          startEditing={previewEdit}
          onNavigate={(e) => { setPreviewEdit(false); setPreview(e); }}
          onRenamed={(updated) => { setPreview(updated); void load(path); }}
          onSaved={() => void load(path)}
          onClose={() => { setPreview(null); setPreviewEdit(false); }}
        />
      )}
      {propsFor && <PropertiesPanel dir={path} entry={propsFor} onClose={() => setPropsFor(null)} />}
      {shareEntry && <ShareLinkDialog dir={path} entry={shareEntry} onClose={() => setShareEntry(null)} />}
      {showLinks && <ShareLinksManager onClose={() => setShowLinks(false)} />}
      {showTrash && <RecycleBin onClose={() => setShowTrash(false)} onChanged={() => load(path)} />}
    </div>
  );

  function setSort(col: SortKey) {
    if (sortKey === col) setSortAsc((a) => !a);
    else { setSortKey(col); setSortAsc(true); }
  }
}

function Crumb({ label, onClick, active }: { label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} className={clsx("rounded px-1.5 py-0.5 transition hover:bg-slate-100", active ? "font-semibold text-ink" : "text-ink-soft")}>
      {label}
    </button>
  );
}

function SortHead({ label, col, sortKey, sortAsc, onSort, className, align }: { label: string; col: SortKey; sortKey: SortKey; sortAsc: boolean; onSort: (c: SortKey) => void; className?: string; align?: "right" }) {
  const active = sortKey === col;
  return (
    <th className={clsx(className, "font-medium")}>
      <button onClick={() => onSort(col)} className={clsx("inline-flex items-center gap-1 hover:text-ink-soft", align === "right" && "flex-row-reverse")}>
        {label}
        {active && (sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
    </th>
  );
}

function BarBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx("flex items-center gap-1 rounded-md px-2 py-1 font-medium transition", danger ? "text-rose-600 hover:bg-rose-100" : "text-ink-soft hover:bg-white")}>
      {children}
    </button>
  );
}

function RowBtn({ children, onClick, label, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; label: string; danger?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={clsx("grid h-7 w-7 place-items-center rounded-md text-slate-400 transition", danger ? "hover:bg-rose-500 hover:text-white" : "hover:bg-slate-200 hover:text-ink-soft")}>
      {children}
    </button>
  );
}

function GridThumb({ entry, dir }: { entry: FileEntry; dir: string }) {
  const isImage = entry.type === "file" && (entry.mime?.startsWith("image/") ?? false) && entry.mime !== "image/svg+xml";
  // Fall back to the generic icon if the server can't thumbnail this image
  // (e.g. an exotic format sharp can't decode) - no broken-image tile.
  const [failed, setFailed] = useState(false);
  if (isImage && !failed) {
    const p = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
    return (
      <span className="grid h-16 w-16 place-items-center overflow-hidden rounded-lg bg-slate-100">
        <img
          src={apiUrl(`/files/thumb?path=${encodeURIComponent(p)}`)}
          alt={entry.name}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return <span className="grid h-16 w-16 place-items-center"><EntryIcon entry={entry} big /></span>;
}

function EntryIcon({ entry, big }: { entry: FileEntry; big?: boolean }) {
  const box = big ? "h-12 w-12 rounded-xl" : "h-8 w-8 rounded-lg";
  const sz = big ? 24 : 16;
  if (entry.type === "dir") {
    return (
      <span className={clsx("grid shrink-0 place-items-center bg-gradient-to-br from-sky-400 to-blue-500 text-white", box)}>
        <FolderIcon size={sz} />
      </span>
    );
  }
  const m = entry.mime ?? "";
  const { Icon, cls } = m.startsWith("image/")
    ? { Icon: ImageIcon, cls: "from-pink-400 to-rose-500" }
    : m.startsWith("video/")
      ? { Icon: FileVideo, cls: "from-purple-400 to-fuchsia-500" }
      : m.startsWith("audio/")
        ? { Icon: FileAudio, cls: "from-amber-400 to-orange-500" }
        : m.startsWith("text/") || m === "application/json" || m === "application/pdf"
          ? { Icon: FileText, cls: "from-slate-400 to-slate-500" }
          : /zip|tar|gzip|compressed|rar/.test(m)
            ? { Icon: FileArchive, cls: "from-yellow-400 to-amber-500" }
            : { Icon: FileIcon, cls: "from-slate-300 to-slate-400" };
  return (
    <span className={clsx("grid shrink-0 place-items-center bg-gradient-to-br text-white", box, cls)}>
      <Icon size={sz} />
    </span>
  );
}

/** Inline folder glyph (keeps the filled look). */
function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z" />
    </svg>
  );
}

function PropertiesPanel({ dir, entry, onClose }: { dir: string; entry: FileEntry; onClose: () => void }) {
  const [info, setInfo] = useState<FileInfoResponse["info"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

  useEffect(() => {
    let cancelled = false;
    api.get<FileInfoResponse>(`/files/info?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!cancelled) setInfo(r.info); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiRequestError ? e.message : "Couldn't read properties."); });
    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="animate-fade-in absolute inset-0 z-30 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className="mb-4 flex items-center gap-3">
          <EntryIcon entry={entry} big />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink" title={entry.name}>{entry.name}</p>
            <p className="text-xs text-ink-faint">{entry.type === "dir" ? "Folder" : entry.mime ?? "File"}</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100" title="Close"><X size={18} /></button>
        </div>
        {error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : !info ? (
          <p className="text-sm text-ink-faint">Reading...</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <Row label="Location" value={dir} mono />
            <Row label="Size" value={formatBytes(info.sizeBytes)} />
            {info.type === "dir" && <Row label="Contains" value={`${info.itemCount} item${info.itemCount === 1 ? "" : "s"}`} />}
            <Row label="Modified" value={new Date(info.modifiedAt).toLocaleString()} />
            <Row label="Created" value={new Date(info.createdAt).toLocaleString()} />
          </dl>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className={clsx("min-w-0 truncate text-right text-ink-soft", mono && "font-mono text-xs")} title={value}>{value}</dd>
    </div>
  );
}
