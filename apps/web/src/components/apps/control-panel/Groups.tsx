import { useEffect, useState } from "react";
import { ChevronDown, Plus, Trash2, Users as UsersIcon, UserPlus } from "lucide-react";
import { clsx } from "clsx";
import type { AdminUser, Group, GroupDetailResponse, GroupMember, GroupsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Field, Input } from "../../ui/controls.tsx";

/**
 * Groups: a named set of users that share permissions can be granted to.
 *
 * Flat on purpose - no nesting - so the answer to "who can read this folder?"
 * is always one lookup deep rather than a tree walk nobody can hold in their
 * head. The name doubles as a system group on the appliance, which is what lets
 * Samba be told `valid users = @editors` instead of a list that goes stale.
 */
export function Groups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const push = useNotifications((s) => s.push);

  async function load() {
    const [g, u] = await Promise.all([
      api.get<GroupsResponse>("/admin/groups"),
      api.get<{ users: AdminUser[] }>("/admin/users"),
    ]);
    setGroups(g.groups);
    setUsers(u.users);
  }
  useEffect(() => { void load(); }, []);

  async function remove(group: Group) {
    if (!(await confirmDialog({
      title: `Delete the "${group.name}" group?`,
      message:
        "Members lose the access this group gave them, and its folder rules go. The accounts stay.",
      confirmLabel: "Delete group",
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/groups/${group.id}`);
      push({ level: "success", title: "Group deleted", body: group.name });
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't delete the group", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Groups</h2>
          <p className="text-sm text-ink-faint">
            Grant access to a group instead of one person at a time - adding someone to it gives them everything it can reach.
          </p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate((s) => !s)}>
          <Plus size={16} /> New group
        </Button>
      </div>

      {showCreate && <CreateGroupForm onDone={async () => { setShowCreate(false); await load(); }} />}

      <div className="space-y-2">
        {groups === null && <p className="text-sm text-ink-faint">Loading...</p>}
        {groups?.length === 0 && !showCreate && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            No groups yet. Create one - "family", "editors", "guests" - then grant it access in Shared Folders.
          </div>
        )}
        {groups?.map((g) => (
          <div key={g.id} className="overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200/70">
            <button
              onClick={() => setExpanded(expanded === g.id ? null : g.id)}
              className="flex w-full items-center gap-3 p-3.5 text-left"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-400 to-indigo-600 text-white">
                <UsersIcon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-ink-soft">{g.name}</div>
                <div className="text-xs text-ink-faint">
                  {g.description || "No description"} - {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                </div>
              </div>
              <ChevronDown size={18} className={clsx("text-ink-faint transition-transform", expanded === g.id && "rotate-180")} />
            </button>
            {expanded === g.id && <GroupEditor group={g} users={users} onSaved={load} onDelete={() => remove(g)} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupEditor({
  group, users, onSaved, onDelete,
}: { group: Group; users: AdminUser[]; onSaved: () => Promise<void>; onDelete: () => void }) {
  const [description, setDescription] = useState(group.description);
  const [members, setMembers] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  useEffect(() => {
    void api
      .get<GroupDetailResponse>(`/admin/groups/${group.id}`)
      .then((r) => setMembers(new Set(r.members.map((m: GroupMember) => m.userId))))
      .catch(() => setMembers(new Set()));
  }, [group.id]);

  function toggle(userId: string) {
    setMembers((s) => {
      const next = new Set(s ?? []);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function save() {
    if (!members) return;
    setBusy(true);
    try {
      await api.patch(`/admin/groups/${group.id}`, { description, members: [...members] });
      push({ level: "success", title: "Group saved", body: group.name });
      await onSaved();
    } catch (err) {
      push({ level: "warning", title: "Save failed", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-slate-200 bg-white p-4">
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this group for?" />
      </Field>

      <div>
        <h4 className="mb-2 text-sm font-semibold text-ink-soft">Members</h4>
        {members === null ? (
          <p className="text-sm text-ink-faint">Loading...</p>
        ) : (
          <div className="space-y-1.5">
            {users.map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
                <input
                  type="checkbox"
                  checked={members.has(u.id)}
                  onChange={() => toggle(u.id)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                />
                <span className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: u.avatarColor }}>
                  {u.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex-1 truncate text-sm text-ink-soft">
                  {u.displayName} <span className="text-ink-faint">@{u.username}</span>
                </span>
                {u.role === "admin" && <span className="rounded-full bg-brand-100 px-1.5 text-[11px] text-brand-700">admin</span>}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={onDelete}>
          <Trash2 size={16} /> Delete group
        </Button>
        <Button loading={busy} onClick={save} disabled={members === null}>Save changes</Button>
      </div>
    </div>
  );
}

function CreateGroupForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/admin/groups", { name, description });
      push({ level: "success", title: "Group created", body: `Grant "${name}" access in Shared Folders.` });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create the group.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Group name" hint="Letters, digits, dot, dash or underscore">
          <Input value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, ""))} placeholder="editors" autoFocus />
        </Field>
        <Field label="Description (optional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="People who can edit the media library" />
        </Field>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy} disabled={name.trim().length < 2}>
          <UserPlus size={16} /> Create group
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
