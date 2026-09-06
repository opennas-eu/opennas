import type { FastifyBaseLogger } from "fastify";
import type { HoneypotConfig } from "@opennas/shared";
import { getSettingOr, setSetting } from "../db/settings.js";
import { addressInCidr, isBannable, recordBan } from "../db/ip-bans.js";
import { banAddress, getFirewallConfig } from "./firewall.js";

/**
 * Decoy paths - a trap for automated scanners.
 *
 * The auto-ban counter is the right answer for someone *guessing passwords*: it
 * waits, because one address is routinely a whole household and locking a family
 * out over typos is worse than the attack. But that patience is wasted on the
 * other kind of traffic a NAS on the internet actually sees, which is a scanner
 * working through a list of exploit paths. It never touches the sign-in form, so
 * it never earns a single failure, and it walks away with a map of the box.
 *
 * The distinguishing fact is that **nothing legitimate ever requests these
 * paths**. A browser does not ask a NAS for `/wp-login.php`, and OpenNAS does not
 * serve PHP at all. So a hit is not suspicious behaviour to be weighed against a
 * threshold - it is proof, and it is treated as such: one request, one ban.
 *
 * ## Why this is safe to have on by default
 *
 * The failure everyone fears from a honeypot is banning the wrong person, so
 * this is conservative in the same three ways the auto-ban is:
 *
 * - loopback, every trusted network **and every private range** are exempt
 *   outright, so an admin poking at their own NAS from the LAN cannot be
 *   caught. The private ranges are not negotiable and not derived from the
 *   firewall's trusted-networks list, which is empty on a fresh install - the
 *   auto-ban can afford to rely on that list because it takes twenty failures
 *   to fire, and a one-strike rule cannot;
 * - the ban is the same temporary one - an hour, expired by the kernel itself -
 *   so the worst case is waiting, not a trip to the machine;
 * - and the decoy list is closed and explicit. It is not a heuristic, a rate, or
 *   a guess about what "looks like" an attack. Every entry is a path this server
 *   has no route for and no intention of adding one.
 *
 * The response is an ordinary 404. Telling a scanner it found a trap only tells
 * it to come back from a different address.
 */

const SETTING = "honeypot_enabled";

/**
 * The same hour the auto-ban uses. Long enough to end a scan run, short enough
 * that a mistake costs an admin a cup of tea rather than console access.
 */
export const DECOY_BAN_SECONDS = 60 * 60;

/**
 * Paths only ever requested by something looking for a way in.
 *
 * Exact matches, lower-cased. Kept short and boring on purpose: every entry has
 * to be one where a *false positive is impossible*, not merely unlikely. If
 * there is an argument for why some legitimate client might request one of
 * these, it does not belong here.
 */
const DECOY_PATHS = new Set([
  // WordPress, by a wide margin the most-scanned software on the internet.
  "/wp-login.php",
  "/wp-admin",
  "/wp-admin/",
  "/wp-admin/setup-config.php",
  "/wp-config.php",
  "/xmlrpc.php",
  // Credentials and config that should never be reachable over http.
  "/.env",
  "/.env.local",
  "/.env.production",
  "/.aws/credentials",
  "/.ssh/id_rsa",
  "/.htpasswd",
  "/config.php",
  "/configuration.php",
  // Admin panels for software OpenNAS is not.
  "/phpmyadmin",
  "/phpmyadmin/",
  "/pma",
  "/myadmin",
  "/admin.php",
  "/administrator/",
  "/manager/html",
  "/solr/",
  "/jenkins/login",
  // Paths from well-known remote-execution chains.
  "/boaform/admin/formlogin",
  "/hnap1/",
  "/shell",
  "/console",
]);

/**
 * Prefixes where everything beneath is a decoy.
 *
 * Only directories OpenNAS genuinely has no route under. `/.well-known/` is
 * deliberately *not* here - that is where ACME's HTTP-01 challenge lives, and
 * banning Let's Encrypt would take the machine's certificate with it.
 */
const DECOY_PREFIXES = [
  "/cgi-bin/",
  "/.git/",
  "/wp-admin/",
  "/wp-includes/",
  "/wp-content/",
  "/phpmyadmin/",
  "/administrator/",
  "/vendor/phpunit/",
];

/** Whether a request path is a decoy. */
export function isDecoyPath(rawPath: string): boolean {
  // Query and fragment are not part of the match: `/wp-login.php?x=1` is the
  // same probe as `/wp-login.php`.
  const path = (rawPath.split("?")[0]?.split("#")[0] ?? "").toLowerCase();
  if (path === "") return false;
  if (DECOY_PATHS.has(path)) return true;
  return DECOY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Ranges that can never be trapped.
 *
 * A honeypot's value is against the internet, and a one-strike ban aimed at your
 * own house is a bad trade at any hit rate. This does mean a compromised device
 * *on* the LAN can probe the NAS without being blocked - a deliberate choice:
 * it is the far less likely scenario, it is visible in the log either way, and
 * the alternative is a feature that can lock a household out of its own storage
 * over a single stray request.
 */
const NEVER_TRAPPED = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16", // link-local
  "100.64.0.0/10", // carrier-grade NAT, and what Tailscale hands out
];

/** Whether an address is one the trap must leave alone. */
export function isExemptFromTrap(address: string, trustedNetworks: string[]): boolean {
  if (!isBannable(address, trustedNetworks)) return true;
  if (NEVER_TRAPPED.some((cidr) => addressInCidr(address, cidr))) return true;
  // The IPv6 equivalents, which the CIDR list above can't express: link-local
  // (fe80::/10) and unique-local (fc00::/7, in practice everything starting fc
  // or fd). A globally-routable v6 address is still trappable - that is the
  // internet, which is what this is for.
  return /^(fe80:|fc|fd)/i.test(address.trim());
}

export function honeypotEnabled(): boolean {
  return getSettingOr(SETTING, "true") === "true";
}

export function setHoneypotEnabled(enabled: boolean): void {
  setSetting(SETTING, enabled ? "true" : "false");
}

/**
 * What the UI is told.
 *
 * The examples are real entries from the list rather than a hand-written
 * illustration, so the screen cannot drift from what the server actually
 * watches - an admin deciding whether to leave this on is entitled to see the
 * real thing.
 */
export function honeypotConfig(): HoneypotConfig {
  return {
    enabled: honeypotEnabled(),
    banSeconds: DECOY_BAN_SECONDS,
    examples: ["/wp-login.php", "/.env", "/.git/config", "/phpmyadmin", "/cgi-bin/luci"],
  };
}

/**
 * Act on a decoy hit.
 *
 * Called without awaiting from the request hook - the 404 must not wait on the
 * firewall, and a ban landing a moment late costs nothing.
 */
export async function noteDecoyHit(
  address: string,
  path: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    if (!honeypotEnabled()) return;
    const trusted = getFirewallConfig().trustedNetworks;
    if (isExemptFromTrap(address, trusted)) {
      // Still worth saying out loud: a scan coming from inside the LAN is
      // something the admin wants to know about, even though nothing is blocked.
      log.info({ address, path: describePath(path) }, "decoy path requested from an exempt address");
      return;
    }

    const shown = describePath(path);
    const applied = await banAddress(address, DECOY_BAN_SECONDS);
    // Recorded even when nothing enforced it, so the admin can see what was
    // caught and that turning the firewall on would start blocking it.
    recordBan(address, `Requested ${shown}, which only a scanner asks for.`, 1, DECOY_BAN_SECONDS);
    if (applied.ok) {
      log.warn({ address, path: shown }, "banned an address for hitting a decoy path");
    } else {
      log.warn({ address, path: shown, err: applied.error }, "decoy hit, but nothing enforced the ban");
    }
  } catch (err) {
    // A honeypot must never be able to turn a 404 into a 500.
    log.warn({ err, address }, "could not act on a decoy hit");
  }
}

/**
 * The path, made safe to store and display.
 *
 * It came off the request line, and it ends up in the database and then in the
 * Blocked addresses list. Control characters are stripped rather than escaped
 * because there is no version of this string where a newline in it is useful,
 * and a log or a table with attacker-chosen line breaks in it is harder to read
 * and easier to mislead with.
 */
export function describePath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
}
