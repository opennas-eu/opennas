import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PreferencesResponse } from "@opennas/shared";
import { requireAuth } from "../auth/plugin.js";
import { getPreferences, setPreferences } from "../db/prefs.js";

export async function prefsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (req): Promise<PreferencesResponse> => {
    return { preferences: getPreferences(req.auth!.user.id) };
  });

  const schema = z.object({
    wallpaper: z.string().max(64).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    taskbarPosition: z.enum(["top", "bottom"]).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    themeId: z.string().max(64).regex(/^[a-z0-9._-]*$/).optional(),
    onboarded: z.boolean().optional(),
  });

  app.put("/", async (req, reply): Promise<PreferencesResponse> => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Invalid preferences." }) as never;
    }
    return { preferences: setPreferences(req.auth!.user.id, parsed.data) };
  });
}
