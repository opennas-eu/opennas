import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECOY_BAN_SECONDS,
  describePath,
  honeypotConfig,
  honeypotEnabled,
  isDecoyPath,
  isExemptFromTrap,
  setHoneypotEnabled,
} from "../../apps/api/src/system/honeypot.js";

/**
 * The decoy trap.
 *
 * This is a feature that blocks people on a single request, so the tests that
 * matter are the ones about it *not* firing. A false positive here doesn't
 * degrade the NAS, it locks someone out of it - and the list is only defensible
 * because every entry is a path where that cannot happen.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the decoys fire", () => {
  for (const path of [
    "/wp-login.php",
    "/WP-LOGIN.PHP",
    "/xmlrpc.php",
    "/.env",
    "/.git/config",
    "/.git/HEAD",
    "/phpmyadmin",
    "/phpmyadmin/index.php",
    "/admin.php",
    "/cgi-bin/luci",
    "/cgi-bin/anything/at/all",
    "/wp-content/plugins/x/y.php",
    "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php",
    "/.aws/credentials",
    "/wp-login.php?redirect_to=%2F",
    "/wp-login.php#anchor",
  ]) {
    assert.ok(isDecoyPath(path), `missed ${path}`);
  }
});

test("nothing OpenNAS actually serves is a decoy", () => {
  // The list that would end an admin's evening.
  for (const path of [
    "/",
    "/index.html",
    "/favicon.ico",
    "/robots.txt",
    "/manifest.webmanifest",
    "/assets/index-abc123.js",
    "/assets/index-abc123.css",
    "/api/health",
    "/api/auth/login",
    "/api/files/raw?path=/x",
    "/api/admin/firewall/bans",
    "/app-sdk/opennas.js",
    "/apps/some-app/index.html",
    "/themes/dark/wallpaper.jpg",
    "/share/abcd1234",
    "/files",
    "/settings",
    "/control-panel",
    "/oidc/auth",
    "/.well-known/openid-configuration",
    "",
  ]) {
    assert.equal(isDecoyPath(path), false, `would ban a request for ${JSON.stringify(path)}`);
  }
});

test("the ACME challenge path is never a decoy", () => {
  // Banning Let's Encrypt would take the machine's certificate with it, and the
  // symptom would arrive sixty days later as an expired cert nobody can renew.
  for (const path of [
    "/.well-known/acme-challenge/tokenvalue",
    "/.well-known/acme-challenge/",
    "/.well-known/",
  ]) {
    assert.equal(isDecoyPath(path), false, `would ban ACME at ${path}`);
  }
});

test("no decoy path collides with a route the server registers", () => {
  // Guards the list against the failure no amount of care prevents: someone adds
  // a real route later whose path is already a trap. This reads the actual route
  // registrations rather than a remembered list of them.
  const registered = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(/\.(?:get|post|put|delete|patch|all)\(\s*"([^"]+)"/g)) {
        registered.add(m[1]!);
      }
      for (const m of src.matchAll(/prefix:\s*"([^"]+)"/g)) registered.add(m[1]!);
    }
  };
  walk(join(repoRoot, "apps", "api", "src"));
  assert.ok(registered.size > 30, `only found ${registered.size} routes - is the scan working?`);

  for (const route of registered) {
    // Routes are registered relative to a prefix, so check the bare path and the
    // /api one everything in this app hangs off.
    for (const candidate of [route, `/api${route}`]) {
      assert.equal(
        isDecoyPath(candidate),
        false,
        `route ${route} is also a decoy path - a real request would be banned`,
      );
    }
  }
});

test("a decoy hit is worth an hour, the same as a failed-login ban", () => {
  assert.equal(DECOY_BAN_SECONDS, 60 * 60);
  assert.equal(honeypotConfig().banSeconds, DECOY_BAN_SECONDS);
});

test("the examples shown in the UI are really decoys", () => {
  // The panel presents these to an admin as "this is what triggers it". If one
  // of them didn't, the screen would be lying about what the feature does.
  const { examples } = honeypotConfig();
  for (const example of examples) {
    assert.ok(isDecoyPath(example), `the UI advertises ${example}, which is not a decoy`);
  }
  assert.ok(examples.length >= 3);
});

test("it is on by default and the toggle sticks", () => {
  assert.equal(honeypotEnabled(), true);
  setHoneypotEnabled(false);
  assert.equal(honeypotEnabled(), false);
  assert.equal(honeypotConfig().enabled, false);
  setHoneypotEnabled(true);
  assert.equal(honeypotEnabled(), true);
});

test("the recorded path can't carry control characters into the log or the UI", () => {
  // It came off the request line, and it ends up in the database and then in a
  // table an admin reads.
  const nl = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  const tab = String.fromCharCode(9);
  const nul = String.fromCharCode(0);
  assert.equal(describePath(`/wp-login.php${nl}GET /evil`), "/wp-login.phpGET /evil");
  assert.equal(describePath(`/x${cr}${nl}${tab}${nul}`), "/x");
  assert.equal(describePath("/" + "a".repeat(500)).length, 120);
  // Ordinary characters survive, so the entry still says something useful.
  assert.equal(describePath("/phpmyadmin/index.php?x=1"), "/phpmyadmin/index.php?x=1");
});

test("the trap can never fire at your own network", () => {
  // The failure that would actually matter: a one-strike ban aimed at the
  // household. trustedNetworks is empty on a fresh install, so the private
  // ranges cannot be left to it.
  for (const address of [
    "127.0.0.1",
    "::1",
    "192.168.1.50",
    "192.168.255.255",
    "10.0.0.5",
    "10.255.255.254",
    "172.16.0.9",
    "172.31.255.1",
    "169.254.10.1",
    "100.64.0.1",
    "fe80::1",
    "fd00::1234",
    "fc00::1",
  ]) {
    assert.equal(isExemptFromTrap(address, []), true, `would trap ${address} on a fresh install`);
  }
});

test("the trap does fire at the internet", () => {
  for (const address of ["203.0.113.99", "198.51.100.7", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1"]) {
    assert.equal(isExemptFromTrap(address, []), false, `${address} should be trappable`);
  }
});

test("configured trusted networks are exempt on top of the built-in ones", () => {
  assert.equal(isExemptFromTrap("203.0.113.99", ["203.0.113.0/24"]), true);
  assert.equal(isExemptFromTrap("203.0.113.99", ["198.51.100.0/24"]), false);
});
