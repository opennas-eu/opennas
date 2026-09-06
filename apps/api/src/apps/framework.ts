import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { AppManifest } from "@opennas/shared";
import { config } from "../config.js";
import { pruneUnknownSettings } from "../db/app-settings.js";
import { upsertInstalledApp, removeInstalledApp } from "../db/installed-apps.js";
import { BUILTIN_APPS } from "./registry.js";
import { CATALOG } from "../packages/catalog.js";
import { isValidHostPattern } from "./fetch-proxy.js";

/** A user-facing install error → mapped to a 400 by the route. */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

/** Ids that an installed app must not collide with (built-ins + catalog packages). */
const RESERVED_IDS = new Set<string>([
  ...BUILTIN_APPS.map((a) => a.id),
  ...CATALOG.map((p) => p.info.id),
]);

// Defensive caps against malicious archives (zip bombs / huge trees).
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MB uncompressed

/**
 * Sum the *declared* uncompressed sizes from the ZIP central directory WITHOUT
 * decompressing - so a zip bomb is rejected before `unzipSync` allocates it.
 * Returns the total, or throws AppError if the archive is malformed, uses zip64,
 * or exceeds the cap. (Central-dir sizes are authoritative even for streamed zips.)
 */
function checkUncompressedSize(buf: Uint8Array): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Find the End Of Central Directory record (sig 0x06054b50), scanning back
  // past an optional trailing comment (≤ 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new AppError("That isn't a valid .onpkg package.");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new AppError("The package has too many files.");

  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) {
      throw new AppError("The package's directory is corrupt.");
    }
    const uncompressed = dv.getUint32(off + 24, true);
    if (uncompressed === 0xffffffff) throw new AppError("zip64 packages aren't supported.");
    total += uncompressed;
    if (total > MAX_TOTAL_BYTES) throw new AppError("The package is too large when unpacked.");
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    off += 46 + nameLen + extraLen + commentLen;
  }
}

/** A safe relative path inside the package (no traversal, no absolute paths). */
const relPath = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/\-]*$/, "must be a relative path")
  .refine((s) => !s.split("/").includes(".."), "must not contain '..'");

/** The JS type a settings field's value (and default) must have. */
function expectedType(type: "text" | "number" | "boolean" | "select"): "string" | "number" | "boolean" {
  return type === "number" ? "number" : type === "boolean" ? "boolean" : "string";
}

const manifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, "id must be lowercase letters, digits, '.', '_' or '-'"),
  name: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(32),
  author: z.string().max(64).optional().default(""),
  description: z.string().max(280).optional().default(""),
  icon: relPath,
  iconGradient: z
    .string()
    .max(128)
    .regex(/^[a-z0-9/\s[\]#%.-]*$/i, "invalid gradient")
    .optional()
    .default("from-slate-400 to-slate-600"),
  category: z.enum(["system", "utilities", "media", "productivity", "developer"]).optional().default("utilities"),
  entry: relPath,
  minRole: z.enum(["admin", "user"]).optional().default("user"),
  /** Publisher's ed25519 public key (base64 SPKI DER) - present on signed apps. */
  publisherKey: z.string().max(4096).optional(),
  permissions: z.array(z.enum(["notifications", "storage", "user", "files", "system", "fetch", "schedule"])).optional().default([]),
  /** Hosts the fetch proxy may reach. Required when "fetch" is requested. */
  fetchHosts: z
    .array(z.string().trim().toLowerCase().max(253))
    .max(10)
    .optional()
    .default([]),
  /** Packaged screenshot images shown on the app's detail page. */
  screenshots: z.array(relPath).max(8).optional().default([]),
  /**
   * Fields OpenNAS renders a settings form for. The app never draws this form
   * itself - it reads the resolved values through `app.settings.all()` - which
   * keeps the inputs (and anything typed into them) in the trusted UI rather
   * than inside the sandboxed iframe.
   */
  settings: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(48).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/),
        label: z.string().trim().min(1).max(80),
        type: z.enum(["text", "number", "boolean", "select"]),
        scope: z.enum(["user", "admin"]).optional().default("user"),
        description: z.string().trim().max(240).optional(),
        default: z.union([z.string().max(2048), z.number(), z.boolean()]).optional(),
        options: z
          .array(z.object({ value: z.string().max(120), label: z.string().trim().min(1).max(80) }))
          .max(50)
          .optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        secret: z.boolean().optional(),
        placeholder: z.string().trim().max(80).optional(),
      }),
    )
    .max(30)
    .optional()
    .default([]),
  window: z
    .object({
      defaultWidth: z.number().int().min(240).max(4000),
      defaultHeight: z.number().int().min(180).max(4000),
      minWidth: z.number().int().min(200).max(4000),
      minHeight: z.number().int().min(150).max(4000),
      resizable: z.boolean(),
    })
    .optional()
    .default({ defaultWidth: 760, defaultHeight: 560, minWidth: 420, minHeight: 320, resizable: true }),
})
  .superRefine((m, ctx) => {
    // "fetch" without hosts would be a permission with nothing behind it, and
    // hosts without "fetch" is dead weight an admin would still be shown.
    const wantsFetch = m.permissions.includes("fetch");
    if (wantsFetch && m.fetchHosts.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fetchHosts"], message: 'the "fetch" permission requires at least one host' });
    }
    if (!wantsFetch && m.fetchHosts.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fetchHosts"], message: 'fetchHosts needs the "fetch" permission' });
    }
    // Settings fields have to be internally consistent, or the form OpenNAS
    // renders for them would be nonsense the app author can't see.
    const keys = new Set<string>();
    for (const f of m.settings) {
      if (keys.has(f.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `duplicate setting key "${f.key}"` });
      }
      keys.add(f.key);
      if (f.type === "select" && (!f.options || f.options.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" is a select with no options` });
      }
      if (f.type !== "select" && f.options?.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" has options but isn't a select` });
      }
      if (f.type !== "number" && (f.min !== undefined || f.max !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" has min/max but isn't a number` });
      }
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" has min greater than max` });
      }
      if (f.secret && f.type !== "text") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" is marked secret but isn't a text field` });
      }
      if (f.default !== undefined && typeof f.default !== expectedType(f.type)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" has a default of the wrong type` });
      }
      if (f.type === "select" && typeof f.default === "string" && !f.options?.some((o) => o.value === f.default)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: `"${f.key}" defaults to a value that isn't one of its options` });
      }
    }
    for (const host of m.fetchHosts) {
      if (!isValidHostPattern(host)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fetchHosts"], message: `"${host}" is not a valid host or *.host pattern` });
      }
    }
  });

type ManifestData = z.infer<typeof manifestSchema>;

/**
 * Canonical digest of a package's contents (everything except the SIGNATURE).
 * Order-independent: filenames are sorted, each contributes `name\n sha256(content)\n`.
 * Must stay byte-for-byte identical to the signing tool (packages/app-sdk/opennas-sign.mjs).
 */
function canonicalDigest(files: Record<string, Uint8Array>): Buffer {
  const names = Object.keys(files).filter((n) => n !== "SIGNATURE" && !n.endsWith("/")).sort();
  const h = createHash("sha256");
  for (const name of names) {
    h.update(name + "\n");
    h.update(createHash("sha256").update(files[name]!).digest("hex") + "\n");
  }
  return h.digest();
}

/** Verify a package's ed25519 signature against the publisher key in its manifest. */
function verifyPackage(files: Record<string, Uint8Array>, publisherKeyB64?: string): { signed: boolean; fingerprint: string | null } {
  const sig = files["SIGNATURE"];
  if (!sig || !publisherKeyB64) return { signed: false, fingerprint: null };
  try {
    const der = Buffer.from(publisherKeyB64, "base64");
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    const signature = Buffer.from(new TextDecoder().decode(sig).trim(), "base64");
    if (!cryptoVerify(null, canonicalDigest(files), pub, signature)) return { signed: false, fingerprint: null };
    return { signed: true, fingerprint: createHash("sha256").update(der).digest("hex") };
  } catch {
    return { signed: false, fingerprint: null };
  }
}

function toAppManifest(m: ManifestData, signature: { signed: boolean; fingerprint: string | null }): AppManifest {
  return {
    id: m.id,
    name: m.name,
    icon: m.icon,
    iconGradient: m.iconGradient,
    category: m.category,
    description: m.description,
    kind: "external",
    minRole: m.minRole,
    window: m.window,
    showOnDesktop: false,
    version: m.version,
    author: m.author,
    entry: m.entry,
    permissions: m.permissions,
    signed: signature.signed,
    publisherFingerprint: signature.fingerprint,
    screenshots: m.screenshots,
    fetchHosts: m.fetchHosts,
    settings: m.settings,
  };
}

/** Resolve a zip entry under `base`, rejecting any path that escapes it (zip-slip). */
function safeJoin(base: string, entry: string): string {
  const dest = resolve(base, entry);
  if (dest !== base && !dest.startsWith(base + sep)) {
    throw new AppError("Package contains an unsafe file path.");
  }
  return dest;
}

/**
 * A package that passed every check but hasn't touched the disk yet. Holding this
 * is what lets the install routes show an admin exactly what the package asks for
 * *before* committing it (see apps/staging.ts).
 */
export interface ValidatedPackage {
  manifest: AppManifest;
  /** Pre-resolved destinations + contents. Every path is already proven in-bounds. */
  writes: { dest: string; content: Uint8Array }[];
  appDir: string;
}

/**
 * Validate a `.onpkg` (zip) buffer: archive sanity, manifest schema, reserved ids,
 * signature, and that no entry escapes the app's directory. Nothing is written.
 * Throws AppError for anything the user should see (bad zip, bad manifest, unsafe
 * paths).
 */
export function validatePackage(buf: Buffer | Uint8Array): ValidatedPackage {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // Zip-bomb defense: reject by declared uncompressed size before decompressing.
  checkUncompressedSize(bytes);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new AppError("That isn't a valid .onpkg package (couldn't read the archive).");
  }

  const entries = Object.entries(files).filter(([name]) => !name.endsWith("/"));
  if (entries.length === 0) throw new AppError("The package is empty.");
  if (entries.length > MAX_ENTRIES) throw new AppError("The package has too many files.");
  let total = 0;
  for (const [, content] of entries) {
    total += content.length;
    if (total > MAX_TOTAL_BYTES) throw new AppError("The package is too large when unpacked.");
  }

  const manifestRaw = files["opennas-app.json"];
  if (!manifestRaw) throw new AppError("Package is missing opennas-app.json at its root.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    throw new AppError("opennas-app.json is not valid JSON.");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AppError(`Invalid manifest: ${issue ? `${issue.path.join(".")} - ${issue.message}` : "check the format"}.`);
  }
  const data = result.data;

  if (RESERVED_IDS.has(data.id)) throw new AppError(`The app id "${data.id}" is reserved by OpenNAS.`);
  if (!files[data.entry]) throw new AppError(`The manifest's entry "${data.entry}" is not in the package.`);

  // Pre-resolve every destination FIRST, so a zip-slip entry is rejected before
  // we touch the disk (no partial extraction left behind on a bad package).
  const appDir = join(config.appsDir, data.id);
  const writes = entries.map(([name, content]) => ({ dest: safeJoin(appDir, name), content }));

  return { manifest: toAppManifest(data, verifyPackage(files, data.publisherKey)), writes, appDir };
}

/**
 * Write a validated package to disk and register it. Splitting this from
 * validation is what makes the permission-consent step possible: the package is
 * fully checked, then held, and only lands here once the admin has approved it.
 *
 * The DB upsert keeps the app's enabled flag, and per-user app storage/files are
 * untouched - so this doubles as the update path.
 */
export async function commitPackage(pkg: ValidatedPackage, sourceRepo?: string | null): Promise<AppManifest> {
  // Extract into a fresh per-app directory (replace any previous version).
  await rm(pkg.appDir, { recursive: true, force: true });
  for (const { dest, content } of pkg.writes) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  upsertInstalledApp(pkg.manifest, sourceRepo);
  // A new version may have dropped or renamed settings fields. Forget the values
  // behind fields that no longer exist, so a key later reintroduced with a
  // different meaning can't inherit an old one.
  pruneUnknownSettings(pkg.manifest.id, pkg.manifest.settings ?? []);
  return pkg.manifest;
}

/** Validate and install in one step - for paths that need no consent gate. */
export async function installFromZip(buf: Buffer | Uint8Array): Promise<AppManifest> {
  return commitPackage(validatePackage(buf));
}

/** Remove an installed app: its code, DB row, stored data, and per-user files. */
export async function uninstallApp(id: string): Promise<void> {
  removeInstalledApp(id);
  await rm(join(config.appsDir, id), { recursive: true, force: true });
  await rm(join(config.appDataDir, id), { recursive: true, force: true });
}

/** Root of an app's private file storage for one user. */
export function appDataBase(appId: string, userId: string): string {
  return join(config.appDataDir, appId, userId);
}

/**
 * Resolve a virtual path inside an app's per-user data folder to a real path,
 * guaranteeing it can't escape that folder. The "files" capability is scoped
 * entirely to here - never the user's shares or the rest of the disk.
 */
export function resolveAppDataPath(appId: string, userId: string, vpath: string): string {
  if (vpath.includes("\0")) throw new AppError("Invalid path.");
  const base = appDataBase(appId, userId);
  const clean = posix.normalize("/" + (vpath || "/")).replace(/\/+$/, "") || "/";
  const real = resolve(base, "." + clean);
  if (real !== base && !real.startsWith(base + sep)) {
    throw new AppError("Path escapes the app's data folder.");
  }
  return real;
}
