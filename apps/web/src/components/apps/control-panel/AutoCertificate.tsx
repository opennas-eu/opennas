import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Globe, Info, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AcmeResponse, AcmeSettings } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { Button, Field, Input, Select, Toggle } from "../../ui/controls.tsx";

/**
 * Automatic certificates from Let's Encrypt (or any ACME CA).
 *
 * The screen is mostly about setting expectations, because the part that fails
 * isn't in OpenNAS: the name has to resolve to this machine and port 80 has to
 * be reachable from the internet. Saying that up front, and again in the error,
 * is worth more than any amount of retry logic.
 */

const STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
const PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";

export function AutoCertificate({ onIssued }: { onIssued: () => void }) {
  const push = useNotifications((s) => s.push);
  const [data, setData] = useState<AcmeResponse | null>(null);
  const [draft, setDraft] = useState<AcmeSettings | null>(null);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "request" | null>(null);
  const poll = useRef<number | null>(null);

  async function load() {
    try {
      const res = await api.get<AcmeResponse>("/admin/tls/acme");
      setData(res);
      setDraft((d) => d ?? res.settings);
      return res;
    } catch {
      return null;
    }
  }
  useEffect(() => { void load(); }, []);

  // While a request is in flight the result arrives out of band, so poll - but
  // only then, and stop as soon as it settles.
  useEffect(() => {
    if (data?.state.status !== "running") {
      if (poll.current) { window.clearInterval(poll.current); poll.current = null; }
      return;
    }
    poll.current = window.setInterval(() => {
      void load().then((res) => {
        if (res && res.state.status !== "running") {
          if (res.state.status === "ok") {
            push({ level: "success", title: "Certificate issued", body: res.state.certDomains.join(", ") });
            onIssued();
          } else if (res.state.lastError) {
            push({ level: "warning", title: "Certificate request failed", body: res.state.lastError });
          }
        }
      });
    }, 3000);
    return () => { if (poll.current) window.clearInterval(poll.current); };
  }, [data?.state.status]);

  if (!data || !draft) return <p className="text-sm text-ink-faint">Loading...</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const running = data.state.status === "running";

  function addDomain() {
    const value = domain.trim().toLowerCase();
    if (!value || !draft) return;
    setDraft({ ...draft, domains: [...new Set([...draft.domains, value])] });
    setDomain("");
  }

  async function save() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      await api.put("/admin/tls/acme", draft);
      await load();
      push({ level: "success", title: "Saved" });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save those settings.");
    } finally {
      setBusy(null);
    }
  }

  async function request() {
    setBusy("request");
    setError(null);
    try {
      await api.post("/admin/tls/acme/request", {});
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't start the request.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
          <Globe size={16} /> Automatic certificate (Let's Encrypt)
        </h3>
        <Toggle
          checked={draft.enabled}
          onChange={(v) => setDraft({ ...draft, enabled: v })}
          label="Automatic certificate"
        />
      </div>
      <p className="mb-3 text-xs text-ink-faint">
        Gets a certificate browsers trust, and renews it a month before it expires - no more warning page.
      </p>

      {!data.available && (
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{data.unavailableReason}</span>
        </div>
      )}

      {draft.enabled && (
        <>
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-white px-3 py-2.5 text-xs text-ink-faint ring-1 ring-slate-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <div>
              <strong className="font-medium text-ink-soft">Two things have to be true before this can work.</strong> Each
              name below must resolve to this machine's public address, and port&nbsp;80 must be reachable from the
              internet - that's how the certificate authority checks the name is yours. On a home connection that
              usually means a port-forward on the router.
            </div>
          </div>

          <Field label="Domain names" hint="One per line. The first is the certificate's main name.">
            <div className="flex gap-2">
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="nas.example.com"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDomain(); } }}
              />
              <Button variant="secondary" className="shrink-0" onClick={addDomain} disabled={!domain.trim()}>
                <Plus size={15} /> Add
              </Button>
            </div>
          </Field>

          {draft.domains.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {draft.domains.map((d) => (
                <div key={d} className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200">
                  <code className="flex-1 font-mono text-xs text-ink-soft">{d}</code>
                  <button
                    aria-label={`Remove ${d}`}
                    onClick={() => setDraft({ ...draft, domains: draft.domains.filter((x) => x !== d) })}
                    className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-rose-500 hover:text-white"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Contact email" hint="The CA warns you here if renewal ever stops working.">
              <Input
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Certificate authority">
              <Select
                value={draft.directoryUrl}
                onChange={(e) => setDraft({ ...draft, directoryUrl: e.target.value })}
                className="w-full"
              >
                <option value={PRODUCTION}>Let's Encrypt</option>
                <option value={STAGING}>Let's Encrypt (staging - untrusted, for testing)</option>
              </Select>
            </Field>
          </div>

          <label className="mt-3 flex items-start gap-2.5 rounded-lg bg-white px-3 py-2.5 ring-1 ring-slate-200">
            <input
              type="checkbox"
              checked={draft.agreedTos}
              onChange={(e) => setDraft({ ...draft, agreedTos: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600"
            />
            <span className="text-sm text-ink-soft">
              I accept the certificate authority's{" "}
              {data.termsOfService ? (
                <a href={data.termsOfService} target="_blank" rel="noreferrer noopener" className="text-brand-600 hover:underline">
                  terms of service
                </a>
              ) : (
                "terms of service"
              )}
            </span>
          </label>
        </>
      )}

      {/* --- what happened last time --- */}
      {data.state.status !== "never" && (
        <div className="mt-3 rounded-lg bg-white px-3 py-2.5 text-xs ring-1 ring-slate-200">
          {running ? (
            <span className="flex items-center gap-2 text-ink-soft">
              <Loader2 size={14} className="animate-spin" /> Requesting a certificate - this usually takes under a minute.
            </span>
          ) : data.state.status === "ok" ? (
            <span className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 size={14} />
              Issued for {data.state.certDomains.join(", ")}
              {data.state.certExpiresAt ? ` - renews automatically before ${new Date(data.state.certExpiresAt).toLocaleDateString()}` : ""}
            </span>
          ) : (
            <span className="flex items-start gap-2 text-rose-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{data.state.lastError ?? "The last request failed."}</span>
            </span>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <Button loading={busy === "save"} onClick={save} disabled={!dirty}>Save</Button>
        {draft.enabled && !dirty && (
          <Button variant="secondary" loading={busy === "request"} onClick={request} disabled={running || !data.available}>
            <RefreshCw size={15} /> {data.state.status === "ok" ? "Renew now" : "Request certificate"}
          </Button>
        )}
        {dirty && <span className="text-xs text-ink-faint">Save before requesting</span>}
      </div>
    </section>
  );
}
