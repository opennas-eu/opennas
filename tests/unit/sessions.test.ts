import "../helpers/env.js";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../helpers/env.js";
import { db } from "../../apps/api/src/db/index.js";
import {
  createSession,
  deleteSession,
  getValidSession,
  listForUser,
} from "../../apps/api/src/db/sessions.js";
import { hashToken } from "../../apps/api/src/db/secrets.js";
import { makeUser } from "../helpers/users.js";

const user = makeUser();
const other = makeUser();

/**
 * Sessions.
 *
 * The property being defended is a narrow one and easy to regress: the value in
 * the cookie must never appear in the database. It used to, which made a
 * readable database file a bag of working logins - no password, no second
 * factor. A future refactor that "simplifies" createSession by storing `token`
 * would restore that silently, and this is what would notice.
 */

test("the cookie value is not what gets stored", () => {
  const s = createSession(user, ["password"]);
  assert.ok(s.token.length >= 40, "the token should be 32 bytes of randomness");
  assert.notEqual(s.token, s.id);
  assert.equal(s.id, hashToken(s.token));

  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(s.id) as { id: string };
  assert.equal(row.id, s.id);
  assert.ok(!row.id.includes(s.token));
  deleteSession(s.id);
});

test("no column anywhere in the row holds the raw token", () => {
  const s = createSession(user, ["password", "totp"]);
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(s.id) as Record<string, unknown>;
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === "string") {
      assert.ok(!value.includes(s.token), `column ${column} contains the raw token`);
    }
  }
  deleteSession(s.id);
});

test("the raw token is absent from the database file on disk", () => {
  // The strongest form of the check: not "the column we thought of", but the
  // bytes. This is the same technique that caught plaintext lingering in free
  // pages after the secrets migration.
  const s = createSession(user, ["password"]);
  db.pragma("wal_checkpoint(TRUNCATE)");
  const file = readFileSync(join(dataDir, "opennas.sqlite"));
  assert.equal(file.includes(Buffer.from(s.token, "utf8")), false, "the session token is in the database file");
  deleteSession(s.id);
});

test("a session is found by its raw token and not by its stored id", () => {
  const s = createSession(user, ["password"]);
  const found = getValidSession(s.token);
  assert.equal(found?.id, s.id);
  assert.equal(found?.userId, user);
  // Presenting the stored form must not work - otherwise a leaked database row
  // would still be a usable cookie.
  assert.equal(getValidSession(s.id), null);
  deleteSession(s.id);
});

test("unknown, empty and near-miss tokens resolve to nothing", () => {
  const s = createSession(user, ["password"]);
  assert.equal(getValidSession(""), null);
  assert.equal(getValidSession("nonsense"), null);
  assert.equal(getValidSession(s.token + "a"), null);
  assert.equal(getValidSession(s.token.slice(0, -1)), null);
  deleteSession(s.id);
});

test("an expired session is refused and swept", () => {
  const s = createSession(user, ["password"]);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    s.id,
  );
  assert.equal(getValidSession(s.token), null);
  // Refusing is not enough - the row should be gone, so an expired session
  // can't accumulate forever in the table.
  const { c } = db.prepare("SELECT COUNT(*) c FROM sessions WHERE id = ?").get(s.id) as { c: number };
  assert.equal(c, 0);
});

test("two sessions never collide", () => {
  const seen = new Set<string>();
  const made: string[] = [];
  for (let i = 0; i < 200; i++) {
    const s = createSession(other, ["password"]);
    assert.ok(!seen.has(s.token), "a token repeated");
    assert.ok(!seen.has(s.id), "a stored id repeated");
    seen.add(s.token);
    seen.add(s.id);
    made.push(s.id);
  }
  assert.equal(listForUser(other).length, 200);
  for (const id of made) deleteSession(id);
  assert.equal(listForUser(other).length, 0);
});

test("the auth methods survive the round trip", () => {
  const s = createSession(user, ["password", "totp"], { userAgent: "probe/1", ip: "203.0.113.9" });
  const found = getValidSession(s.token);
  assert.deepEqual(found?.authMethods, ["password", "totp"]);
  const detail = listForUser(user)[0];
  assert.equal(detail?.userAgent, "probe/1");
  assert.equal(detail?.ip, "203.0.113.9");
  deleteSession(s.id);
});
