import { mkdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  AdminUser, AdminUsersResponse, UserAppAccessResponse, AutologinResponse, ZfsResponse, ZfsSnapshotsResponse, AuditResponse, ConfigBackup, ConfigRestorePlan, ConfigRestoreResult, FolderAclsResponse,
  DdnsResponse, GroupDetailResponse, SelfUpdateResponse, GroupsResponse, IpBansResponse, LogsResponse, LogSourceId, NetworkResponse, RaidResponse, SystemTasksResponse,
  ServicesResponse, SharesResponse, SmtpResponse, SshResponse, StorageLocationsResponse,
  StorageResponse, StorageTargetsResponse, TimeResponse,
  AcmeResponse, FirewallApplyResponse, FirewallResponse, QuotasResponse,
  TlsInfo, TlsResponse, UpdateResponse, VolumesResponse,
} from "@opennas/shared";
import { requireAdmin } from "../auth/plugin.js";
import { config } from "../config.js";
import { hashPassword, validatePasswordStrength } from "../auth/password.js";
import { BLOCK_PWNED_SETTING, screenPassword } from "../auth/hibp.js";
import { REQUIRE_PASSKEY_SETTING } from "../auth/pending.js";
import { clearMfaTickets, disableTotp, totpEnabled } from "../db/totp.js";
import {
  ZFS_LAYOUTS,
  createDataset,
  createPool,
  createSnapshot,
  destroyDataset,
  destroyPool,
  destroySnapshot,
  exportPool,
  importPool,
  listDatasets,
  listImportable,
  listPools,
  listSnapshots,
  rollbackSnapshot,
  scrubPool,
  setDatasetQuota,
  zfsStatus,
} from "../system/zfs.js";
import { getSettingOr, setSetting } from "../db/settings.js";
import { createClient, deleteClient, listClients, type OidcClientRecord } from "../db/oidc-clients.js";
import { validateName } from "../files/paths.js";
import {
  countAdmins,
  createUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  listUsers,
  setMustChangePassword,
  isUserDisabled,
  mustChangePassword as userMustChangePassword,
  setPasswordHash,
  setPasswordPwned,
  updateUser,
} from "../db/users.js";
import { deleteAllForUser } from "../db/sessions.js";
import { countCredentialsByUser } from "../db/credentials.js";
import {
  createShare,
  deleteShare,
  ensureQuotaProjectId,
  getShareById,
  getShareRowByName,
  listShares,
  setGroupPermissions,
  setPermissions,
  updateShare,
} from "../db/shares.js";
import {
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupByName,
  listGroups,
  listMembers,
  setMembers,
  updateGroup,
  usernamesInGroup,
} from "../db/groups.js";
import { deleteAcl, listAcls, normalizeAclPath, pruneOrphanAcls, setAcl } from "../db/acls.js";
import { MAX_NFS_RULES, deleteNfsRule, isValidNfsClient, listNfsRules, setNfsRule } from "../db/nfs-rules.js";
import {
  MAX_TASKS,
  countSystemTasks,
  createSystemTask,
  deleteSystemTask,
  getSystemTask,
  listSystemTasks,
  markTaskStarted,
  updateSystemTask,
} from "../db/system-tasks.js";
import { runTask } from "../system/task-runner.js";
import {
  applyGeneratedConfigs,
  detectDaemons,
  generateExports,
  generateSmbConf,
  getServicesConfig,
  setServicesConfig,
  shareBasePath,
} from "../services/services.js";
import {
  applyFirewall,
  applyServiceStates,
  createRaid,
  destroyRaid,
  disableFirewall,
  enableQuotas,
  firewallStatus,
  getShareQuota,
  quotaStatus,
  setShareQuota,
  raidAddDisk,
  raidRemoveDisk,
  eraseVolume,
  expandDisk,
  initializeDisk,
  mountVolume,
  powerAction,
  regenerateSelfSignedCert,
  reloadFileServices,
  reloadWebProxy,
  removeShareGroup,
  removeShareUser,
  runSystemUpdate,
  setHostname,
  setInterface,
  setNtpServer,
  setTimezone,
  syncShareGroup,
  syncShareUser,
  unmountVolume,
} from "../system/integration.js";
import { listRaidArrays, listStorage, listStorageWithHealth, listVolumes } from "../system/storage.js";
import { getStorageLocations, listStorageTargets, setStorageLocations, storageDefaults } from "../system/storage-paths.js";
import { getNetwork, getTimeInfo, getUpdateInfo } from "../system/management.js";
import { addSshKey, authorizedKeysBody, getSshConfig, removeSshKey } from "../system/ssh.js";
import { applySshKeys, setSshService } from "../system/integration.js";
import { getSmtpConfig, sendTestMail, setSmtpConfig } from "../system/smtp.js";
import {
  acmeAvailable,
  acmeTermsOfService,
  getAcmeSettings,
  getAcmeState,
  isValidDomain,
  runIssuance,
  setAcmeSettings,
} from "../system/acme-manager.js";
import {
  FIREWALL_SERVICES,
  generateRuleset,
  getFirewallConfig,
  isValidCidr,
  setFirewallConfig,
} from "../system/firewall.js";
import { currentBans, liftBan } from "../system/auto-ban.js";
import { setHoneypotEnabled } from "../system/honeypot.js";
import { ALWAYS_AVAILABLE, allowedAppIds, isAppsRestricted, setAppAccess } from "../db/app-access.js";
import { appsForRole } from "../apps/registry.js";
import { autologinConfig, setAutologinConfig } from "../auth/autologin.js";
import { deleteAutologinSessions } from "../db/sessions.js";
import {
  applyUpdate,
  channelUrl,
  checkForUpdate,
  rollbackUpdate,
  setChannelUrl,
  updateState,
  updateSupported,
} from "../system/updater.js";
import { runOnce as runDdnsOnce, setConfig as setDdnsConfig, status as ddnsStatus } from "../system/ddns.js";
import { logSources, readLog } from "../system/logs.js";
import { auditActions, listAudit } from "../db/audit.js";
import { applyRestore, exportConfig, planRestore } from "../system/config-backup.js";
import { clearLockout, listLockouts } from "../db/login-attempts.js";

const usernameRe = /^[a-zA-Z0-9_.-]+$/;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  // ===================== Users =====================
  app.get("/users", async (): Promise<AdminUsersResponse> => {
    const users: AdminUser[] = listUsers().map((u) => ({
      ...u.user,
      disabled: u.disabled,
      passkeyCount: u.passkeyCount,
      activeSessions: u.activeSessions,
      passwordPwned: u.passwordPwned,
      twoFactorEnabled: u.twoFactorEnabled,
      mustChangePassword: u.mustChangePassword,
      appsRestricted: u.user.role !== "admin" && isAppsRestricted(u.user.id),
    }));
    return { users };
  });

  // ---- Which apps a user may use -------------------------------------------

  app.get("/users/:id/apps", async (req, reply): Promise<UserAppAccessResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    const user = getUserById(id);
    if (!user) return reply.code(404).send({ error: "not_found", message: "No such user." }) as never;
    return {
      userId: id,
      restricted: user.role !== "admin" && isAppsRestricted(id),
      appIds: allowedAppIds(id),
      // The choices are the apps this user's *role* could reach, not every app
      // on the machine - offering an admin-only app in the list would suggest
      // ticking it would grant something, and it wouldn't.
      available: appsForRole(user.role).map((a) => ({ id: a.id, name: a.name, category: a.category })),
      alwaysAvailable: [...ALWAYS_AVAILABLE],
    };
  });

  app.put("/users/:id/apps", async (req, reply): Promise<UserAppAccessResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    const user = getUserById(id);
    if (!user) return reply.code(404).send({ error: "not_found", message: "No such user." }) as never;

    const parsed = z
      .object({ restricted: z.boolean(), appIds: z.array(z.string().min(1).max(64)).max(200) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide restricted and appIds." }) as never;
    }

    // Refused rather than quietly ignored. An admin restricted out of Control
    // Panel could not undo it from the web interface, and on a headless NAS the
    // next step is a keyboard and a screen - so nobody gets to set this and
    // believe it took.
    if (user.role === "admin" && parsed.data.restricted) {
      return reply.code(400).send({
        error: "admin_unrestrictable",
        message:
          "An administrator's apps can't be limited - they'd have no way to undo it. Change the account to a regular user first.",
      }) as never;
    }

    req.audit({ user: user.username, restricted: parsed.data.restricted, apps: parsed.data.appIds });
    setAppAccess(id, parsed.data);
    return {
      userId: id,
      restricted: user.role !== "admin" && isAppsRestricted(id),
      appIds: allowedAppIds(id),
      available: appsForRole(user.role).map((a) => ({ id: a.id, name: a.name, category: a.category })),
      alwaysAvailable: [...ALWAYS_AVAILABLE],
    };
  });

  // ---- Automatic sign-in from a trusted console ----------------------------

  /** Why an account can't be the autologin one, or "" if it can. */
  function autologinIneligibility(u: { id: string; role: string }): string {
    if (u.role === "admin") {
      return "Administrators can't sign in automatically - everyone on that network would be an admin.";
    }
    if (isUserDisabled(u.id)) return "This account is disabled.";
    if (totpEnabled(u.id)) return "This account uses an authenticator app, which automatic sign-in would step around.";
    if (userMustChangePassword(u.id)) return "This account still has a temporary password to replace.";
    return "";
  }

  function autologinPayload(): AutologinResponse {
    return {
      autologin: autologinConfig(),
      candidates: listUsers().map(({ user }) => {
        const reason = autologinIneligibility(user);
        return {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          eligible: reason === "",
          reason,
        };
      }),
    };
  }

  app.get("/security/autologin", async (): Promise<AutologinResponse> => autologinPayload());

  app.put("/security/autologin", async (req, reply): Promise<AutologinResponse | undefined> => {
    const parsed = z
      .object({
        enabled: z.boolean(),
        userId: z.string().min(1).max(64).nullable(),
        networks: z.array(z.string().trim().min(1).max(64)).max(16),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide enabled, userId and networks." }) as never;
    }
    const { enabled, userId, networks } = parsed.data;

    if (enabled) {
      if (!userId) {
        return reply.code(400).send({ error: "no_user", message: "Choose the account to sign in." }) as never;
      }
      const user = getUserById(userId);
      if (!user) return reply.code(404).send({ error: "not_found", message: "No such user." }) as never;
      const why = autologinIneligibility(user);
      if (why) return reply.code(400).send({ error: "not_eligible", message: why }) as never;

      const bad = networks.find((n) => !isValidCidr(n));
      if (bad) {
        return reply.code(400).send({
          error: "bad_network",
          message: `"${bad}" isn't a network - write it like 192.168.1.0/24.`,
        }) as never;
      }
      // The network list is the entire restriction, so an empty one is not a
      // configuration to save - it is the difference between "the hallway
      // tablet" and "anybody who can reach the box".
      if (networks.length === 0) {
        return reply.code(400).send({
          error: "no_networks",
          message: "Name at least one network. Without one this would sign in anybody who can reach OpenNAS.",
        }) as never;
      }
    }

    req.audit({ enabled, userId, networks });
    setAutologinConfig({ enabled, userId: userId ?? null, networks });
    // Sessions minted under the old rules would otherwise outlive them.
    const dropped = deleteAutologinSessions();
    if (dropped > 0) req.log.info({ dropped }, "cleared automatic-sign-in sessions after a rule change");
    return autologinPayload();
  });

  // Account policy: breached-password blocking (HaveIBeenPwned) and whether
  // every account must carry a passkey. Reading is admin (gated above).
  const readPolicy = () => ({
    blockPwned: getSettingOr(BLOCK_PWNED_SETTING, "false") === "true",
    requirePasskey: getSettingOr(REQUIRE_PASSKEY_SETTING, "false") === "true",
  });

  app.get("/security/password-policy", async () => readPolicy());
  app.put("/security/password-policy", async (req, reply) => {
    const parsed = z
      .object({ blockPwned: z.boolean().optional(), requirePasskey: z.boolean().optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide blockPwned and/or requirePasskey." });
    if (parsed.data.blockPwned !== undefined) setSetting(BLOCK_PWNED_SETTING, parsed.data.blockPwned ? "true" : "false");
    if (parsed.data.requirePasskey !== undefined) {
      // Turning this on locks *this admin* out of everything but passkey
      // enrolment too, which is the correct behaviour but a nasty surprise if
      // they can't enrol - so refuse rather than strand the person who asked.
      if (parsed.data.requirePasskey && countCredentialsByUser(req.auth!.user.id) === 0) {
        return reply.code(400).send({
          error: "no_passkey",
          message: "Register a passkey on your own account first - otherwise this would lock you out of everything but enrolment.",
        });
      }
      setSetting(REQUIRE_PASSKEY_SETTING, parsed.data.requirePasskey ? "true" : "false");
    }
    req.audit(parsed.data);
    return readPolicy();
  });

  // ---- OIDC identity provider: registered relying parties (clients) -------
  const toClientInfo = (c: OidcClientRecord) => ({ clientId: c.clientId, name: c.name, redirectUris: c.redirectUris, scopes: c.scopes, createdAt: c.createdAt });
  const issuerUrl = (req: { protocol: string; headers: { host?: string } }) =>
    getSettingOr("oidc_issuer", "").replace(/\/+$/, "") || `${req.protocol}://${req.headers.host}`;

  app.get("/oidc/clients", async (req) => ({ clients: listClients().map(toClientInfo), issuer: issuerUrl(req) }));

  app.post("/oidc/clients", async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(64),
        redirectUris: z.array(z.string().url().max(512)).min(1).max(10),
        scopes: z.array(z.enum(["openid", "profile", "email"])).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a name and at least one valid redirect URI." });
    const scopes = [...new Set(["openid", ...(parsed.data.scopes ?? ["profile", "email"])])];
    const { record, secret } = createClient(parsed.data.name, parsed.data.redirectUris, scopes);
    return reply.code(201).send({ client: toClientInfo(record), clientSecret: secret });
  });

  app.delete("/oidc/clients/:id", async (req, reply) => {
    if (!deleteClient((req.params as { id: string }).id)) return reply.code(404).send({ error: "not_found", message: "No such client." });
    return { ok: true };
  });

  app.put("/oidc/issuer", async (req, reply) => {
    const parsed = z.object({ issuer: z.string().url().max(255).or(z.literal("")) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter a valid issuer URL (or empty to auto-detect)." });
    setSetting("oidc_issuer", parsed.data.issuer.replace(/\/+$/, ""));
    return { issuer: issuerUrl(req) };
  });

  const createSchema = z.object({
    username: z.string().trim().min(2).max(32).regex(usernameRe),
    displayName: z.string().trim().min(1).max(64),
    email: z.string().email().optional().or(z.literal("")).transform((v) => v || null),
    role: z.enum(["admin", "user"]),
    password: z.string().min(8).max(256),
    temporaryPassword: z.boolean().optional(),
  });

  app.post("/users", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Invalid user details.", fields: flatten(parsed.error) });
    }
    if (getUserByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: "exists", message: "That username is taken." });
    }
    const strength = validatePasswordStrength(parsed.data.password);
    if (strength) return reply.code(400).send({ error: "weak_password", message: strength });
    const screen = await screenPassword(parsed.data.password);
    if (screen.blocked) return reply.code(400).send({ error: "breached_password", message: "That password appears in a known data breach - choose a different one." });

    const user = createUser({
      username: parsed.data.username,
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      role: parsed.data.role,
      passwordHash: await hashPassword(parsed.data.password),
    });
    setPasswordPwned(user.id, screen.pwned);
    // A password an admin picked and then said out loud is not a secret. Marking
    // it temporary holds the account at a change-password gate on first sign-in.
    if (parsed.data.temporaryPassword) setMustChangePassword(user.id, true);
    req.audit({ username: user.username, temporaryPassword: parsed.data.temporaryPassword === true });
    await syncShareUser(req.log, user.username, parsed.data.password); // SMB account (linux mode)
    return reply.code(201).send({ user });
  });

  const updateSchema = z.object({
    displayName: z.string().trim().min(1).max(64).optional(),
    email: z.string().email().or(z.literal("")).transform((v) => v || null).optional(),
    role: z.enum(["admin", "user"]).optional(),
    disabled: z.boolean().optional(),
  });

  app.patch("/users/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const target = getUserById(id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "User not found." });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid changes." });

    const isSelf = req.auth!.user.id === id;
    const demoting = parsed.data.role === "user" || parsed.data.disabled === true;
    // Never let the last active admin be demoted or disabled.
    if (target.role === "admin" && demoting && countAdmins(id) === 0) {
      return reply.code(400).send({ error: "last_admin", message: "This is the last administrator." });
    }
    if (isSelf && parsed.data.disabled === true) {
      return reply.code(400).send({ error: "self", message: "You can't disable your own account." });
    }
    req.audit({ username: target.username, from: { role: target.role }, to: parsed.data });
    updateUser(id, parsed.data);
    if (parsed.data.disabled === true) deleteAllForUser(id); // kick active sessions
    return { user: getUserById(id) };
  });

  app.post("/users/:id/password", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const target = getUserById(id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "User not found." });
    const parsed = z
      .object({ password: z.string().min(8).max(256), temporary: z.boolean().optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "weak_password", message: "Password must be at least 8 characters." });
    const screen = await screenPassword(parsed.data.password);
    if (screen.blocked) return reply.code(400).send({ error: "breached_password", message: "That password appears in a known data breach - choose a different one." });
    const temporary = parsed.data.temporary !== false; // an admin-set password defaults to temporary
    req.audit({ username: target.username, temporary });
    setPasswordHash(id, await hashPassword(parsed.data.password));
    setPasswordPwned(id, screen.pwned);
    setMustChangePassword(id, temporary);
    await syncShareUser(req.log, target.username, parsed.data.password); // keep SMB password in sync
    return { ok: true, temporary };
  });

  /**
   * Clear a user's two-factor enrolment. This is the lost-phone path: without
   * it, an account whose authenticator is gone and whose recovery codes are
   * lost can only be recovered by deleting it. Audited, and it drops any
   * half-finished sign-in so a pending ticket can't be exchanged afterwards.
   */
  app.delete("/users/:id/totp", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const target = getUserById(id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "User not found." });
    if (!totpEnabled(id)) return reply.code(400).send({ error: "not_enabled", message: "That account doesn't use two-factor authentication." });
    req.audit({ username: target.username });
    disableTotp(id);
    clearMfaTickets(id);
    return { ok: true };
  });

  app.delete("/users/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const target = getUserById(id);
    if (!target) return reply.code(404).send({ error: "not_found", message: "User not found." });
    if (id === req.auth!.user.id) return reply.code(400).send({ error: "self", message: "You can't delete your own account." });
    if (target.role === "admin" && countAdmins(id) === 0) {
      return reply.code(400).send({ error: "last_admin", message: "This is the last administrator." });
    }
    req.audit({ username: target.username, role: target.role });
    deleteUser(id);
    await removeShareUser(req.log, target.username); // drop SMB/system account (linux mode)
    return { ok: true };
  });

  // ===================== Shared folders =====================
  // Data volumes a new share can be placed on (for the create-share picker).
  app.get("/volumes", async (): Promise<VolumesResponse> => ({ volumes: await listVolumes() }));

  app.get("/shares", async (): Promise<SharesResponse> => {
    const shares = listShares();
    // Attach best-effort size for each share folder (computed in parallel).
    await Promise.all(
      shares.map(async (s) => {
        s.sizeBytes = await folderSize(shareBasePath(s)).catch(() => null);
        // Usage comes from the filesystem's own accounting, which is both
        // cheaper and more truthful than walking the tree.
        if (s.volume && s.quotaProjectId) {
          const q = await getShareQuota(s.volume, s.quotaProjectId).catch(() => null);
          if (q) s.quotaUsedBytes = q.usedBytes;
        }
      }),
    );
    return { shares };
  });

  const shareCreateSchema = z.object({
    name: z.string().trim().min(1).max(64),
    comment: z.string().max(255).optional(),
    guestAccess: z.enum(["none", "ro", "rw"]).optional(),
    smbEnabled: z.boolean().optional(),
    nfsEnabled: z.boolean().optional(),
    browseable: z.boolean().optional(),
    recycleEnabled: z.boolean().optional(),
    timeMachineEnabled: z.boolean().optional(),
    volume: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  });

  app.post("/shares", async (req, reply) => {
    const parsed = shareCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid share." });
    let name: string;
    try {
      name = validateName(parsed.data.name);
    } catch {
      return reply.code(400).send({ error: "bad_name", message: "Share name can't contain slashes or special path characters." });
    }
    if (getShareRowByName(name)) return reply.code(409).send({ error: "exists", message: "A share with that name already exists." });

    // If a volume was chosen, make sure it's actually a mounted data volume.
    const volume = parsed.data.volume;
    if (volume) {
      const volumes = await listVolumes();
      if (!volumes.some((v) => v.label === volume)) {
        return reply.code(400).send({ error: "bad_volume", message: "That storage volume isn't available." });
      }
    }

    const share = createShare({ ...parsed.data, name });
    try {
      await mkdir(shareBasePath(share), { recursive: true });
    } catch (err) {
      // Roll back the row so we don't leave a share pointing at a folder we
      // couldn't create (e.g. an unwritable volume mount).
      deleteShare(share.id);
      req.log.error({ err, name, volume }, "could not create share directory");
      return reply.code(500).send({ error: "mkdir_failed", message: "Couldn't create the folder on that volume." });
    }
    applyGeneratedConfigs(req.log); // wire the new share into smb.conf/exports now
    await reloadFileServices(req.log);
    return reply.code(201).send({ share });
  });

  /** Attach live quota usage to one share, when it has a quota at all. */
  async function withQuotaUsage(share: ReturnType<typeof getShareById>) {
    if (!share || !share.volume || !share.quotaProjectId) return share;
    const q = await getShareQuota(share.volume, share.quotaProjectId).catch(() => null);
    if (q) share.quotaUsedBytes = q.usedBytes;
    return share;
  }

  const shareUpdateSchema = z.object({
    comment: z.string().max(255).optional(),
    guestAccess: z.enum(["none", "ro", "rw"]).optional(),
    smbEnabled: z.boolean().optional(),
    nfsEnabled: z.boolean().optional(),
    browseable: z.boolean().optional(),
    recycleEnabled: z.boolean().optional(),
    timeMachineEnabled: z.boolean().optional(),
    // 0 removes the cap; capped at 1 PiB so a typo can't overflow the helper.
    quotaBytes: z.number().int().min(0).max(1024 ** 5).optional(),
    permissions: z.array(z.object({ userId: z.string(), level: z.enum(["ro", "rw"]) })).optional(),
    groupPermissions: z.array(z.object({ groupId: z.string(), level: z.enum(["ro", "rw"]) })).optional(),
  });

  app.patch("/shares/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getShareById(id)) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    const parsed = shareUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid changes." });
    const { permissions, groupPermissions, ...fields } = parsed.data;
    if (groupPermissions?.some((g) => !getGroupById(g.groupId))) {
      return reply.code(400).send({ error: "bad_group", message: "One of those groups no longer exists." });
    }
    updateShare(id, fields);
    if (permissions) setPermissions(id, permissions);
    if (groupPermissions) setGroupPermissions(id, groupPermissions);
    // A cap is only real once the filesystem knows about it, so report a
    // failure rather than storing a number that isn't enforcing anything.
    let quotaWarning: string | null = null;
    if (fields.quotaBytes !== undefined) quotaWarning = await applyShareQuota(req.log, id);
    applyGeneratedConfigs(req.log);
    await reloadFileServices(req.log);
    return { share: await withQuotaUsage(getShareById(id)), quotaWarning };
  });

  // ---- Per-share quotas ---------------------------------------------------
  //
  // Enforced by the filesystem, not by OpenNAS, so the cap holds for SMB and
  // NFS writes too - not just what goes through the web UI. Project quotas are
  // the only kind that means anything here: Samba maps every connection to the
  // one `opennas` account, so a per-user filesystem quota would charge every
  // byte anybody wrote to the same user. That's stated in the response rather
  // than left for the UI to guess at.
  const PER_USER_NOTE =
    "Per-user quotas aren't offered: every SMB connection is mapped to a single service account, so the filesystem " +
    "cannot tell your users apart and every byte would be charged to the same one. Cap the shared folder instead.";

  app.get("/quotas", async (): Promise<QuotasResponse> => {
    const volumes = await listVolumes();
    const statuses = await Promise.all(
      volumes.map(async (v) => ({ volume: v.label, ...(await quotaStatus(v.label)) })),
    );
    return { volumes: statuses, perUserNote: PER_USER_NOTE };
  });

  app.post("/quotas/:volume/enable", async (req, reply) => {
    const parsed = z.object({ volume: z.string().regex(/^[a-zA-Z0-9_-]+$/) }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid volume." });
    const before = await quotaStatus(parsed.data.volume);
    if (!before.supported) {
      return reply.code(400).send({ error: "unsupported", message: before.reason || "Quotas aren't supported there." });
    }
    req.audit({ volume: parsed.data.volume });
    // This unmounts and remounts the volume, so anything reading from it will
    // see a brief interruption - the UI says so before offering the button.
    const res = await enableQuotas(req.log, parsed.data.volume);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Could not enable quotas." });
    return { ok: true, status: { volume: parsed.data.volume, ...(await quotaStatus(parsed.data.volume)) } };
  });

  /** Push a share's stored cap down to the filesystem. Returns an error message, or null. */
  async function applyShareQuota(log: typeof app.log, shareId: string): Promise<string | null> {
    const share = getShareById(shareId);
    if (!share) return "Share not found.";
    const volume = share.volume ?? "";
    if (!volume) {
      return "Quotas need the share to live on a data volume - the default share root isn't one.";
    }
    const status = await quotaStatus(volume);
    if (!status.supported) return status.reason || "That volume can't carry quotas.";
    if (!status.active) return "Turn quotas on for that volume first.";
    const projectId = ensureQuotaProjectId(shareId);
    const res = await setShareQuota(log, volume, share.name, projectId, share.quotaBytes);
    return res.ok ? null : (res.error ?? "Could not apply the quota.");
  }

  // ---- Folder-level access rules ----------------------------------------
  //
  // These are enforced by OpenNAS itself - File Station, search, downloads,
  // share links, the recycle bin - because every one of those goes through the
  // same `pathAccess` check. SMB and NFS cannot express them: Samba maps every
  // connection to the service account, so it has no per-user identity below the
  // share to act on. The UI says so plainly rather than implying otherwise.

  // ---- Scheduled maintenance ------------------------------------------------

  // The task kinds are a fixed catalogue, not a command to run - scheduling an
  // arbitrary script from a web UI is a short path from an admin session to root
  // code execution, and these cover what a NAS actually needs on a timer.

  const scheduleSchema = z.object({
    name: z.string().trim().min(1).max(64),
    kind: z.enum(["config-backup", "scrub", "trim", "smart-test"]),
    target: z.string().trim().max(128).default(""),
    frequency: z.enum(["daily", "weekly", "monthly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6).default(0),
    dayOfMonth: z.number().int().min(1).max(31).default(1),
    enabled: z.boolean().default(true),
  });

  /** A target that matches the kind - checked here as well as in the runner. */
  function badTarget(kind: string, target: string): string | null {
    if (kind === "config-backup") return null; // needs none
    if (kind === "smart-test") {
      return /^\/dev\/[a-zA-Z0-9/_-]{1,64}$/.test(target) ? null : "Choose a disk for the SMART test.";
    }
    return /^[a-zA-Z0-9_-]{1,64}$/.test(target) ? null : "Choose a data volume for this task.";
  }

  app.get("/tasks", async (): Promise<SystemTasksResponse> => {
    const [volumes, disks] = await Promise.all([listVolumes(), listStorage()]);
    return {
      tasks: listSystemTasks(),
      volumes: volumes.map((v) => v.label).filter((l): l is string => Boolean(l)),
      // Every disk, including the system one: a SMART test is read-only and the
      // disk holding the OS is the one whose health matters most.
      disks: disks.map((d) => d.name).filter((n): n is string => Boolean(n)),
    };
  });

  app.post("/tasks", async (req, reply) => {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Give the task a name, a kind and a time." });
    }
    const problem = badTarget(parsed.data.kind, parsed.data.target);
    if (problem) return reply.code(400).send({ error: "bad_target", message: problem });
    if (countSystemTasks() >= MAX_TASKS) {
      return reply.code(409).send({ error: "too_many", message: `At most ${MAX_TASKS} scheduled tasks.` });
    }
    req.audit({ name: parsed.data.name, kind: parsed.data.kind, target: parsed.data.target });
    return reply.code(201).send({ task: createSystemTask(parsed.data) });
  });

  app.patch("/tasks/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = getSystemTask(id);
    if (!existing) return reply.code(404).send({ error: "not_found", message: "No such task." });
    const parsed = scheduleSchema.partial().omit({ kind: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid changes." });
    if (parsed.data.target !== undefined) {
      const problem = badTarget(existing.kind, parsed.data.target);
      if (problem) return reply.code(400).send({ error: "bad_target", message: problem });
    }
    req.audit({ task: id, ...parsed.data });
    return { task: updateSystemTask(id, parsed.data) };
  });

  app.delete("/tasks/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getSystemTask(id)) return reply.code(404).send({ error: "not_found", message: "No such task." });
    req.audit({ task: id });
    deleteSystemTask(id);
    return { ok: true };
  });

  /** Run a task now, without disturbing its schedule. */
  app.post("/tasks/:id/run", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = getSystemTask(id);
    if (!task) return reply.code(404).send({ error: "not_found", message: "No such task." });
    if (task.lastStatus === "running") {
      return reply.code(409).send({ error: "busy", message: "That task is already running." });
    }
    req.audit({ task: id, kind: task.kind });
    // Started, not awaited: a scrub takes hours and the request must not.
    markTaskStarted(id);
    void runTask(task, req.log);
    return reply.code(202).send({ ok: true });
  });

  // ---- NFS export rules -----------------------------------------------------

  // NFS authorises by address, not by user: the client asserts its own uids and
  // the server takes its word for it. So these rules *are* the access control,
  // and every change regenerates /etc/exports immediately.

  app.post("/shares/:id/nfs-rules", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getShareById(id)) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    const parsed = z
      .object({
        network: z.string().trim().min(1).max(255),
        level: z.enum(["ro", "rw"]),
        rootSquash: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Give a client address and an access level." });
    }
    if (!isValidNfsClient(parsed.data.network)) {
      return reply.code(400).send({
        error: "bad_client",
        message: "Use an address, a network like 192.168.1.0/24, a hostname, or * for anyone.",
      });
    }
    req.audit({ share: id, network: parsed.data.network, level: parsed.data.level, rootSquash: parsed.data.rootSquash });
    const rule = setNfsRule({ shareId: id, ...parsed.data });
    if (!rule) {
      return reply.code(409).send({ error: "too_many", message: `A share may have at most ${MAX_NFS_RULES} NFS rules.` });
    }
    applyGeneratedConfigs(req.log);
    return reply.code(201).send({ rules: listNfsRules(id) });
  });

  app.delete("/shares/:id/nfs-rules/:ruleId", async (req, reply) => {
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    if (!getShareById(id)) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    req.audit({ share: id, rule: ruleId });
    deleteNfsRule(id, ruleId);
    applyGeneratedConfigs(req.log);
    return { rules: listNfsRules(id) };
  });

  app.get("/shares/:id/acls", async (req, reply): Promise<FolderAclsResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    if (!getShareById(id)) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    pruneOrphanAcls();
    return { acls: listAcls(id) };
  });

  const aclSchema = z.object({
    path: z.string().min(1).max(1024),
    subjectType: z.enum(["user", "group"]),
    subjectId: z.string().min(1),
    level: z.enum(["none", "ro", "rw"]),
  });

  app.post("/shares/:id/acls", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const share = getShareById(id);
    if (!share) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    const parsed = aclSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid rule." });

    const subjectExists = parsed.data.subjectType === "user"
      ? getUserById(parsed.data.subjectId) !== null
      : getGroupById(parsed.data.subjectId) !== null;
    if (!subjectExists) return reply.code(400).send({ error: "bad_subject", message: "That user or group no longer exists." });

    let path: string;
    try {
      path = normalizeAclPath(parsed.data.path);
    } catch {
      return reply.code(400).send({ error: "bad_path", message: "That folder path isn't valid." });
    }
    if (!path) {
      return reply.code(400).send({
        error: "root_path",
        message: "Access at the top of a share is set in the share's own permissions, not as a folder rule.",
      });
    }

    // The folder has to exist, or a typo silently becomes a rule that never
    // matches anything and quietly does nothing.
    const onDisk = join(shareBasePath(share), path);
    const found = await stat(onDisk).then((st) => st.isDirectory()).catch(() => false);
    if (!found) return reply.code(400).send({ error: "no_folder", message: "There's no folder at that path in this share." });

    req.audit({ share: share.name, path, subjectType: parsed.data.subjectType, level: parsed.data.level });
    const acl = setAcl({ ...parsed.data, shareId: id, path });
    return reply.code(201).send({ acl });
  });

  app.delete("/shares/:id/acls/:aclId", async (req, reply) => {
    const { id, aclId } = req.params as { id: string; aclId: string };
    const share = getShareById(id);
    if (!share) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    if (!deleteAcl(id, aclId)) return reply.code(404).send({ error: "not_found", message: "Rule not found." });
    req.audit({ share: share.name });
    return { ok: true };
  });

  // ===================== Groups =====================
  app.get("/groups", async (): Promise<GroupsResponse> => ({ groups: listGroups() }));

  app.get("/groups/:id", async (req, reply): Promise<GroupDetailResponse | undefined> => {
    const id = (req.params as { id: string }).id;
    const group = getGroupById(id);
    if (!group) return reply.code(404).send({ error: "not_found", message: "Group not found." });
    return { group, members: listMembers(id) };
  });

  const groupSchema = z.object({
    // Same charset as a username: the name becomes a system group so Samba can
    // be told `valid users = @<name>`.
    name: z.string().trim().min(2).max(32).regex(usernameRe),
    description: z.string().trim().max(255).optional(),
  });

  app.post("/groups", async (req, reply) => {
    const parsed = groupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "A group name is 2-32 letters, digits, dot, dash or underscore." });
    }
    if (getGroupByName(parsed.data.name)) {
      return reply.code(409).send({ error: "exists", message: "A group with that name already exists." });
    }
    if (getUserByUsername(parsed.data.name)) {
      return reply.code(409).send({ error: "name_taken", message: "A user already has that name - groups and users share a namespace on the system." });
    }
    req.audit({ name: parsed.data.name });
    const group = createGroup(parsed.data.name, parsed.data.description ?? "");
    await syncShareGroup(req.log, group.name, []);
    return reply.code(201).send({ group });
  });

  app.patch("/groups/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const group = getGroupById(id);
    if (!group) return reply.code(404).send({ error: "not_found", message: "Group not found." });
    const parsed = z
      .object({
        description: z.string().trim().max(255).optional(),
        members: z.array(z.string()).max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid changes." });

    if (parsed.data.members) {
      const unknown = parsed.data.members.filter((uid) => !getUserById(uid));
      if (unknown.length) return reply.code(400).send({ error: "bad_member", message: "One of those accounts no longer exists." });
      setMembers(id, parsed.data.members);
    }
    if (parsed.data.description !== undefined) updateGroup(id, { description: parsed.data.description });

    req.audit({ name: group.name, memberCount: parsed.data.members?.length });
    await syncShareGroup(req.log, group.name, usernamesInGroup(id));
    applyGeneratedConfigs(req.log); // membership changes who `valid users` lets in
    await reloadFileServices(req.log);
    return { group: getGroupById(id), members: listMembers(id) };
  });

  app.delete("/groups/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const group = getGroupById(id);
    if (!group) return reply.code(404).send({ error: "not_found", message: "Group not found." });
    req.audit({ name: group.name });
    deleteGroup(id); // also drops its share grants and any folder rules naming it
    await removeShareGroup(req.log, group.name);
    applyGeneratedConfigs(req.log);
    await reloadFileServices(req.log);
    return { ok: true };
  });

  app.delete("/shares/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getShareById(id)) return reply.code(404).send({ error: "not_found", message: "Share not found." });
    // Definition only - the folder and its data are left on disk.
    deleteShare(id);
    applyGeneratedConfigs(req.log);
    await reloadFileServices(req.log);
    return { ok: true };
  });

  // ===================== Services =====================
  app.get("/services", async (): Promise<ServicesResponse> => buildServicesResponse());

  const servicesSchema = z.object({
    smb: z.object({
      enabled: z.boolean().optional(),
      workgroup: z.string().max(64).optional(),
      serverString: z.string().max(128).optional(),
      allowGuest: z.boolean().optional(),
    }).partial().optional(),
    nfs: z.object({
      enabled: z.boolean().optional(),
      allowedNetworks: z.string().max(255).optional(),
    }).partial().optional(),
    afp: z.object({ enabled: z.boolean().optional() }).partial().optional(),
  });

  app.put("/services", async (req, reply): Promise<ServicesResponse> => {
    const parsed = servicesSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid services config." }) as never;
    const next = setServicesConfig(parsed.data);
    applyGeneratedConfigs(req.log);
    // Start/stop + enable/disable the actual daemons to match the new config.
    await applyServiceStates(req.log, { smb: next.smb.enabled, nfs: next.nfs.enabled, afp: next.afp.enabled });
    await reloadFileServices(req.log);
    return buildServicesResponse();
  });

  // ===================== TLS certificate =====================
  // ===================== Firewall =====================
  //
  // Applying a rule can cut off the very connection asking for it, so a change
  // is staged rather than simply made: it is loaded, and a timer puts the old
  // one back unless the admin confirms from a connection that still works. It
  // is the same reasoning behind `iptables-apply`, and the only way to offer a
  // "only my subnet may reach this NAS" switch that an admin can safely try.
  const REVERT_SECONDS = config.firewallRevertSeconds;
  type FirewallConfigShape = ReturnType<typeof getFirewallConfig>;
  let pendingRevert: { token: string; timer: NodeJS.Timeout; previous: FirewallConfigShape } | null = null;

  /**
   * Load `fw` (or tear the table down when it's disabled). Returns an error
   * message, or null on success.
   *
   * When the host can't enforce rules at all - dev mode, or an appliance with
   * no nftables - the settings are still stored and this reports success. The
   * response's `available: false` is what tells the admin nothing is being
   * enforced; refusing to save would just mean the screen couldn't be used at
   * all on a machine that might gain nftables later.
   */
  async function loadRuleset(log: typeof app.log, fw: FirewallConfigShape): Promise<string | null> {
    if ((await firewallStatus()) === "unavailable") return null;
    if (!fw.enabled) {
      const r = await disableFirewall(log);
      return r.ok ? null : (r.error ?? "Could not turn the firewall off.");
    }
    const path = join(config.generatedDir, "opennas.nft");
    await writeFile(path, generateRuleset(fw), { mode: 0o600 });
    const r = await applyFirewall(log, path);
    return r.ok ? null : (r.error ?? "The ruleset could not be loaded.");
  }

  function cancelPendingRevert(): void {
    if (!pendingRevert) return;
    clearTimeout(pendingRevert.timer);
    pendingRevert = null;
  }

  // ---- Dynamic DNS ----------------------------------------------------------

  app.get("/ddns", async (): Promise<DdnsResponse> => ({ ddns: ddnsStatus() }));

  app.put("/ddns", async (req, reply): Promise<DdnsResponse | undefined> => {
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        provider: z.enum(["duckdns", "dyndns2", "cloudflare"]).optional(),
        hostname: z.string().trim().max(253).optional(),
        username: z.string().trim().max(128).optional(),
        server: z.string().trim().max(253).optional(),
        zone: z.string().trim().max(64).optional(),
        // Absent or empty keeps whatever is stored, so the browser never has to
        // hold the token in order to save an unrelated field.
        secret: z.string().max(512).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid settings." }) as never;

    // The token is deliberately excluded from the audit detail; everything else
    // about the change is worth recording.
    const { secret, ...loggable } = parsed.data;
    req.audit({ ...loggable, secretChanged: Boolean(secret) });
    return { ddns: { ...ddnsStatus(), config: setDdnsConfig(parsed.data) } };
  });

  /** Check and update now, whatever the timer was going to do. */
  app.post("/ddns/update", async (req): Promise<DdnsResponse> => {
    req.audit({});
    return { ddns: await runDdnsOnce(req.log, true) };
  });

  // ---- Blocked addresses ----------------------------------------------------

  // The kernel is the authority on what is actually blocked, so these read the
  // live nftables set rather than the table of bans OpenNAS wrote.

  app.get("/firewall/bans", async (): Promise<IpBansResponse> => currentBans());

  app.delete("/firewall/bans/:address", async (req, reply) => {
    const address = decodeURIComponent((req.params as { address: string }).address);
    // Whatever is on file, this string reaches a root helper - so it is checked
    // here too rather than relying on having been the only way in.
    if (!/^[0-9a-fA-F:.]{2,45}$/.test(address)) {
      return reply.code(400).send({ error: "invalid", message: "That isn't an address." });
    }
    req.audit({ address });
    await liftBan(address);
    return currentBans();
  });

  /**
   * Turn the decoy trap on or off.
   *
   * A toggle rather than an editable path list. The list is only safe because
   * every entry is a path where a false positive is impossible, and that is a
   * property of the specific paths - letting an admin add `/files` to it would
   * hand them a way to lock their whole household out of their own NAS in one
   * click.
   */
  app.put("/firewall/honeypot", async (req, reply): Promise<IpBansResponse | undefined> => {
    const body = req.body as { enabled?: unknown };
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "invalid", message: "Send { enabled: true | false }." });
    }
    req.audit({ enabled: body.enabled });
    setHoneypotEnabled(body.enabled);
    return currentBans();
  });

  app.get("/firewall", async (): Promise<FirewallResponse> => {
    const config = getFirewallConfig();
    const status = await firewallStatus();
    return {
      config,
      services: FIREWALL_SERVICES,
      available: status !== "unavailable",
      unavailableReason:
        status === "unavailable"
          ? "nftables isn't available on this system, so rules can be reviewed but not enforced."
          : null,
      preview: generateRuleset(config),
    };
  });

  const firewallSchema = z.object({
    enabled: z.boolean(),
    allowed: z.array(z.enum(["web", "ssh", "smb", "nfs", "afp", "discovery"])).max(16),
    trustedNetworks: z.array(z.string().trim().min(1).max(64)).max(32),
    restrictToTrusted: z.boolean(),
  });

  app.put("/firewall", async (req, reply): Promise<FirewallApplyResponse | undefined> => {
    const parsed = firewallSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid firewall settings." });

    // Every entry is interpolated into a ruleset, so anything that isn't
    // recognisably an address is refused rather than quoted and hoped for.
    const bad = parsed.data.trustedNetworks.filter((n) => !isValidCidr(n));
    if (bad.length > 0) {
      return reply.code(400).send({ error: "bad_network", message: `Not a valid address or range: ${bad[0]}` });
    }
    if (parsed.data.restrictToTrusted && parsed.data.trustedNetworks.length === 0) {
      return reply.code(400).send({
        error: "no_networks",
        message: "Add at least one trusted network first - otherwise this would refuse every connection, including yours.",
      });
    }

    const previous = getFirewallConfig();
    const next: FirewallConfigShape = { ...parsed.data };
    req.audit({ enabled: next.enabled, allowed: next.allowed, restrictToTrusted: next.restrictToTrusted });

    cancelPendingRevert(); // a second change supersedes an unconfirmed one
    const error = await loadRuleset(req.log, next);
    if (error) return reply.code(500).send({ error: "apply_failed", message: error });
    setFirewallConfig(next);

    // Turning the firewall *off* can't lock anyone out, and neither can a host
    // that isn't enforcing anything - neither needs the confirm-or-revert dance.
    if (!next.enabled || (await firewallStatus()) === "unavailable") {
      return { config: next, pending: null, preview: generateRuleset(next) };
    }

    const token = nanoid(24);
    const timer = setTimeout(() => {
      void (async () => {
        app.log.warn("firewall change was not confirmed - reverting");
        await loadRuleset(app.log, previous);
        setFirewallConfig(previous);
        pendingRevert = null;
      })();
    }, REVERT_SECONDS * 1000);
    timer.unref?.();
    pendingRevert = { token, timer, previous };

    return { config: next, pending: { token, revertsInSeconds: REVERT_SECONDS }, preview: generateRuleset(next) };
  });

  app.post("/firewall/confirm", async (req, reply) => {
    const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Missing token." });
    if (!pendingRevert || pendingRevert.token !== parsed.data.token) {
      // Either it was already confirmed, or the timer beat them to it.
      return reply.code(409).send({ error: "no_pending", message: "There's nothing waiting to be confirmed." });
    }
    req.audit({ confirmed: true });
    cancelPendingRevert();
    return { ok: true, config: getFirewallConfig() };
  });

  /** Put the previous rules back now, without waiting for the timer. */
  app.post("/firewall/revert", async (req, reply) => {
    if (!pendingRevert) return reply.code(409).send({ error: "no_pending", message: "There's nothing to undo." });
    const previous = pendingRevert.previous;
    cancelPendingRevert();
    await loadRuleset(req.log, previous);
    setFirewallConfig(previous);
    req.audit({ reverted: true });
    return { ok: true, config: previous };
  });

  app.get("/tls", async (): Promise<TlsResponse> => ({ tls: readTlsInfo() }));

  const tlsSchema = z.object({
    cert: z.string().min(1).max(64 * 1024),
    key: z.string().min(1).max(64 * 1024),
  });

  app.post("/tls", async (req, reply): Promise<TlsResponse> => {
    const parsed = tlsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a PEM certificate and key." }) as never;
    // Validate the cert parses and the key matches it before writing anything.
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(parsed.data.cert);
    } catch {
      return reply.code(400).send({ error: "bad_cert", message: "The certificate is not valid PEM." }) as never;
    }
    try {
      const keyObj = createPrivateKey(parsed.data.key);
      if (!cert.checkPrivateKey(keyObj)) {
        return reply.code(400).send({ error: "mismatch", message: "The private key does not match the certificate." }) as never;
      }
    } catch {
      return reply.code(400).send({ error: "bad_key", message: "The private key is not valid PEM." }) as never;
    }
    try {
      await mkdir(config.tlsDir, { recursive: true });
      await writeFile(join(config.tlsDir, "cert.pem"), parsed.data.cert, { mode: 0o644 });
      await writeFile(join(config.tlsDir, "key.pem"), parsed.data.key, { mode: 0o640 });
    } catch (err) {
      req.log.error({ err }, "writing TLS cert failed");
      return reply.code(500).send({ error: "write_failed", message: "Could not save the certificate." }) as never;
    }
    await reloadWebProxy(req.log);
    return { tls: readTlsInfo() };
  });

  // ---- Automatic certificates (ACME / Let's Encrypt) ---------------------
  //
  // Only http-01 is offered: it needs nothing but port 80 reachable from the
  // internet, which is a thing an admin can check. dns-01 would mean holding
  // API credentials for their DNS provider, which is a different feature with
  // a different blast radius.

  app.get("/tls/acme", async (): Promise<AcmeResponse> => {
    const settings = getAcmeSettings();
    const { available, reason } = acmeAvailable();
    return {
      settings,
      state: getAcmeState(),
      available,
      unavailableReason: reason,
      termsOfService: await acmeTermsOfService(settings.directoryUrl),
    };
  });

  const acmeSchema = z.object({
    enabled: z.boolean(),
    domains: z.array(z.string().trim().min(1).max(253)).max(16),
    email: z.string().email().or(z.literal("")),
    directoryUrl: z.string().url().max(512),
    agreedTos: z.boolean(),
  });

  app.put("/tls/acme", async (req, reply) => {
    const parsed = acmeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid certificate settings." });

    const domains = parsed.data.domains.map((d) => d.trim().toLowerCase());
    const bad = domains.filter((d) => !isValidDomain(d));
    if (bad.length > 0) {
      return reply.code(400).send({
        error: "bad_domain",
        message: `"${bad[0]}" isn't a name a public CA can issue for. Use a full hostname like nas.example.com - wildcards aren't supported.`,
      });
    }
    if (parsed.data.enabled) {
      if (domains.length === 0) {
        return reply.code(400).send({ error: "no_domains", message: "Add at least one domain name." });
      }
      if (!parsed.data.agreedTos) {
        return reply.code(400).send({ error: "tos", message: "The certificate authority's terms of service have to be accepted." });
      }
      // Only http(s) - this URL is fetched by the server, and a file:// or
      // gopher:// "directory" is not something to hand to fetch.
      if (!/^https?:\/\//i.test(parsed.data.directoryUrl)) {
        return reply.code(400).send({ error: "bad_directory", message: "The directory URL must be http or https." });
      }
    }

    const settings = { ...parsed.data, domains };
    req.audit({ enabled: settings.enabled, domains, directoryUrl: settings.directoryUrl });
    setAcmeSettings(settings);
    return { settings, state: getAcmeState() };
  });

  /**
   * Request a certificate now. Runs in the background: an ACME order involves
   * the CA reaching back to this machine, and holding the HTTP request open for
   * it would time out long before the order finished.
   */
  app.post("/tls/acme/request", async (req, reply) => {
    const settings = getAcmeSettings();
    if (!settings.enabled) return reply.code(400).send({ error: "disabled", message: "Turn automatic certificates on first." });
    if (settings.domains.length === 0) return reply.code(400).send({ error: "no_domains", message: "Add at least one domain name." });
    if (!acmeAvailable().available) {
      return reply.code(400).send({ error: "unavailable", message: acmeAvailable().reason });
    }
    req.audit({ domains: settings.domains });
    void runIssuance(req.log, settings);
    return { started: true };
  });

  app.post("/tls/self-signed", async (req): Promise<TlsResponse> => {
    await regenerateSelfSignedCert(req.log);
    return { tls: readTlsInfo() };
  });

  // ===================== Storage / disks =====================
  // Enriched with S.M.A.R.T. health + live usage for the Storage dashboard.
  app.get("/storage", async (): Promise<StorageResponse> => ({ disks: await listStorageWithHealth() }));

  // ---- ZFS ------------------------------------------------------------------
  //
  // mdadm gives redundancy; ZFS gives redundancy *plus* the checksums that make
  // it mean something - a parity array happily returns a silently corrupted
  // block, because parity is only consulted when a disk admits it failed. All of
  // it goes through the privileged helper, including the reads, because
  // `zpool create` on the wrong device is unrecoverable and the backend is the
  // part reachable from the network.

  const POOL_NAME = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "A pool name may use letters, numbers, dot, dash and underscore.");
  const DATASET_NAME = z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)+$/, "Give a dataset inside a pool, like tank/photos.");

  app.get("/zfs", async (): Promise<ZfsResponse> => {
    const status = await zfsStatus();
    if (status.state !== "ready") {
      return { status, pools: [], datasets: [], importable: [] };
    }
    const [pools, datasets, importable] = await Promise.all([listPools(), listDatasets(), listImportable()]);
    return { status, pools, datasets, importable };
  });

  app.get("/zfs/layouts", async (): Promise<{ layouts: typeof ZFS_LAYOUTS }> => ({ layouts: ZFS_LAYOUTS }));

  app.post("/zfs/pools", async (req, reply) => {
    const parsed = z
      .object({
        name: POOL_NAME,
        layout: z.enum(["stripe", "mirror", "raidz1", "raidz2", "raidz3"]),
        disks: z.array(z.string().regex(/^\/dev\/[a-zA-Z0-9/_-]{1,64}$/)).min(1).max(60),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message ?? "Check the pool details." });
    }
    // Audited before it runs: this erases every disk named, and if it goes wrong
    // the record of what was asked for is the only thing left.
    req.audit({ name: parsed.data.name, layout: parsed.data.layout, disks: parsed.data.disks });
    const r = await createPool(req.log, parsed.data.name, parsed.data.layout, parsed.data.disks);
    if (!r.ok) return reply.code(400).send({ error: "create_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.delete("/zfs/pools/:name", async (req, reply) => {
    const name = POOL_NAME.safeParse((req.params as { name: string }).name);
    if (!name.success) return reply.code(400).send({ error: "invalid", message: "That isn't a pool name." });
    req.audit({ name: name.data });
    const r = await destroyPool(req.log, name.data);
    if (!r.ok) return reply.code(400).send({ error: "destroy_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.post("/zfs/pools/:name/export", async (req, reply) => {
    const name = POOL_NAME.safeParse((req.params as { name: string }).name);
    if (!name.success) return reply.code(400).send({ error: "invalid", message: "That isn't a pool name." });
    req.audit({ name: name.data });
    const r = await exportPool(req.log, name.data);
    if (!r.ok) return reply.code(400).send({ error: "export_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.post("/zfs/import", async (req, reply) => {
    const parsed = z.object({ name: POOL_NAME.optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "That isn't a pool name." });
    req.audit({ name: parsed.data.name ?? "(all)" });
    const r = await importPool(req.log, parsed.data.name);
    if (!r.ok) return reply.code(400).send({ error: "import_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.post("/zfs/pools/:name/scrub", async (req, reply) => {
    const name = POOL_NAME.safeParse((req.params as { name: string }).name);
    if (!name.success) return reply.code(400).send({ error: "invalid", message: "That isn't a pool name." });
    const stop = (req.body as { stop?: boolean } | undefined)?.stop === true;
    req.audit({ name: name.data, stop });
    const r = await scrubPool(req.log, name.data, stop);
    if (!r.ok) return reply.code(400).send({ error: "scrub_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.post("/zfs/datasets", async (req, reply) => {
    const parsed = z.object({ name: DATASET_NAME }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message ?? "Check the name." });
    }
    req.audit({ name: parsed.data.name });
    const r = await createDataset(req.log, parsed.data.name);
    if (!r.ok) return reply.code(400).send({ error: "create_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.delete("/zfs/datasets", async (req, reply) => {
    const parsed = DATASET_NAME.safeParse((req.query as { name?: string }).name ?? "");
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "That isn't a dataset." });
    req.audit({ name: parsed.data });
    const r = await destroyDataset(req.log, parsed.data);
    if (!r.ok) return reply.code(400).send({ error: "destroy_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.put("/zfs/datasets/quota", async (req, reply) => {
    const parsed = z
      .object({ name: DATASET_NAME, bytes: z.number().int().min(0).max(2 ** 53 - 1).nullable() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide a dataset and a size in bytes (or null)." });
    }
    req.audit({ name: parsed.data.name, bytes: parsed.data.bytes });
    const r = await setDatasetQuota(req.log, parsed.data.name, parsed.data.bytes);
    if (!r.ok) return reply.code(400).send({ error: "quota_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.get("/zfs/snapshots", async (req): Promise<ZfsSnapshotsResponse> => {
    const ds = (req.query as { dataset?: string }).dataset;
    const parsed = ds ? DATASET_NAME.safeParse(ds) : null;
    return { snapshots: await listSnapshots(parsed?.success ? parsed.data : undefined) };
  });

  app.post("/zfs/snapshots", async (req, reply) => {
    const parsed = z
      .object({
        dataset: DATASET_NAME,
        name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a dataset and a snapshot name." });
    req.audit({ dataset: parsed.data.dataset, name: parsed.data.name });
    const r = await createSnapshot(req.log, parsed.data.dataset, parsed.data.name);
    if (!r.ok) return reply.code(400).send({ error: "snapshot_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  const FULL_SNAPSHOT = z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)+@[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

  app.delete("/zfs/snapshots", async (req, reply) => {
    const parsed = FULL_SNAPSHOT.safeParse((req.query as { name?: string }).name ?? "");
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Give it as dataset@snapshot." });
    req.audit({ name: parsed.data });
    const r = await destroySnapshot(req.log, parsed.data);
    if (!r.ok) return reply.code(400).send({ error: "destroy_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  app.post("/zfs/snapshots/rollback", async (req, reply) => {
    const parsed = z.object({ name: FULL_SNAPSHOT }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Give it as dataset@snapshot." });
    req.audit({ name: parsed.data.name });
    const r = await rollbackSnapshot(req.log, parsed.data.name);
    if (!r.ok) return reply.code(400).send({ error: "rollback_failed", message: r.error });
    return { ok: true, message: r.message };
  });

  // Read-only RAID (mdadm) array status.
  app.get("/storage/raid", async (): Promise<RaidResponse> => ({ arrays: await listRaidArrays() }));

  // Where VM disks/ISOs + container volumes/stacks are placed (admin-relocatable).
  /** Places a new VM / stack / service can be stored, for the create forms. */
  app.get("/storage/targets", async (): Promise<StorageTargetsResponse> => ({ targets: listStorageTargets() }));

  app.get("/storage/locations", async (): Promise<StorageLocationsResponse> => ({
    locations: getStorageLocations(),
    defaults: { vm: storageDefaults.vm, containers: storageDefaults.containers },
    volumes: await listVolumes(),
  }));

  app.put("/storage/locations", async (req, reply): Promise<StorageLocationsResponse> => {
    const parsed = z
      .object({ vm: z.string().max(4096).nullish(), containers: z.string().max(4096).nullish() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide vm and/or containers paths." }) as never;
    const res = setStorageLocations(parsed.data);
    if (!res.ok) return reply.code(400).send({ error: "bad_path", message: res.error ?? "Invalid path." }) as never;
    return { locations: getStorageLocations(), defaults: { vm: storageDefaults.vm, containers: storageDefaults.containers }, volumes: await listVolumes() };
  });

  const initSchema = z.object({
    disk: z.string().regex(/^\/dev\/[a-zA-Z0-9/]+$/),
    fsType: z.enum(["ext4", "btrfs", "xfs"]),
    label: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  });

  app.post("/storage/init", async (req, reply) => {
    const parsed = initSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide a disk, filesystem and a simple label (letters, digits, _ -)." });
    // Re-check server-side that the disk is actually unconfigured (never wipe system/data).
    const disks = await listStorage();
    const target = disks.find((d) => d.name === parsed.data.disk);
    if (!target) return reply.code(404).send({ error: "not_found", message: "Disk not found." });
    if (target.state !== "unconfigured") {
      return reply.code(409).send({ error: "in_use", message: "That disk is already in use - refusing to erase it." });
    }
    const res = await initializeDisk(req.log, parsed.data.disk, parsed.data.fsType, parsed.data.label);
    if (!res.ok) return reply.code(500).send({ error: "init_failed", message: res.error ?? "Could not initialize the disk." });
    return { disks: await listStorage() };
  });

  // Create a RAID array from blank disks, then format + mount it as a volume.
  const RAID_MIN: Record<string, number> = { raid0: 2, raid1: 2, raid5: 3, raid6: 4, raid10: 4 };
  const raidSchema = z.object({
    level: z.enum(["raid0", "raid1", "raid5", "raid6", "raid10"]),
    label: z.string().trim().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    fsType: z.enum(["ext4", "btrfs", "xfs"]),
    disks: z.array(z.string().regex(/^\/dev\/[a-zA-Z0-9/]+$/)).min(2).max(24),
  });

  const expandSchema = z.object({
    disk: z.string().min(1).max(64),
    fsType: z.enum(["ext4", "btrfs", "xfs"]),
    label: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    size: z.string().max(16).regex(/^[0-9]+[GMgm]$/).optional(),
  });

  /**
   * Claim a disk's unallocated space as a data volume. Deliberately allowed on
   * the system disk - on a single-disk machine that's the only place a data
   * volume can come from, and appending to free space never touches the
   * partitions that are already there.
   */
  app.post("/storage/expand", async (req, reply) => {
    const parsed = expandSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide a disk, filesystem and a simple label (letters, digits, _ -)." });
    }
    const disks = await listStorageWithHealth();
    const target = disks.find((d) => d.name === parsed.data.disk);
    if (!target) return reply.code(404).send({ error: "not_found", message: "Disk not found." });
    if (target.unallocatedBytes !== null && target.unallocatedBytes < 1024 * 1024 * 1024) {
      return reply.code(409).send({ error: "no_space", message: "That disk has no meaningful unallocated space." });
    }
    req.audit({ disk: parsed.data.disk, label: parsed.data.label, fsType: parsed.data.fsType, size: parsed.data.size ?? "all" });
    const res = await expandDisk(req.log, parsed.data.disk, parsed.data.fsType, parsed.data.label, parsed.data.size);
    if (!res.ok) return reply.code(500).send({ error: "expand_failed", message: res.error ?? "Could not create the volume." });
    return { disks: await listStorageWithHealth() };
  });

  app.post("/storage/raid", async (req, reply) => {
    const parsed = raidSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid", message: "Provide a level, simple label, filesystem and member disks." });
    }
    const { level, label, fsType, disks } = parsed.data;
    const unique = [...new Set(disks)];
    if (unique.length !== disks.length) {
      return reply.code(400).send({ error: "dup_disks", message: "A disk is listed more than once." });
    }
    if (disks.length < (RAID_MIN[level] ?? 2)) {
      return reply.code(400).send({ error: "too_few", message: `${level} needs at least ${RAID_MIN[level]} disks.` });
    }
    // Re-check server-side that every member is unconfigured (never wipe system/data).
    const all = await listStorage();
    for (const d of disks) {
      const target = all.find((x) => x.name === d);
      if (!target) return reply.code(404).send({ error: "not_found", message: `Disk ${d} not found.` });
      if (target.state !== "unconfigured") {
        return reply.code(409).send({ error: "in_use", message: `${d} is already in use - refusing to erase it.` });
      }
    }
    const res = await createRaid(req.log, { level, label, fsType, disks });
    if (!res.ok) return reply.code(500).send({ error: "raid_failed", message: res.error ?? "Could not create the RAID array." });
    return { disks: await listStorage(), arrays: await listRaidArrays() };
  });

  app.delete("/storage/raid/:md", async (req, reply) => {
    const p = z.object({ md: z.string().regex(/^md[0-9]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid", message: "Invalid array name." });
    const res = await destroyRaid(req.log, p.data.md);
    if (!res.ok) return reply.code(500).send({ error: "destroy_failed", message: res.error ?? "Could not remove the array." });
    return { ok: true };
  });

  const mdParam = z.object({ md: z.string().regex(/^md[0-9]+$/) });
  const memberSchema = z.object({ disk: z.string().regex(/^\/dev\/[a-zA-Z0-9]+$/) });

  // Add a blank disk to an array (rebuild a degraded array, or add a spare).
  app.post("/storage/raid/:md/add", async (req, reply) => {
    const p = mdParam.safeParse(req.params);
    const b = memberSchema.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "invalid", message: "Provide a valid array and disk." });
    // Only add a disk that holds nothing we'd lose.
    const target = (await listStorage()).find((x) => x.name === b.data.disk);
    if (!target) return reply.code(404).send({ error: "not_found", message: `Disk ${b.data.disk} not found.` });
    if (target.state !== "unconfigured") {
      return reply.code(409).send({ error: "in_use", message: `${b.data.disk} is already in use - pick a blank disk.` });
    }
    const res = await raidAddDisk(req.log, p.data.md, b.data.disk);
    if (!res.ok) return reply.code(500).send({ error: "add_failed", message: res.error ?? "Could not add the disk." });
    return { disks: await listStorage(), arrays: await listRaidArrays() };
  });

  // Fail + remove a member from an array (drop a dead/replaced disk).
  app.post("/storage/raid/:md/remove", async (req, reply) => {
    const p = mdParam.safeParse(req.params);
    const b = memberSchema.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "invalid", message: "Provide a valid array and member." });
    const arr = (await listRaidArrays()).find((a) => a.name === `/dev/${p.data.md}`);
    if (!arr) return reply.code(404).send({ error: "not_found", message: "Array not found." });
    if (!arr.members.some((m) => m.name === b.data.disk)) {
      return reply.code(400).send({ error: "not_member", message: `${b.data.disk} isn't a member of ${p.data.md}.` });
    }
    const res = await raidRemoveDisk(req.log, p.data.md, b.data.disk);
    if (!res.ok) return reply.code(500).send({ error: "remove_failed", message: res.error ?? "Could not remove the member." });
    return { disks: await listStorage(), arrays: await listRaidArrays() };
  });

  const labelParam = z.object({ label: z.string().regex(/^[a-zA-Z0-9_-]+$/) });
  app.post("/storage/volume/:label/:op", async (req, reply): Promise<StorageResponse> => {
    const p = labelParam.safeParse(req.params);
    const op = (req.params as { op: string }).op;
    if (!p.success || !["mount", "unmount", "erase"].includes(op)) {
      return reply.code(400).send({ error: "invalid", message: "Bad volume request." }) as never;
    }
    const fn = op === "mount" ? mountVolume : op === "unmount" ? unmountVolume : eraseVolume;
    const res = await fn(req.log, p.data.label);
    if (!res.ok) return reply.code(500).send({ error: "op_failed", message: res.error ?? "Operation failed." }) as never;
    return { disks: await listStorage() };
  });

  // ===================== Network =====================
  app.get("/network", async (): Promise<NetworkResponse> => ({ network: await getNetwork() }));

  app.post("/network/hostname", async (req, reply) => {
    const parsed = z.object({ hostname: z.string().trim().min(1).max(63).regex(/^[a-zA-Z0-9.-]+$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid hostname." });
    const res = await setHostname(req.log, parsed.data.hostname);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Could not set hostname." });
    return { ok: true };
  });

  app.post("/network/interface", async (req, reply) => {
    const parsed = z.object({
      iface: z.string().regex(/^[a-zA-Z0-9]+$/),
      mode: z.enum(["dhcp", "static"]),
      ip: z.string().optional(),
      cidr: z.string().optional(),
      gateway: z.string().optional(),
      dns: z.string().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid network config." });
    const res = await setInterface(req.log, parsed.data.iface, parsed.data);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Could not apply network config." });
    return { ok: true };
  });

  // ===================== Time / region =====================
  app.get("/time", async (): Promise<TimeResponse> => ({ time: await getTimeInfo() }));

  app.post("/time", async (req, reply) => {
    const parsed = z.object({
      timezone: z.string().regex(/^[A-Za-z0-9_+\-/]+$/).optional(),
      ntpServer: z.string().regex(/^[a-zA-Z0-9.-]+$/).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid time settings." });
    if (parsed.data.timezone) {
      const r = await setTimezone(req.log, parsed.data.timezone);
      if (!r.ok) return reply.code(500).send({ error: "failed", message: r.error ?? "Could not set timezone." });
    }
    if (parsed.data.ntpServer) {
      const r = await setNtpServer(req.log, parsed.data.ntpServer);
      if (!r.ok) return reply.code(500).send({ error: "failed", message: r.error ?? "Could not set NTP server." });
    }
    return { time: await getTimeInfo() };
  });

  // ===================== Update / info =====================
  app.get("/update", async (): Promise<UpdateResponse> => ({ update: await getUpdateInfo() }));

  /** `apk upgrade` - Alpine's own packages, which is a different thing from OpenNAS. */
  app.post("/update/system-packages", async (req, reply) => {
    req.audit({});
    const res = await runSystemUpdate(req.log);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Update failed." });
    return { ok: true };
  });

  // Kept at the old path so an older UI doesn't break, but it does what it
  // always did: Alpine packages, not OpenNAS.
  app.post("/update", async (req, reply) => {
    req.audit({});
    const res = await runSystemUpdate(req.log);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Update failed." });
    return { ok: true };
  });

  // ---- Updating OpenNAS itself ----------------------------------------------

  app.get("/update/opennas", async (req): Promise<SelfUpdateResponse> => {
    const [check, status, supported] = await Promise.all([
      checkForUpdate(req.log),
      updateState(),
      updateSupported(),
    ]);
    return { ...check, status, supported, channel: channelUrl() };
  });

  app.put("/update/opennas/channel", async (req, reply) => {
    const parsed = z.object({ url: z.string().trim().url().max(500) }).safeParse(req.body);
    if (!parsed.success || !/^https:\/\//i.test(parsed.data.url)) {
      return reply.code(400).send({ error: "invalid", message: "Give an https URL for the update channel." });
    }
    req.audit({ channel: parsed.data.url });
    setChannelUrl(parsed.data.url);
    return { ok: true, channel: channelUrl() };
  });

  app.post("/update/opennas", async (req, reply) => {
    if (!(await updateSupported())) {
      return reply.code(409).send({
        error: "unsupported",
        message: "This installation has no updater - it was built or installed by hand.",
      });
    }
    const { available } = await checkForUpdate(req.log);
    if (!available) {
      return reply.code(409).send({ error: "up_to_date", message: "There's nothing newer to install." });
    }
    req.audit({ from: config.version, to: available.version });
    const res = await applyUpdate(available, req.log);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "The update failed." });
    // 202: the updater has detached and is about to restart this very process.
    return reply.code(202).send({ ok: true, version: available.version });
  });

  app.post("/update/opennas/rollback", async (req, reply) => {
    req.audit({});
    const res = await rollbackUpdate(req.log);
    if (!res.ok) return reply.code(502).send({ error: "failed", message: res.error ?? "Rollback failed." });
    return reply.code(202).send({ ok: true });
  });

  // ===================== Power =====================
  app.post("/power/:action", async (req, reply) => {
    const action = (req.params as { action: string }).action;
    if (action !== "reboot" && action !== "poweroff") {
      return reply.code(400).send({ error: "invalid", message: "Use reboot or poweroff." });
    }
    const ok = await powerAction(req.log, action);
    return { ok, action };
  });

  // ===================== SSH =====================
  app.get("/ssh", async (): Promise<SshResponse> => ({ ssh: getSshConfig() }));

  app.post("/ssh", async (req, reply): Promise<SshResponse> => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid request." }) as never;
    const res = await setSshService(req.log, parsed.data.enabled);
    if (!res.ok) return reply.code(500).send({ error: "failed", message: res.error ?? "Could not change SSH." }) as never;
    return { ssh: getSshConfig() };
  });

  app.post("/ssh/keys", async (req, reply): Promise<SshResponse> => {
    const parsed = z.object({ key: z.string().min(1).max(8192) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Provide an SSH public key." }) as never;
    try {
      addSshKey(parsed.data.key);
    } catch (err) {
      return reply.code(400).send({ error: "bad_key", message: err instanceof Error ? err.message : "Invalid key." }) as never;
    }
    await applySshKeys(req.log, config.sshUser, authorizedKeysBody());
    return { ssh: getSshConfig() };
  });

  app.delete("/ssh/keys/:id", async (req): Promise<SshResponse> => {
    removeSshKey((req.params as { id: string }).id);
    await applySshKeys(req.log, config.sshUser, authorizedKeysBody());
    return { ssh: getSshConfig() };
  });

  // ===================== Email / SMTP =====================
  app.get("/smtp", async (): Promise<SmtpResponse> => ({ smtp: getSmtpConfig() }));

  const smtpSchema = z.object({
    enabled: z.boolean().optional(),
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    username: z.string().max(255).optional(),
    password: z.string().max(255).optional(),
    from: z.string().max(255).optional(),
    to: z.string().max(255).optional(),
    alertDiskHealth: z.boolean().optional(),
  });

  app.put("/smtp", async (req, reply): Promise<SmtpResponse> => {
    const parsed = smtpSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid SMTP settings." }) as never;
    return { smtp: setSmtpConfig(parsed.data) };
  });

  app.post("/smtp/test", async (req, reply) => {
    const parsed = smtpSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Invalid SMTP settings." });
    try {
      await sendTestMail(parsed.data);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: "send_failed", message: err instanceof Error ? err.message : "Could not send the test email." });
    }
  });

  // ===================== Config backup / restore =====================
  app.get("/config/export", async (_req, reply): Promise<ConfigBackup> => {
    const backup = exportConfig();
    // Offered as a download rather than inline JSON - this is a file people keep.
    reply.header("Content-Disposition", `attachment; filename="opennas-config-${backup.exportedAt.slice(0, 10)}.json"`);
    return backup;
  });

  /** Dry run: says what an import would change, without changing anything. */
  app.post("/config/plan", async (req): Promise<ConfigRestorePlan> => planRestore(req.body));

  app.post("/config/import", async (req, reply): Promise<ConfigRestoreResult> => {
    const plan = planRestore(req.body);
    if (!plan.ok) {
      return reply.code(400).send({ error: "invalid_backup", message: plan.problems.join(" ") }) as never;
    }
    const result = applyRestore(req.body as ConfigBackup);
    req.audit({
      settings: result.settings,
      usersCreated: result.usersCreated,
      usersUpdated: result.usersUpdated,
      sharesCreated: result.sharesCreated,
      sharesUpdated: result.sharesUpdated,
    });
    // Shares changed, so the daemon config has to be regenerated to match.
    try {
      await applyGeneratedConfigs(req.log);
      await reloadFileServices(req.log);
    } catch (err) {
      req.log.warn({ err }, "could not reload file services after config import");
      result.warnings.push("Shares were imported, but the file services couldn't be reloaded automatically.");
    }
    return result;
  });

  // ===================== Audit log =====================
  app.get("/audit", async (req): Promise<AuditResponse> => {
    const q = z
      .object({
        search: z.string().max(120).optional(),
        action: z.string().max(96).optional(),
        actorId: z.string().max(64).optional(),
        outcome: z.enum(["ok", "denied", "error"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    const filter = q.success ? q.data : {};
    const { entries, total } = listAudit(filter);
    return { entries, total, actions: auditActions() };
  });

  // ===================== Account lockouts =====================
  app.get("/lockouts", async () => ({ lockouts: listLockouts() }));

  app.delete("/lockouts/:username", async (req) => {
    const username = (req.params as { username: string }).username;
    req.audit({ username });
    return { ok: clearLockout(username) };
  });

  // ===================== Logs =====================
  app.get("/logs", async (req): Promise<LogsResponse> => {
    const q = req.query as { source?: string; lines?: string };
    const valid: LogSourceId[] = ["opennas", "system", "nginx", "auth"];
    const source = (valid.includes(q.source as LogSourceId) ? q.source : "opennas") as LogSourceId;
    const lines = Math.max(10, Math.min(2000, Number(q.lines) || 200));
    return { source, sources: logSources(), lines: await readLog(source, lines) };
  });
}

function readTlsInfo(): TlsInfo | null {
  try {
    const pem = readFileSync(join(config.tlsDir, "cert.pem"));
    const c = new X509Certificate(pem);
    return {
      subject: c.subject,
      issuer: c.issuer,
      validFrom: c.validFrom,
      validTo: c.validTo,
      fingerprint: c.fingerprint256,
      selfSigned: c.subject === c.issuer,
      altNames: c.subjectAltName ?? null,
    };
  } catch {
    return null;
  }
}

function buildServicesResponse(): ServicesResponse {
  const cfg = getServicesConfig();
  const shares = listShares();
  return {
    config: cfg,
    generated: { smbConf: generateSmbConf(cfg, shares), exports: generateExports(cfg, shares) },
    daemons: detectDaemons(),
  };
}

async function folderSize(path: string): Promise<number> {
  // Shallow size: sum immediate children's sizes (cheap; avoids deep walks).
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile()) {
      const s = await stat(join(path, e.name)).catch(() => null);
      if (s) total += s.size;
    }
  }
  return total;
}

function flatten(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
