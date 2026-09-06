import type { ShareLink } from "@opennas/shared";
import { db } from "./index.js";

interface Row {
  id: string;
  user_id: string;
  virtual_path: string;
  name: string;
  is_dir: number;
  password_hash: string | null;
  expires_at: string | null;
  created_at: string;
}

function toLink(r: Row): ShareLink {
  return {
    id: r.id,
    path: r.virtual_path,
    name: r.name,
    isDir: r.is_dir === 1,
    hasPassword: !!r.password_hash,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    url: `/s/${r.id}`,
  };
}

export function createLink(item: {
  id: string;
  userId: string;
  virtualPath: string;
  name: string;
  isDir: boolean;
  passwordHash: string | null;
  expiresAt: string | null;
}): void {
  db.prepare(
    `INSERT INTO share_links (id, user_id, virtual_path, name, is_dir, password_hash, expires_at, created_at)
     VALUES (@id, @userId, @virtualPath, @name, @isDir, @passwordHash, @expiresAt, @createdAt)`,
  ).run({
    id: item.id,
    userId: item.userId,
    virtualPath: item.virtualPath,
    name: item.name,
    isDir: item.isDir ? 1 : 0,
    passwordHash: item.passwordHash,
    expiresAt: item.expiresAt,
    createdAt: new Date().toISOString(),
  });
}

export function listLinks(userId: string): ShareLink[] {
  return (db.prepare("SELECT * FROM share_links WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[]).map(toLink);
}

export function getLink(userId: string, id: string): ShareLink | null {
  const r = db.prepare("SELECT * FROM share_links WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  return r ? toLink(r) : null;
}

export function removeLink(userId: string, id: string): void {
  db.prepare("DELETE FROM share_links WHERE id = ? AND user_id = ?").run(id, userId);
}

/** Raw lookup for the public endpoint (no user scoping). */
export interface PublicLink {
  id: string;
  virtualPath: string;
  isDir: boolean;
  passwordHash: string | null;
  expiresAt: string | null;
}

export function getPublicLink(id: string): PublicLink | null {
  const r = db.prepare("SELECT id, virtual_path, is_dir, password_hash, expires_at FROM share_links WHERE id = ?").get(id) as
    | { id: string; virtual_path: string; is_dir: number; password_hash: string | null; expires_at: string | null }
    | undefined;
  if (!r) return null;
  return { id: r.id, virtualPath: r.virtual_path, isDir: r.is_dir === 1, passwordHash: r.password_hash, expiresAt: r.expires_at };
}

export function deleteLinkById(id: string): void {
  db.prepare("DELETE FROM share_links WHERE id = ?").run(id);
}
