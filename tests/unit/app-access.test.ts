import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import { makeUser } from "../helpers/users.js";
import {
  ALWAYS_AVAILABLE,
  allowedAppIds,
  canUseApp,
  forgetApp,
  isAppsRestricted,
  setAppAccess,
} from "../../apps/api/src/db/app-access.js";

/**
 * The per-user app allow-list.
 *
 * Two properties carry the whole feature. The first is that it defaults to off,
 * so every account that existed before it did keeps working unchanged. The
 * second is that an admin can never be caught by it - an admin restricted out of
 * Control Panel has no way back in from the web interface, and on a headless NAS
 * that means finding a keyboard.
 */

const admin = { id: makeUser("admin"), role: "admin" as const };
const user = { id: makeUser("user"), role: "user" as const };
const other = { id: makeUser("user"), role: "user" as const };

test("an unrestricted account may use anything", () => {
  assert.equal(isAppsRestricted(user.id), false);
  for (const app of ["dashboard", "file-station", "notes", "anything-at-all"]) {
    assert.equal(canUseApp(user, app), true, `blocked ${app} with no restriction set`);
  }
});

test("a restricted account may use only what it was given", () => {
  setAppAccess(user.id, { restricted: true, appIds: ["dashboard", "file-station"] });
  assert.equal(isAppsRestricted(user.id), true);
  assert.equal(canUseApp(user, "dashboard"), true);
  assert.equal(canUseApp(user, "file-station"), true);
  assert.equal(canUseApp(user, "notes"), false);
  assert.equal(canUseApp(user, "system-monitor"), false);
});

test("restricting one account does not touch another", () => {
  assert.equal(isAppsRestricted(other.id), false);
  assert.equal(canUseApp(other, "notes"), true);
});

test("an admin is never restricted, whatever the table says", () => {
  // The route refuses to set this, but the check is here too: a route added
  // later that forgets would otherwise be able to strand an administrator.
  setAppAccess(admin.id, { restricted: true, appIds: [] });
  for (const app of ["dashboard", "notes", "package-center", "control-panel"]) {
    assert.equal(canUseApp(admin, app), true, `an admin was refused ${app}`);
  }
  setAppAccess(admin.id, { restricted: false, appIds: [] });
});

test("Control Panel and About survive an empty allow-list", () => {
  // A user who can't reach Control Panel can't change their own password or
  // enrol a passkey - an account that cannot secure itself.
  setAppAccess(user.id, { restricted: true, appIds: [] });
  assert.equal(canUseApp(user, "control-panel"), true);
  assert.equal(canUseApp(user, "about"), true);
  assert.equal(canUseApp(user, "dashboard"), false);
  for (const id of ALWAYS_AVAILABLE) assert.equal(canUseApp(user, id), true);
});

test("the always-available apps are not stored as grants", () => {
  // A row for one would suggest an admin could remove it by unticking a box.
  setAppAccess(user.id, { restricted: true, appIds: ["dashboard", "control-panel", "about"] });
  assert.deepEqual(allowedAppIds(user.id), ["dashboard"]);
  assert.equal(canUseApp(user, "control-panel"), true);
});

test("saving replaces the list rather than adding to it", () => {
  setAppAccess(user.id, { restricted: true, appIds: ["dashboard", "notes"] });
  assert.deepEqual(allowedAppIds(user.id), ["dashboard", "notes"]);
  setAppAccess(user.id, { restricted: true, appIds: ["file-station"] });
  assert.deepEqual(allowedAppIds(user.id), ["file-station"]);
  assert.equal(canUseApp(user, "dashboard"), false);
});

test("duplicates in the input collapse", () => {
  setAppAccess(user.id, { restricted: true, appIds: ["notes", "notes", "notes"] });
  assert.deepEqual(allowedAppIds(user.id), ["notes"]);
});

test("turning the restriction off restores everything at once", () => {
  setAppAccess(user.id, { restricted: true, appIds: ["dashboard"] });
  assert.equal(canUseApp(user, "notes"), false);
  setAppAccess(user.id, { restricted: false, appIds: [] });
  assert.equal(canUseApp(user, "notes"), true);
  assert.equal(canUseApp(user, "dashboard"), true);
});

test("the list is remembered while the restriction is off", () => {
  // So an admin can switch it off to debug something and switch it back without
  // rebuilding the list from memory.
  setAppAccess(user.id, { restricted: false, appIds: ["dashboard", "notes"] });
  assert.deepEqual(allowedAppIds(user.id), ["dashboard", "notes"]);
  assert.equal(canUseApp(user, "notes"), true, "the list must not apply while off");
  setAppAccess(user.id, { restricted: true, appIds: allowedAppIds(user.id) });
  assert.equal(canUseApp(user, "notes"), true);
  assert.equal(canUseApp(user, "file-station"), false);
});

test("uninstalling an app forgets who was allowed it", () => {
  // Otherwise reinstalling later would silently restore access to people an
  // admin has since excluded.
  setAppAccess(user.id, { restricted: true, appIds: ["dashboard", "some-app"] });
  assert.equal(canUseApp(user, "some-app"), true);
  forgetApp("some-app");
  assert.equal(canUseApp(user, "some-app"), false);
  assert.deepEqual(allowedAppIds(user.id), ["dashboard"]);
});
