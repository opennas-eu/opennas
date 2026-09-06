import test from "node:test";
import assert from "node:assert/strict";
import {
  PCI_ADDR_RE,
  USB_ID_RE,
  normalizePciAddress,
} from "../../apps/api/src/system/passthrough.js";

/**
 * Parsing the identifiers that end up inside a libvirt domain XML.
 *
 * Everything else in this module talks to real sysfs and real virsh, so it lives
 * in tests/system. What is testable in isolation is the parsing - and it matters,
 * because a value that gets past `normalizePciAddress` is interpolated into XML
 * and handed to a hypervisor.
 */

test("normalizePciAddress fills in the missing domain", () => {
  assert.equal(normalizePciAddress("03:00.0"), "0000:03:00.0");
  assert.equal(normalizePciAddress("0000:03:00.0"), "0000:03:00.0");
  assert.equal(normalizePciAddress("0001:1f:1f.7"), "0001:1f:1f.7");
});

test("normalizePciAddress lower-cases and trims", () => {
  assert.equal(normalizePciAddress("  0000:0A:00.1  "), "0000:0a:00.1");
  assert.equal(normalizePciAddress("AB:CD.0"), "0000:ab:cd.0");
});

test("normalizePciAddress refuses anything that is not an address", () => {
  for (const bad of [
    "",
    "   ",
    "03:00",
    "03:00.8", // function is 0-7
    "3:0.0",
    "0000:03:00.0 extra",
    "0000:03:00.0;reboot",
    "../../etc/passwd",
    "0000:03:00.0\n0000:04:00.0",
    "zz:00.0",
    "00000:03:00.0",
    "<hostdev/>",
  ]) {
    assert.equal(normalizePciAddress(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("PCI_ADDR_RE is anchored at both ends", () => {
  // An unanchored regex here would let "0000:03:00.0'/><script>" through into
  // the domain XML.
  assert.ok(PCI_ADDR_RE.test("0000:03:00.0"));
  assert.ok(!PCI_ADDR_RE.test("x0000:03:00.0"));
  assert.ok(!PCI_ADDR_RE.test("0000:03:00.0x"));
  assert.ok(!PCI_ADDR_RE.test("0000:03:00.0\nmore"));
});

test("USB_ID_RE accepts vendor:product and nothing else", () => {
  assert.ok(USB_ID_RE.test("1d6b:0002"));
  assert.ok(USB_ID_RE.test("1D6B:0002"));
  assert.ok(!USB_ID_RE.test("1d6b"));
  assert.ok(!USB_ID_RE.test("1d6b:0002:0003"));
  assert.ok(!USB_ID_RE.test("1d6b:002"));
  assert.ok(!USB_ID_RE.test(" 1d6b:0002"));
  assert.ok(!USB_ID_RE.test("1d6b:0002 "));
  assert.ok(!USB_ID_RE.test("zzzz:0002"));
});

test("the regexes are not sticky or global", () => {
  // A /g regex carries lastIndex between .test() calls, so the same input would
  // alternate true and false. Easy to introduce, very confusing to debug.
  for (const re of [PCI_ADDR_RE, USB_ID_RE]) {
    assert.equal(re.global, false);
    assert.equal(re.sticky, false);
  }
  assert.equal(PCI_ADDR_RE.test("0000:03:00.0"), PCI_ADDR_RE.test("0000:03:00.0"));
  assert.equal(USB_ID_RE.test("1d6b:0002"), USB_ID_RE.test("1d6b:0002"));
});
