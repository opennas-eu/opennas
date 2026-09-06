import type { NotificationRecord } from "@opennas/shared";
import { createNotification, type NewNotification } from "../db/notifications.js";
import { listUsers } from "../db/users.js";

/**
 * The one way anything server-side tells a user something.
 *
 * Writes the notification durably, then pushes it to any of that user's live
 * WebSocket connections so an open desktop updates immediately. Nothing is lost
 * if they're offline - they'll see it on their next load, which is the whole
 * point of moving notifications off the browser.
 *
 * The socket registry is filled in by ws.ts; this module only ever calls into
 * it, so there's no import cycle.
 */

type Deliver = (msg: { type: "notification"; notification: NotificationRecord }) => void;

/** userId -> the sockets that user currently has open (tabs, devices). */
const listeners = new Map<string, Set<Deliver>>();

/** Register a live connection for a user. Returns an unregister function. */
export function subscribeUser(userId: string, deliver: Deliver): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(deliver);
  return () => {
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(deliver);
    if (current.size === 0) listeners.delete(userId);
  };
}

/** Store a notification for one user and push it to their open sessions. */
export function notifyUser(input: NewNotification): NotificationRecord {
  const record = createNotification(input);
  const set = listeners.get(input.userId);
  if (set) {
    for (const deliver of set) {
      try {
        deliver({ type: "notification", notification: record });
      } catch {
        /* a dead socket is cleaned up by its own close handler */
      }
    }
  }
  return record;
}

/**
 * Notify every admin - for things about the machine rather than about a person
 * (a failing disk, an app update awaiting approval). Regular users can't act on
 * these and shouldn't be alarmed by them.
 */
export function notifyAdmins(input: Omit<NewNotification, "userId">): number {
  const admins = listUsers().filter((u) => u.user.role === "admin" && !u.disabled);
  for (const admin of admins) notifyUser({ ...input, userId: admin.user.id });
  return admins.length;
}
