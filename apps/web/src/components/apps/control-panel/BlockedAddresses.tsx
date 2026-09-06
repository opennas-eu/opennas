import { useCallback, useEffect, useState } from "react";
import { Ban, Info, ShieldOff, Sparkles } from "lucide-react";
import type { IpBan, IpBansResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Toggle } from "../../ui/controls.tsx";

/**
 * Addresses blocked for repeated failed sign-ins.
 *
 * Shown inside the firewall panel because that is what enforces it - and the
 * panel has to be honest when the firewall is off, since bans are still
 * *recorded* then but nothing is dropping anything.
 */
export function BlockedAddresses({ firewallActive }: { firewallActive: boolean }) {
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
        title: "Couldn't change that",
        body: err instanceof ApiRequestError ? err.message : "Failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function lift(ban: IpBan) {
    setBusy(ban.address);
    try {
      setData(await api.del<IpBansResponse>(`/admin/firewall/bans/${encodeURIComponent(ban.address)}`));
      push({ level: "success", title: "Unblocked", body: ban.address });
    } catch (err) {
      push({
        level: "warning",
        title: "Couldn't unblock that address",
        body: err instanceof ApiRequestError ? err.message : "Failed.",
      });
    } finally {
      setBusy(null);
    }
  }

  if (data === null) return null;

  return (
    <section className="mt-6">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Ban size={15} /> Blocked addresses
      </h3>
      <p className="mb-2 text-xs text-ink-faint">
        An address that keeps failing to sign in is blocked for an hour. Your own networks are never blocked, so you
        can't lock yourself out.
      </p>

      {!firewallActive && data.bans.length > 0 && (
        <p className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <ShieldOff size={13} className="mt-0.5 shrink-0" />
          <span>
            The firewall is off, so nothing is actually being blocked. These are recorded so you can see what would
            have been - turning the firewall on starts enforcing them.
          </span>
        </p>
      )}

      {data.bans.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-faint ring-1 ring-slate-200/70">
          No addresses are blocked.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {data.bans.map((b) => (
            <li key={b.address} className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/70">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-mono text-xs text-ink-soft">{b.address}</span>
                  {b.active ? (
                    <span className="rounded-full bg-rose-100 px-1.5 py-px text-[10px] font-medium text-rose-700">blocked</span>
                  ) : (
                    <span className="rounded-full bg-slate-200 px-1.5 py-px text-[10px] font-medium text-ink-faint">
                      not enforced
                    </span>
                  )}
                </div>
                <span className="block text-[11px] text-ink-faint">
                  {b.reason}
                  {b.failures > 0 && ` - ${b.failures} failed attempts`}
                  {` - until ${new Date(b.expiresAt).toLocaleTimeString()}`}
                </span>
              </div>
              <Button
                variant="ghost"
                className="h-7 shrink-0 px-2 text-xs"
                loading={busy === b.address}
                onClick={() => void lift(b)}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-faint">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          Blocks are held by the kernel with their own expiry, so they lift themselves even if OpenNAS is stopped - and
          a restart of the NAS clears them all.
        </span>
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
              <h4 className="text-sm font-medium text-ink-soft">Trap scanners on sight</h4>
              <Toggle
                checked={data.honeypot.enabled}
                disabled={busy === "honeypot"}
                onChange={(next) => void setHoneypot(next)}
                label="Trap scanners on sight"
              />
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              Most attacks on a NAS never touch the sign-in form - they work through a list of paths hoping to find
              some other software running. Nothing legitimate ever asks a NAS for those, so one request is enough:
              the address is blocked for {Math.round(data.honeypot.banSeconds / 60)} minutes straight away, instead of
              being given the twenty tries the sign-in counter allows.
            </p>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              Watched paths include{" "}
              {data.honeypot.examples.map((p, i) => (
                <span key={p}>
                  {i > 0 && ", "}
                  <code className="rounded bg-white px-1 py-px font-mono">{p}</code>
                </span>
              ))}
              . Your own network is exempt - loopback, every private range and anything you've marked trusted - so
              this can only ever block something coming in from the internet.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
