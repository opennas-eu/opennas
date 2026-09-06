import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NotesResponse } from "@opennas/shared";
import { requireAuth } from "../auth/plugin.js";
import { isInstalled } from "../db/packages.js";
import { createNote, deleteNote, listNotes, updateNote } from "../db/notes.js";

export async function noteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  // The Notes app must be installed for its API to be usable.
  app.addHook("preHandler", async (_req, reply) => {
    if (!isInstalled("notes")) {
      await reply.code(404).send({ error: "not_installed", message: "Notes is not installed." });
    }
  });

  app.get("/", async (req): Promise<NotesResponse> => ({ notes: listNotes(req.auth!.user.id) }));

  const createSchema = z.object({ title: z.string().max(200).optional(), body: z.string().max(100_000).optional() });
  app.post("/", async (req) => {
    const { title, body } = createSchema.parse(req.body ?? {});
    return { note: createNote(req.auth!.user.id, title?.trim() || "Untitled", body ?? "") };
  });

  const updateSchema = z.object({ title: z.string().max(200).optional(), body: z.string().max(100_000).optional() });
  app.patch("/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const note = updateNote(req.auth!.user.id, id, updateSchema.parse(req.body ?? {}));
    if (!note) return reply.code(404).send({ error: "not_found", message: "Note not found." });
    return { note };
  });

  app.delete("/:id", async (req, reply) => {
    const ok = deleteNote(req.auth!.user.id, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "Note not found." });
    return { ok: true };
  });
}
