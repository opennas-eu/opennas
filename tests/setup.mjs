/**
 * Loaded before imports in every test process.
 *
 * Registers the .js-to-.ts resolve hook and sets OPENNAS_DATA_DIR to a temporary
 * directory before config.ts reads it. Setting this inside a test body would
 * be too late: ESM evaluates imported modules first, which could create or
 * modify files in the developer's real data directory.
 *
 * An explicit OPENNAS_DATA_DIR is preserved for tests targeting a specific
 * installation. Temporary directories created here are removed on exit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./hooks.mjs", pathToFileURL(import.meta.filename));

if (!process.env.OPENNAS_DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "opennas-test-"));
  process.env.OPENNAS_DATA_DIR = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp directory is the OS's problem, not a test failure */
    }
  });
}

// Keep the appliance's system-touching code paths in their generate-only mode
// unless a test deliberately asks otherwise. A unit test must never reload smbd.
process.env.OPENNAS_SYSTEM_MODE ??= "demo";
