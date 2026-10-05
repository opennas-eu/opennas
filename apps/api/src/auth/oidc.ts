import { createHash, timingSafeEqual } from "node:crypto";
import * as client from "openid-client";
import { config } from "../config.js";
import { putOidcState, takeOidcState } from "../db/oidc.js";

/** "local" is reserved; OIDC identities are namespaced by this provider id. */
export const OIDC_PROVIDER = "sso";

let discovered: client.Configuration | null = null;

async function getConfig(): Promise<client.Configuration> {
  if (discovered) return discovered;
  discovered = await client.discovery(
    new URL(config.oidc.issuer),
    config.oidc.clientId,
    config.oidc.clientSecret || undefined,
  );
  return discovered;
}

/**
 * What the browser that started a login keeps, to prove it is the one finishing
 * it: a hash of the `state`, in a signed, httpOnly cookie (see auth/routes.ts).
 *
 * Without it the state is only checked to *exist*, and anyone can start a login,
 * stop at the IdP's redirect and hand the callback URL - carrying their own code
 * - to someone else's browser, which would then be signed in as the attacker's
 * account (login CSRF), uploading into a NAS account the attacker can read.
 */
export function oidcStateBinding(state: string): string {
  return createHash("sha256").update(`opennas-oidc-state:${state}`).digest("base64url");
}

/** Whether a binding cookie's value belongs to this `state`. Constant-time. */
export function oidcStateMatches(binding: string | null | undefined, state: string | null): boolean {
  if (!binding || !state) return false;
  const want = Buffer.from(oidcStateBinding(state));
  const got = Buffer.from(binding);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Begin login: returns the IdP authorization URL, persists PKCE state, and
 * returns the state too so the caller can bind it to the browser.
 */
export async function beginLogin(): Promise<{ url: string; state: string }> {
  const cfg = await getConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  putOidcState(state, codeVerifier, nonce);

  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: config.oidc.redirectUri,
    scope: config.oidc.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url: url.href, state };
}

export interface OidcClaims {
  subject: string;
  username: string;
  displayName: string;
  email: string | null;
}

/** Complete login from the IdP redirect; validates state/nonce/PKCE. */
export async function completeLogin(currentUrl: URL): Promise<OidcClaims> {
  const cfg = await getConfig();
  const state = currentUrl.searchParams.get("state");
  if (!state) throw new Error("Missing state parameter.");
  const stored = takeOidcState(state);
  if (!stored) throw new Error("Login session expired or invalid. Please try again.");

  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: stored.codeVerifier,
    expectedNonce: stored.nonce,
    expectedState: state,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims) throw new Error("IdP returned no ID token claims.");

  const sub = String(claims.sub);
  const email = typeof claims.email === "string" ? claims.email : null;
  const preferred =
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    (email ? email.split("@")[0] : "") ||
    `sso-${sub.slice(0, 8)}`;
  const name =
    (typeof claims.name === "string" && claims.name) || preferred;

  return { subject: sub, username: preferred, displayName: name, email };
}

export function oidcEnabled(): boolean {
  return config.oidc.enabled;
}
