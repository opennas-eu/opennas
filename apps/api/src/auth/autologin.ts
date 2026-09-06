import type { FastifyRequest } from "fastify";
import type { AutologinConfig, User } from "@opennas/shared";
import { getSetting, setSetting } from "../db/settings.js";
import { addressInCidr } from "../db/ip-bans.js";
import { getUserById, isUserDisabled, mustChangePassword } from "../db/users.js";

/**
 * Signing in automatically from a known network.
 *
 * The case this exists for is a screen on a wall: a tablet in the hallway or a
 * spare monitor showing the dashboard, where typing a password every time the
 * browser reloads makes the whole thing useless. It is a genuine trade - an
 * account on that network needs no credential at all - so it is off by default
 * and hedged in every direction that costs nothing.
 *
 * ## What it refuses to do
 *
 * **Never an administrator.** Auto-signing-in an admin from a network means
 * everyone on the wifi is an admin, and the guest network is one router
 * misconfiguration away from that. The convenience is a dashboard on a wall,
 * which a regular account serves perfectly.
 *
 * **Never an account with two-factor enabled.** Someone who set up an
 * authenticator has said what they want; quietly stepping around it because an
 * admin ticked a box elsewhere would be a security downgrade nobody would see
 * coming.
 *
 * **Never a blank or missing network list.** "Anywhere" is not a trusted
 * console, it is an open door, so an empty list means disabled.
 *
 * **Never a disabled account, and never one holding a temporary password** -
 * both checked at sign-in time rather than only when configured, since either
 * can become true afterwards.
 *
 * ## And what it marks
 *
 * The session records `autologin` as its method, so it is visibly not a
 * password anywhere sessions are listed, and changing the configuration throws
 * every existing one away rather than leaving sessions alive that the new rules
 * would not have granted.
 */

const SETTING = "autologin";

const DEFAULT: AutologinConfig = { enabled: false, userId: null, networks: [] };

export function autologinConfig(): AutologinConfig {
  const raw = getSetting(SETTING);
  if (!raw) return DEFAULT;
  try {
    const parsed = JSON.parse(raw) as Partial<AutologinConfig>;
    return {
      enabled: parsed.enabled === true,
      userId: typeof parsed.userId === "string" && parsed.userId ? parsed.userId : null,
      networks: Array.isArray(parsed.networks) ? parsed.networks.filter((n) => typeof n === "string") : [],
    };
  } catch {
    return DEFAULT;
  }
}

export function setAutologinConfig(config: AutologinConfig): void {
  setSetting(SETTING, JSON.stringify(config));
}

/**
 * Whether a source address is one of the configured consoles.
 *
 * Loopback is *not* implicitly included. The backend talks to itself, nginx
 * proxies from loopback, and a health check comes from there too - quietly
 * treating all of that as a trusted console would sign the world in through the
 * proxy. If someone wants loopback, they can write `127.0.0.1/32`.
 */
export function addressMatches(address: string, networks: string[]): boolean {
  return networks.some((cidr) => addressInCidr(address, cidr));
}

/**
 * The user to sign in for this request, or null.
 *
 * Every gate is re-checked here rather than trusted from when the setting was
 * written: an account can be disabled, demoted to needing a password change, or
 * promoted to admin long after an admin ticked this box.
 */
export function autologinUserFor(req: FastifyRequest): User | null {
  const config = autologinConfig();
  if (!config.enabled || !config.userId || config.networks.length === 0) return null;
  if (!addressMatches(req.ip, config.networks)) return null;

  const user = getUserById(config.userId);
  if (!user) return null;
  if (user.role === "admin") return null;
  if (isUserDisabled(user.id)) return null;
  if (mustChangePassword(user.id)) return null;
  return user;
}
