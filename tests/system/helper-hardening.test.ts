import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The storage, ZFS and firewall helpers' guards, run as the real scripts.
 *
 * Same approach as zfs-helper.test.ts: every tool that would change the machine
 * is a stub that records its arguments, and the absolute paths the scripts work
 * on are pointed at a sandbox in a copy. What is being checked is what a helper
 * refuses - and that when it refuses, nothing ran.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packaging = join(repoRoot, "packaging");

interface Box {
  dir: string;
  bin: string;
  calls: () => string[];
  run: (args: string[]) => { code: number; stdout: string; stderr: string };
  sh: (script: string) => { code: number; stdout: string; stderr: string };
  cleanup: () => void;
}

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A sandboxed copy of one helper, with `rewrite` applied to its source. */
function sandbox(helper: string, rewrite: (src: string, dir: string) => string, stubs: Record<string, string> = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), `${helper}-`));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  for (const [name, body] of Object.entries(stubs)) {
    stub(bin, name, `echo "${name} $*" >> "${log}"\n${body}`);
  }
  const script = join(dir, helper);
  writeFileSync(script, rewrite(readFileSync(join(packaging, helper), "utf8"), dir));
  chmodSync(script, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const result = (r: ReturnType<typeof spawnSync>) => ({
    code: r.status ?? 1,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  });
  return {
    dir,
    bin,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.trim()),
    run: (args) => result(spawnSync("sh", [script, ...args], { encoding: "utf8", env })),
    // Run a snippet with the helper's *functions* defined (everything above its
    // top-level `case`), for the pieces that are only reachable on real disks.
    sh(snippet) {
      const src = readFileSync(script, "utf8");
      const defs = src.slice(0, src.search(/^case "\$\{1:-\}" in$/m));
      return result(spawnSync("sh", ["-c", `${defs}\n${snippet}`], { encoding: "utf8", env }));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function withBox(box: Box, fn: (box: Box) => void) {
  try {
    fn(box);
  } finally {
    box.cleanup();
  }
}

const REAL_BLOCK_DEVICES = ["/dev/loop0", "/dev/loop1"];
const skipDisks = REAL_BLOCK_DEVICES.every((d) => existsSync(d)) ? false : "needs block devices to name as members";

// ---- opennas-storage ----------------------------------------------------------

const storageBox = (lsblk = "") =>
  sandbox(
    "opennas-storage",
    (src, dir) =>
      src
        .replaceAll("/etc/fstab", join(dir, "fstab"))
        .replaceAll("/etc/mdadm.conf", join(dir, "mdadm.conf"))
        .replaceAll("/var/lib/opennas/volumes", join(dir, "volumes")),
    {
      lsblk,
      sfdisk: "",
      wipefs: "",
      mdadm: "",
      smartctl: "",
      findmnt: "exit 1",
      umount: "",
      blkid: "exit 1",
      mkfs: "",
    },
  );

test("erasing a volume removes only its own fstab line", () => {
  withBox(storageBox(), (box) => {
    const fstab = join(box.dir, "fstab");
    const vol = join(box.dir, "volumes");
    writeFileSync(
      fstab,
      [
        "/dev/sda2  /  ext4  rw  0 1",
        `UUID=1111  ${vol}/data  ext4  rw,relatime  0 2`,
        `UUID=2222  ${vol}/data2  ext4  rw,relatime  0 2`,
        `UUID=3333  ${vol}/mydata  ext4  rw,relatime  0 2`,
      ].join("\n") + "\n",
    );
    const r = box.run(["erase", "data"]);
    assert.equal(r.code, 0, r.stderr);
    const left = readFileSync(fstab, "utf8");
    assert.doesNotMatch(left, /\/data\s/);
    assert.match(left, /\/data2 /, "erasing data took data2 with it");
    assert.match(left, /\/mydata /);
    assert.match(left, /^\/dev\/sda2 /m);
  });
});

test("removing md1 from mdadm.conf leaves md10 alone", () => {
  withBox(storageBox(), (box) => {
    const conf = join(box.dir, "mdadm.conf");
    writeFileSync(
      conf,
      [
        "ARRAY /dev/md1 metadata=1.2 name=nas:1 UUID=aaaa:1111",
        "ARRAY /dev/md10 metadata=1.2 name=nas:10 UUID=bbbb:2222",
        "ARRAY /dev/md/2 metadata=1.2 name=nas:2 UUID=cccc:3333",
      ].join("\n") + "\n",
    );
    assert.equal(box.sh(`mdadm_conf_remove /dev/md1 aaaa:1111`).code, 0);
    assert.equal(readFileSync(conf, "utf8"), "ARRAY /dev/md10 metadata=1.2 name=nas:10 UUID=bbbb:2222\nARRAY /dev/md/2 metadata=1.2 name=nas:2 UUID=cccc:3333\n");
    // By UUID when the device field is a /dev/md/<name> alias.
    assert.equal(box.sh(`mdadm_conf_remove /dev/md2 cccc:3333`).code, 0);
    assert.equal(readFileSync(conf, "utf8"), "ARRAY /dev/md10 metadata=1.2 name=nas:10 UUID=bbbb:2222\n");
  });
});

test("a size that would smuggle a second sfdisk instruction is refused", () => {
  withBox(storageBox(), (box) => {
    for (const size of ["10G,type=ef", "10G\nsize=1M", "10", "G", "1.5G", "-10G", "10GG", "10T", " 10G"]) {
      const r = box.run(["init-free", "/dev/null", "ext4", "vol", size]);
      assert.notEqual(r.code, 0, `size ${JSON.stringify(size)} was accepted`);
      assert.match(r.stderr, /invalid size/, `size ${JSON.stringify(size)}: ${r.stderr}`);
    }
    assert.deepEqual(box.calls(), []);
  });
});

test("smartctl is only ever pointed at a plain disk node", () => {
  withBox(storageBox(), (box) => {
    for (const disk of ["-a", "--scan", "/dev/sda --device=foo", "/dev/../etc/shadow", "/dev/sd", "/etc/shadow", "/dev/sda;id", "/dev/disk/by-id/x"]) {
      assert.notEqual(box.run(["smart", disk]).code, 0, `${disk} was accepted`);
      assert.notEqual(box.run(["smart-test", disk, "short"]).code, 0, `${disk} was accepted for a self-test`);
    }
    assert.deepEqual(box.calls(), []);
  });
});

test("a disk that is a member of something is not 'free' just because nothing is mounted", () => {
  for (const [what, lsblk] of [
    ["md member", 'case "$*" in *FSTYPE*) echo; echo linux_raid_member ;; *TYPE*) echo disk; echo part ;; esac'],
    ["zfs member", 'case "$*" in *FSTYPE*) echo zfs_member ;; *TYPE*) echo disk ;; esac'],
    ["LVM PV", 'case "$*" in *FSTYPE*) echo LVM2_member ;; *TYPE*) echo disk ;; esac'],
    ["holder", 'case "$*" in *FSTYPE*) echo ;; *TYPE*) echo disk; echo part; echo raid1 ;; esac'],
    ["mounted", 'case "$*" in *MOUNTPOINT*) echo /mnt ;; esac'],
  ] as const) {
    withBox(storageBox(lsblk), (box) => {
      assert.notEqual(box.sh("disk_unused /dev/vdb").code, 0, `${what}: treated as free`);
    });
  }
  withBox(storageBox('case "$*" in *FSTYPE*) echo; echo ext4 ;; *TYPE*) echo disk; echo part ;; esac'), (box) => {
    assert.equal(box.sh("disk_unused /dev/vdb").code, 0, "an unmounted plain filesystem is free");
  });
});

test("init and raid-create refuse an array member before wiping it", { skip: skipDisks }, () => {
  const member = 'case "$*" in *FSTYPE*) echo linux_raid_member ;; *TYPE*) echo disk ;; esac';
  withBox(storageBox(member), (box) => {
    assert.notEqual(box.run(["init", "/dev/loop0", "ext4", "vol"]).code, 0);
    assert.notEqual(box.run(["raid-create", "raid1", "vol", "ext4", "/dev/loop0", "/dev/loop1"]).code, 0);
    assert.notEqual(box.run(["raid-add", "md0", "/dev/loop0"]).code, 0);
    const ran = box.calls().filter((c) => !c.startsWith("lsblk"));
    assert.deepEqual(ran, [], "something ran against a disk that belongs to an array");
  });
});

// ---- opennas-zfs ----------------------------------------------------------------

function zfsBox(zfs: string, lsblk = "") {
  return sandbox(
    "opennas-zfs",
    (src, dir) => src.replace(/^VOLROOT=.*$/m, `VOLROOT=${join(dir, "volumes")}`),
    {
      zpool: 'case "$1" in list) exit 0 ;; esac\nexit 0',
      zfs,
      findmnt: "exit 1",
      lsblk,
      wipefs: "",
      partprobe: "",
    },
  );
}

test("pool-create refuses a disk that still belongs to another pool", { skip: skipDisks }, () => {
  withBox(zfsBox("", 'case "$*" in *FSTYPE*) echo zfs_member ;; esac'), (box) => {
    const r = box.run(["pool-create", "tank", "mirror", "/dev/loop0", "/dev/loop1"]);
    assert.notEqual(r.code, 0);
    assert.ok(!box.calls().some((c) => c.startsWith("zpool create")), "zpool create ran");
    assert.ok(!box.calls().some((c) => c.startsWith("wipefs")), "the member was wiped");
  });
});

test("an imported pool whose datasets would mount outside the volume root is sent back", () => {
  const datasets = (dir: string) =>
    `case "$1" in
get) echo local ;;
list) printf 'tank\\t${join(dir, "volumes")}/tank\\ntank/sneaky\\t/etc\\n' ;;
esac`;
  const dir = mkdtempSync(join(tmpdir(), "zfs-import-"));
  try {
    withBox(zfsBox(datasets(dir)), (box) => {
      // The fake `zfs list` names the sandbox's own volume root; rewrite it.
      const zfsStub = join(box.bin, "zfs");
      writeFileSync(zfsStub, readFileSync(zfsStub, "utf8").replaceAll(join(dir, "volumes"), join(box.dir, "volumes")));
      const r = box.run(["pool-import", "tank"]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /outside/);
      const calls = box.calls();
      assert.ok(calls.some((c) => /^zpool import -N /.test(c)), "the pool was not imported unmounted first");
      assert.ok(calls.includes("zpool export tank"), "the refused pool was left imported");
      assert.ok(!calls.some((c) => c.startsWith("zfs mount")), "something was mounted");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pool from another system is mounted under the volume root", () => {
  withBox(zfsBox('case "$1" in get) echo default ;; list) printf "" ;; esac'), (box) => {
    const r = box.run(["pool-import", "tank"]);
    assert.equal(r.code, 0, r.stderr);
    const calls = box.calls();
    assert.ok(calls.includes(`zfs set mountpoint=${join(box.dir, "volumes")}/tank tank`), calls.join("\n"));
    assert.ok(calls.includes("zfs mount -a"));
  });
});

// ---- opennas-firewall -------------------------------------------------------------

function firewallBox() {
  return sandbox(
    "opennas-firewall",
    (src, dir) =>
      src
        .replace(/^STAGED=.*$/m, `STAGED=${join(dir, "generated", "opennas.nft")}`)
        .replace(/^RULES=.*$/m, `RULES=${join(dir, "etc", "firewall.nft")}`),
    { nft: "", "rc-update": "" },
  );
}

test("the firewall only loads the staged ruleset, never an include", () => {
  withBox(firewallBox(), (box) => {
    const staged = join(box.dir, "generated", "opennas.nft");
    mkdirSync(join(box.dir, "generated"), { recursive: true });
    writeFileSync(join(box.dir, "other.nft"), "table inet opennas {}\n");

    // Any other path, even a perfectly good ruleset.
    assert.notEqual(box.run(["apply", join(box.dir, "other.nft")]).code, 0);
    // A symlink where the staged file should be.
    symlinkSync(join(box.dir, "other.nft"), staged);
    assert.notEqual(box.run(["apply", staged]).code, 0);
    rmSync(staged);
    // An include, in any spelling.
    for (const body of ['include "/etc/shadow"\n', 'table inet opennas {}\n  INCLUDE "/root/x"\n']) {
      writeFileSync(staged, body);
      assert.notEqual(box.run(["apply", staged]).code, 0, `accepted ${JSON.stringify(body)}`);
    }
    assert.deepEqual(box.calls(), [], "nft ran on a refused ruleset");

    writeFileSync(staged, "table inet opennas {}\n");
    const r = box.run(["apply", staged]);
    assert.equal(r.code, 0, r.stderr);
    // Checked, loaded and persisted from the same private copy.
    const nft = box.calls().filter((c) => c.startsWith("nft"));
    assert.equal(nft.length, 2);
    assert.ok(!nft.some((c) => c.includes(staged)), "nft read the staged file directly");
    assert.equal(readFileSync(join(box.dir, "etc", "firewall.nft"), "utf8"), "table inet opennas {}\n");
  });
});

test("the shipped firewall staging path is the backend's", () => {
  const src = readFileSync(join(packaging, "opennas-firewall"), "utf8");
  assert.match(src, /^STAGED=\/var\/lib\/opennas\/generated\/opennas\.nft$/m);
});
