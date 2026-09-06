import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import {
  BAN_SECONDS,
  addressInCidr,
  clearIpFailures,
  isBannable,
  listRecordedBans,
  recordBan,
  recordIpFailure,
  removeBan,
} from "../../apps/api/src/db/ip-bans.js";

/**
 * Auto-banning addresses that keep failing to sign in.
 *
 * The bug worth catching here is not "an attacker got extra tries". It is the
 * admin locking themselves out of a headless box, which takes physical access to
 * undo. So most of this is about who must *never* be banned.
 */

test("loopback is never bannable", () => {
  for (const a of ["127.0.0.1", "127.0.0.53", "127.1.2.3", "::1", "::ffff:127.0.0.1", "  127.0.0.1  "]) {
    assert.equal(isBannable(a, []), false, `would ban ${a}`);
  }
});

test("an empty address is never bannable", () => {
  assert.equal(isBannable("", []), false);
  assert.equal(isBannable("   ", []), false);
});

test("trusted networks are exempt", () => {
  assert.equal(isBannable("192.168.1.50", ["192.168.1.0/24"]), false);
  assert.equal(isBannable("192.168.2.50", ["192.168.1.0/24"]), true);
  assert.equal(isBannable("10.4.0.9", ["192.168.1.0/24", "10.0.0.0/8"]), false);
});

test("an ordinary public address is bannable", () => {
  assert.equal(isBannable("203.0.113.7", []), true);
  assert.equal(isBannable("203.0.113.7", ["192.168.1.0/24"]), true);
});

test("addressInCidr does IPv4 prefix maths", () => {
  assert.ok(addressInCidr("192.168.1.1", "192.168.1.0/24"));
  assert.ok(addressInCidr("192.168.1.255", "192.168.1.0/24"));
  assert.ok(!addressInCidr("192.168.2.1", "192.168.1.0/24"));
  assert.ok(addressInCidr("10.255.255.255", "10.0.0.0/8"));
  assert.ok(!addressInCidr("11.0.0.1", "10.0.0.0/8"));
  assert.ok(addressInCidr("172.16.5.4", "172.16.0.0/12"));
  assert.ok(!addressInCidr("172.32.5.4", "172.16.0.0/12"));
  // /31 and /32, where the shift maths is easy to get wrong.
  assert.ok(addressInCidr("192.168.1.7", "192.168.1.7/32"));
  assert.ok(!addressInCidr("192.168.1.8", "192.168.1.7/32"));
  assert.ok(addressInCidr("192.168.1.6", "192.168.1.6/31"));
  assert.ok(addressInCidr("192.168.1.7", "192.168.1.6/31"));
  assert.ok(!addressInCidr("192.168.1.8", "192.168.1.6/31"));
});

test("addressInCidr handles the whole-internet and high-bit cases", () => {
  // 0.0.0.0/0 matches everything - an admin who trusts it has disabled banning,
  // which is their call, but it must not be read as "matches nothing".
  assert.ok(addressInCidr("1.2.3.4", "0.0.0.0/0"));
  assert.ok(addressInCidr("255.255.255.255", "0.0.0.0/0"));
  // Addresses above 2^31 must not go negative through the shift.
  assert.ok(addressInCidr("255.255.255.255", "255.255.255.0/24"));
  assert.ok(addressInCidr("200.0.0.1", "200.0.0.0/24"));
  assert.ok(!addressInCidr("128.0.0.1", "0.0.0.0/8"));
});

test("addressInCidr treats a bare address as /32", () => {
  assert.ok(addressInCidr("192.168.1.7", "192.168.1.7"));
  assert.ok(!addressInCidr("192.168.1.8", "192.168.1.7"));
});

test("addressInCidr never matches across families", () => {
  assert.ok(!addressInCidr("192.168.1.1", "fd00::/8"));
  assert.ok(!addressInCidr("fd00::1", "192.168.1.0/24"));
  assert.ok(!addressInCidr("192.168.1.1", ""));
  assert.ok(!addressInCidr("192.168.1.1", "/24"));
});

test("IPv6 prefix matching is coarse but fails safe", () => {
  // Textual prefix only. It can only ever *widen* the exempt set, so the
  // consequence of imprecision is an address that isn't banned - never one that
  // is banned wrongly.
  assert.ok(addressInCidr("fd00:1234::5", "fd00:1234::/32"));
  assert.ok(!addressInCidr("fe80::1", "fd00:1234::/32"));
  // "::/0" has an empty prefix, so it matches every v6 address.
  assert.ok(addressInCidr("fe80::1", "::/0"));
  // A non-address never reaches the v6 branch at all.
  assert.ok(!addressInCidr("anything", "::/0"));
});

test("failures accumulate and cross the threshold once", () => {
  const addr = "203.0.113.11";
  clearIpFailures(addr);
  let banned = 0;
  let last = 0;
  for (let i = 1; i <= 25; i++) {
    const r = recordIpFailure(addr);
    assert.equal(r.failures, i, `count drifted at attempt ${i}`);
    if (r.shouldBan) banned++;
    last = r.failures;
  }
  assert.equal(last, 25);
  // The threshold is well above the per-account one, because one address is
  // routinely a whole household behind NAT.
  assert.ok(banned > 0 && banned < 25, `banned on ${banned} of 25 attempts`);
});

test("a successful sign-in clears the history", () => {
  const addr = "203.0.113.12";
  clearIpFailures(addr);
  recordIpFailure(addr);
  recordIpFailure(addr);
  clearIpFailures(addr);
  assert.equal(recordIpFailure(addr).failures, 1);
});

test("failures outside the window are forgotten", () => {
  const addr = "203.0.113.13";
  clearIpFailures(addr);
  const long = new Date("2026-01-01T00:00:00Z");
  recordIpFailure(addr, long);
  assert.equal(recordIpFailure(addr, new Date(long.getTime() + 60_000)).failures, 2);
  // Sixteen minutes later the window has rolled over.
  assert.equal(recordIpFailure(addr, new Date(long.getTime() + 16 * 60_000)).failures, 1);
});

test("an empty address records nothing", () => {
  assert.deepEqual(recordIpFailure(""), { failures: 0, shouldBan: false });
});

test("a recorded ban expires and stops being listed", () => {
  const addr = "203.0.113.14";
  removeBan(addr);
  const ban = recordBan(addr, "test", 20, 3600);
  assert.equal(ban.address, addr);
  assert.equal(ban.failures, 20);
  assert.ok(Date.parse(ban.expiresAt) > Date.parse(ban.bannedAt));

  const now = new Date();
  assert.ok(listRecordedBans(now).some((b) => b.address === addr));
  // An hour and a minute on, it is gone from the list without anything sweeping -
  // listRecordedBans deletes expired rows as it goes, which is also why nothing
  // is left for removeBan to find afterwards.
  const later = new Date(now.getTime() + (3600 + 60) * 1000);
  assert.ok(!listRecordedBans(later).some((b) => b.address === addr));
  assert.equal(removeBan(addr), false);
});

test("removeBan reports whether it actually lifted anything", () => {
  const addr = "203.0.113.15";
  recordBan(addr, "test", 20, 3600);
  assert.equal(removeBan(addr), true);
  assert.equal(removeBan(addr), false);
  assert.ok(!listRecordedBans().some((b) => b.address === addr));
});

test("re-banning an address replaces its row rather than duplicating it", () => {
  const addr = "203.0.113.16";
  removeBan(addr);
  recordBan(addr, "first", 20, 3600);
  recordBan(addr, "second", 25, 3600);
  const rows = listRecordedBans().filter((b) => b.address === addr);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, "second");
  assert.equal(rows[0]!.failures, 25);
  removeBan(addr);
});

test("being banned resets the failure counter", () => {
  // Otherwise an address coming back after its hour would be re-banned on its
  // very next mistake, turning a one-hour ban into a permanent one.
  const addr = "203.0.113.17";
  clearIpFailures(addr);
  for (let i = 0; i < 5; i++) recordIpFailure(addr);
  recordBan(addr, "test", 5, 3600);
  assert.equal(recordIpFailure(addr).failures, 1);
  removeBan(addr);
});

test("bans are temporary by default", () => {
  // A permanent ban on a headless NAS is a support call. An hour is long enough
  // to end a run and short enough to wait out.
  assert.ok(BAN_SECONDS > 0 && BAN_SECONDS <= 24 * 3600);
});
