import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";
import type { TlsInfo, TlsResponse } from "@opennas/shared";
import { api, ApiRequestError } from "../../../lib/api.ts";
import { useNotifications } from "../../../store/notifications.ts";
import { confirmDialog } from "../../../store/dialogs.ts";
import { Button } from "../../ui/controls.tsx";
import { AutoCertificate } from "./AutoCertificate.tsx";

export function Certificate() {
  const [info, setInfo] = useState<TlsInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"apply" | "self" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const push = useNotifications((s) => s.push);

  async function load() {
    try {
      const res = await api.get<TlsResponse>("/admin/tls");
      setInfo(res.tls);
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => { void load(); }, []);

  async function apply() {
    setBusy("apply");
    setError(null);
    try {
      const res = await api.post<TlsResponse>("/admin/tls", { cert, key });
      setInfo(res.tls);
      setCert("");
      setKey("");
      push({ level: "success", title: "Certificate updated", body: "nginx reloaded with the new certificate." });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not apply the certificate.");
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (!(await confirmDialog({
      title: "Generate a new self-signed certificate?",
      message: "This replaces the current certificate. Browsers will show a warning until you trust the new one.",
      confirmLabel: "Generate",
    }))) return;
    setBusy("self");
    setError(null);
    try {
      const res = await api.post<TlsResponse>("/admin/tls/self-signed");
      setInfo(res.tls);
      push({ level: "success", title: "Self-signed certificate generated" });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not regenerate the certificate.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink">Certificate</h2>
        <p className="text-sm text-ink-faint">The TLS certificate the web interface is served with (HTTPS).</p>
      </div>

      <div className="mb-6 rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200/70">
        {!loaded ? (
          <p className="text-sm text-ink-faint">Loading...</p>
        ) : info ? (
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white ${info.selfSigned ? "bg-amber-500" : "bg-emerald-500"}`}>
              {info.selfSigned ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}
            </span>
            <div className="min-w-0 text-sm">
              <div className="font-semibold text-ink">
                {info.selfSigned ? "Self-signed certificate" : "Custom certificate"}
              </div>
              <dl className="mt-1.5 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-ink-faint">
                <dt>Subject</dt><dd className="truncate text-ink-soft">{info.subject.replace(/\n/g, ", ")}</dd>
                <dt>Issuer</dt><dd className="truncate text-ink-soft">{info.issuer.replace(/\n/g, ", ")}</dd>
                {info.altNames && (<><dt>Alt names</dt><dd className="truncate text-ink-soft">{info.altNames}</dd></>)}
                <dt>Valid until</dt><dd className="text-ink-soft">{new Date(info.validTo).toLocaleString()}</dd>
                <dt>SHA-256</dt><dd className="truncate font-mono text-xs text-ink-soft">{info.fingerprint}</dd>
              </dl>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-faint">No certificate found yet.</p>
        )}
      </div>

      <div className="mb-6">
        <AutoCertificate onIssued={load} />
      </div>

      <section className="mb-6">
        <h3 className="mb-2 text-sm font-semibold text-ink-soft">Install your own certificate</h3>
        <p className="mb-3 text-xs text-ink-faint">
          Paste a PEM certificate (full chain) and its matching private key. nginx reloads automatically.
        </p>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Certificate (PEM)</span>
            <textarea
              value={cert}
              onChange={(e) => setCert(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder="-----BEGIN CERTIFICATE-----"
              className="opennas-scroll w-full rounded-lg bg-white px-3 py-2 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Private key (PEM)</span>
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder="-----BEGIN PRIVATE KEY-----"
              className="opennas-scroll w-full rounded-lg bg-white px-3 py-2 font-mono text-xs text-ink shadow-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        <div className="mt-3 flex items-center gap-2">
          <Button loading={busy === "apply"} disabled={!cert.trim() || !key.trim()} onClick={apply}>
            Apply certificate
          </Button>
          <Button variant="secondary" loading={busy === "self"} onClick={regenerate}>
            <RefreshCw size={15} /> Regenerate self-signed
          </Button>
        </div>
      </section>

      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
        After applying a new certificate you may need to reload the page; browsers warn on self-signed
        certificates until you trust them or install one from a real CA.
      </p>
    </div>
  );
}
