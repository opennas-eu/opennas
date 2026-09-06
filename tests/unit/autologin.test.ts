import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import { addressMatches, autologinConfig, setAutologinConfig } from "../../apps/api/src/auth/autologin.js";
import { setSetting } from "../../apps/api/src/db/settings.js";

/**
 * Signing in automatically from a known network.
 *
 * The whole restriction is the network list, so the tests are about the ways it
 * could turn out to mean "everyone": an empty list, a stray loopback match, a
 * setting that survives a bad JSON round trip as something more permissive than
 * what was written.
 */

test("it is off until somebody turns it on", () => {
  const config = autologinConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.userId, null);
  assert.deepEqual(config.networks, []);
});

test("the configuration round-trips", () => {
  setAutologinConfig({ enabled: true, userId: "abc", networks: ["192.168.1.40/32"] });
  assert.deepEqual(autologinConfig(), { enabled: true, userId: "abc", networks: ["192.168.1.40/32"] });
  setAutologinConfig({ enabled: false, userId: null, networks: [] });
  assert.deepEqual(autologinConfig(), { enabled: false, userId: null, networks: [] });
});

test("a corrupt setting reads as off, not as on", () => {
  // The failure direction matters: a parse error must never leave the machine
  // signing people in.
  for (const junk of ["", "{", "null", "[]", '"enabled"', "{ nope"]) {
    setSetting("autologin", junk);
    const config = autologinConfig();
    assert.equal(config.enabled, false, `${junk} read as enabled`);
    assert.deepEqual(config.networks, []);
  }
});

test("a setting with the wrong shapes is coerced downward", () => {
  setSetting("autologin", JSON.stringify({ enabled: "yes", userId: 42, networks: "192.168.1.0/24" }));
  const config = autologinConfig();
  // "yes" is not true. Anything but a real boolean is off.
  assert.equal(config.enabled, false);
  assert.equal(config.userId, null);
  assert.deepEqual(config.networks, []);

  setSetting("autologin", JSON.stringify({ enabled: true, userId: "u1", networks: ["10.0.0.0/8", 5, null, "x"] }));
  assert.deepEqual(autologinConfig().networks, ["10.0.0.0/8", "x"]);
  setAutologinConfig({ enabled: false, userId: null, networks: [] });
});

test("an empty network list matches nobody", () => {
  // Not "everybody", which is what a permissive default would mean here.
  for (const address of ["127.0.0.1", "192.168.1.40", "203.0.113.9", "::1"]) {
    assert.equal(addressMatches(address, []), false, `${address} matched an empty list`);
  }
});

test("a single machine matches only itself", () => {
  const one = ["192.168.1.40/32"];
  assert.equal(addressMatches("192.168.1.40", one), true);
  assert.equal(addressMatches("192.168.1.41", one), false);
  assert.equal(addressMatches("192.168.2.40", one), false);
});

test("a subnet matches its members and nothing else", () => {
  const lan = ["192.168.1.0/24"];
  assert.equal(addressMatches("192.168.1.1", lan), true);
  assert.equal(addressMatches("192.168.1.254", lan), true);
  assert.equal(addressMatches("192.168.2.1", lan), false);
  assert.equal(addressMatches("10.0.0.1", lan), false);
});

test("loopback is not implicitly trusted", () => {
  // nginx proxies from loopback and the health check comes from there, so
  // treating it as a console would sign in every visitor through the proxy.
  assert.equal(addressMatches("127.0.0.1", ["192.168.1.0/24"]), false);
  assert.equal(addressMatches("::1", ["192.168.1.0/24"]), false);
  // It can still be named on purpose.
  assert.equal(addressMatches("127.0.0.1", ["127.0.0.1/32"]), true);
});

test("several networks are all checked", () => {
  const nets = ["192.168.1.40/32", "10.9.0.0/16"];
  assert.equal(addressMatches("192.168.1.40", nets), true);
  assert.equal(addressMatches("10.9.5.5", nets), true);
  assert.equal(addressMatches("10.10.5.5", nets), false);
});
