import { DEFAULT_PREFERENCES, type UserPreferences } from "@opennas/shared";
import { db } from "./index.js";

/** Per-user UI preferences, stored as individual key/value rows. */

export function getPreferences(userId: string): UserPreferences {
  const rows = db
    .prepare("SELECT key, value FROM user_prefs WHERE user_id = ?")
    .all(userId) as { key: string; value: string }[];
  const prefs: UserPreferences = { ...DEFAULT_PREFERENCES };
  for (const r of rows) {
    if (r.key === "wallpaper") prefs.wallpaper = r.value;
    else if (r.key === "accent") prefs.accent = r.value;
    else if (r.key === "taskbarPosition" && (r.value === "top" || r.value === "bottom")) {
      prefs.taskbarPosition = r.value;
    } else if (r.key === "theme" && (r.value === "light" || r.value === "dark" || r.value === "system")) {
      prefs.theme = r.value;
    } else if (r.key === "themeId") prefs.themeId = r.value;
    // Stored as a string by setPreferences, like every other value here.
    else if (r.key === "onboarded") prefs.onboarded = r.value === "true";
  }
  return prefs;
}

const upsert = db.prepare(
  `INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)
   ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
);

export function setPreferences(userId: string, partial: Partial<UserPreferences>): UserPreferences {
  const write = db.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) upsert.run(userId, k, v);
  });
  const entries = Object.entries(partial)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  write(entries);
  return getPreferences(userId);
}
