import type { InstalledTheme, UserPreferences } from "@opennas/shared";
import { applyAccent } from "./accents.ts";
import { applyTheme } from "./theme.ts";
import { wallpaperById } from "./wallpapers.ts";

/** CSS variables a theme may set - cleared when switching back to a built-in look. */
const THEME_VAR_KEYS = ["--radius-window", "--color-ink", "--color-ink-soft", "--color-ink-faint", "--shadow-window", "--shadow-panel"];

function applyInstalledTheme(t: InstalledTheme): void {
  const root = document.documentElement;
  root.style.setProperty("--color-brand-400", t.accent["400"]);
  root.style.setProperty("--color-brand-500", t.accent["500"]);
  root.style.setProperty("--color-brand-600", t.accent["600"]);
  root.style.setProperty("--color-brand-700", t.accent["700"]);
  // Reset any vars from a previous theme, then apply this one's.
  for (const k of THEME_VAR_KEYS) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
}

function clearThemeVars(): void {
  const root = document.documentElement;
  for (const k of THEME_VAR_KEYS) root.style.removeProperty(k);
}

/** The currently-applied theme, or null when using the built-in accent/wallpaper. */
export function activeTheme(prefs: UserPreferences, themes: InstalledTheme[]): InstalledTheme | null {
  return prefs.themeId ? themes.find((t) => t.id === prefs.themeId) ?? null : null;
}

/** Apply accent + theme vars based on prefs (an installed theme wins for accent +
 *  vars), then the light/dark mode - which always follows the user's own pref. */
export function applyAppearance(prefs: UserPreferences, themes: InstalledTheme[]): void {
  const theme = activeTheme(prefs, themes);
  if (theme) {
    applyInstalledTheme(theme);
  } else {
    clearThemeVars();
    applyAccent(prefs.accent);
  }
  applyTheme(prefs.theme);
}

/** The desktop wallpaper CSS `background` - a theme's wallpaper, else the built-in. */
export function resolveWallpaper(prefs: UserPreferences, themes: InstalledTheme[]): string {
  const theme = activeTheme(prefs, themes);
  return theme ? theme.wallpaper : wallpaperById(prefs.wallpaper).background;
}
