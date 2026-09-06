import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Link2, Trash2, X } from "lucide-react";
import type { FileEntry, ShareLink, ShareLinkListResponse, ShareLinkResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../lib/api.ts";
import { useNotifications } from "../../store/notifications.ts";
import { confirmDialog } from "../../store/dialogs.ts";
import { Button, Field, Input, Select } from "../ui/controls.tsx";

function fullUrl(link: ShareLink): string {
  return `${location.origin}${link.url}`;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked - user can copy manually */
  }
}

/** Create a public link for one file/folder. */
export function ShareLinkDialog({ dir, entry, onClose }: { dir: string; entry: FileEntry; onClose: () => void }) {
  const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
  const [expires, setExpires] = useState("0");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const push = useNotifications((s) => s.push);

  async function create() {
    setBusy(true);
    try {
      const days = Number(expires);
      const res = await api.post<ShareLinkResponse>("/files/share-links", {
        path,
        ...(days > 0 ? { expiresInDays: days } : {}),
        ...(password ? { password } : {}),
      });
      setLink(res.link);
    } catch (err) {
      push({ level: "warning", title: "Couldn't create link", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!link) return;
    void copyToClipboard(fullUrl(link));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal title={`Share "${entry.name}"`} onClose={onClose}>
      {!link ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-faint">Anyone with the link can {entry.type === "dir" ? "download this folder as a zip" : "download this file"} - no account needed.</p>
          <Field label="Link expires">
            <Select value={expires} onChange={(e) => setExpires(e.target.value)} className="w-full">
              <option value="0">Never</option>
              <option value="1">After 1 day</option>
              <option value="7">After 7 days</option>
              <option value="30">After 30 days</option>
            </Select>
          </Field>
          <Field label="Password (optional)" hint="Recipients must enter this to download">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="No password" autoComplete="new-password" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" className="h-9" onClick={onClose}>Cancel</Button>
            <Button className="h-9" loading={busy} onClick={create}><Link2 size={15} /> Create link</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">Your share link is ready:</p>
          <div className="flex gap-2">
            <Input readOnly value={fullUrl(link)} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
            <Button className="h-[42px] shrink-0" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}</Button>
          </div>
          <p className="text-xs text-ink-faint">
            {link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleString()}` : "No expiry"}
            {link.hasPassword ? " - password protected" : ""}
          </p>
          <div className="flex justify-end"><Button variant="secondary" className="h-9" onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}

/** List + revoke the user's existing public links. */
export function ShareLinksManager({ onClose }: { onClose: () => void }) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function load() {
    setLinks((await api.get<ShareLinkListResponse>("/files/share-links")).links);
  }
  useEffect(() => { void load(); }, []);

  async function revoke(link: ShareLink) {
    if (!(await confirmDialog({ title: `Revoke link to "${link.name}"?`, message: "The link will stop working immediately.", confirmLabel: "Revoke", danger: true }))) return;
    await api.del(`/files/share-links/${link.id}`);
    await load();
  }

  function copy(link: ShareLink) {
    void copyToClipboard(fullUrl(link));
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <Modal title="Shared links" onClose={onClose} wide>
      {links === null ? (
        <p className="p-6 text-center text-sm text-ink-faint">Loading...</p>
      ) : links.length === 0 ? (
        <p className="p-8 text-center text-sm text-ink-faint">No share links yet. Right-click a file and choose 'Share link'.</p>
      ) : (
        <div className="space-y-1.5">
          {links.map((link) => (
            <div key={link.id} className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
              <Link2 size={15} className="shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink-soft">{link.name}{link.isDir ? "/" : ""}</div>
                <div className="truncate text-xs text-ink-faint">
                  {link.expiresAt ? `expires ${new Date(link.expiresAt).toLocaleDateString()}` : "no expiry"}
                  {link.hasPassword ? " - password" : ""} - {link.path}
                </div>
              </div>
              <button onClick={() => copy(link)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-slate-200 hover:text-ink-soft" title="Copy link">
                {copiedId === link.id ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button onClick={() => void revoke(link)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-rose-500 hover:text-white" title="Revoke"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className="animate-fade-in absolute inset-0 z-30 flex flex-col bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`mx-auto flex max-h-full w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10 ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
          <h2 className="flex-1 font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-slate-100" title="Close"><X size={18} /></button>
        </div>
        <div className="opennas-scroll min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}
