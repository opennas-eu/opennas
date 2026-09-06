import { nanoid } from "nanoid";
import type { NotificationLevel, NotificationRecord } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Durable per-user notifications.
 *
 * These exist so things the *server* notices can reach a person: a disk failing
 * overnight, an app update that needs approval, a scheduled task an app asked
 * for. The browser keeps its own short-lived items for immediate feedback ("App
 * installed"); anything that must survive a reload, or that happened while
 * nobody was looking, belongs here.
 */

interface Row {
  id: string;
  user_id: string;
  level: string;
  title: string;
  body: string | null;
  app_id: string | null;
  dedupe_key: string | null;
  created_at: string;
  read_at: string | null;
}

const LEVELS = new Set(["info", "success", "warning", "critical"]);

function toRecord(row: Row): NotificationRecord {
  return {
    id: row.id,
    level: (LEVELS.has(row.level) ? row.level : "info") as NotificationLevel,
    title: row.title,
    body: row.body ?? undefined,
    appId: row.app_id ?? undefined,
    createdAt: row.created_at,
    read: row.read_at !== null,
  };
}

export interface NewNotification {
  userId: string;
  level?: NotificationLevel;
  title: string;
  body?: string;
  appId?: string;
  /**
   * Collapses repeats of one ongoing condition. A new notification with the same
   * key replaces any *unread* one, so a disk that stays broken doesn't produce a
   * fresh row on every scan. Once the user reads it, the next occurrence is new
   * again - they've acknowledged the old one.
   */
  dedupeKey?: string;
}

export function createNotification(input: NewNotification): NotificationRecord {
  const now = new Date().toISOString();
  const id = nanoid();
  const tx = db.transaction(() => {
    if (input.dedupeKey) {
      db.prepare("DELETE FROM notifications WHERE user_id = ? AND dedupe_key = ? AND read_at IS NULL").run(
        input.userId,
        input.dedupeKey,
      );
    }
    db.prepare(
      `INSERT INTO notifications (id, user_id, level, title, body, app_id, dedupe_key, created_at, read_at)
       VALUES (@id, @userId, @level, @title, @body, @appId, @dedupeKey, @createdAt, NULL)`,
    ).run({
      id,
      userId: input.userId,
      level: input.level ?? "info",
      title: input.title.slice(0, 200),
      body: input.body?.slice(0, 1000) ?? null,
      appId: input.appId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
    });
    // Keep the per-user history bounded.
    db.prepare(
      `DELETE FROM notifications WHERE user_id = @userId AND id NOT IN (
         SELECT id FROM notifications WHERE user_id = @userId ORDER BY created_at DESC LIMIT 200
       )`,
    ).run({ userId: input.userId });
  });
  tx();
  return {
    id,
    level: input.level ?? "info",
    title: input.title,
    body: input.body,
    appId: input.appId,
    createdAt: now,
    read: false,
  };
}

export function listNotifications(userId: string, limit = 100): NotificationRecord[] {
  const rows = db
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as Row[];
  return rows.map(toRecord);
}

export function markNotificationRead(userId: string, id: string): boolean {
  return (
    db
      .prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
      .run(new Date().toISOString(), id, userId).changes > 0
  );
}

export function markAllNotificationsRead(userId: string): number {
  return db
    .prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .run(new Date().toISOString(), userId).changes;
}

export function deleteNotification(userId: string, id: string): boolean {
  return db.prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

export function clearNotifications(userId: string): number {
  return db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId).changes;
}
