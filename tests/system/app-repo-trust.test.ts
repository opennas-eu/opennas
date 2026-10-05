import "../helpers/env.js";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { buildServer } from "../../apps/api/src/server.js";
import { createSession } from "../../apps/api/src/db/sessions.js";
import { createUser } from "../../apps/api/src/db/users.js";
import { getInstalledApp } from "../../apps/api/src/db/installed-apps.js";
import { repoIdFor, saveRepos } from "../../apps/api/src/apps/repos.js";
import { setTrusted } from "../../apps/api/src/apps/trust.js";

const { zipSync } = createRequire(new URL("../../apps/api/package.json", import.meta.url))("fflate") as {
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array;
};

/**
 * Installing and updating from a repository, against a repository the test runs.
 *
 * The repository is not trusted - only the publishers whose keys the admin
 * trusted are. So:
 *
 * - an update signed by a *different* key, or not signed at all, waits for an
 *   admin even when it asks for no new permissions (trusting two publishers is
 *   not consent for one to take over the other's app);
 * - a download that turns out to be a different app than the one asked for is
 *   refused, rather than overwriting that other app;
 * - bytes that don't match the checksum the repository published are refused;
 * - a disabled repository is not quietly replaced by another one.
 */

interface Offer {
  version: string;
  buf: Buffer;
  sha?: string;
}

let app: Awaited<ReturnType<typeof buildServer>>;
let cookie: string;
let repo: Server;
let repoUrl: string;
const offers = new Map<string, Offer>();

const enc = (s: string) => new TextEncoder().encode(s);

function keypair(): { privateKey: KeyObject; spki: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, spki: der.toString("base64"), fingerprint: createHash("sha256").update(der).digest("hex") };
}

/** Same canonical digest as apps/framework.ts and the signing tool. */
function digest(files: Record<string, Uint8Array>): Buffer {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    h.update(name + "\n");
    h.update(createHash("sha256").update(files[name]!).digest("hex") + "\n");
  }
  return h.digest();
}

function pkg(id: string, version: string, key: ReturnType<typeof keypair> | null): Buffer {
  const manifest = {
    manifestVersion: 1,
    id,
    name: id,
    version,
    icon: "icon.svg",
    entry: "index.html",
    ...(key ? { publisherKey: key.spki } : {}),
  };
  const files: Record<string, Uint8Array> = {
    "opennas-app.json": enc(JSON.stringify(manifest)),
    "index.html": enc(`<p>${id} ${version}</p>`),
    "icon.svg": enc("<svg/>"),
  };
  if (key) files["SIGNATURE"] = enc(sign(null, digest(files), key.privateKey).toString("base64"));
  return Buffer.from(zipSync(files));
}

function offer(id: string, version: string, buf: Buffer, sha?: string): void {
  offers.set(id, { version, buf, ...(sha ? { sha } : {}) });
}

const post = (url: string, payload: object) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload });

before(async () => {
  repo = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/v1/catalog") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ repository: "test", apps: [...offers].map(([id, o]) => ({ id, name: id, version: o.version })) }));
      return;
    }
    const m = /^\/v1\/apps\/([^/]+)\/download$/.exec(url);
    const o = m ? offers.get(m[1]!) : undefined;
    if (!o) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-onpkg-sha256": o.sha ?? createHash("sha256").update(o.buf).digest("hex"),
    });
    res.end(o.buf);
  });
  await new Promise<void>((r) => repo.listen(0, "127.0.0.1", r));
  repoUrl = `http://127.0.0.1:${(repo.address() as { port: number }).port}`;
  saveRepos([{ id: repoIdFor(repoUrl), url: repoUrl, name: "test", enabled: true }]);

  app = await buildServer();
  await app.ready();
  const admin = createUser({ username: `repo-${process.pid}`, displayName: "Repo", role: "admin" });
  cookie = `opennas_session=${app.signCookie(createSession(admin.id, ["password"]).token)}`;
});

after(async () => {
  await app?.close();
  repo?.close();
});

test("an update signed by another trusted key waits for approval", async () => {
  const a = keypair();
  const b = keypair();
  setTrusted(a.fingerprint, true);
  setTrusted(b.fingerprint, true);

  offer("signer-app", "1.0.0", pkg("signer-app", "1.0.0", a));
  const first = await post("/api/apps/repo/install", { id: "signer-app" });
  assert.equal(first.statusCode, 201, first.body);

  // Same publisher, nothing new: straight in.
  offer("signer-app", "1.1.0", pkg("signer-app", "1.1.0", a));
  const same = await post("/api/apps/repo/updates/apply", { ids: ["signer-app"] });
  assert.deepEqual(JSON.parse(same.body).updated.map((u: { id: string }) => u.id), ["signer-app"]);

  // Different key - trusted, but not the one this app was installed under.
  offer("signer-app", "1.2.0", pkg("signer-app", "1.2.0", b));
  const other = JSON.parse((await post("/api/apps/repo/updates/apply", { ids: ["signer-app"] })).body);
  assert.equal(other.updated.length, 0);
  assert.equal(other.pending.length, 1);
  assert.equal(getInstalledApp("signer-app")?.version, "1.1.0");

  // Unsigned.
  offer("signer-app", "1.3.0", pkg("signer-app", "1.3.0", null));
  const unsigned = JSON.parse((await post("/api/apps/repo/updates/apply", { ids: ["signer-app"] })).body);
  assert.equal(unsigned.updated.length, 0);
  assert.equal(unsigned.pending.length, 1);
  assert.equal(getInstalledApp("signer-app")?.version, "1.1.0");
});

test("a download that is a different app is refused", async () => {
  const k = keypair();
  setTrusted(k.fingerprint, true);
  offer("victim-app", "1.0.0", pkg("victim-app", "1.0.0", k));
  assert.equal((await post("/api/apps/repo/install", { id: "victim-app" })).statusCode, 201);

  offer("decoy-app", "1.0.0", pkg("victim-app", "6.6.6", k));
  const res = await post("/api/apps/repo/install", { id: "decoy-app" });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(getInstalledApp("victim-app")?.version, "1.0.0");
  assert.equal(getInstalledApp("decoy-app"), null);
  offers.delete("decoy-app");

  // And on the update path.
  offer("victim-app", "2.0.0", pkg("other-app", "2.0.0", k));
  const upd = JSON.parse((await post("/api/apps/repo/updates/apply", { ids: ["victim-app"] })).body);
  assert.equal(upd.failed.length, 1);
  assert.equal(getInstalledApp("other-app"), null);
  assert.equal(getInstalledApp("victim-app")?.version, "1.0.0");
});

test("bytes that don't match the published checksum are refused", async () => {
  const k = keypair();
  setTrusted(k.fingerprint, true);
  offer("hash-app", "1.0.0", pkg("hash-app", "1.0.0", k), "0".repeat(64));
  const res = await post("/api/apps/repo/install", { id: "hash-app" });
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(JSON.parse(res.body).error, "integrity");
  assert.equal(getInstalledApp("hash-app"), null);
});

test("a disabled pinned repository is an error, not a fallback", async () => {
  const other = "http://127.0.0.1:9";
  saveRepos([
    { id: repoIdFor(repoUrl), url: repoUrl, name: "test", enabled: false },
    { id: repoIdFor(other), url: other, name: "other", enabled: true },
  ]);
  try {
    const res = await post("/api/apps/repo/install", { id: "victim-app", repo: repoIdFor(repoUrl) });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(JSON.parse(res.body).error, "repo_disabled");
  } finally {
    saveRepos([{ id: repoIdFor(repoUrl), url: repoUrl, name: "test", enabled: true }]);
  }
});
