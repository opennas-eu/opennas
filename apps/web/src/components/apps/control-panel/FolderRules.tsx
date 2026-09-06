import { useEffect, useState } from "react";
import { FolderLock, Info, Plus, Trash2 } from "lucide-react";
import type { AccessLevel, AdminUser, FolderAcl, FolderAclsResponse, Group, Share } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";

/**
 * Folder-level rules for one share.
 *
 * The panel is deliberately explicit about the two things people get wrong: how
 * conflicting rules resolve, and that SMB and NFS can't honour them. Both are
 * stated on screen rather than left to documentation nobody reads.
 */

const LEVEL_LABEL: Record<AccessLevel, string> = {
  none: "No access",
  ro: "Read only",
  rw: "Read & write",
};

const LEVEL_STYLE: Record<AccessLevel, string> = {
  none: "bg-rose-50 text-rose-700 ring-rose-200",
  ro: "bg-amber-50 text-amber-700 ring-amber-200",
  rw: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

export function FolderRules({ share, users, groups }: { share: Share; users: AdminUser[]; groups: Group[] }) {
  const [acls, setAcls] = useState<FolderAcl[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [subject, setSubject] = useState("");
  const [level, setLevel] = useState<AccessLevel>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  async function load() {
    try {
      setAcls((await api.get<FolderAclsResponse>(`/admin/shares/${share.id}/acls`)).acls);
    } catch {
      setAcls([]);
    }
  }
  useEffect(() => { void load(); }, [share.id]);

  async function add() {
    // The picker encodes both halves so one <select> can offer users and groups.
    const [subjectType, subjectId] = subject.split(":") as ["user" | "group", string];
    if (!subjectId) { setError("Choose who the rule applies to."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/shares/${share.id}/acls`, { path, subjectType, subjectId, level });
      setPath(""); setSubject(""); setLevel("none"); setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't add that rule.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(acl: FolderAcl) {
    try {
      await api.del(`/admin/shares/${share.id}/acls/${acl.id}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't remove the rule", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <FolderLock size={15} /> Folder rules
        </h4>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add rule
          </Button>
        )}
      </div>

      <p className="mb-3 text-xs text-ink-faint">
        Change access to one folder inside this share. The closest rule wins, and a person beats a group. A rule can
        never grant access to a share someone can't already reach.
      </p>

      {adding && (
        <div className="mb-3 space-y-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Folder" hint={`Inside ${share.name}, e.g. "payroll/2026"`}>
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="payroll" autoFocus />
            </Field>
            <Field label="Applies to">
              <Select value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full">
                <option value="">Choose...</option>
                {groups.length > 0 && (
                  <optgroup label="Groups">
                    {groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="People">
                  {users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.displayName} (@{u.username})</option>)}
                </optgroup>
              </Select>
            </Field>
            <Field label="Access">
              <Select value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)} className="w-full">
                <option value="none">No access</option>
                <option value="ro">Read only</option>
                <option value="rw">Read &amp; write</option>
              </Select>
            </Field>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex gap-2">
            <Button loading={busy} onClick={add} disabled={!path.trim() || !subject}>Add rule</Button>
            <Button variant="ghost" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      {acls === null ? (
        <p className="text-sm text-ink-faint">Loading...</p>
      ) : acls.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-ink-faint">
          No folder rules. Everyone with access to this share sees all of it.
        </div>
      ) : (
        <div className="space-y-1.5">
          {acls.map((acl) => (
            <div key={acl.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
              <code className="truncate font-mono text-xs text-ink-soft">/{acl.path}</code>
              <span className="text-xs text-ink-faint">
                {acl.subjectType === "group" ? "group" : "person"}
              </span>
              <span className="truncate text-sm text-ink-soft">
                {acl.subjectType === "group" ? acl.subjectName : `${acl.subjectLabel} (@${acl.subjectName})`}
              </span>
              <span className="flex-1" />
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ring-1 ${LEVEL_STYLE[acl.level]}`}>
                {LEVEL_LABEL[acl.level]}
              </span>
              <button
                aria-label="Remove rule"
                onClick={() => void remove(acl)}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {acls !== null && acls.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div>
            <strong className="font-medium">Folder rules apply to the web interface.</strong> Over SMB and NFS this share
            is governed by its user and group permissions above - every SMB connection is mapped to one service account,
            so the file server has no way to tell your users apart below the share. Keep anything that must be private
            from SMB clients in a separate share.
          </div>
        </div>
      )}
    </div>
  );
}
