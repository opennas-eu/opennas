import { nanoid } from "nanoid";
import { db } from "./index.js";

/**
 * Short-lived WebAuthn challenges. Stored in SQLite (not memory) so they survive
 * a dev reload and work across workers. Pruned by pruneEphemeral().
 */
export type ChallengeKind = "registration" | "authentication";

export function putChallenge(
  challenge: string,
  kind: ChallengeKind,
  userId: string | null,
): string {
  const id = nanoid();
  db.prepare(
    "INSERT INTO webauthn_challenges (id, user_id, challenge, kind, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, challenge, kind, Date.now());
  return id;
}

export interface StoredChallenge {
  challenge: string;
  kind: ChallengeKind;
  userId: string | null;
}

/** Atomically fetch-and-consume a challenge by id. Returns null if missing/expired. */
export function takeChallenge(id: string): StoredChallenge | null {
  const row = db.prepare("SELECT * FROM webauthn_challenges WHERE id = ?").get(id) as
    | { challenge: string; kind: ChallengeKind; user_id: string | null; created_at: number }
    | undefined;
  db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").run(id);
  if (!row) return null;
  if (Date.now() - row.created_at > 5 * 60 * 1000) return null; // 5 min TTL
  return { challenge: row.challenge, kind: row.kind, userId: row.user_id };
}
