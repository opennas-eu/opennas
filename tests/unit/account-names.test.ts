import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isManageableAccountName, isReservedAccountName } from "../../apps/api/src/system/integration.js";

/**
 * Which names the backend will mirror into system accounts and groups.
 *
 * The helper is what enforces this; the backend's copy exists so that creating
 * an OpenNAS group called `wheel` is refused with a message instead of being
 * mirrored onto - and reconciling the members of - the real one.
 */

test("system names are never manageable, in any case", () => {
  for (const name of ["root", "wheel", "Wheel", "docker", "libvirt", "kvm", "disk", "shadow", "adm", "opennas", "nobody", "sshd"]) {
    assert.ok(isReservedAccountName(name), `${name} is not reserved`);
    assert.ok(!isManageableAccountName(name), `${name} is manageable`);
  }
});

test("ordinary names are, and option-looking or odd ones are not", () => {
  for (const ok of ["alice", "editors", "admin", "team_2", "j.doe"]) assert.ok(isManageableAccountName(ok), ok);
  for (const bad of ["-rf", ".hidden", "", "a b", "x".repeat(33), "a/b", "a:b"]) assert.ok(!isManageableAccountName(bad), bad);
});

test("the backend's list matches the helper's", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const helper = readFileSync(join(repoRoot, "packaging", "opennas-sysctl"), "utf8");
  const block = helper.match(/^RESERVED="([^"]*)"/m);
  assert.ok(block, "could not find RESERVED in opennas-sysctl");
  const names = block[1]!.split(/\s+/).filter(Boolean);
  assert.ok(names.length > 40);
  for (const n of names) assert.ok(isReservedAccountName(n), `${n} is reserved by the helper but not the backend`);
});
