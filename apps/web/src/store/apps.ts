import { create } from "zustand";
import type { AppManifest, AppsResponse } from "@opennas/shared";
import { api } from "../lib/api.ts";

interface AppsStore {
  apps: AppManifest[];
  loaded: boolean;
  load: () => Promise<void>;
  byId: (id: string) => AppManifest | undefined;
}

export const useApps = create<AppsStore>((set, get) => ({
  apps: [],
  loaded: false,
  async load() {
    try {
      const res = await api.get<AppsResponse>("/apps");
      set({ apps: res.apps, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  byId: (id) => get().apps.find((a) => a.id === id),
}));
