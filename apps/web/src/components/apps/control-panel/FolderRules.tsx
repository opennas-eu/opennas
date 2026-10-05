import { useEffect, useState } from "react";
import { FolderLock, Info, Plus, Trash2 } from "lucide-react";
import type { AccessLevel, AdminUser, FolderAcl, FolderAclsResponse, Group, Share } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Select } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import type { MessageKey } from "../../../i18n/index.ts";

/**
 * Folder-level rules for one share.
 *
 * The panel is deliberately explicit about the two things people get wrong: how
 * conflicting rules resolve, and that SMB and NFS can't honour them. Both are
 * stated on screen rather than left to documentation nobody reads.
 */

const LEVEL_LABEL: Record<AccessLevel, MessageKey> = {
  none: "cp.shares.noAccess",
  ro: "common.readOnly",
  rw: "common.readWrite",
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
  const t = useT();

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
    if (!subjectId) { setError(t("cp.folderRules.chooseSubject")); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/shares/${share.id}/acls`, { path, subjectType, subjectId, level });
      setPath(""); setSubject(""); setLevel("none"); setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.folderRules.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(acl: FolderAcl) {
    try {
      await api.del(`/admin/shares/${share.id}/acls/${acl.id}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.folderRules.removeFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <FolderLock size={15} /> {t("cp.folderRules.title")}
        </h4>
        {!adding && (
          <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={() => setAdding(true)}>
            <Plus size={14} /> {t("cp.folderRules.addRule")}
          </Button>
        )}
      </div>

      <p className="mb-3 text-xs text-ink-faint">
        {t("cp.folderRules.intro")}
      </p>

      {adding && (
        <div className="mb-3 space-y-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("cp.folderRules.folder")} hint={t("cp.folderRules.folderHint", { name: share.name })}>
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("cp.folderRules.folderExample")} autoFocus />
            </Field>
            <Field label={t("cp.folderRules.appliesTo")}>
              <Select value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full">
                <option value="">{t("cp.folderRules.choose")}</option>
                {groups.length > 0 && (
                  <optgroup label={t("cp.groups")}>
                    {groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
                  </optgroup>
                )}
                <optgroup label={t("cp.folderRules.people")}>
                  {users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.displayName} (@{u.username})</option>)}
                </optgroup>
              </Select>
            </Field>
            <Field label={t("cp.folderRules.access")}>
              <Select value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)} className="w-full">
                <option value="none">{t("cp.shares.noAccess")}</option>
                <option value="ro">{t("common.readOnly")}</option>
                <option value="rw">{t("common.readWrite")}</option>
              </Select>
            </Field>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex gap-2">
            <Button loading={busy} onClick={add} disabled={!path.trim() || !subject}>{t("cp.folderRules.addRule")}</Button>
            <Button variant="ghost" onClick={() => { setAdding(false); setError(null); }}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}

      {acls === null ? (
        <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>
      ) : acls.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-ink-faint">
          {t("cp.folderRules.empty")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {acls.map((acl) => (
            <div key={acl.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
              <code className="truncate font-mono text-xs text-ink-soft">/{acl.path}</code>
              <span className="text-xs text-ink-faint">
                {acl.subjectType === "group" ? t("cp.folderRules.group") : t("cp.folderRules.person")}
              </span>
              <span className="truncate text-sm text-ink-soft">
                {acl.subjectType === "group" ? acl.subjectName : `${acl.subjectLabel} (@${acl.subjectName})`}
              </span>
              <span className="flex-1" />
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ring-1 ${LEVEL_STYLE[acl.level]}`}>
                {t(LEVEL_LABEL[acl.level])}
              </span>
              <button
                aria-label={t("cp.folderRules.removeRule")}
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
            <strong className="font-medium">{t("cp.folderRules.webOnly")}</strong> {t("cp.folderRules.webOnlyDetail")}
          </div>
        </div>
      )}
    </div>
  );
}
