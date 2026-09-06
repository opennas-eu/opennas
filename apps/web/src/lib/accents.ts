/** Accent presets. Tailwind v4 exposes theme colors as CSS variables, so
 *  overriding --color-brand-{400..700} at runtime re-themes the whole UI live. */

export interface Accent {
  id: string;
  name: string;
  /** The 600-shade hex, also used as the stored preference value. */
  value: string;
  shades: { 400: string; 500: string; 600: string; 700: string };
}

export const ACCENTS: Accent[] = [
  { id: "blue", name: "Blue", value: "#2563eb", shades: { 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8" } },
  { id: "violet", name: "Violet", value: "#7c3aed", shades: { 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed", 700: "#6d28d9" } },
  { id: "emerald", name: "Emerald", value: "#059669", shades: { 400: "#34d399", 500: "#10b981", 600: "#059669", 700: "#047857" } },
  { id: "rose", name: "Rose", value: "#e11d48", shades: { 400: "#fb7185", 500: "#f43f5e", 600: "#e11d48", 700: "#be123c" } },
  { id: "amber", name: "Amber", value: "#d97706", shades: { 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706", 700: "#b45309" } },
  { id: "cyan", name: "Cyan", value: "#0891b2", shades: { 400: "#22d3ee", 500: "#06b6d4", 600: "#0891b2", 700: "#0e7490" } },
  { id: "pink", name: "Pink", value: "#db2777", shades: { 400: "#f472b6", 500: "#ec4899", 600: "#db2777", 700: "#be185d" } },
  { id: "slate", name: "Graphite", value: "#475569", shades: { 400: "#94a3b8", 500: "#64748b", 600: "#475569", 700: "#334155" } },
];

export function accentByValue(value: string): Accent {
  return ACCENTS.find((a) => a.value.toLowerCase() === value.toLowerCase()) ?? ACCENTS[0]!;
}

/** Apply an accent to the document by overriding the brand CSS variables. */
export function applyAccent(value: string): void {
  const accent = accentByValue(value);
  const root = document.documentElement;
  root.style.setProperty("--color-brand-400", accent.shades[400]);
  root.style.setProperty("--color-brand-500", accent.shades[500]);
  root.style.setProperty("--color-brand-600", accent.shades[600]);
  root.style.setProperty("--color-brand-700", accent.shades[700]);
}
