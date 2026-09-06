import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { User } from "@opennas/shared";
import { config, isCrossOrigin, shouldUseSecureCookie } from "../config.js";
import { getValidSession, deleteSession, type SessionRecord } from "../db/sessions.js";
import { getUserById } from "../db/users.js";
import { addressMatches, autologinConfig } from "./autologin.js";

const COOKIE_NAME = "opennas_session";

export interface AuthContext {
  user: User;
  session: SessionRecord;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the auth plugin's onRequest hook; null when logged out. */
    auth: AuthContext | null;
  }
  interface FastifyReply {
    setSessionCookie(sessionId: string, expiresAt: string): void;
    clearSessionCookie(): void;
  }
}

/**
 * Wires session cookie <-> DB session <-> user resolution and exposes
 * `request.auth` plus reply cookie helpers. Cookies are httpOnly + signed.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("auth", null);

  app.decorateReply("setSessionCookie", function (this: FastifyReply, sessionId, expiresAt) {
    // `request.protocol` reflects X-Forwarded-Proto from nginx (trustProxy is on),
    // so the cookie is Secure on HTTPS and plain on HTTP - an HTTP appliance would
    // otherwise have its Secure cookie rejected by the browser.
    const isHttps = this.request.protocol === "https";
    this.setCookie(COOKIE_NAME, sessionId, {
      path: "/",
      httpOnly: true,
      // Cross-origin frontends need SameSite=None (which requires Secure);
      // otherwise Lax is the safer default for the single-origin topology.
      sameSite: isCrossOrigin() ? "none" : "lax",
      secure: shouldUseSecureCookie(isHttps),
      signed: true,
      expires: new Date(expiresAt),
    });
  });

  app.decorateReply("clearSessionCookie", function (this: FastifyReply) {
    this.clearCookie(COOKIE_NAME, { path: "/" });
  });

  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.auth = null;
    const raw = req.cookies[COOKIE_NAME];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;

    const session = getValidSession(unsigned.value);
    if (!session) return;
    const user = getUserById(session.userId);
    if (!user) {
      deleteSession(session.id);
      return;
    }

    /**
     * An automatic session is only good from where it was granted.
     *
     * "Only from these networks" has to be a standing condition rather than a
     * one-time gate, or the cookie a wall tablet was handed becomes a password
     * for anybody who can read it off the device - usable from anywhere, for as
     * long as it lasts. Nothing else in OpenNAS is address-bound, and shouldn't
     * be: a laptop legitimately moves between wifi and a phone hotspot mid-session.
     * A console does not move, and this is the one session type nobody had to
     * prove anything to obtain.
     */
    if (session.authMethods.includes("autologin")) {
      const { networks, enabled } = autologinConfig();
      if (!enabled || !addressMatches(req.ip, networks)) {
        deleteSession(session.id);
        return;
      }
    }

    req.auth = { user, session };
  });
});

/** Route guard: 401 unless authenticated. Use as a preHandler. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
  }
}

/** Route guard: 403 unless the user is an admin. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.auth) {
    await reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
    return;
  }
  if (req.auth.user.role !== "admin") {
    await reply.code(403).send({ error: "forbidden", message: "Administrator access required." });
  }
}

export { COOKIE_NAME, config };
