import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Globe2, RefreshCw } from "lucide-react";
import type { DdnsProviderId, DdnsResponse, DdnsStatus } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Select, Toggle } from "../../ui/controls.tsx";

/**
 * Dynamic DNS.
 *
 * The token is write-only from the browser's side: it is sent when set and
 * never sent back, so the field is empty on load and left empty to keep what is
 * stored. Same shape as the SMTP password, and for the same reason.
 */

const PROVIDERS: { id: DdnsProviderId; label: string; blurb: string; needs: ("username" | "server" | "zone")[] }[] = [
  {
    id: "duckdns",
    label: "DuckDNS",
    blurb: "Free, and only needs your subdomain and token.",
    needs: [],
  },
  {
    id: "dyndns2",
    label: "No-IP, Dynu, Namecheap and others (dyndns2)",
    blurb: "The old DynDNS protocol, which most providers still speak. You'll need their update host and your account details.",
    needs: ["username", "server"],
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    blurb: "For a domain you own. Create the A record once; OpenNAS keeps it pointed here. Use a scoped API token, not your account key.",
    needs: ["zone"],
  },
];

export function Ddns() {
  const [data, setData] = useState<DdnsStatus | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  const load = useCallback(async () => {
    const res = await api.get<DdnsResponse>("/admin/ddns").catch(() => null);
    setData(res?.ddns ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (data === null) return null;
  const cfg = data.config;
  const meta = PROVIDERS.find((p) => p.id === cfg.provider) ?? PROVIDERS[0]!;

  function patch(fields: Partial<typeof cfg>) {
    setData((d) => (d ? { ...d, config: { ...d.config, ...fields } } : d));
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await api.put<DdnsResponse>("/admin/ddns", {
        enabled: cfg.enabled,
        provider: cfg.provider,
        hostname: cfg.hostname,
        username: cfg.username,
        server: cfg.server,
        zone: cfg.zone,
        // Only when the field was actually typed into.
        ...(secret ? { secret } : {}),
      });
      setSecret("");
      setData(res.ddns);
      push({ level: "success", title: "Dynamic DNS saved" });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save that.");
    } finally {
      setBusy(null);
    }
  }

  async function updateNow() {
    setBusy("update");
    setError(null);
    try {
      const res = await api.post<DdnsResponse>("/admin/ddns/update", {});
      setData(res.ddns);
      if (res.ddns.lastStatus === "error") setError(res.ddns.lastMessage);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't run the update.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-6">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Globe2 size={15} /> Dynamic DNS
      </h3>
      <p className="mb-3 text-xs text-ink-faint">
        Keeps a hostname pointed at this connection as your address changes, so the NAS stays reachable from outside by
        name. It's also what automatic HTTPS needs - a certificate can only be issued for a name that resolves here.
      </p>

      <div className="max-w-lg space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
          <div>
            <div className="text-sm font-medium text-ink-soft">Keep my hostname up to date</div>
            <div className="text-xs text-ink-faint">Checked every five minutes; only sent when the address changes.</div>
          </div>
          <Toggle checked={cfg.enabled} onChange={(v) => patch({ enabled: v })} label="Enable dynamic DNS" />
        </div>

        <Field label="Provider">
          <Select
            value={cfg.provider}
            onChange={(e) => patch({ provider: e.target.value as DdnsProviderId })}
            className="w-full"
          >
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <p className="-mt-1 text-[11px] text-ink-faint">{meta.blurb}</p>

        <Field label="Hostname" hint={cfg.provider === "duckdns" ? "your-name.duckdns.org" : "home.example.com"}>
          <Input value={cfg.hostname} onChange={(e) => patch({ hostname: e.target.value })} />
        </Field>

        {meta.needs.includes("server") && (
          <Field label="Update host" hint="e.g. dynupdate.no-ip.com">
            <Input value={cfg.server} onChange={(e) => patch({ server: e.target.value })} placeholder="dynupdate.no-ip.com" />
          </Field>
        )}
        {meta.needs.includes("username") && (
          <Field label="Username">
            <Input value={cfg.username} onChange={(e) => patch({ username: e.target.value })} autoComplete="off" />
          </Field>
        )}
        {meta.needs.includes("zone") && (
          <Field label="Zone ID" hint="On the domain's overview page in Cloudflare">
            <Input value={cfg.zone} onChange={(e) => patch({ zone: e.target.value })} autoComplete="off" />
          </Field>
        )}

        <Field
          label={cfg.provider === "cloudflare" ? "API token" : cfg.provider === "duckdns" ? "Token" : "Password"}
          hint={cfg.hasSecret ? "Stored. Leave blank to keep it." : undefined}
        >
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={cfg.hasSecret ? "••••••••" : ""}
            autoComplete="new-password"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button loading={busy === "save"} onClick={() => void save()}>Save</Button>
          <Button
            variant="secondary"
            loading={busy === "update"}
            disabled={!cfg.enabled || !cfg.hostname || (!cfg.hasSecret && !secret)}
            onClick={() => void updateNow()}
          >
            <RefreshCw size={15} /> Update now
          </Button>
        </div>

        {data.lastStatus !== "never" && (
          <div
            className={
              "flex items-start gap-2 rounded-lg px-3 py-2 text-xs ring-1 " +
              (data.lastStatus === "ok"
                ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                : "bg-rose-50 text-rose-700 ring-rose-200")
            }
          >
            {data.lastStatus === "ok" ? (
              <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            )}
            <span>
              {data.lastMessage}
              {data.lastIp && (
                <>
                  {" "}Currently <strong className="font-mono">{data.lastIp}</strong>.
                </>
              )}
              {data.lastCheckedAt && (
                <span className="block opacity-70">Last checked {new Date(data.lastCheckedAt).toLocaleString()}</span>
              )}
            </span>
          </div>
        )}

        {error && (
          <p className="flex items-start gap-2 text-xs text-rose-600">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{error}</span>
          </p>
        )}
      </div>
    </section>
  );
}
