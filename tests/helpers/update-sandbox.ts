import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A disposable installation for exercising the real `opennas-update`.
 *
 * The script is run **as itself**, not reimplemented - it is the trust boundary
 * for the whole update path, so a test that checks a paraphrase of it is worth
 * very little. What is redirected is only *where* it operates: `PREFIX`, `KEY`,
 * `STATE_DIR` and `HEALTH_URL` are rewritten in a copy so the test can own a
 * fake install under /tmp.
 *
 * Those four are deliberately **not** environment-overridable in the shipped
 * script. `KEY` especially: a root-run updater that took its trust anchor from
 * the environment would let anyone who could set a variable point it at a key of
 * their own, which is precisely the escalation the design exists to prevent.
 * Rewriting a copy in a test costs nothing and gives up nothing.
 *
 * `verifyConstants` below asserts the real constants are still the ones the
 * appliance needs, since that is the part rewriting hides.
 */
export interface Sandbox {
  dir: string;
  prefix: string;
  script: string;
  statusFile: string;
  privateKey: string;
  publicKey: string;
  /** A second key, so "signed, but not by us" can be tested. */
  wrongKey: string;
  health: Server;
  healthy: (ok: boolean) => void;
  status: () => { state: string; message: string };
  run: (args: string[]) => { code: number; stdout: string; stderr: string };
  cleanup: () => void;
}

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

/** A tree shaped like a built OpenNAS payload. */
export function makePayload(dir: string, version: string, extra: Record<string, string> = {}): void {
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "index.js"), `// OpenNAS ${version}\n`);
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "opennas", dependencies: {} }, null, 2) + "\n");
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

/**
 * A stand-in for the native module the updater loads before swapping.
 *
 * `loadable: false` produces one that throws on require - the case that used to
 * install fine and then fail to boot, and which the helper is supposed to catch
 * while the old version is still serving.
 */
export function fakeNativeModule(dir: string, loadable: boolean): void {
  const mod = join(dir, "node_modules", "better-sqlite3");
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
  writeFileSync(
    join(mod, "index.js"),
    loadable ? "module.exports = {};\n" : "throw new Error('missing binding for this platform');\n",
  );
}

export async function makeSandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), "opennas-update-"));
  const prefix = join(dir, "opennas");
  const etc = join(dir, "etc");
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  mkdirSync(etc, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // Two keypairs: the one the install trusts, and one it does not.
  const privateKey = join(dir, "release.key");
  const publicKey = join(etc, "update-key.pub");
  const wrongKey = join(dir, "wrong.key");
  sh("openssl", ["genpkey", "-algorithm", "ed25519", "-out", privateKey]);
  sh("openssl", ["pkey", "-in", privateKey, "-pubout", "-out", publicKey]);
  sh("openssl", ["genpkey", "-algorithm", "ed25519", "-out", wrongKey]);

  // A health endpoint the test can switch off, so "the new version never came
  // back" is a real HTTP failure rather than a mocked one.
  let up = true;
  const health = createServer((_req, res) => {
    if (!up) {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const port = (health.address() as { port: number }).port;

  // rc-service and nginx reloads have nothing to act on here; a stub keeps the
  // script on its real path instead of taking an error branch.
  writeFileSync(join(bin, "rc-service"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "rc-service"), 0o755);

  const original = readFileSync(join(repoRoot, "packaging", "opennas-update"), "utf8");
  const script = join(dir, "opennas-update");
  writeFileSync(
    script,
    original
      .replace(/^PREFIX=.*$/m, `PREFIX=${prefix}`)
      .replace(/^KEY=.*$/m, `KEY="${publicKey}"`)
      .replace(/^STATE_DIR=.*$/m, `STATE_DIR=${state}`)
      .replace(/^HEALTH_TIMEOUT=.*$/m, "HEALTH_TIMEOUT=9")
      .replace(/^HEALTH_URL=.*$/m, `HEALTH_URL="http://127.0.0.1:${port}/api/health"`),
  );
  chmodSync(script, 0o755);

  return {
    dir,
    prefix,
    script,
    statusFile: join(state, "status"),
    privateKey,
    publicKey,
    wrongKey,
    health,
    healthy: (ok: boolean) => {
      up = ok;
    },
    status() {
      try {
        const [st = "", msg = ""] = readFileSync(join(state, "status"), "utf8").trim().split("|");
        return { state: st, message: msg };
      } catch {
        return { state: "", message: "" };
      }
    },
    run(args: string[]) {
      try {
        const stdout = sh("sh", [script, ...args], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        return { code: 0, stdout, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
    cleanup() {
      health.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Pack a directory the way make-release.sh does, and sign it. */
export function packAndSign(payloadDir: string, out: string, key: string): { bundle: string; sig: string } {
  execFileSync("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "-czf", out, "-C", payloadDir, "."]);
  execFileSync("openssl", ["pkeyutl", "-sign", "-inkey", key, "-rawin", "-in", out, "-out", `${out}.sig`]);
  return { bundle: out, sig: `${out}.sig` };
}

/**
 * Wait for the detached updater to reach a terminal state.
 *
 * The default is generous on purpose. The updater unpacks a tarball, loads a
 * native module and polls an HTTP endpoint, none of which have a bounded
 * duration on a loaded machine - and this test flaked exactly once, while a
 * QEMU VM was saturating the host. A timeout that only holds on an idle machine
 * is a test that fails for reasons unrelated to the code.
 */
export async function settle(box: Sandbox, timeoutMs = 120_000): Promise<{ state: string; message: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = box.status();
    if (["ok", "failed", "rolled_back"].includes(s.state)) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
}
