import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHANNEL,
  compareVersions,
  parseRelease,
} from "../../apps/api/src/system/updater.js";

/**
 * Version ordering and manifest parsing.
 *
 * These two are what stand between "an update server told us something" and
 * "we downloaded and installed it", so they are tested against the answers that
 * would actually hurt: a downgrade dressed up as an upgrade, a manifest with an
 * http:// bundle, a digest that isn't one.
 */

const digest = "a".repeat(64);

function manifest(over: Record<string, unknown> = {}) {
  return {
    version: "1.2.3",
    releasedAt: "2026-01-01T00:00:00Z",
    notes: "hello",
    bundleUrl: "https://example.test/o.tar.gz",
    signatureUrl: "https://example.test/o.tar.gz.sig",
    sha256: digest,
    ...over,
  };
}

test("compareVersions orders the ordinary cases", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.1.0", "1.0.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  // Missing components read as zero, so "1.2" is 1.2.0 rather than unparseable.
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.1", "1.2"), 1);
});

test("compareVersions ignores build metadata", () => {
  // This is the whole reason VERSION can carry a commit hash: every rebuild of
  // the same release must not look like a new release.
  assert.equal(compareVersions("1.2.3+abc1234", "1.2.3+def5678"), 0);
  assert.equal(compareVersions("1.2.3+abc1234", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.4+abc", "1.2.3+zzz"), 1);
});

test("a pre-release sorts below the same version without one", () => {
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0-beta.2"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.2"), 0);
  // A pre-release of a *higher* version still beats a lower release.
  assert.equal(compareVersions("1.1.0-beta.1", "1.0.9"), 1);
});

test("a beta build is not offered an older release", () => {
  // The check in checkForUpdate is `compareVersions(release, current) > 0`, so
  // this is the property that stops a rolled-back channel downgrading a fleet.
  assert.ok(compareVersions("1.0.0", "1.2.0+abc") <= 0);
  assert.ok(compareVersions("1.2.0", "1.2.0+abc") <= 0);
  assert.ok(compareVersions("1.2.1", "1.2.0+abc") > 0);
});

test("parseRelease accepts a well-formed manifest", () => {
  const r = parseRelease(manifest());
  assert.ok(r);
  assert.equal(r.version, "1.2.3");
  assert.equal(r.sha256, digest);
  assert.equal(r.notes, "hello");
});

test("parseRelease refuses anything that is not an object", () => {
  for (const bad of [null, undefined, 0, "", "{}", [], true]) {
    assert.equal(parseRelease(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("parseRelease insists on a real sha256", () => {
  for (const sha of ["", "abc", digest.slice(0, 63), digest + "a", "g".repeat(64), null, 123]) {
    assert.equal(parseRelease(manifest({ sha256: sha })), null, `accepted ${String(sha)}`);
  }
  // Case-insensitive, because a manifest written by hand may be upper-case.
  const upper = parseRelease(manifest({ sha256: "A".repeat(64) }));
  assert.equal(upper?.sha256, "a".repeat(64));
});

test("parseRelease refuses a missing version", () => {
  assert.equal(parseRelease(manifest({ version: "" })), null);
  assert.equal(parseRelease(manifest({ version: "   " })), null);
  assert.equal(parseRelease(manifest({ version: 5 })), null);
});

test("parseRelease is https-only", () => {
  for (const url of [
    "http://example.test/o.tar.gz",
    "ftp://example.test/o.tar.gz",
    "file:///etc/passwd",
    "/relative/path",
    "javascript:alert(1)",
    "",
  ]) {
    assert.equal(parseRelease(manifest({ bundleUrl: url })), null, `accepted bundle ${url}`);
    assert.equal(parseRelease(manifest({ signatureUrl: url })), null, `accepted sig ${url}`);
  }
});

test("parseRelease caps the notes so a channel can't hand us a novel", () => {
  const r = parseRelease(manifest({ notes: "x".repeat(10_000) }));
  assert.equal(r?.notes.length, 4000);
  // A non-string becomes empty rather than leaking into the UI as "[object Object]".
  assert.equal(parseRelease(manifest({ notes: { a: 1 } }))?.notes, "");
  assert.equal(parseRelease(manifest({ releasedAt: 42 }))?.releasedAt, "");
});

test("the default channel is https", () => {
  assert.match(DEFAULT_CHANNEL, /^https:\/\//);
});

test("pre-release identifiers are compared the way semver does", () => {
  // The one that matters during a beta: as plain strings "beta.10" < "beta.9",
  // so the tenth beta would never be offered to anyone on the ninth.
  assert.equal(compareVersions("1.0.0-beta.10", "1.0.0-beta.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.9", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);

  // A numeric identifier ranks below an alphanumeric one.
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);

  // More identifiers wins when everything before them matches.
  assert.equal(compareVersions("1.0.0-beta.1.1", "1.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0-beta.1.1"), -1);

  // The example chain from the semver spec, in order.
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.equal(compareVersions(chain[i]!, chain[i + 1]!), -1, `${chain[i]} should sort below ${chain[i + 1]}`);
    assert.equal(compareVersions(chain[i + 1]!, chain[i]!), 1, `${chain[i + 1]} should sort above ${chain[i]}`);
  }
  for (const v of chain) assert.equal(compareVersions(v, v), 0, `${v} should equal itself`);
});

test("a beta series upgrades in order, and to the release", () => {
  // What an installed beta machine actually asks: "is this newer than me?"
  const running = "0.9.0-beta.1+abc1234";
  assert.ok(compareVersions("0.9.0-beta.2", running) > 0);
  assert.ok(compareVersions("0.9.0", running) > 0);
  assert.ok(compareVersions("1.0.0", running) > 0);
  assert.ok(compareVersions("0.9.0-beta.1", running) === 0, "a rebuild of the same beta is not an update");
  assert.ok(compareVersions("0.8.9", running) < 0);
});
