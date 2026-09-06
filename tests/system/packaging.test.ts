import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shell that runs as root.
 *
 * None of this is exercised by building or typechecking, and all of it runs on
 * an appliance nobody can log into to fix. A syntax error in a helper is a NAS
 * that boots into a broken state, so the cheapest possible check - does `sh`
 * agree this is a script - is worth having in CI.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packaging = join(repoRoot, "packaging");

function shellScripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const head = readFileSync(path).subarray(0, 64).toString("utf8");
      if (/^#!.*\b(sh|bash|ash)\b/.test(head)) out.push(path);
    }
  };
  walk(packaging);
  walk(join(repoRoot, "distro"));
  return out;
}

test("every shell script parses", () => {
  const scripts = shellScripts();
  assert.ok(scripts.length > 10, `only found ${scripts.length} scripts - is the walk working?`);
  for (const path of scripts) {
    const head = readFileSync(path).subarray(0, 64).toString("utf8");
    // Check each with the shell it declares: /bin/sh scripts must be POSIX, and
    // checking a POSIX script with bash would let a bashism through.
    const shell = /^#!.*\bbash\b/.test(head) ? "bash" : "sh";
    try {
      execFileSync(shell, ["-n", path], { stdio: "pipe" });
    } catch (err) {
      const e = err as { stderr?: Buffer };
      assert.fail(`${path.replace(repoRoot, "")} does not parse:\n${e.stderr?.toString() ?? ""}`);
    }
  }
});

test("every shell script is executable", () => {
  for (const path of shellScripts()) {
    assert.ok(statSync(path).mode & 0o111, `${path.replace(repoRoot, "")} is not executable`);
  }
});

test("the helpers the release ships are the helpers doas permits", () => {
  // These three lists have to agree or an update installs a helper that doas
  // refuses to run, which fails at the moment it is needed and not before.
  const release = readFileSync(join(packaging, "make-release.sh"), "utf8");
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  const policy = installer.split("doas.d/opennas.conf")[1] ?? "";

  const permitted = [...policy.matchAll(/cmd \/usr\/lib\/opennas\/([\w-]+)/g)].map((m) => m[1]!);
  assert.ok(permitted.length >= 5, `only ${permitted.length} helpers in the doas policy`);
  for (const helper of permitted) {
    assert.ok(
      release.includes(`packaging/${helper}"`),
      `${helper} is permitted by doas but not shipped in an update bundle`,
    );
  }
});

test("the updater and the release script agree on the payload layout", () => {
  // The updater refuses a bundle without server/index.js and VERSION; the build
  // is what puts them there. If either moves, updates stop working and the only
  // symptom is a refusal message about the bundle not being OpenNAS.
  const updater = readFileSync(join(packaging, "opennas-update"), "utf8");
  const build = readFileSync(join(packaging, "build-dist.sh"), "utf8");
  assert.match(updater, /\$NEW\/server\/index\.js/);
  assert.match(updater, /\$NEW\/VERSION/);
  assert.match(build, /\$OUT\/server/);
  assert.match(build, /"\$OUT\/VERSION"/);
  // Service files travel under service/ in the payload and are installed from
  // there by the updater.
  const release = readFileSync(join(packaging, "make-release.sh"), "utf8");
  assert.match(release, /\$STAGE\/opennas\/service/);
  assert.match(updater, /\$PREFIX\/service\//);
});

test("the release bundle is packed reproducibly", () => {
  // Without this the published sha256 changes on every rebuild of the same
  // commit, and a checksum that always differs is a checksum nobody checks.
  const release = readFileSync(join(packaging, "make-release.sh"), "utf8");
  for (const flag of ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime="]) {
    assert.ok(release.includes(flag), `make-release.sh is missing ${flag}`);
  }
});

test("the release script verifies its own signature before publishing", () => {
  // Signing with the wrong key produces a bundle every installed machine
  // refuses. Catching that on the build machine costs one openssl call.
  const release = readFileSync(join(packaging, "make-release.sh"), "utf8");
  assert.match(release, /openssl pkeyutl -sign/);
  assert.match(release, /openssl pkeyutl -verify/);
});

test("the build ships the licence with the binaries", () => {
  // GPLv3 §6: the terms travel with the object code.
  const build = readFileSync(join(packaging, "build-dist.sh"), "utf8");
  assert.match(build, /LICENSE/);
});

test("no packaging script pipes a download straight into a shell", () => {
  for (const path of shellScripts()) {
    // Comment lines are dropped first - a comment explaining *why* a script
    // doesn't do this should not read as doing it.
    const body = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.ok(
      !/(curl|wget)[^\n|]*\|\s*(sudo\s+)?(sh|bash)\b/.test(body),
      `${path.replace(repoRoot, "")} pipes a download into a shell`,
    );
  }
});
