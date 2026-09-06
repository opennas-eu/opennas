import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { InstalledTheme, ThemeAccentShades } from "@opennas/shared";
import { config } from "../config.js";
import { upsertInstalledTheme, removeInstalledTheme } from "../db/installed-themes.js";

/** A user-facing install error → mapped to 400 by the route. */
export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeError";
  }
}

const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // themes are small (a wallpaper at most)
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** Reject a zip bomb by its declared uncompressed size before decompressing. */
function checkUncompressedSize(buf: Uint8Array): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ThemeError("That isn't a valid .onthm theme.");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new ThemeError("The theme has too many files.");
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) throw new ThemeError("The theme's directory is corrupt.");
    const uncompressed = dv.getUint32(off + 24, true);
    if (uncompressed === 0xffffffff) throw new ThemeError("zip64 themes aren't supported.");
    total += uncompressed;
    if (total > MAX_TOTAL_BYTES) throw new ThemeError("The theme is too large.");
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
}

const relPath = z
  .string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/\-]*$/, "must be a relative path")
  .refine((s) => !s.split("/").includes(".."), "must not contain '..'");

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex colour");
const shades = z.object({ "400": hex, "500": hex, "600": hex, "700": hex });

const manifestSchema = z.object({
  themeVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, "id: lowercase letters, digits, '.', '_' or '-'"),
  name: z.string().trim().min(1).max(64),
  author: z.string().max(64).optional().default(""),
  description: z.string().max(280).optional().default(""),
  mode: z.enum(["light", "dark"]),
  accent: z.union([hex, shades]),
  wallpaper: z.string().trim().min(1).max(2000),
  vars: z.record(z.string().max(64), z.string().max(200)).optional().default({}),
});

// ---- colour + CSS helpers --------------------------------------------------
function hexToRgb(h: string): number[] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function rgbToHex(rgb: number[]): string {
  return "#" + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
}
function mix(a: number[], b: number[], t: number): number[] {
  return a.map((x, i) => x + (b[i]! - x) * t);
}
function shadesFromHex(h: string): ThemeAccentShades {
  const rgb = hexToRgb(h);
  return {
    "400": rgbToHex(mix(rgb, [255, 255, 255], 0.36)),
    "500": rgbToHex(mix(rgb, [255, 255, 255], 0.18)),
    "600": h,
    "700": rgbToHex(mix(rgb, [0, 0, 0], 0.18)),
  };
}

/** CSS values are injected as variables/background - keep them to a safe charset
 *  (no url()/expression/script, no statement breaks). Returns null if unsafe. */
function sanitizeCss(v: string): string | null {
  if (/url\s*\(|expression|javascript:|@import|[<>{};"`]/i.test(v)) return null;
  if (!/^[a-zA-Z0-9#%.,()\s/+-]+$/.test(v)) return null;
  return v.trim();
}

/** CSS variables a theme may override (anything else is ignored). */
const ALLOWED_VARS = new Set(["--radius-window", "--color-ink", "--color-ink-soft", "--color-ink-faint", "--shadow-window", "--shadow-panel"]);

function safeJoin(base: string, entry: string): string {
  const dest = resolve(base, entry);
  if (dest !== base && !dest.startsWith(base + sep)) throw new ThemeError("Theme contains an unsafe file path.");
  return dest;
}

/**
 * Install a theme from a `.onthm` (zip) buffer: validate the manifest, extract a
 * packaged wallpaper image, resolve everything to an InstalledTheme, and persist.
 */
export async function installThemeFromZip(buf: Buffer | Uint8Array): Promise<InstalledTheme> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  checkUncompressedSize(bytes);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ThemeError("That isn't a valid .onthm theme (couldn't read the archive).");
  }

  const raw = files["theme.json"];
  if (!raw) throw new ThemeError("Theme is missing theme.json at its root.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ThemeError("theme.json is not valid JSON.");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ThemeError(`Invalid theme: ${issue ? `${issue.path.join(".")} - ${issue.message}` : "check the format"}.`);
  }
  const m = result.data;

  // Resolve the wallpaper: a packaged image → url(); otherwise a CSS background.
  let wallpaper: string;
  const isImage = IMG_RE.test(m.wallpaper);
  if (isImage) {
    if (!relPath.safeParse(m.wallpaper).success || !files[m.wallpaper]) {
      throw new ThemeError(`The wallpaper image "${m.wallpaper}" is not in the theme.`);
    }
    wallpaper = `url('/theme-content/${m.id}/${m.wallpaper}') center / cover no-repeat fixed`;
  } else {
    const css = sanitizeCss(m.wallpaper);
    if (!css) throw new ThemeError("The wallpaper CSS contains unsupported values.");
    wallpaper = css;
  }

  // Allow-listed, sanitized CSS variable overrides.
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.vars)) {
    if (!ALLOWED_VARS.has(k)) continue;
    const clean = sanitizeCss(v);
    if (clean) vars[k] = clean;
  }

  const theme: InstalledTheme = {
    id: m.id,
    name: m.name,
    author: m.author,
    description: m.description,
    mode: m.mode,
    accent: typeof m.accent === "string" ? shadesFromHex(m.accent) : m.accent,
    wallpaper,
    vars,
  };

  // Extract only the wallpaper image (the rest is metadata) into the theme dir.
  const dir = join(config.themesDir, m.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (isImage) {
    const dest = safeJoin(dir, m.wallpaper);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, files[m.wallpaper]!);
  }

  upsertInstalledTheme(theme);
  return theme;
}

export async function uninstallTheme(id: string): Promise<void> {
  removeInstalledTheme(id);
  await rm(join(config.themesDir, id), { recursive: true, force: true });
}
