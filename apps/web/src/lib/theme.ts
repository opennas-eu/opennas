import type { ThemeMode } from "@opennas/shared";

/**
 * Applies the chosen theme by toggling the `dark` class on <html>. "system"
 * follows the OS preference and stays in sync via a media-query listener.
 */
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let current: ThemeMode = "system";

function resolve(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return media?.matches ?? false;
}

function paint() {
  document.documentElement.classList.toggle("dark", resolve(current));
}

function onSystemChange() {
  if (current === "system") paint();
}

export function applyTheme(mode: ThemeMode): void {
  current = mode;
  paint();
  media?.removeEventListener("change", onSystemChange);
  if (mode === "system") media?.addEventListener("change", onSystemChange);
}
