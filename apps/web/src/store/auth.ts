import { create } from "zustand";
import type { BootstrapState, MeResponse, SessionInfo, User } from "@opennas/shared";
import { api } from "../lib/api.ts";

interface AuthState {
  status: "loading" | "ready";
  bootstrap: BootstrapState | null;
  session: SessionInfo | null;
  /** Load bootstrap + current session on app start. */
  init: () => Promise<void>;
  refreshBootstrap: () => Promise<void>;
  /** Re-read the session from the server (e.g. after clearing a pending action). */
  refresh: () => Promise<void>;
  setSession: (session: SessionInfo) => void;
  /** Patch the signed-in user in place (e.g. after a profile change). */
  setUser: (user: User) => void;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: "loading",
  bootstrap: null,
  session: null,

  async init() {
    try {
      const [bootstrap, me] = await Promise.all([
        api.get<BootstrapState>("/auth/bootstrap"),
        api.get<MeResponse>("/auth/me"),
      ]);
      set({ bootstrap, session: me.session, status: "ready" });
    } catch {
      set({ status: "ready" });
    }
  },

  async refresh() {
    try {
      const me = await api.get<MeResponse>("/auth/me");
      set({ session: me.session });
    } catch {
      /* keep the current session; a transient failure isn't a sign-out */
    }
  },

  async refreshBootstrap() {
    try {
      set({ bootstrap: await api.get<BootstrapState>("/auth/bootstrap") });
    } catch {
      /* keep previous */
    }
  },

  setSession(session) {
    set({ session });
    void get().refreshBootstrap();
  },

  setUser(user) {
    const session = get().session;
    if (session) set({ session: { ...session, user } });
  },

  async logout() {
    try {
      await api.post("/auth/logout");
    } finally {
      set({ session: null });
    }
  },
}));
