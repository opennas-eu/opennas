import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeAddress } from "../../apps/api/src/system/ddns.js";

/**
 * The guard on what gets pushed to a DNS provider.
 *
 * The public-IP echoes are third-party HTTP endpoints, so their answer is
 * untrusted input that ends up in an outbound URL. An echo that returns an error
 * page must not become an A record.
 */

test("accepts ordinary IPv4", () => {
  for (const a of ["1.2.3.4", "192.168.1.1", "255.255.255.255", "0.0.0.0", " 203.0.113.7\n"]) {
    assert.ok(looksLikeAddress(a), `rejected ${JSON.stringify(a)}`);
  }
});

test("accepts IPv6", () => {
  for (const a of ["::1", "fd00::1", "2001:db8::dead:beef", "fe80::1ff:fe23:4567:890a"]) {
    assert.ok(looksLikeAddress(a), `rejected ${a}`);
  }
});

test("refuses octets above 255", () => {
  for (const a of ["256.1.1.1", "1.256.1.1", "1.1.1.999", "300.300.300.300"]) {
    assert.equal(looksLikeAddress(a), false, `accepted ${a}`);
  }
});

test("refuses what an echo returns when it is having a bad day", () => {
  for (const a of [
    "",
    "   ",
    "<!DOCTYPE html>",
    "Service Unavailable",
    "1.2.3.4 (via proxy)",
    "1.2.3.4\n1.2.3.5",
    "1.2.3",
    "1.2.3.4.5",
    "example.com",
    "1.2.3.4/24",
    "not an address",
  ]) {
    assert.equal(looksLikeAddress(a), false, `accepted ${JSON.stringify(a)}`);
  }
});

test("refuses an over-long value", () => {
  // 45 characters is the longest a real IPv6 address gets. Anything past that is
  // a page, not an answer.
  assert.equal(looksLikeAddress(":" + "a".repeat(60)), false);
});
