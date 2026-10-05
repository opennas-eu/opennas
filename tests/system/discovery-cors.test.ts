import "../helpers/env.js";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../../apps/api/src/server.js";

/**
 * `/api/discover` and its Private Network Access preflight, against the real
 * server.
 *
 * This exists because the obvious way to check it does not work. Curling the
 * endpoint without an `Origin` header reports a perfect result while the
 * feature is entirely broken: @fastify/cors only treats an `OPTIONS` as a
 * preflight when `Origin` is present, so without one the request falls through
 * to whatever route happens to be there. That is how a route-level
 * `OPTIONS /api/discover` handler looked correct for a while despite never
 * running in a browser - the plugin answers preflights from its own `onRequest`
 * hook and replies before routing.
 *
 * So every request below carries the headers a browser actually sends.
 *
 * Two properties, and the second matters more than the first:
 *
 * 1. Discovery is open to everyone, and says the PNA opt-in out loud. Without
 *    it Chrome and Edge block every request from a hosted finder.
 * 2. Discovery being open does not open anything else. `/api/discover` is the
 *    single deliberate hole in a same-origin API, and the delegator that opens
 *    it is per-request - so the test that a foreign origin still cannot read
 *    `/api/health` is the one guarding against a widened blast radius.
 */

let app: Awaited<ReturnType<typeof buildServer>>;

const FOREIGN = "https://find.opennas.eu";

before(async () => {
  app = await buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
});

test("the PNA preflight opts in, so a hosted finder is allowed through", async () => {
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/discover",
    headers: {
      origin: FOREIGN,
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });

  assert.equal(res.statusCode, 204);
  // The header the whole feature depends on. Missing it, Chrome blocks the GET
  // that follows and the scan finds nothing on a network full of OpenNAS boxes.
  assert.equal(res.headers["access-control-allow-private-network"], "true");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  // A scan is 254 addresses; an uncached preflight doubles that to 508.
  assert.equal(res.headers["access-control-max-age"], "86400");
});

test("a cross-origin GET is readable and returns a bare constant", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/discover",
    headers: { origin: FOREIGN },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  // `origin: *` with credentials is rejected by browsers outright, so the
  // delegator has to turn credentials off for this route specifically.
  assert.equal(res.headers["access-control-allow-credentials"], undefined);

  // Exactly one field. No version, no hostname, no instance name - an
  // unauthenticated version banner is how somebody picks which exploit to try.
  assert.deepEqual(res.json(), { product: "opennas" });
});

test("opening discovery does not open the rest of the API", async () => {
  for (const url of ["/api/health", "/api/system/info", "/api/auth/session"]) {
    const res = await app.inject({ method: "GET", url, headers: { origin: FOREIGN } });
    assert.notEqual(
      res.headers["access-control-allow-origin"],
      "*",
      `${url} must not be readable by any origin`,
    );
    assert.notEqual(
      res.headers["access-control-allow-origin"],
      FOREIGN,
      `${url} must not be readable by ${FOREIGN}`,
    );
  }
});

test("the PNA opt-in is scoped to discovery and nothing else", async () => {
  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/health",
    headers: {
      origin: FOREIGN,
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });

  assert.equal(res.headers["access-control-allow-private-network"], undefined);
});

test("a query string does not slip past the discovery path check", async () => {
  // isDiscoverPath compares without the query string. If it compared the raw
  // URL, `/api/discover?x=1` would fall through to the default origin list and
  // a finder appending a cache-buster would silently stop working.
  const res = await app.inject({
    method: "GET",
    url: "/api/discover?t=123",
    headers: { origin: FOREIGN },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});
