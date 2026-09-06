import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { autologinUserFor } from "./autologin.js";
import type {
  AuthMethod,
  BootstrapState,
  LoginResponse,
  MeResponse,
  SessionInfo,
  SessionsResponse,
  SessionSummary,
  TotpEnableResponse,
  TotpSetupResponse,
  TotpStatus,
  User,
} from "@opennas/shared";
import { config } from "../config.js";
import { requireAuth } from "./plugin.js";
import { hashPassword, validatePasswordStrength, verifyPassword } from "./password.js";
import { screenPassword } from "./hibp.js";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  saveCredential,
  verifyAuthentication,
  verifyRegistration,
} from "./passkeys.js";
import { beginLogin, completeLogin, oidcEnabled, OIDC_PROVIDER } from "./oidc.js";
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from "./totp.js";
import { qrSvg } from "./qr.js";
import { pendingActions } from "./pending.js";
import {
  clearMfaTickets,
  confirmTotp,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  consumeMfaTicket,
  createMfaTicket,
  disableTotp,
  failMfaTicket,
  getTotp,
  noteTotpStep,
  peekMfaTicket,
  replaceRecoveryCodes,
  startTotpEnrolment,
  totpEnabled,
} from "../db/totp.js";
import {
  countUsers,
  createUser,
  getAvatarFilename,
  getPasswordHash,
  getUserById,
  getUserByUsername,
  getUserRowByUsername,
  isUserDisabled,
  markLogin,
  setAvatarFilename,
  setMustChangePassword,
  setPasswordHash,
  setPasswordPwned,
} from "../db/users.js";
import {
  createSession,
  deleteOtherSessionsForUser,
  deleteOwnedSession,
  deleteSession,
  listForUser,
} from "../db/sessions.js";
import { putChallenge, takeChallenge } from "../db/challenges.js";
import { lockoutRemainingSeconds, recordFailure, recordSuccess } from "../db/login-attempts.js";
import { clearIpFailures } from "../db/ip-bans.js";
import { noteFailedAttempt } from "../system/auto-ban.js";
import {
  deleteCredential,
  getCredentialsByUser,
  toSummary,
} from "../db/credentials.js";
import { getSettingOr, setSetting } from "../db/settings.js";
import { getUserIdByOidc, linkOidcIdentity } from "../db/oidc.js";
import { syncShareUser } from "../system/integration.js";

function sessionInfo(user: User, methods: AuthMethod[], expiresAt: string): SessionInfo {
  return { user, authMethods: methods, expiresAt, pendingActions: pendingActions(user) };
}

function meta(req: FastifyRequest) {
  return { userAgent: req.headers["user-agent"], ip: req.ip };
}

/** Issue a session + cookie and return the SessionInfo payload. */
function startSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: User,
  methods: AuthMethod[],
): SessionInfo {
  const session = createSession(user.id, methods, meta(req));
  markLogin(user.id);
  // The cookie gets the raw token; only its hash was stored.
  reply.setSessionCookie(session.token, session.expiresAt);
  return sessionInfo(user, methods, session.expiresAt);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---- Bootstrap / setup ------------------------------------------------
  app.get("/bootstrap", async (): Promise<BootstrapState> => {
    return {
      needsSetup: countUsers() === 0,
      instanceName: getSettingOr("instance_name", config.webauthn.rpName),
      oidc: oidcEnabled()
        ? { enabled: true, buttonLabel: config.oidc.buttonLabel }
        : null,
      passkeysEnabled: true,
    };
  });

  const setupSchema = z.object({
    instanceName: z.string().trim().min(1).max(64),
    username: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
    displayName: z.string().trim().min(1).max(64),
    password: z.string().min(8).max(256),
  });

  app.post("/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (countUsers() > 0) {
      return reply.code(409).send({ error: "already_setup", message: "OpenNAS is already configured." });
    }
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Invalid setup details.", fields: flatten(parsed.error) });
    }
    const { instanceName, username, displayName, password } = parsed.data;
    const strength = validatePasswordStrength(password);
    if (strength) return reply.code(400).send({ error: "weak_password", message: strength });

    const screen = await screenPassword(password); // policy is off during setup → flags only
    const user = createUser({
      username,
      displayName,
      role: "admin",
      passwordHash: await hashPassword(password),
    });
    setPasswordPwned(user.id, screen.pwned);
    setSetting("instance_name", instanceName);
    await syncShareUser(req.log, user.username, password); // SMB account (linux mode)
    const info = startSession(req, reply, user, ["password"]);
    return reply.code(201).send({ session: info } satisfies MeResponse);
  });

  // ---- Session ----------------------------------------------------------
  /**
   * Who am I?
   *
   * Also where automatic sign-in happens, deliberately: this is the first call
   * the desktop makes, so a console on a configured network arrives at the
   * desktop without a login screen appearing at all - rather than seeing one
   * flash past. Nothing happens here for anyone already signed in, or for any
   * address that isn't on the list.
   */
  app.get("/me", async (req, reply): Promise<MeResponse> => {
    if (!req.auth) {
      const auto = autologinUserFor(req);
      if (auto) {
        req.log.info({ user: auto.username, ip: req.ip }, "signed in automatically from a trusted console");
        return { session: startSession(req, reply, auto, ["autologin"]) };
      }
      return { session: null };
    }
    return {
      session: sessionInfo(req.auth.user, req.auth.session.authMethods, req.auth.session.expiresAt),
    };
  });

  app.post("/logout", async (req, reply) => {
    if (req.auth) deleteSession(req.auth.session.id);
    reply.clearSessionCookie();
    return { ok: true };
  });

  // ---- Session management (revoke your own devices) ----------------------

  /**
   * Best-effort friendly device name from a user agent. Deliberately crude - it
   * exists so a user can recognise their own devices in the list, not to do
   * analytics, and it always falls back to something rather than throwing.
   */
  function describeDevice(ua: string | null): string {
    if (!ua) return "Unknown device";
    const browser =
      /Edg\//.test(ua) ? "Edge"
      : /OPR\/|Opera/.test(ua) ? "Opera"
      : /Firefox\//.test(ua) ? "Firefox"
      : /Chrome\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari"
      : null;
    const os =
      /Android/.test(ua) ? "Android"
      : /iPhone|iPad|iPod/.test(ua) ? "iOS"
      : /Windows/.test(ua) ? "Windows"
      : /Mac OS X|Macintosh/.test(ua) ? "macOS"
      : /Linux/.test(ua) ? "Linux"
      : null;
    if (browser && os) return `${browser} on ${os}`;
    return browser ?? os ?? "Unknown device";
  }

  app.get("/sessions", { preHandler: requireAuth }, async (req): Promise<SessionsResponse> => {
    const currentId = req.auth!.session.id;
    const sessions: SessionSummary[] = listForUser(req.auth!.user.id).map((s) => ({
      id: s.id,
      device: describeDevice(s.userAgent),
      userAgent: s.userAgent,
      ip: s.ip,
      authMethods: s.authMethods,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: s.id === currentId,
    }));
    return { sessions };
  });

  // Sign out everywhere else. Declared before /sessions/:id so "others" isn't
  // swallowed by the parameterised route.
  app.post("/sessions/revoke-others", { preHandler: requireAuth }, async (req) => {
    const revoked = deleteOtherSessionsForUser(req.auth!.user.id, req.auth!.session.id);
    return { ok: true, revoked };
  });

  app.delete("/sessions/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // Revoking the current session is a logout - clear the cookie too, so the
    // browser isn't left holding a dead session id.
    const isCurrent = id === req.auth!.session.id;
    if (!deleteOwnedSession(req.auth!.user.id, id)) {
      return reply.code(404).send({ error: "not_found", message: "No such session." });
    }
    if (isCurrent) reply.clearSessionCookie();
    return { ok: true, current: isCurrent };
  });

  // ---- Profile picture --------------------------------------------------
  const AVATAR_TYPES: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  app.post("/me/avatar", { preHandler: requireAuth }, async (req, reply) => {
    const data = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB
    if (!data) return reply.code(400).send({ error: "no_file", message: "No image was uploaded." });
    const ext = AVATAR_TYPES[data.mimetype];
    if (!ext) {
      // Drain the stream so the connection isn't left hanging.
      data.file.resume();
      return reply.code(400).send({ error: "bad_type", message: "Use a PNG, JPEG, WebP or GIF image." });
    }

    const userId = req.auth!.user.id;
    const filename = `${userId}-${nanoid(8)}.${ext}`;
    try {
      await pipeline(data.file, createWriteStream(join(config.avatarsDir, filename)));
    } catch {
      return reply.code(500).send({ error: "write_failed", message: "Could not save the image." });
    }
    if (data.file.truncated) {
      await unlink(join(config.avatarsDir, filename)).catch(() => {});
      return reply.code(413).send({ error: "too_large", message: "Image is too large (max 5 MB)." });
    }

    const previous = getAvatarFilename(userId);
    setAvatarFilename(userId, filename);
    if (previous) await unlink(join(config.avatarsDir, previous)).catch(() => {});
    return { user: getUserById(userId) };
  });

  app.delete("/me/avatar", { preHandler: requireAuth }, async (req) => {
    const userId = req.auth!.user.id;
    const previous = getAvatarFilename(userId);
    setAvatarFilename(userId, null);
    if (previous) await unlink(join(config.avatarsDir, previous)).catch(() => {});
    return { user: getUserById(userId) };
  });

  // Public: serve a user's avatar image (referenced from <img src>). The ?v=
  // query (the stored filename) makes the URL change whenever the image does.
  app.get("/avatars/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const filename = getAvatarFilename(id);
    if (!filename) return reply.code(404).send({ error: "not_found", message: "No avatar." });
    const ext = filename.slice(filename.lastIndexOf(".") + 1);
    const type = Object.entries(AVATAR_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    reply.header("Cache-Control", "private, max-age=3600");
    reply.type(type);
    return reply.send(createReadStream(join(config.avatarsDir, filename)));
  });

  // ---- Password login ---------------------------------------------------
  const loginSchema = z.object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
  });

  app.post("/login/password", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Username and password required." });
    }
    const username = parsed.data.username;
    req.audit({ username });

    // Per-account lockout, complementing the per-IP rate limit above: that one
    // can't see a slow attack, or one spread across many addresses.
    const locked = lockoutRemainingSeconds(username);
    if (locked > 0) {
      return reply.code(429).send({
        error: "locked_out",
        message: `Too many failed sign-ins. Try again in ${Math.ceil(locked / 60)} minute(s).`,
      });
    }

    const row = getUserRowByUsername(username);
    // Constant-ish time: always run a hash compare even on unknown users.
    const stored = row?.password_hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
    const ok = (await verifyPassword(parsed.data.password, stored)) && row !== null;
    if (!ok || !row) {
      // Counted for unknown usernames too, so the lockout can't be used to probe
      // which accounts exist.
      recordFailure(username);
      // And against the source address, which is the axis the per-account
      // lockout can't see: one address working through many usernames keeps
      // every account under its own threshold.
      void noteFailedAttempt(req.ip, `repeated failed sign-ins (last tried "${username}")`, req.log);
      return reply.code(401).send({ error: "bad_credentials", message: "Incorrect username or password." });
    }
    if (row.disabled) {
      return reply.code(403).send({ error: "disabled", message: "This account has been disabled." });
    }
    recordSuccess(username);
    clearIpFailures(req.ip);
    const user = getUserById(row.id)!;

    // The password was right, but it isn't the whole story. Hand back a ticket
    // instead of a session - nothing about the account is reachable with it.
    if (totpEnabled(user.id)) {
      return {
        session: null,
        mfaRequired: true,
        ticket: createMfaTicket(user.id),
        recoveryCodesAvailable: countUnusedRecoveryCodes(user.id) > 0,
      } satisfies LoginResponse;
    }

    const info = startSession(req, reply, user, ["password"]);
    return { session: info } satisfies LoginResponse;
  });

  // ---- Second factor ----------------------------------------------------
  const totpLoginSchema = z.object({ ticket: z.string().min(1), code: z.string().min(1).max(32) });

  app.post("/login/totp", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = totpLoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Malformed request." });

    const userId = peekMfaTicket(parsed.data.ticket);
    if (!userId) {
      return reply.code(401).send({ error: "ticket", message: "That sign-in expired. Please enter your password again." });
    }
    const user = getUserById(userId);
    const record = getTotp(userId);
    if (!user || !record?.confirmedAt) {
      consumeMfaTicket(parsed.data.ticket);
      return reply.code(401).send({ error: "no_totp", message: "Two-factor authentication isn't set up." });
    }
    if (isUserDisabled(userId)) {
      consumeMfaTicket(parsed.data.ticket);
      return reply.code(403).send({ error: "disabled", message: "This account has been disabled." });
    }
    req.audit({ username: user.username });

    const step = verifyTotp(record.secret, parsed.data.code);
    let method: AuthMethod | null = null;
    if (step !== null) {
      // A code stays valid for its whole 30-second step and the window either
      // side of it. Refusing a step we've already honoured means one that was
      // observed in transit or over a shoulder can't be used a second time.
      if (record.lastUsedStep !== null && step <= record.lastUsedStep) {
        failMfaTicket(parsed.data.ticket);
        recordFailure(user.username);
        return reply.code(401).send({ error: "replayed", message: "That code has already been used. Wait for the next one." });
      }
      noteTotpStep(userId, step);
      method = "totp";
    } else if (consumeRecoveryCode(userId, parsed.data.code)) {
      method = "recovery-code";
    }

    if (!method) {
      failMfaTicket(parsed.data.ticket);
      // Counted against the account lockout too: without it the second factor
      // would be guessable at whatever the per-IP limit allows, indefinitely.
      recordFailure(user.username);
      return reply.code(401).send({ error: "bad_code", message: "That code isn't right." });
    }

    consumeMfaTicket(parsed.data.ticket);
    recordSuccess(user.username);
    const info = startSession(req, reply, user, ["password", method]);
    if (method === "recovery-code") {
      const left = countUnusedRecoveryCodes(userId);
      req.log.info({ userId, left }, "signed in with a recovery code");
    }
    return { session: info } satisfies LoginResponse;
  });

  // ---- Passkey registration (authenticated) -----------------------------
  app.post(
    "/passkeys/register/options",
    { preHandler: requireAuth },
    async (req) => {
      const user = req.auth!.user;
      const options = await buildRegistrationOptions(user);
      const challengeId = putChallenge(options.challenge, "registration", user.id);
      return { challengeId, options };
    },
  );

  const regVerifySchema = z.object({
    challengeId: z.string(),
    label: z.string().trim().min(1).max(48).optional(),
    response: z.any(),
  });

  app.post("/passkeys/register/verify", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = regVerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Malformed request." });
    const user = req.auth!.user;
    const challenge = takeChallenge(parsed.data.challengeId);
    if (!challenge || challenge.kind !== "registration" || challenge.userId !== user.id) {
      return reply.code(400).send({ error: "challenge", message: "Challenge expired. Try again." });
    }
    const result = await verifyRegistration(parsed.data.response, challenge.challenge);
    if (!result) return reply.code(400).send({ error: "verify", message: "Could not verify passkey." });

    saveCredential({
      id: result.credentialId,
      userId: user.id,
      publicKey: result.publicKey,
      counter: result.counter,
      transports: result.transports,
      deviceType: result.deviceType,
      backedUp: result.backedUp,
      label: parsed.data.label ?? "Passkey",
    });
    return { ok: true };
  });

  app.get("/passkeys", { preHandler: requireAuth }, async (req) => {
    return { passkeys: getCredentialsByUser(req.auth!.user.id).map(toSummary) };
  });

  app.delete("/passkeys/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = deleteCredential(id, req.auth!.user.id);
    if (!ok) return reply.code(404).send({ error: "not_found", message: "Passkey not found." });
    return { ok: true };
  });

  // ---- Passkey login (unauthenticated) ----------------------------------
  const loginOptsSchema = z.object({ username: z.string().trim().optional() });

  app.post("/passkeys/login/options", async (req) => {
    const parsed = loginOptsSchema.safeParse(req.body ?? {});
    const username = parsed.success ? parsed.data.username : undefined;
    const user = username ? getUserByUsername(username) : null;
    const options = await buildAuthenticationOptions(user?.id);
    const challengeId = putChallenge(options.challenge, "authentication", user?.id ?? null);
    return { challengeId, options };
  });

  const loginVerifySchema = z.object({ challengeId: z.string(), response: z.any() });

  app.post("/passkeys/login/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const parsed = loginVerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Malformed request." });
    const challenge = takeChallenge(parsed.data.challengeId);
    if (!challenge || challenge.kind !== "authentication") {
      return reply.code(400).send({ error: "challenge", message: "Challenge expired. Try again." });
    }
    const result = await verifyAuthentication(parsed.data.response, challenge.challenge);
    if (!result) return reply.code(401).send({ error: "verify", message: "Passkey not recognised." });
    const user = getUserById(result.credential.userId);
    if (!user) return reply.code(401).send({ error: "no_user", message: "Account no longer exists." });
    if (isUserDisabled(user.id)) return reply.code(403).send({ error: "disabled", message: "This account has been disabled." });
    const info = startSession(req, reply, user, ["passkey"]);
    return { session: info } satisfies MeResponse;
  });

  // ---- Two-factor authentication (authenticated) ------------------------
  //
  // Only the password path asks for a second factor. A passkey already proves
  // possession of a device plus a user gesture, so demanding a code after one
  // adds friction without adding a factor; an SSO sign-in is the identity
  // provider's business, and it has its own policy.

  app.get("/totp", { preHandler: requireAuth }, async (req): Promise<TotpStatus> => {
    const userId = req.auth!.user.id;
    const record = getTotp(userId);
    return {
      enabled: record?.confirmedAt != null,
      confirmedAt: record?.confirmedAt ?? null,
      recoveryCodesRemaining: countUnusedRecoveryCodes(userId),
    };
  });

  app.post("/totp/setup", { preHandler: requireAuth }, async (req, reply): Promise<TotpSetupResponse | undefined> => {
    const user = req.auth!.user;
    if (totpEnabled(user.id)) {
      return reply.code(409).send({ error: "already_enabled", message: "Two-factor authentication is already on. Turn it off first." });
    }
    // A fresh secret every time setup is opened, so an abandoned QR from an
    // earlier attempt can never be the one that ends up enabled.
    const secret = generateSecret();
    startTotpEnrolment(user.id, secret);
    const issuer = getSettingOr("instance_name", config.webauthn.rpName);
    const uri = otpauthUri(issuer, user.username, secret);
    return { secret, uri, qrSvg: qrSvg(uri) };
  });

  app.post("/totp/enable", { preHandler: requireAuth }, async (req, reply): Promise<TotpEnableResponse | undefined> => {
    const parsed = z.object({ code: z.string().min(1).max(16) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter the six-digit code." });
    const user = req.auth!.user;
    const record = getTotp(user.id);
    if (!record) return reply.code(400).send({ error: "no_setup", message: "Start setup again." });
    if (record.confirmedAt) return reply.code(409).send({ error: "already_enabled", message: "Two-factor authentication is already on." });

    const step = verifyTotp(record.secret, parsed.data.code);
    if (step === null) return reply.code(400).send({ error: "bad_code", message: "That code isn't right. Check your authenticator and try again." });

    const codes = generateRecoveryCodes();
    confirmTotp(user.id, step);
    replaceRecoveryCodes(user.id, codes);
    req.audit({ username: user.username });
    // Shown once and never again - only their hashes are kept.
    return { ok: true, recoveryCodes: codes };
  });

  app.post("/totp/recovery-codes", { preHandler: requireAuth }, async (req, reply): Promise<TotpEnableResponse | undefined> => {
    const user = req.auth!.user;
    if (!totpEnabled(user.id)) return reply.code(400).send({ error: "not_enabled", message: "Two-factor authentication isn't on." });
    const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Confirm your password." });
    if (!(await confirmOwnPassword(user.id, parsed.data.password))) {
      return reply.code(403).send({ error: "bad_password", message: "That password isn't right." });
    }
    const codes = generateRecoveryCodes();
    replaceRecoveryCodes(user.id, codes); // the old set stops working immediately
    req.audit({ username: user.username });
    return { ok: true, recoveryCodes: codes };
  });

  // POST rather than DELETE: it carries a password in the body, and a request
  // body on DELETE is the sort of thing intermediaries quietly drop.
  app.post("/totp/disable", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.auth!.user;
    const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Confirm your password." });
    // Re-authenticate: turning off a second factor from a session someone else
    // is holding would undo the whole point of having one.
    if (!(await confirmOwnPassword(user.id, parsed.data.password))) {
      return reply.code(403).send({ error: "bad_password", message: "That password isn't right." });
    }
    req.audit({ username: user.username });
    disableTotp(user.id);
    clearMfaTickets(user.id);
    return { ok: true };
  });

  /** Verify a password against the caller's own account. */
  async function confirmOwnPassword(userId: string, password: string): Promise<boolean> {
    const hash = getPasswordHash(userId);
    if (!hash) return false;
    return verifyPassword(password, hash);
  }

  // ---- Changing your own password ---------------------------------------
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(8).max(256),
  });

  app.post("/me/password", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "weak_password", message: "New password must be at least 8 characters." });
    }
    const user = req.auth!.user;
    const existing = getPasswordHash(user.id);

    // An account provisioned over SSO has no password to prove; anyone else has
    // to show they know the current one, so a borrowed session can't take the
    // account over outright.
    if (existing) {
      if (!parsed.data.currentPassword) {
        return reply.code(400).send({ error: "current_required", message: "Enter your current password." });
      }
      if (!(await verifyPassword(parsed.data.currentPassword, existing))) {
        return reply.code(403).send({ error: "bad_password", message: "Your current password isn't right." });
      }
      if (parsed.data.currentPassword === parsed.data.newPassword) {
        return reply.code(400).send({ error: "same_password", message: "Choose a password you haven't just been using." });
      }
    }

    const strength = validatePasswordStrength(parsed.data.newPassword);
    if (strength) return reply.code(400).send({ error: "weak_password", message: strength });
    const screen = await screenPassword(parsed.data.newPassword);
    if (screen.blocked) {
      return reply.code(400).send({ error: "breached_password", message: "That password appears in a known data breach - choose a different one." });
    }

    req.audit({ username: user.username });
    setPasswordHash(user.id, await hashPassword(parsed.data.newPassword));
    setPasswordPwned(user.id, screen.pwned);
    setMustChangePassword(user.id, false); // clears the temporary-password gate
    await syncShareUser(req.log, user.username, parsed.data.newPassword); // keep SMB in step

    // Other sessions were opened with the old password; a change is usually a
    // response to it having leaked, so they go.
    const revoked = deleteOtherSessionsForUser(user.id, req.auth!.session.id);
    return { ok: true, revokedSessions: revoked, session: sessionInfo(req.auth!.user, req.auth!.session.authMethods, req.auth!.session.expiresAt) };
  });

  // ---- OIDC ("Login with SSO") -----------------------------------------
  app.get("/oidc/start", async (_req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: "disabled", message: "SSO is not configured." });
    const url = await beginLogin();
    return reply.redirect(url);
  });

  app.get("/oidc/callback", async (req, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: "disabled", message: "SSO is not configured." });
    const url = new URL(req.url, config.webauthn.origin);
    try {
      const claims = await completeLogin(url);
      let userId = getUserIdByOidc(OIDC_PROVIDER, claims.subject);

      if (!userId) {
        if (!config.oidc.autoCreateUsers) {
          return reply.redirect("/?sso_error=not_provisioned");
        }
        const username = await uniqueUsername(claims.username);
        const user = createUser({
          username,
          displayName: claims.displayName,
          email: claims.email,
          role: countUsers() === 0 ? "admin" : "user",
          source: OIDC_PROVIDER,
        });
        linkOidcIdentity(OIDC_PROVIDER, claims.subject, user.id);
        userId = user.id;
      }

      if (isUserDisabled(userId)) return reply.redirect("/?sso_error=disabled");
      const user = getUserById(userId)!;
      startSession(req, reply, user, ["oidc"]);
      return reply.redirect("/");
    } catch (err) {
      req.log.error({ err }, "OIDC callback failed");
      return reply.redirect("/?sso_error=failed");
    }
  });
}

/** Ensure a unique username when auto-provisioning from SSO. */
async function uniqueUsername(base: string): Promise<string> {
  const clean = base.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 28) || "user";
  if (!getUserByUsername(clean)) return clean;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${clean}${i}`;
    if (!getUserByUsername(candidate)) return candidate;
  }
  return `${clean}-${Date.now()}`;
}

function flatten(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
