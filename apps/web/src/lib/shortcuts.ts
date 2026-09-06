import { useEffect } from "react";
import { useWindows, type SnapZone } from "../store/windows.ts";

/**
 * Desktop-wide keyboard shortcuts.
 *
 * Chords are picked to avoid ones the browser or host OS already owns: no
 * Alt+Tab (the OS takes it), no bare Super (ditto), no Ctrl+W or Ctrl+T. What's
 * left that's reliably ours is Ctrl/⌘+K and Ctrl+Alt+<key>, so window
 * management lives there.
 *
 * Keystrokes are ignored while the user is typing in a field, unless the chord
 * includes a modifier that couldn't be part of ordinary text entry.
 */

const SNAP_KEYS: Record<string, SnapZone> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "maximize",
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const store = useWindows.getState();
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl/⌘+K - search. Allowed even mid-typing: it's unambiguous, and a
      // search box you can't reach from another field would be irritating.
      if (mod && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        store.setSearch(!store.searchOpen);
        return;
      }

      if (isTyping(e.target)) return;

      // Escape closes whatever overlay is open, innermost first.
      if (e.key === "Escape") {
        if (store.searchOpen) { store.setSearch(false); return; }
        if (store.launcherOpen) { store.setLauncher(false); return; }
        return;
      }

      if (!e.ctrlKey || !e.altKey) return;

      // Ctrl+Alt+Space - app launcher.
      if (e.code === "Space") {
        e.preventDefault();
        store.setLauncher(!store.launcherOpen);
        return;
      }

      // Ctrl+Alt+←/→/↑ snap the focused window; ↓ minimizes it.
      const focused = store.focusedId;
      if (!focused) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        store.minimize(focused);
        return;
      }
      const zone = SNAP_KEYS[e.key];
      if (zone) {
        e.preventDefault();
        store.snap(focused, zone);
        return;
      }
      // Ctrl+Alt+Tab cycles windows (Alt+Tab belongs to the OS).
      if (e.key === "Tab") {
        e.preventDefault();
        store.cycle(e.shiftKey ? -1 : 1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
