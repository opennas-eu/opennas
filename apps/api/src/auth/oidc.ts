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

/** Begin login: returns the IdP authorization URL and persists PKCE state. */
export async function beginLogin(): Promise<string> {
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
  return url.href;
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
