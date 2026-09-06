import { create } from "zustand";
import { en } from "./locales/en.ts";

/**
 * Translation for the OpenNAS desktop.
 *
 * Written here rather than pulled in, for the same reason the TOTP and QR code
 * are: the whole of what this needs is lookup, interpolation and plurals, and a
 * general-purpose i18n library brings a loader, a plugin system and a bundle
 * several times the size of the catalogues themselves.
 *
 * Three rules shape it:
 *
 * - **English is the source of truth.** Keys are typed from the English
 *   catalogue, so a typo in a key is a compile error and a translation that has
 *   drifted from it is a compile error too.
 * - **A missing translation falls back to English, never to a key.** A screen
 *   showing `settings.storage.title` to a user is worse than one showing
 *   English, so an incomplete catalogue degrades instead of breaking.
 * - **Plurals go through `Intl.PluralRules`**, because "1 file / 2 files" is
 *   English's rule and not everyone's - Polish alone has three forms.
 */

/**
 * Keys come from English; values are plain strings.
 *
 * `en` is declared `as const` so its keys are literals, but taking `typeof en`
 * wholesale would make each *value* a literal too - and then a German
 * translation would have to equal the English text to typecheck. Mapping the
 * keys onto `string` keeps the half that's useful.
 */
export type Catalogue = Record<keyof typeof en, string>;
export type MessageKey = keyof Catalogue;

/** A locale OpenNAS ships strings for. */
export interface LocaleMeta {
  id: string;
  /** The language's name in that language - nobody looks for "German". */
  nativeName: string;
  englishName: string;
}

export const LOCALES: LocaleMeta[] = [
  { id: "en", nativeName: "English", englishName: "English" },
  { id: "de", nativeName: "Deutsch", englishName: "German" },
];

/**
 * Catalogues load on demand so a browser set to English never downloads the
 * others. English is bundled because it is also the fallback, and a fallback
 * that has to be fetched isn't one.
 */
const loaders: Record<string, () => Promise<Partial<Catalogue>>> = {
  de: () => import("./locales/de.ts").then((m) => m.de),
};

const catalogues: Record<string, Partial<Catalogue>> = { en };

export type Params = Record<string, string | number>;

/**
 * Fill `{name}` placeholders.
 *
 * Values are substituted as text and never parsed further, so a value that
 * itself contains `{something}` is left alone rather than being treated as
 * another placeholder to fill.
 */
function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * Pick a plural form.
 *
 * A message with plurals is written as `one|other` - or with as many forms as
 * the language needs, in the order `Intl.PluralRules` names them. English uses
 * two; a catalogue for a language that needs more supplies more, and no code
 * here has to know which languages those are.
 */
const PLURAL_ORDER: Intl.LDMLPluralRule[] = ["zero", "one", "two", "few", "many", "other"];

function selectPlural(template: string, locale: string, count: number): string {
  const forms = template.split("|");
  if (forms.length === 1) return template;
  const category = new Intl.PluralRules(locale).select(count);
  // The forms are written in the canonical order of the categories this
  // language distinguishes, so the position of the selected category is the
  // form to use. When the catalogue supplied fewer forms than the language needs
  // - an English fallback standing in for Polish, say - the last one is used
  // rather than nothing.
  const supported = PLURAL_ORDER.filter((c) => localeHasCategory(locale, c));
  const index = supported.indexOf(category);
  return forms[index >= 0 && index < forms.length ? index : forms.length - 1] ?? template;
}

/** Which plural categories a locale actually distinguishes, cached per locale. */
const categoryCache = new Map<string, Set<Intl.LDMLPluralRule>>();
function localeHasCategory(locale: string, category: Intl.LDMLPluralRule): boolean {
  let set = categoryCache.get(locale);
  if (!set) {
    const rules = new Intl.PluralRules(locale);
    // `resolvedOptions().pluralCategories` is the authoritative list for the
    // language; deriving it by sampling numbers would miss the rare ones.
    set = new Set(rules.resolvedOptions().pluralCategories as Intl.LDMLPluralRule[]);
    categoryCache.set(locale, set);
  }
  return set.has(category);
}

interface I18nStore {
  locale: string;
  /** True once a non-English catalogue has finished loading. */
  ready: boolean;
  setLocale: (locale: string) => Promise<void>;
}

/** The browser's preference, if OpenNAS speaks it. */
export function detectLocale(): string {
  if (typeof navigator === "undefined") return "en";
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = (tag ?? "").split("-")[0]?.toLowerCase();
    if (base && LOCALES.some((l) => l.id === base)) return base;
  }
  return "en";
}

const STORAGE_KEY = "opennas.locale";

function storedLocale(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && LOCALES.some((l) => l.id === v) ? v : null;
  } catch {
    // A browser with site data blocked still has to render.
    return null;
  }
}

export const useI18n = create<I18nStore>((set) => ({
  locale: storedLocale() ?? detectLocale(),
  ready: true,
  async setLocale(locale) {
    if (!LOCALES.some((l) => l.id === locale)) return;
    if (!catalogues[locale] && loaders[locale]) {
      set({ ready: false });
      try {
        catalogues[locale] = await loaders[locale]!();
      } catch {
        // A catalogue that won't load leaves English in place rather than a
        // half-translated screen.
        set({ ready: true });
        return;
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* preference just won't persist */
    }
    document.documentElement.lang = locale;
    set({ locale, ready: true });
  },
}));

/** Translate a key in a given locale. Exported for use outside React. */
export function translate(locale: string, key: MessageKey, params?: Params): string {
  const template = (catalogues[locale]?.[key] as string | undefined) ?? en[key];
  if (template === undefined) {
    // Only reachable if a key is constructed at runtime rather than typed.
    return String(key);
  }
  const count = params?.count;
  const chosen = typeof count === "number" ? selectPlural(template, locale, count) : template;
  return interpolate(chosen, params);
}

/**
 * The translation function for components.
 *
 * Subscribes to the locale, so changing language re-renders everything using it
 * without a reload.
 */
export function useT(): (key: MessageKey, params?: Params) => string {
  const locale = useI18n((s) => s.locale);
  return (key, params) => translate(locale, key, params);
}

/** The active locale, for `Intl` formatting of dates, numbers and lists. */
export function useLocale(): string {
  return useI18n((s) => s.locale);
}

/** Load the stored/detected catalogue at startup. */
export function initI18n(): void {
  const locale = useI18n.getState().locale;
  document.documentElement.lang = locale;
  if (locale !== "en") void useI18n.getState().setLocale(locale);
}
