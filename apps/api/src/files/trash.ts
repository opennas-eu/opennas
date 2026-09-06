import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { addTrashItem, clearTrash, getTrashRow, listTrash, removeTrashItem } from "../db/trash.js";
import { resolveSafe, toVirtual } from "./paths.js";

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** rename(), falling back to copy+remove across filesystems (shares may live on
 *  a different volume than the recycle bin under the data dir). */
async function moveCrossFs(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

export { listTrash, getTrashRow };

/** Soft-delete: move a real path into the recycle bin and record its metadata. */
export async function moveToTrash(userId: string, real: string, virtualPath: string, isDir: boolean, sizeBytes: number): Promise<void> {
  const id = nanoid();
  await moveCrossFs(real, join(config.trashDir, id));
  addTrashItem({ id, userId, virtualPath, name: basename(real), isDir, sizeBytes });
}

/** Restore a trashed item to its original location (uniquified on collision). */
export async function restoreFromTrash(
  userId: string,
  id: string,
): Promise<{ ok: true; path: string } | { ok: false; code: number; message: string }> {
  const item = getTrashRow(userId, id);
  if (!item) return { ok: false, code: 404, message: "Item not found in the recycle bin." };
  const src = join(config.trashDir, id);
  if (!(await exists(src))) {
    removeTrashItem(id);
    return { ok: false, code: 404, message: "The deleted file is missing." };
  }

  let destReal: string;
  try {
    destReal = resolveSafe(item.originalPath);
  } catch {
    return { ok: false, code: 400, message: "The original shared folder no longer exists." };
  }

  await mkdir(dirname(destReal), { recursive: true }).catch(() => {});
  if (await exists(destReal)) {
    const ext = item.isDir ? "" : item.name.match(/\.[^.]+$/)?.[0] ?? "";
    const stem = ext ? item.name.slice(0, -ext.length) : item.name;
    let i = 1;
    do {
      destReal = join(dirname(destReal), `${stem} (restored${i > 1 ? " " + i : ""})${ext}`);
      i++;
    } while (await exists(destReal));
  }
  await moveCrossFs(src, destReal);
  removeTrashItem(id);
  return { ok: true, path: toVirtual(destReal) };
}

/** Permanently delete one trash item. */
export async function purgeTrashItem(userId: string, id: string): Promise<boolean> {
  const item = getTrashRow(userId, id);
  if (!item) return false;
  await rm(join(config.trashDir, id), { recursive: true, force: true });
  removeTrashItem(id);
  return true;
}

/** Permanently delete everything in the user's recycle bin. */
export async function emptyTrash(userId: string): Promise<void> {
  for (const it of listTrash(userId)) await rm(join(config.trashDir, it.id), { recursive: true, force: true });
  clearTrash(userId);
}
