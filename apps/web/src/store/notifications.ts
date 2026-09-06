import { create } from "zustand";
import type { NotificationRecord, NotificationsResponse } from "@opennas/shared";
import { api } from "../lib/api.ts";

export type { NotificationLevel } from "@opennas/shared";
import type { NotificationLevel } from "@opennas/shared";

/**
 * The notification centre.
 *
 * Two kinds of item share one list:
 *
 *  - **server** items are durable and per-user. Anything the backend noticed
 *    lands here - a failing disk, an app update awaiting approval, a scheduled
 *    task - and it survives reloads, arrives on every device, and shows up even
 *    if it happened while nobody was signed in.
 *  - **local** items are immediate feedback for something the user just did
 *    ("App installed", "Couldn't save"). They're session-scoped on purpose:
 *    persisting a toast about an action you watched succeed is just clutter.
 *
 * `push()` keeps its old signature, so the ~40 call sites around the app didn't
 * have to change when this moved server-side.
 */

export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  /** Epoch ms, for sorting and relative timestamps. */
  createdAt: number;
  read: boolean;
  /** Optional app to open when the notification is clicked. */
  appId?: string;
  /** Where it came from - decides whether read/remove hits the API. */
  source: "server" | "local";
}

interface NotificationStore {
  items: Notification[];
  /** Push a local, session-only notification. `dedupeKey` suppresses repeats. */
  push: (n: Omit<Notification, "id" | "createdAt" | "read" | "source">, dedupeKey?: string) => void;
  /** Merge a notification pushed over the WebSocket. */
  receive: (record: NotificationRecord) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Load the user's stored notifications. Call on login / desktop mount. */
  hydrate: (userId: string) => void;
}

const COOLDOWN_MS = 60_000;
/** Suppress repeats of one-time events (e.g. the welcome) for much longer. */
const STICKY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const STICKY_KEYS = new Set(["welcome"]);

/**
 * Dedupe bookkeeping for local pushes. Kept in localStorage (not on the server)
 * because it exists to stop one browser session re-firing the same toast - a
 * different device has no reason to care.
 */
let dedupeKeyPrefix: string | null = null;
let dedupe: Record<string, number> = {};

function loadDedupe(userId: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(`opennas.notify-dedupe.${userId}`) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function persistDedupe() {
  if (!dedupeKeyPrefix) return;
  try {
    localStorage.setItem(dedupeKeyPrefix, JSON.stringify(dedupe));
  } catch {
    /* quota / private mode: dedupe just becomes session-scoped */
  }
}

function fromRecord(r: NotificationRecord): Notification {
  return {
    id: r.id,
    level: r.level,
    title: r.title,
    body: r.body,
    appId: r.appId,
    createdAt: Date.parse(r.createdAt),
    read: r.read,
    source: "server",
  };
}

/** Newest first, with a stable order for items sharing a timestamp. */
function sorted(items: Notification[]): Notification[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export const useNotifications = create<NotificationStore>((set, get) => ({
  items: [],

  hydrate(userId) {
    dedupeKeyPrefix = `opennas.notify-dedupe.${userId}`;
    dedupe = loadDedupe(userId);
    void api
      .get<NotificationsResponse>("/notifications")
      .then((res) => {
        // Keep any local items raised while the request was in flight.
        const local = get().items.filter((i) => i.source === "local");
        set({ items: sorted([...res.notifications.map(fromRecord), ...local]).slice(0, 200) });
      })
      .catch(() => {
        /* offline or not signed in - local items keep working */
      });
  },

  push(n, dedupeKey) {
    if (dedupeKey) {
      const last = dedupe[dedupeKey] ?? 0;
      const cooldown = STICKY_KEYS.has(dedupeKey) ? STICKY_COOLDOWN_MS : COOLDOWN_MS;
      if (Date.now() - last < cooldown) return;
      dedupe[dedupeKey] = Date.now();
      persistDedupe();
    }
    const item: Notification = {
      ...n,
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      read: false,
      source: "local",
    };
    set({ items: sorted([item, ...get().items]).slice(0, 200) });
  },

  receive(record) {
    const item = fromRecord(record);
    // The same notification can arrive twice (WS push racing a hydrate).
    if (get().items.some((i) => i.id === item.id)) return;
    set({ items: sorted([item, ...get().items]).slice(0, 200) });
  },

  markAllRead() {
    const items = get().items;
    if (!items.some((i) => !i.read)) return;
    set({ items: items.map((i) => (i.read ? i : { ...i, read: true })) });
    if (items.some((i) => !i.read && i.source === "server")) {
      void api.post("/notifications/read", {}).catch(() => {
        /* it'll be marked again next time the bell is opened */
      });
    }
  },

  remove(id) {
    const target = get().items.find((i) => i.id === id);
    set({ items: get().items.filter((i) => i.id !== id) });
    if (target?.source === "server") {
      void api.del(`/notifications/${encodeURIComponent(id)}`).catch(() => {
        /* it reappears on the next hydrate, which is the honest outcome */
      });
    }
  },

  clear() {
    const hadServerItems = get().items.some((i) => i.source === "server");
    set({ items: [] });
    if (hadServerItems) {
      void api.del("/notifications").catch(() => {
        /* they'll come back on the next hydrate */
      });
    }
  },
}));
