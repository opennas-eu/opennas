import type { FastifyReply, FastifyRequest } from "fastify";
import type { PendingAction, User } from "@opennas/shared";
import { getSettingOr } from "../db/settings.js";
import { countCredentialsByUser } from "../db/credentials.js";
import { mustChangePassword } from "../db/users.js";

/**
 * Things a signed-in user has to deal with before they can use anything else.
 *
 * Both of the policies that produce one - an admin-issued temporary password,
 * and a requirement that everyone enrol a passkey - are worthless if they only
 * show a banner: a user could ignore the prompt indefinitely, and an API client
 * would never see it at all. So the check lives in a request hook, and a gated
 * session can reach nothing but the handful of routes needed to clear it.
 *
 * The session itself stays fully valid. That matters: the user is authenticated,
 * they just aren't finished. Downgrading them to logged-out would make setting a
 * new password impossible without re-entering the old one they were given.
 */

export const REQUIRE_PASSKEY_SETTING = "require_passkey";

export function requirePasskeyEnabled(): boolean {
  return getSettingOr(REQUIRE_PASSKEY_SETTING, "false") === "true";
}

export function pendingActions(user: User): PendingAction[] {
  const pending: PendingAction[] = [];
  if (mustChangePassword(user.id)) pending.push("password");
  if (requirePasskeyEnabled() && countCredentialsByUser(user.id) === 0) pending.push("passkey");
  return pending;
}

/**
 * Routes a gated session may still call: reading who you are, signing out, and
 * the two flows that actually clear the gate. Everything else is refused.
 *
 * Matched against the path with the /api prefix already stripped by Fastify's
 * routing, so these are compared to `req.url` minus that prefix.
 */
const ALLOWED: RegExp[] = [
  /^\/auth\/me$/,
  /^\/auth\/bootstrap$/,
  /^\/auth\/logout$/,
  /^\/auth\/me\/password$/,
  /^\/auth\/avatars\//,
  /^\/auth\/passkeys(\/|$)/,
];

export async function pendingGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) return;
  const path = req.url.replace(/^\/api/, "").split("?")[0] ?? "";
  if (ALLOWED.some((re) => re.test(path))) return;

  const pending = pendingActions(req.auth.user);
  if (pending.length === 0) return;

  await reply.code(403).send({
    error: "setup_required",
    message:
      pending.includes("password")
        ? "You need to choose a new password before continuing."
        : "You need to register a passkey before continuing.",
    pending,
  });
}
