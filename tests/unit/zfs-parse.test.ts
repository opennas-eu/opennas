import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import {
  ZFS_LAYOUTS,
  layoutInfo,
  parseDatasetList,
  parseImportable,
  parsePoolList,
  parsePoolStatus,
  parseSnapshotList,
} from "../../apps/api/src/system/zfs.js";

/**
 * Reading what ZFS says.
 *
 * `zpool list -Hp` and `zfs list -Hp` are tab-separated, exact-byte and stable —
 * those parse cleanly. `zpool status` is written for a person, has no contract,
 * and is the one that will change under us. So the tests below are mostly about
 * it, and mostly about the cases that matter operationally: a degraded pool, a
 * resilver in progress, checksum errors on one disk, and a layout that isn't the
 * one we assumed.
 *
 * The fixtures are the real output shapes ZFS produces. That is a weaker
 * guarantee than running the real thing — which is why this file is paired with
 * a VM run against actual pools — but a parser that only ever meets its author's
 * assumptions is worth testing against the awkward shapes anyway.
 */

test("pool list parses exact bytes", () => {
  const out = [
    "tank\t8001563222016\t1234567890\t7999328654126\tONLINE\t3\t15\t1.00",
    "backup\t2000398934016\t512000000000\t1488398934016\tDEGRADED\t11\t25\t1.00",
  ].join("\n");
  const pools = parsePoolList(out);
  assert.equal(pools.length, 2);
  assert.equal(pools[0]!.name, "tank");
  assert.equal(pools[0]!.sizeBytes, 8001563222016);
  assert.equal(pools[0]!.health, "ONLINE");
  assert.equal(pools[0]!.capacityPercent, 15);
  assert.equal(pools[1]!.health, "DEGRADED");
});

test("pool list survives the dashes ZFS prints for unknown figures", () => {
  // A pool with no dedup or fragmentation figure prints "-", not a number.
  const pools = parsePoolList("tank\t100\t10\t90\tONLINE\t-\t10\t-");
  assert.equal(pools.length, 1);
  assert.equal(pools[0]!.fragmentationPercent, 0);
  assert.equal(pools[0]!.dedupRatio, 0);
  assert.equal(pools[0]!.sizeBytes, 100);
});

test("pool list ignores blank and malformed lines", () => {
  assert.deepEqual(parsePoolList(""), []);
  assert.deepEqual(parsePoolList("\n\n  \n"), []);
  assert.deepEqual(parsePoolList("garbage"), []);
  assert.equal(parsePoolList("no such pool\ntank\t1\t1\t1\tONLINE").length, 1);
});

test("a healthy raidz2 pool's vdev tree is read correctly", () => {
  const status = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:12:31 with 0 errors on Sun Sep  6 03:12:31 2026
config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        ONLINE       0     0     0
\t  raidz2-0  ONLINE       0     0     0
\t    sda     ONLINE       0     0     0
\t    sdb     ONLINE       0     0     0
\t    sdc     ONLINE       0     0     0
\t    sdd     ONLINE       0     0     0

errors: No known data errors`;
  const { vdevs, scan, statusNote } = parsePoolStatus(status.replace(/\t/g, "    "));
  assert.equal(vdevs.length, 1);
  assert.equal(vdevs[0]!.name, "raidz2-0");
  assert.equal(vdevs[0]!.type, "raidz2");
  assert.equal(vdevs[0]!.state, "ONLINE");
  assert.deepEqual(vdevs[0]!.members.map((m) => m.name), ["sda", "sdb", "sdc", "sdd"]);
  assert.equal(vdevs[0]!.members[0]!.errors.checksum, 0);
  // A finished scrub is not a scrub in progress.
  assert.equal(scan, null);
  assert.equal(statusNote, "No known data errors");
});

test("a degraded pool mid-resilver reports the failure and the progress", () => {
  const status = `  pool: tank
 state: DEGRADED
status: One or more devices is currently being resilvered.  The pool will
        continue to function, possibly in a degraded state.
action: Wait for the resilver to complete.
  scan: resilver in progress since Sun Sep  6 04:02:11 2026
        1.21T scanned at 1.02G/s, 640G issued at 540M/s, 3.60T total
        160G resilvered, 17.36% done, 01:38:12 to go
config:

    NAME             STATE     READ WRITE CKSUM
    tank             DEGRADED     0     0     0
      raidz2-0       DEGRADED     0     0     0
        sda          ONLINE       0     0     0
        replacing-1  DEGRADED     0     0     0
          sdb        FAULTED      3     0    17
          sde        ONLINE       0     0     0
        sdc          ONLINE       0     0     0
        sdd          ONLINE       0     0     2

errors: No known data errors`;
  const { vdevs, scan, statusNote } = parsePoolStatus(status);
  assert.equal(vdevs.length, 1);
  assert.equal(vdevs[0]!.state, "DEGRADED");
  // The faulted disk and its error counts have to survive — this is the whole
  // reason an admin opens this screen.
  const faulted = vdevs[0]!.members.find((m) => m.name === "sdb");
  assert.ok(faulted, "the faulted disk was dropped");
  assert.equal(faulted.state, "FAULTED");
  assert.equal(faulted.errors.read, 3);
  assert.equal(faulted.errors.checksum, 17);
  const quiet = vdevs[0]!.members.find((m) => m.name === "sdd");
  assert.equal(quiet?.errors.checksum, 2);

  assert.ok(scan, "a resilver in progress was not reported");
  assert.equal(scan.kind, "resilver");
  assert.equal(scan.percent, 17.36);
  assert.match(statusNote, /being resilvered/);
});

test("a scrub in progress is reported with its percentage", () => {
  const status = `  pool: tank
 state: ONLINE
  scan: scrub in progress since Sun Sep  6 05:00:00 2026
        820G scanned at 1.1G/s, 400G issued at 530M/s, 3.60T total
        0B repaired, 10.85% done, 01:44:02 to go
config:

    NAME        STATE     READ WRITE CKSUM
    tank        ONLINE       0     0     0
      mirror-0  ONLINE       0     0     0
        sda     ONLINE       0     0     0
        sdb     ONLINE       0     0     0

errors: No known data errors`;
  const { scan, vdevs } = parsePoolStatus(status);
  assert.equal(scan?.kind, "scrub");
  assert.equal(scan?.percent, 10.85);
  assert.equal(vdevs[0]!.type, "mirror");
});

test("several vdevs in one pool each keep their own members", () => {
  const status = `  pool: tank
 state: ONLINE
  scan: none requested
config:

    NAME        STATE     READ WRITE CKSUM
    tank        ONLINE       0     0     0
      mirror-0  ONLINE       0     0     0
        sda     ONLINE       0     0     0
        sdb     ONLINE       0     0     0
      mirror-1  ONLINE       0     0     0
        sdc     ONLINE       0     0     0
        sdd     ONLINE       0     0     0

errors: No known data errors`;
  const { vdevs } = parsePoolStatus(status);
  assert.equal(vdevs.length, 2);
  assert.deepEqual(vdevs.map((v) => v.name), ["mirror-0", "mirror-1"]);
  assert.deepEqual(vdevs[0]!.members.map((m) => m.name), ["sda", "sdb"]);
  assert.deepEqual(vdevs[1]!.members.map((m) => m.name), ["sdc", "sdd"]);
});

test("a stripe's bare disks are not lost for want of a vdev row", () => {
  // ZFS prints no grouping row for a stripe, so a parser that only collects
  // members under a vdev header would show an empty pool.
  const status = `  pool: fast
 state: ONLINE
  scan: none requested
config:

    NAME        STATE     READ WRITE CKSUM
    fast        ONLINE       0     0     0
      nvme0n1   ONLINE       0     0     0
      nvme1n1   ONLINE       0     0     0

errors: No known data errors`;
  const { vdevs } = parsePoolStatus(status);
  assert.equal(vdevs.length, 1);
  assert.equal(vdevs[0]!.type, "stripe");
  assert.deepEqual(vdevs[0]!.members.map((m) => m.name), ["nvme0n1", "nvme1n1"]);
});

test("a pool with real data errors passes ZFS's own words through", () => {
  const status = `  pool: tank
 state: ONLINE
status: One or more devices has experienced an error resulting in data
        corruption.  Applications may be affected.
action: Restore the file in question if possible.  Otherwise restore the
        entire pool from backup.
   see: https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-8A
  scan: scrub repaired 0B in 00:00:04 with 2 errors on Sun Sep  6 06:00:00 2026
config:

    NAME        STATE     READ WRITE CKSUM
    tank        ONLINE       0     0     4
      raidz1-0  ONLINE       0     0     8
        sda     ONLINE       0     0     4
        sdb     ONLINE       0     0     4
        sdc     ONLINE       0     0     0

errors: 2 data errors, use '-v' for a list`;
  const { statusNote, vdevs } = parsePoolStatus(status);
  // Never paraphrased: if ZFS says applications may be affected, so do we.
  assert.match(statusNote, /data\s+corruption/);
  assert.equal(vdevs[0]!.members[0]!.errors.checksum, 4);
});

test("parsePoolStatus never throws on rubbish", () => {
  for (const input of ["", "\n\n", "no pools available", "config:\n", "   pool: x", " \t\t"]) {
    const r = parsePoolStatus(input);
    assert.ok(Array.isArray(r.vdevs), `threw or returned junk for ${JSON.stringify(input)}`);
  }
});

test("dataset list parses bytes and quotas", () => {
  const out = [
    "tank\t1234567890\t7999328654126\t0\t/var/lib/opennas/volumes/tank\tlz4",
    "tank/photos\t900000000\t7999328654126\t10737418240\t/var/lib/opennas/volumes/tank/photos\tlz4",
  ].join("\n");
  const ds = parseDatasetList(out);
  assert.equal(ds.length, 2);
  assert.equal(ds[1]!.name, "tank/photos");
  assert.equal(ds[1]!.quotaBytes, 10737418240);
  // 0 means no quota, which is exactly what ZFS reports for an unset one.
  assert.equal(ds[0]!.quotaBytes, 0);
  assert.equal(ds[1]!.compression, "lz4");
});

test("snapshot list splits the dataset from the snapshot name", () => {
  const out = [
    "tank/photos@daily-2026-09-06\t65536\t1757116800\t900000000",
    "tank/photos@before-import\t131072\t1757030400\t880000000",
  ].join("\n");
  const snaps = parseSnapshotList(out);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0]!.dataset, "tank/photos");
  assert.equal(snaps[0]!.snapshot, "daily-2026-09-06");
  assert.equal(snaps[0]!.usedBytes, 65536);
  assert.equal(new Date(snaps[0]!.createdAt).getTime(), 1757116800 * 1000);
  // A line with no "@" isn't a snapshot and must not become one.
  assert.deepEqual(parseSnapshotList("tank/photos\t1\t2\t3"), []);
});

test("importable pools are read from zpool import's prose", () => {
  const out = `   pool: tank
     id: 1234567890123456789
  state: ONLINE
 action: The pool can be imported using its name or numeric identifier.
 config:

\ttank        ONLINE
\t  raidz1-0  ONLINE

   pool: oldbackup
     id: 9876543210987654321
  state: ONLINE
 action: The pool can be imported using its name or numeric identifier.`;
  assert.deepEqual(parseImportable(out), ["tank", "oldbackup"]);
  assert.deepEqual(parseImportable("no pools available to import"), []);
  assert.deepEqual(parseImportable(""), []);
});

test("the layouts say what they cost and what they survive", () => {
  // The UI renders these verbatim, so a wrong minimum here is a pool the helper
  // refuses to create after the admin has already picked disks.
  assert.deepEqual(
    ZFS_LAYOUTS.map((l) => [l.id, l.minDisks, l.faultTolerance]),
    [
      ["mirror", 2, 1],
      ["raidz1", 3, 1],
      ["raidz2", 4, 2],
      ["raidz3", 5, 3],
      ["stripe", 1, 0],
    ],
  );
  assert.equal(layoutInfo("raidz2")?.minDisks, 4);
  assert.equal(layoutInfo("raid5"), null);
  for (const l of ZFS_LAYOUTS) assert.notEqual(l.note.trim(), "", `${l.id} has no explanation`);
});

test("the stripe layout is honest about having no redundancy", () => {
  const stripe = layoutInfo("stripe")!;
  assert.equal(stripe.faultTolerance, 0);
  assert.match(stripe.note, /no redundancy/i);
});

test("the exact output a real pool produces is parsed correctly", () => {
  // Captured verbatim from `zpool status` on OpenZFS 2.2.11 in a VM, tabs and
  // all. It replaces nothing above — it is here because every other fixture in
  // this file is something a person typed, and this one is not. The tab
  // indentation in particular is what broke the first version of the parser.
  const real =
    "  pool: tank\n" +
    " state: ONLINE\n" +
    "config:\n" +
    "\n" +
    "\tNAME        STATE     READ WRITE CKSUM\n" +
    "\ttank        ONLINE       0     0     0\n" +
    "\t  raidz2-0  ONLINE       0     0     0\n" +
    "\t    vdc     ONLINE       0     0     0\n" +
    "\t    vdd     ONLINE       0     0     0\n" +
    "\t    vde     ONLINE       0     0     0\n" +
    "\t    vdf     ONLINE       0     0     0\n" +
    "\t    vdg     ONLINE       0     0     0\n" +
    "\n" +
    "errors: No known data errors\n";
  const { vdevs, scan, statusNote } = parsePoolStatus(real);
  assert.equal(vdevs.length, 1, "the pool row was mistaken for a disk");
  assert.equal(vdevs[0]!.name, "raidz2-0");
  assert.equal(vdevs[0]!.type, "raidz2");
  assert.deepEqual(vdevs[0]!.members.map((m) => m.name), ["vdc", "vdd", "vde", "vdf", "vdg"]);
  for (const m of vdevs[0]!.members) assert.equal(m.state, "ONLINE");
  // A pool that has never been scrubbed prints no `scan:` line at all.
  assert.equal(scan, null);
  assert.equal(statusNote, "No known data errors");
});

test("the exact output of a real `zpool import` is parsed correctly", () => {
  // Also captured from the VM. The config block is indented with tabs and the
  // pool name appears twice — once in the "pool:" header and once in the tree —
  // so a looser parser would report it twice.
  const real =
    "   pool: tank\n" +
    "     id: 3610809148582029839\n" +
    "  state: ONLINE\n" +
    " action: The pool can be imported using its name or numeric identifier.\n" +
    " config:\n" +
    "\n" +
    "\ttank        ONLINE\n" +
    "\t  raidz2-0  ONLINE\n" +
    "\t    vdc     ONLINE\n" +
    "\t    vdd     ONLINE\n";
  assert.deepEqual(parseImportable(real), ["tank"]);
});
