import "../helpers/env.js";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../helpers/env.js";
import { buildServer } from "../../apps/api/src/server.js";
import { createSession } from "../../apps/api/src/db/sessions.js";
import { createUser } from "../../apps/api/src/db/users.js";
import { saveDevApps } from "../../apps/api/src/apps/dev-apps.js";
import { createShare } from "../../apps/api/src/db/shares.js";
import { grantPath } from "../../apps/api/src/db/app-grants.js";
import { resolveSafe } from "../../apps/api/src/files/paths.js";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Binary and large files through the app SDK, against the real server.
 *
 * Built in-process with `buildServer()` and driven with `inject`, so these are
 * the actual routes with the actual multipart parser and the actual path
 * resolution - the parts where a mistake is a file written outside a sandbox.
 *
 * The properties worth holding, in order of how much they'd cost to get wrong:
 *
 * 1. Bytes survive. A photo that comes back one byte different is worse than
 *    one that fails to come back at all, because nobody notices until later.
 * 2. Nothing escapes. Both the private sandbox and a share grant are path
 *    boundaries, and an upload is a *write* - the direction where a traversal
 *    stops being an information leak and starts being an overwrite.
 * 3. A failed upload doesn't destroy what was there. Uploads replace files, and
 *    a dropped connection halfway through must not leave a truncated file
 *    sitting where a good one used to be.
 */

// Inferred rather than imported from fastify: this directory is not a workspace
// package, so fastify's types live with the API and aren't on the resolution
// path here. The inferred type is the same one and costs nothing.
let app: Awaited<ReturnType<typeof buildServer>>;
let cookie: string;
let userId: string;
const APP_ID = "test-bin-app";

/** Multipart body for one file, built by hand - no dependency, no ambiguity. */
function multipart(filename: string, content: Buffer): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----opennas${randomBytes(8).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, content, tail]),
  };
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

before(async () => {
  app = await buildServer();
  const user = createUser({ username: `bin-${process.pid}`, displayName: "Bin", role: "admin" });
  userId = user.id;
  const session = createSession(user.id, ["password"]);
  // The cookie is signed, so it has to be minted the way a real sign-in would.
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  const signed = app.signCookie ? app.signCookie(session.token) : session.token;
  cookie = `opennas_session=${signed}`;

  // A development app is the quickest way to a real app with real permissions:
  // it goes through the same manifest and the same permission checks as a
  // packaged one, and needs no signed package to build first.
  saveDevApps([
    {
      id: APP_ID,
      name: "Bin Test",
      url: "http://127.0.0.1:9/",
      permissions: ["files", "shares:read", "shares:write"],
      enabled: true,
    },
  ]);
});

after(async () => {
  saveDevApps([]);
  await app?.close();
});

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url, headers: { cookie, ...headers } });
}

function upload(url: string, filename: string, content: Buffer) {
  const { headers, payload } = multipart(filename, content);
  return app.inject({ method: "POST", url, headers: { cookie, ...headers }, payload });
}

test("a binary file survives a round trip byte for byte", async () => {
  // Random bytes rather than text: an encoding bug that mangles high bytes or
  // stops at a NUL would sail past anything printable.
  const original = randomBytes(3 * 1024 * 1024);
  const up = await upload(`/api/apps/${APP_ID}/files/upload?path=media/photo.bin`, "photo.bin", original);
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(JSON.parse(up.body).bytes, original.length);

  const down = await get(`/api/apps/${APP_ID}/files/raw?path=media/photo.bin`);
  assert.equal(down.statusCode, 200);
  assert.equal(down.rawPayload.length, original.length);
  assert.equal(sha(down.rawPayload), sha(original), "the bytes came back different");
});

test("every byte value survives, including NUL and 0xff", async () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await upload(`/api/apps/${APP_ID}/files/upload?path=bytes.bin`, "bytes.bin", all);
  const down = await get(`/api/apps/${APP_ID}/files/raw?path=bytes.bin`);
  assert.deepEqual([...down.rawPayload], [...all]);
});

test("the download is served as something to store, never to render", async () => {
  // These bytes come from an app and are served from the OpenNAS origin. An app
  // that could get an HTML file rendered there rather than downloaded would have
  // stepped out of its sandbox.
  await upload(`/api/apps/${APP_ID}/files/upload?path=page.html`, "page.html", Buffer.from("<script>alert(1)</script>"));
  const res = await get(`/api/apps/${APP_ID}/files/raw?path=page.html`);
  assert.match(res.headers["content-disposition"] as string, /^attachment;/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["content-security-policy"] as string, /sandbox/);
  assert.match(res.headers["content-security-policy"] as string, /default-src 'none'/);
});

test("range requests work, so an app can seek in a video", async () => {
  const data = randomBytes(64 * 1024);
  await upload(`/api/apps/${APP_ID}/files/upload?path=clip.bin`, "clip.bin", data);

  const res = await get(`/api/apps/${APP_ID}/files/raw?path=clip.bin`, { range: "bytes=1000-1099" });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], `bytes 1000-1099/${data.length}`);
  assert.deepEqual([...res.rawPayload], [...data.subarray(1000, 1100)]);

  // A suffix range - the last N bytes - which is what a player asks for when it
  // wants a trailing index.
  const tail = await get(`/api/apps/${APP_ID}/files/raw?path=clip.bin`, { range: "bytes=-50" });
  assert.equal(tail.statusCode, 206);
  assert.deepEqual([...tail.rawPayload], [...data.subarray(data.length - 50)]);

  // And one that asks past the end.
  const bad = await get(`/api/apps/${APP_ID}/files/raw?path=clip.bin`, { range: `bytes=${data.length + 10}-` });
  assert.equal(bad.statusCode, 416);
});

test("an upload cannot climb out of the app's own folder", async () => {
  // A traversal on a *write* is an overwrite, not a leak, so this is the
  // direction that matters most.
  const before = randomBytes(64);
  await upload(`/api/apps/${APP_ID}/files/upload?path=keep.bin`, "keep.bin", before);

  for (const path of ["../../escape.bin", "../../../../etc/opennas-escape", "/..%2f..%2fescape.bin"]) {
    const res = await upload(
      `/api/apps/${APP_ID}/files/upload?path=${encodeURIComponent(path)}`,
      "x.bin",
      randomBytes(32),
    );
    // Either refused, or clamped back inside - never written outside.
    assert.ok(res.statusCode === 200 || res.statusCode >= 400, `unexpected ${res.statusCode}`);
  }

  // The app's own tree is under app-data/<id>/<user>/; nothing may appear above it.
  const appData = join(dataDir, "app-data");
  const strays = readdirSync(appData, { withFileTypes: true }).filter((d) => d.isFile());
  assert.deepEqual(strays.map((d) => d.name), [], "a file was written above the app's folder");
  assert.ok(!existsSync(join(dataDir, "escape.bin")));
  assert.ok(!existsSync("/etc/opennas-escape"));
});

test("a read cannot climb out either", async () => {
  for (const path of ["../../../../etc/passwd", "/etc/passwd", "..%2f..%2f..%2fetc%2fpasswd"]) {
    const res = await get(`/api/apps/${APP_ID}/files/raw?path=${encodeURIComponent(path)}`);
    assert.ok(res.statusCode >= 400, `${path} returned ${res.statusCode}`);
    assert.ok(!res.body.includes("root:"), `${path} leaked /etc/passwd`);
  }
});

test("an app that didn't ask for file access is refused", async () => {
  saveDevApps([
    { id: APP_ID, name: "Bin Test", url: "http://127.0.0.1:9/", permissions: ["files", "shares:read", "shares:write"], enabled: true },
    { id: "no-perms-app", name: "No Perms", url: "http://127.0.0.1:9/", permissions: [], enabled: true },
  ]);
  const read = await get(`/api/apps/no-perms-app/files/raw?path=x.bin`);
  assert.equal(read.statusCode, 403);
  const write = await upload(`/api/apps/no-perms-app/files/upload?path=x.bin`, "x.bin", randomBytes(16));
  assert.equal(write.statusCode, 403);
});

test("an app that isn't installed at all is refused", async () => {
  const read = await get(`/api/apps/not-a-real-app/files/raw?path=x.bin`);
  assert.equal(read.statusCode, 404);
  const write = await upload(`/api/apps/not-a-real-app/files/upload?path=x.bin`, "x.bin", randomBytes(16));
  assert.equal(write.statusCode, 404);
});

test("nobody signed out can read or write bytes", async () => {
  const read = await app.inject({ method: "GET", url: `/api/apps/${APP_ID}/files/raw?path=bytes.bin` });
  assert.equal(read.statusCode, 401);
  const { headers, payload } = multipart("x.bin", randomBytes(16));
  const write = await app.inject({
    method: "POST",
    url: `/api/apps/${APP_ID}/files/upload?path=x.bin`,
    headers,
    payload,
  });
  assert.equal(write.statusCode, 401);
});

test("a missing file reads as 404 rather than as empty bytes", async () => {
  const res = await get(`/api/apps/${APP_ID}/files/raw?path=nothing/here.bin`);
  assert.equal(res.statusCode, 404);
});

test("a folder is not a file", async () => {
  await upload(`/api/apps/${APP_ID}/files/upload?path=adir/inside.bin`, "inside.bin", randomBytes(16));
  const res = await get(`/api/apps/${APP_ID}/files/raw?path=adir`);
  assert.equal(res.statusCode, 404);
});

test("an upload with no file attached is a clean 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/apps/${APP_ID}/files/upload?path=x.bin`,
    headers: { cookie, "content-type": "multipart/form-data; boundary=----empty" },
    payload: Buffer.from("------empty--\r\n"),
  });
  assert.equal(res.statusCode, 400);
});

test("uploading over a file replaces it, and leaves no temp behind", async () => {
  const first = randomBytes(1024);
  const second = randomBytes(2048);
  await upload(`/api/apps/${APP_ID}/files/upload?path=replace.bin`, "replace.bin", first);
  await upload(`/api/apps/${APP_ID}/files/upload?path=replace.bin`, "replace.bin", second);

  const res = await get(`/api/apps/${APP_ID}/files/raw?path=replace.bin`);
  assert.equal(sha(res.rawPayload), sha(second));

  // The upload writes to a sibling and renames, so a `.part-` file surviving
  // would mean a path that never cleans up after itself.
  const dirs = readdirSync(join(dataDir, "app-data", APP_ID), { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const names = readdirSync(join(dataDir, "app-data", APP_ID, d.name));
    assert.deepEqual(names.filter((n) => n.includes(".part-")), [], "a partial upload was left behind");
  }
});

// ---- The user's real folders, through a grant --------------------------------
//
// The private sandbox above is the app's own corner of the data directory. These
// go to the user's actual shares - the files they'd lose - so the boundary being
// tested is the grant rather than a directory the app owns anyway.

test("bytes round-trip through a folder the user granted", async () => {
  const share = createShare({ name: `BinShare${process.pid}` });
  await mkdir(resolveSafe(`/${share.name}`), { recursive: true });
  const grant = grantPath(APP_ID, userId, `/${share.name}`, "dir", "readwrite");

  const original = randomBytes(1024 * 1024);
  const up = await upload(
    `/api/apps/${APP_ID}/shares/upload?handle=${grant.handle}&path=holiday.bin`,
    "holiday.bin",
    original,
  );
  assert.equal(up.statusCode, 200, up.body);

  const down = await get(`/api/apps/${APP_ID}/shares/raw?handle=${grant.handle}&path=holiday.bin`);
  assert.equal(down.statusCode, 200);
  assert.equal(sha(down.rawPayload), sha(original));

  // And it really is in the share, not somewhere the app owns.
  assert.ok(existsSync(resolveSafe(`/${share.name}/holiday.bin`)));
});

test("a read-only grant refuses an upload", async () => {
  const share = createShare({ name: `BinRO${process.pid}` });
  await mkdir(resolveSafe(`/${share.name}`), { recursive: true });
  const grant = grantPath(APP_ID, userId, `/${share.name}`, "dir", "read");

  const res = await upload(
    `/api/apps/${APP_ID}/shares/upload?handle=${grant.handle}&path=nope.bin`,
    "nope.bin",
    randomBytes(64),
  );
  assert.equal(res.statusCode, 403);
  assert.ok(!existsSync(resolveSafe(`/${share.name}/nope.bin`)));
});

test("a grant is a boundary - nothing lands outside the granted folder", async () => {
  // Note what this does *not* assert: that an out-of-grant path is refused.
  // With a handle, the path is joined onto the granted root and then
  // normalised, so `../x` and `/Elsewhere/x` both collapse to somewhere inside
  // the grant rather than being rejected. Surprising to read, but the property
  // that matters is the one checked here - the bytes never land outside - and
  // clamping fails in the safe direction where refusing-by-string-matching does
  // not.
  const inside = createShare({ name: `BinIn${process.pid}` });
  const outside = createShare({ name: `BinOut${process.pid}` });
  await mkdir(resolveSafe(`/${inside.name}`), { recursive: true });
  await mkdir(resolveSafe(`/${outside.name}`), { recursive: true });
  const grant = grantPath(APP_ID, userId, `/${inside.name}`, "dir", "readwrite");

  for (const path of [`../${outside.name}/stolen.bin`, "../../etc/passwd", `/${outside.name}/stolen.bin`]) {
    await upload(
      `/api/apps/${APP_ID}/shares/upload?handle=${grant.handle}&path=${encodeURIComponent(path)}`,
      "x.bin",
      randomBytes(32),
    );
    const read = await get(
      `/api/apps/${APP_ID}/shares/raw?handle=${grant.handle}&path=${encodeURIComponent(path)}`,
    );
    assert.ok(!read.body.includes("root:"), `${path} leaked /etc/passwd`);
  }

  assert.ok(!existsSync(resolveSafe(`/${outside.name}/stolen.bin`)), "an app wrote outside its grant");
  assert.deepEqual(readdirSync(resolveSafe(`/${outside.name}`)), [], "the other share was touched");
});

test("a grant-only app cannot address anything by absolute path", async () => {
  // The app above declares shares:read/shares:write, so an absolute path is
  // legitimately *its* to use - that is the broad permission the admin
  // approved. The interesting case is an app with no share permission at all,
  // holding one folder the user picked: for it, a path without a handle has to
  // be nothing at all.
  saveDevApps([
    { id: APP_ID, name: "Bin Test", url: "http://127.0.0.1:9/", permissions: ["files", "shares:read", "shares:write"], enabled: true },
    { id: "grant-only-app", name: "Grant Only", url: "http://127.0.0.1:9/", permissions: [], enabled: true },
  ]);
  const share = createShare({ name: `BinPick${process.pid}` });
  const secret = createShare({ name: `BinSecret${process.pid}` });
  await mkdir(resolveSafe(`/${share.name}`), { recursive: true });
  await mkdir(resolveSafe(`/${secret.name}`), { recursive: true });
  await writeFile(resolveSafe(`/${secret.name}/private.bin`), randomBytes(64));
  const grant = grantPath("grant-only-app", userId, `/${share.name}`, "dir", "readwrite");

  // Inside its grant: fine.
  const ok = await upload(
    `/api/apps/grant-only-app/shares/upload?handle=${grant.handle}&path=mine.bin`,
    "mine.bin",
    randomBytes(64),
  );
  assert.equal(ok.statusCode, 200, ok.body);

  // Without the handle, it has no share access whatsoever.
  const read = await get(`/api/apps/grant-only-app/shares/raw?path=/${secret.name}/private.bin`);
  assert.equal(read.statusCode, 403);
  const write = await upload(
    `/api/apps/grant-only-app/shares/upload?path=/${secret.name}/planted.bin`,
    "planted.bin",
    randomBytes(64),
  );
  assert.equal(write.statusCode, 403);
  assert.ok(!existsSync(resolveSafe(`/${secret.name}/planted.bin`)));
  assert.deepEqual(readdirSync(resolveSafe(`/${secret.name}`)), ["private.bin"]);
});

test("without a grant, an app with no shares permission gets nothing", async () => {
  saveDevApps([
    { id: APP_ID, name: "Bin Test", url: "http://127.0.0.1:9/", permissions: ["files", "shares:read", "shares:write"], enabled: true },
    { id: "no-shares-app", name: "No Shares", url: "http://127.0.0.1:9/", permissions: ["files"], enabled: true },
  ]);
  const res = await get(`/api/apps/no-shares-app/shares/raw?path=/anything.bin`);
  assert.equal(res.statusCode, 403);
});
