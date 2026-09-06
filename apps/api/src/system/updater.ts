import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import type { UpdateRelease, UpdateState } from "@opennas/shared";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db/settings.js";

const exec = promisify(execFile);

/**
 * Downloads and stages OpenNAS updates.
 *
 * This unprivileged module checks for releases, downloads a bundle and verifies
 * its checksum. The root helper, `opennas-update`, verifies the signature,
 * replaces the installation and restarts the service. It restores the previous
 * version if the health check fails.
 *
 * Signature verification belongs in the root helper so a compromised backend
 * cannot bypass it.
 */

const CHANNEL_SETTING = "update_channel";
const STAGE_DIR = "update-stage";

/** Where releases are published. Overridable for testing and for a private mirror. */
export const DEFAULT_CHANNEL = "https://opennas.org/updates/stable.json";

export function channelUrl(): string {
  const stored = getSetting(CHANNEL_SETTING)?.trim();
  return stored && /^https:\/\//i.test(stored) ? stored : DEFAULT_CHANNEL;
}

export function setChannelUrl(url: string): void {
  setSetting(CHANNEL_SETTING, url.trim());
}

/**
 * Compare two versions the way semver orders them.
 *
 * Build metadata after `+` is ignored, which is what lets the VERSION file carry
 * a commit hash without every rebuild looking like a new release. A pre-release
 * suffix after `-` sorts *below* the same version without one, so 1.0.0-beta.2
 * never looks newer than 1.0.0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("+")[0]!.split("-", 2);
    const nums = (core ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre: pre ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // Same numbers: no pre-release beats a pre-release, otherwise compare them.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return comparePreRelease(pa.pre, pb.pre);
}

/**
 * Compare semver pre-release identifiers.
 *
 * Compare numeric identifiers as numbers so beta.10 sorts after beta.9.
 * Numeric identifiers sort below alphanumeric ones. If all shared identifiers
 * match, the version with more identifiers sorts later.
 */
function comparePreRelease(a: string, b: string): number {
  const ai = a.split(".");
  const bi = b.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // https only: an update fetched over plain http could be swapped in flight,
    // and while the signature would catch that, failing early is clearer than a
    // confusing verification error.
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse a channel manifest, refusing anything that isn't fully formed. */
export function parseRelease(raw: unknown): UpdateRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === "string" ? r.version.trim() : "";
  const bundleUrl = typeof r.bundleUrl === "string" ? r.bundleUrl : "";
  const signatureUrl = typeof r.signatureUrl === "string" ? r.signatureUrl : "";
  const sha256 = typeof r.sha256 === "string" ? r.sha256.trim().toLowerCase() : "";
  if (!version || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!isSafeUrl(bundleUrl) || !isSafeUrl(signatureUrl)) return null;
  return {
    version,
    releasedAt: typeof r.releasedAt === "string" ? r.releasedAt : "",
    notes: typeof r.notes === "string" ? r.notes.slice(0, 4000) : "",
    bundleUrl,
    signatureUrl,
    sha256,
  };
}

/** Ask the channel what the latest release is. */
export async function checkForUpdate(log: FastifyBaseLogger): Promise<{
  current: string;
  available: UpdateRelease | null;
  error: string;
}> {
  const current = config.version;
  try {
    const res = await fetch(channelUrl(), {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
      redirect: "follow",
    });
    if (!res.ok) return { current, available: null, error: `The update server answered ${res.status}.` };
    const release = parseRelease(await res.json());
    if (!release) return { current, available: null, error: "The update server sent something unusable." };
    // Only offered when it is actually newer, so a channel that has rolled back
    // can't talk a machine into "updating" to an older build.
    const newer = compareVersions(release.version, current) > 0;
    return { current, available: newer ? release : null, error: "" };
  } catch (err) {
    log.warn({ err }, "could not check for updates");
    return { current, available: null, error: "Couldn't reach the update server." };
  }
}

async function download(url: string, limitBytes: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
  if (!res.ok) throw new Error(`download failed with ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A cap so a hostile or broken channel can't fill the disk before anything has
  // had a chance to check what it sent.
  if (buf.length > limitBytes) throw new Error("the download was larger than expected");
  return buf;
}

/**
 * Fetch a release and hand it to the privileged updater.
 *
 * Returns once the update has been *started*; it detaches and restarts the
 * service, so there is nothing useful to await - progress is read back with
 * `updateState`.
 */
export async function applyUpdate(
  release: UpdateRelease,
  log: FastifyBaseLogger,
): Promise<{ ok: boolean; error?: string }> {
  const dir = join(config.dataDir, STAGE_DIR);
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const bundle = await download(release.bundleUrl, 512 * 1024 * 1024);
    const digest = createHash("sha256").update(bundle).digest("hex");
    if (digest !== release.sha256) {
      // The signature check on the far side would catch this too; failing here
      // gives a clearer answer for the ordinary case of a truncated download.
      return { ok: false, error: "The download didn't match the checksum the update server published." };
    }
    const signature = await download(release.signatureUrl, 4096);

    const bundlePath = join(dir, "bundle.tar.gz");
    const sigPath = join(dir, "bundle.sig");
    await writeFile(bundlePath, bundle, { mode: 0o600 });
    await writeFile(sigPath, signature, { mode: 0o600 });

    log.info({ version: release.version }, "handing the update to the privileged updater");
    await exec("doas", [config.updateHelper, "apply", bundlePath, sigPath], { timeout: 60_000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    log.warn({ err }, "update failed");
    return { ok: false, error: e.stderr?.trim() || e.message || "The update could not be applied." };
  }
}

/** What the privileged updater last reported. */
export async function updateState(): Promise<UpdateState> {
  try {
    const { stdout } = await exec("doas", [config.updateHelper, "status"], { timeout: 10_000 });
    const [state = "idle", message = "", at = ""] = stdout.trim().split("|");
    const known: UpdateState["state"][] = ["idle", "running", "ok", "failed", "rolled_back"];
    return {
      state: (known as string[]).includes(state) ? (state as UpdateState["state"]) : "idle",
      message,
      at,
    };
  } catch {
    // No helper (not on the appliance), or doas refused. Neither is an error
    // worth surfacing as a failure - it just means self-update isn't available.
    return { state: "idle", message: "", at: "" };
  }
}

/** Whether this installation can update itself at all. */
export async function updateSupported(): Promise<boolean> {
  if (config.systemMode !== "linux") return false;
  try {
    await exec("doas", [config.updateHelper, "status"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function rollbackUpdate(log: FastifyBaseLogger): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec("doas", [config.updateHelper, "rollback"], { timeout: 120_000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string };
    log.warn({ err }, "rollback failed");
    return { ok: false, error: e.stderr?.trim() || "Could not go back to the previous version." };
  }
}
