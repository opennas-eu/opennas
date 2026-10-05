import { create } from "zustand";
import type { ServerMessage, SystemSample, SystemStaticInfo } from "@opennas/shared";
import { useNotifications } from "./notifications.ts";
import { apiWsUrl } from "../lib/api.ts";

const HISTORY = 60; // ~60s of rolling history for the charts

interface SystemStore {
  connected: boolean;
  info: SystemStaticInfo | null;
  latest: SystemSample | null;
  history: SystemSample[];
  refCount: number;
  socket: WebSocket | null;
  /** Open the WS (idempotent, ref-counted by mounted consumers). */
  connect: () => void;
  disconnect: () => void;
}

export const useSystem = create<SystemStore>((set, get) => ({
  connected: false,
  info: null,
  latest: null,
  history: [],
  refCount: 0,
  socket: null,

  connect() {
    set((s) => ({ refCount: s.refCount + 1 }));
    if (get().socket) return;
    open(set, get);
  },

  disconnect() {
    const refCount = Math.max(0, get().refCount - 1);
    set({ refCount });
    if (refCount === 0) {
      const ws = get().socket;
      set({ socket: null, connected: false });
      // Detach before closing: the close event arrives later, possibly after a
      // new socket has been opened (React StrictMode unmounts and remounts
      // immediately), and this one must not touch the store by then.
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      }
    }
  },
}));

type SetFn = (partial: Partial<SystemStore> | ((s: SystemStore) => Partial<SystemStore>)) => void;
type GetFn = () => SystemStore;

function open(set: SetFn, get: GetFn): void {
  const ws = new WebSocket(apiWsUrl("/ws"));
  set({ socket: ws });

  // Every handler checks it still belongs to the current socket. A superseded
  // one's late events must not mark the store connected, feed it stale data,
  // or - worst - null out its replacement and orphan it.
  const current = () => get().socket === ws;

  ws.onopen = () => {
    if (!current()) return;
    set({ connected: true });
    ws.send(JSON.stringify({ type: "subscribe", channel: "system" }));
  };

  ws.onmessage = (ev) => {
    if (!current()) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "notification") {
      // Pushed by the server the moment it raises one - a failing disk shows up
      // on an open desktop without waiting for a reload.
      useNotifications.getState().receive(msg.notification);
    } else if (msg.type === "hello") {
      set({ info: msg.info });
    } else if (msg.type === "sample") {
      set((s) => ({
        latest: msg.sample,
        history: [...s.history, msg.sample].slice(-HISTORY),
      }));
    }
  };

  ws.onclose = () => {
    if (!current()) return;
    set({ connected: false, socket: null });
    // Reconnect with backoff while consumers are still mounted.
    if (get().refCount > 0) {
      setTimeout(() => {
        if (get().refCount > 0 && !get().socket) open(set, get);
      }, 1500);
    }
  };

  ws.onerror = () => ws.close();
}
