import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NotificationsResponse } from "@opennas/shared";
import { requireAuth } from "../auth/plugin.js";
import {
  clearNotifications,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../db/notifications.js";

/** A user's own notifications. Every route is scoped to the caller. */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (req): Promise<NotificationsResponse> => {
    const notifications = listNotifications(req.auth!.user.id);
    return { notifications, unread: notifications.filter((n) => !n.read).length };
  });

  app.post("/read", async (req, reply) => {
    const parsed = z.object({ id: z.string().min(1).max(64).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid request." });
    // No id means "mark everything read" - what the bell does when opened.
    if (!parsed.data.id) return { ok: true, marked: markAllNotificationsRead(req.auth!.user.id) };
    const ok = markNotificationRead(req.auth!.user.id, parsed.data.id);
    return { ok, marked: ok ? 1 : 0 };
  });

  app.delete("/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deleteNotification(req.auth!.user.id, id)) {
      return reply.code(404).send({ error: "not_found", message: "No such notification." });
    }
    return { ok: true };
  });

  app.delete("/", async (req) => ({ ok: true, removed: clearNotifications(req.auth!.user.id) }));
}
