/** Built-in desktop wallpapers. Each is a CSS `background` value applied to the
 *  desktop root, so they're crisp at any resolution and cost nothing to ship.
 *  Names are getters so they read in the current language wherever shown. */

import { tr } from "../i18n/index.ts";

export interface Wallpaper {
  id: string;
  name: string;
  /** Full CSS `background` shorthand. */
  background: string;
}

export const WALLPAPERS: Wallpaper[] = [
  {
    id: "aurora",
    get name() { return tr("ui.wallpaper.aurora"); },
    background:
      "radial-gradient(60rem 60rem at 12% 8%, rgb(56 189 248 / 0.22), transparent 55%), radial-gradient(50rem 50rem at 88% 18%, rgb(139 92 246 / 0.22), transparent 55%), radial-gradient(70rem 50rem at 50% 110%, rgb(16 185 129 / 0.16), transparent 60%), linear-gradient(160deg, #0b1220 0%, #0e1730 45%, #0b1220 100%)",
  },
  {
    id: "midnight",
    get name() { return tr("ui.wallpaper.midnight"); },
    background: "radial-gradient(40rem 40rem at 80% 10%, rgb(59 130 246 / 0.18), transparent 60%), linear-gradient(180deg, #020617 0%, #0f172a 100%)",
  },
  {
    id: "sunset",
    get name() { return tr("ui.wallpaper.sunset"); },
    background: "linear-gradient(160deg, #1e1b4b 0%, #7c2d12 60%, #b45309 100%)",
  },
  {
    id: "forest",
    get name() { return tr("ui.wallpaper.forest"); },
    background: "radial-gradient(50rem 50rem at 20% 20%, rgb(16 185 129 / 0.25), transparent 60%), linear-gradient(160deg, #052e16 0%, #064e3b 50%, #022c22 100%)",
  },
  {
    id: "ocean",
    get name() { return tr("ui.wallpaper.ocean"); },
    background: "radial-gradient(60rem 40rem at 50% 0%, rgb(14 165 233 / 0.3), transparent 60%), linear-gradient(180deg, #082f49 0%, #0c4a6e 60%, #082f49 100%)",
  },
  {
    id: "nebula",
    get name() { return tr("ui.wallpaper.nebula"); },
    background:
      "radial-gradient(40rem 40rem at 25% 30%, rgb(217 70 239 / 0.25), transparent 55%), radial-gradient(45rem 45rem at 75% 70%, rgb(99 102 241 / 0.3), transparent 55%), linear-gradient(160deg, #1e1b4b 0%, #0f0a2e 100%)",
  },
  {
    id: "rose",
    get name() { return tr("ui.wallpaper.rose"); },
    background: "radial-gradient(50rem 40rem at 70% 20%, rgb(244 114 182 / 0.25), transparent 60%), linear-gradient(160deg, #4c0519 0%, #831843 55%, #500724 100%)",
  },
  {
    id: "graphite",
    get name() { return tr("ui.wallpaper.graphite"); },
    background: "linear-gradient(160deg, #18181b 0%, #27272a 50%, #18181b 100%)",
  },
];

export function wallpaperById(id: string): Wallpaper {
  return WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0]!;
}
