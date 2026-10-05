import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Pencil, ShieldCheck, Trash2 } from "lucide-react";
import type { UserAppGrant, UserAppGrantsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { useT } from "../../../i18n/index.ts";

/**
 * Folders this user has handed to apps.
 *
 * The picker tells people they can take access back later, so there has to be a
 * place where they actually can - and it belongs here rather than in App Center,
 * because grants are per-person: two users of the same app have given it
 * different folders, and neither should see the other's.
 */
export function AppFolderAccess() {
  const t = useT();
  const [grants, setGrants] = useState<UserAppGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    const res = await api.get<UserAppGrantsResponse>("/apps/grants").catch(() => ({ grants: [] }));
    setGrants(res.grants);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(g: UserAppGrant) {
    const ok = await confirmDialog({
      title: t("cp.appAccess.revokeConfirm", { app: g.appName, folder: g.name }),
      message: t("cp.appAccess.revokeMessage", { path: g.path }),
      confirmLabel: t("cp.appAccess.revoke"),
      danger: true,
    });
    if (!ok) return;
    setBusy(g.handle);
    try {
      setGrants((await api.del<UserAppGrantsResponse>(`/apps/grants/${encodeURIComponent(g.handle)}`)).grants);
    } catch (err) {
      push({
        level: "warning",
        title: t("cp.appAccess.revokeFailed"),
        body: err instanceof ApiRequestError ? err.message : t("cp.failed"),
      });
    } finally {
      setBusy(null);
    }
  }

  if (grants === null) return null;

  // Grouped by app, because the question people arrive with is "what can this
  // app see?" rather than "what has happened to this folder?".
  const byApp = new Map<string, UserAppGrant[]>();
  for (const g of grants) {
    const list = byApp.get(g.appId);
    if (list) list.push(g);
    else byApp.set(g.appId, [g]);
  }

  return (
    <section className="mb-6">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <FolderOpen size={15} /> {t("cp.appAccess.title")}
      </h3>
      <p className="mb-2 text-xs text-ink-faint">
        {t("cp.appAccess.hint")}
      </p>

      {grants.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          {t("cp.appAccess.empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {[...byApp.entries()].map(([appId, list]) => (
            <div key={appId} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-semibold text-ink-soft">{list[0]!.appName}</span>
                {!list[0]!.appInstalled && (
                  <span className="rounded-full bg-slate-200 px-1.5 py-px text-[10px] font-medium text-ink-faint">
                    {t("cp.appAccess.notInstalled")}
                  </span>
                )}
              </div>
              <ul className="space-y-1">
                {list.map((g) => (
                  <li key={g.handle} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200/70">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-ink-soft">{g.path}</span>
                      <span className="flex items-center gap-1 text-[11px] text-ink-faint">
                        {g.mode === "readwrite" ? <Pencil size={10} /> : <ShieldCheck size={10} />}
                        {g.mode === "readwrite" ? t("cp.appAccess.canChange") : t("cp.appAccess.canRead")}
                        {g.lastUsedAt
                          ? ` - ${t("cp.appAccess.lastUsed", { date: new Date(g.lastUsedAt).toLocaleDateString() })}`
                          : ` - ${t("cp.appAccess.neverUsed")}`}
                      </span>
                    </div>
                    <button
                      onClick={() => void revoke(g)}
                      disabled={busy === g.handle}
                      title={t("cp.appAccess.revokeAccess")}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
