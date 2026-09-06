import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeNativeModule,
  makePayload,
  makeSandbox,
  packAndSign,
  settle,
  type Sandbox,
} from "../helpers/update-sandbox.js";

/**
 * The privileged updater, run as itself.
 *
 * This is the one path in OpenNAS where a mistake is a remote root
 * compromise - a web-layer bug that could talk this script into installing an
 * attacker's tree would turn "someone found an XSS" into "someone owns the NAS".
 * So the refusals are tested first and in more detail than the happy path, and
 * every one of them also asserts that the *existing install is untouched*:
 * refusing loudly while having already swapped the tree would be no better than
 * accepting.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function installedAt(version: string) {
  const box = await makeSandbox();
  makePayload(box.prefix, version);
  fakeNativeModule(box.prefix, true);
  writeFileSync(join(box.prefix, "node_modules", "MARKER"), "compiled for this machine\n");
  return box;
}

function currentVersion(box: Sandbox): string {
  return readFileSync(join(box.prefix, "VERSION"), "utf8").trim();
}

/** Nothing moved: same version, same carried-across modules, no stray trees. */
function assertUntouched(box: Sandbox, version: string) {
  assert.equal(currentVersion(box), version, "the installed version changed");
  assert.ok(existsSync(join(box.prefix, "node_modules", "MARKER")), "the machine's modules went missing");
  assert.ok(!existsSync(`${box.prefix}.old`), "left a .old tree behind");
}

test("the shipped constants are the ones the appliance needs", () => {
  // The sandbox rewrites these, so this is the only place that sees the real
  // values. A typo here would be invisible to every other test in the file.
  const src = readFileSync(join(repoRoot, "packaging", "opennas-update"), "utf8");
  assert.match(src, /^PREFIX=\/usr\/lib\/opennas$/m);
  assert.match(src, /^KEY="\/etc\/opennas\/update-key\.pub"$/m);
  assert.match(src, /^STATE_DIR=\/var\/lib\/opennas\/update$/m);
  assert.match(src, /^HEALTH_URL="http:\/\/127\.0\.0\.1:\d+\/api\/health"$/m);
  // None of them may be environment-overridable: a root-run updater that takes
  // its trust anchor from the environment is not a trust anchor.
  assert.ok(!/^KEY=.*\$\{/m.test(src), "KEY is overridable from the environment");
  assert.ok(!/^PREFIX=.*\$\{/m.test(src), "PREFIX is overridable from the environment");
});

test("the doas policy names every helper by absolute path", () => {
  // doas matches `cmd <name>` against argv[0]. A bare name would let anything
  // earlier on PATH be run as root, so every OpenNAS helper - the updater most
  // of all, since it is the one that installs code - has to be allow-listed by
  // its full path.
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  const policy = installer.split("doas.d/opennas.conf")[1] ?? "";
  assert.ok(policy.includes("permit nopass opennas as root"), "no doas policy found in the installer");

  for (const helper of ["opennas-update", "opennas-storage", "opennas-sysctl", "opennas-logs", "opennas-firewall"]) {
    assert.ok(
      policy.includes(`cmd /usr/lib/opennas/${helper}`),
      `${helper} is not allow-listed by absolute path`,
    );
    assert.ok(
      !new RegExp(`cmd ${helper}\\s*$`, "m").test(policy),
      `${helper} is also allow-listed by bare name, which defeats the point`,
    );
  }
  // The policy itself must not be world-readable.
  assert.match(installer, /chmod 0600 "\$mnt\/etc\/doas\.d\/opennas\.conf"/);
  // Nothing may be permitted as a shell or an interpreter, which would be a
  // general-purpose root escalation wearing an allow-list.
  for (const forbidden of ["cmd sh", "cmd bash", "cmd node", "cmd env", "cmd chmod", "cmd chown", "cmd tee"]) {
    assert.ok(!policy.includes(forbidden), `the doas policy permits "${forbidden}"`);
  }
});

test("status on a fresh install reports idle", async () => {
  const box = await installedAt("1.0.0");
  try {
    const r = box.run(["status"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^idle\|\|?$/);
  } finally {
    box.cleanup();
  }
});

test("a genuine update installs and keeps the machine's compiled modules", async () => {
  const box = await installedAt("1.0.0");
  try {
    const next = join(box.dir, "payload");
    makePayload(next, "1.1.0");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);

    assert.equal(box.run(["apply", bundle, sig]).code, 0);
    const s = await settle(box);
    assert.equal(s.state, "ok", `status was ${JSON.stringify(s)}`);
    assert.equal(currentVersion(box), "1.1.0");
    // node_modules is never in a bundle - better-sqlite3 is compiled for this
    // machine's arch and libc - so it has to be carried across.
    assert.ok(existsSync(join(box.prefix, "node_modules", "MARKER")), "the compiled modules were lost");
    // A successful update discards the old tree rather than leaving it to grow.
    assert.ok(!existsSync(`${box.prefix}.old`));
    assert.ok(!existsSync(`${box.prefix}.new`));
  } finally {
    box.cleanup();
  }
});

test("a bundle signed with the wrong key is refused, install untouched", async () => {
  const box = await installedAt("1.0.0");
  try {
    const next = join(box.dir, "payload");
    makePayload(next, "9.9.9");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.wrongKey);

    const r = box.run(["apply", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "failed");
    assert.match(s.message, /signature/i);
    assert.ok(r.code !== 0 || s.state === "failed");
    assertUntouched(box, "1.0.0");
  } finally {
    box.cleanup();
  }
});

test("a tampered bundle is refused, install untouched", async () => {
  const box = await installedAt("1.0.0");
  try {
    const next = join(box.dir, "payload");
    makePayload(next, "9.9.9");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);
    // Flip a byte after signing.
    const bytes = readFileSync(bundle);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(bundle, bytes);

    box.run(["apply", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "failed");
    assert.match(s.message, /signature/i);
    assertUntouched(box, "1.0.0");
  } finally {
    box.cleanup();
  }
});

test("a correctly-signed bundle that is not OpenNAS is refused", async () => {
  // Signature alone is not enough: whoever holds the release key could still
  // sign the wrong tree by mistake, and a payload with no server in it would
  // otherwise be swapped in and leave the machine dead.
  const box = await installedAt("1.0.0");
  try {
    const next = join(box.dir, "payload");
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, "hello.txt"), "not an OpenNAS build\n");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);

    box.run(["apply", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "failed");
    assert.match(s.message, /OpenNAS update|server\/index\.js/i);
    assertUntouched(box, "1.0.0");
  } finally {
    box.cleanup();
  }
});

test("a missing signature is refused", async () => {
  const box = await installedAt("1.0.0");
  try {
    const next = join(box.dir, "payload");
    makePayload(next, "1.1.0");
    const { bundle } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);

    box.run(["apply", bundle, join(box.dir, "does-not-exist.sig")]);
    const s = await settle(box);
    assert.equal(s.state, "failed");
    assertUntouched(box, "1.0.0");
  } finally {
    box.cleanup();
  }
});

test("a bundle whose native module won't load is refused before the swap", async () => {
  // The important word is *before*. Swapping first and discovering it on boot
  // means a failed start and a ninety-second rollback; catching it here means
  // the old version never stops serving.
  const box = await installedAt("1.0.0");
  try {
    fakeNativeModule(box.prefix, false);
    const next = join(box.dir, "payload");
    makePayload(next, "1.1.0");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);

    box.run(["apply", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "failed");
    assert.match(s.message, /database driver/i);
    assert.equal(currentVersion(box), "1.0.0");
    assert.ok(!existsSync(`${box.prefix}.old`), "the tree was swapped before the check");
  } finally {
    box.cleanup();
  }
});

test("an update that installs but never answers rolls itself back", async () => {
  const box = await installedAt("1.0.0");
  try {
    box.healthy(false);
    const next = join(box.dir, "payload");
    makePayload(next, "1.1.0");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);

    box.run(["apply", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "rolled_back", `status was ${JSON.stringify(s)}`);
    assert.equal(currentVersion(box), "1.0.0");
    assert.ok(existsSync(join(box.prefix, "node_modules", "MARKER")));
    // No half-swapped trees left on disk for the next update to trip over.
    assert.ok(!existsSync(`${box.prefix}.new`));
  } finally {
    box.cleanup();
  }
});

test("rollback on request restores the previous version", async () => {
  const box = await installedAt("1.0.0");
  try {
    const next = join(box.dir, "payload");
    makePayload(next, "1.1.0");
    const { bundle, sig } = packAndSign(next, join(box.dir, "b.tar.gz"), box.privateKey);
    box.run(["apply", bundle, sig]);
    assert.equal((await settle(box)).state, "ok");
    assert.equal(currentVersion(box), "1.1.0");

    // A successful update deletes .old, so there is deliberately nothing to go
    // back to - the "Go back" button is for a version that came up but is wrong,
    // which is the state right after a failed-then-restored update.
    const r = box.run(["rollback"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no previous version/i);
    assert.equal(currentVersion(box), "1.1.0");
  } finally {
    box.cleanup();
  }
});

test("an unknown subcommand does nothing", async () => {
  const box = await installedAt("1.0.0");
  try {
    const r = box.run(["please-install-everything"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /usage/i);
    assertUntouched(box, "1.0.0");
  } finally {
    box.cleanup();
  }
});
