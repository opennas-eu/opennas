import type { FastifyBaseLogger } from "fastify";
import type { IpBan, IpBansResponse } from "@opennas/shared";
import {
  BAN_SECONDS,
  isBannable,
  listRecordedBans,
  recordBan,
  recordIpFailure,
  removeBan,
} from "../db/ip-bans.js";
import { activeBans, banAddress, getFirewallConfig, unbanAddress } from "./firewall.js";
import { honeypotConfig } from "./honeypot.js";

/**
 * Blocking an address that keeps failing to sign in.
 *
 * Deliberately conservative about who can be blocked. The failure mode that
 * matters here is not "an attacker got a few more tries" - it is "the admin
 * locked themselves out of their own NAS", which needs physical access to undo
 * and is a far worse outcome than a slow brute-force attempt. So loopback and
 * every trusted network are exempt outright, bans are an hour rather than
 * permanent, and the kernel expires them itself so a stopped OpenNAS can never
 * leave someone blocked.
 *
 * It also never blocks on the *first* handful of failures: one address is
 * routinely a whole household behind NAT, and a shared IP hitting a typo
 * threshold would lock out everyone in the building.
 */

/**
 * Record a failed sign-in from an address and ban it if it has earned one.
 *
 * Called without awaiting from the auth path: a failed login must not wait on
 * the firewall, and a ban arriving a moment late costs nothing.
 */
export async function noteFailedAttempt(
  address: string,
  reason: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const trusted = getFirewallConfig().trustedNetworks;
    if (!isBannable(address, trusted)) return;

    const { failures, shouldBan } = recordIpFailure(address);
    if (!shouldBan) return;

    const applied = await banAddress(address, BAN_SECONDS);
    // Recorded even when the firewall is off, so the admin can see *why* an
    // address would have been blocked and that turning the firewall on would
    // start blocking it. The UI reads the live set to say which is which.
    recordBan(address, reason, failures);
    if (applied.ok) {
      log.warn({ address, failures }, "banned an address for repeated failed sign-ins");
    } else {
      log.warn({ address, failures, err: applied.error }, "wanted to ban an address but nothing enforced it");
    }
  } catch (err) {
    // Never let ban bookkeeping turn a failed login into a 500.
    log.warn({ err, address }, "could not record a failed sign-in against the source address");
  }
}

/**
 * Bans as they stand, merging what is recorded with what the kernel is really
 * dropping.
 *
 * The two disagree after a reboot (the kernel set is empty, the rows remain), so
 * `active` comes from the live set and never from the database.
 */
export async function currentBans(): Promise<IpBansResponse> {
  const [recorded, live] = await Promise.all([
    Promise.resolve(listRecordedBans()),
    activeBans(),
  ]);
  const bans: IpBan[] = recorded.map((b) => ({ ...b, active: live.has(b.address) }));

  // An address the kernel is dropping but that OpenNAS has no row for - a ban
  // that outlived its record, or one added by hand. Better shown than hidden,
  // since it is doing real work.
  for (const [address, secondsLeft] of live) {
    if (bans.some((b) => b.address === address)) continue;
    const now = new Date();
    bans.push({
      address,
      reason: "Blocked at the firewall (no OpenNAS record - added by hand, or from before a restart).",
      failures: 0,
      bannedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + secondsLeft * 1000).toISOString(),
      active: true,
    });
  }

  return { bans, enforced: live.size > 0 || getFirewallConfig().enabled, honeypot: honeypotConfig() };
}

/** Lift a ban, in the kernel and in the record. */
export async function liftBan(address: string): Promise<void> {
  await unbanAddress(address);
  removeBan(address);
}
