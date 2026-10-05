import "../helpers/env.js";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer, appContentId } from "../../apps/api/src/server.js";
import { config } from "../../apps/api/src/config.js";
import { createUser, setMustChangePassword } from "../../apps/api/src/db/users.js";
import { createSession } from "../../apps/api/src/db/sessions.js";
import { setAppAccess } from "../../apps/api/src/db/app-access.js";

/**
 * `/app-content/<id>/...` against the real server: the per-user app allow-list
 * has to hold however the id is spelled, and the content must never run on the
 * NAS origin when opened outside its sandboxed iframe.
 *
 * The id used to be taken as "whatever comes before the first slash", so
 * `/app-content//secretapp/index.html` produced an empty id, skipped the check,
 * and was still served by @fastify/static. Every spelling below is one the
 * static handler (or the router in front of it) can map onto `secretapp`.
 */

// This file is quick enough to finish before pino's pretty-printing worker has
// drained, which can leave that worker holding the process open. Plain JSON
// logging has no worker. Read by buildServer(), so setting it here is in time.
process.env.OPENNAS_LOG_PRETTY = "false";

let app: Awaited<ReturnType<typeof buildServer>>;
let restricted: string;
let allowed: string;

const SECRET = "SECRET-APP-CONTENT";

function sessionCookie(userId: string): string {
  return `opennas_session=${app.signCookie(createSession(userId, ["password"]).token)}`;
}

before(async () => {
  app = await buildServer();
  await app.ready();
  mkdirSync(join(config.appsDir, "secretapp"), { recursive: true });
  writeFileSync(join(config.appsDir, "secretapp", "index.html"), SECRET);

  const r = createUser({ username: `gate-r-${process.pid}`, displayName: "R", role: "user" });
  setAppAccess(r.id, { restricted: true, appIds: [] });
  restricted = sessionCookie(r.id);

  const a = createUser({ username: `gate-a-${process.pid}`, displayName: "A", role: "user" });
  allowed = sessionCookie(a.id);
});

after(async () => {
  await app?.close();
});

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

test("a restricted user can't reach an app's files by any spelling of its id", async () => {
  for (const url of [
    "/app-content/secretapp/index.html",
    "/app-content//secretapp/index.html",
    "/app-content///secretapp/index.html",
    "/app-content/%73ecretapp/index.html",
    "/app-content/./secretapp/index.html",
    "/app-content/%2E/secretapp/index.html",
    "/app-content/x/../secretapp/index.html",
    "/app-content/secretapp%2Findex.html",
    "/app-content/SECRETAPP/index.html",
  ]) {
    const res = await get(url, restricted);
    assert.notEqual(res.statusCode, 200, `${url} was served`);
    assert.ok(!res.body.includes(SECRET), `${url} leaked the app's content`);
  }
});

test("a malformed escape is refused, not thrown", async () => {
  const res = await get("/app-content/%E0%A4%A/x", restricted);
  assert.ok(res.statusCode === 400 || res.statusCode === 404, `got ${res.statusCode}`);
  assert.ok(!res.body.includes(SECRET));
});

test("an unrestricted user still gets the file", async () => {
  const res = await get("/app-content/secretapp/index.html", allowed);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, SECRET);
});

test("app content carries a sandbox CSP without allow-same-origin", async () => {
  const res = await get("/app-content/secretapp/index.html", allowed);
  const csp = String(res.headers["content-security-policy"]);
  assert.match(csp, /(^|;)\s*sandbox allow-scripts/);
  assert.ok(!csp.includes("allow-same-origin"), csp);
});

test("a user with setup outstanding gets no app content", async () => {
  const u = createUser({ username: `gate-p-${process.pid}`, displayName: "P", role: "user" });
  setMustChangePassword(u.id, true);
  const res = await get("/app-content/secretapp/index.html", sessionCookie(u.id));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "setup_required");
});

test("appContentId only accepts clean, decodable paths", () => {
  assert.equal(appContentId("/app-content/notes/index.html?x=1"), "notes");
  assert.equal(appContentId("/app-content/notes/assets/"), "notes");
  assert.equal(appContentId("/app-content//notes/index.html"), null);
  assert.equal(appContentId("/app-content/%6Eotes/x"), "notes");
  assert.equal(appContentId("/app-content/notes%2F..%2Fother/x"), null);
  assert.equal(appContentId("/app-content/notes/%E0%A4%A"), null);
  assert.equal(appContentId("/app-content/../etc/passwd"), null);
  assert.equal(appContentId("/app-content/"), null);
});
