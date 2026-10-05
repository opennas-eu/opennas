import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { authPlugin, requireAuth } from "./auth/plugin.js";
import { auditPlugin } from "./audit/plugin.js";
import { checkPublicPassword, servePublicLink } from "./files/public-share.js";
import { authRoutes } from "./auth/routes.js";
import { systemRoutes } from "./system/routes.js";
import { appsRoutes } from "./apps/routes.js";
import { startAppUpdateChecker } from "./apps/repo.js";
import { startDiskHealthMonitor } from "./system/health-monitor.js";
import { startScheduler } from "./apps/scheduler.js";
import { startTaskRunner } from "./system/task-runner.js";
import { startDdns } from "./system/ddns.js";
import { fileRoutes } from "./files/routes.js";
import { prefsRoutes } from "./prefs/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { packageRoutes } from "./packages/routes.js";
import { containerRoutes } from "./containers/routes.js";
import { vmRoutes } from "./vms/routes.js";
import { themeRoutes } from "./themes/routes.js";
import { noteRoutes } from "./notes/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import { websocketRoutes } from "./ws.js";
import { oidcProvider } from "./oidc/provider.js";
import { pruneOidc } from "./oidc/store.js";
import { pruneEphemeral } from "./db/index.js";
import { pendingActions, pendingGate } from "./auth/pending.js";
import { pruneOrphanAcls } from "./db/acls.js";
import { challengeStore } from "./system/acme.js";
import { startAcmeRenewal } from "./system/acme-manager.js";
import { devFrameOrigins } from "./apps/dev-apps.js";
import { pruneAudit } from "./db/audit.js";
import { isDecoyPath, noteDecoyHit } from "./system/honeypot.js";
import { canUseApp } from "./db/app-access.js";

/**
 * Is this the discovery endpoint? Compared without the query string, because
 * the CORS delegator and the PNA hook both see the raw URL.
 */
function isDiscoverPath(url: string | undefined): boolean {
  if (!url) return false;
  const q = url.indexOf("?");
  return (q === -1 ? url : url.slice(0, q)) === "/api/discover";
}

export async function buildServer(): Promise<FastifyInstance> {
  // Pretty-printing runs in a pino worker thread. Read per call rather than from
  // config so a test can turn it off: a short test process can finish before
  // that worker has drained, and the worker then holds it open indefinitely.
  const pretty = !config.isProd && process.env.OPENNAS_LOG_PRETTY !== "false";
  const app = Fastify({
    logger: {
      level: config.isProd ? "info" : "debug",
      transport: !pretty
        ? undefined
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
    },
    trustProxy: config.trustedProxies,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });

  // Security headers + CSP tuned for the SPA. The /api/files/raw route sets its
  // own stricter sandbox CSP, which overrides this for user-supplied content.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        // Apps render in iframes. Packaged ones are served from here; a
        // registered development app is loaded from its own local dev server,
        // so its origin has to be named - evaluated per request, so adding one
        // takes effect immediately rather than after a restart, which for a
        // hot-reload feature would rather miss the point.
        frameSrc: ["'self'", () => devFrameOrigins().join(" ") || "'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  });

  // Per-IP rate limiting. Generous globally; auth routes tighten this further
  // via their own route config (see auth/routes.ts).
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    hook: "onRequest",
  });

  /**
   * The decoy trap.
   *
   * Before anything else routes, because the whole point is that these paths
   * never reach a handler - and because the SPA fallback would otherwise answer
   * `/wp-login.php` with a cheerful 200 and the whole web UI, which tells a
   * scanner there is something here worth coming back to.
   *
   * The ban is fired off without awaiting: the 404 goes out immediately, and the
   * firewall call finishes in the background. A scanner that has already sent
   * its next request by then is still caught, because the address is what is
   * banned, not the connection.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!isDecoyPath(req.raw.url ?? "")) return;
    void noteDecoyHit(req.ip, req.raw.url ?? "", req.log);
    return reply.code(404).type("text/plain").send("Not Found");
  });

  // CORS: in dev, allow the Vite origin. In prod, allow the explicit
  // OPENNAS_CORS_ORIGINS list (split-origin frontend) or nothing (same-origin
  // reverse-proxy topology, where no cross-origin requests happen).
  const defaultCorsOrigin = config.isProd
    ? config.corsOrigins.length > 0
      ? config.corsOrigins
      : false
    : config.webauthn.origin;

  /**
   * The Private Network Access opt-in, which is what makes a hosted finder
   * (find-service/) possible at all.
   *
   * Chrome and Edge will not let a page on a public site touch a private
   * address without asking the device first: before the real GET they send an
   * `OPTIONS` carrying `Access-Control-Request-Private-Network: true`, and the
   * device has to answer `Access-Control-Allow-Private-Network: true` or the
   * request is blocked.
   *
   * This has to be an `onRequest` hook registered *before* @fastify/cors, not a
   * route. @fastify/cors answers preflights from its own `onRequest` hook and
   * replies immediately, so a route-level `OPTIONS /api/discover` handler never
   * runs and the header never ships. Headers set here survive that short-circuit.
   *
   * Opting in is safe precisely because the route it guards returns a constant:
   * it grants a page permission to learn that an OpenNAS exists at an address,
   * which anything on the LAN already learns from the mDNS broadcast.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!isDiscoverPath(req.raw.url)) return;
    if (req.headers["access-control-request-private-network"] === "true") {
      reply.header("Access-Control-Allow-Private-Network", "true");
    }
  });

  await app.register(cors, {
    // Per-request, so /api/discover can be open to everyone while every other
    // route keeps the narrow origin list. A single static `origin` cannot do
    // both, and `credentials: true` alongside `origin: "*"` is rejected outright
    // by browsers - so discovery turns credentials off as well.
    delegator(req, cb) {
      if (isDiscoverPath(req.raw.url)) {
        cb(null, {
          origin: "*",
          credentials: false,
          methods: ["GET", "OPTIONS"],
          // A scan is 254 addresses. Without a cached preflight that is 508
          // requests instead of 254.
          maxAge: 86400,
        });
        return;
      }
      cb(null, { origin: defaultCorsOrigin, credentials: true });
    },
  });
  await app.register(websocket);
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 * 1024, files: 50 }, // 5 GB/file, 50 files/request
  });
  await app.register(authPlugin);
  // After auth, so entries know who acted.
  await app.register(auditPlugin);

  // API surface, all under /api.
  await app.register(
    async (api) => {
      // A user with mandatory setup outstanding (temporary password, required
      // passkey) can reach only the routes that clear it. Instance-level, so it
      // covers every route below without each one opting in.
      api.addHook("preHandler", pendingGate);

      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(systemRoutes, { prefix: "/system" });
      await api.register(appsRoutes, { prefix: "/apps" });
      await api.register(fileRoutes, { prefix: "/files" });
      await api.register(prefsRoutes, { prefix: "/prefs" });
      await api.register(adminRoutes, { prefix: "/admin" });
      await api.register(packageRoutes, { prefix: "/packages" });
      await api.register(containerRoutes, { prefix: "/containers" });
      await api.register(vmRoutes, { prefix: "/vms" });
      await api.register(themeRoutes, { prefix: "/themes" });
      await api.register(noteRoutes, { prefix: "/notes" });
      await api.register(notificationRoutes, { prefix: "/notifications" });
      await api.register(websocketRoutes);
      api.get("/health", async () => ({ ok: true, version: config.version }));

      /**
       * "Is there an OpenNAS at this address?" — and nothing else.
       *
       * The finder (find-service/) has to identify OpenNAS from a browser on
       * someone else's page, which means a cross-origin read, which means CORS.
       * Every other route is deliberately closed to that, so this is the one
       * exception and it is kept as thin as it can possibly be: a constant.
       *
       * No version, no hostname, no instance name. `/api/health` returns the
       * version but is not cross-origin readable, and it stays that way — an
       * unauthenticated version banner is how someone picks which exploit to
       * try. What this does return is already shouted over mDNS to the whole
       * LAN (`%h (OpenNAS)`), so it discloses nothing new to anyone who can
       * reach the port at all.
       */
      api.get("/discover", async (_req, reply) => {
        reply.header("Cache-Control", "no-store");
        return { product: "opennas" };
      });

    },
    { prefix: "/api" },
  );

  // Clean, non-leaky error responses (Burp-style fuzzing hits this a lot).
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid", message: "Invalid request." });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ error: "rate_limited", message: "Too many requests. Please slow down." });
    }
    if (status >= 500) {
      app.log.error({ err }, "unhandled error");
      return reply.code(status).send({ error: "server_error", message: "Something went wrong." });
    }
    return reply.code(status).send({ error: "request_error", message: err.message });
  });

  await registerAppContent(app);
  await registerThemeContent(app);
  await registerShareLinks(app);
  registerAcmeChallenge(app);
  // OpenNAS-as-OIDC-provider: /.well-known/openid-configuration + /oidc/*.
  await app.register(oidcProvider);
  await registerStatic(app);

  // Periodic cleanup of expired challenges / states / sessions / OIDC artefacts.
  const prune = setInterval(() => {
    pruneEphemeral();
    pruneOidc();
    pruneAudit();
    // Folder rules name their subject polymorphically, so no foreign key can
    // clear them when a user or group goes away. Left alone, a recycled id
    // would inherit a rule written for somebody else.
    pruneOrphanAcls();
  }, 5 * 60 * 1000);
  prune.unref?.();

  // Periodic app-update check against the repository catalogue (installs them
  // too, when the admin has enabled automatic updates).
  const stopUpdateChecker = startAppUpdateChecker(app.log);

  // Daily certificate-renewal check. A no-op on the overwhelming majority of
  // installs, which never configure ACME at all.
  const stopAcmeRenewal = startAcmeRenewal(app.log);

  // Periodic S.M.A.R.T. scan that emails the alert recipient about failing disks.
  const stopHealthMonitor = startDiskHealthMonitor(app.log);

  // Once-a-minute tick that performs the work installed apps scheduled.
  const stopScheduler = startScheduler(app.log);
  const stopTaskRunner = startTaskRunner(app.log);
  const stopDdns = startDdns(app.log);

  app.addHook("onClose", async () => {
    clearInterval(prune);
    stopUpdateChecker();
    stopAcmeRenewal();
    stopHealthMonitor();
    stopScheduler();
    stopTaskRunner();
    stopDdns();
  });

  return app;
}

/**
 * The app id an `/app-content/...` URL will actually be served from, or null
 * when it can't be told safely - in which case the request is refused.
 *
 * Taking "whatever is before the first slash" is not good enough: the static
 * handler underneath is lenient about the path in ways a naive split is not, so
 * `/app-content//secretapp/x` split to an empty id (and skipped the check) while
 * still serving `secretapp`. So the path is decoded segment by segment exactly
 * once, and anything with an empty, dot or undecodable segment - or a segment
 * that decodes to a separator - is rejected outright rather than interpreted.
 */
export function appContentId(rawUrl: string): string | null {
  const q = rawUrl.search(/[?#]/);
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  if (!path.startsWith("/app-content/")) return null;
  const segments = path.slice("/app-content/".length).split("/");
  for (const [i, seg] of segments.entries()) {
    // A trailing slash on a folder is the one empty segment that's harmless.
    if (seg === "" && i === segments.length - 1 && i > 0) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (decoded === "" || decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) return null;
  }
  const id = decodeURIComponent(segments[0]!);
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) ? id : null;
}

/**
 * Serve installed third-party app content at /app-content/<id>/... These files are
 * loaded into a sandboxed iframe (opaque origin), so the iframe sandbox - not CSP
 * - is the real isolation boundary. We still send a permissive-but-bounded CSP
 * plus nosniff, and `frame-ancestors 'self'` so the OpenNAS desktop can frame it.
 * Auth-gated and scoped to appsDir; @fastify/static blocks path traversal.
 */
async function registerAppContent(app: FastifyInstance): Promise<void> {
  await app.register(
    async (content) => {
      content.addHook("preHandler", requireAuth);
      /**
       * The second half of the per-user app allow-list.
       *
       * `/app-content/<id>/...` is an app's real surface - its HTML, its scripts,
       * everything it is. Filtering the launcher without gating this would leave
       * a "restriction" anyone could step around by typing the URL, so the same
       * check the API routes make is made here, on the id in the path.
       */
      content.addHook("preHandler", async (req, reply) => {
        const appId = appContentId(req.raw.url ?? "");
        if (appId !== null && canUseApp(req.auth!.user, appId)) return;
        return reply.code(404).send({ error: "not_found", message: "No such app file." });
      });
      // An app is the user's whole session in an iframe; one with setup still
      // outstanding gets no further here than it does under /api.
      content.addHook("preHandler", async (req, reply) => {
        const pending = pendingActions(req.auth!.user);
        if (pending.length === 0) return;
        return reply.code(403).send({ error: "setup_required", message: "Finish setting up your account first.", pending });
      });
      content.addHook("onSend", async (_req, reply, payload) => {
        // The iframe runs in an OPAQUE origin (sandbox without allow-same-origin),
        // so `'self'` matches nothing - we must allow scheme sources or the app
        // can't even load the SDK (/app-sdk/opennas.js) or its own scripts. The
        // sandbox + opaque origin (not this CSP) is the isolation boundary; CSP
        // here only locks down framing so the app can't be embedded elsewhere.
        //
        // `sandbox` repeats the iframe's own sandbox (AppFrame.tsx, still without
        // allow-same-origin) for when the content is *not* in that iframe: opened
        // top-level by a link or a typed URL, it would otherwise run on the NAS
        // origin with the session cookie and the whole API at its disposal.
        // Inside the iframe the two are intersected, so this takes nothing away.
        reply.header(
          "Content-Security-Policy",
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; frame-ancestors 'self'; base-uri 'none'; " +
            "sandbox allow-scripts allow-forms allow-popups allow-modals",
        );
        reply.header("X-Content-Type-Options", "nosniff");
        return payload;
      });
      await content.register(fastifyStatic, {
        root: config.appsDir,
        prefix: "/", // combined with the plugin prefix → /app-content/...
        decorateReply: false, // the SPA static registration owns reply.sendFile
        index: false,
      });
      // Scoped to /app-content so it doesn't clash with the SPA's root 404 handler.
      content.setNotFoundHandler((_req, reply) => {
        reply.code(404).send({ error: "not_found", message: "No such app file." });
      });
    },
    { prefix: "/app-content" },
  );
}

/**
 * Serve installed theme wallpaper images at /theme-content/<id>/... Auth-gated and
 * scoped to themesDir; these are referenced from a theme's CSS `background`.
 */
async function registerThemeContent(app: FastifyInstance): Promise<void> {
  await app.register(
    async (content) => {
      content.addHook("preHandler", requireAuth);
      content.addHook("onSend", async (_req, reply, payload) => {
        reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
        reply.header("X-Content-Type-Options", "nosniff");
        return payload;
      });
      await content.register(fastifyStatic, {
        root: config.themesDir,
        prefix: "/",
        decorateReply: false,
        index: false,
      });
      content.setNotFoundHandler((_req, reply) => {
        reply.code(404).send({ error: "not_found", message: "No such theme file." });
      });
    },
    { prefix: "/theme-content" },
  );
}

/**
 * Public share links at /s/:token - unauthenticated download of a file/folder
 * someone shared, with optional expiry + password. Lives outside /api so the URL
 * is short and shareable. Parses urlencoded form bodies (the password prompt)
 * without an extra dependency.
 */
/**
 * Answers the ACME http-01 challenge.
 *
 * Deliberately outside `/api` and outside every auth hook: the whole point is
 * that a certificate authority - unauthenticated, over plain HTTP, on port 80 -
 * can read it. It only ever returns a value that `acme.ts` put there moments
 * earlier for an order in flight, and the map is emptied as soon as validation
 * finishes, so there is nothing to disclose the rest of the time.
 */
function registerAcmeChallenge(app: FastifyInstance): void {
  app.get("/.well-known/acme-challenge/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const value = challengeStore.get(token);
    if (!value) return reply.code(404).type("text/plain").send("not found");
    return reply.type("application/octet-stream").send(value);
  });
}

async function registerShareLinks(app: FastifyInstance): Promise<void> {
  await app.register(
    async (pub) => {
      pub.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err as Error);
        }
      });
      pub.get("/:token", servePublicLink);
      pub.post("/:token", checkPublicPassword);
    },
    { prefix: "/s" },
  );
}

/**
 * In production we serve the built React app and fall back to index.html for
 * client-side routes. In dev, Vite serves the UI and proxies /api here.
 */
async function registerStatic(app: FastifyInstance): Promise<void> {
  const indexHtml = join(config.webDist, "index.html");
  if (!existsSync(indexHtml)) {
    app.log.warn(
      { webDist: config.webDist },
      "No built web UI found - run `pnpm build` for production, or use Vite in dev.",
    );
    return;
  }

  await app.register(fastifyStatic, { root: config.webDist, prefix: "/" });

  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api")) {
      return reply.code(404).send({ error: "not_found", message: "No such endpoint." });
    }
    return reply.type("text/html").sendFile("index.html");
  });
}
