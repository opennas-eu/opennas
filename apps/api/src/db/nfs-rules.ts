import { nanoid } from "nanoid";
import type { NfsRule } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Who may mount a share over NFS, and how.
 *
 * NFS authorises by *address*, not by user - the client asserts its own uids and
 * the server believes it. That makes the network list the whole of the access
 * control, so it is worth being able to say something more precise than one
 * global list applied to every share.
 *
 * A share with no rules of its own falls back to the global allowed-networks
 * setting, which is what every existing installation has; adding a rule is what
 * opts a share into the finer-grained scheme.
 */

interface Row {
  id: string;
  share_id: string;
  network: string;
  level: "ro" | "rw";
  root_squash: number;
  created_at: string;
}

/** How many rules one share may carry, so /etc/exports can't be grown unbounded. */
export const MAX_NFS_RULES = 20;

/**
 * An NFS client spec: a CIDR, a bare address, a hostname, a wildcard domain, or
 * `*` for everyone.
 *
 * Deliberately strict about what it accepts, because whatever this returns gets
 * written into /etc/exports - where a space would silently split one rule into
 * two and a newline would let a caller append export lines of their own.
 */
export function isValidNfsClient(spec: string): boolean {
  const v = spec.trim();
  if (v.length === 0 || v.length > 255) return false;
  if (v === "*") return true;
  // No whitespace, no exports metacharacters, no comment starter.
  if (/[\s(),#"'\\]/.test(v)) return false;
  // CIDR or bare IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) {
    const [addr, bits] = v.split("/");
    if (addr!.split(".").some((o) => Number(o) > 255)) return false;
    if (bits !== undefined && Number(bits) > 32) return false;
    return true;
  }
  // A hostname, or one with NFS's glob wildcards in it - `*.lan` and `nas?.lan`
  // are both things exports(5) accepts and people actually write. The bare-IPv4
  // branch above has already returned, so a malformed address like 300.1.1.1
  // cannot fall through to here and be mistaken for a hostname.
  return /^[a-zA-Z0-9*?]([a-zA-Z0-9.*?-]*[a-zA-Z0-9*?])?$/.test(v);
}

function toRule(r: Row): NfsRule {
  return {
    id: r.id,
    network: r.network,
    level: r.level,
    rootSquash: r.root_squash === 1,
  };
}

export function listNfsRules(shareId: string): NfsRule[] {
  const rows = db
    .prepare("SELECT * FROM share_nfs_rules WHERE share_id = ? ORDER BY created_at ASC")
    .all(shareId) as Row[];
  return rows.map(toRule);
}

/** All rules at once, keyed by share - one query for the whole exports render. */
export function allNfsRules(): Map<string, NfsRule[]> {
  const rows = db.prepare("SELECT * FROM share_nfs_rules ORDER BY created_at ASC").all() as Row[];
  const out = new Map<string, NfsRule[]>();
  for (const r of rows) {
    const list = out.get(r.share_id);
    if (list) list.push(toRule(r));
    else out.set(r.share_id, [toRule(r)]);
  }
  return out;
}

export interface SetNfsRuleInput {
  shareId: string;
  network: string;
  level: "ro" | "rw";
  rootSquash: boolean;
}

/** Add a rule, or update the one already covering that network. */
export function setNfsRule(input: SetNfsRuleInput): NfsRule | null {
  const network = input.network.trim();
  if (!isValidNfsClient(network)) return null;

  const existing = db
    .prepare("SELECT * FROM share_nfs_rules WHERE share_id = ? AND network = ?")
    .get(input.shareId, network) as Row | undefined;

  if (existing) {
    db.prepare("UPDATE share_nfs_rules SET level = ?, root_squash = ? WHERE id = ?").run(
      input.level,
      input.rootSquash ? 1 : 0,
      existing.id,
    );
    return toRule({ ...existing, level: input.level, root_squash: input.rootSquash ? 1 : 0 });
  }

  const count = db
    .prepare("SELECT COUNT(*) AS n FROM share_nfs_rules WHERE share_id = ?")
    .get(input.shareId) as { n: number };
  if (count.n >= MAX_NFS_RULES) return null;

  const row: Row = {
    id: nanoid(),
    share_id: input.shareId,
    network,
    level: input.level,
    root_squash: input.rootSquash ? 1 : 0,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO share_nfs_rules (id, share_id, network, level, root_squash, created_at)
     VALUES (@id, @share_id, @network, @level, @root_squash, @created_at)`,
  ).run(row);
  return toRule(row);
}

export function deleteNfsRule(shareId: string, id: string): boolean {
  return db.prepare("DELETE FROM share_nfs_rules WHERE id = ? AND share_id = ?").run(id, shareId).changes > 0;
}
