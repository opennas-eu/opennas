import type { InstalledTheme } from "@opennas/shared";
import { db } from "./index.js";

/** Installed custom themes - the resolved theme JSON keyed by id. */

export function listInstalledThemes(): InstalledTheme[] {
  const rows = db.prepare("SELECT theme FROM installed_themes ORDER BY installed_at DESC").all() as { theme: string }[];
  return rows
    .map((r) => {
      try {
        return JSON.parse(r.theme) as InstalledTheme;
      } catch {
        return null;
      }
    })
    .filter((t): t is InstalledTheme => t !== null);
}

export function getInstalledTheme(id: string): InstalledTheme | null {
  const row = db.prepare("SELECT theme FROM installed_themes WHERE id = ?").get(id) as { theme: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.theme) as InstalledTheme;
  } catch {
    return null;
  }
}

export function upsertInstalledTheme(theme: InstalledTheme): void {
  db.prepare(
    `INSERT INTO installed_themes (id, theme, installed_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET theme = excluded.theme, installed_at = excluded.installed_at`,
  ).run(theme.id, JSON.stringify(theme), new Date().toISOString());
}

export function removeInstalledTheme(id: string): void {
  db.prepare("DELETE FROM installed_themes WHERE id = ?").run(id);
}
