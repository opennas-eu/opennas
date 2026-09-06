import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The privileged ZFS helper's guards, run as the real script.
 *
 * ZFS itself isn't on a CI runner and can't be - the kernel module has to match
 * the running kernel - so `zpool` and `zfs` are replaced with stubs that record
 * every argument they are handed and always succeed. That is not a simulation of
 * ZFS: it is a **tripwire**. The property being tested is that a hostile pool
 * name is rejected by the helper *before* any ZFS command is invoked at all, and
 * a stub proves that better than the real thing would, because with the real
 * `zpool` a rejected name and a name ZFS happened to dislike look identical.
 *
 * The behaviour of real pools is verified separately, in a VM with a real
 * kernel module and real disks.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const HELPER = join(repoRoot, "packaging", "opennas-zfs");

interface Sandbox {
  dir: string;
  /** Every argv the stubs were invoked with, one per line. */
  calls: () => string[];
  run: (args: string[]) => { code: number; stdout: string; stderr: string };
  cleanup: () => void;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "opennas-zfs-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");

  // Stubs that succeed at everything and write down what they were asked to do.
  for (const name of ["zpool", "zfs"]) {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/bin/sh\necho "${name} $*" >> "${log}"\n` +
        // `zpool list -H -o name` is how the helper checks for an existing pool;
        // answering nothing means "no pools", which is the clean-slate case.
        `case "$1" in list) exit 0 ;; esac\nexit 0\n`,
    );
    chmodSync(path, 0o755);
  }
  // findmnt decides whether the system runs from ZFS; here it does not.
  writeFileSync(join(bin, "findmnt"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "findmnt"), 0o755);
  // lsblk reports nothing mounted, so a disk looks free.
  writeFileSync(join(bin, "lsblk"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "lsblk"), 0o755);

  return {
    dir,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.trim()),
    run(args) {
      try {
        const stdout = execFileSync("sh", [HELPER, ...args], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        return { code: 0, stdout, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A block device the helper will accept as a member. */
function fakeDisk(box: Sandbox, name: string): string {
  // The helper requires `-b`, which only a real block device satisfies - so
  // these tests use ones the machine already has, read-only and never touched
  // because the stubbed zpool never does anything.
  return name;
}

const REAL_BLOCK_DEVICES = ["/dev/loop0", "/dev/loop1", "/dev/loop2", "/dev/loop3", "/dev/loop4"];
const haveBlockDevices = REAL_BLOCK_DEVICES.every((d) => existsSync(d));
const skipDisks = haveBlockDevices ? false : "needs a few block devices to name as members";

test("the helper is a valid shell script", () => {
  execFileSync("sh", ["-n", HELPER]);
});

test("an unknown subcommand does nothing and says how to use it", () => {
  const box = sandbox();
  try {
    const r = box.run(["do-something-clever"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /usage: opennas-zfs/);
    assert.deepEqual(box.calls(), [], "a ZFS command ran for an unknown subcommand");
  } finally {
    box.cleanup();
  }
});

test("a hostile pool name never reaches zpool", () => {
  // The one that matters. Each of these is rejected by the name check, and the
  // proof is that the stub recorded nothing at all.
  const hostile = [
    "../etc",
    "../../var/lib",
    "-o",
    "-f",
    "a b",
    "tank;reboot",
    "tank$(id)",
    "tank`id`",
    "tank|sh",
    "tank\nrm -rf /",
    ".hidden",
    "",
    "tank/child",
    "tank'quote",
    'tank"quote',
  ];
  for (const name of hostile) {
    const box = sandbox();
    try {
      const r = box.run(["pool-create", name, "mirror", "/dev/sda", "/dev/sdb"]);
      assert.notEqual(r.code, 0, `accepted the pool name ${JSON.stringify(name)}`);
      const created = box.calls().filter((c) => c.startsWith("zpool create"));
      assert.deepEqual(created, [], `zpool create ran for ${JSON.stringify(name)}`);
    } finally {
      box.cleanup();
    }
  }
});

test("a hostile dataset name never reaches zfs", () => {
  for (const name of ["../etc/passwd", "tank/../../etc", "tank", "-o", "tank/a b", "tank/x;reboot", "", "/", "tank/"]) {
    const box = sandbox();
    try {
      const r = box.run(["dataset-create", name]);
      assert.notEqual(r.code, 0, `accepted the dataset ${JSON.stringify(name)}`);
      assert.deepEqual(
        box.calls().filter((c) => c.startsWith("zfs create")),
        [],
        `zfs create ran for ${JSON.stringify(name)}`,
      );
    } finally {
      box.cleanup();
    }
  }
});

test("a quota that isn't a number is refused", () => {
  for (const q of ["1G", "-1", "abc", "10;reboot", "", "1e9"]) {
    const box = sandbox();
    try {
      const r = box.run(["dataset-quota", "tank/photos", q]);
      assert.notEqual(r.code, 0, `accepted the quota ${JSON.stringify(q)}`);
      assert.deepEqual(box.calls().filter((c) => c.includes("set quota")), []);
    } finally {
      box.cleanup();
    }
  }
  // A plain byte count is fine, and "none" clears it.
  for (const q of ["10485760", "none"]) {
    const box = sandbox();
    try {
      assert.equal(box.run(["dataset-quota", "tank/photos", q]).code, 0, `refused the quota ${q}`);
      assert.ok(box.calls().some((c) => c.includes(`set quota=${q}`)), `did not set quota=${q}`);
    } finally {
      box.cleanup();
    }
  }
});

test("a snapshot has to be given as dataset@name", () => {
  for (const s of ["tank/docs", "tank/docs@", "@snap", "tank/docs@a b", "tank/docs@-x", "../x@y"]) {
    const box = sandbox();
    try {
      assert.notEqual(box.run(["snapshot-destroy", s]).code, 0, `accepted ${JSON.stringify(s)}`);
      assert.deepEqual(box.calls().filter((c) => c.startsWith("zfs destroy")), []);
    } finally {
      box.cleanup();
    }
  }
});

test("the disk-count minimum for each layout is enforced before anything runs", { skip: skipDisks }, () => {
  const cases: [string, number][] = [
    ["mirror", 1],
    ["raidz1", 2],
    ["raidz2", 3],
    ["raidz3", 4],
  ];
  for (const [layout, tooFew] of cases) {
    const box = sandbox();
    try {
      const disks = REAL_BLOCK_DEVICES.slice(0, tooFew).map((d) => fakeDisk(box, d));
      const r = box.run(["pool-create", "tank", layout, ...disks]);
      assert.notEqual(r.code, 0, `${layout} accepted ${tooFew} disks`);
      assert.deepEqual(box.calls().filter((c) => c.startsWith("zpool create")), [], `${layout} reached zpool create`);
    } finally {
      box.cleanup();
    }
  }
});

test("an unknown layout is refused", () => {
  const box = sandbox();
  try {
    const r = box.run(["pool-create", "tank", "raid5", "/dev/sda", "/dev/sdb", "/dev/sdc"]);
    assert.notEqual(r.code, 0);
    assert.deepEqual(box.calls().filter((c) => c.startsWith("zpool create")), []);
  } finally {
    box.cleanup();
  }
});

test("a member that isn't a block device is refused", () => {
  const box = sandbox();
  try {
    // A real file, so the check that fails is "is it a block device" and not
    // "does it exist".
    const notADisk = join(box.dir, "notadisk");
    writeFileSync(notADisk, "");
    const r = box.run(["pool-create", "tank", "mirror", "/dev/sda", notADisk]);
    assert.notEqual(r.code, 0);
    assert.deepEqual(box.calls().filter((c) => c.startsWith("zpool create")), []);
  } finally {
    box.cleanup();
  }
});

test("a member path outside /dev is refused", () => {
  const box = sandbox();
  try {
    const r = box.run(["pool-create", "tank", "mirror", "/tmp/sda", "/dev/sdb"]);
    assert.notEqual(r.code, 0);
    assert.deepEqual(box.calls().filter((c) => c.startsWith("zpool create")), []);
  } finally {
    box.cleanup();
  }
});

test("status answers rather than failing when ZFS is missing entirely", () => {
  // Reporting that ZFS is unusable is the whole job of `status`, so unlike every
  // other subcommand it must not exit non-zero when zpool isn't there.
  const dir = mkdtempSync(join(tmpdir(), "opennas-nozfs-"));
  try {
    const r = execFileSync("sh", [HELPER, "status"], {
      encoding: "utf8",
      // An empty PATH plus the basics: no zpool anywhere.
      env: { PATH: "/usr/bin:/bin" },
    });
    // On a machine that genuinely has no ZFS this is "absent"; on one that has
    // it, "ready" or "no-module". All three are answers, not failures.
    assert.match(r, /^state=(absent|no-module|ready)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the helper is shipped and allow-listed like the others", () => {
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  const policy = installer.split("doas.d/opennas.conf")[1] ?? "";
  assert.ok(policy.includes("cmd /usr/lib/opennas/opennas-zfs"), "no doas rule for the ZFS helper");
  const stage = readFileSync(join(repoRoot, "distro", "stage.sh"), "utf8");
  assert.match(stage, /packaging\/opennas-zfs/);
  const release = readFileSync(join(repoRoot, "packaging", "make-release.sh"), "utf8");
  assert.match(release, /packaging\/opennas-zfs/);
});

test("ZFS is optional: a build without it must still install", () => {
  // The kernel module is the one package here that can legitimately be missing
  // for an architecture or kernel flavour. A warning is right; aborting is not.
  const installer = readFileSync(join(repoRoot, "distro", "installer", "opennas-install"), "utf8");
  // Just the word list of the `for _bin in ... ; do` loop, not the rest of the
  // file - the first version of this matched "zpool" in the *warning* it was
  // supposed to be checking for, and duly failed.
  const loop = installer.match(/for _bin in \\?\n?([\s\S]*?);\s*do/);
  assert.ok(loop, "could not find the required-binaries loop");
  const required = loop[1]!.split(/[\s\\]+/).filter(Boolean);
  assert.ok(required.includes("mdadm"), "the loop was parsed wrongly");
  assert.ok(!required.includes("zpool"), "zpool is in the abort-on-missing list");
  assert.ok(!required.includes("zfs"), "zfs is in the abort-on-missing list");
  assert.match(installer, /note: ZFS is not installed/);
});
