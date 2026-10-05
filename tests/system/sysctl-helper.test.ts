import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServicesConfig, Share } from "../../packages/shared/src/index.js";

/**
 * `opennas-sysctl`, run as itself against a fake account database.
 *
 * Every system tool it drives (adduser, smbpasswd, rc-service, su, ...) is a
 * stub that writes down how it was called, and `getent`/`id` answer from
 * passwd/group files in the sandbox. Like the ZFS tests, the stubs are a
 * tripwire: the property under test is that the helper refuses root, wheel,
 * the service account and the rest *before* any of those tools runs - and a
 * recorded call list shows that more plainly than the real tools would.
 *
 * The share-config checks are run against the backend's real generator output,
 * so a change to services.ts that the helper would refuse fails here rather
 * than on a NAS whose shares quietly stop updating.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const HELPER = join(repoRoot, "packaging", "opennas-sysctl");

interface Box {
  dir: string;
  generated: string;
  shared: string;
  volumes: string;
  smbConf: string;
  exports: string;
  calls: () => string[];
  run: (args: string[], input?: string) => { code: number; stdout: string; stderr: string };
  cleanup: () => void;
}

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function sandbox(roots?: { shared: string; volumes: string }, opts: { untrusted?: boolean } = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), "opennas-sysctl-"));
  const bin = join(dir, "bin");
  const etc = join(dir, "etc");
  const generated = join(dir, "generated");
  const shared = roots?.shared ?? join(dir, "shared");
  const volumes = roots?.volumes ?? join(dir, "volumes");
  const log = join(dir, "calls.log");
  for (const d of [bin, etc, join(etc, "samba"), join(etc, "network"), generated, shared, volumes, join(dir, "home", "admin")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(log, "");

  writeFileSync(
    join(dir, "passwd"),
    [
      "root:x:0:0:root:/root:/bin/sh",
      "daemon:x:2:2:daemon:/sbin:/sbin/nologin",
      "nginx:x:100:101:nginx:/var/lib/nginx:/sbin/nologin",
      "opennas:x:101:102:Linux User,,,:/var/lib/opennas:/sbin/nologin",
      `admin:x:1000:1000:Linux User,,,:${join(dir, "home", "admin")}:/bin/sh`,
      "alice:x:110:65533:OpenNAS share user:/home/alice:/sbin/nologin",
      "bob:x:112:65533:OpenNAS share user:/home/bob:/sbin/nologin",
      "legacy:x:111:65533:Linux User,,,:/home/legacy:/sbin/nologin",
      "chrony:x:113:65533:Linux User,,,:/var/lib/chrony:/sbin/nologin",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "group"),
    [
      "root:x:0:root",
      "wheel:x:10:root,admin",
      "nginx:x:101:nginx",
      "opennas:x:102:",
      "admin:x:1000:",
      "nogroup:x:65533:",
      "editors:x:1001:alice",
      "mixed:x:1002:alice,admin",
      "legacygrp:x:300:legacy",
    ].join("\n") + "\n",
  );

  // getent/id answer from the files above.
  stub(
    bin,
    "getent",
    `db="${dir}/$1"; shift
if [ "$#" -eq 0 ]; then cat "$db"; exit 0; fi
awk -F: -v k="$1" '$1 == k { print; found = 1 } END { exit !found }' "$db"`,
  );
  stub(
    bin,
    "id",
    `[ "$1" = "-Gn" ] || exit 1
u="$2"
gid=$(awk -F: -v u="$u" '$1 == u { print $4 }' "${dir}/passwd")
[ -n "$gid" ] || exit 1
awk -F: -v u="$u" -v gid="$gid" '$3 == gid { printf "%s ", $1 } { n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] == u) printf "%s ", $1 }' "${dir}/group"
echo`,
  );
  // A new group really appears, so the helper's own re-check of it can pass.
  stub(bin, "addgroup", `echo "addgroup $*" >> "${log}"\n[ "$#" -eq 1 ] && echo "$1:x:1500:" >> "${dir}/group"; exit 0`);
  for (const name of ["adduser", "deluser", "delgroup", "rc-service", "rc-update", "smbcontrol", "exportfs", "hostname"]) {
    stub(bin, name, `echo "${name} $*" >> "${log}"`);
  }
  stub(bin, "smbpasswd", `case "$*" in *-s*) cat > /dev/null ;; esac\necho "smbpasswd $*" >> "${log}"`);
  stub(bin, "su", `cat > /dev/null\necho "su $*" | head -c 40 >> "${log}"; echo >> "${log}"`);

  const smbConf = join(etc, "samba", "smb.conf");
  const exportsPath = join(etc, "exports");
  // Point the shipped constants at the sandbox, in a copy. They are plain
  // assignments, deliberately not read from the environment: a root helper
  // must not take its paths from whoever invoked it.
  const script = join(dir, "opennas-sysctl");
  const src = readFileSync(HELPER, "utf8")
    .replace(/^DATA_DIR=.*$/m, `DATA_DIR=${dir}`)
    // The sandbox cannot chown to root, so the directories it makes (and /tmp's
    // owner) stand in for root's.
    // `untrusted` leaves them as what they are on a machine nobody migrated:
    // the service account's, which nothing above a share may be.
    .replace(/^TRUSTED_UIDS=.*$/m, opts.untrusted ? "TRUSTED_UIDS=0" : `TRUSTED_UIDS="0 ${process.getuid!()}"`)
    .replace(/^GENERATED=.*$/m, `GENERATED=${generated}`)
    .replace(/^SHARE_ROOT=.*$/m, `SHARE_ROOT=${shared}`)
    .replace(/^VOLUME_ROOT=.*$/m, `VOLUME_ROOT=${volumes}`)
    .replace(/^SMB_CONF=.*$/m, `SMB_CONF=${smbConf}`)
    .replace(/^EXPORTS=.*$/m, `EXPORTS=${exportsPath}`)
    .replaceAll("/etc/network/interfaces", join(etc, "network", "interfaces"))
    .replaceAll("/etc/resolv.conf", join(etc, "resolv.conf"))
    .replaceAll("/etc/localtime", join(etc, "localtime"))
    .replaceAll("/etc/timezone", join(etc, "timezone"))
    .replaceAll("/usr/share/zoneinfo", join(dir, "zoneinfo"));
  writeFileSync(script, src);
  chmodSync(script, 0o755);
  mkdirSync(join(dir, "zoneinfo", "Europe"), { recursive: true });
  writeFileSync(join(dir, "zoneinfo", "Europe", "Berlin"), "TZif-berlin");
  writeFileSync(join(dir, "secret"), "root:$6$hash:::\n");

  return {
    dir,
    generated,
    shared,
    volumes,
    smbConf,
    exports: exportsPath,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.trim()),
    run(args, input) {
      const r = spawnSync("sh", [script, ...args], {
        encoding: "utf8",
        input: input ?? "",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function withBox(fn: (box: Box) => void, roots?: { shared: string; volumes: string }, opts?: { untrusted?: boolean }) {
  const box = sandbox(roots, opts);
  try {
    fn(box);
  } finally {
    box.cleanup();
  }
}

// ---- Accounts ---------------------------------------------------------------

test("system and reserved accounts are refused before any tool runs", () => {
  withBox((box) => {
    for (const name of ["root", "wheel", "opennas", "nginx", "daemon", "chrony", "admin", "docker", "-rf", "../x"]) {
      for (const op of [["user-add", name], ["user-passwd", name], ["user-del", name]]) {
        const r = box.run(op, "pw\npw\n");
        assert.notEqual(r.code, 0, `${op.join(" ")} was accepted`);
      }
    }
    assert.deepEqual(box.calls(), [], "a system tool ran for a refused account");
  });
});

test("a share account can have its Samba password set", () => {
  withBox((box) => {
    for (const name of ["alice", "legacy"]) {
      const r = box.run(["user-passwd", name], "pw\npw\n");
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(box.calls(), [
      "smbpasswd -s -a alice",
      "smbpasswd -e alice",
      "smbpasswd -s -a legacy",
      "smbpasswd -e legacy",
    ]);
  });
});

test("a new share account is created locked and marked as OpenNAS's", () => {
  withBox((box) => {
    assert.equal(box.run(["user-add", "carol"]).code, 0);
    assert.deepEqual(box.calls(), ["adduser -S -D -H -s /sbin/nologin -g OpenNAS share user carol"]);
    // An existing share account is left as it is.
    assert.equal(box.run(["user-add", "alice"]).code, 0);
    assert.equal(box.calls().length, 1);
  });
});

test("an OpenNAS group called wheel cannot touch the real wheel", () => {
  // The bug this guards: reconciling members of a group named `wheel` removed
  // the administrators from it.
  withBox((box) => {
    for (const g of ["wheel", "root", "docker", "disk", "shadow", "kvm", "libvirt", "adm", "opennas", "Wheel"]) {
      assert.notEqual(box.run(["group-sync", g, "alice"]).code, 0, `group-sync ${g} was accepted`);
      assert.notEqual(box.run(["group-del", g]).code, 0, `group-del ${g} was accepted`);
    }
    // A group that holds a real account, or is someone's primary group, is not ours either.
    assert.notEqual(box.run(["group-sync", "mixed", "alice"]).code, 0);
    assert.notEqual(box.run(["group-del", "admin"]).code, 0);
    assert.deepEqual(box.calls(), []);
  });
});

test("group-sync reconciles members, over share accounts only", () => {
  withBox((box) => {
    const r = box.run(["group-sync", "editors", "bob", "admin", "root"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /skipping 'admin'/);
    assert.deepEqual(box.calls(), ["addgroup bob editors", "delgroup alice editors"]);
  });
  withBox((box) => {
    // A new group is created as a regular (non-system) group.
    assert.equal(box.run(["group-sync", "photos", "alice"]).code, 0);
    assert.equal(box.calls()[0], "addgroup photos");
  });
});

test("only OpenNAS-owned services can be driven", () => {
  withBox((box) => {
    for (const [unit, action] of [["sshd", "stop"], ["nginx", "stop"], ["docker", "stop"], ["samba", "zap"], ["networking", "restart"], ["opennas", "stop"]]) {
      assert.notEqual(box.run(["service", unit!, action!]).code, 0, `${unit} ${action} was accepted`);
    }
    assert.deepEqual(box.calls(), []);
    assert.equal(box.run(["service", "samba", "enable"]).code, 0);
    assert.equal(box.run(["service", "samba", "start"]).code, 0);
    assert.equal(box.run(["service", "nginx", "reload"]).code, 0);
    assert.deepEqual(box.calls(), ["rc-update add samba default", "rc-service samba start", "rc-service nginx reload"]);
  });
});

// ---- SSH keys, timezone, network --------------------------------------------

test("ssh keys are refused for the service account and system users", () => {
  withBox((box) => {
    for (const user of ["opennas", "root", "nginx", "legacy", "alice"]) {
      assert.notEqual(box.run(["ssh", "keys", user], "ssh-ed25519 AAAA x\n").code, 0, `keys for ${user} accepted`);
    }
    assert.deepEqual(box.calls(), []);
  });
});

test("ssh keys refuse a symlinked .ssh, and are written as the user", () => {
  withBox((box) => {
    const home = join(box.dir, "home", "admin");
    symlinkSync(join(box.dir, "etc"), join(home, ".ssh"));
    const r = box.run(["ssh", "keys", "admin"], "ssh-ed25519 AAAA x\n");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /symlink/);
    assert.deepEqual(box.calls(), []);
  });
  withBox((box) => {
    const r = box.run(["ssh", "keys", "admin"], "ssh-ed25519 AAAA x\n");
    assert.equal(r.code, 0, r.stderr);
    // Dropped to the user for the write, so a symlink race buys nothing.
    assert.match(box.calls()[0] ?? "", /^su -s \/bin\/sh -c/);
  });
});

test("a timezone cannot walk out of the zoneinfo tree", () => {
  withBox((box) => {
    for (const tz of ["../../../../etc/shadow", "/etc/shadow", "Europe/../../secret", "..", "-x", "Europe//Berlin"]) {
      assert.notEqual(box.run(["timezone", tz]).code, 0, `${tz} was accepted`);
    }
    assert.ok(!existsSync(join(box.dir, "etc", "localtime")));
    assert.equal(box.run(["timezone", "Europe/Berlin"]).code, 0);
    assert.equal(readFileSync(join(box.dir, "etc", "localtime"), "utf8"), "TZif-berlin");
  });
});

test("a static address without a gateway is accepted; a bad DNS server is not", () => {
  withBox((box) => {
    const ok = box.run(["iface", "eth0", "static", "192.168.1.5", "24", "", "1.1.1.1, 9.9.9.9"]);
    assert.equal(ok.code, 0, ok.stderr);
    const ifaces = readFileSync(join(box.dir, "etc", "network", "interfaces"), "utf8");
    assert.match(ifaces, /address 192\.168\.1\.5\/24/);
    assert.doesNotMatch(ifaces, /gateway/);
    assert.equal(
      readFileSync(join(box.dir, "etc", "resolv.conf"), "utf8"),
      "nameserver 1.1.1.1\nnameserver 9.9.9.9\n",
    );
    for (const dns of ["1.1.1.1\nnameserver 6.6.6.6", "evil.example", "1.1.1.1;reboot", "300.1.1.1"]) {
      assert.notEqual(box.run(["iface", "eth0", "static", "192.168.1.5", "24", "", dns]).code, 0, `dns ${JSON.stringify(dns)}`);
    }
    assert.notEqual(box.run(["iface", "eth0", "static", "192.168.1.5", "24", "10.0.0.1x"]).code, 0);
    assert.notEqual(box.run(["iface", "eth0", "static", "192.168.1.5", "33"]).code, 0);
  });
});

// ---- Share configs -------------------------------------------------------------

process.env.OPENNAS_SHARE_USER = "opennas";
const { generateSmbConf, generateExports } = await import("../../apps/api/src/services/services.ts");
const { config } = await import("../../apps/api/src/config.ts");

const servicesCfg: ServicesConfig = {
  smb: { enabled: true, workgroup: "WORKGROUP", serverString: "OpenNAS", allowGuest: true },
  nfs: { enabled: true, allowedNetworks: "192.168.1.0/24" },
  afp: { enabled: false },
};

function share(over: Partial<Share>): Share {
  return {
    id: "s",
    name: "media",
    comment: "",
    guestAccess: "none",
    smbEnabled: true,
    nfsEnabled: true,
    browseable: true,
    volume: null,
    createdAt: "",
    permissions: [{ username: "alice", level: "rw" }],
    groupPermissions: [{ name: "editors", level: "ro" }],
    recycleEnabled: false,
    timeMachineEnabled: false,
    nfsRules: [],
    quotaBytes: 0,
    ...over,
  } as Share;
}

const shares: Share[] = [
  share({ name: "media", comment: "Films & music", recycleEnabled: true }),
  share({ name: "Time Machine", timeMachineEnabled: true, quotaBytes: 500 * 1024 ** 3, nfsEnabled: false }),
  share({
    name: "backups",
    volume: "vol1",
    guestAccess: "rw",
    nfsRules: [{ id: "r", network: "10.0.0.0/8", level: "rw", rootSquash: false }],
  }),
];

function shareRoots() {
  return { shared: config.filesRoot, volumes: config.volumesRoot };
}

function stageReal(box: Box) {
  mkdirSync(join(box.shared, "media"), { recursive: true });
  mkdirSync(join(box.volumes, "vol1", "backups"), { recursive: true });
  const smb = generateSmbConf(servicesCfg, shares);
  const exp = generateExports(servicesCfg, shares);
  writeFileSync(join(box.generated, "smb.conf"), smb);
  writeFileSync(join(box.generated, "exports"), exp);
  return { smb, exp };
}

test("the backend's real generated configs are installed unchanged", () => {
  withBox((box) => {
    const { smb, exp } = stageReal(box);
    const r = box.run(["share-apply"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(box.smbConf, "utf8"), smb);
    assert.equal(readFileSync(box.exports, "utf8"), exp);
    assert.match(exp, /no_root_squash/, "the fixture should exercise a no_root_squash rule");
    assert.ok(box.calls().includes("exportfs -ra"));
    assert.ok(box.calls().includes("smbcontrol all reload-config"));
  }, shareRoots());
});

test("an smb.conf with anything OpenNAS does not generate is not installed", () => {
  const hostile = [
    ["root preexec", (s: string) => s.replace("[media]", "[media]\n   root preexec = /bin/sh -c 'id > /tmp/x'")],
    ["include", (s: string) => s.replace("[global]", "[global]\n   include = /etc/shadow")],
    ["path outside", (s: string) => s.replace(/path = .*media/, "path = /etc")],
    ["dotdot path", (s: string) => s.replace(/path = (.*)media/, "path = $1media/../../..")],
    ["force user root", (s: string) => s.replace("force user = opennas", "force user = root")],
    ["magic script", (s: string) => s + "   magic script = run.sh\n"],
    ["homes", (s: string) => s + "[homes]\n   path = /home\n"],
    ["second global", (s: string) => s + "[global]\n   workgroup = X\n"],
    ["extra vfs", (s: string) => s.replace("vfs objects = catia fruit streams_xattr recycle", "vfs objects = catia full_audit")],
  ] as const;
  for (const [what, mutate] of hostile) {
    withBox((box) => {
      const { smb } = stageReal(box);
      writeFileSync(join(box.generated, "smb.conf"), mutate(smb));
      writeFileSync(box.smbConf, "# previous\n");
      const r = box.run(["share-apply"]);
      assert.notEqual(r.code, 0, `${what}: accepted`);
      assert.equal(readFileSync(box.smbConf, "utf8"), "# previous\n", `${what}: smb.conf was replaced`);
    }, shareRoots());
  }
});

test("an export that is not a share, or has options OpenNAS never writes, is dropped", () => {
  withBox((box) => {
    const { exp } = stageReal(box);
    mkdirSync(join(box.shared, "evil-parent"), { recursive: true });
    symlinkSync("/", join(box.shared, "rootlink"));
    const extra = [
      "/    *(rw,no_root_squash)",
      `${box.shared}    *(rw,no_root_squash)`,
      `${box.volumes}/vol1    *(rw)`,
      `${box.shared}/media/../../..    *(rw)`,
      `${box.shared}/rootlink    *(rw,no_root_squash)`,
      `${box.shared}/media    *(rw,insecure)`,
      `${box.shared}/media    *(rw,fsid=0)`,
      `${box.shared}/media    *`,
      `${box.shared}/media    evil host(rw)`,
    ];
    writeFileSync(join(box.generated, "exports"), exp + extra.join("\n") + "\n");
    const r = box.run(["share-apply"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(box.exports, "utf8"), exp, "a hostile export line survived");
    assert.equal((r.stderr.match(/dropped/g) ?? []).length, extra.length);
  }, shareRoots());
});

test("a symlinked staging file is refused rather than read as root", () => {
  withBox((box) => {
    symlinkSync(join(box.dir, "secret"), join(box.generated, "exports"));
    writeFileSync(box.exports, "# previous\n");
    const r = box.run(["share-apply"]);
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(box.exports, "utf8"), "# previous\n");
    assert.doesNotMatch(r.stderr, /\$6\$hash/);
  });
});

test("the shipped staging paths are the backend's data dir", () => {
  const src = readFileSync(HELPER, "utf8");
  assert.match(src, /^DATA_DIR=\/var\/lib\/opennas$/m);
  assert.match(src, /^TRUSTED_UIDS=0$/m, "only root may own the directories above a share");
  assert.match(src, /^SVC=opennas$/m);
  assert.match(src, /^GENERATED=\/var\/lib\/opennas\/generated$/m);
  assert.match(src, /^SHARE_ROOT=\/var\/lib\/opennas\/shared$/m);
  assert.match(src, /^VOLUME_ROOT=\/var\/lib\/opennas\/volumes$/m);
  assert.match(src, /^SMB_CONF=\/etc\/samba\/smb\.conf$/m);
  assert.match(src, /^EXPORTS=\/etc\/exports$/m);
});

// ---- Share directories and the roots above them -------------------------------

const mode = (p: string) => statSync(p).mode & 0o7777;

test("share-dir creates a share directory, in the share root or on a volume", () => {
  withBox((box) => {
    mkdirSync(join(box.volumes, "vol1"));
    assert.equal(box.run(["share-dir", "create", "Media Files"]).code, 0);
    assert.ok(statSync(join(box.shared, "Media Files")).isDirectory());
    assert.equal(mode(join(box.shared, "Media Files")), 0o755);
    const v = box.run(["share-dir", "create", "-backups", "vol1"]);
    assert.equal(v.code, 0, v.stderr);
    assert.ok(statSync(join(box.volumes, "vol1", "-backups")).isDirectory());
    // An existing directory (a ZFS dataset, a re-created share) is fine.
    assert.equal(box.run(["share-dir", "create", "Media Files"]).code, 0);
  });
});

test("share-dir refuses symlinks, `..`, slashes and unknown volumes", () => {
  withBox((box) => {
    const outside = join(box.dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(box.shared, "linked"));
    mkdirSync(join(box.volumes, "vol1"));
    symlinkSync(join(box.dir, "outside"), join(box.volumes, "vlink"));
    for (const args of [
      ["linked"],
      [".."],
      ["."],
      [""],
      ["a/b"],
      ["../outside"],
      ["evil\nname"],
      ["x", "../shared"],
      ["x", "nope"],
      ["x", "vlink"],
      ["x", "vol1/.."],
    ]) {
      const r = box.run(["share-dir", "create", ...args]);
      assert.notEqual(r.code, 0, `accepted ${JSON.stringify(args)}`);
    }
    assert.ok(lstatSync(join(box.shared, "linked")).isSymbolicLink(), "the symlink was replaced");
    assert.deepEqual(readdirSync(outside), [], "something was created through a symlink");
    assert.ok(!existsSync(join(box.dir, "x")) && !existsSync(join(box.volumes, "x")));
  });
});

test("share-dir refuses a share root the service account could still rewrite", () => {
  // As on a machine whose roots could not be made root's: the sandbox's own
  // directories stand for the service account's.
  withBox((box) => {
    const r = box.run(["share-dir", "create", "Media"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /writable by the service account/);
    assert.ok(!existsSync(join(box.shared, "Media")));
  }, undefined, { untrusted: true });
});

test("share-apply installs each share's resolved path, not the configured one", () => {
  withBox((box) => {
    // vol2 is another name for vol1 (root made the link, so it is trusted).
    mkdirSync(join(box.volumes, "vol1", "backups"), { recursive: true });
    symlinkSync(join(box.volumes, "vol1"), join(box.volumes, "vol2"));
    const onVol2 = [share({ name: "backups", volume: "vol2" })];
    writeFileSync(join(box.generated, "smb.conf"), generateSmbConf(servicesCfg, onVol2));
    writeFileSync(join(box.generated, "exports"), generateExports(servicesCfg, onVol2));
    const r = box.run(["share-apply"]);
    assert.equal(r.code, 0, r.stderr);
    const real = join(box.volumes, "vol1", "backups");
    const smb = readFileSync(box.smbConf, "utf8");
    assert.match(smb, new RegExp(`^   path = ${real}$`, "m"));
    assert.doesNotMatch(smb, /vol2/);
    const exp = readFileSync(box.exports, "utf8");
    assert.match(exp, new RegExp(`^${real}    `, "m"));
    assert.doesNotMatch(exp, /vol2/);
  }, shareRoots());
});

test("share-apply refuses a share directory that is a symlink, or a writable share root", () => {
  withBox((box) => {
    const { smb } = stageReal(box);
    rmSync(join(box.shared, "media"), { recursive: true });
    mkdirSync(join(box.shared, "elsewhere"));
    symlinkSync(join(box.shared, "elsewhere"), join(box.shared, "media"));
    writeFileSync(box.smbConf, "# previous\n");
    const r = box.run(["share-apply"]);
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(box.smbConf, "utf8"), "# previous\n");
    assert.doesNotMatch(readFileSync(box.exports, "utf8"), /media/);
    assert.ok(smb.includes("media"));
  }, shareRoots());
  withBox((box) => {
    const { exp } = stageReal(box);
    assert.ok(exp.trim(), "the fixture should export something");
    writeFileSync(box.smbConf, "# previous\n");
    const r = box.run(["share-apply"]);
    assert.notEqual(r.code, 0);
    assert.equal(readFileSync(box.smbConf, "utf8"), "# previous\n");
    const kept = readFileSync(box.exports, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    assert.deepEqual(kept, [], "an export under a rewritable root survived");
  }, shareRoots(), { untrusted: true });
});

test("share-roots secures the roots, skips symlinks, and is idempotent", () => {
  withBox((box) => {
    const elsewhere = join(box.dir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    chmodSync(elsewhere, 0o700);
    mkdirSync(join(box.volumes, "vol1"), { mode: 0o777 });
    chmodSync(join(box.volumes, "vol1"), 0o777);
    mkdirSync(join(box.volumes, "vol2", "opennas"), { recursive: true });
    writeFileSync(join(box.volumes, "vol2", "opennas", "disk.img"), "vm");
    symlinkSync(elsewhere, join(box.volumes, "evil"));
    chmodSync(box.shared, 0o777);

    const snapshot = () => ({
      data: mode(box.dir),
      shared: mode(box.shared),
      volumes: mode(box.volumes),
      vol1: mode(join(box.volumes, "vol1")),
      vol1opennas: statSync(join(box.volumes, "vol1", "opennas")).isDirectory(),
      vol2: mode(join(box.volumes, "vol2")),
      vol2disk: readFileSync(join(box.volumes, "vol2", "opennas", "disk.img"), "utf8"),
      elsewhere: mode(elsewhere),
      evil: lstatSync(join(box.volumes, "evil")).isSymbolicLink(),
      entries: readdirSync(box.volumes).sort(),
    });

    const first = box.run(["share-roots"]);
    assert.equal(first.code, 0, first.stderr);
    const after = snapshot();
    assert.deepEqual(after, {
      data: 0o1770,
      shared: 0o755,
      volumes: 0o755,
      vol1: 0o755,
      vol1opennas: true,
      vol2: 0o755,
      vol2disk: "vm",
      elsewhere: 0o700,
      evil: true,
      entries: ["evil", "vol1", "vol2"],
    });
    const second = box.run(["share-roots"]);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(snapshot(), after);
  });
});

test("share-roots refuses a share root that is a symlink, and changes nothing through it", () => {
  withBox((box) => {
    const target = join(box.dir, "target");
    mkdirSync(target);
    chmodSync(target, 0o700);
    rmSync(box.shared, { recursive: true });
    symlinkSync(target, box.shared);
    assert.notEqual(box.run(["share-roots"]).code, 0);
    assert.equal(mode(target), 0o700);
  });
});
