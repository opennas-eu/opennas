import "../helpers/env.js";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../apps/api/src/server.js";
import { createSession } from "../../apps/api/src/db/sessions.js";
import { createUser, updateUser } from "../../apps/api/src/db/users.js";
import { createShare, setPermissions } from "../../apps/api/src/db/shares.js";
import { deleteAcl, setAcl } from "../../apps/api/src/db/acls.js";
import { resolveSafe } from "../../apps/api/src/files/paths.js";

// fflate lives with the API; this directory is not a workspace package.
const { unzipSync } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("fflate") as {
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
};

/**
 * File Station operations that act on a whole tree, against folder rules.
 *
 * Each of these used to check the one path it was given and then act on
 * everything below it: a zip of a folder shipped the subfolder a rule had
 * closed, a move needed only *read* on what it moved, a delete took read-only
 * subfolders with it. The property is the same everywhere - an operation on a
 * folder is an operation on every item in it, and folder rules apply to each.
 *
 * Also here: symlinks inside a share (resolveSafe resolves them for real now,
 * and an upload won't write through one), and public links, which lend their
 * creator's access only for as long as the creator still has it.
 *
 * Layout, for a user with read-write on the share:
 *
 *   Team/
 *     proj/            rw (inherited)
 *       a.txt
 *       locked/        rule: ro
 *       hidden/        rule: none
 *     ro-dir/          rule: ro
 *       f.txt
 *     secret.zip       rule: none
 */

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie: string;
let userId: string;
let shareId: string;
const SHARE = `Team${process.pid}`;
let root: string;
let outside: string;

const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function multipart(filename: string, content: Buffer): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----opennas${randomBytes(8).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  };
}

function rebuild(): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "proj", "locked"), { recursive: true });
  mkdirSync(join(root, "proj", "hidden"), { recursive: true });
  mkdirSync(join(root, "ro-dir"), { recursive: true });
  writeFileSync(join(root, "proj", "a.txt"), "a");
  writeFileSync(join(root, "proj", "locked", "l.txt"), "l");
  writeFileSync(join(root, "proj", "hidden", "h.txt"), "HIDDEN");
  writeFileSync(join(root, "ro-dir", "f.txt"), "f");
  writeFileSync(join(root, "secret.zip"), "not really a zip");
}

before(async () => {
  app = await buildServer();
  await app.ready();
  const user = createUser({ username: `acl-${process.pid}`, displayName: "Acl", role: "user" });
  userId = user.id;
  cookie = `opennas_session=${app.signCookie(createSession(user.id, ["password"]).token)}`;

  shareId = createShare({ name: SHARE }).id;
  setPermissions(shareId, [{ userId, level: "rw" }]);
  root = resolveSafe(`/${SHARE}`);
  rebuild();
  for (const [path, level] of [
    ["proj/locked", "ro"],
    ["proj/hidden", "none"],
    ["ro-dir", "ro"],
    ["secret.zip", "none"],
  ] as const) {
    setAcl({ shareId, path, subjectType: "user", subjectId: userId, level });
  }
  outside = mkdtempSync(join(tmpdir(), "opennas-outside-"));
  writeFileSync(join(outside, "target.txt"), "outside");
});

after(async () => {
  await app?.close();
  rmSync(outside, { recursive: true, force: true });
});

test("moving a file out of a read-only folder is refused", async () => {
  rebuild();
  const res = await req("POST", "/api/files/move", { path: `/${SHARE}/ro-dir/f.txt`, toDir: `/${SHARE}` });
  assert.equal(res.statusCode, 403);
  assert.ok(existsSync(join(root, "ro-dir", "f.txt")));
});

test("moving or deleting a folder with a read-only subfolder is refused", async () => {
  rebuild();
  const mv = await req("POST", "/api/files/move", { path: `/${SHARE}/proj`, toDir: `/${SHARE}/ro-dir` });
  assert.equal(mv.statusCode, 403);
  mkdirSync(join(root, "dest"));
  const mv2 = await req("POST", "/api/files/move", { path: `/${SHARE}/proj`, toDir: `/${SHARE}/dest` });
  assert.equal(mv2.statusCode, 403);
  const del = await req("DELETE", `/api/files?path=${encodeURIComponent(`/${SHARE}/proj`)}&permanent=1`);
  assert.equal(del.statusCode, 403);
  const rn = await req("POST", "/api/files/rename", { path: `/${SHARE}/proj`, newName: "renamed" });
  assert.equal(rn.statusCode, 403);
  assert.ok(existsSync(join(root, "proj", "locked", "l.txt")));
});

test("an ordinary move still works", async () => {
  rebuild();
  const res = await req("POST", "/api/files/move", { path: `/${SHARE}/proj/a.txt`, toDir: `/${SHARE}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(existsSync(join(root, "a.txt")));
});

test("a folder zip leaves out the subfolder the user can't read", async () => {
  rebuild();
  const res = await req("GET", `/api/files/zip?path=${encodeURIComponent(`/${SHARE}/proj`)}`);
  assert.equal(res.statusCode, 200);
  const names = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
  assert.ok(names.includes("proj/a.txt"), names.join(","));
  assert.ok(names.includes("proj/locked/l.txt"), names.join(","));
  assert.ok(!names.some((n) => n.includes("hidden")), names.join(","));
});

test("compress refuses items the user can't read, and filters below the rest", async () => {
  rebuild();
  const denied = await req("POST", "/api/files/compress", { dir: `/${SHARE}`, names: ["secret.zip"], name: "x" });
  assert.equal(denied.statusCode, 403);
  const ok = await req("POST", "/api/files/compress", { dir: `/${SHARE}`, names: ["proj"], name: "p" });
  assert.equal(ok.statusCode, 200, ok.body);
  const names = Object.keys(unzipSync(new Uint8Array(readFileSync(join(root, "p.zip")))));
  assert.ok(!names.some((n) => n.includes("hidden")), names.join(","));
});

test("copy leaves the unreadable subfolder behind", async () => {
  rebuild();
  mkdirSync(join(root, "dest"));
  const res = await req("POST", "/api/files/copy", { path: `/${SHARE}/proj`, toDir: `/${SHARE}/dest` });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(existsSync(join(root, "dest", "proj", "a.txt")));
  assert.ok(!existsSync(join(root, "dest", "proj", "hidden")));
});

test("extracting needs read on the archive", async () => {
  rebuild();
  const res = await req("POST", "/api/files/extract", { path: `/${SHARE}/secret.zip` });
  assert.equal(res.statusCode, 403);
});

test("a symlink out of the share is not followed", async () => {
  rebuild();
  symlinkSync(outside, join(root, "escape"));
  const list = await req("GET", `/api/files/list?path=${encodeURIComponent(`/${SHARE}/escape`)}`);
  assert.equal(list.statusCode, 400);
  const dl = await req("GET", `/api/files/download?path=${encodeURIComponent(`/${SHARE}/escape/target.txt`)}`);
  assert.equal(dl.statusCode, 400);
  assert.ok(!dl.body.includes("outside"));
  // A dangling link is not "doesn't exist yet": writing through it creates its target.
  symlinkSync(join(outside, "new.txt"), join(root, "dangling.txt"));
  assert.throws(() => resolveSafe(`/${SHARE}/dangling.txt`));
  assert.throws(() => resolveSafe(`/${SHARE}/escape/new/deeper.txt`));
  assert.doesNotThrow(() => resolveSafe(`/${SHARE}/proj/not-yet/created.txt`));
});

test("an upload doesn't write through an existing symlink", async () => {
  rebuild();
  writeFileSync(join(root, "real.txt"), "original");
  symlinkSync(join(root, "real.txt"), join(root, "inlink.txt"));
  const { headers, payload } = multipart("inlink.txt", Buffer.from("overwritten"));
  const res = await app.inject({
    method: "POST",
    url: `/api/files/upload?path=${encodeURIComponent(`/${SHARE}`)}`,
    headers: { cookie, ...headers },
    payload,
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(readFileSync(join(root, "real.txt"), "utf8"), "original");

  symlinkSync(join(outside, "target.txt"), join(root, "outlink.txt"));
  const out = multipart("outlink.txt", Buffer.from("overwritten"));
  const res2 = await app.inject({
    method: "POST",
    url: `/api/files/upload?path=${encodeURIComponent(`/${SHARE}`)}`,
    headers: { cookie, ...out.headers },
    payload: out.payload,
  });
  assert.equal(res2.statusCode, 400, res2.body);
  assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside");
});

test("a public link lasts only as long as its creator's access", async () => {
  rebuild();
  const made = await req("POST", "/api/files/share-links", { path: `/${SHARE}/proj/a.txt` });
  assert.equal(made.statusCode, 200, made.body);
  const url = JSON.parse(made.body).link.url as string;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);

  updateUser(userId, { disabled: true });
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  updateUser(userId, { disabled: false });
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);

  const rule = setAcl({ shareId, path: "proj", subjectType: "user", subjectId: userId, level: "none" });
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  deleteAcl(shareId, rule.id);
});

test("a public folder link's zip follows its creator's folder rules", async () => {
  rebuild();
  const made = await req("POST", "/api/files/share-links", { path: `/${SHARE}/proj` });
  const url = JSON.parse(made.body).link.url as string;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200);
  const names = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
  assert.ok(names.includes("proj/a.txt"));
  assert.ok(!names.some((n) => n.includes("hidden")), names.join(","));
});
