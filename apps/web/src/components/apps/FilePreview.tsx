import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Download, FileQuestion, Loader2, Pencil, Save, X } from "lucide-react";
import type { FileEntry } from "@opennas/shared";
import { api, apiUrl, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { formatBytes } from "../../lib/format.ts";
import { defuseRenderedMarkup } from "../../lib/safe-markup.ts";
import { useT } from "../../i18n/index.ts";

type Kind = "image" | "video" | "audio" | "pdf" | "text" | "csv" | "docx" | "none";

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".log", ".json", ".xml", ".yml", ".yaml", ".toml", ".ini", ".conf", ".cfg", ".env",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte",
  ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".php", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
  ".java", ".kt", ".swift", ".sql", ".pl", ".lua", ".r", ".dockerfile", ".gitignore", ".editorconfig", ".properties",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function kindOf(entry: FileEntry): Kind {
  const mime = entry.mime ?? "";
  const ext = extOf(entry.name);
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || TEXT_EXT.has(ext)) return "text";
  return "none";
}

export function FilePreview({
  dir,
  entry,
  files,
  writable = false,
  startEditing = false,
  onNavigate,
  onRenamed,
  onSaved,
  onClose,
}: {
  dir: string;
  entry: FileEntry;
  files: FileEntry[];
  /** Whether the current folder is writable (enables rename + text editing). */
  writable?: boolean;
  /** Open a text file straight into edit mode (used for freshly created files). */
  startEditing?: boolean;
  onNavigate: (e: FileEntry) => void;
  /** Called after a successful inline rename with the updated entry. */
  onRenamed?: (updated: FileEntry) => void;
  /** Called after saving edited text content, so the listing can refresh. */
  onSaved?: () => void;
  onClose: () => void;
}) {
  const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
  const rawUrl = apiUrl(`/files/raw?path=${encodeURIComponent(path)}`);
  const downloadUrl = apiUrl(`/files/download?path=${encodeURIComponent(path)}`);
  const kind = kindOf(entry);
  const push = useNotifications((s) => s.push);
  const t = useT();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(entry.name);
  // Reset rename state whenever the previewed file changes.
  useEffect(() => { setRenaming(false); setNameDraft(entry.name); }, [entry.name]);

  const index = files.findIndex((f) => f.name === entry.name);
  const prev = index > 0 ? files[index - 1] : null;
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : null;

  // Keyboard: Esc closes, arrows navigate between files. Suspended while renaming
  // so typing a name (and its arrow keys) doesn't flip the preview.
  useEffect(() => {
    if (renaming) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prev) onNavigate(prev);
      else if (e.key === "ArrowRight" && next) onNavigate(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, prev, next, renaming]);

  async function commitRename() {
    const nextName = nameDraft.trim();
    setRenaming(false);
    if (!nextName || nextName === entry.name) { setNameDraft(entry.name); return; }
    try {
      await api.post("/files/rename", { path, newName: nextName });
      onRenamed?.({ ...entry, name: nextName });
    } catch (err) {
      push({ level: "warning", title: t("app.files.renameFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
      setNameDraft(entry.name);
    }
  }

  return (
    <div
      className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 text-white">
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); if (e.key === "Escape") { setRenaming(false); setNameDraft(entry.name); } }}
            onFocus={(e) => e.target.select()}
            onBlur={() => void commitRename()}
            className="min-w-0 flex-1 rounded-md bg-white/15 px-2 py-1 text-sm font-medium text-white outline-none ring-1 ring-white/30 focus:ring-2 focus:ring-white/60"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={entry.name}>{entry.name}</span>
        )}
        <span className="hidden shrink-0 text-xs text-white/60 sm:inline">{formatBytes(entry.sizeBytes)}</span>
        {writable && !renaming && (
          <button
            onClick={() => { setNameDraft(entry.name); setRenaming(true); }}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/80 transition hover:bg-white/15 hover:text-white"
            title={t("app.files.rename")}
          >
            <Pencil size={16} />
          </button>
        )}
        {renaming && (
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => void commitRename()} className="grid h-8 w-8 place-items-center rounded-lg text-white/80 transition hover:bg-white/15 hover:text-white" title={t("app.preview.saveName")}>
            <Check size={18} />
          </button>
        )}
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener"
          className="grid h-8 w-8 place-items-center rounded-lg text-white/80 transition hover:bg-white/15 hover:text-white"
          title={t("app.files.download")}
        >
          <Download size={17} />
        </a>
        <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-white/80 transition hover:bg-white/15 hover:text-white" title={t("app.preview.close")}>
          <X size={18} />
        </button>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {prev && (
          <NavArrow side="left" onClick={() => onNavigate(prev)} />
        )}
        {next && (
          <NavArrow side="right" onClick={() => onNavigate(next)} />
        )}
        <div className="grid h-full place-items-center overflow-auto p-4">
          <PreviewBody key={path} kind={kind} entry={entry} path={path} rawUrl={rawUrl} downloadUrl={downloadUrl} writable={writable} startEditing={startEditing} onSaved={onSaved} />
        </div>
      </div>
    </div>
  );
}

function NavArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className={`absolute top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 ${side === "left" ? "left-3" : "right-3"}`}
      title={side === "left" ? t("app.preview.previous") : t("app.preview.next")}
    >
      {side === "left" ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  );
}

function PreviewBody({ kind, entry, path, rawUrl, downloadUrl, writable, startEditing, onSaved }: { kind: Kind; entry: FileEntry; path: string; rawUrl: string; downloadUrl: string; writable: boolean; startEditing: boolean; onSaved?: () => void }) {
  switch (kind) {
    case "image":
      return <img src={rawUrl} alt={entry.name} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />;
    case "video":
      return <video src={rawUrl} controls autoPlay className="max-h-full max-w-full rounded-lg shadow-2xl" />;
    case "audio":
      return (
        <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
          <p className="mb-3 truncate text-sm font-medium text-ink">{entry.name}</p>
          <audio src={rawUrl} controls autoPlay className="w-full" />
        </div>
      );
    case "pdf":
      // Deliberately no `sandbox` attribute: a sandboxed frame turns off the
      // browser's built-in PDF viewer (Chrome refuses outright), which is the
      // only thing this frame is for. The isolation comes from the response
      // instead - /files/raw sends a type derived from the extension (so this
      // is application/pdf, never HTML), `nosniff`, and a CSP `sandbox`
      // header, and refuses to serve HTML or SVG inline at all.
      return <iframe src={rawUrl} title={entry.name} className="h-full w-full rounded-lg bg-white shadow-2xl" />;
    case "text":
    case "csv":
      return <TextPreview path={path} rawUrl={rawUrl} csv={kind === "csv"} tsv={extOf(entry.name) === ".tsv"} writable={writable} startEditing={startEditing} onSaved={onSaved} />;
    case "docx":
      return <DocxPreview rawUrl={rawUrl} />;
    default:
      return <NoPreview downloadUrl={downloadUrl} />;
  }
}

function NoPreview({ downloadUrl }: { downloadUrl: string }) {
  const t = useT();
  return (
    <div className="rounded-2xl bg-white p-8 text-center shadow-2xl">
      <FileQuestion size={40} className="mx-auto mb-3 text-slate-300" />
      <p className="text-sm font-medium text-ink">{t("app.preview.unsupported")}</p>
      <a href={downloadUrl} target="_blank" rel="noopener" className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
        <Download size={15} /> {t("app.files.download")}
      </a>
    </div>
  );
}

function Spinner() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-xl bg-white px-5 py-4 text-sm text-ink-soft shadow-2xl">
      <Loader2 size={16} className="animate-spin" /> {t("app.preview.loading")}
    </div>
  );
}

function TextPreview({ path, rawUrl, csv, tsv, writable, startEditing, onSaved }: { path: string; rawUrl: string; csv: boolean; tsv: boolean; writable: boolean; startEditing: boolean; onSaved?: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Editing is only offered for plain text (not the CSV table renderer).
  const editable = writable && !csv;
  const [editing, setEditing] = useState(editable && startEditing);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const push = useNotifications((s) => s.push);
  const t = useT();

  useEffect(() => {
    const ac = new AbortController();
    setText(null);
    setError(null);
    fetch(rawUrl, { credentials: "include", signal: ac.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(t("app.preview.loadFileFailed")))))
      .then((body) => setText(body.length > 2_000_000 ? `${body.slice(0, 2_000_000)}\n\n${t("app.preview.truncated")}` : body))
      .catch((e) => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawUrl]);

  // Seed the editor draft from the loaded text when entering edit mode.
  useEffect(() => { if (editing && text != null) setDraft(text); }, [editing, text]);

  const rows = useMemo(() => {
    if (!csv || text == null) return null;
    const sep = tsv ? "\t" : ",";
    return text.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 1000).map((line) => parseCsvLine(line, sep));
  }, [csv, tsv, text]);

  async function save() {
    setSaving(true);
    try {
      await api.put("/files/write", { path, content: draft });
      setText(draft);
      setEditing(false);
      onSaved?.();
      push({ level: "success", title: t("app.preview.saved"), body: t("app.preview.savedBody") });
    } catch (err) {
      push({ level: "warning", title: t("app.preview.saveFailed"), body: err instanceof ApiRequestError ? err.message : t("app.files.failed") });
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="rounded-xl bg-white px-5 py-4 text-sm text-rose-600 shadow-2xl">{error}</div>;
  if (text == null) return <Spinner />;

  if (editing) {
    return (
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
          <span className="flex-1 text-xs font-medium text-ink-faint">{t("app.preview.editing")}</span>
          <button onClick={() => setEditing(false)} disabled={saving} className="rounded-md px-2.5 py-1 text-xs font-medium text-ink-soft transition hover:bg-slate-100 disabled:opacity-50">{t("common.cancel")}</button>
          <button onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-brand-500 disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {t("common.save")}
          </button>
        </div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); } }}
          spellCheck={false}
          className="opennas-scroll min-h-[40vh] w-full flex-1 resize-none p-4 text-left font-mono text-xs leading-relaxed text-ink-soft outline-none"
        />
      </div>
    );
  }

  if (rows) {
    return (
      <div className="max-h-full w-full max-w-4xl overflow-auto rounded-xl bg-white shadow-2xl">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((cells, r) => (
              <tr key={r} className={r === 0 ? "bg-slate-100 font-semibold" : "odd:bg-slate-50/50"}>
                {cells.map((c, i) => (
                  <td key={i} className="whitespace-nowrap border border-slate-200 px-2.5 py-1 text-ink-soft">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
      {editable && (
        <div className="flex items-center justify-end border-b border-slate-200 px-3 py-1.5">
          <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-ink-soft transition hover:bg-slate-100" title={t("common.edit")}>
            <Pencil size={13} /> {t("common.edit")}
          </button>
        </div>
      )}
      <pre className="opennas-scroll max-h-full overflow-auto p-4 text-left font-mono text-xs leading-relaxed text-ink-soft">
        {text}
      </pre>
    </div>
  );
}

/** Minimal CSV line parser (handles quoted fields with embedded separators/quotes). */
function parseCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function DocxPreview({ rawUrl }: { rawUrl: string }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(rawUrl, { credentials: "include" });
        if (!res.ok) throw new Error(t("app.preview.loadDocFailed"));
        const buf = await res.arrayBuffer();
        const { renderAsync } = await import("docx-preview");
        const host = hostRef.current;
        if (cancelled || !host) return;
        // docx-preview writes <style> elements built from the document's own
        // styles, and those selectors are whatever the file says. Rendered into
        // the light DOM they would restyle the whole desktop, so the output goes
        // into a shadow root: styles inside it can't reach the page, and the
        // page's styles can't reach in.
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        const styles = document.createElement("div");
        const body = document.createElement("div");
        body.className = "opennas-docx";
        shadow.replaceChildren(styles, body);
        await renderAsync(buf, body, styles, { className: "docx", inWrapper: true });
        // The document's hyperlink targets are whatever the file says -
        // including `javascript:` - and a shadow root doesn't change the origin
        // they'd run in. Take out anything executable before it can be clicked.
        defuseRenderedMarkup(styles);
        defuseRenderedMarkup(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t("app.preview.renderDocFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawUrl]);

  return (
    <div className="relative max-h-full w-full max-w-4xl overflow-auto rounded-xl bg-white shadow-2xl">
      {loading && <div className="grid place-items-center py-10"><Spinner /></div>}
      {error && <div className="px-5 py-4 text-sm text-rose-600">{error}</div>}
      <div ref={hostRef} />
    </div>
  );
}
