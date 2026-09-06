import type { PasskeySummary } from "@opennas/shared";
import { db } from "./index.js";

/** A stored WebAuthn credential (passkey). public_key is raw COSE bytes. */
export interface CredentialRecord {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

function toRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: row.transports ? (JSON.parse(row.transports) as string[]) : [],
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function getCredentialById(id: string): CredentialRecord | null {
  const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as
    | CredentialRow
    | undefined;
  return row ? toRecord(row) : null;
}

export function getCredentialsByUser(userId: string): CredentialRecord[] {
  const rows = db
    .prepare("SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at")
    .all(userId) as CredentialRow[];
  return rows.map(toRecord);
}

export interface SaveCredentialInput {
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  label: string;
}

export function countCredentialsByUser(userId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").get(userId) as { n: number }
  ).n;
}

export function saveCredential(input: SaveCredentialInput): void {
  db.prepare(
    `INSERT INTO credentials
       (id, user_id, public_key, counter, transports, device_type, backed_up, label, created_at)
     VALUES (@id, @user_id, @public_key, @counter, @transports, @device_type, @backed_up, @label, @created_at)`,
  ).run({
    id: input.id,
    user_id: input.userId,
    public_key: Buffer.from(input.publicKey),
    counter: input.counter,
    transports: JSON.stringify(input.transports),
    device_type: input.deviceType,
    backed_up: input.backedUp ? 1 : 0,
    label: input.label,
    created_at: new Date().toISOString(),
  });
}

export function updateCredentialCounter(id: string, counter: number): void {
  db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(
    counter,
    new Date().toISOString(),
    id,
  );
}

export function deleteCredential(id: string, userId: string): boolean {
  const res = db
    .prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return res.changes > 0;
}

export function toSummary(c: CredentialRecord): PasskeySummary {
  return {
    id: c.id,
    label: c.label,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    deviceType: c.deviceType === "multiDevice" ? "synced passkey" : "device-bound",
    backedUp: c.backedUp,
  };
}
