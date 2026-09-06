import type { AppManifest } from "@opennas/shared";
import { db } from "./index.js";

/** A row in installed_apps, with its manifest parsed back into an object. */
export interface InstalledApp {
  id: string;
  version: string;
  manifest: AppManifest;
  enabled: boolean;
  installedAt: string;
  /**
   * The repository this app was installed from, or null for a manual upload.
   * Updates are only ever taken from here - see `db/index.ts` migration 0017.
   */
  sourceRepo: string | null;
}

interface AppRow {
  id: string;
  version: string;
  manifest: string;
  enabled: number;
  installed_at: string;
  source_repo: string | null;
}

function toApp(row: AppRow): InstalledApp {
  return {
    id: row.id,
    version: row.version,
    manifest: JSON.parse(row.manifest) as AppManifest,
    enabled: row.enabled === 1,
    installedAt: row.installed_at,
    sourceRepo: row.source_repo,
  };
}

export function listInstalledApps(): InstalledApp[] {
  return (db.prepare("SELECT * FROM installed_apps ORDER BY id").all() as AppRow[]).map(toApp);
}

export function getInstalledApp(id: string): InstalledApp | null {
  const row = db.prepare("SELECT * FROM installed_apps WHERE id = ?").get(id) as AppRow | undefined;
  return row ? toApp(row) : null;
}

/**
 * Insert or update an app. `sourceRepo` is only written when given, so an
 * update applied from the repository keeps the provenance recorded at install
 * time and re-installing by hand doesn't silently clear it.
 */
export function upsertInstalledApp(manifest: AppManifest, sourceRepo?: string | null): void {
  db.prepare(
    `INSERT INTO installed_apps (id, version, manifest, enabled, installed_at, source_repo)
     VALUES (@id, @version, @manifest, 1, @installed_at, @source_repo)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       manifest = excluded.manifest,
       source_repo = COALESCE(excluded.source_repo, installed_apps.source_repo)`,
  ).run({
    id: manifest.id,
    version: manifest.version ?? "0.0.0",
    manifest: JSON.stringify(manifest),
    installed_at: new Date().toISOString(),
    source_repo: sourceRepo ?? null,
  });
}

export function setAppEnabled(id: string, enabled: boolean): void {
  db.prepare("UPDATE installed_apps SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function removeInstalledApp(id: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM installed_apps WHERE id = ?").run(id);
    db.prepare("DELETE FROM app_storage WHERE app_id = ?").run(id);
    db.prepare("DELETE FROM app_settings WHERE app_id = ?").run(id);
  });
  tx();
}

// ---- Per-app, per-user key/value storage ----------------------------------

export function getAppStorage(appId: string, userId: string, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM app_storage WHERE app_id = ? AND user_id = ? AND key = ?")
    .get(appId, userId, key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function listAppStorage(appId: string, userId: string): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM app_storage WHERE app_id = ? AND user_id = ?")
    .all(appId, userId) as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setAppStorage(appId: string, userId: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_storage (app_id, user_id, key, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(appId, userId, key, value);
}

export function deleteAppStorage(appId: string, userId: string, key: string): void {
  db.prepare("DELETE FROM app_storage WHERE app_id = ? AND user_id = ? AND key = ?").run(appId, userId, key);
}
