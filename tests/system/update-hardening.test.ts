import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, statSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
 * The updater's defences against its own caller, run as the real script.
 *
 * update.test.ts covers bundles that are not genuine. This covers what a
 * compromised backend could do with genuine ones, or with the files around
 * them: hand it an old signed release, swap the bundle after asking for it to be
 * installed, or point the status file at something root should not write.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The SERVICE_FILES destinations, under the sandbox's SYSROOT. */
const SERVICE_DESTS = [
  "/etc/doas.d/opennas.conf",
  "/etc/conf.d/opennas",
  "/etc/init.d/opennas",
  "/etc/init.d/opennas-tls",
  "/etc/init.d/opennas-firewall",
  "/etc/init.d/opennas-banner",
  "/etc/nginx/http.d/opennas.conf",
  "/etc/avahi/services/opennas.service",
  "/usr/sbin/opennas",
];

async function installedAt(version: string): Promise<Sandbox & { sysroot: string }> {
  const box = await makeSandbox();
  makePayload(box.prefix, version);
  fakeNativeModule(box.prefix, true);
  // Point the service-file installs at a sandbox root too.
  const sysroot = join(box.dir, "root");
  // The directories exist on a real machine; install(1) does not create them.
  for (const dst of SERVICE_DESTS) mkdirSync(join(sysroot, dst, ".."), { recursive: true });
  // `doas -C` stands in for doas's own syntax check: a policy containing the
  // word BROKEN is one doas would refuse.
  writeFileSync(join(box.dir, "bin", "doas"), '#!/bin/sh\n[ "$1" = -C ] || exit 1\n! grep -q BROKEN "$2"\n');
  chmodSync(join(box.dir, "bin", "doas"), 0o755);
  const src = readFileSync(box.script, "utf8");
  writeFileSync(box.script, src.replace(/^SYSROOT=$/m, `SYSROOT=${sysroot}`));
  return Object.assign(box, { sysroot });
}

function version(box: Sandbox): string {
  return readFileSync(join(box.prefix, "VERSION"), "utf8").trim();
}

/** A signed payload carrying a full set of service files tagged with `tag`. */
function release(
  box: Sandbox,
  v: string,
  tag = v,
  policy = `permit nopass opennas as root cmd /usr/lib/opennas/opennas-update # ${tag}\n`,
  more: Record<string, string> = {},
) {
  const dir = join(box.dir, `payload-${v}-${Math.random().toString(36).slice(2)}`);
  const extra: Record<string, string> = { "opennas-cli": `cli ${tag}\n`, "service/doas-opennas.conf": policy, ...more };
  for (const f of ["opennas.openrc", "opennas-tls.openrc", "opennas-firewall.openrc", "opennas-banner.openrc", "nginx-opennas.conf", "opennas-avahi.service"]) {
    extra[`service/${f}`] = `${f} ${tag}\n`;
  }
  makePayload(dir, v, extra);
  return packAndSign(dir, join(box.dir, `b-${v}-${Math.random().toString(36).slice(2)}.tar.gz`), box.privateKey);
}

test("the shipped updater installs service files at the real root", () => {
  const src = readFileSync(join(repoRoot, "packaging", "opennas-update"), "utf8");
  assert.match(src, /^SYSROOT=$/m, "SYSROOT must be empty in the shipped script");
});

for (const [what, v] of [["an older", "0.9.0"], ["the same", "1.0.0"], ["a pre-release of the same", "1.0.0-rc.1"]] as const) {
  test(`${what} version is refused, even when correctly signed`, async () => {
    const box = await installedAt("1.0.0");
    try {
      const { bundle, sig } = release(box, v);
      box.run(["apply", bundle, sig]);
      const s = await settle(box);
      assert.equal(s.state, "failed", JSON.stringify(s));
      assert.match(s.message, /not newer/);
      assert.equal(version(box), "1.0.0");
      assert.ok(!existsSync(`${box.prefix}.old`));
    } finally {
      box.cleanup();
    }
  });
}

test("a downgrade needs the explicit flag, which the backend never passes", async () => {
  const box = await installedAt("1.0.0");
  try {
    const { bundle, sig } = release(box, "0.9.0");
    box.run(["apply", "--allow-downgrade", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "ok", JSON.stringify(s));
    assert.equal(version(box), "0.9.0");
  } finally {
    box.cleanup();
  }
  const updater = readFileSync(join(repoRoot, "apps", "api", "src", "system", "updater.ts"), "utf8");
  assert.ok(!updater.includes("allow-downgrade"), "the backend passes --allow-downgrade");
});

test("swapping the bundle after handing it over changes nothing", async () => {
  // The verify-then-unpack window: the backend owns the staged bundle, so it
  // could replace it between the signature check and tar. The helper works on
  // a private copy taken before either.
  const box = await installedAt("1.0.0");
  try {
    const { bundle, sig } = release(box, "1.1.0", "genuine");
    assert.equal(box.run(["apply", bundle, sig]).code, 0);
    writeFileSync(bundle, "not the bundle that was verified");
    const s = await settle(box);
    assert.equal(s.state, "ok", JSON.stringify(s));
    assert.equal(version(box), "1.1.0");
    assert.equal(readFileSync(join(box.sysroot, "usr/sbin/opennas"), "utf8"), "cli genuine\n");
    // And the private copy is cleaned up.
    assert.ok(!readdirSync(box.dir).some((f) => f.startsWith("opennas.stage.")), "the private staging copy was left behind");
    assert.ok(!existsSync(`${box.prefix}.new`));
  } finally {
    box.cleanup();
  }
});

test("a symlinked status file is replaced, not written through", async () => {
  const box = await installedAt("1.0.0");
  try {
    const victim = join(box.dir, "victim");
    writeFileSync(victim, "precious\n");
    rmSync(box.statusFile, { force: true });
    symlinkSync(victim, box.statusFile);
    symlinkSync(victim, join(box.dir, "state", "update.log"));

    // Fails early (no such bundle), which writes a status with the caller's text in it.
    box.run(["apply", "/nonexistent\nroot:x:0:0::/:/bin/sh", "/nonexistent.sig"]);
    assert.equal(readFileSync(victim, "utf8"), "precious\n", "root wrote through the symlink");
    assert.ok(!lstatSync(box.statusFile).isSymbolicLink());
    const status = readFileSync(box.statusFile, "utf8");
    assert.equal(status.split("\n").filter(Boolean).length, 1, "a newline from the caller reached the status file");

    // `status` must not read through one either - its output goes to the caller.
    rmSync(box.statusFile);
    symlinkSync(victim, box.statusFile);
    assert.doesNotMatch(box.run(["status"]).stdout, /precious/);
  } finally {
    box.cleanup();
  }
});

test("a state directory replaced by a symlink is not followed", async () => {
  const box = await installedAt("1.0.0");
  try {
    const elsewhere = join(box.dir, "elsewhere");
    mkdirSync(elsewhere);
    const state = join(box.dir, "state");
    rmSync(state, { recursive: true, force: true });
    symlinkSync(elsewhere, state);

    box.run(["apply", "/nonexistent", "/nonexistent.sig"]);
    assert.ok(!existsSync(join(elsewhere, "status")), "the status was written into the symlink's target");
    assert.ok(!lstatSync(state).isSymbolicLink());
    assert.equal(box.status().state, "failed");
  } finally {
    box.cleanup();
  }
});

test("a rollback puts back the service files the update replaced", async () => {
  const box = await installedAt("1.0.0");
  try {
    // What the 1.0.0 machine has on disk outside the payload. One of them
    // missing, so "restore" has to mean "remove" for it.
    for (const dst of SERVICE_DESTS.slice(0, -1)) {
      mkdirSync(join(box.sysroot, dst, ".."), { recursive: true });
      writeFileSync(join(box.sysroot, dst), `${dst} old\n`);
    }
    box.healthy(false);
    const { bundle, sig } = release(box, "1.1.0", "new");
    box.run(["apply", bundle, sig]);
    const s = await settle(box);
    assert.equal(s.state, "rolled_back", JSON.stringify(s));
    assert.equal(version(box), "1.0.0");
    for (const dst of SERVICE_DESTS.slice(0, -1)) {
      assert.equal(readFileSync(join(box.sysroot, dst), "utf8"), `${dst} old\n`, `${dst} was not restored`);
    }
    assert.ok(!existsSync(join(box.sysroot, "usr/sbin/opennas")), "a file the update added survived the rollback");
    assert.ok(!existsSync(join(box.prefix, ".service-backup")), "the backup was left in the tree");
  } finally {
    box.cleanup();
  }
});

const OLD_CONFD = `export OPENNAS_SYSTEM_MODE=linux
export OPENNAS_SMB_CONF=/etc/samba/smb.conf
export OPENNAS_NFS_EXPORTS=/etc/exports
`;

/** A machine as an older installer left it: permissive policy, opennas-writable configs. */
function legacyMachine(box: Sandbox & { sysroot: string }) {
  writeFileSync(join(box.sysroot, "etc/doas.d/opennas.conf"), "permit nopass opennas as root cmd adduser\n");
  writeFileSync(join(box.sysroot, "etc/conf.d/opennas"), OLD_CONFD);
  mkdirSync(join(box.sysroot, "etc/samba"), { recursive: true });
  for (const f of ["etc/samba/smb.conf", "etc/exports"]) {
    writeFileSync(join(box.sysroot, f), "# old\n");
    chmodSync(join(box.sysroot, f), 0o666);
  }
}

test("an update migrates an old install: policy, config ownership, conf.d - idempotently", async () => {
  const box = await installedAt("1.0.0");
  try {
    legacyMachine(box);
    const { bundle, sig } = release(box, "1.1.0", "new");
    box.run(["apply", bundle, sig]);
    assert.equal((await settle(box)).state, "ok");
    const policy = readFileSync(join(box.sysroot, "etc/doas.d/opennas.conf"), "utf8");
    assert.match(policy, /# new/);
    assert.doesNotMatch(policy, /adduser/);
    assert.equal(statSync(join(box.sysroot, "etc/doas.d/opennas.conf")).mode & 0o777, 0o600);
    for (const f of ["etc/samba/smb.conf", "etc/exports"]) {
      assert.equal(statSync(join(box.sysroot, f)).mode & 0o777, 0o644, `${f} is still writable by others`);
    }
    const confd = readFileSync(join(box.sysroot, "etc/conf.d/opennas"), "utf8");
    assert.match(confd, /^export OPENNAS_SMB_CONF=\/var\/lib\/opennas\/generated\/smb\.conf$/m);
    assert.match(confd, /^export OPENNAS_NFS_EXPORTS=\/var\/lib\/opennas\/generated\/exports$/m);

    // Again, on the already-migrated machine: nothing changes.
    const again = release(box, "1.2.0", "new");
    box.run(["apply", again.bundle, again.sig]);
    assert.equal((await settle(box)).state, "ok");
    assert.equal(readFileSync(join(box.sysroot, "etc/conf.d/opennas"), "utf8"), confd);
  } finally {
    box.cleanup();
  }
});

test("an update has the new share helper lock down the share roots, on every update", async () => {
  // The work itself (and its idempotency) is tested against the real helper in
  // sysctl-helper.test.ts; here, that the migration runs it from the newly
  // installed tree - which is the one that knows how.
  const box = await installedAt("1.0.0");
  try {
    const log = join(box.dir, "sysctl.log");
    const stub = { "opennas-sysctl": `#!/bin/sh\necho "$*" >> "${log}"\n` };
    const first = release(box, "1.1.0", "new", undefined, stub);
    box.run(["apply", first.bundle, first.sig]);
    assert.equal((await settle(box)).state, "ok");
    assert.equal(readFileSync(log, "utf8"), "share-roots\n");
    const again = release(box, "1.2.0", "new", undefined, stub);
    box.run(["apply", again.bundle, again.sig]);
    assert.equal((await settle(box)).state, "ok");
    assert.equal(readFileSync(log, "utf8"), "share-roots\nshare-roots\n");
  } finally {
    box.cleanup();
  }
});

test("a doas policy that doas rejects is not installed; the old one stays", async () => {
  const box = await installedAt("1.0.0");
  try {
    legacyMachine(box);
    const { bundle, sig } = release(box, "1.1.0", "new", "permit BROKEN\n");
    box.run(["apply", bundle, sig]);
    assert.equal((await settle(box)).state, "ok");
    assert.equal(readFileSync(join(box.sysroot, "etc/doas.d/opennas.conf"), "utf8"), "permit nopass opennas as root cmd adduser\n");
    assert.ok(!readdirSync(join(box.sysroot, "etc/doas.d")).some((f) => f.startsWith(".")), "a temporary policy was left behind");
  } finally {
    box.cleanup();
  }
});

test("a rollback restores the previous doas policy and conf.d", async () => {
  const box = await installedAt("1.0.0");
  try {
    legacyMachine(box);
    box.healthy(false);
    const { bundle, sig } = release(box, "1.1.0", "new");
    box.run(["apply", bundle, sig]);
    assert.equal((await settle(box)).state, "rolled_back");
    assert.equal(readFileSync(join(box.sysroot, "etc/doas.d/opennas.conf"), "utf8"), "permit nopass opennas as root cmd adduser\n");
    assert.equal(readFileSync(join(box.sysroot, "etc/conf.d/opennas"), "utf8"), OLD_CONFD);
  } finally {
    box.cleanup();
  }
});
