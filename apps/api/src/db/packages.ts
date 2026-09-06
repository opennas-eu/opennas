import { db } from "./index.js";

export interface InstalledPackage {
  id: string;
  version: string;
  status: string;
  installedAt: string;
}

export function listInstalled(): InstalledPackage[] {
  return (db.prepare("SELECT * FROM packages ORDER BY installed_at").all() as {
    id: string;
    version: string;
    status: string;
    installed_at: string;
  }[]).map((r) => ({ id: r.id, version: r.version, status: r.status, installedAt: r.installed_at }));
}

export function installedIds(): Set<string> {
  return new Set(listInstalled().map((p) => p.id));
}

export function isInstalled(id: string): boolean {
  return db.prepare("SELECT 1 FROM packages WHERE id = ?").get(id) !== undefined;
}

export function install(id: string, version: string, status: string): void {
  db.prepare(
    `INSERT INTO packages (id, version, status, installed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, status = excluded.status`,
  ).run(id, version, status, new Date().toISOString());
}

export function uninstall(id: string): void {
  db.prepare("DELETE FROM packages WHERE id = ?").run(id);
}
