import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "../helpers/env.js";
import {
  SECRET_SETTINGS,
  decryptSecret,
  encryptSecret,
  encryptionReady,
  hashToken,
  hashesEqual,
  isEncrypted,
  isHashed,
  needsUpgrade,
} from "../../apps/api/src/db/secrets.js";

/**
 * The crypto that keeps a stolen database from being a stolen NAS.
 *
 * The interesting cases here are all failure ones: a value that was tampered
 * with, truncated, or sealed under a different key must come back as `null`
 * rather than as plausible-looking rubbish, because a caller that trusts a
 * silently-wrong TOTP secret is worse than one that reports the setting broken.
 */

test("a sealed value round-trips", () => {
  for (const plain of ["hunter2", "", "ünïcödé ✓", "x".repeat(4096), "\0\n\t"]) {
    const sealed = encryptSecret(plain);
    assert.equal(decryptSecret(sealed), plain, `failed for ${JSON.stringify(plain.slice(0, 20))}`);
  }
});

test("the ciphertext does not contain the plaintext", () => {
  const sealed = encryptSecret("correct-horse-battery-staple");
  assert.ok(!sealed.includes("correct"));
  assert.ok(sealed.startsWith("enc2:"));
  assert.ok(isEncrypted(sealed));
});

test("sealing the same value twice gives different ciphertext", () => {
  // A fresh IV every time. Without this, two accounts with the same TOTP secret
  // would be visibly identical in the database.
  const a = encryptSecret("same");
  const b = encryptSecret("same");
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test("an empty string stays empty rather than becoming ciphertext", () => {
  // "no SMTP password set" must not turn into "a password that decrypts to
  // nothing" - the settings UI distinguishes the two.
  assert.equal(encryptSecret(""), "");
  assert.equal(decryptSecret(""), "");
});

test("a tampered ciphertext fails closed", () => {
  const sealed = encryptSecret("hunter2");
  const [, salt, iv, tag, ct] = sealed.split(":");
  // Flip a bit in the ciphertext body.
  const flipped = Buffer.from(ct!, "base64url");
  flipped[0] = (flipped[0] ?? 0) ^ 0x01;
  assert.equal(decryptSecret(`enc2:${salt}:${iv}:${tag}:${flipped.toString("base64url")}`), null);
});

test("a tampered auth tag fails closed", () => {
  const sealed = encryptSecret("hunter2");
  const [, salt, iv, tag, ct] = sealed.split(":");
  const flipped = Buffer.from(tag!, "base64url");
  flipped[0] = (flipped[0] ?? 0) ^ 0x01;
  assert.equal(decryptSecret(`enc2:${salt}:${iv}:${flipped.toString("base64url")}:${ct}`), null);
});

test("a truncated or malformed sealed value fails closed", () => {
  const sealed = encryptSecret("hunter2");
  const parts = sealed.split(":");
  assert.equal(decryptSecret("enc2:"), null);
  assert.equal(decryptSecret("enc2:::::"), null);
  assert.equal(decryptSecret(`enc2:${parts[1]}`), null);
  assert.equal(decryptSecret(`enc2:${parts[1]}:${parts[2]}`), null);
  assert.equal(decryptSecret(`enc2:${parts[1]}:${parts[2]}:${parts[3]}`), null);
  assert.equal(decryptSecret(sealed.slice(0, sealed.length - 4)), null);
  // A swapped IV is a wrong key as far as GCM is concerned.
  assert.equal(
    decryptSecret(`enc2:${parts[1]}:${encryptSecret("other").split(":")[2]}:${parts[3]}:${parts[4]}`),
    null,
  );
});

test("an unmarked value is returned unchanged", () => {
  // Rows written before encryption existed. Refusing to read them would lock
  // people out of their own accounts on upgrade.
  assert.equal(decryptSecret("legacy-plaintext"), "legacy-plaintext");
  assert.equal(isEncrypted("legacy-plaintext"), false);
});

test("the key file is 0600 and 32 bytes", () => {
  encryptSecret("force the key into existence");
  assert.ok(encryptionReady());
  const path = join(dataDir, "secret.key");
  assert.equal(readFileSync(path).length, 32);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("hashToken is marked, stable, and one-way", () => {
  const h = hashToken("a-session-id");
  assert.ok(h.startsWith("h1:"));
  assert.ok(isHashed(h));
  assert.equal(h, hashToken("a-session-id"));
  assert.notEqual(h, hashToken("a-session-ie"));
  assert.ok(!h.includes("a-session-id"));
  assert.equal(isHashed("a-session-id"), false);
});

test("hashesEqual compares without throwing on different lengths", () => {
  // timingSafeEqual throws on a length mismatch, which would turn a comparison
  // against a malformed stored value into a 500. The length check in front of it
  // is the thing being tested here.
  const a = hashToken("one");
  const b = hashToken("two");
  assert.ok(hashesEqual(a, a));
  assert.ok(!hashesEqual(a, b));
  assert.ok(!hashesEqual(a, "short"));
  assert.ok(!hashesEqual(a, ""));
  // Two empty strings *are* equal. Harmless, because hashToken never returns
  // one - it always emits the "h1:" prefix - so no caller can present an empty
  // token and match an empty stored value. Asserted so that stays true.
  assert.ok(hashesEqual("", ""));
  assert.ok(hashToken("").length > 3);
});

test("SECRET_SETTINGS names the settings that hold credentials", () => {
  // The list is a deny-list, so the failure mode is a *new* secret setting being
  // exported in a config backup. This asserts the known ones stay in it; the
  // real defence is remembering to add to it on the same commit.
  assert.ok(SECRET_SETTINGS.has("smtp"));
  assert.ok(SECRET_SETTINGS.has("ddns"));
  assert.ok(!SECRET_SETTINGS.has("update_channel"));
});

// ---- The per-value salt (enc2) ---------------------------------------------
//
// AES-GCM's 96-bit nonce is safe for a bounded number of messages under one key
// and catastrophic if one ever repeats: the repeat leaks GHASH's `H`, and from
// there an attacker forges anything under that key forever. OpenNAS is nowhere
// near the limit — a few hundred values against a ceiling of 2^32 — but the key
// never rotates and the count only grows, so the format derives a fresh key per
// value from a random 256-bit salt instead of relying on staying small.

test("every sealed value carries its own salt", () => {
  const a = encryptSecret("hunter2");
  const b = encryptSecret("hunter2");
  assert.ok(a.startsWith("enc2:"), `expected the current format, got ${a.slice(0, 8)}`);
  const saltA = a.split(":")[1]!;
  const saltB = b.split(":")[1]!;
  assert.notEqual(saltA, saltB, "two values reused a salt");
  // 32 bytes, base64url — 43 characters, unpadded.
  assert.equal(Buffer.from(saltA, "base64url").length, 32);
});

test("a repeated nonce is survivable because the key differs with it", () => {
  // The forbidden attack needs the same (key, nonce). Reconstructing one value's
  // nonce under another value's salt must not produce a readable plaintext —
  // that is the whole point of deriving per value.
  const a = encryptSecret("first secret");
  const b = encryptSecret("second secret");
  const [, saltA, ivA, tagA, ctA] = a.split(":");
  const [, saltB] = b.split(":");
  assert.notEqual(saltA, saltB);
  // A's ciphertext and nonce, B's salt: the derived key is different, so this
  // must fail closed rather than decrypt to anything.
  assert.equal(decryptSecret(`enc2:${saltB}:${ivA}:${tagA}:${ctA}`), null);
});

test("a tampered salt fails closed", () => {
  const sealed = encryptSecret("hunter2");
  const parts = sealed.split(":");
  const salt = Buffer.from(parts[1]!, "base64url");
  salt[0] = (salt[0] ?? 0) ^ 0x01;
  parts[1] = salt.toString("base64url");
  assert.equal(decryptSecret(parts.join(":")), null);
});

test("values written before the salt existed are still readable", () => {
  // An upgrade must never lock somebody out of their own authenticator, so the
  // old format is read forever. This builds a genuine enc1 value the way the
  // previous implementation did — one key, no salt.
  const plain = "an old TOTP secret";
  const masterKey = readFileSync(join(dataDir, "secret.key"));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const legacy = `enc1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;

  assert.equal(decryptSecret(legacy), plain, "an existing install became unreadable");
  assert.ok(isEncrypted(legacy), "an old value must still count as sealed");
  assert.ok(needsUpgrade(legacy), "an old value should be flagged for upgrade");
  assert.ok(!needsUpgrade(encryptSecret(plain)), "a new value must not be flagged");
});

test("a damaged old-format value fails closed rather than throwing", () => {
  for (const bad of ["enc1:", "enc1:a:b", "enc1:a:b:c", "enc1::::"]) {
    assert.equal(decryptSecret(bad), null, `accepted ${bad}`);
  }
});
