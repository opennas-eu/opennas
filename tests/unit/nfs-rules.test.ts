import test from "node:test";
import assert from "node:assert/strict";
import { isValidNfsClient } from "../../apps/api/src/db/nfs-rules.js";

/**
 * Whatever this accepts is written verbatim into /etc/exports.
 *
 * exports(5) is whitespace-separated and `#` starts a comment, so a value with a
 * space in it silently becomes two rules and a value with a newline lets a
 * caller append export lines of their own. The injection cases below are the
 * point of the whole function; the acceptance cases exist so nobody "hardens"
 * it into rejecting `*.lan`, which is what people actually type.
 */

test("accepts the specs people actually write", () => {
  for (const ok of [
    "*",
    "192.168.1.10",
    "192.168.1.0/24",
    "10.0.0.0/8",
    "0.0.0.0/0",
    "255.255.255.255/32",
    "nas.lan",
    "*.lan",
    "*.home.arpa",
    "nas?.lan",
    "server-01",
    "a",
    "A.B.C",
  ]) {
    assert.ok(isValidNfsClient(ok), `rejected ${ok}`);
  }
});

test("surrounding whitespace is tolerated", () => {
  assert.ok(isValidNfsClient("  192.168.1.0/24  "));
  assert.ok(isValidNfsClient("\t*.lan\n"));
});

test("refuses anything that would break out of one exports field", () => {
  for (const bad of [
    "192.168.1.0/24 (rw,no_root_squash)",
    "10.0.0.1 *",
    "10.0.0.1\n/etc *(rw)",
    "10.0.0.1\r\n*",
    "host#comment",
    'host"quoted',
    "host'quoted",
    "host\\escaped",
    "host(rw)",
    "a,b",
    "host\tsecond",
  ]) {
    assert.equal(isValidNfsClient(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("refuses malformed addresses instead of treating them as hostnames", () => {
  // The bare-IPv4 branch returns before the hostname branch, so these must not
  // fall through and be accepted as names that happen to look numeric.
  for (const bad of ["300.1.1.1", "1.2.3.4/33", "999.999.999.999", "1.2.3.4/99"]) {
    assert.equal(isValidNfsClient(bad), false, `accepted ${bad}`);
  }
});

test("refuses empty and oversized specs", () => {
  assert.equal(isValidNfsClient(""), false);
  assert.equal(isValidNfsClient("   "), false);
  assert.equal(isValidNfsClient("a".repeat(255)), true);
  assert.equal(isValidNfsClient("a".repeat(256)), false);
});

test("refuses names that start or end with a separator", () => {
  for (const bad of ["-host", "host-", ".host", "host.", "-", "."]) {
    assert.equal(isValidNfsClient(bad), false, `accepted ${bad}`);
  }
});
