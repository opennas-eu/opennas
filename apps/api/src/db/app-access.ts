import type { User } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Which apps a user may use.
 *
 * Off for everyone by default - a new account, and every account that existed
 * before this was written, can use whatever its role allows. Restriction is
 * something an admin turns on for a specific person, not a wall everyone starts
 * behind.
 *
 * ## This is not a UI filter
 *
 * The tempting version of this feature hides apps from the launcher and stops
 * there, which restricts nobody: an app's real surface is its API routes and the
 * files served under `/apps/<id>/`, and both are reachable by typing a URL. So
 * the check lives at the two chokepoints every request goes through - the
 * `resolveApp` helper that every per-app route calls, and the static handler
 * that serves an app's own files - rather than in the list the desktop renders.
 * The launcher filter is a convenience on top of that, not the mechanism.
 *
 * ## Two things it deliberately cannot do
 *
 * **It never applies to admins.** An admin restricted out of Control Panel could
 * not undo it from the web interface, and on a headless NAS that means a
 * keyboard and a screen. The restriction is refused at the route rather than
 * quietly ignored, so nobody sets it and believes it took.
 *
 * **It cannot take away Control Panel or About.** Control Panel is where a
 * regular user changes their own password, enrols a passkey and sets up 2FA;
 * an account that cannot reach it is an account that cannot secure itself. The
 * admin-only pages inside it are already gated by role, so leaving it available
 * gives nothing away.
 */

/** Apps the allow-list can never remove. */
export const ALWAYS_AVAILABLE = new Set(["control-panel", "about"]);

interface Row {
  app_id: string;
}

/** Whether this user's app list is being enforced at all. */
export function isAppsRestricted(userId: string): boolean {
  const row = db.prepare("SELECT apps_restricted FROM users WHERE id = ?").get(userId) as
    | { apps_restricted: number }
    | undefined;
  return row?.apps_restricted === 1;
}

/** The app ids explicitly allowed for a user, whether or not the list is in force. */
export function allowedAppIds(userId: string): string[] {
  const rows = db
    .prepare("SELECT app_id FROM app_access WHERE user_id = ? ORDER BY app_id")
    .all(userId) as Row[];
  return rows.map((r) => r.app_id);
}

/**
 * Whether a user may use an app.
 *
 * Takes the whole user rather than an id so the admin and role checks can't be
 * skipped by a caller that happens to have only an id to hand.
 */
export function canUseApp(user: Pick<User, "id" | "role">, appId: string): boolean {
  if (user.role === "admin") return true;
  if (ALWAYS_AVAILABLE.has(appId)) return true;
  if (!isAppsRestricted(user.id)) return true;
  const row = db
    .prepare("SELECT 1 AS ok FROM app_access WHERE user_id = ? AND app_id = ?")
    .get(user.id, appId) as { ok: number } | undefined;
  return row !== undefined;
}

export interface AppAccessInput {
  restricted: boolean;
  appIds: string[];
}

/**
 * Replace a user's app access in one go.
 *
 * A transaction, because a half-applied change here is a user who can suddenly
 * use more or less than the admin intended, and the window would be exactly as
 * long as the loop.
 */
export function setAppAccess(userId: string, input: AppAccessInput): void {
  const apply = db.transaction(() => {
    db.prepare("UPDATE users SET apps_restricted = ? WHERE id = ?").run(input.restricted ? 1 : 0, userId);
    db.prepare("DELETE FROM app_access WHERE user_id = ?").run(userId);
    const insert = db.prepare("INSERT OR IGNORE INTO app_access (user_id, app_id) VALUES (?, ?)");
    for (const appId of new Set(input.appIds)) {
      // The always-available ones are not stored: they are granted by the code
      // above regardless, and a row for one would suggest an admin could remove
      // it by unticking a box.
      if (ALWAYS_AVAILABLE.has(appId)) continue;
      insert.run(userId, appId);
    }
  });
  apply();
}

/**
 * Forget an app everywhere it was granted.
 *
 * Called when an app is uninstalled. Without it, reinstalling an app later would
 * silently restore whatever access it had the first time - including to people
 * an admin had since decided shouldn't have it.
 */
export function forgetApp(appId: string): void {
  db.prepare("DELETE FROM app_access WHERE app_id = ?").run(appId);
}
