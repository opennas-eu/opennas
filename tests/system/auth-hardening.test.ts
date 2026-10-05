import "../helpers/env.js";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

/**
 * Sign-in paths that have to hold before, during and after first setup.
 *
 * - `/api/auth/setup` creates the first administrator exactly once, even when
 *   two requests race through its password hashing together.
 * - SSO is not a way in before setup has run (the first SSO user would
 *   otherwise become the administrator), and a callback only completes in the
 *   browser that started the login - the state is bound to a signed cookie.
 * - A user with setup outstanding reaches only the routes that clear it.
 *
 * SSO is switched on through the environment, which config.ts reads once at
 * import - so the server is imported dynamically, after the variables are set.
 * The issuer is never contacted: every case here is decided before that.
 */

process.env.OPENNAS_OIDC_ISSUER = "http://127.0.0.1:9/issuer";
process.env.OPENNAS_OIDC_CLIENT_ID = "opennas-test";

const { buildServer } = await import("../../apps/api/src/server.js");
const { putOidcState, takeOidcState } = await import("../../apps/api/src/db/oidc.js");
const { oidcStateBinding, oidcStateMatches } = await import("../../apps/api/src/auth/oidc.js");
const { countUsers, createUser, setMustChangePassword } = await import("../../apps/api/src/db/users.js");
const { createSession } = await import("../../apps/api/src/db/sessions.js");
const { config } = await import("../../apps/api/src/config.js");

let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
});

test("SSO auto-provisioning is off unless asked for", () => {
  assert.equal(config.oidc.autoCreateUsers, false);
});

test("SSO is refused until setup has created the administrator", async () => {
  assert.equal(countUsers(), 0, "this file must run against an empty database");
  const start = await app.inject({ method: "GET", url: "/api/auth/oidc/start" });
  assert.equal(start.statusCode, 302);
  assert.match(String(start.headers.location), /sso_error=not_setup/);
  const cb = await app.inject({ method: "GET", url: "/api/auth/oidc/callback?state=x&code=y" });
  assert.match(String(cb.headers.location), /sso_error=not_setup/);
});

test("two racing setup requests create one administrator", async () => {
  const body = (username: string) => ({
    instanceName: "Race",
    username,
    displayName: username,
    password: "correct horse battery staple 42",
  });
  const results = await Promise.all(
    ["first-admin", "second-admin", "third-admin"].map((u) =>
      app.inject({ method: "POST", url: "/api/auth/setup", payload: body(u) }),
    ),
  );
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [201, 409, 409], results.map((r) => r.body).join("\n"));
  assert.equal(countUsers(), 1);
});

test("a callback without the browser's state cookie is refused before the state is used", async () => {
  putOidcState("state-no-cookie", "verifier", "nonce");
  const res = await app.inject({ method: "GET", url: "/api/auth/oidc/callback?state=state-no-cookie&code=c" });
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers.location), /sso_error=state_mismatch/);
  // Not consumed: the real browser can still finish its own login.
  assert.ok(takeOidcState("state-no-cookie"));
});

test("a cookie bound to a different state is refused, and a forged one too", async () => {
  putOidcState("state-a", "verifier", "nonce");
  const other = app.signCookie(oidcStateBinding("state-b"));
  const res = await app.inject({
    method: "GET",
    url: "/api/auth/oidc/callback?state=state-a&code=c",
    headers: { cookie: `opennas_oidc_state=${other}` },
  });
  assert.match(String(res.headers.location), /sso_error=state_mismatch/);

  const unsigned = await app.inject({
    method: "GET",
    url: "/api/auth/oidc/callback?state=state-a&code=c",
    headers: { cookie: `opennas_oidc_state=${oidcStateBinding("state-a")}` },
  });
  assert.match(String(unsigned.headers.location), /sso_error=state_mismatch/);
  assert.ok(takeOidcState("state-a"));
});

test("the binding matches only its own state", () => {
  assert.ok(oidcStateMatches(oidcStateBinding("s1"), "s1"));
  assert.ok(!oidcStateMatches(oidcStateBinding("s1"), "s2"));
  assert.ok(!oidcStateMatches(undefined, "s1"));
  assert.ok(!oidcStateMatches(oidcStateBinding("s1"), null));
});

test("a user who must change their password reaches only the routes that clear it", async () => {
  const u = createUser({ username: `pending-${process.pid}`, displayName: "P", role: "user" });
  setMustChangePassword(u.id, true);
  const cookie = `opennas_session=${app.signCookie(createSession(u.id, ["password"]).token)}`;
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

  const me = await get("/api/auth/me");
  assert.equal(me.statusCode, 200);
  assert.deepEqual(JSON.parse(me.body).session.pendingActions, ["password"]);

  for (const url of ["/api/files/list?path=/", "/api/apps", "/api/notes", "/api/auth/sessions"]) {
    const res = await get(url);
    assert.equal(res.statusCode, 403, url);
    assert.equal(JSON.parse(res.body).error, "setup_required", url);
  }
});
