import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { X509Certificate } from "node:crypto";
import type { AcmeSettings, AcmeState } from "@opennas/shared";
import { config } from "../config.js";
import { getSettingOr, setSetting } from "../db/settings.js";
import { AcmeClient, AcmeError, LETSENCRYPT_PRODUCTION, daysUntilExpiry } from "./acme.js";
import { linuxMode, reloadWebProxy } from "./integration.js";
import { notifyAdmins } from "../notifications/hub.js";

/**
 * Orchestration around the ACME client: what to request, when to renew, and
 * where the results go.
 *
 * Renewal runs on a daily check rather than a calendar entry, because an
 * appliance is switched off, moved, and left unplugged for a fortnight - a job
 * scheduled for a particular day is a job that doesn't run. Anything inside 30
 * days of expiry is renewed, which is the window Let's Encrypt recommends and
 * leaves a fortnight of failed attempts before anything actually breaks.
 */

const SETTINGS_KEY = "acme";
const STATE_KEY = "acme_state";
/** Renew this far ahead of expiry. */
const RENEW_WITHIN_DAYS = 30;

export const DEFAULT_ACME: AcmeSettings = {
  enabled: false,
  domains: [],
  email: "",
  directoryUrl: LETSENCRYPT_PRODUCTION,
  agreedTos: false,
};

export function getAcmeSettings(): AcmeSettings {
  try {
    const parsed = JSON.parse(getSettingOr(SETTINGS_KEY, "")) as Partial<AcmeSettings>;
    return {
      enabled: parsed.enabled === true,
      domains: Array.isArray(parsed.domains) ? parsed.domains.filter(isValidDomain) : [],
      email: typeof parsed.email === "string" ? parsed.email : "",
      directoryUrl: typeof parsed.directoryUrl === "string" && parsed.directoryUrl ? parsed.directoryUrl : LETSENCRYPT_PRODUCTION,
      agreedTos: parsed.agreedTos === true,
    };
  } catch {
    return { ...DEFAULT_ACME };
  }
}

export function setAcmeSettings(settings: AcmeSettings): void {
  setSetting(SETTINGS_KEY, JSON.stringify(settings));
}

export function getAcmeState(): AcmeState {
  try {
    const parsed = JSON.parse(getSettingOr(STATE_KEY, "")) as Partial<AcmeState>;
    return {
      status: parsed.status ?? "never",
      lastRunAt: parsed.lastRunAt ?? null,
      lastError: parsed.lastError ?? null,
      certExpiresAt: parsed.certExpiresAt ?? null,
      certDomains: Array.isArray(parsed.certDomains) ? parsed.certDomains : [],
    };
  } catch {
    return { status: "never", lastRunAt: null, lastError: null, certExpiresAt: null, certDomains: [] };
  }
}

function setAcmeState(state: AcmeState): void {
  setSetting(STATE_KEY, JSON.stringify(state));
}

/**
 * A hostname the CA could plausibly issue for. Deliberately strict: a wrong
 * entry here means a failed order and a rate-limit hit against the account,
 * which is a slow thing to recover from.
 */
export function isValidDomain(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const d = value.trim().toLowerCase();
  if (d.length === 0 || d.length > 253) return false;
  if (d.startsWith("*.")) return false; // wildcards need dns-01, which this doesn't do
  const labels = d.split(".");
  if (labels.length < 2) return false; // a public CA won't issue for a bare name
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** The account key, created on first use and reused thereafter. */
async function accountKey(): Promise<string> {
  const path = join(config.tlsDir, "acme-account.key");
  try {
    return await readFile(path, "utf8");
  } catch {
    const pem = AcmeClient.generateAccountKey();
    await mkdir(config.tlsDir, { recursive: true });
    await writeFile(path, pem, { mode: 0o600 });
    return pem;
  }
}

export async function acmeTermsOfService(directoryUrl: string): Promise<string | null> {
  try {
    const client = new AcmeClient(directoryUrl, await accountKey(), { info: () => {}, warn: () => {} });
    return await client.termsOfService();
  } catch {
    return null;
  }
}

/** True while an issuance is in flight - a second one would fight over the nonce. */
let running = false;

export interface IssueResult {
  ok: boolean;
  error?: string;
}

/**
 * Request (or renew) a certificate and install it. Writes the new certificate
 * only after the CA has issued one, so a failed run leaves the working
 * certificate exactly where it was.
 */
export async function runIssuance(log: FastifyBaseLogger, settings = getAcmeSettings()): Promise<IssueResult> {
  if (running) return { ok: false, error: "A certificate request is already in progress." };
  if (!settings.enabled) return { ok: false, error: "Automatic certificates are turned off." };
  if (settings.domains.length === 0) return { ok: false, error: "No domain names have been set." };
  if (!settings.agreedTos) return { ok: false, error: "The CA's terms of service have not been accepted." };

  running = true;
  const previous = getAcmeState();
  setAcmeState({ ...previous, status: "running" });

  try {
    const client = new AcmeClient(settings.directoryUrl, await accountKey(), log);
    await client.ensureAccount(settings.email);
    log.info({ domains: settings.domains }, "acme: requesting certificate");
    const { certificate, privateKey } = await client.obtainCertificate(settings.domains);

    // Sanity-check before replacing a certificate that currently works.
    const leaf = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(certificate)?.[0];
    if (!leaf) throw new AcmeError("The CA returned something that isn't a certificate");
    const parsed = new X509Certificate(leaf);

    await mkdir(config.tlsDir, { recursive: true });
    await writeFile(join(config.tlsDir, "cert.pem"), certificate, { mode: 0o644 });
    await writeFile(join(config.tlsDir, "key.pem"), privateKey, { mode: 0o600 });
    await reloadWebProxy(log);

    setAcmeState({
      status: "ok",
      lastRunAt: new Date().toISOString(),
      lastError: null,
      certExpiresAt: new Date(parsed.validTo).toISOString(),
      certDomains: [...settings.domains],
    });
    log.info({ expiresAt: parsed.validTo }, "acme: certificate installed");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Certificate request failed.";
    log.warn({ err }, "acme: certificate request failed");
    setAcmeState({ ...previous, status: "error", lastRunAt: new Date().toISOString(), lastError: message });
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

/**
 * The daily check. Renews inside the window, and does nothing (quietly) the
 * rest of the time - this runs on every appliance, most of which have no ACME
 * configuration at all.
 */
export async function renewIfNeeded(log: FastifyBaseLogger): Promise<void> {
  const settings = getAcmeSettings();
  if (!settings.enabled || settings.domains.length === 0) return;

  let days: number | null = null;
  try {
    days = daysUntilExpiry(await readFile(join(config.tlsDir, "cert.pem"), "utf8"));
  } catch {
    days = null; // no certificate yet - that counts as due
  }

  const state = getAcmeState();
  // The names may have changed since the certificate was issued, in which case
  // the current expiry is irrelevant.
  const namesChanged =
    state.certDomains.length !== settings.domains.length ||
    settings.domains.some((d) => !state.certDomains.includes(d));

  if (days !== null && days > RENEW_WITHIN_DAYS && !namesChanged) return;

  log.info({ days, namesChanged }, "acme: renewal due");
  const result = await runIssuance(log, settings);
  if (!result.ok) {
    // Expiring silently is how a NAS becomes unreachable on a Sunday.
    const urgency = days !== null && days <= 7 ? "warning" : "info";
    notifyAdmins({
      level: urgency === "warning" ? "warning" : "info",
      title: "Certificate renewal failed",
      body:
        days !== null
          ? `The certificate expires in ${days} day${days === 1 ? "" : "s"}. ${result.error ?? ""}`.trim()
          : (result.error ?? "The certificate could not be issued."),
      dedupeKey: "acme-renewal-failed",
    });
  }
}

/** Start the daily renewal check. Returns a stop function. */
export function startAcmeRenewal(log: FastifyBaseLogger): () => void {
  const DAY = 24 * 60 * 60 * 1000;
  // A short delay after boot: the network may not be up the instant we start.
  const first = setTimeout(() => void renewIfNeeded(log), 60_000);
  const timer = setInterval(() => void renewIfNeeded(log), DAY);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function acmeAvailable(): { available: boolean; reason: string | null } {
  if (!linuxMode()) {
    return { available: false, reason: "Certificates can only be installed on the appliance, not in development mode." };
  }
  return { available: true, reason: null };
}
