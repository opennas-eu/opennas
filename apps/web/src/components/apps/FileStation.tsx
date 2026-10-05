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
import { useLocale, useT } from "../../i18n/index.ts";

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
  const t = useT();
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
      setError(err instanceof ApiRequestError ? err.message : t("app.files.openFailed"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      push({ level: "warning", title: t("app.files.createFolderFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
    }
  }

  async function createTextFile() {
    const raw = await promptDialog({
      title: t("app.files.newTextFile"),
      message: t("app.files.newTextFileHint"),
      confirmLabel: t("common.create"),
      defaultValue: t("app.files.untitledFile"),
      placeholder: t("app.files.untitledFile"),
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
      push({ level: "warning", title: t("app.files.createFileFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
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
      push({ level: "warning", title: t("app.files.renameFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
    }
  }

  async function deleteEntries(entries: FileEntry[]) {
    if (entries.length === 0) return;
    const ok = await confirmDialog({
      title: entries.length === 1 ? t("app.files.deleteOne", { name: entries[0]!.name }) : t("app.files.deleteMany", { count: entries.length }),
      message: t("app.files.deleteHint"),
      confirmLabel: t("common.delete"),
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
    if (failed) push({ level: "warning", title: t("app.files.deleteSomeFailed"), body: t("app.files.failedCount", { count: failed }) });
    await load(path);
  }

  function copySelection(kind: ClipKind, entries: FileEntry[]) {
    if (entries.length === 0) return;
    setClip({ kind, dir: path, names: entries.map((e) => e.name) });
    push({ level: "info", title: kind === "copy" ? t("app.files.copied") : t("app.files.cutDone"), body: t("app.files.readyToPaste", { count: entries.length }) });
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
    if (failed) push({ level: "warning", title: t("app.files.pasteSomeFailed"), body: t("app.files.pasteFailedCount", { count: failed }) });
    else push({ level: "success", title: clip.kind === "copy" ? t("app.files.copiedHere") : t("app.files.movedHere"), body: t("app.files.itemsDone", { count: clip.names.length }) });
    await load(path);
  }

  function downloadEntries(entries: FileEntry[]) {
    const files = entries.filter((e) => e.type === "file");
    if (files.length === 0) {
      push({ level: "info", title: t("app.files.nothingToDownload"), body: t("app.files.useZipForFolders") });
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
        throw new Error(body?.message ?? t("app.files.uploadFailedBody"));
      }
      push({ level: "success", title: t("app.files.uploadComplete"), body: t("app.files.uploadedTo", { count: files.length, path }) });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: t("app.files.uploadFailed"), body: err instanceof Error ? err.message : t("app.files.failed") });
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
    const def = entries.length === 1 ? entries[0]!.name.replace(/\.[^.]+$/, "") : t("app.files.archiveName");
    const name = await promptDialog({
      title: t("app.files.compressTitle"),
      message: t("app.files.compressMessage", { count: entries.length }),
      confirmLabel: t("app.files.compress"),
      defaultValue: def,
      placeholder: t("app.files.archiveName"),
    });
    if (!name) return;
    try {
      await api.post("/files/compress", { dir: path, names: entries.map((e) => e.name), name });
      push({ level: "success", title: t("app.files.compressed"), body: t("app.files.zipCreated", { name: name.replace(/\.zip$/i, "") }) });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: t("app.files.compressFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
    }
  }

  async function extractEntry(e: FileEntry) {
    try {
      const res = await api.post<{ path: string }>("/files/extract", { path: join(e.name) });
      push({ level: "success", title: t("app.files.extracted"), body: t("app.files.extractedTo", { name: e.name, folder: res.path.split("/").pop() ?? "" }) });
      await load(path);
    } catch (err) {
      push({ level: "warning", title: t("app.files.extractFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
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
    if (failed) push({ level: "warning", title: op === "copy" ? t("app.files.copySomeFailed") : t("app.files.moveSomeFailed"), body: t("app.files.failedCount", { count: failed }) });
    else push({ level: "success", title: op === "copy" ? t("app.files.copied") : t("app.files.moved"), body: t("app.files.itemsInto", { count: names.length, folder: folder.name }) });
    await load(path);
  }

  const isInternalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-opennas");

  function buildMenuItems(): MenuItem[] {
    const sel = selectedEntries;
    if (menu?.entry) {
      const e = menu.entry;
      const multi = sel.length > 1;
      const items: MenuItem[] = [];
      if (e.type === "dir") items.push({ label: t("app.files.open"), icon: <FolderOpen size={15} />, onClick: () => openEntry(e) });
      else if (isPreviewable(e)) items.push({ label: t("app.files.preview"), icon: <Eye size={15} />, onClick: () => openPreview(e) });
      if (sel.some((x) => x.type === "file")) {
        items.push({ label: multi ? t("app.files.downloadFiles") : t("app.files.download"), icon: <Download size={15} />, onClick: () => downloadEntries(sel) });
      }
      if (!multi && e.type === "dir") {
        items.push({ label: t("app.files.downloadZip"), icon: <Download size={15} />, onClick: () => downloadFolderZip(e) });
      }
      if (!multi && e.type === "file" && /\.zip$/i.test(e.name) && writable) {
        items.push({ label: t("app.files.extractHere"), icon: <PackageOpen size={15} />, onClick: () => void extractEntry(e) });
      }
      if (writable) items.push({ label: multi ? t("app.files.compressCount", { count: sel.length }) : t("app.files.compressTitle"), icon: <Archive size={15} />, onClick: () => void compressSelection(sel) });
      items.push({ label: t("app.files.copy"), icon: <Copy size={15} />, onClick: () => copySelection("copy", sel), separator: true });
      if (writable) items.push({ label: t("app.files.cut"), icon: <Scissors size={15} />, onClick: () => copySelection("cut", sel) });
      if (writable && !multi) items.push({ label: t("app.files.rename"), icon: <Pencil size={15} />, onClick: () => startRename(e) });
      if (!multi) items.push({ label: t("app.files.shareLink"), icon: <Link2 size={15} />, onClick: () => setShareEntry(e), separator: true });
      items.push({ label: t("app.files.properties"), icon: <Info size={15} />, onClick: () => setPropsFor(e), separator: !multi ? false : true });
      if (writable) items.push({ label: multi ? t("app.files.deleteCount", { count: sel.length }) : t("common.delete"), icon: <Trash2 size={15} />, danger: true, onClick: () => deleteEntries(sel), separator: true });
      return items;
    }
    // Background menu
    return [
      { label: t("app.files.paste"), icon: <ClipboardPaste size={15} />, disabled: !clip || !writable, onClick: () => void paste() },
      { label: t("app.files.newFolder"), icon: <FolderPlus size={15} />, disabled: !writable, onClick: () => setCreating(true), separator: true },
      { label: t("app.files.newTextFile"), icon: <FilePlus size={15} />, disabled: !writable, onClick: () => void createTextFile() },
      { label: t("app.files.uploadFiles"), icon: <Upload size={15} />, disabled: !writable, onClick: () => fileInput.current?.click() },
      { label: t("app.files.selectAll"), icon: <Check size={15} />, onClick: () => setSelected(new Set(displayed.map((e) => e.name))), separator: true },
      { label: t("desktop.refresh"), icon: <RefreshCw size={15} />, onClick: () => void load(path) },
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
        <button onClick={() => parent && load(parent)} disabled={!parent} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title={t("app.files.back")}>
          <ArrowLeft size={16} />
        </button>
        <button onClick={() => parent && load(parent)} disabled={!parent} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title={t("app.files.upOneLevel")}>
          <ArrowUp size={16} />
        </button>

        {/* Breadcrumb */}
        <nav className="opennas-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-1 text-sm">
          <Crumb onClick={() => load("/")} label={t("shares.title")} active={path === "/"} />
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
            placeholder={t("desktop.search")}
            className="h-8 w-36 rounded-lg bg-slate-100 pl-8 pr-2 text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-1.5 grid h-5 w-5 place-items-center rounded text-slate-400 hover:text-ink-soft" title={t("app.files.clearSearch")}>
              <X size={13} />
            </button>
          )}
        </div>

        <button onClick={() => setView((v) => (v === "list" ? "grid" : "list"))} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title={view === "list" ? t("app.files.gridView") : t("app.files.listView")}>
          {view === "list" ? <LayoutGrid size={16} /> : <ListIcon size={16} />}
        </button>
        <button onClick={() => load(path)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title={t("desktop.refresh")}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
        <button onClick={() => setShowLinks(true)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title={t("app.files.sharedLinks")}>
          <Link2 size={16} />
        </button>
        <button onClick={() => setShowTrash(true)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition hover:bg-slate-100" title={t("app.files.recycleBin")}>
          <Trash2 size={16} />
        </button>
        {clip && (
          <button onClick={() => void paste()} disabled={!writable} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title={t("app.files.pasteCount", { count: clip.names.length })}>
            <ClipboardPaste size={16} /> <span className="hidden sm:inline">{t("app.files.paste")}</span>
          </button>
        )}
        <button onClick={() => setCreating((c) => !c)} disabled={!writable} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft transition hover:bg-slate-100 disabled:opacity-40" title={t("app.files.newFolder")}>
          <FolderPlus size={16} /> <span className="hidden sm:inline">{t("app.files.new")}</span>
        </button>
        <Button className="h-8 px-3 py-0 text-xs" onClick={() => fileInput.current?.click()} loading={uploading > 0} disabled={!writable}>
          <Upload size={15} /> {t("app.files.upload")}
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
            placeholder={t("app.files.folderName")}
            className="h-8 max-w-xs py-0 text-sm"
          />
          <Button className="h-8 px-3 py-0 text-xs" onClick={createFolder}>{t("common.create")}</Button>
          <Button variant="ghost" className="h-8 px-2 py-0 text-xs" onClick={() => setCreating(false)}>{t("common.cancel")}</Button>
        </div>
      )}

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-brand-100 bg-brand-50/60 px-4 py-1.5 text-xs">
          <span className="font-medium text-brand-700">{t("app.files.selected", { count: selected.size })}</span>
          <span className="flex-1" />
          <BarBtn onClick={() => downloadEntries(selectedEntries)}><Download size={13} /> {t("app.files.download")}</BarBtn>
          <BarBtn onClick={() => copySelection("copy", selectedEntries)}><Copy size={13} /> {t("app.files.copy")}</BarBtn>
          {writable && <BarBtn onClick={() => copySelection("cut", selectedEntries)}><Scissors size={13} /> {t("app.files.cut")}</BarBtn>}
          {writable && <BarBtn danger onClick={() => deleteEntries(selectedEntries)}><Trash2 size={13} /> {t("common.delete")}</BarBtn>}
          <BarBtn onClick={() => setSelected(new Set())}><X size={13} /> {t("app.files.clearSelection")}</BarBtn>
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
              <p className="text-sm">{query ? t("app.files.noMatches") : path === "/" ? t("app.files.noShares") : t("app.files.empty")}</p>
              {!query && (
                <p className="text-xs">
                  {path === "/" ? t("app.files.noSharesHint") : t("app.files.emptyHint")}
                </p>
              )}
            </div>
          </div>
        ) : view === "list" ? (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-xs text-ink-faint shadow-[0_1px_0_rgb(0_0_0/0.06)]">
              <tr>
                <SortHead label={t("common.name")} col="name" sortKey={sortKey} sortAsc={sortAsc} onSort={setSort} className="px-4 py-2" />
                <SortHead label={t("app.files.size")} col="size" sortKey={sortKey} sortAsc={sortAsc} onSort={setSort} className="w-28 px-3 py-2 text-right" align="right" />
                <SortHead label={t("app.files.modified")} col="modified" sortKey={sortKey} sortAsc={sortAsc} onSort={setSort} className="hidden w-40 px-3 py-2 sm:table-cell" />
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
                          <RowBtn label={t("app.files.download")} onClick={(ev) => { ev.stopPropagation(); window.open(apiUrl(`/files/download?path=${encodeURIComponent(join(e.name))}`), "_blank"); }}>
                            <Download size={15} />
                          </RowBtn>
                        )}
                        <RowBtn label={t("app.files.more")} onClick={(ev) => { ev.stopPropagation(); if (!selected.has(e.name)) setSelected(new Set([e.name])); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}>
                          <Info size={15} />
                        </RowBtn>
                        {writable && (
                          <RowBtn label={t("common.delete")} danger onClick={(ev) => { ev.stopPropagation(); void deleteEntries([e]); }}>
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
          {listing ? t("app.files.items", { count: displayed.length }) : "..."}
          {query && listing ? ` ${t("app.files.filteredFrom", { total: listing.entries.length })}` : ""}
          {!writable && listing ? ` - ${t("app.files.readOnly")}` : ""}
        </span>
        {uploading > 0 && <span className="text-brand-600">{t("app.files.uploading", { count: uploading })}</span>}
      </footer>

      {/* Drag-drop overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 m-2 grid place-items-center rounded-xl border-2 border-dashed border-brand-400 bg-brand-50/80 backdrop-blur-sm">
          <div className="text-center text-brand-700">
            <Upload size={32} className="mx-auto mb-2" />
            <p className="font-semibold">{t("app.files.dropToUpload")}</p>
            <p className="text-sm">{t("app.files.dropTarget", { path })}</p>
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
  const t = useT();
  const locale = useLocale();
  const [info, setInfo] = useState<FileInfoResponse["info"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;

  useEffect(() => {
    let cancelled = false;
    api.get<FileInfoResponse>(`/files/info?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!cancelled) setInfo(r.info); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiRequestError ? e.message : t("app.files.propsFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="animate-fade-in absolute inset-0 z-30 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-900/10">
        <div className="mb-4 flex items-center gap-3">
          <EntryIcon entry={entry} big />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink" title={entry.name}>{entry.name}</p>
            <p className="text-xs text-ink-faint">{entry.type === "dir" ? t("app.files.folder") : entry.mime ?? t("app.files.file")}</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100" title={t("desktop.close")}><X size={18} /></button>
        </div>
        {error ? (
          <p className="text-sm text-rose-600">{error}</p>
        ) : !info ? (
          <p className="text-sm text-ink-faint">{t("app.files.reading")}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <Row label={t("app.files.location")} value={dir} mono />
            <Row label={t("app.files.size")} value={formatBytes(info.sizeBytes)} />
            {info.type === "dir" && <Row label={t("app.files.contains")} value={t("app.files.items", { count: info.itemCount })} />}
            <Row label={t("app.files.modified")} value={new Date(info.modifiedAt).toLocaleString(locale)} />
            <Row label={t("app.files.created")} value={new Date(info.createdAt).toLocaleString(locale)} />
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
