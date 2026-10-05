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
import { useT } from "../../../i18n/index.ts";

export function SharedFolders() {
  const t = useT();
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
      title: t("cp.shares.removeTitle", { name: share.name }),
      message: t("cp.shares.removeMessage"),
      confirmLabel: t("cp.shares.removeShare"),
      danger: true,
    }))) return;
    try {
      await api.del(`/admin/shares/${share.id}`);
      await load();
    } catch (err) {
      push({ level: "warning", title: t("cp.shares.removeFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t("shares.title")}</h2>
          <p className="text-sm text-ink-faint">
            {t("cp.shares.subtitle")}
          </p>
        </div>
        <Button className="h-9" onClick={() => setShowCreate((s) => !s)}>
          <FolderPlus size={16} /> {t("common.create")}
        </Button>
      </div>

      {showCreate && <CreateShareForm onDone={async () => { setShowCreate(false); await load(); }} />}

      <div className="space-y-2">
        {shares === null && <p className="text-sm text-ink-faint">{t("desktop.loading")}</p>}
        {shares?.length === 0 && !showCreate && (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-ink-faint">
            {t("cp.shares.empty")}
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
                  {share.guestAccess !== "none" && <Badge icon={<Globe size={11} />}>{t("cp.shares.guestBadge", { level: share.guestAccess })}</Badge>}
                  {share.groupPermissions.length > 0 && (
                    <Badge icon={<UsersIcon size={11} />}>
                      {t("cp.shares.groupCount", { count: share.groupPermissions.length })}
                    </Badge>
                  )}
                  {share.recycleEnabled && <Badge icon={<RotateCcw size={11} />}>{t("cp.shares.recycleBadge")}</Badge>}
                  {share.timeMachineEnabled && <Badge icon={<Clock size={11} />}>{t("cp.shares.timeMachineBadge")}</Badge>}
                  {share.quotaBytes > 0 && (
                    <Badge icon={<Gauge size={11} />}>
                      {share.quotaUsedBytes != null ? `${formatBytes(share.quotaUsedBytes)} / ` : ""}
                      {formatBytes(share.quotaBytes)}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-ink-faint">
                          {share.comment || t("cp.shares.noDescription")} - {t("cp.shares.userCount", { count: share.permissions.length })}
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
  const t = useT();

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/admin/shares/${share.id}`, {
        comment, guestAccess, smbEnabled, nfsEnabled, browseable, recycleEnabled, timeMachineEnabled,
        permissions: Object.entries(perms).filter(([, l]) => l !== "none").map(([userId, level]) => ({ userId, level })),
        groupPermissions: Object.entries(groupPerms).filter(([, l]) => l !== "none").map(([groupId, level]) => ({ groupId, level })),
      });
      push({ level: "success", title: t("cp.shares.saved"), body: t("cp.shares.savedBody", { name: share.name }) });
      await onSaved();
    } catch (err) {
      push({ level: "warning", title: t("cp.shares.saveFailed"), body: err instanceof ApiRequestError ? err.message : t("cp.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-slate-200 bg-white p-4">
      <Field label={t("common.description")}>
        <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("cp.shares.descriptionPlaceholder")} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <ToggleRow label={t("shares.smb")} hint={t("shares.smbHint")} checked={smbEnabled} onChange={setSmb} />
        <ToggleRow label={t("shares.nfs")} hint={t("shares.nfsHint")} checked={nfsEnabled} onChange={setNfs} />
        <ToggleRow label={t("shares.browseable")} hint={t("shares.browseableHint")} checked={browseable} onChange={setBrowseable} />
        <ToggleRow
          label={t("shares.recycle")}
          hint={t("cp.shares.recycleHint")}
          checked={recycleEnabled}
          onChange={setRecycle}
        />
        <ToggleRow
          label={t("shares.timeMachine")}
          hint={t("shares.timeMachineHint")}
          checked={timeMachineEnabled}
          onChange={setTimeMachine}
        />
        <Field label={t("shares.guestAccess")}>
          <Select value={guestAccess} onChange={(e) => setGuestAccess(e.target.value as AccessLevel)} className="w-full">
            <option value="none">{t("shares.noGuestAccess")}</option>
            <option value="ro">{t("common.readOnly")}</option>
            <option value="rw">{t("common.readWrite")}</option>
          </Select>
        </Field>
      </div>

      {timeMachineEnabled && (!smbEnabled || guestAccess !== "none") && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            {!smbEnabled
              ? t("cp.shares.tmNeedsSmb")
              : t("cp.shares.tmNeedsAuth")}
          </span>
        </p>
      )}
      {timeMachineEnabled && smbEnabled && guestAccess === "none" && share.quotaBytes === 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("cp.shares.tmNoLimit")}
          </span>
        </p>
      )}

      {groups.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-ink-soft">{t("cp.shares.groupPermissions")}</h4>
          <p className="mb-2 text-xs text-ink-faint">
            {t("cp.shares.groupPermissionsHint")}
          </p>
          <div className="space-y-1.5">
            {groups.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-indigo-600 text-white">
                  <UsersIcon size={12} />
                </span>
                <span className="flex-1 truncate text-sm text-ink-soft">
                  {g.name} <span className="text-ink-faint">- {t("cp.shares.memberCount", { count: g.memberCount })}</span>
                </span>
                <Select
                  value={groupPerms[g.id] ?? "none"}
                  onChange={(e) => setGroupPerms((m) => ({ ...m, [g.id]: e.target.value as AccessLevel }))}
                  className="h-8 py-0 text-xs"
                >
                  <option value="none">{t("cp.shares.noAccess")}</option>
                  <option value="ro">{t("common.readOnly")}</option>
                  <option value="rw">{t("common.readWrite")}</option>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-sm font-semibold text-ink-soft">{t("cp.shares.userPermissions")}</h4>
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
                <option value="none">{t("cp.shares.noAccess")}</option>
                <option value="ro">{t("common.readOnly")}</option>
                <option value="rw">{t("common.readWrite")}</option>
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
          <Trash2 size={16} /> {t("cp.shares.removeShare")}
        </Button>
        <Button loading={busy} onClick={save}>{t("common.saveChanges")}</Button>
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
  const t = useT();

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
      push({ level: "success", title: t("cp.shares.created"), body: t("cp.shares.createdBody", { name }) });
      onDone();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t("cp.shares.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("cp.shares.folderName")} hint={t("cp.shares.folderNameHint")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cp.shares.folderNameExample")} autoFocus />
        </Field>
        <Field label={t("cp.shares.descriptionOptional")}>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("cp.shares.descriptionExample")} />
        </Field>
      </div>
      <Field
        label={t("cp.shares.location")}
        hint={
          volumes.length
            ? t("cp.shares.locationHint")
            : t("cp.shares.noVolumes")
        }
      >
        <Select value={volume} onChange={(e) => setVolume(e.target.value)} className="w-full" disabled={volumes.length === 0}>
          <option value="">{t("cp.shares.defaultLocation")}</option>
          {volumes.map((v) => (
            <option key={v.label} value={v.label}>
              {v.label}
              {v.freeBytes != null ? ` - ${t("cp.shares.free", { size: formatBytes(v.freeBytes) })}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <ToggleRow label={t("cp.shares.smbNow")} hint={t("cp.shares.smbNowHint")} checked={smbEnabled} onChange={setSmb} />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy}><FolderPlus size={16} /> {t("cp.shares.createShare")}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t("common.cancel")}</Button>
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
