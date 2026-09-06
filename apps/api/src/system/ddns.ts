import type { FastifyBaseLogger } from "fastify";
import type { DdnsConfig, DdnsProviderId, DdnsStatus } from "@opennas/shared";
import { getSetting, setSetting } from "../db/settings.js";

/**
 * Dynamic DNS: keeping a hostname pointed at a home connection's changing IP.
 *
 * Two things make this worth building in rather than leaving to a container.
 * First, a NAS is the machine people most want to reach from outside, and a
 * residential address moves. Second, the ACME client already here needs a name
 * that resolves to this box before it can get a certificate - without dynamic
 * DNS, automatic HTTPS only works for people who already have static addressing.
 *
 * The credential never leaves this module: `publicConfig()` replaces it with a
 * flag, and it is on the settings deny-list so a config backup can't carry it
 * out of the machine.
 */

const SETTING = "ddns";
const STATE_SETTING = "ddns_state";

/** How often to check. Providers ask for restraint; five minutes is the norm. */
const CHECK_MS = 5 * 60 * 1000;

/**
 * Where to ask "what is my public address?".
 *
 * Several, because this is an outbound dependency on someone else's service and
 * a single one being down should not stop the NAS updating its own DNS. They are
 * asked in order and the first plain-looking address wins.
 */
const IP_ECHOES = ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"];

interface StoredDdns {
  enabled: boolean;
  provider: DdnsProviderId;
  hostname: string;
  username: string;
  /** Token or password. Never returned to a client. */
  secret: string;
  /** dyndns2 only: the provider's update host, e.g. "dynupdate.no-ip.com". */
  server: string;
  /** Cloudflare only: the zone the record lives in. */
  zone: string;
}

const DEFAULT: StoredDdns = {
  enabled: false,
  provider: "duckdns",
  hostname: "",
  username: "",
  secret: "",
  server: "",
  zone: "",
};

interface StoredState {
  lastIp: string;
  lastCheckedAt: string;
  lastUpdatedAt: string;
  lastStatus: "ok" | "error" | "never";
  lastMessage: string;
}

const DEFAULT_STATE: StoredState = {
  lastIp: "",
  lastCheckedAt: "",
  lastUpdatedAt: "",
  lastStatus: "never",
  lastMessage: "",
};

function readStored(): StoredDdns {
  try {
    return { ...DEFAULT, ...(JSON.parse(getSetting(SETTING) ?? "{}") as Partial<StoredDdns>) };
  } catch {
    return DEFAULT;
  }
}

function readState(): StoredState {
  try {
    return { ...DEFAULT_STATE, ...(JSON.parse(getSetting(STATE_SETTING) ?? "{}") as Partial<StoredState>) };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(state: StoredState): void {
  setSetting(STATE_SETTING, JSON.stringify(state));
}

/** The config as a client may see it - the credential becomes a flag. */
export function publicConfig(): DdnsConfig {
  const { secret, ...rest } = readStored();
  return { ...rest, hasSecret: secret.length > 0 };
}

export interface DdnsPatch extends Partial<Omit<StoredDdns, "secret">> {
  /** A new credential; empty or absent keeps the stored one. */
  secret?: string;
}

export function setConfig(patch: DdnsPatch): DdnsConfig {
  const current = readStored();
  const next: StoredDdns = {
    ...current,
    ...patch,
    // An empty string means "leave it alone", so the UI can save other fields
    // without the client ever having to hold the credential to send it back.
    secret: patch.secret ? patch.secret : current.secret,
  };
  setSetting(SETTING, JSON.stringify(next));
  return publicConfig();
}

export function status(): DdnsStatus {
  return { ...readState(), config: publicConfig() };
}

/** A plausible IPv4 or IPv6 address, and nothing else. */
export function looksLikeAddress(value: string): boolean {
  const v = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split(".").every((o) => Number(o) <= 255);
  return /^[0-9a-fA-F:]{2,45}$/.test(v) && v.includes(":");
}

/**
 * Ask the internet what this machine's public address is.
 *
 * Returns null when every echo fails, which is treated as "don't know" rather
 * than "the address changed" - updating DNS on a guess is worse than skipping a
 * cycle.
 */
export async function detectPublicIp(): Promise<string | null> {
  for (const url of IP_ECHOES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!res.ok) continue;
      // These return a bare address; anything longer is a page, not an answer.
      const body = (await res.text()).trim().slice(0, 64);
      if (looksLikeAddress(body)) return body;
    } catch {
      // Next echo.
    }
  }
  return null;
}

interface UpdateOutcome {
  ok: boolean;
  message: string;
}

/**
 * Push the address to the provider.
 *
 * Each provider gets its own function rather than one templated URL: their
 * success conditions genuinely differ - DuckDNS answers with a bare "OK",
 * dyndns2 with a word and the address, Cloudflare with JSON and an HTTP status
 * that is 200 even for some failures - and treating "the request didn't throw"
 * as success is how a dynamic-DNS setup silently stops working.
 */
async function pushUpdate(cfg: StoredDdns, ip: string): Promise<UpdateOutcome> {
  switch (cfg.provider) {
    case "duckdns": {
      const domain = cfg.hostname.replace(/\.duckdns\.org$/i, "");
      const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(cfg.secret)}&ip=${encodeURIComponent(ip)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
      const body = (await res.text()).trim();
      // DuckDNS answers "OK" or "KO" with a 200 either way, so the status code
      // says nothing at all.
      if (body.startsWith("OK")) return { ok: true, message: `DuckDNS accepted ${ip}.` };
      return { ok: false, message: "DuckDNS rejected the update. Check the domain and token." };
    }

    case "dyndns2": {
      const host = cfg.server.trim() || "members.dyndns.org";
      const url = `https://${host}/nic/update?hostname=${encodeURIComponent(cfg.hostname)}&myip=${encodeURIComponent(ip)}`;
      const auth = Buffer.from(`${cfg.username}:${cfg.secret}`).toString("base64");
      const res = await fetch(url, {
        headers: {
          authorization: `Basic ${auth}`,
          // dyndns2 requires a user agent, and several providers reject the
          // default one outright.
          "user-agent": "OpenNAS/1.0 dynamic-dns-client",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const body = (await res.text()).trim();
      if (body.startsWith("good")) return { ok: true, message: `Updated to ${ip}.` };
      // "nochg" means the provider already had this address. Not an error, but
      // repeating it is what gets a client blocked, so it is surfaced.
      if (body.startsWith("nochg")) return { ok: true, message: `Already pointed at ${ip}.` };
      return { ok: false, message: `Provider said "${body.slice(0, 80)}".` };
    }

    case "cloudflare": {
      // Cloudflare needs the record's id before it can be changed, so this is
      // two calls: find the A/AAAA record on the zone, then patch it.
      const type = ip.includes(":") ? "AAAA" : "A";
      const headers = { authorization: `Bearer ${cfg.secret}`, "content-type": "application/json" };
      const listUrl =
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(cfg.zone)}/dns_records` +
        `?type=${type}&name=${encodeURIComponent(cfg.hostname)}`;
      const listRes = await fetch(listUrl, { headers, signal: AbortSignal.timeout(15000), redirect: "error" });
      const list = (await listRes.json()) as { success?: boolean; result?: { id: string }[]; errors?: { message: string }[] };
      if (!list.success) {
        return { ok: false, message: list.errors?.[0]?.message ?? "Cloudflare rejected the lookup." };
      }
      const recordId = list.result?.[0]?.id;
      if (!recordId) {
        return {
          ok: false,
          message: `No ${type} record named ${cfg.hostname} exists in that zone. Create the record so OpenNAS can update it.`,
        };
      }
      const patchRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(cfg.zone)}/dns_records/${recordId}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ content: ip }),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
      const patched = (await patchRes.json()) as { success?: boolean; errors?: { message: string }[] };
      if (patched.success) return { ok: true, message: `Updated the ${type} record to ${ip}.` };
      return { ok: false, message: patched.errors?.[0]?.message ?? "Cloudflare rejected the update." };
    }

    default:
      return { ok: false, message: "Unknown provider." };
  }
}

/**
 * One cycle: find the address, and update if it moved.
 *
 * `force` skips the unchanged check, for the "Update now" button - the stored
 * address can be right while the provider's has been lost or never set.
 */
export async function runOnce(log: FastifyBaseLogger, force = false): Promise<DdnsStatus> {
  const cfg = readStored();
  const state = readState();
  const now = new Date().toISOString();

  if (!cfg.enabled || !cfg.hostname || !cfg.secret) {
    return status();
  }

  const ip = await detectPublicIp();
  if (!ip) {
    writeState({
      ...state,
      lastCheckedAt: now,
      lastStatus: "error",
      lastMessage: "Could not determine the public IP address. None of the lookup services replied.",
    });
    return status();
  }

  if (!force && ip === state.lastIp && state.lastStatus === "ok") {
    // Nothing to do. Recorded so the UI can show it is still watching rather
    // than looking stalled.
    writeState({ ...state, lastCheckedAt: now, lastIp: ip });
    return status();
  }

  try {
    const result = await pushUpdate(cfg, ip);
    writeState({
      lastIp: result.ok ? ip : state.lastIp,
      lastCheckedAt: now,
      lastUpdatedAt: result.ok ? now : state.lastUpdatedAt,
      lastStatus: result.ok ? "ok" : "error",
      lastMessage: result.message,
    });
    if (!result.ok) log.warn({ provider: cfg.provider, message: result.message }, "dynamic DNS update failed");
  } catch (err) {
    writeState({
      ...state,
      lastCheckedAt: now,
      lastStatus: "error",
      lastMessage: "Couldn't reach the provider.",
    });
    log.warn({ err, provider: cfg.provider }, "dynamic DNS update threw");
  }
  return status();
}

/** Start the periodic check. Returns a stop function for the onClose hook. */
export function startDdns(log: FastifyBaseLogger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce(log);
    } catch (err) {
      log.warn({ err }, "dynamic DNS tick failed");
    } finally {
      running = false;
    }
  };
  // A first run shortly after boot, because a reboot is exactly when the
  // address is most likely to have changed - but not instantly, so it doesn't
  // race the network coming up.
  const initial = setTimeout(() => void tick(), 30_000);
  initial.unref?.();
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
