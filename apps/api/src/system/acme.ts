import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signOneShot, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * An ACME (RFC 8555) client, for automatic Let's Encrypt certificates.
 *
 * Written directly against the RFC rather than pulled in. ACME is a small
 * protocol - a signed POST, a nonce, and a state machine over four endpoints -
 * and the alternative libraries drag in their own crypto and HTTP stacks to run
 * on an appliance whose whole point is being small and auditable.
 *
 * The one thing not done by hand is the CSR. Node can generate keys but cannot
 * build a PKCS#10 request, and hand-rolling DER for the certificate request is
 * exactly the kind of code that is subtly wrong in ways nobody notices until a
 * CA rejects it. `openssl` is already installed and already used for the
 * self-signed certificate, so it does that one step.
 *
 * Only the **http-01** challenge is implemented. dns-01 would need per-provider
 * API credentials, which is a different feature; tls-alpn-01 needs to own the
 * TLS handshake, which nginx does here.
 */

export const LETSENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LETSENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert?: string;
  keyChange?: string;
  meta?: { termsOfService?: string };
}

interface AcmeResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  raw: string;
}

/** A pending http-01 challenge: token -> the exact bytes that must be served. */
export type ChallengeStore = Map<string, string>;

/** The live store the public challenge route reads from. */
export const challengeStore: ChallengeStore = new Map();

export interface AcmeLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export class AcmeError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "AcmeError";
  }
}

export class AcmeClient {
  private directory: Directory | null = null;
  private nonce: string | null = null;
  private kid: string | null = null;
  private readonly key;
  private readonly jwk: Record<string, string>;

  constructor(
    private readonly directoryUrl: string,
    accountKeyPem: string,
    private readonly log: AcmeLogger,
  ) {
    this.key = createPrivateKey(accountKeyPem);
    const pub = createPublicKey(this.key).export({ format: "jwk" }) as Record<string, string>;
    // Only the members RFC 7638 defines for EC, in the order it requires.
    this.jwk = { crv: pub.crv!, kty: pub.kty!, x: pub.x!, y: pub.y! };
  }

  /** A fresh ES256 account key. P-256 because every ACME CA supports it. */
  static generateAccountKey(): string {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  /** RFC 7638 JWK thumbprint - the second half of every key authorization. */
  thumbprint(): string {
    const canonical = JSON.stringify(this.jwk); // already in lexicographic order
    return b64url(createHash("sha256").update(canonical).digest());
  }

  /** The exact string that must be served at the http-01 challenge URL. */
  keyAuthorization(token: string): string {
    return `${token}.${this.thumbprint()}`;
  }

  private async fetchDirectory(): Promise<Directory> {
    if (this.directory) return this.directory;
    // Bounded: this is reached from a page load (to show the terms of service),
    // and a NAS with no route to the internet must not stall the whole request.
    const res = await fetch(this.directoryUrl, {
      headers: { "user-agent": "OpenNAS" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new AcmeError(`ACME directory unreachable (HTTP ${res.status})`);
    this.directory = (await res.json()) as Directory;
    return this.directory;
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const dir = await this.fetchDirectory();
    const res = await fetch(dir.newNonce, { method: "HEAD", headers: { "user-agent": "OpenNAS" } });
    const nonce = res.headers.get("replay-nonce");
    if (!nonce) throw new AcmeError("The CA did not issue a nonce");
    return nonce;
  }

  /**
   * A signed request. `payload === null` means POST-as-GET, whose payload is
   * the empty string rather than an empty object - a distinction the RFC is
   * explicit about and CAs enforce.
   */
  private async signedPost<T = unknown>(url: string, payload: unknown | null): Promise<AcmeResponse<T>> {
    const protectedHeader: Record<string, unknown> = {
      alg: "ES256",
      nonce: await this.freshNonce(),
      url,
      // Before the account exists it is identified by the key itself; after, by
      // the URL the CA assigned it. Sending both is an error.
      ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }),
    };
    const protected64 = b64url(JSON.stringify(protectedHeader));
    const payload64 = payload === null ? "" : b64url(JSON.stringify(payload));
    const signature = signOneShot(
      "sha256",
      Buffer.from(`${protected64}.${payload64}`),
      // JWS wants the raw R||S pair; Node emits DER unless told otherwise.
      { key: this.key, dsaEncoding: "ieee-p1363" },
    );

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/jose+json", "user-agent": "OpenNAS" },
      body: JSON.stringify({ protected: protected64, payload: payload64, signature: b64url(signature) }),
    });

    const next = res.headers.get("replay-nonce");
    if (next) this.nonce = next;

    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw; // certificate downloads come back as PEM, not JSON
    }

    if (res.status >= 400) {
      const problem = body as { detail?: string; type?: string } | null;
      // A stale nonce is the one error worth retrying transparently; the CA
      // hands us a fresh one in the same response.
      if (problem?.type?.endsWith("badNonce") && next) {
        return this.signedPost<T>(url, payload);
      }
      throw new AcmeError(`ACME request to ${url} failed (HTTP ${res.status})`, problem?.detail);
    }
    return { status: res.status, headers: res.headers, body: body as T, raw };
  }

  /** Register (or look up) the account. Idempotent - the CA returns the existing one. */
  async ensureAccount(email: string): Promise<void> {
    const dir = await this.fetchDirectory();
    const res = await this.signedPost(dir.newAccount, {
      termsOfServiceAgreed: true,
      ...(email ? { contact: [`mailto:${email}`] } : {}),
    });
    const kid = res.headers.get("location");
    if (!kid) throw new AcmeError("The CA did not return an account URL");
    this.kid = kid;
  }

  /** The terms of service URL, so consent can be asked for rather than assumed. */
  async termsOfService(): Promise<string | null> {
    return (await this.fetchDirectory()).meta?.termsOfService ?? null;
  }

  /**
   * Run the whole issuance: order, prove control of each name over http-01,
   * finalize with a CSR, and download the chain.
   */
  async obtainCertificate(domains: string[]): Promise<{ certificate: string; privateKey: string }> {
    const dir = await this.fetchDirectory();
    if (!this.kid) throw new AcmeError("Account not registered");

    const orderRes = await this.signedPost<AcmeOrder>(dir.newOrder, {
      identifiers: domains.map((value) => ({ type: "dns", value })),
    });
    const orderUrl = orderRes.headers.get("location");
    if (!orderUrl) throw new AcmeError("The CA did not return an order URL");
    let order = orderRes.body;

    // ---- prove control of every name -------------------------------------
    const published: string[] = [];
    try {
      for (const authzUrl of order.authorizations) {
        const authz = (await this.signedPost<AcmeAuthorization>(authzUrl, null)).body;
        if (authz.status === "valid") continue; // already proven, and still cached

        const challenge = authz.challenges.find((c) => c.type === "http-01");
        if (!challenge) {
          throw new AcmeError(
            `The CA offered no http-01 challenge for ${authz.identifier.value}`,
            "OpenNAS can only answer http-01, which needs port 80 reachable from the internet.",
          );
        }
        challengeStore.set(challenge.token, this.keyAuthorization(challenge.token));
        published.push(challenge.token);

        this.log.info({ domain: authz.identifier.value }, "acme: answering http-01 challenge");
        await this.signedPost(challenge.url, {});
        await this.pollUntil(
          authzUrl,
          (a: AcmeAuthorization) => a.status !== "pending",
          `validation of ${authz.identifier.value}`,
        ).then((a) => {
          if (a.status !== "valid") {
            throw new AcmeError(
              `The CA could not verify ${authz.identifier.value}`,
              a.challenges.find((c) => c.error)?.error?.detail ??
                "Check that this name resolves to this machine and that port 80 is reachable from the internet.",
            );
          }
        });
      }
    } finally {
      // Whatever happened, stop serving the tokens.
      for (const token of published) challengeStore.delete(token);
    }

    // ---- finalize ---------------------------------------------------------
    const { csrDer, keyPem } = await generateCsr(domains);
    order = (await this.signedPost<AcmeOrder>(order.finalize, { csr: b64url(csrDer) })).body;
    order = await this.pollUntil(orderUrl, (o: AcmeOrder) => o.status !== "processing", "issuance");
    if (order.status !== "valid" || !order.certificate) {
      throw new AcmeError("The CA did not issue a certificate", order.error?.detail ?? `order status: ${order.status}`);
    }

    const certificate = (await this.signedPost<string>(order.certificate, null)).raw;
    return { certificate, privateKey: keyPem };
  }

  /** Poll a resource until `done`, backing off, with a ceiling so it can't hang. */
  private async pollUntil<T extends { status: string }>(
    url: string,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    let delay = 1000;
    for (let attempt = 0; attempt < 12; attempt++) {
      const value = (await this.signedPost<T>(url, null)).body;
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 8000);
    }
    throw new AcmeError(`Timed out waiting for ${what}`);
  }
}

interface AcmeOrder {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: { detail?: string };
}

interface AcmeAuthorization {
  status: string;
  identifier: { type: string; value: string };
  challenges: { type: string; url: string; token: string; status: string; error?: { detail?: string } }[];
}

/**
 * A 2048-bit RSA key and a matching PKCS#10 CSR covering every name, via
 * openssl. RSA rather than EC because a NAS gets reached by whatever is on the
 * network, including old clients, and the compatibility is worth more here than
 * the handshake cost.
 *
 * Returns the CSR in DER, which is what ACME wants (base64url-encoded).
 */
export async function generateCsr(domains: string[]): Promise<{ csrDer: Buffer; keyPem: string }> {
  const [primary] = domains;
  if (!primary) throw new AcmeError("No domain given");

  const dir = await mkdtemp(join(tmpdir(), "opennas-csr-"));
  try {
    const keyPath = join(dir, "key.pem");
    const csrPath = join(dir, "req.der");
    const confPath = join(dir, "openssl.cnf");

    // Every name goes in the SAN list, including the first: a CN-only
    // certificate has been ignored by browsers for years.
    const san = domains.map((d, i) => `DNS.${i + 1} = ${d}`).join("\n");
    await writeFile(
      confPath,
      [
        "[req]",
        "distinguished_name = dn",
        "req_extensions = ext",
        "prompt = no",
        "[dn]",
        `CN = ${primary}`,
        "[ext]",
        "subjectAltName = @alt",
        "[alt]",
        san,
      ].join("\n"),
      "utf8",
    );

    await execFileAsync("openssl", ["genrsa", "-out", keyPath, "2048"]);
    await execFileAsync("openssl", [
      "req", "-new", "-key", keyPath, "-out", csrPath, "-outform", "DER", "-config", confPath,
    ]);

    return { csrDer: await readFile(csrPath), keyPem: await readFile(keyPath, "utf8") };
  } finally {
    // The private key lives in here; don't leave it in /tmp.
    await rm(dir, { recursive: true, force: true });
  }
}

/** Days until a PEM certificate expires; null when it can't be read. */
export function daysUntilExpiry(certPem: string): number | null {
  try {
    const match = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(certPem);
    if (!match) return null;
    const cert = new X509Certificate(match[0]);
    return Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000);
  } catch {
    return null;
  }
}
