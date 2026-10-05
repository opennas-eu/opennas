import test from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, parseV6 } from "../../apps/api/src/apps/fetch-proxy.js";

/**
 * The fetch proxy's address filter, which is what keeps an app with the
 * "fetch" permission off the LAN and off the NAS itself.
 *
 * IPv6 has many spellings for an IPv4 address, and the filter used to recognise
 * only the dotted ones: `::ffff:7f00:1` is 127.0.0.1 written in hex, and
 * `64:ff9b::a00:1` is 10.0.0.1 through any NAT64 gateway on the path. Each is
 * judged as the IPv4 address it carries.
 */

test("embedded IPv4 is judged as IPv4, however it is written", () => {
  for (const ip of [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:7F00:0001",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:c0a8:101",
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "::ffff:0:7f00:1", // SIIT-translated
    "::127.0.0.1", // IPv4-compatible
    "::7f00:1",
    "::a00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b::c0a8:1",
    "64:ff9b:1::8.8.8.8", // local-use NAT64 prefix
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("public addresses through the same forms are still allowed", () => {
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("IPv6-only special ranges are refused", () => {
  for (const ip of [
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "fec0::1",
    "ff02::1",
    "2002:7f00:1::1",
    "2001:0:4136:e378::1",
    "2001:db8::1",
    "100::1",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("parseV6 expands every spelling to eight groups", () => {
  assert.deepEqual(parseV6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseV6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(parseV6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseV6("1::8"), [1, 0, 0, 0, 0, 0, 0, 8]);
  assert.equal(parseV6("127.0.0.1"), null);
  assert.equal(parseV6("not-an-address"), null);
});
