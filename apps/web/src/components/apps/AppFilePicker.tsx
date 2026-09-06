import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, File as FileIcon, Folder, FolderOpen, Home, Lock, X } from "lucide-react";
import { clsx } from "clsx";
import type { AppManifest, FileEntry, FileListResponse } from "@opennas/shared";
import { api } from "../../lib/api.ts";
import { Button } from "../ui/controls.tsx";
import { formatBytes } from "../../lib/format.ts";

/**
 * The file picker OpenNAS draws when an app asks for a folder.
 *
 * This is deliberately *outside* the app's iframe. The app never sees the
 * browsing - only the one path the user finally chose - which is what lets an
 * app work with a folder without holding a permission over everything. Same
 * principle as the app settings form, where secrets never pass through the app.
 *
 * It reads through the ordinary File Station API on the user's own session, so
 * what can be browsed here is exactly what that person could browse anyway.
 */

export interface PickerRequest {
  app: AppManifest;
  mode: "read" | "readwrite";
  select: "file" | "dir";
  title?: string;
}

export interface PickerChoice {
  path: string;
  type: "file" | "dir";
}

export function AppFilePicker({
  request,
  onPick,
  onCancel,
}: {
  request: PickerRequest;
  onPick: (choice: PickerChoice) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string) => {
    setEntries(null);
    setError(null);
    setSelected(null);
    try {
      const res = await api.get<FileListResponse>(`/files/list?path=${encodeURIComponent(target)}`);
      setEntries(res.entries);
      setPath(res.path);
    } catch {
      setError("That folder couldn't be opened.");
      setEntries([]);
    }
  }, []);

  useEffect(() => { void load("/"); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const segments = path.split("/").filter(Boolean);
  const wantsFolder = request.select === "dir";

  // Picking a folder means "the one I'm looking at" unless a child is selected,
  // which is what makes choosing a share root possible without a parent listing.
  const choice: PickerChoice | null = selected
    ? { path: `${path === "/" ? "" : path}/${selected.name}`, type: selected.type }
    : wantsFolder && path !== "/"
      ? { path, type: "dir" }
      : null;

  const canConfirm = choice !== null && (wantsFolder ? choice.type === "dir" : choice.type === "file");

  return createPortal(
    <div
      className="fixed inset-0 z-[9000] grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
        <header className="flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <FolderOpen size={18} className="mt-0.5 shrink-0 text-brand-500" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">
              {request.title || `Choose a ${wantsFolder ? "folder" : "file"}`}
            </h2>
            <p className="text-[11px] text-ink-faint">
              <strong className="text-ink-soft">{request.app.name}</strong> will be able to{" "}
              {request.mode === "readwrite" ? "read and change" : "read"} what you pick - and nothing else. You can take
              this back at any time in Control Panel → Security.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-faint transition hover:bg-slate-100 dark:hover:bg-slate-700"
            title="Cancel"
          >
            <X size={15} />
          </button>
        </header>

        <div className="flex items-center gap-0.5 overflow-x-auto border-b border-slate-200 px-3 py-1.5 text-xs dark:border-slate-700">
          <button
            onClick={() => void load("/")}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ink-soft transition hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <Home size={12} /> Shared folders
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex shrink-0 items-center">
              <ChevronRight size={12} className="text-ink-faint" />
              <button
                onClick={() => void load("/" + segments.slice(0, i + 1).join("/"))}
                className="rounded px-1.5 py-0.5 text-ink-soft transition hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        <div className="opennas-scroll min-h-[14rem] flex-1 overflow-auto p-1.5">
          {entries === null ? (
            <p className="p-4 text-center text-xs text-ink-faint">Loading...</p>
          ) : error ? (
            <p className="p-4 text-center text-xs text-rose-600">{error}</p>
          ) : entries.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-faint">This folder is empty.</p>
          ) : (
            <ul>
              {entries.map((entry) => {
                const isDir = entry.type === "dir";
                // A file the app can't use is shown but not selectable, so the
                // folder still looks like the folder the user knows.
                const usable = wantsFolder ? isDir : !isDir;
                const isSelected = selected?.name === entry.name;
                return (
                  <li key={entry.name}>
                    <button
                      onClick={() => (isDir && !wantsFolder ? void load(`${path === "/" ? "" : path}/${entry.name}`) : setSelected(entry))}
                      onDoubleClick={() => isDir && void load(`${path === "/" ? "" : path}/${entry.name}`)}
                      disabled={!usable && !isDir}
                      className={clsx(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition",
                        isSelected
                          ? "bg-brand-500 text-white"
                          : usable || isDir
                            ? "text-ink-soft hover:bg-slate-100 dark:hover:bg-slate-700"
                            : "cursor-default text-ink-faint opacity-50",
                      )}
                    >
                      {isDir ? <Folder size={14} className="shrink-0" /> : <FileIcon size={14} className="shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {!isDir && <span className={clsx("shrink-0", isSelected ? "text-white/70" : "text-ink-faint")}>{formatBytes(entry.sizeBytes)}</span>}
                      {isDir && (
                        <ChevronRight
                          size={13}
                          className={clsx("shrink-0", isSelected ? "text-white/70" : "text-ink-faint")}
                          onClick={(e) => { e.stopPropagation(); void load(`${path === "/" ? "" : path}/${entry.name}`); }}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-slate-200 px-4 py-2.5 dark:border-slate-700">
          <p className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            {choice ? (
              <>
                <Lock size={10} className="mr-1 inline" />
                Giving access to <strong className="text-ink-soft">{choice.path}</strong>
              </>
            ) : wantsFolder ? (
              "Open a shared folder, then choose it or one of its subfolders."
            ) : (
              "Select a file."
            )}
          </p>
          <Button variant="ghost" className="h-8 shrink-0 px-3 text-xs" onClick={onCancel}>Cancel</Button>
          <Button
            className="h-8 shrink-0 px-3 text-xs"
            disabled={!canConfirm}
            onClick={() => choice && onPick(choice)}
          >
            {wantsFolder ? "Use this folder" : "Use this file"}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
