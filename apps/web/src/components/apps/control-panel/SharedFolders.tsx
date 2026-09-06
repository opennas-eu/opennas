import { useEffect, useState } from "react";
import { ChevronDown, Clock, FolderPlus, Gauge, Globe, HardDrive, Info, Network, RotateCcw, Trash2, Users as UsersIcon } from "lucide-react";
import { clsx } from "clsx";
import type { AccessLevel, AdminUser, Group, GroupsResponse, QuotasResponse, ServicesResponse, Share, StorageVolume, VolumeQuotaStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { formatBytes } from "../../../lib/format.ts";
import { ShareQuota } from "./ShareQuota.tsx";
import { NfsRules } from "./NfsRules.tsx";
import { Button, Field, Input, Select, Toggle } from "../../ui/controls.tsx";
import { FolderRules } from "./FolderRules.tsx";

export function SharedFolders() {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [quotas, setQuotas] = useState<QuotasResponse>({ volumes: [], perUserNote: "" });
  // Needed only so the NFS panel can say what a share without rules inherits.
  const [nfsNetworks, setNfsNetworks] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  async function load() {
    const [s, u, g, q, svc] = await Promise.all([
      api.get<{ shares: Share[] }>("/admin/shares"),
      api.get<{ users: AdminUser[] }>("/admin/users"),
      api.get<GroupsResponse>("/admin/groups").catch(() => ({ groups: [] })),
      api.get<QuotasResponse>("/admin/quotas").catch(() => ({ volumes: [], perUserNote: "" })),
      api.get<ServicesResponse>("/admin/services").catch(() => null),
    ]);
    setShares(s.shares);
    setUsers(u.users);
    setGroups(g.groups);
    setQuotas(q);
    setNfsNetworks(svc?.config.nfs.allowedNetworks ?? "");
  }
  useEffect(() => { void load(); }, []);

  async function remove(share: Share) {
    if (!(await confirmDialog({
      title: `Remove the "${share.name}" share?`,
      message: "Removes the share definition. The folder and its files stay on disk.",
      confirmLabel: "Remove share",
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/shares/${share.id}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: "Couldn't remove share", body: err instanceof ApiRequestError ? err.message : "Failed." });
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Shared Folders</h2>
          <p className="text-sm text-ink-faint">
            Folders exposed to users and over SMB/NFS, with per-user and per-group permissions and folder-level rules.
          </p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate((s) => !s)}>
          <FolderPlus size={16} /> Create
        </Button>
      </div>

      {showCreate && <CreateShareForm onDone={async () => { setShowCreate(false); await load(); }} />}

      <div className="space-y-2">
        {shares === null && <p className="text-sm text-ink-faint">Loading...</p>}
        {shares?.length === 0 && !showCreate && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            No shared folders yet. Create one to grant users access and expose it over SMB/NFS.
          </div>
        )}
        {shares?.map((share) => (
          <div key={share.id} className="overflow-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200/70">
            <button onClick={() => setExpanded(expanded === share.id ? null : share.id)} className="flex w-full items-center gap-3 p-3.5 text-left">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white">
                <HardDrive size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-ink-soft">{share.name}</span>
                  {share.smbEnabled && <Badge icon={<Network size={11} />}>SMB</Badge>}
                  {share.nfsEnabled && <Badge icon={<Network size={11} />}>NFS</Badge>}
                  {share.volume && <Badge icon={<HardDrive size={11} />}>{share.volume}</Badge>}
                  {share.guestAccess !== "none" && <Badge icon={<Globe size={11} />}>guest {share.guestAccess}</Badge>}
                  {share.groupPermissions.length > 0 && (
                    <Badge icon={<UsersIcon size={11} />}>
                      {share.groupPermissions.length} group{share.groupPermissions.length === 1 ? "" : "s"}
                    </Badge>
                  )}
                  {share.recycleEnabled && <Badge icon={<RotateCcw size={11} />}>recycle</Badge>}
                  {share.timeMachineEnabled && <Badge icon={<Clock size={11} />}>time machine</Badge>}
                  {share.quotaBytes > 0 && (
                    <Badge icon={<Gauge size={11} />}>
                      {share.quotaUsedBytes != null ? `${formatBytes(share.quotaUsedBytes)} / ` : ""}
                      {formatBytes(share.quotaBytes)}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-ink-faint">
                          {share.comment || "No description"} - {share.permissions.length} user{share.permissions.length === 1 ? "" : "s"}
                  {share.sizeBytes != null ? ` - ${formatBytes(share.sizeBytes)}` : ""}
                </div>
              </div>
              <ChevronDown size={18} className={clsx("text-ink-faint transition-transform", expanded === share.id && "rotate-180")} />
            </button>

            {expanded === share.id && (
              <ShareEditor
                share={share}
                users={users}
                groups={groups}
                quota={quotas.volumes.find((v: VolumeQuotaStatus) => v.volume === share.volume) ?? null}
                perUserNote={quotas.perUserNote}
                nfsNetworks={nfsNetworks}
                onSaved={load}
                onDelete={() => remove(share)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareEditor({
  share, users, groups, quota, perUserNote, nfsNetworks, onSaved, onDelete,
}: {
  share: Share; users: AdminUser[]; groups: Group[];
  quota: VolumeQuotaStatus | null; perUserNote: string; nfsNetworks: string;
  onSaved: () => Promise<void>; onDelete: () => void;
}) {
  const [comment, setComment] = useState(share.comment);
  const [guestAccess, setGuestAccess] = useState<AccessLevel>(share.guestAccess);
  const [smbEnabled, setSmb] = useState(share.smbEnabled);
  const [nfsEnabled, setNfs] = useState(share.nfsEnabled);
  const [browseable, setBrowseable] = useState(share.browseable);
  const [recycleEnabled, setRecycle] = useState(share.recycleEnabled);
  const [timeMachineEnabled, setTimeMachine] = useState(share.timeMachineEnabled);
  const [perms, setPerms] = useState<Record<string, AccessLevel>>(() => {
    const m: Record<string, AccessLevel> = {};
    for (const p of share.permissions) m[p.userId] = p.level;
    return m;
  });
  const [groupPerms, setGroupPerms] = useState<Record<string, AccessLevel>>(() => {
    const m: Record<string, AccessLevel> = {};
    for (const p of share.groupPermissions) m[p.groupId] = p.level;
    return m;
  });
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/admin/shares/${share.id}`, {
        comment, guestAccess, smbEnabled, nfsEnabled, browseable, recycleEnabled, timeMachineEnabled,
        permissions: Object.entries(perms).filter(([, l]) => l !== "none").map(([userId, level]) => ({ userId, level })),
        groupPermissions: Object.entries(groupPerms).filter(([, l]) => l !== "none").map(([groupId, level]) => ({ groupId, level })),
      });
      push({ level: "success", title: "Share saved", body: `"${share.name}" updated.` });
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
        <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What's this folder for?" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <ToggleRow label="Share over SMB" hint="Windows/macOS file sharing" checked={smbEnabled} onChange={setSmb} />
        <ToggleRow label="Share over NFS" hint="Unix/Linux file sharing" checked={nfsEnabled} onChange={setNfs} />
        <ToggleRow label="Browseable" hint="Visible when browsing the network" checked={browseable} onChange={setBrowseable} />
        <ToggleRow
          label="Recycle bin over SMB"
          hint="A delete from Windows or macOS moves the file aside instead of destroying it"
          checked={recycleEnabled}
          onChange={setRecycle}
        />
        <ToggleRow
          label="Time Machine backups"
          hint="Offer this folder to macOS as a backup destination"
          checked={timeMachineEnabled}
          onChange={setTimeMachine}
        />
        <Field label="Guest access">
          <Select value={guestAccess} onChange={(e) => setGuestAccess(e.target.value as AccessLevel)} className="w-full">
            <option value="none">No guest access</option>
            <option value="ro">Read only</option>
            <option value="rw">Read &amp; write</option>
          </Select>
        </Field>
      </div>

      {timeMachineEnabled && (!smbEnabled || guestAccess !== "none") && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            {!smbEnabled
              ? "Time Machine works over SMB, so this folder needs SMB sharing switched on before macOS can use it."
              : "Time Machine requires authenticated access. Set guest access to 'No guest access' to enable backups."}
          </span>
        </p>
      )}
      {timeMachineEnabled && smbEnabled && guestAccess === "none" && share.quotaBytes === 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            With no size limit, Time Machine will fill the whole volume - and every other share on it. Set a limit so
            macOS clears out old backups instead.
          </span>
        </p>
      )}

      {groups.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-ink-soft">Group permissions</h4>
          <p className="mb-2 text-xs text-ink-faint">
            Everyone in the group gets this. Where a person's own permission and their groups' disagree, the most
            permissive wins.
          </p>
          <div className="space-y-1.5">
            {groups.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-indigo-600 text-white">
                  <UsersIcon size={12} />
                </span>
                <span className="flex-1 truncate text-sm text-ink-soft">
                  {g.name} <span className="text-ink-faint">- {g.memberCount} member{g.memberCount === 1 ? "" : "s"}</span>
                </span>
                <Select
                  value={groupPerms[g.id] ?? "none"}
                  onChange={(e) => setGroupPerms((m) => ({ ...m, [g.id]: e.target.value as AccessLevel }))}
                  className="h-8 py-0 text-xs"
                >
                  <option value="none">No access</option>
                  <option value="ro">Read only</option>
                  <option value="rw">Read &amp; write</option>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-sm font-semibold text-ink-soft">User permissions</h4>
        <div className="space-y-1.5">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
              <span className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: u.avatarColor }}>
                {u.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex-1 truncate text-sm text-ink-soft">{u.displayName} <span className="text-ink-faint">@{u.username}</span></span>
              <Select
                value={perms[u.id] ?? "none"}
                onChange={(e) => setPerms((m) => ({ ...m, [u.id]: e.target.value as AccessLevel }))}
                className="h-8 py-0 text-xs"
              >
                <option value="none">No access</option>
                <option value="ro">Read only</option>
                <option value="rw">Read &amp; write</option>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <ShareQuota share={share} status={quota} perUserNote={perUserNote} onChanged={onSaved} />

      {share.nfsEnabled && (
        <NfsRules share={share} globalNetworks={nfsNetworks} onChanged={onSaved} />
      )}

      <FolderRules share={share} users={users} groups={groups} />

      <div className="flex items-center justify-between">
        <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={onDelete}>
          <Trash2 size={16} /> Remove share
        </Button>
        <Button loading={busy} onClick={save}>Save changes</Button>
      </div>
    </div>
  );
}

function CreateShareForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [smbEnabled, setSmb] = useState(true);
  const [volume, setVolume] = useState(""); // "" = default share root
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const push = useNotifications((s) => s.push);

  // Load the data volumes the share can be placed on.
  useEffect(() => {
    void api
      .get<{ volumes: StorageVolume[] }>("/admin/volumes")
      .then((r) => setVolumes(r.volumes))
      .catch(() => setVolumes([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Only send `volume` when a real volume is picked (omit for default root).
      await api.post("/admin/shares", { name, comment, smbEnabled, ...(volume ? { volume } : {}) });
      push({ level: "success", title: "Share created", body: `"${name}" is ready. Set permissions to grant access.` });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Failed to create share.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Folder name" hint="Created under the chosen location">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Media" autoFocus />
        </Field>
        <Field label="Description (optional)">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Movies & shows" />
        </Field>
      </div>
      <Field
        label="Location"
        hint={
          volumes.length
            ? "Which storage volume this share's files live on"
            : "No data volumes found - using the default share root. Add one in Storage."
        }
      >
        <Select value={volume} onChange={(e) => setVolume(e.target.value)} className="w-full" disabled={volumes.length === 0}>
          <option value="">Default location (system volume)</option>
          {volumes.map((v) => (
            <option key={v.label} value={v.label}>
              {v.label}
              {v.freeBytes != null ? ` - ${formatBytes(v.freeBytes)} free` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <ToggleRow label="Share over SMB now" hint="You can change this and add NFS after creating" checked={smbEnabled} onChange={setSmb} />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}><FolderPlus size={16} /> Create share</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
      <div>
        <div className="text-sm font-medium text-ink-soft">{label}</div>
        {hint && <div className="text-xs text-ink-faint">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Badge({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
      {icon} {children}
    </span>
  );
}
