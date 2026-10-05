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
  const policy = readFileSync(join(repoRoot, "packaging", "doas-opennas.conf"), "utf8");

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
  // The updater lists them (and backs them up for a rollback) by their path
  // inside the payload, so every service file the release ships must appear.
  assert.match(updater, /\$PREFIX\/\$_src/);
  for (const f of ["opennas.openrc", "opennas-tls.openrc", "opennas-firewall.openrc", "opennas-banner.openrc", "nginx-opennas.conf", "opennas-avahi.service"]) {
    assert.ok(release.includes(f), `make-release.sh does not ship ${f}`);
    assert.ok(updater.includes(`service/${f}|`), `the updater does not install service/${f}`);
  }
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

test("the doas policy grants no raw system tool with open-ended arguments", () => {
  // adduser, smbpasswd, rc-service, smartctl and the rest used to be listed
  // with any arguments - enough to set root's Samba password, strip wheel or
  // stop sshd. Everything privileged goes through a helper now; the only bare
  // commands left take no arguments at all.
  const policy = readFileSync(join(repoRoot, "packaging", "doas-opennas.conf"), "utf8");
  const rules = policy.split("\n").filter((l) => l.startsWith("permit"));
  assert.ok(rules.length >= 6, "could not find the doas rules");
  for (const rule of rules) {
    const m = rule.match(/^permit nopass opennas as root cmd (\S+)(.*)$/);
    assert.ok(m, `unexpected rule shape: ${rule}`);
    const [, cmd, rest] = m;
    if (cmd!.startsWith("/usr/lib/opennas/opennas-")) continue;
    assert.ok(["reboot", "poweroff"].includes(cmd!), `raw tool allowed: ${rule}`);
    assert.equal(rest!.trim(), "args", `${cmd} is allowed with arguments`);
  }
  // The firewall helper - which the backend also uses for ban/unban/bans - is there.
  assert.ok(rules.some((r) => r.endsWith("cmd /usr/lib/opennas/opennas-firewall")));
});

test("the share daemon configs stay root-owned on the appliance", () => {
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  assert.doesNotMatch(installer, /chown opennas:opennas \/etc\/samba\/smb\.conf/);
  assert.doesNotMatch(installer, /chown [^\n]*opennas[^\n]*\/etc\/exports/);
  assert.match(installer, /OPENNAS_SMB_CONF=\/var\/lib\/opennas\/generated\/smb\.conf/);
  assert.match(installer, /OPENNAS_NFS_EXPORTS=\/var\/lib\/opennas\/generated\/exports/);
});

test("the installer never evals a menu built from hardware strings", () => {
  // A disk's model string is whatever the device reports; under eval it ran as root.
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  const code = installer
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /\beval\b/);
});

test("discovery answers over plain HTTP; nothing else on port 80 does", () => {
  const conf = readFileSync(join(packaging, "nginx-opennas.conf"), "utf8");
  const http = conf.slice(conf.indexOf("listen 80"), conf.indexOf("listen 443"));
  assert.match(http, /location = \/api\/discover \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:4174;/);
  assert.match(http, /location \/ \{\s*return 301 https:\/\/\$host\$request_uri;/);
  // Exact-match only: no prefix location that would open more of the API.
  assert.doesNotMatch(http, /location \/api\/ /);
});

test("the installer, the ISO and update bundles all carry the one doas policy file", () => {
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  const stage = readFileSync(join(repoRoot, "distro", "stage.sh"), "utf8");
  const release = readFileSync(join(packaging, "make-release.sh"), "utf8");
  const updater = readFileSync(join(packaging, "opennas-update"), "utf8");
  assert.match(installer, /install -m 0600 "\$mnt\/usr\/lib\/opennas\/service\/doas-opennas\.conf" "\$mnt\/etc\/doas\.d\/opennas\.conf"/);
  assert.doesNotMatch(installer, /permit nopass opennas/, "the installer has its own copy of the policy again");
  assert.match(stage, /packaging\/doas-opennas\.conf" "\$BUILD\/payload\/usr\/lib\/opennas\/service\/doas-opennas\.conf"/);
  assert.match(release, /packaging\/doas-opennas\.conf" +"\$STAGE\/opennas\/service\/doas-opennas\.conf"/);
  assert.ok(updater.includes("service/doas-opennas.conf|/etc/doas.d/opennas.conf|0600"));
  assert.match(updater, /doas -C/);
});
