import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { AppFetchRequest, AppFetchResponse } from "@opennas/shared";

/**
 * Outbound HTTP for apps holding the "fetch" permission.
 *
 * An app can't reach the network itself (it's in a sandboxed, opaque-origin
 * iframe), so this makes the request on its behalf - which means OpenNAS is
 * lending out its own network position, including whatever the box can reach on
 * the LAN. That makes SSRF the whole problem, and the defence is layered:
 *
 *  1. The target host must match a pattern the app declared in its manifest and
 *     an admin approved at install time. There is no "any host" option.
 *  2. Only http/https, only ordinary methods, no ambient credentials - every
 *     request is built from scratch, so no cookie or session ever rides along.
 *  3. Every address the host resolves to must be publicly routable. Loopback,
 *     private ranges, link-local, CGNAT, multicast and friends are all refused,
 *     so an app can't reach the NAS itself or anything else on the LAN.
 *  4. The connection is made to the *pinned* address we just validated, with SNI
 *     and Host set to the original name. Resolving and then connecting by name
 *     would leave a DNS-rebinding window where the second lookup returns
 *     127.0.0.1; connecting to the checked address closes it.
 *  5. Redirects are not followed automatically - each hop is re-validated
 *     through steps 1-4, because a redirect to 169.254.169.254 is the classic
 *     way out of an allowlist.
 */

/** A refusal the app should see, mapped to a 4xx by the route. */
export class FetchDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchDenied";
  }
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const MAX_REQUEST_BODY = 1024 * 1024; // 1 MB
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_HEADERS = 20;

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Headers an app may not set. Hop-by-hop headers would confuse the connection;
 * `host` would defeat the allowlist; `cookie` is pointless here and inviting.
 */
const BLOCKED_REQUEST_HEADERS = new Set([
  "host", "cookie", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "content-length", "expect", "proxy-authorization", "proxy-connection",
]);

/** Response headers we don't hand back - nothing here is useful to a sandboxed app. */
const BLOCKED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2", "connection", "keep-alive", "transfer-encoding"]);

/** Content types returned as text; everything else comes back base64. */
const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|.*\+json|.*\+xml))/i;

// ---- Host allowlist --------------------------------------------------------

const HOST_PATTERN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** Validate one manifest host pattern: "api.example.com" or "*.example.com". */
export function isValidHostPattern(pattern: string): boolean {
  return pattern.length <= 253 && HOST_PATTERN_RE.test(pattern) && pattern.includes(".");
}

/**
 * Does `host` match a declared pattern? An exact pattern matches only itself;
 * `*.example.com` matches any subdomain but NOT the bare `example.com` - an app
 * that wants both declares both, rather than getting the apex by surprise.
 */
export function hostMatches(host: string, patterns: string[]): boolean {
  const target = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === pattern;
  });
}

// ---- Address validation ----------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** IPv4 ranges that must never be reachable through the proxy. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback - the NAS itself
  ["169.254.0.0", 16], // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
];

function isPublicV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of V4_BLOCKED) {
    const baseInt = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (baseInt & mask)) return false;
  }
  return true;
}

/**
 * Is this address safe to connect to? Anything not clearly public is refused -
 * the failure mode of being too strict is an app that can't reach a host, which
 * is much better than an app reaching the NAS's own admin API.
 */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version !== 6) return false;

  const addr = ip.toLowerCase().split("%")[0]!; // drop any zone id
  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-embedded forms are judged as IPv4.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (embedded && (addr.startsWith("::ffff:") || addr.startsWith("::") || addr.startsWith("64:ff9b:"))) {
    return isPublicV4(embedded[1]!);
  }
  if (addr === "::" || addr === "::1") return false; // unspecified / loopback
  const head = addr.split(":")[0] ?? "";
  const group = parseInt(head || "0", 16);
  if (Number.isNaN(group)) return false;
  if ((group & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((group & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((group & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (group === 0x2002) return false; // 6to4 - wraps an arbitrary v4 address
  if (group === 0x0100) return false; // 100::/64 discard-only
  return true;
}

/**
 * Resolve a hostname and return the addresses, refusing unless *every* one is
 * public. Checking every answer (not just the first) means a host that resolves
 * to both a real address and 127.0.0.1 is rejected rather than raced.
 */
async function resolvePublicAddresses(host: string): Promise<{ address: string; family: number }[]> {
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new FetchDenied(`${host} is not a publicly routable address.`);
    return [{ address: host, family: isIP(host) }];
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new FetchDenied(`Couldn't resolve ${host}.`);
  }
  if (answers.length === 0) throw new FetchDenied(`Couldn't resolve ${host}.`);
  for (const a of answers) {
    if (!isPublicAddress(a.address)) {
      throw new FetchDenied(`${host} resolves to a private or reserved address, which apps may not reach.`);
    }
  }
  return answers;
}

// ---- The proxy -------------------------------------------------------------

interface Hop {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

function sanitizeRequestHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const entries = Object.entries(input);
  if (entries.length > MAX_HEADERS) throw new FetchDenied(`Too many headers (max ${MAX_HEADERS}).`);
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase().trim();
    const value = String(rawValue);
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new FetchDenied(`Invalid header name "${rawName}".`);
    // A newline here would let an app inject extra headers or a second request.
    if (/[\r\n]/.test(value)) throw new FetchDenied(`Invalid value for header "${rawName}".`);
    if (BLOCKED_REQUEST_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) continue;
    if (value.length > 4096) throw new FetchDenied(`Header "${rawName}" is too long.`);
    out[name] = value;
  }
  return out;
}

/** Perform one hop against a pre-validated, pinned address. */
function performRequest(hop: Hop, address: string, family: number): Promise<{ res: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isHttps = hop.url.protocol === "https:";
    const port = hop.url.port ? Number(hop.url.port) : isHttps ? 443 : 80;
    const send = isHttps ? httpsRequest : httpRequest;

    const req = send(
      {
        // Connect to the address we validated, never re-resolve the name.
        host: address,
        family,
        port,
        method: hop.method,
        path: `${hop.url.pathname}${hop.url.search}`,
        headers: { ...hop.headers, host: hop.url.host },
        // TLS is still verified against the original hostname.
        servername: isHttps && !isIP(hop.url.hostname) ? hop.url.hostname : undefined,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new FetchDenied(`The response is larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new FetchDenied(`The request to ${hop.url.host} timed out.`));
    });
    req.on("error", (err) => reject(new FetchDenied(`Could not reach ${hop.url.host}: ${err.message}`)));
    if (hop.body) req.write(hop.body);
    req.end();
  });
}

/**
 * Run an app's request. `allowedHosts` comes from the app's manifest, which an
 * admin approved at install - this function never widens it.
 */
export async function proxyFetch(input: AppFetchRequest, allowedHosts: string[]): Promise<AppFetchResponse> {
  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new FetchDenied(`Method ${method} isn't allowed.`);

  let body: Buffer | undefined;
  if (input.body != null && method !== "GET" && method !== "HEAD") {
    body = Buffer.from(String(input.body), "utf8");
    if (body.length > MAX_REQUEST_BODY) throw new FetchDenied("The request body is too large (max 1 MB).");
  }

  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new FetchDenied("That isn't a valid URL.");
  }

  let hop: Hop = { url, method, headers: sanitizeRequestHeaders(input.headers), body };
  let redirects = 0;

  for (;;) {
    if (hop.url.protocol !== "https:" && hop.url.protocol !== "http:") {
      throw new FetchDenied("Only http and https URLs are allowed.");
    }
    if (hop.url.username || hop.url.password) {
      throw new FetchDenied("URLs with embedded credentials aren't allowed.");
    }
    if (!hostMatches(hop.url.hostname, allowedHosts)) {
      throw new FetchDenied(`This app isn't allowed to contact ${hop.url.hostname}.`);
    }

    const [addr] = await resolvePublicAddresses(hop.url.hostname);
    const { res, body: responseBody } = await performRequest(hop, addr!.address, addr!.family);

    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) throw new FetchDenied("Too many redirects.");
      redirects++;
      let next: URL;
      try {
        next = new URL(location, hop.url);
      } catch {
        throw new FetchDenied("The server redirected to an invalid URL.");
      }
      // 303, and 301/302 on POST, become a GET without a body - same as a browser.
      const drop = status === 303 || ((status === 301 || status === 302) && hop.method === "POST");
      hop = {
        url: next,
        method: drop ? "GET" : hop.method,
        headers: hop.headers,
        body: drop ? undefined : hop.body,
      };
      continue; // re-validated from the top: allowlist, scheme and address
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (BLOCKED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    const contentType = headers["content-type"] ?? "";
    const asText = TEXT_TYPE.test(contentType) || contentType === "";
    return {
      status,
      statusText: res.statusMessage ?? "",
      headers,
      body: asText ? responseBody.toString("utf8") : responseBody.toString("base64"),
      encoding: asText ? "utf8" : "base64",
      url: hop.url.toString(),
    };
  }
}
