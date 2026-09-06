import type { IpBan } from "@opennas/shared";
import { db } from "./index.js";

/**
 * Failed sign-ins per source address, and the bans that follow.
 *
 * This is the second axis of brute-force defence. `login_attempts` locks one
 * *account* after repeated failures, which stops someone grinding a password
 * list against a known username. It does nothing about an address working
 * through many usernames - every account stays under its own threshold while
 * the attacker gets unlimited attempts overall. That is what this catches.
 *
 * The record here is bookkeeping; the enforcement is an nftables set with a
 * per-element timeout, so the kernel lifts a ban itself even if OpenNAS is
 * stopped. The two can therefore disagree - a reboot clears the kernel set and
 * not these rows - so anything showing bans to an admin reads the live set.
 */

/** Failures from one address before it is banned. Higher than the per-account
 * threshold, because one address is legitimately several people behind NAT. */
const THRESHOLD = 20;
/** Failures older than this are forgotten. */
const WINDOW_MS = 15 * 60 * 1000;
/** How long a ban lasts. Long enough to end a run, short enough to wait out. */
export const BAN_SECONDS = 60 * 60;

interface AttemptRow {
  address: string;
  failures: number;
  first_fail_at: string | null;
  last_fail_at: string | null;
}

interface BanRow {
  address: string;
  reason: string;
  failures: number;
  banned_at: string;
  expires_at: string;
}

/**
 * Addresses that must never be banned, whatever they do.
 *
 * Loopback because banning it would cut the box off from itself, and the
 * trusted networks because those are the addresses an admin told us to trust -
 * locking the operator out of their own NAS to slow an attacker down is a bad
 * trade, and this project has made the reachability mistake once already.
 */
export function isBannable(address: string, trustedNetworks: string[]): boolean {
  const a = address.trim().toLowerCase();
  if (!a) return false;
  if (a === "127.0.0.1" || a === "::1" || a.startsWith("127.")) return false;
  // ::ffff:127.0.0.1 and friends.
  if (a.startsWith("::ffff:127.")) return false;
  return !trustedNetworks.some((n) => addressInCidr(a, n));
}

/**
 * Whether an address falls inside a CIDR.
 *
 * IPv4 is compared numerically. IPv6 is compared on the textual prefix, which is
 * coarse - but it only ever *widens* the never-ban set, so being imprecise here
 * fails safe: at worst an address that could have been banned isn't.
 */
export function addressInCidr(address: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  if (!net) return false;
  const bits = Number(bitsRaw);

  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (v4.test(address) && v4.test(net)) {
    const toInt = (ip: string) => ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const prefix = Number.isFinite(bits) ? Math.min(32, Math.max(0, bits)) : 32;
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (toInt(address) & mask) === (toInt(net) & mask);
  }

  if (address.includes(":") && net.includes(":")) {
    const head = net.split("::")[0] ?? "";
    return head.length === 0 || address.startsWith(head);
  }
  return false;
}

/**
 * Record a failure. Returns true when this one crosses the ban threshold.
 *
 * Counted for unknown usernames too, so probing for valid accounts costs the
 * attacker the same as guessing passwords for a known one.
 */
export function recordIpFailure(address: string, now: Date = new Date()): { failures: number; shouldBan: boolean } {
  const a = address.trim().toLowerCase();
  if (!a) return { failures: 0, shouldBan: false };

  const row = db.prepare("SELECT * FROM ip_attempts WHERE address = ?").get(a) as AttemptRow | undefined;
  const stale = row?.first_fail_at ? now.getTime() - Date.parse(row.first_fail_at) > WINDOW_MS : true;
  const failures = stale ? 1 : row!.failures + 1;
  const firstAt = stale ? now.toISOString() : row!.first_fail_at!;

  db.prepare(
    `INSERT INTO ip_attempts (address, failures, first_fail_at, last_fail_at)
     VALUES (@a, @f, @first, @last)
     ON CONFLICT(address) DO UPDATE SET failures = @f, first_fail_at = @first, last_fail_at = @last`,
  ).run({ a, f: failures, first: firstAt, last: now.toISOString() });

  return { failures, shouldBan: failures >= THRESHOLD };
}

/** A successful sign-in clears the address's history. */
export function clearIpFailures(address: string): void {
  db.prepare("DELETE FROM ip_attempts WHERE address = ?").run(address.trim().toLowerCase());
}

export function recordBan(address: string, reason: string, failures: number, seconds = BAN_SECONDS): IpBan {
  const now = new Date();
  const expires = new Date(now.getTime() + seconds * 1000);
  const row: BanRow = {
    address: address.trim().toLowerCase(),
    reason,
    failures,
    banned_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };
  db.prepare(
    `INSERT INTO ip_bans (address, reason, failures, banned_at, expires_at)
     VALUES (@address, @reason, @failures, @banned_at, @expires_at)
     ON CONFLICT(address) DO UPDATE SET
       reason = @reason, failures = @failures, banned_at = @banned_at, expires_at = @expires_at`,
  ).run(row);
  // The counter is reset so an address that comes back after its ban gets a
  // fresh allowance rather than being re-banned on its very next mistake.
  clearIpFailures(address);
  return toBan(row);
}

function toBan(r: BanRow): IpBan {
  return {
    address: r.address,
    reason: r.reason,
    failures: r.failures,
    bannedAt: r.banned_at,
    expiresAt: r.expires_at,
    active: true,
  };
}

/** Recorded bans, newest first, with expired ones dropped as we go. */
export function listRecordedBans(now: Date = new Date()): IpBan[] {
  db.prepare("DELETE FROM ip_bans WHERE expires_at <= ?").run(now.toISOString());
  const rows = db.prepare("SELECT * FROM ip_bans ORDER BY banned_at DESC").all() as BanRow[];
  return rows.map(toBan);
}

export function removeBan(address: string): boolean {
  return db.prepare("DELETE FROM ip_bans WHERE address = ?").run(address.trim().toLowerCase()).changes > 0;
}
