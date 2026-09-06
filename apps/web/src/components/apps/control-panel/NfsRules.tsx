import { useState } from "react";
import { AlertTriangle, Network, Plus, ShieldAlert, Trash2 } from "lucide-react";
import type { NfsRule, Share } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button, Input, Select } from "../../ui/controls.tsx";

/**
 * Who may mount one share over NFS.
 *
 * The panel is blunt about what NFS actually is, because people reasonably
 * assume it works like SMB: there is no password here. NFS trusts whatever user
 * ids the client sends, so the address list is the entire access control, and
 * turning off root squashing hands remote root the run of the share.
 */
export function NfsRules({ share, globalNetworks, onChanged }: {
  share: Share;
  globalNetworks: string;
  onChanged: () => Promise<void>;
}) {
  const [network, setNetwork] = useState("");
  const [level, setLevel] = useState<"ro" | "rw">("ro");
  const [rootSquash, setRootSquash] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  async function add() {
    setBusy("add");
    setError(null);
    try {
      await api.post(`/admin/shares/${share.id}/nfs-rules`, { network: network.trim(), level, rootSquash });
      setNetwork("");
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't add that rule.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(rule: NfsRule) {
    // Removing the last rule silently changes where the share's access comes
    // from, so that has to be said rather than discovered.
    const last = share.nfsRules.length === 1;
    const ok = await confirmDialog({
      title: `Remove the rule for ${rule.network}?`,
      message: last
        ? `That's the only rule on this share, so it goes back to inheriting the global list (${globalNetworks || "*"}) at ${share.guestAccess === "rw" ? "read & write" : "read-only"}.`
        : "Clients on that network will no longer be able to mount this share.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(rule.id);
    try {
      await api.del(`/admin/shares/${share.id}/nfs-rules/${rule.id}`);
      await onChanged();
    } catch (err) {
      push({ level: "warning", title: "Couldn't remove that rule", body: err instanceof ApiRequestError ? err.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Network size={15} /> NFS access
      </h4>
      <p className="mb-2 text-xs text-ink-faint">
        NFS has no sign-in - it trusts whichever machine connects, so these addresses are the whole of the access
        control. Keep the list as narrow as you can.
      </p>

      {share.nfsRules.length === 0 ? (
        <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          No rules of its own, so this share uses the global list -{" "}
          <strong className="text-ink-soft">{globalNetworks || "anyone"}</strong>, at{" "}
          {share.guestAccess === "rw" ? "read & write" : "read-only"} (inherited from guest access, which is really an
          SMB setting). Add a rule below to decide it here instead.
        </p>
      ) : (
        <ul className="mb-2 space-y-1.5">
          {share.nfsRules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-200/70">
              <div className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-ink-soft">{r.network}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
                  {r.level === "rw" ? "read & write" : "read-only"}
                  {!r.rootSquash && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 py-px font-medium text-rose-700">
                      <ShieldAlert size={9} /> root not squashed
                    </span>
                  )}
                </span>
              </div>
              <button
                onClick={() => void remove(r)}
                disabled={busy === r.id}
                title="Remove rule"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && network.trim()) void add(); }}
          placeholder="192.168.1.0/24"
          className="h-8 w-44 text-xs"
        />
        <Select value={level} onChange={(e) => setLevel(e.target.value as "ro" | "rw")} className="h-8 w-32 py-0 text-xs">
          <option value="ro">Read only</option>
          <option value="rw">Read &amp; write</option>
        </Select>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
          <input
            type="checkbox"
            checked={rootSquash}
            onChange={(e) => setRootSquash(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300"
          />
          Squash remote root
        </label>
        <Button className="h-8 px-3 text-xs" loading={busy === "add"} disabled={!network.trim()} onClick={() => void add()}>
          <Plus size={13} /> Add
        </Button>
      </div>

      {!rootSquash && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 ring-1 ring-rose-200">
          <ShieldAlert size={12} className="mt-0.5 shrink-0" />
          <span>
            Without root squashing, anyone with root on a machine at that address owns every file in this share and can
            change any of it. Only do this for a machine you control as completely as this one.
          </span>
        </p>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-2 text-xs text-rose-600">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </p>
      )}
    </div>
  );
}
