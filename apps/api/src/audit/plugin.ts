import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordAudit } from "../db/audit.js";

/**
 * Records consequential actions.
 *
 * This is a hook rather than a call at every call site on purpose: a log with
 * gaps is worse than no log, because it invites the assumption that an absent
 * entry means nothing happened. Every mutating request under /api is recorded
 * unless it's explicitly skipped, so a route added later is audited by default
 * instead of being silently missed.
 *
 * Routes that know something the URL doesn't - which permissions an install
 * granted, say - add it with `req.audit({ ... })`.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** Attach extra detail to this request's audit entry. Merged; call freely. */
    audit(detail: Record<string, unknown>): void;
    /** Internal: what `audit()` has collected. */
    auditDetail?: Record<string, unknown>;
  }
}

const AUDITED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Mutating routes deliberately not recorded. These are high-frequency and
 * low-consequence - an app writing its own key/value store, or a user marking a
 * notification read. Auditing them would bury the entries that matter.
 *
 * File operations are also absent: "who deleted this file" is a fair question,
 * but at NAS volumes it would swamp everything else, and the recycle bin already
 * answers the recovery half. Worth revisiting as its own feature.
 */
const SKIP_PATTERNS: RegExp[] = [
  /^\/api\/apps\/[^/]+\/storage/,
  /^\/api\/apps\/[^/]+\/files/,
  /^\/api\/apps\/[^/]+\/fetch$/,
  /^\/api\/apps\/[^/]+\/system$/,
  /^\/api\/notifications/,
  /^\/api\/prefs/,
  /^\/api\/notes/,
  /^\/api\/files/,
];

/**
 * Routes whose request body is never recorded, only what the route itself
 * reports through `req.audit()`.
 *
 * An app declares its own settings fields and marks which are secret, so the
 * key names are attacker-chosen from the audit log's point of view - an app can
 * call its API token `colour` and `SECRET_KEYS` would happily log it. The keys
 * that changed are still recorded; the values never are.
 */
const NO_BODY_PATTERNS: RegExp[] = [
  /^\/api\/apps\/[^/]+\/settings$/,
  // Carries a registry password; the route records the host and username itself.
  /^\/api\/containers\/registries$/,
];

/** Human names for the routes worth reading at a glance. */
const ACTION_NAMES: Record<string, string> = {
  "POST /api/auth/login/password": "auth.login.password",
  "POST /api/auth/passkeys/login/verify": "auth.login.passkey",
  "POST /api/auth/logout": "auth.logout",
  "POST /api/auth/setup": "auth.setup",
  "POST /api/auth/passkeys/register/verify": "auth.passkey.add",
  "DELETE /api/auth/passkeys/:id": "auth.passkey.remove",
  "POST /api/auth/login/totp": "auth.login.second_factor",
  "POST /api/auth/me/password": "auth.password.change",
  "POST /api/auth/totp/setup": "auth.2fa.setup_started",
  "POST /api/auth/totp/enable": "auth.2fa.enable",
  "POST /api/auth/totp/disable": "auth.2fa.disable",
  "POST /api/auth/totp/recovery-codes": "auth.2fa.recovery_codes_replaced",
  "DELETE /api/auth/sessions/:id": "auth.session.revoke",
  "POST /api/auth/sessions/revoke-others": "auth.session.revoke_others",

  "POST /api/admin/users": "user.create",
  "PATCH /api/admin/users/:id": "user.update",
  "DELETE /api/admin/users/:id": "user.delete",
  "POST /api/admin/users/:id/password": "user.password_reset",
  "PUT /api/apps/:id/settings": "app.settings.update",
  "POST /api/containers/registries": "container.registry.login",
  "DELETE /api/containers/registries/:host": "container.registry.remove",
  "DELETE /api/admin/users/:id/totp": "user.2fa_cleared",
  "PUT /api/admin/security/password-policy": "security.password_policy",

  "POST /api/admin/shares": "share.create",
  "PATCH /api/admin/shares/:id": "share.update",
  "DELETE /api/admin/shares/:id": "share.delete",
  "PUT /api/admin/services": "services.update",

  "POST /api/admin/storage/init": "storage.disk_init",
  "POST /api/admin/storage/expand": "storage.disk_expand",
  "POST /api/admin/storage/raid": "storage.raid.create",
  "DELETE /api/admin/storage/raid/:md": "storage.raid.destroy",
  "POST /api/admin/storage/raid/:md/add": "storage.raid.add_disk",
  "POST /api/admin/storage/raid/:md/remove": "storage.raid.remove_disk",
  "POST /api/admin/storage/volume/:label/:op": "storage.volume",
  "PUT /api/admin/storage/locations": "storage.locations",

  "POST /api/admin/tls": "tls.install",
  "POST /api/admin/tls/self-signed": "tls.self_signed",
  "POST /api/admin/power/:action": "system.power",
  "POST /api/admin/update": "system.update",
  "POST /api/admin/network/hostname": "network.hostname",
  "POST /api/admin/network/interface": "network.interface",
  "POST /api/admin/time": "system.time",
  "POST /api/admin/ssh": "ssh.toggle",
  "POST /api/admin/ssh/keys": "ssh.key.add",
  "DELETE /api/admin/ssh/keys/:id": "ssh.key.remove",
  "PUT /api/admin/smtp": "smtp.update",
  "POST /api/admin/smtp/test": "smtp.test",
  "POST /api/admin/oidc/clients": "oidc.client.create",
  "DELETE /api/admin/oidc/clients/:id": "oidc.client.delete",
  "PUT /api/admin/oidc/issuer": "oidc.issuer",

  "POST /api/apps/install": "app.install.upload",
  "POST /api/apps/install/confirm": "app.install.confirm",
  "POST /api/apps/install/cancel": "app.install.cancel",
  "DELETE /api/apps/:id": "app.uninstall",
  "POST /api/apps/:id/enabled": "app.enabled",
  "POST /api/apps/:id/trust": "app.trust",
  "PUT /api/apps/:id/schedule": "app.schedule.set",
  "DELETE /api/apps/:id/schedule/:name": "app.schedule.delete",
  "PUT /api/apps/repo": "app.repos.update",
  "POST /api/apps/repo/install": "app.install.repo",
  "POST /api/apps/repo/updates/apply": "app.update.apply",
  "PUT /api/apps/repo/updates/auto": "app.update.auto",
};

/** Fallback name for a route with no entry above, so coverage never has holes. */
function fallbackAction(method: string, url: string): string {
  const path = url
    .replace(/^\/api\//, "")
    .replace(/\/:[^/]+/g, "")
    .replace(/\//g, ".")
    .replace(/^\.|\.$/g, "");
  return `${path || "root"}.${method.toLowerCase()}`;
}

/** Body keys never written to the log, however they're nested. */
const SECRET_KEYS =
  /^(password|newpassword|currentpassword|secret|clientsecret|token|ticket|passphrase|privatekey|key|code|recoverycode|recoverycodes)$/i;

/** Strip secrets and trim bulk, so the log is safe to read and hand around. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "...";
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

function outcomeFor(status: number): "ok" | "denied" | "error" {
  if (status === 401 || status === 403) return "denied";
  if (status >= 400) return "error";
  return "ok";
}

export const auditPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest("auditDetail", undefined);
  app.decorateRequest("audit", function (this: FastifyRequest, detail: Record<string, unknown>) {
    this.auditDetail = { ...(this.auditDetail ?? {}), ...detail };
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!AUDITED_METHODS.has(req.method)) return;
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (SKIP_PATTERNS.some((re) => re.test(path))) return;

    // The route *pattern* (.../users/:id), not the concrete path, so entries group.
    const pattern = req.routeOptions?.url ?? path;
    const action = ACTION_NAMES[`${req.method} ${pattern}`] ?? fallbackAction(req.method, pattern);

    const params = req.params as Record<string, unknown> | undefined;
    const target =
      typeof params?.id === "string"
        ? params.id
        : typeof params?.name === "string"
          ? params.name
          : typeof params?.md === "string"
            ? params.md
            : null;

    // Some routes carry values whose *names* are chosen by somebody else, so
    // no key-matching redaction can be trusted on them. Those routes describe
    // themselves through req.audit() instead, and their body is never captured.
    const captureBody = !NO_BODY_PATTERNS.some((re) => re.test(path));
    const body =
      captureBody && req.body && typeof req.body === "object"
        ? (sanitize(req.body) as Record<string, unknown>)
        : undefined;
    const detail = { ...(body ?? {}), ...(req.auditDetail ?? {}) };

    try {
      recordAudit({
        actorId: req.auth?.user.id ?? null,
        // An unauthenticated request still gets an entry - a failed login is one
        // of the things you most want to see.
        actorName: req.auth?.user.username ?? "anonymous",
        actorIp: req.ip ?? null,
        action,
        target,
        detail: Object.keys(detail).length > 0 ? detail : undefined,
        outcome: outcomeFor(reply.statusCode),
        status: reply.statusCode,
      });
    } catch (err) {
      req.log.warn({ err, action }, "could not write audit entry");
    }
  });
});
