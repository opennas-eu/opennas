import { create } from "zustand";
import { isPhoneViewport } from "../lib/viewport.ts";
import type { AppManifest } from "@opennas/shared";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInstance {
  id: string;
  app: AppManifest;
  title: string;
  rect: WindowRect;
  /** Saved geometry to restore from a maximized state. */
  restoreRect: WindowRect | null;
  minimized: boolean;
  maximized: boolean;
  /** True while playing the close animation, just before removal. */
  closing: boolean;
  /** True briefly so geometry changes (maximize/restore) animate smoothly. */
  animating: boolean;
  zIndex: number;
  /** Count an app asked to show on its taskbar button; null hides it. */
  badge: number | null;
}

/** Where a window can be snapped: screen halves, quarters, or full. */
export type SnapZone = "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "maximize";

interface WindowStore {
  windows: WindowInstance[];
  focusedId: string | null;
  launcherOpen: boolean;
  searchOpen: boolean;
  nextZ: number;

  openApp: (app: AppManifest) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  toggleMinimize: (id: string) => void;
  toggleMaximize: (id: string) => void;
  setRect: (id: string, rect: Partial<WindowRect>) => void;
  setTitle: (id: string, title: string) => void;
  setBadge: (id: string, badge: number | null) => void;
  setLauncher: (open: boolean) => void;
  setSearch: (open: boolean) => void;
  /** Snap a window to a screen region, remembering where it came from. */
  snap: (id: string, zone: SnapZone) => void;
  /** Focus the next (or previous) non-minimized window, for keyboard cycling. */
  cycle: (direction: 1 | -1) => void;
  /**
   * Put every window back somewhere it can be reached.
   *
   * `leavingPhone` says the viewport just grew past the phone breakpoint, in
   * which case the windows are all full-screen sheets with no arrangement worth
   * preserving and each is re-placed at its app's normal size. Otherwise this is
   * an ordinary resize and the user's layout is kept - only clamped.
   */
  reflow: (leavingPhone: boolean) => void;
}

/** Geometry for a snap zone, in the area above the taskbar. */
export function snapRect(zone: SnapZone): WindowRect {
  if (isPhoneViewport()) return phoneRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight - TASKBAR_H;
  const halfW = Math.round(vw / 2);
  const halfH = Math.round(vh / 2);
  switch (zone) {
    case "left": return { x: 0, y: TASKBAR_H, width: halfW, height: vh };
    case "right": return { x: vw - halfW, y: TASKBAR_H, width: halfW, height: vh };
    case "top-left": return { x: 0, y: TASKBAR_H, width: halfW, height: halfH };
    case "top-right": return { x: vw - halfW, y: TASKBAR_H, width: halfW, height: halfH };
    case "bottom-left": return { x: 0, y: TASKBAR_H + vh - halfH, width: halfW, height: halfH };
    case "bottom-right": return { x: vw - halfW, y: TASKBAR_H + vh - halfH, width: halfW, height: halfH };
    case "maximize": return { x: 0, y: TASKBAR_H, width: vw, height: vh };
  }
}

const TASKBAR_H = 48;

/** Cascade new windows a little so they don't stack perfectly. */
function placeWindow(app: AppManifest, index: number): WindowRect {
  // On a phone every app fills the screen. Cascading a 460px window onto a
  // 390px viewport produces something clipped on two sides that then cannot be
  // dragged back, so the concept of placement simply doesn't apply there.
  if (isPhoneViewport()) return phoneRect();

  const vw = window.innerWidth;
  const vh = window.innerHeight - TASKBAR_H;
  const width = Math.min(app.window.defaultWidth, vw - 40);
  const height = Math.min(app.window.defaultHeight, vh - 40);
  const offset = (index % 6) * 28;
  const x = Math.max(16, Math.round((vw - width) / 2) - 80 + offset);
  const y = Math.max(TASKBAR_H + 16, Math.round((vh - height) / 2) + offset);
  return { x, y, width, height };
}

/**
 * A full-screen sheet, above the bottom bar.
 *
 * The bar is at the bottom on a phone - that is where thumbs are - so the
 * window occupies everything above it rather than everything below a title bar.
 */
export function phoneRect(): WindowRect {
  return {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight - TASKBAR_H,
  };
}

export const useWindows = create<WindowStore>((set, get) => ({
  windows: [],
  focusedId: null,
  launcherOpen: false,
  searchOpen: false,
  nextZ: 1,

  openApp(app) {
    const existing = get().windows.find((w) => w.app.id === app.id);
    if (existing) {
      // Single-instance apps: focus + un-minimize instead of duplicating.
      set((s) => ({
        focusedId: existing.id,
        launcherOpen: false,
        nextZ: s.nextZ + 1,
        windows: s.windows.map((w) =>
          w.id === existing.id ? { ...w, minimized: false, zIndex: s.nextZ + 1 } : w,
        ),
      }));
      return;
    }
    set((s) => {
      const id = `${app.id}-${Date.now().toString(36)}`;
      const z = s.nextZ + 1;
      const win: WindowInstance = {
        id,
        app,
        title: app.name,
        rect: placeWindow(app, s.windows.length),
        restoreRect: null,
        minimized: false,
        maximized: false,
        closing: false,
        animating: false,
        badge: null,
        zIndex: z,
      };
      return {
        windows: [...s.windows, win],
        focusedId: id,
        launcherOpen: false,
        nextZ: z,
      };
    });
  },

  close(id) {
    // Play the exit animation first, then drop the window from the list.
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, closing: true } : w)),
      focusedId:
        s.focusedId === id
          ? topMost(s.windows.filter((w) => w.id !== id && !w.minimized))
          : s.focusedId,
    }));
    setTimeout(() => {
      set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
    }, 140);
  },

  focus(id) {
    set((s) => {
      if (s.focusedId === id && !s.windows.find((w) => w.id === id)?.minimized) {
        return {};
      }
      const z = s.nextZ + 1;
      return {
        focusedId: id,
        nextZ: z,
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, minimized: false, zIndex: z } : w,
        ),
      };
    });
  },

  minimize(id) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
      focusedId: s.focusedId === id ? topMost(s.windows.filter((w) => w.id !== id && !w.minimized)) : s.focusedId,
    }));
  },

  toggleMinimize(id) {
    const w = get().windows.find((x) => x.id === id);
    if (!w) return;
    if (w.minimized || get().focusedId !== id) get().focus(id);
    else get().minimize(id);
  },

  toggleMaximize(id) {
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id) return w;
        if (!w.app.window.resizable) return w;
        if (w.maximized && w.restoreRect) {
          return { ...w, maximized: false, animating: true, rect: w.restoreRect, restoreRect: null };
        }
        return {
          ...w,
          maximized: true,
          animating: true,
          restoreRect: w.rect,
          rect: {
            x: 0,
            y: TASKBAR_H,
            width: window.innerWidth,
            height: window.innerHeight - TASKBAR_H,
          },
        };
      }),
    }));
    // Clear the transition flag so dragging/resizing stays snappy afterwards.
    setTimeout(() => {
      set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, animating: false } : w)) }));
    }, 220);
  },

  setRect(id, rect) {
    // Dragging or resizing takes the window out of any snapped/maximized state,
    // and drops the saved geometry - the user has just chosen a new one.
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id ? { ...w, rect: { ...w.rect, ...rect }, maximized: false, restoreRect: null } : w,
      ),
    }));
  },

  setBadge(id, badge) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, badge } : w)),
    }));
  },
  setTitle(id, title) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)),
    }));
  },

  setLauncher(open) {
    set({ launcherOpen: open, searchOpen: open ? false : get().searchOpen });
  },

  setSearch(open) {
    set({ searchOpen: open, launcherOpen: open ? false : get().launcherOpen });
  },

  snap(id, zone) {
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id || !w.app.window.resizable) return w;
        return {
          ...w,
          maximized: zone === "maximize",
          animating: true,
          // Keep the pre-snap geometry so un-maximizing returns somewhere sane,
          // but don't overwrite it when snapping from an already-snapped state.
          restoreRect: w.restoreRect ?? w.rect,
          rect: snapRect(zone),
        };
      }),
    }));
    setTimeout(() => {
      set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, animating: false } : w)) }));
    }, 220);
  },

  reflow(leavingPhone) {
    // On a phone the rect is ignored entirely - the window renders full-screen -
    // so there is nothing to correct until the viewport grows again.
    if (isPhoneViewport()) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    set((s) => ({
      windows: s.windows.map((w, index) => {
        if (leavingPhone) return { ...w, rect: placeWindow(w.app, index), maximized: false };
        if (w.maximized) return { ...w, rect: snapRect("maximize") };

        const width = Math.min(w.rect.width, vw);
        const height = Math.min(w.rect.height, vh - TASKBAR_H);
        return {
          ...w,
          rect: {
            width,
            height,
            // Leave at least a corner grabbable rather than allowing a window to
            // sit entirely off the right-hand edge.
            x: Math.max(0, Math.min(w.rect.x, vw - 80)),
            // The important one: never above the taskbar. A window at y=0 has its
            // title bar - and therefore its close button - underneath it, which is
            // exactly what a phone sheet leaves behind when the viewport grows.
            y: Math.max(TASKBAR_H, Math.min(w.rect.y, vh - 40)),
          },
        };
      }),
    }));
  },

  cycle(direction) {
    const visible = get()
      .windows.filter((w) => !w.minimized && !w.closing)
      .sort((a, b) => a.zIndex - b.zIndex);
    if (visible.length === 0) return;
    const current = visible.findIndex((w) => w.id === get().focusedId);
    const next = visible[(current + direction + visible.length) % visible.length];
    if (next) get().focus(next.id);
  },
}));

function topMost(windows: WindowInstance[]): string | null {
  const visible = windows.filter((w) => !w.minimized);
  if (visible.length === 0) return null;
  return visible.reduce((a, b) => (a.zIndex >= b.zIndex ? a : b)).id;
}

export const TASKBAR_HEIGHT = TASKBAR_H;
