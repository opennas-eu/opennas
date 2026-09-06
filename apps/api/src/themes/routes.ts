import type { FastifyInstance } from "fastify";
import type { ThemeInstallResponse, ThemesResponse } from "@opennas/shared";
import { requireAdmin, requireAuth } from "../auth/plugin.js";
import { getInstalledTheme, listInstalledThemes } from "../db/installed-themes.js";
import { installThemeFromZip, ThemeError, uninstallTheme } from "./framework.js";

export async function themeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Any signed-in user can list + apply installed themes (apply is a pref).
  app.get("/", async (): Promise<ThemesResponse> => ({ themes: listInstalledThemes() }));

  // Installing/removing a theme affects everyone - admin only.
  app.post("/install", { preHandler: requireAdmin }, async (req, reply): Promise<ThemeInstallResponse> => {
    const part = await req.file({ limits: { fileSize: 32 * 1024 * 1024 } }).catch(() => null);
    if (!part) return reply.code(400).send({ error: "no_file", message: "Upload a .onthm theme." }) as never;
    const buf = await part.toBuffer();
    if (part.file.truncated) return reply.code(413).send({ error: "too_large", message: "That theme is too large." }) as never;
    try {
      const theme = await installThemeFromZip(buf);
      return reply.code(201).send({ theme });
    } catch (err) {
      if (err instanceof ThemeError) return reply.code(400).send({ error: "bad_theme", message: err.message }) as never;
      req.log.error({ err }, "theme install failed");
      return reply.code(500).send({ error: "install_failed", message: "Could not install the theme." }) as never;
    }
  });

  app.delete("/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getInstalledTheme(id)) return reply.code(404).send({ error: "not_found", message: "Theme not installed." });
    await uninstallTheme(id);
    return { ok: true };
  });
}
