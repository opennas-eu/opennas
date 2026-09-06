import { create } from "zustand";
import type { InstalledTheme, ThemesResponse } from "@opennas/shared";
import { api } from "../lib/api.ts";
import { applyAppearance } from "../lib/appearance.ts";
import { usePrefs, registerThemesGetter } from "./prefs.ts";

interface ThemesStore {
  themes: InstalledTheme[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useThemes = create<ThemesStore>((set) => ({
  themes: [],
  loaded: false,

  async load() {
    try {
      const res = await api.get<ThemesResponse>("/themes");
      set({ themes: res.themes, loaded: true });
      // Re-apply now that the active theme's definition is available.
      applyAppearance(usePrefs.getState().preferences, res.themes);
    } catch {
      set({ loaded: true });
    }
  },
}));

// Let the prefs store read the current themes without a hard import cycle.
registerThemesGetter(() => useThemes.getState().themes);
