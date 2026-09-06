import { create } from "zustand";
import { DEFAULT_PREFERENCES, type InstalledTheme, type PreferencesResponse, type UserPreferences } from "@opennas/shared";
import { api } from "../lib/api.ts";
import { applyAppearance } from "../lib/appearance.ts";

/** Current installed themes (read lazily to avoid a store import cycle). */
function currentThemes(): InstalledTheme[] {
  // The themes store registers a getter here once it's loaded.
  return themesGetter?.() ?? [];
}
let themesGetter: (() => InstalledTheme[]) | null = null;
export function registerThemesGetter(fn: () => InstalledTheme[]): void {
  themesGetter = fn;
}

interface PrefsStore {
  preferences: UserPreferences;
  loaded: boolean;
  load: () => Promise<void>;
  update: (partial: Partial<UserPreferences>) => Promise<void>;
}

export const usePrefs = create<PrefsStore>((set, get) => ({
  preferences: DEFAULT_PREFERENCES,
  loaded: false,

  async load() {
    try {
      const res = await api.get<PreferencesResponse>("/prefs");
      set({ preferences: res.preferences, loaded: true });
      applyAppearance(res.preferences, currentThemes());
    } catch {
      set({ loaded: true });
    }
  },

  async update(partial) {
    // Optimistic: apply immediately, persist in the background.
    const next = { ...get().preferences, ...partial };
    set({ preferences: next });
    applyAppearance(next, currentThemes());
    try {
      await api.put<PreferencesResponse>("/prefs", partial);
    } catch {
      /* keep optimistic value; a reload will reconcile */
    }
  },
}));
