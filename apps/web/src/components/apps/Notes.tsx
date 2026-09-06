import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { Plus, StickyNote, Trash2 } from "lucide-react";
import type { Note } from "@opennas/shared";
import { api } from "../../lib/api.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { formatRelative } from "../../lib/format.ts";
import { Input } from "../ui/controls.tsx";

export function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = notes.find((n) => n.id === selectedId) ?? null;

  async function load(selectFirst = false) {
    const res = await api.get<{ notes: Note[] }>("/notes");
    setNotes(res.notes);
    if (selectFirst && res.notes.length && !selectedId) select(res.notes[0]!);
  }
  useEffect(() => { void load(true); }, []);

  function select(n: Note) {
    flushSave();
    setSelectedId(n.id);
    setTitle(n.title);
    setBody(n.body);
    setSaved(true);
  }

  async function create() {
    const { note } = await api.post<{ note: Note }>("/notes", { title: "Untitled", body: "" });
    setNotes((ns) => [note, ...ns]);
    select(note);
  }

  async function remove(id: string) {
    if (!(await confirmDialog({ title: "Delete this note?", confirmLabel: "Delete", danger: true }))) return;
    await api.del(`/notes/${id}`);
    setNotes((ns) => ns.filter((n) => n.id !== id));
    if (selectedId === id) { setSelectedId(null); setTitle(""); setBody(""); }
  }

  // Debounced autosave.
  function queueSave(nextTitle: string, nextBody: string) {
    if (!selectedId) return;
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist(selectedId, nextTitle, nextBody), 700);
  }

  function flushSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (selectedId && !saved) void persist(selectedId, title, body);
    }
  }

  async function persist(id: string, t: string, b: string) {
    const { note } = await api.patch<{ note: Note }>(`/notes/${id}`, { title: t || "Untitled", body: b });
    setNotes((ns) => ns.map((n) => (n.id === id ? note : n)).sort((a, b2) => b2.updatedAt.localeCompare(a.updatedAt)));
    setSaved(true);
  }

  useEffect(() => () => flushSave(), []); // flush on unmount

  return (
    <div className="flex h-full bg-white">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold text-ink-soft">Notes</span>
          <button onClick={create} className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-white hover:bg-brand-500" title="New note">
            <Plus size={16} />
          </button>
        </div>
        <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-1.5">
          {notes.length === 0 && <p className="px-2 py-4 text-center text-xs text-ink-faint">No notes yet. Create one!</p>}
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => select(n)}
              className={clsx("group flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors", selectedId === n.id ? "bg-brand-100" : "hover:bg-slate-200/50")}
            >
              <StickyNote size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink-soft">{n.title || "Untitled"}</div>
                <div className="truncate text-xs text-ink-faint">{n.body.split("\n")[0] || "No content"}</div>
                <div className="text-[10px] text-slate-400">{formatRelative(n.updatedAt)}</div>
              </div>
              <span onClick={(e) => { e.stopPropagation(); void remove(n.id); }} className="grid h-6 w-6 shrink-0 place-items-center rounded text-slate-300 opacity-0 hover:bg-rose-500 hover:text-white group-hover:opacity-100" title="Delete">
                <Trash2 size={13} />
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
              <Input
                value={title}
                onChange={(e) => { setTitle(e.target.value); queueSave(e.target.value, body); }}
                placeholder="Title"
                className="h-9 border-0 bg-transparent px-0 text-base font-semibold shadow-none ring-0 focus:ring-0"
              />
              <span className="shrink-0 text-xs text-ink-faint">{saved ? "Saved" : "Saving..."}</span>
            </div>
            <textarea
              value={body}
              onChange={(e) => { setBody(e.target.value); queueSave(title, e.target.value); }}
              onBlur={flushSave}
              placeholder="Start writing... (Markdown supported)"
              spellCheck
              className="opennas-scroll min-h-0 flex-1 resize-none bg-white p-4 text-sm leading-relaxed text-ink outline-none"
            />
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-center text-sm text-ink-faint">
            <div>
              <StickyNote size={28} className="mx-auto mb-2 text-slate-300" />
              Select or create a note
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
