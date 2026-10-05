import { useCallback, useEffect, useState } from "react";
import { MonitorSmartphone, Plus, X } from "lucide-react";
import type { AutologinResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Input, Select, Toggle } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";

/**
 * Signing in automatically from a known network.
 *
 * The panel is written to make the trade visible rather than to make the feature
 * look harmless: it says plainly that anyone on those networks gets in without a
 * password, and it shows *why* an account can't be chosen instead of silently
 * omitting it - an admin looking for their own name in the list deserves to be
 * told that admins are excluded on purpose, not left wondering if it's a bug.
 */
export function Autologin() {
  const t = useT();
  const [data, setData] = useState<AutologinResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [userId, setUserId] = useState("");
  const [networks, setNetworks] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const push = useNotifications((s) => s.push);

  const apply = useCallback((res: AutologinResponse) => {
    setData(res);
    setEnabled(res.autologin.enabled);
    setUserId(res.autologin.userId ?? "");
    setNetworks(res.autologin.networks);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        apply(await api.get<AutologinResponse>("/admin/security/autologin"));
      } catch {
        setData(null);
      }
    })();
  }, [apply]);

  function addNetwork() {
    const value = draft.trim();
    if (!value || networks.includes(value)) return;
    setNetworks((n) => [...n, value]);
    setDraft("");
  }

  async function save() {
    setSaving(true);
    try {
      apply(
        await api.put<AutologinResponse>("/admin/security/autologin", {
          enabled,
          userId: userId || null,
          networks,
        }),
      );
      push({
        level: "success",
        title: t("cp.saved"),
        body: enabled ? t("cp.autologin.savedOn") : t("cp.autologin.savedOff"),
      });
    } catch (err) {
      push({
        level: "warning",
        title: t("cp.autologin.saveFailed"),
        body: err instanceof ApiRequestError ? err.message : t("cp.failed"),
      });
    } finally {
      setSaving(false);
    }
  }

  if (data === null) return null;
  const eligible = data.candidates.filter((c) => c.eligible);
  const blocked = data.candidates.filter((c) => !c.eligible);

  return (
    <div className="mb-4 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200/70">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-ink-faint ring-1 ring-slate-200">
          <MonitorSmartphone size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-soft">{t("cp.autologin.title")}</div>
          <div className="text-xs text-ink-faint">
            {t("cp.autologin.hint")}
          </div>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label={t("cp.autologin.toggle")} />
      </div>

      {enabled && (
        <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">{t("cp.autologin.signInAs")}</label>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="h-9 w-full py-0">
              <option value="">{t("cp.autologin.chooseAccount")}</option>
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} (@{c.username})
                </option>
              ))}
            </Select>
            {eligible.length === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                {t("cp.autologin.noEligible")}
              </p>
            )}
            {blocked.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {blocked.map((c) => (
                  <li key={c.id} className="text-[11px] text-ink-faint">
                    {fillElements(t("cp.autologin.cantUse", { reason: c.reason }), { user: <span className="font-medium">@{c.username}</span> })}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-ink-soft">{t("cp.autologin.networks")}</label>
            <div className="flex flex-wrap gap-1.5">
              {networks.map((n) => (
                <span
                  key={n}
                  className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-mono text-[11px] text-ink-soft ring-1 ring-slate-200"
                >
                  {n}
                  <button
                    type="button"
                    className="text-ink-faint hover:text-rose-600"
                    aria-label={t("cp.autologin.removeNetwork", { network: n })}
                    onClick={() => setNetworks((cur) => cur.filter((x) => x !== n))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {networks.length === 0 && (
                <span className="text-[11px] text-amber-700">
                  {t("cp.autologin.addOne")}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addNetwork();
                  }
                }}
                placeholder="192.168.1.40/32"
                className="h-8 flex-1 text-xs"
              />
              <Button variant="secondary" className="h-8 px-2 text-xs" onClick={addNetwork}>
                <Plus size={13} /> {t("common.add")}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">
              {fillElements(t("cp.autologin.cidrHint"), { cidr: <code className="rounded bg-white px-1 py-px font-mono">/32</code> })}
            </p>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button className="h-8 px-3 text-xs" loading={saving} onClick={() => void save()}>
          {t("common.save")}
        </Button>
        <span className="text-[11px] text-ink-faint">{t("cp.autologin.changeHint")}</span>
      </div>
    </div>
  );
}
