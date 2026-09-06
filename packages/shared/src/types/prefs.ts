/** Per-user UI preferences (personalization). */

export type ThemeMode = "light" | "dark" | "system";

export interface UserPreferences {
  /** Wallpaper id from the built-in catalog, or "custom". */
  wallpaper: string;
  /** Accent color hex, drives buttons/highlights. */
  accent: string;
  /** Taskbar position (future-proofing; "top" for now). */
  taskbarPosition: "top" | "bottom";
  /** Window/app chrome theme. "system" follows the OS preference. */
  theme: ThemeMode;
  /** Installed custom theme id to apply, or "" for none (use accent + wallpaper). */
  themeId: string;
  /**
   * True once the user has been through (or dismissed) the first-run wizard.
   * Stored per user, so a second admin added later still gets shown around.
   */
  onboarded: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  wallpaper: "aurora",
  accent: "#3b82f6",
  taskbarPosition: "top",
  theme: "system",
  themeId: "",
  onboarded: false,
};

export interface PreferencesResponse {
  preferences: UserPreferences;
}
