import type { TrashItem } from "@opennas/shared";
import { db } from "./index.js";

interface Row {
  id: string;
  user_id: string;
  virtual_path: string;
  name: string;
  is_dir: number;
  size_bytes: number;
  deleted_at: string;
}

function toItem(r: Row): TrashItem {
  return {
    id: r.id,
    originalPath: r.virtual_path,
    name: r.name,
    isDir: r.is_dir === 1,
    sizeBytes: r.size_bytes,
    deletedAt: r.deleted_at,
  };
}

export function addTrashItem(item: { id: string; userId: string; virtualPath: string; name: string; isDir: boolean; sizeBytes: number }): void {
  db.prepare(
    `INSERT INTO trash_items (id, user_id, virtual_path, name, is_dir, size_bytes, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(item.id, item.userId, item.virtualPath, item.name, item.isDir ? 1 : 0, item.sizeBytes, new Date().toISOString());
}

export function listTrash(userId: string): TrashItem[] {
  return (db.prepare("SELECT * FROM trash_items WHERE user_id = ? ORDER BY deleted_at DESC").all(userId) as Row[]).map(toItem);
}

export function getTrashRow(userId: string, id: string): TrashItem | null {
  const r = db.prepare("SELECT * FROM trash_items WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  return r ? toItem(r) : null;
}

export function removeTrashItem(id: string): void {
  db.prepare("DELETE FROM trash_items WHERE id = ?").run(id);
}

export function clearTrash(userId: string): void {
  db.prepare("DELETE FROM trash_items WHERE user_id = ?").run(userId);
}
