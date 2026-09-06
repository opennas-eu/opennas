import { nanoid } from "nanoid";
import type { Note } from "@opennas/shared";
import { db } from "./index.js";

interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function toNote(r: NoteRow): Note {
  return { id: r.id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listNotes(userId: string): Note[] {
  return (
    db.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as NoteRow[]
  ).map(toNote);
}

export function createNote(userId: string, title: string, body: string): Note {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO notes (id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, title, body, now, now);
  return { id, title, body, createdAt: now, updatedAt: now };
}

/** Update a note, scoped to its owner. Returns null if not found/owned. */
export function updateNote(userId: string, id: string, fields: { title?: string; body?: string }): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?").get(id, userId) as NoteRow | undefined;
  if (!row) return null;
  const title = fields.title ?? row.title;
  const body = fields.body ?? row.body;
  const now = new Date().toISOString();
  db.prepare("UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(title, body, now, id);
  return { id, title, body, createdAt: row.created_at, updatedAt: now };
}

export function deleteNote(userId: string, id: string): boolean {
  return db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
