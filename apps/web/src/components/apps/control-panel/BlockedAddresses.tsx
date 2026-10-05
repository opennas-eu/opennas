import { useCallback, useEffect, useState } from "react";
import { Ban, Info, ShieldOff, Sparkles } from "lucide-react";
import type { IpBan, IpBansResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Toggle } from "../../ui/controls.tsx";
import { useT } from "../../../i18n/index.ts";
import { fillElements } from "./fillElements.tsx";

/**
 * Addresses blocked for repeated failed sign-ins.
 *
 * Shown inside the firewall panel because that is what enforces it - and the
 * panel has to be honest when the firewall is off, since bans are still
 * *recorded* then but nothing is dropping anything.
 */
export function BlockedAddresses({ firewallActive }: { firewallActive: boolean }) {
  const t = useT();
  const [data, setData] = useState<IpBansResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    setData(await api.get<IpBansResponse>("/admin/firewall/bans").catch(() => null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function setHoneypot(enabled: boolean) {
    setBusy("honeypot");
    try {
      setData(await api.put<IpBansResponse>("/admin/firewall/honeypot", { enabled }));
    } catch (err) {
      push({
        level: "warning",
        title: t("cp.blocked.changeFailed"),
        body: err instanceof ApiRequestError ? err.message : t("cp.failed"),
      });
    } finally {
      setBusy(null);
    }
  }

  async function lift(ban: IpBan) {
    setBusy(ban.address);
    try {
      setData(await api.del<IpBansResponse>(`/admin/firewall/bans/${encodeURIComponent(ban.address)}`));
      push({ level: "success", title: t("cp.blocked.unblocked"), body: ban.address });
    } catch (err) {
      push({
        level: "warning",
        title: t("cp.blocked.unblockFailed"),
        body: err instanceof ApiRequestError ? err.message : t("cp.failed"),
      });
    } finally {
      setBusy(null);
    }
  }

  if (data === null) return null;

  return (
    <section className="mt-6">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Ban size={15} /> {t("cp.blocked.title")}
      </h3>
      <p className="mb-2 text-xs text-ink-faint">
        {t("cp.blocked.intro")}
      </p>

      {!firewallActive && data.bans.length > 0 && (
        <p className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <ShieldOff size={13} className="mt-0.5 shrink-0" />
          <span>{t("cp.blocked.firewallOff")}</span>
        </p>
      )}

      {data.bans.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          {t("cp.blocked.none")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {data.bans.map((b) => (
            <li key={b.address} className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-mono text-xs text-ink-soft">{b.address}</span>
                  {b.active ? (
                    <span className="rounded-full bg-rose-100 px-1.5 py-px text-[10px] font-medium text-rose-700">{t("cp.blocked.blocked")}</span>
                  ) : (
                    <span className="rounded-full bg-slate-200 px-1.5 py-px text-[10px] font-medium text-ink-faint">
                      {t("cp.blocked.notEnforced")}
                    </span>
                  )}
                </div>
                <span className="block text-[11px] text-ink-faint">
                  {b.reason}
                  {b.failures > 0 && ` - ${t("cp.blocked.failures", { count: b.failures })}`}
                  {` - ${t("cp.blocked.until", { time: new Date(b.expiresAt).toLocaleTimeString() })}`}
                </span>
              </div>
              <Button
                variant="ghost"
                className="h-7 shrink-0 px-2 text-xs"
                loading={busy === b.address}
                onClick={() => void lift(b)}
              >
                {t("cp.blocked.unblock")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-faint">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>{t("cp.blocked.kernelNote")}</span>
      </p>

      {/*
        The trap is presented next to the bans rather than as its own page,
        because what it does is put addresses in the list above. Showing the real
        watched paths matters: this is a feature that blocks people, and an admin
        deciding whether to leave it on should be able to see exactly what
        triggers it rather than trust a description.
      */}
      <div className="mt-5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-brand-600"><Sparkles size={15} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium text-ink-soft">{t("cp.blocked.honeypot")}</h4>
              <Toggle
                checked={data.honeypot.enabled}
                disabled={busy === "honeypot"}
                onChange={(next) => void setHoneypot(next)}
                label={t("cp.blocked.honeypot")}
              />
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              {t("cp.blocked.honeypotBody", {
                duration: t("cp.blocked.minutes", { count: Math.round(data.honeypot.banSeconds / 60) }),
              })}
            </p>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              {fillElements(t("cp.blocked.watched"), {
                paths: data.honeypot.examples.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ", "}
                    <code className="rounded bg-white px-1 py-px font-mono">{p}</code>
                  </span>
                )),
              })}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
