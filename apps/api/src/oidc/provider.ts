import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserById } from "../db/users.js";
import { getSettingOr } from "../db/settings.js";
import { getClient, verifyClientSecret } from "../db/oidc-clients.js";
import { jwks, signJwt } from "./keys.js";
import { consumeCode, getAccessToken, issueAccessToken, issueCode } from "./store.js";

/**
 * OpenNAS as an OpenID Connect identity provider (authorization-code + PKCE).
 * Registered at the top level (these are standard, externally-called paths, not
 * under /api). The OpenNAS session cookie (set by authPlugin globally) tells the
 * authorize endpoint who's logged in.
 */

const SUPPORTED_SCOPES = ["openid", "profile", "email"];

function issuerFor(req: FastifyRequest): string {
  return getSettingOr("oidc_issuer", "").replace(/\/+$/, "") || `${req.protocol}://${req.headers.host}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function b64urlSha256(s: string): string {
  return createHash("sha256").update(s).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function claimsFor(userId: string, scope: string): Record<string, unknown> | null {
  const u = getUserById(userId);
  if (!u) return null;
  const scopes = scope.split(/\s+/);
  const claims: Record<string, unknown> = { sub: u.id };
  if (scopes.includes("profile")) {
    claims.name = u.displayName;
    claims.preferred_username = u.username;
  }
  if (scopes.includes("email") && u.email) {
    claims.email = u.email;
    claims.email_verified = true;
  }
  return claims;
}

function errorPage(reply: FastifyReply, title: string, detail: string): void {
  reply.code(400).type("text/html").send(
    `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
     <body style="font:15px system-ui;background:#0b1120;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0">
     <div style="max-width:30rem;text-align:center"><h1 style="font-size:18px">${esc(title)}</h1>
     <p style="color:#94a3b8">${esc(detail)}</p></div></body>`,
  );
}

function consentPage(opts: { issuer: string; appName: string; scopes: string[]; user: string; params: Record<string, string> }): string {
  const hidden = Object.entries(opts.params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const scopeText: Record<string, string> = {
    openid: "Confirm your identity",
    profile: "Your name and username",
    email: "Your email address",
  };
  const items = opts.scopes.map((s) => `<li>${esc(scopeText[s] ?? s)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize ${esc(opts.appName)}</title><style>
   :root{color-scheme:dark} body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1120;color:#e2e8f0;font:15px/1.5 system-ui,-apple-system,sans-serif}
   .card{width:100%;max-width:26rem;background:#0f172a;border:1px solid #1e293b;border-radius:18px;padding:28px}
   .mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6 50%,#0ea5e9);margin:0 auto 14px}
   h1{font-size:18px;text-align:center;margin:0 0 6px} .sub{color:#94a3b8;text-align:center;font-size:13px;margin-bottom:18px}
   ul{list-style:none;padding:0;margin:0 0 20px} li{padding:9px 12px;background:#0b1120;border:1px solid #1e293b;border-radius:10px;margin-bottom:8px;font-size:14px}
   li::before{content:"✓ ";color:#34d399} .row{display:flex;gap:10px} button{flex:1;border:0;border-radius:10px;padding:11px;font:600 14px system-ui;cursor:pointer}
   .allow{background:#fff;color:#0f172a} .deny{background:#1e293b;color:#cbd5e1} .who{color:#64748b;text-align:center;font-size:12px;margin-top:14px}</style></head>
  <body><form class="card" method="post" action="/oidc/authorize">
   <div class="mark"></div>
   <h1><strong>${esc(opts.appName)}</strong> wants to sign you in</h1>
   <p class="sub">using your OpenNAS account</p>
   <ul>${items}</ul>
   ${hidden}
   <div class="row"><button class="deny" name="decision" value="deny" type="submit">Cancel</button>
   <button class="allow" name="decision" value="allow" type="submit">Allow</button></div>
   <p class="who">Signed in as ${esc(opts.user)}</p>
  </form></body></html>`;
}

/** Validate the client + redirect_uri (the two things we must not redirect on if wrong). */
function validateClientRedirect(
  clientId: string | undefined,
  redirectUri: string | undefined,
): { ok: false; error: string } | { ok: true; client: ReturnType<typeof getClient> & object; redirectUri: string } {
  if (!clientId) return { ok: false, error: "Unknown application." };
  const client = getClient(clientId);
  if (!client) return { ok: false, error: "Unknown application (client_id)." };
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { ok: false, error: "The redirect URI isn't registered for this application." };
  return { ok: true, client, redirectUri };
}

export async function oidcProvider(app: FastifyInstance): Promise<void> {
  // Parse form posts from the consent page without an extra dependency.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err as Error);
    }
  });

  app.get("/.well-known/openid-configuration", async (req) => {
    const iss = issuerFor(req);
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oidc/authorize`,
      token_endpoint: `${iss}/oidc/token`,
      userinfo_endpoint: `${iss}/oidc/userinfo`,
      jwks_uri: `${iss}/oidc/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: SUPPORTED_SCOPES,
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      code_challenge_methods_supported: ["S256"],
      claims_supported: ["sub", "name", "preferred_username", "email", "email_verified"],
    };
  });

  app.get("/oidc/jwks", async () => jwks());

  app.get("/oidc/authorize", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const vr = validateClientRedirect(q.client_id, q.redirect_uri);
    if (!vr.ok) return errorPage(reply, "Can't sign you in", vr.error);
    const { client, redirectUri } = vr;
    const redirect = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.state) u.searchParams.set("state", q.state);
      return reply.redirect(u.toString());
    };

    if (q.response_type !== "code") return redirect({ error: "unsupported_response_type" });
    const scope = q.scope ?? "";
    if (!scope.split(/\s+/).includes("openid")) return redirect({ error: "invalid_scope", error_description: "openid scope required" });
    if (q.code_challenge && q.code_challenge_method !== "S256") return redirect({ error: "invalid_request", error_description: "only S256 PKCE supported" });

    // Not signed in → bounce through the OpenNAS login, then back here.
    if (!req.auth) {
      return reply.redirect(`/?oidc_return=${encodeURIComponent(req.url)}`);
    }

    const granted = scope.split(/\s+/).filter((s) => SUPPORTED_SCOPES.includes(s));
    return reply.type("text/html").send(
      consentPage({
        issuer: issuerFor(req),
        appName: client.name,
        scopes: granted,
        user: req.auth.user.displayName,
        params: {
          client_id: q.client_id!,
          redirect_uri: q.redirect_uri!,
          response_type: "code",
          scope: granted.join(" "),
          ...(q.state ? { state: q.state } : {}),
          ...(q.nonce ? { nonce: q.nonce } : {}),
          ...(q.code_challenge ? { code_challenge: q.code_challenge, code_challenge_method: "S256" } : {}),
        },
      }),
    );
  });

  app.post("/oidc/authorize", async (req, reply) => {
    const b = req.body as Record<string, string>;
    const vr = validateClientRedirect(b.client_id, b.redirect_uri);
    if (!vr.ok) return errorPage(reply, "Can't sign you in", vr.error);
    if (!req.auth) return errorPage(reply, "Session expired", "Please sign in to OpenNAS again.");

    const u = new URL(vr.redirectUri);
    if (b.state) u.searchParams.set("state", b.state);
    if (b.decision !== "allow") {
      u.searchParams.set("error", "access_denied");
      return reply.redirect(u.toString());
    }
    const code = issueCode({
      userId: req.auth.user.id,
      clientId: vr.client.clientId,
      redirectUri: vr.redirectUri,
      scope: b.scope ?? "openid",
      nonce: b.nonce ?? null,
      codeChallenge: b.code_challenge ?? null,
      authTime: Math.floor(Date.now() / 1000),
    });
    u.searchParams.set("code", code);
    return reply.redirect(u.toString());
  });

  app.post("/oidc/token", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const tokenError = (error: string, description?: string) =>
      reply.code(400).send({ error, ...(description ? { error_description: description } : {}) });

    if (b.grant_type !== "authorization_code") return tokenError("unsupported_grant_type");

    // Client auth: HTTP Basic, or client_id/secret in the body, or public+PKCE.
    let clientId = b.client_id;
    let clientSecret = b.client_secret;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(authHeader.slice(6), "base64").toString().split(":");
      clientId = id || clientId;
      clientSecret = secret ?? clientSecret;
    }
    if (!clientId || !getClient(clientId)) return tokenError("invalid_client");

    const c = consumeCode(b.code ?? "");
    if (!c || c.clientId !== clientId) return tokenError("invalid_grant", "Bad or expired authorization code.");
    if (c.redirectUri !== b.redirect_uri) return tokenError("invalid_grant", "redirect_uri mismatch.");

    // Authenticate: PKCE if a challenge was used, otherwise the client secret.
    if (c.codeChallenge) {
      if (!b.code_verifier || b64urlSha256(b.code_verifier) !== c.codeChallenge) return tokenError("invalid_grant", "PKCE verification failed.");
    } else {
      if (!clientSecret || !verifyClientSecret(clientId, clientSecret)) return tokenError("invalid_client", "Client authentication failed.");
    }

    const claims = claimsFor(c.userId, c.scope);
    if (!claims) return tokenError("invalid_grant", "User no longer exists.");

    const iss = issuerFor(req);
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt({
      iss,
      sub: c.userId,
      aud: clientId,
      iat: now,
      exp: now + 3600,
      auth_time: c.authTime,
      ...(c.nonce ? { nonce: c.nonce } : {}),
      ...claims,
    });
    const { token } = issueAccessToken({ userId: c.userId, clientId, scope: c.scope });

    reply.header("Cache-Control", "no-store");
    return { access_token: token, token_type: "Bearer", expires_in: 3600, id_token: idToken, scope: c.scope };
  });

  const userinfo = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.body as { access_token?: string })?.access_token;
    const at = token ? getAccessToken(token) : null;
    if (!at) {
      reply.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return reply.code(401).send({ error: "invalid_token" });
    }
    const claims = claimsFor(at.userId, at.scope);
    if (!claims) return reply.code(404).send({ error: "not_found" });
    return claims;
  };
  app.get("/oidc/userinfo", userinfo);
  app.post("/oidc/userinfo", userinfo);
}
