import { chmodSync, existsSync, renameSync } from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { SECRET_SETTINGS, decryptSecret, encryptSecret, isEncrypted, needsUpgrade } from "./secrets.js";

/**
 * One-time adoption of a pre-rename database (the project was formerly "LyNAS").
 * If the configured DB doesn't exist yet but a legacy lynas.sqlite is sitting in
 * the same data dir, take it over - including the WAL/SHM sidecars - so existing
 * accounts and settings survive the rename to OpenNAS.
 */
const legacyDb = config.dbPath.replace(/opennas\.sqlite$/, "lynas.sqlite");
if (legacyDb !== config.dbPath && !existsSync(config.dbPath) && existsSync(legacyDb)) {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacyDb + suffix)) {
      try {
        renameSync(legacyDb + suffix, config.dbPath + suffix);
      } catch {
        /* non-fatal: a fresh DB will be created instead */
      }
    }
  }
}

/**
 * Single SQLite connection for the whole process. SQLite is a perfect fit for a
 * single-node NAS appliance: zero external services, durable, fast enough.
 */
export const db = new Database(config.dbPath);

/**
 * The database and its WAL sidecar are private to the service account.
 *
 * They were being created 0644. That file holds TOTP secrets in base32 (not a
 * hash - the algorithm needs the secret back), session ids that *are* the value
 * of the session cookie, and the SMTP password; any local account could read it
 * and both mint valid second-factor codes and impersonate a signed-in user.
 *
 * Applied on every start, not just at creation, so databases made before this
 * are fixed too. The `-wal` and `-shm` sidecars matter as much as the main file:
 * recent writes live in the WAL, so leaving it readable leaks the same data.
 */
function lockDownDatabaseFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(config.dbPath + suffix)) chmodSync(config.dbPath + suffix, 0o600);
    } catch {
      /* best effort - an unwritable mode must not stop the NAS booting */
    }
  }
}

lockDownDatabaseFiles();

db.pragma("journal_mode = WAL");
// Overwrite deleted content rather than just marking the space reusable.
// Without this, a row's bytes stay legible in the file's free pages until
// something happens to reuse them - so "we deleted the token" and "the token is
// gone from the disk" were two different things.
db.pragma("secure_delete = ON");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

/**
 * Forward-only migrations. Each entry runs once, tracked in `_migrations`.
 * Append new migrations to the end - never edit a shipped one.
 */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        email         TEXT,
        role          TEXT NOT NULL DEFAULT 'user',
        source        TEXT NOT NULL DEFAULT 'local',
        password_hash TEXT,
        avatar_color  TEXT NOT NULL DEFAULT '#3b82f6',
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE UNIQUE INDEX idx_users_username ON users(lower(username));

      CREATE TABLE credentials (
        id           TEXT PRIMARY KEY,          -- base64url credential id
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key   BLOB NOT NULL,
        counter      INTEGER NOT NULL DEFAULT 0,
        transports   TEXT,                       -- json string[]
        device_type  TEXT NOT NULL DEFAULT 'singleDevice',
        backed_up    INTEGER NOT NULL DEFAULT 0,
        label        TEXT NOT NULL DEFAULT 'Passkey',
        created_at   TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX idx_credentials_user ON credentials(user_id);

      CREATE TABLE webauthn_challenges (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        challenge  TEXT NOT NULL,
        kind       TEXT NOT NULL,                -- 'registration' | 'authentication'
        created_at INTEGER NOT NULL              -- epoch ms
      );

      CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        auth_methods TEXT NOT NULL DEFAULT '[]', -- json AuthMethod[]
        user_agent   TEXT,
        ip           TEXT,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE oidc_identities (
        provider TEXT NOT NULL,
        subject  TEXT NOT NULL,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (provider, subject)
      );

      CREATE TABLE oidc_states (
        state         TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        nonce         TEXT NOT NULL,
        created_at    INTEGER NOT NULL            -- epoch ms
      );
    `,
  },
  {
    id: "0002_users_shares_prefs",
    sql: `
      ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE user_prefs (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE shares (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,        -- folder name under files root
        comment      TEXT NOT NULL DEFAULT '',
        guest_access TEXT NOT NULL DEFAULT 'none', -- none | ro | rw
        smb_enabled  INTEGER NOT NULL DEFAULT 1,
        nfs_enabled  INTEGER NOT NULL DEFAULT 0,
        browseable   INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE share_permissions (
        share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level    TEXT NOT NULL DEFAULT 'rw',       -- ro | rw
        PRIMARY KEY (share_id, user_id)
      );
    `,
  },
  {
    id: "0003_packages_notes",
    sql: `
      CREATE TABLE packages (
        id           TEXT PRIMARY KEY,             -- catalog id
        version      TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'running', -- running | stopped | external
        config       TEXT NOT NULL DEFAULT '{}',
        installed_at TEXT NOT NULL
      );

      CREATE TABLE notes (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL DEFAULT 'Untitled',
        body       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notes_user ON notes(user_id);
    `,
  },
  {
    id: "0004_user_avatars",
    sql: `
      ALTER TABLE users ADD COLUMN avatar_path TEXT;
    `,
  },
  {
    id: "0005_share_volume",
    // Which data volume a share lives on (its label). Empty = the default share
    // root. Resolved to a real path at runtime (see services.shareBasePath).
    sql: `
      ALTER TABLE shares ADD COLUMN volume TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: "0006_apps",
    // Third-party app framework: installed apps + per-app/per-user key-value store.
    sql: `
      CREATE TABLE installed_apps (
        id           TEXT PRIMARY KEY,             -- app id (from its manifest)
        version      TEXT NOT NULL,
        manifest     TEXT NOT NULL,                -- full AppManifest as JSON
        enabled      INTEGER NOT NULL DEFAULT 1,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE app_storage (
        app_id  TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (app_id, user_id, key)
      );
    `,
  },
  {
    id: "0007_trash_sharelinks",
    sql: `
      CREATE TABLE trash_items (
        id           TEXT PRIMARY KEY,           -- random id (also the on-disk name)
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        virtual_path TEXT NOT NULL,              -- original path (incl. share)
        name         TEXT NOT NULL,
        is_dir       INTEGER NOT NULL DEFAULT 0,
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        deleted_at   TEXT NOT NULL
      );
      CREATE INDEX idx_trash_user ON trash_items(user_id);

      CREATE TABLE share_links (
        id            TEXT PRIMARY KEY,           -- the public token
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        virtual_path  TEXT NOT NULL,
        name          TEXT NOT NULL,
        is_dir        INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT,                       -- nullable
        expires_at    TEXT,                       -- nullable ISO timestamp
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_sharelinks_user ON share_links(user_id);
    `,
  },
  {
    id: "0008_themes",
    sql: `
      CREATE TABLE installed_themes (
        id           TEXT PRIMARY KEY,
        theme        TEXT NOT NULL,                 -- resolved InstalledTheme JSON
        installed_at TEXT NOT NULL
      );
    `,
  },
  {
    id: "0009_pwned",
    // Whether the user's password was found in a known breach at its last set.
    sql: `ALTER TABLE users ADD COLUMN password_pwned INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: "0010_oidc_clients",
    sql: `
      CREATE TABLE oidc_clients (
        client_id     TEXT PRIMARY KEY,
        secret_hash   TEXT NOT NULL,       -- sha256(secret) hex
        name          TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,       -- JSON array of exact redirect URIs
        scopes        TEXT NOT NULL DEFAULT 'openid profile email',
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    id: "0011_notifications",
    // Durable, per-user notifications. Previously these lived only in the
    // browser's localStorage, which meant nothing the *server* noticed (a disk
    // failing at 3am, an app update) could ever reach the user.
    sql: `
      CREATE TABLE notifications (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        level      TEXT NOT NULL DEFAULT 'info',   -- info|success|warning|critical
        title      TEXT NOT NULL,
        body       TEXT,
        app_id     TEXT,                            -- app to open when clicked
        -- Collapses repeats of the same ongoing condition (e.g. one disk failing).
        dedupe_key TEXT,
        created_at TEXT NOT NULL,
        read_at    TEXT
      );
      CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
      CREATE INDEX idx_notifications_dedupe ON notifications(user_id, dedupe_key);
    `,
  },
  {
    id: "0012_scheduled_tasks",
    // Work an installed app asked OpenNAS to do on a schedule. Apps are sandboxed
    // iframes with no server-side code, so the *server* performs the action -
    // which is why each action maps onto a capability the app already declared.
    sql: `
      CREATE TABLE scheduled_tasks (
        id            TEXT PRIMARY KEY,
        app_id        TEXT NOT NULL,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,            -- app-chosen, unique per app+user
        interval_sec  INTEGER NOT NULL,
        action        TEXT NOT NULL,            -- JSON ScheduledAction
        enabled       INTEGER NOT NULL DEFAULT 1,
        next_run_at   TEXT NOT NULL,
        last_run_at   TEXT,
        last_status   TEXT,                     -- ok | error
        last_error    TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_tasks_app_user_name ON scheduled_tasks(app_id, user_id, name);
      CREATE INDEX idx_tasks_due ON scheduled_tasks(enabled, next_run_at);
    `,
  },
  {
    id: "0013_audit_log",
    // Who did what, when. Actor identity is denormalised on purpose: the record
    // has to stay meaningful after the account is deleted, which is exactly the
    // case you most want a log for.
    sql: `
      CREATE TABLE audit_log (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        actor_id    TEXT,                  -- NULL for unauthenticated or system
        actor_name  TEXT NOT NULL,         -- username at the time, or 'system'
        actor_ip    TEXT,
        action      TEXT NOT NULL,         -- e.g. 'admin.users.delete'
        target      TEXT,                  -- what it acted on
        detail      TEXT,                  -- JSON, secrets stripped
        outcome     TEXT NOT NULL,         -- ok | denied | error
        status      INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);
      CREATE INDEX idx_audit_actor ON audit_log(actor_id, at DESC);
      CREATE INDEX idx_audit_action ON audit_log(action, at DESC);
    `,
  },
  {
    id: "0014_login_attempts",
    // Failed sign-ins per account. The existing rate limit is per-IP, which does
    // nothing about a slow or distributed attack on one account.
    sql: `
      CREATE TABLE login_attempts (
        username     TEXT PRIMARY KEY,     -- lowercased; tracked even if no such user
        failures     INTEGER NOT NULL DEFAULT 0,
        first_fail_at TEXT,
        last_fail_at TEXT,
        locked_until TEXT
      );
    `,
  },
  {
    id: "0015_account_security",
    // Two-factor, and the two "you must do this before you can use the box"
    // flags. `must_change_password` backs admin-issued temporary passwords;
    // the passkey requirement is a global policy in `settings`, so it has no
    // column of its own - whether a user satisfies it is just a credential count.
    sql: `
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE user_totp (
        user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret         TEXT NOT NULL,      -- base32
        confirmed_at   TEXT,               -- NULL while enrolment is unfinished
        created_at     TEXT NOT NULL,
        last_used_step INTEGER              -- replay guard: highest step accepted
      );

      CREATE TABLE totp_recovery_codes (
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,           -- sha256; the codes are high-entropy
        used_at   TEXT,
        PRIMARY KEY (user_id, code_hash)
      );

      -- A password login that still owes a second factor. Short-lived and
      -- single-use, so it is never a bearer token for the account.
      CREATE TABLE mfa_tickets (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    id: "0016_groups_and_acls",
    // Groups, folder-level ACLs, and a per-share recycle bin.
    //
    // Permissions were per-user only, which stops scaling the moment a household
    // or team has more than a handful of people, and they stopped at the share
    // root, so "everyone can read /projects but only finance sees payroll" had
    // no expression at all.
    sql: `
      CREATE TABLE groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,   -- also the system group name
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );

      CREATE TABLE group_members (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE INDEX idx_group_members_user ON group_members(user_id);

      CREATE TABLE share_group_permissions (
        share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        level    TEXT NOT NULL DEFAULT 'rw',  -- ro | rw
        PRIMARY KEY (share_id, group_id)
      );

      -- One rule for one subject on one folder below a share root. \`path\` is
      -- normalised relative to that root, with no leading or trailing slash;
      -- the empty string would be the root itself, which share_permissions
      -- already covers, so it is never stored.
      CREATE TABLE folder_acls (
        id           TEXT PRIMARY KEY,
        share_id     TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        path         TEXT NOT NULL,
        subject_type TEXT NOT NULL,          -- user | group
        subject_id   TEXT NOT NULL,
        level        TEXT NOT NULL,          -- none | ro | rw
        created_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_folder_acl_subject ON folder_acls(share_id, path, subject_type, subject_id);
      CREATE INDEX idx_folder_acl_share ON folder_acls(share_id);

      -- Samba's vfs_recycle: a delete over SMB moves the file aside instead of
      -- destroying it, matching what the web UI has always done.
      ALTER TABLE shares ADD COLUMN recycle_enabled INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: "0017_app_repos_and_settings",
    // Two app-platform additions.
    //
    // `source_repo` records which repository an app came from. Updates are then
    // only ever taken from that same repository: without it, adding a second
    // repo that happens to publish the same app id at a higher version would
    // silently hand that app over to a different publisher.
    //
    // `app_settings` backs the per-app settings panel. `user_id` is '' rather
    // than NULL for admin-scoped values, because SQLite permits NULLs in a
    // primary key and would then allow duplicate rows for the same setting.
    sql: `
      ALTER TABLE installed_apps ADD COLUMN source_repo TEXT;

      CREATE TABLE app_settings (
        app_id  TEXT NOT NULL,
        user_id TEXT NOT NULL,      -- '' = admin-scoped, shared by everyone
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,      -- JSON-encoded scalar
        PRIMARY KEY (app_id, user_id, key)
      );
      CREATE INDEX idx_app_settings_app ON app_settings(app_id);
    `,
  },
  {
    id: "0018_share_quotas",
    // Per-share size caps, backed by filesystem *project* quotas.
    //
    // `quota_project_id` is the project id the filesystem knows the share by.
    // It has to be stable and unique per share and can't be derived from the
    // name (renaming would orphan the tag), so it is allocated once here.
    // Deliberately not per-*user*: Samba maps every connection to the single
    // `opennas` account, so a per-user filesystem quota would charge every
    // byte anyone wrote to the same user.
    sql: `
      ALTER TABLE shares ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shares ADD COLUMN quota_project_id INTEGER;
    `,
  },
  {
    id: "0019_app_share_grants",
    // Folders a user handed to an app through the host-drawn picker.
    //
    // This is a *narrowing* record, never a widening one: the grant says which
    // path an app may ask about, and the server still resolves the user's own
    // access to that path on every call. So losing access to a share, or a
    // folder rule turning read-only, takes effect at once no matter what grants
    // exist - and a grant left behind by an uninstalled app can't resurrect
    // anything.
    //
    // Keyed by (app, user, path) so re-picking the same folder updates the row
    // rather than accumulating duplicates the user would have to revoke twice.
    sql: `
      CREATE TABLE app_share_grants (
        id           TEXT PRIMARY KEY,
        app_id       TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        path         TEXT NOT NULL,
        type         TEXT NOT NULL,      -- 'file' | 'dir'
        mode         TEXT NOT NULL,      -- 'read' | 'readwrite'
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        UNIQUE (app_id, user_id, path)
      );
      CREATE INDEX idx_app_share_grants_app_user ON app_share_grants(app_id, user_id);
    `,
  },
  {
    id: "0020_time_machine",
    // Offer a share to macOS as a Time Machine destination.
    //
    // Samba's `fruit` module does the actual work and was already loaded. What
    // OpenNAS adds is the toggle, the mDNS record that makes macOS *offer* the
    // share in System Settings (without it the share is reachable but nothing
    // suggests it as a backup target), and a size cap - Time Machine grows until
    // the volume is full otherwise, which on a NAS takes everything else down
    // with it. The cap reuses the share's existing quota rather than adding a
    // second number that could contradict it.
    sql: `
      ALTER TABLE shares ADD COLUMN time_machine INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: "0021_nfs_rules",
    // Per-share NFS export rules.
    //
    // Until now every NFS share got one global list of allowed networks, and
    // read/write came from `guest_access` - an SMB concept that has nothing to
    // do with NFS, so a share that was read-only over SMB was read-only over NFS
    // whether or not that made sense. These rules replace both: a share with no
    // rules still falls back to the global list, so nothing changes for anyone
    // who hasn't set any.
    //
    // `root_squash` defaults on because the alternative hands remote root full
    // ownership of everything in the share, and that should never be the thing
    // you get by not thinking about it.
    sql: `
      CREATE TABLE share_nfs_rules (
        id          TEXT PRIMARY KEY,
        share_id    TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
        network     TEXT NOT NULL,
        level       TEXT NOT NULL,            -- 'ro' | 'rw'
        root_squash INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        UNIQUE (share_id, network)
      );
      CREATE INDEX idx_share_nfs_rules_share ON share_nfs_rules(share_id);
    `,
  },
  {
    id: "0022_system_tasks",
    // Maintenance the NAS runs on a schedule.
    //
    // Deliberately a *fixed catalogue* of task kinds rather than "run this
    // script": an arbitrary command scheduled from the web UI is a clean path
    // from an admin session to root code execution, and the things people
    // actually want scheduled on a NAS - a config backup, a scrub, a SMART test,
    // a trim - are a short list. Anyone who genuinely needs a custom script has
    // cron and an SSH login.
    //
    // `last_output` is capped by the writer rather than the schema; SQLite has
    // no length constraint worth relying on here.
    sql: `
      CREATE TABLE system_tasks (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL,      -- 'config-backup' | 'scrub' | 'trim' | 'smart-test'
        target       TEXT NOT NULL DEFAULT '',   -- volume label or disk path, per kind
        options      TEXT NOT NULL DEFAULT '{}', -- JSON, kind-specific
        frequency    TEXT NOT NULL,      -- 'daily' | 'weekly' | 'monthly'
        hour         INTEGER NOT NULL DEFAULT 3,
        minute       INTEGER NOT NULL DEFAULT 0,
        weekday      INTEGER NOT NULL DEFAULT 0, -- 0=Sunday, for 'weekly'
        day_of_month INTEGER NOT NULL DEFAULT 1, -- for 'monthly'
        enabled      INTEGER NOT NULL DEFAULT 1,
        next_run_at  TEXT NOT NULL,
        last_run_at  TEXT,
        last_status  TEXT,               -- 'ok' | 'error' | 'running'
        last_output  TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_system_tasks_due ON system_tasks(enabled, next_run_at);
    `,
  },
  {
    id: "0023_ip_bans",
    // Addresses blocked for repeated failed sign-ins.
    //
    // The *enforcement* lives in an nftables set with a per-element timeout, so
    // the kernel lifts a ban on its own whether or not OpenNAS is running. This
    // table is the record: what was banned, why, and until when, so the admin
    // has something to look at and something to lift early. The two can drift
    // (a reboot clears the kernel set but not this table), which is why the UI
    // reads the live set rather than trusting these rows.
    sql: `
      CREATE TABLE ip_bans (
        address    TEXT PRIMARY KEY,
        reason     TEXT NOT NULL,
        failures   INTEGER NOT NULL DEFAULT 0,
        banned_at  TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      -- Failed sign-ins per source address, the other half of the per-account
      -- tracking in login_attempts: that one catches a slow attack on one
      -- account, this one catches an address working through many usernames.
      CREATE TABLE ip_attempts (
        address       TEXT PRIMARY KEY,
        failures      INTEGER NOT NULL DEFAULT 0,
        first_fail_at TEXT,
        last_fail_at  TEXT
      );
    `,
  },
  {
    id: "0024_secrets_at_rest",
    // Existing rows still hold raw tokens; the code that reads them now expects
    // hashes. Sessions and half-finished logins are cheap to throw away, so they
    // are - everyone signs in again once, which is the safe direction and takes
    // a moment. The values that *cannot* be regenerated (TOTP secrets, stored
    // passwords) are converted in code immediately after this runs, because
    // encrypting them needs the key and SQL cannot reach it.
    sql: `
      DELETE FROM sessions;
      DELETE FROM mfa_tickets;
      DELETE FROM webauthn_challenges;
      DELETE FROM oidc_states;
    `,
  },
  {
    id: "0025_app_access",
    // Which apps a user may use. Two parts, because "no rows" has to mean
    // something unambiguous: `apps_restricted` says whether the list applies at
    // all, and `app_access` is the list. Without the flag, a restricted user
    // allowed nothing would be indistinguishable from an unrestricted one - and
    // every existing account would have to be back-filled with a row per app to
    // keep working.
    sql: `
      ALTER TABLE users ADD COLUMN apps_restricted INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS app_access (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app_id  TEXT NOT NULL,
        PRIMARY KEY (user_id, app_id)
      );
      CREATE INDEX IF NOT EXISTS idx_app_access_user ON app_access(user_id);
    `,
  },
];

/**
 * Encrypt anything still sitting in the clear.
 *
 * Separate from the SQL migrations because sealing a value needs the key, and a
 * migration is a string of SQL. Written to be safe to run on every boot: a value
 * that is already sealed is left alone, so this converges rather than
 * double-encrypting, and a value that fails to seal is left as it was rather
 * than replaced with something unreadable.
 */
function sealExistingSecrets(): void {
  let sealed = 0;
  try {
    const totp = db.prepare("SELECT user_id, secret FROM user_totp").all() as
      { user_id: string; secret: string }[];
    const update = db.prepare("UPDATE user_totp SET secret = ? WHERE user_id = ?");
    for (const row of totp) {
      // Plaintext gets sealed; an `enc1:` value gets re-sealed in the newer
      // format. Reading it back first means a value that cannot be decrypted —
      // a restored database with the wrong key file, say — is left exactly as
      // it was rather than replaced with something unreadable.
      if (needsUpgrade(row.secret)) {
        const plain = decryptSecret(row.secret);
        if (plain === null) continue;
        update.run(encryptSecret(plain), row.user_id);
        sealed++;
        continue;
      }
      if (isEncrypted(row.secret)) continue;
      update.run(encryptSecret(row.secret), row.user_id);
      sealed++;
    }

    const settings = db.prepare("SELECT key, value FROM settings").all() as
      { key: string; value: string }[];
    const setValue = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
    for (const row of settings) {
      if (!SECRET_SETTINGS.has(row.key)) continue;
      if (needsUpgrade(row.value)) {
        const plain = decryptSecret(row.value);
        if (plain === null) continue;
        setValue.run(encryptSecret(plain), row.key);
        sealed++;
        continue;
      }
      if (isEncrypted(row.value)) continue;
      setValue.run(encryptSecret(row.value), row.key);
      sealed++;
    }

    if (sealed > 0) {
      // Rewriting a value does not erase the old one. SQLite leaves the previous
      // bytes in free pages, so a database that has *just* been encrypted still
      // has every plaintext secret sitting in it, which would make the whole
      // exercise pointless on exactly the machines that most needed it.
      // VACUUM rebuilds the file and drops that free space - but on its own it
      // is not enough in WAL mode: the rebuild lands in the write-ahead log and
      // the main file keeps its old pages until the log is folded back in.
      // Checkpointing with TRUNCATE first, then vacuuming, is what actually
      // leaves no readable copy behind. Verified by grepping the file for a
      // known secret before and after - with only the VACUUM, it was still
      // there.
      //
      // It is not a guarantee even so: the *filesystem* may still hold the
      // released blocks, and any snapshot or backup taken beforehand is
      // untouched. It removes the copy from the live file, which is the copy
      // that travels with it.
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      console.info(`sealed or upgraded ${sealed} secret(s) at rest and rewrote the database to drop the old copies`);
    }
  } catch (err) {
    // Never stop the NAS booting over this. The reader tolerates plaintext, so
    // the worst case is that a value stays as it was and is sealed on its next
    // write instead.
    console.warn("could not seal existing secrets at rest:", err);
  }
}

function migrate(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r) => (r as { id: string }).id),
  );

  const insert = db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");
  const runAll = db.transaction((pending: typeof MIGRATIONS) => {
    for (const m of pending) {
      db.exec(m.sql);
      insert.run(m.id, new Date().toISOString());
    }
  });

  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (pending.length > 0) runAll(pending);
}

migrate();

sealExistingSecrets();

// Again after migrating: SQLite creates the `-wal` and `-shm` sidecars lazily on
// the first write, so at the point the connection was opened they usually did
// not exist yet and the pass above had nothing to fix. Migrating always writes,
// so by here they do. Setting the process umask instead would have been simpler
// and wrong - it would also narrow the share directories, which are deliberately
// group-accessible so Samba's `force user` mapping works.
lockDownDatabaseFiles();

/** Best-effort cleanup of expired ephemeral rows. Cheap; run on an interval. */
export function pruneEphemeral(): void {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes
  db.prepare("DELETE FROM webauthn_challenges WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM oidc_states WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM mfa_tickets WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  // Read notifications older than 30 days aren't worth keeping.
  const staleReads = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?").run(staleReads);
}
