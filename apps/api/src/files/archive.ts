import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";

/** Cap on uncompressed bytes when building/extracting a zip (memory bound). */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 1 GB

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

interface Counter {
  total: number;
}

async function addPath(map: Record<string, Uint8Array>, realPath: string, archPath: string, counter: Counter): Promise<void> {
  const s = await lstat(realPath).catch(() => null);
  if (!s) return;
  if (s.isDirectory()) {
    const entries = await readdir(realPath, { withFileTypes: true });
    if (entries.length === 0) {
      map[archPath + "/"] = new Uint8Array(0);
      return;
    }
    for (const e of entries) {
      if (!e.isFile() && !e.isDirectory()) continue;
      await addPath(map, join(realPath, e.name), `${archPath}/${e.name}`, counter);
    }
  } else if (s.isFile()) {
    counter.total += s.size;
    if (counter.total > MAX_ZIP_BYTES) throw new ArchiveError("Selection is too large to zip.");
    map[archPath] = new Uint8Array(await readFile(realPath));
  }
}

/** Build a .zip (in memory) from a set of real paths; archive names = basenames. */
export async function buildZip(realPaths: string[]): Promise<Uint8Array> {
  const map: Record<string, Uint8Array> = {};
  const counter: Counter = { total: 0 };
  for (const p of realPaths) await addPath(map, p, basename(p), counter);
  return zipSync(map, { level: 6 });
}

/** Extract a .zip (real path) into destDir (real path), guarding against zip-slip. */
export async function extractZip(zipReal: string, destReal: string): Promise<void> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(await readFile(zipReal)));
  } catch {
    throw new ArchiveError("That isn't a valid .zip file.");
  }
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    const dest = resolve(destReal, name);
    if (dest !== destReal && !dest.startsWith(destReal + sep)) {
      throw new ArchiveError("The archive contains an unsafe file path.");
    }
    if (name.endsWith("/")) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    total += content.length;
    if (total > MAX_ZIP_BYTES) throw new ArchiveError("The archive is too large to extract.");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
}
