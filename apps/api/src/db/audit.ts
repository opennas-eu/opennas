import { nanoid } from "nanoid";
import type { AuditEntry, AuditOutcome } from "@opennas/shared";
import { db } from "./index.js";

/**
 * The audit trail: who did what, when.
 *
 * Actor identity is denormalised (`actor_name` alongside `actor_id`) because the
 * entries that matter most are often about accounts that no longer exist - a
 * deleted admin's actions have to stay readable after the row they pointed at
 * is gone.
 */

interface Row {
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string;
  actor_ip: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  outcome: string;
  status: number;
}

function toEntry(row: Row): AuditEntry {
  let detail: Record<string, unknown> | undefined;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = undefined;
    }
  }
  return {
    id: row.id,
    at: row.at,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorIp: row.actor_ip,
    action: row.action,
    target: row.target,
    detail,
    outcome: (row.outcome as AuditOutcome) ?? "ok",
    status: row.status,
  };
}

export interface NewAuditEntry {
  actorId?: string | null;
  actorName: string;
  actorIp?: string | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
  outcome: AuditOutcome;
  status: number;
}

const insert = db.prepare(
  `INSERT INTO audit_log (id, at, actor_id, actor_name, actor_ip, action, target, detail, outcome, status)
   VALUES (@id, @at, @actorId, @actorName, @actorIp, @action, @target, @detail, @outcome, @status)`,
);

export function recordAudit(entry: NewAuditEntry): void {
  insert.run({
    id: nanoid(),
    at: new Date().toISOString(),
    actorId: entry.actorId ?? null,
    actorName: entry.actorName.slice(0, 64),
    actorIp: entry.actorIp ?? null,
    action: entry.action.slice(0, 96),
    target: entry.target?.slice(0, 256) ?? null,
    detail: entry.detail ? JSON.stringify(entry.detail).slice(0, 4000) : null,
    outcome: entry.outcome,
    status: entry.status,
  });
}

export interface AuditQuery {
  /** Substring match on action, target or actor name. */
  search?: string;
  action?: string;
  actorId?: string;
  outcome?: AuditOutcome;
  limit?: number;
  /** Skip this many rows, for paging. */
  offset?: number;
}

export function listAudit(query: AuditQuery = {}): { entries: AuditEntry[]; total: number } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.action) {
    where.push("action = @action");
    params.action = query.action;
  }
  if (query.actorId) {
    where.push("actor_id = @actorId");
    params.actorId = query.actorId;
  }
  if (query.outcome) {
    where.push("outcome = @outcome");
    params.outcome = query.outcome;
  }
  if (query.search) {
    where.push("(action LIKE @search OR target LIKE @search OR actor_name LIKE @search)");
    params.search = `%${query.search}%`;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, rowid DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: Math.min(query.limit ?? 100, 500), offset: query.offset ?? 0 }) as Row[];
  return { entries: rows.map(toEntry), total };
}

/** Distinct action names present in the log, for the filter dropdown. */
export function auditActions(): string[] {
  return (db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all() as { action: string }[]).map(
    (r) => r.action,
  );
}

/**
 * Trim the log to a retention window. Called from the periodic prune - an audit
 * log that grows without bound is its own kind of problem on an appliance.
 */
export function pruneAudit(days = 180, maxRows = 50_000): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let removed = db.prepare("DELETE FROM audit_log WHERE at < ?").run(cutoff).changes;
  removed += db.prepare(
    `DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)`,
  ).run(maxRows).changes;
  return removed;
}
