/**
 * Custom themes (`.onthm` packages). A theme bundles an accent palette, a
 * wallpaper, a base mode and a few CSS-variable overrides - installed at runtime
 * for deeper personalization than the built-in accent/wallpaper pickers.
 */

export interface ThemeAccentShades {
  "400": string;
  "500": string;
  "600": string;
  "700": string;
}

/** What a creator writes in `theme.json` at the root of an `.onthm` package. */
export interface ThemeManifest {
  themeVersion: 1;
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** Base light/dark mode the theme is designed for. */
  mode: "light" | "dark";
  /** A single accent hex (shades auto-derived) or explicit 400/500/600/700. */
  accent: string | ThemeAccentShades;
  /** A CSS `background` value (e.g. a gradient) OR a packaged image filename. */
  wallpaper: string;
  /** Optional allow-listed CSS variable overrides, e.g. {"--radius-window":"16px"}. */
  vars?: Record<string, string>;
}

/** A resolved, ready-to-apply theme as returned by the API. */
export interface InstalledTheme {
  id: string;
  name: string;
  author: string;
  description: string;
  mode: "light" | "dark";
  accent: ThemeAccentShades;
  /** CSS `background` value - a packaged image is already resolved to `url(...)`. */
  wallpaper: string;
  /** Sanitized CSS variable overrides applied to the document root. */
  vars: Record<string, string>;
}

export interface ThemesResponse {
  themes: InstalledTheme[];
}

export interface ThemeInstallResponse {
  theme: InstalledTheme;
}
