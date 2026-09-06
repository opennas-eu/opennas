import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Info, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import type {
  FirewallApplyResponse, FirewallConfig, FirewallResponse, FirewallService, FirewallServiceId,
} from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { BlockedAddresses } from "./BlockedAddresses.tsx";
import { Button, Input, Toggle } from "../../ui/controls.tsx";

/**
 * Host firewall.
 *
 * The dangerous part of this screen isn't a wrong rule, it's a rule that works:
 * "only my subnet may reach this NAS" is exactly right until you're not on that
 * subnet, and then the box is gone. So applying stages the change and starts a
 * countdown - confirm from a connection that still works, or it puts the old
 * rules back by itself.
 */
export function Firewall() {
  const push = useNotifications((s) => s.push);
  const [data, setData] = useState<FirewallResponse | null>(null);
  const [draft, setDraft] = useState<FirewallConfig | null>(null);
  const [network, setNetwork] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [pending, setPending] = useState<{ token: string; left: number } | null>(null);
  const tick = useRef<number | null>(null);

  async function load() {
    try {
      const res = await api.get<FirewallResponse>("/admin/firewall");
      setData(res);
      setDraft(res.config);
    } catch {
      setData(null);
    }
  }
  useEffect(() => { void load(); }, []);

  // The countdown is cosmetic - the server holds the real timer - but it has to
  // stop when the component goes away, or it keeps ticking against nothing.
  useEffect(() => {
    if (!pending) return;
    tick.current = window.setInterval(() => {
      setPending((p) => {
        if (!p) return null;
        if (p.left <= 1) { void load(); return null; }
        return { ...p, left: p.left - 1 };
      });
    }, 1000);
    return () => { if (tick.current) window.clearInterval(tick.current); };
  }, [pending?.token]);

  if (!data || !draft) return <p className="text-sm text-ink-faint">Loading...</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);

  function toggleService(id: FirewallServiceId, on: boolean) {
    setDraft((d) => d && ({
      ...d,
      allowed: on ? [...new Set([...d.allowed, id])] : d.allowed.filter((x) => x !== id),
    }));
  }

  function addNetwork() {
    const value = network.trim();
    if (!value) return;
    setDraft((d) => d && ({ ...d, trustedNetworks: [...new Set([...d.trustedNetworks, value])] }));
    setNetwork("");
  }

  async function apply() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<FirewallApplyResponse>("/admin/firewall", draft);
      setData((d) => d && ({ ...d, config: res.config, preview: res.preview }));
      setDraft(res.config);
      if (res.pending) {
        setPending({ token: res.pending.token, left: res.pending.revertsInSeconds });
      } else {
        push({ level: "success", title: draft.enabled ? "Firewall updated" : "Firewall turned off" });
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't apply those rules.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending) return;
    try {
      await api.post("/admin/firewall/confirm", { token: pending.token });
      setPending(null);
      push({ level: "success", title: "Firewall rules kept" });
      await load();
    } catch {
      // The timer almost certainly won; reload rather than guess.
      setPending(null);
      await load();
    }
  }

  async function undo() {
    try {
      await api.post("/admin/firewall/revert", {});
      push({ level: "success", title: "Previous rules restored" });
    } catch { /* the timer may already have done it */ }
    setPending(null);
    await load();
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><ShieldCheck size={20} /> Firewall</h2>
        <p className="text-sm text-ink-faint">
          Choose what this NAS accepts from the network. Anything not listed here is refused.
        </p>
      </div>

      {!data.available && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
          <Info size={15} className="mt-0.5 shrink-0" />
          <span>{data.unavailableReason}</span>
        </div>
      )}

      {/* The confirm-or-revert window. */}
      {pending && (
        <div className="mb-4 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle size={16} /> Still there? Confirm these rules
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            The new rules are live. If they've cut off anything you need, do nothing - the previous rules come back
            automatically in <strong>{pending.left}s</strong>. This message only reaches you because your connection
            still works.
          </p>
          <div className="mt-3 flex gap-2">
            <Button className="h-8 px-3 py-0 text-xs" onClick={confirm}><Check size={14} /> Keep these rules</Button>
            <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={undo}><X size={14} /> Undo now</Button>
          </div>
        </div>
      )}

      <section className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium text-ink-soft">Turn the firewall on</span>
            <span className="block text-xs text-ink-faint">
              Blocks everything inbound except what you allow below. The web interface always stays reachable.
            </span>
          </span>
          <Toggle
            checked={draft.enabled}
            onChange={(v) => setDraft({ ...draft, enabled: v })}
            label="Turn the firewall on"
          />
        </label>
      </section>

      <section className="mt-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <h3 className="mb-3 text-sm font-semibold text-ink-soft">What's allowed in</h3>
        <div className="space-y-2">
          {data.services.map((s: FirewallService) => (
            <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3.5 py-2.5 ring-1 ring-slate-200">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink-soft">
                  {s.name}
                  <span className="ml-2 font-mono text-[11px] font-normal text-ink-faint">
                    {s.ports.map((p) => `${p.port}/${p.proto}`).join(" ")}
                  </span>
                </div>
                <div className="text-xs text-ink-faint">{s.description}</div>
              </div>
              {s.alwaysOn ? (
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-ink-faint">always on</span>
              ) : (
                <Toggle
                  checked={draft.allowed.includes(s.id)}
                  onChange={(v) => toggleService(s.id, v)}
                  label={s.name}
                />
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
        <h3 className="mb-1 text-sm font-semibold text-ink-soft">Trusted networks</h3>
        <p className="mb-3 text-xs text-ink-faint">
          Addresses or ranges - <code className="font-mono">192.168.1.0/24</code>, <code className="font-mono">10.0.0.5</code>,
          <code className="font-mono"> fd00::/8</code>. Normally these reach everything regardless of the toggles above.
        </p>

        <div className="mb-3 flex gap-2">
          <Input
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            placeholder="192.168.1.0/24"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNetwork(); } }}
          />
          <Button variant="secondary" className="shrink-0" onClick={addNetwork} disabled={!network.trim()}>
            <Plus size={15} /> Add
          </Button>
        </div>

        {draft.trustedNetworks.length === 0 ? (
          <p className="text-xs text-ink-faint">None yet.</p>
        ) : (
          <div className="space-y-1.5">
            {draft.trustedNetworks.map((n) => (
              <div key={n} className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200">
                <code className="flex-1 font-mono text-xs text-ink-soft">{n}</code>
                <button
                  aria-label={`Remove ${n}`}
                  onClick={() => setDraft({ ...draft, trustedNetworks: draft.trustedNetworks.filter((x) => x !== n) })}
                  className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <label className="mt-3 flex items-start gap-2.5 rounded-lg bg-white px-3 py-2.5 ring-1 ring-slate-200">
          <input
            type="checkbox"
            checked={draft.restrictToTrusted}
            disabled={draft.trustedNetworks.length === 0}
            onChange={(e) => setDraft({ ...draft, restrictToTrusted: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 disabled:opacity-40"
          />
          <span>
            <span className="block text-sm font-medium text-ink-soft">Accept connections only from these networks</span>
            <span className="block text-xs text-ink-faint">
              Everything else is refused outright, including the web interface. Make sure you're on one of these
              networks before applying - you'll be asked to confirm afterwards.
            </span>
          </span>
        </label>
      </section>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <Button loading={busy} onClick={apply} disabled={!dirty || pending !== null}>
          {draft.enabled ? "Apply rules" : "Save"}
        </Button>
        {dirty && <span className="text-xs text-ink-faint">Unsaved changes</span>}
        <span className="flex-1" />
        <button onClick={() => setShowRules((v) => !v)} className="text-xs text-ink-faint transition hover:text-ink-soft">
          {showRules ? "Hide" : "Show"} generated rules
        </button>
      </div>

      {showRules && (
        <pre className="opennas-scroll mt-3 max-h-80 overflow-auto rounded-xl bg-slate-900 p-3.5 font-mono text-[11px] leading-relaxed text-slate-200">
          {data.preview}
        </pre>
      )}

      <BlockedAddresses firewallActive={data.available && data.config.enabled} />
    </div>
  );
}
