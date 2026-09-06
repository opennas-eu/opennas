import { useEffect, useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import type { UserAppAccessResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Toggle } from "../../ui/controls.tsx";

/**
 * Which apps one person may use.
 *
 * Loaded on open rather than with the user list, because it needs the whole app
 * catalogue and almost nobody restricts anybody - paying for that on every visit
 * to the Users page to serve the rare case would be the wrong trade.
 *
 * The always-available apps are shown ticked and disabled rather than hidden.
 * An admin who can't see Control Panel in the list would reasonably conclude
 * they had taken it away, and then wonder why the user still had it.
 */
export function UserApps({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const [data, setData] = useState<UserAppAccessResponse | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const push = useNotifications((s) => s.push);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api.get<UserAppAccessResponse>(`/admin/users/${userId}/apps`);
        if (!live) return;
        setData(res);
        setRestricted(res.restricted);
        setChosen(new Set(res.appIds));
      } catch {
        if (live) setData(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  async function save() {
    setSaving(true);
    try {
      const res = await api.put<UserAppAccessResponse>(`/admin/users/${userId}/apps`, {
        restricted,
        appIds: [...chosen],
      });
      setData(res);
      setRestricted(res.restricted);
      setChosen(new Set(res.appIds));
      push({
        level: "success",
        title: "Saved",
        body: res.restricted ? "This account can now use only the apps you picked." : "This account can use every app.",
      });
      onChanged();
    } catch (err) {
      push({
        level: "warning",
        title: "Couldn't save that",
        body: err instanceof ApiRequestError ? err.message : "Failed.",
      });
    } finally {
      setSaving(false);
    }
  }

  if (data === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-ink-faint">
        <Loader2 size={13} className="animate-spin" /> Loading apps...
      </div>
    );
  }

  const always = new Set(data.alwaysAvailable);
  const dirty = restricted !== data.restricted || !sameSet(chosen, new Set(data.appIds));

  return (
    <div className="mt-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-ink-faint"><Lock size={15} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink-soft">Limit which apps this account can use</span>
            <Toggle checked={restricted} onChange={setRestricted} label="Limit apps" />
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            Off means every app their role allows, which is how every account starts. Turning it on hides the rest from
            their desktop <em>and</em> refuses them if they go looking - it isn't only the launcher.
          </p>
        </div>
      </div>

      {restricted && (
        <div className="mt-3 grid gap-1.5 border-t border-slate-200 pt-3 sm:grid-cols-2">
          {data.available.map((app) => {
            const locked = always.has(app.id);
            const on = locked || chosen.has(app.id);
            return (
              <label
                key={app.id}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                  locked ? "text-ink-faint" : "cursor-pointer text-ink-soft hover:bg-slate-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={(e) => {
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(app.id);
                      else next.delete(app.id);
                      return next;
                    });
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <span className="truncate">{app.name}</span>
                {locked && <span className="ml-auto shrink-0 text-[10px] text-ink-faint">always on</span>}
              </label>
            );
          })}
        </div>
      )}

      {restricted && (
        <p className="mt-2 text-[11px] text-ink-faint">
          Control Panel and About can't be taken away - without Control Panel this account couldn't change its own
          password or set up a passkey. The admin-only pages inside it stay hidden either way.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button className="h-8 px-3 text-xs" loading={saving} disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
        {dirty && <span className="text-[11px] text-ink-faint">Unsaved changes</span>}
      </div>
    </div>
  );
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}
