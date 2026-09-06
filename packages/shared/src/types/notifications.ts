/** Durable, server-stored notifications. */

export type NotificationLevel = "info" | "success" | "warning" | "critical";

/** One stored notification belonging to a user. */
export interface NotificationRecord {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  /** App to open when the notification is clicked. */
  appId?: string;
  /** ISO timestamp. */
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications */
export interface NotificationsResponse {
  notifications: NotificationRecord[];
  unread: number;
}

// ---- Scheduled tasks (apps asking OpenNAS to do work on a timer) -----------

/**
 * What OpenNAS should do when a task falls due.
 *
 * An app is a sandboxed iframe with no server-side code, so the *server* carries
 * the action out. That's why each action maps onto a capability the app already
 * declared and the admin already approved - scheduling never grants new reach.
 */
export type ScheduledAction =
  /** Post a notification to the owning user. Requires the "notifications" permission. */
  | { kind: "notify"; title: string; body?: string; level?: NotificationLevel }
  /**
   * Fetch a URL through the app's allow-list and store the response body under
   * `storeAs` in the app's per-user storage. Requires "fetch" and "storage".
   */
  | { kind: "fetch"; url: string; method?: string; headers?: Record<string, string>; storeAs: string };

/** A task an app registered. Scoped to one app and one user. */
export interface ScheduledTask {
  id: string;
  /** App-chosen name, unique per app + user. Re-registering it updates in place. */
  name: string;
  /** How often it runs, in seconds. */
  intervalSeconds: number;
  action: ScheduledAction;
  enabled: boolean;
  /** ISO timestamps. */
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  createdAt: string;
}

export interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
}
