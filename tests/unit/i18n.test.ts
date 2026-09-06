import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../apps/web/src/i18n/locales/en.ts";
import { de } from "../../apps/web/src/i18n/locales/de.ts";

/**
 * The translation catalogues.
 *
 * TypeScript already stops a German key that English doesn't have. What it
 * can't see is the inside of the strings: a translator dropping a `{count}`
 * placeholder, adding one that nothing supplies, or writing two plural forms
 * where the language needs three. Each of those renders as visible nonsense to
 * the only people who would notice - the ones reading that language.
 */

const catalogues: [string, Record<string, string>][] = [
  ["de", de as Record<string, string>],
];
const source = en as Record<string, string>;

const placeholders = (s: string) => new Set(Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]!));
const formCount = (s: string) => s.split("|").length;

test("English keys are non-empty and unique by construction", () => {
  const keys = Object.keys(source);
  assert.ok(keys.length > 20, `only ${keys.length} strings - is the catalogue loading?`);
  for (const [k, v] of Object.entries(source)) {
    assert.equal(typeof v, "string", `${k} is not a string`);
    assert.notEqual(v.trim(), "", `${k} is empty`);
  }
});

for (const [id, cat] of catalogues) {
  test(`${id}: every key exists in English`, () => {
    for (const key of Object.keys(cat)) {
      assert.ok(key in source, `${id} has "${key}", which English does not`);
    }
  });

  test(`${id}: no empty or untranslated-looking values`, () => {
    for (const [key, value] of Object.entries(cat)) {
      assert.equal(typeof value, "string", `${id}.${key} is not a string`);
      assert.notEqual(value.trim(), "", `${id}.${key} is empty - omit the key instead, so it falls back to English`);
    }
  });

  test(`${id}: placeholders match English exactly`, () => {
    // A dropped {count} shows the sentence with a hole in it; an invented one
    // renders literally as "{anzahl}".
    for (const [key, value] of Object.entries(cat)) {
      const want = placeholders(source[key]!);
      const got = placeholders(value);
      assert.deepEqual(
        [...got].sort(),
        [...want].sort(),
        `${id}.${key} placeholders differ from English`,
      );
    }
  });

  test(`${id}: plural strings have the right number of forms`, () => {
    // Forms are written in the order Intl.PluralRules names them, so the count
    // has to match what the language actually distinguishes.
    const expected = new Intl.PluralRules(id).resolvedOptions().pluralCategories.length;
    for (const [key, value] of Object.entries(cat)) {
      const enForms = formCount(source[key]!);
      const forms = formCount(value);
      if (enForms === 1 && forms === 1) continue;
      assert.ok(
        enForms > 1,
        `${id}.${key} uses plural forms but the English string does not`,
      );
      assert.equal(
        forms,
        expected,
        `${id}.${key} has ${forms} plural forms; ${id} distinguishes ${expected}`,
      );
    }
  });

  test(`${id}: translations are not simply copies of the English`, () => {
    // A handful of identical strings is normal ("NAS", "OpenNAS", "SMB").
    // A catalogue that is *mostly* identical is a placeholder someone forgot.
    const keys = Object.keys(cat);
    const same = keys.filter((k) => cat[k] === source[k]);
    assert.ok(
      same.length < keys.length * 0.5,
      `${same.length} of ${keys.length} ${id} strings are byte-identical to English`,
    );
  });
}

test("plural forms are ordered the way Intl names them", () => {
  // English distinguishes one|other, so a two-form string is unambiguous. This
  // pins the assumption the selector rests on, which is otherwise invisible.
  assert.deepEqual(new Intl.PluralRules("en").resolvedOptions().pluralCategories.sort(), ["one", "other"]);
  assert.equal(new Intl.PluralRules("en").select(1), "one");
  assert.equal(new Intl.PluralRules("en").select(0), "other");
  assert.equal(new Intl.PluralRules("en").select(2), "other");
  // German happens to agree with English here; Polish is the one that doesn't.
  assert.deepEqual(new Intl.PluralRules("de").resolvedOptions().pluralCategories.sort(), ["one", "other"]);
  assert.equal(new Intl.PluralRules("pl").resolvedOptions().pluralCategories.length, 4);
});

test("the catalogues carry a useful amount of German", () => {
  const coverage = Object.keys(de).length / Object.keys(en).length;
  assert.ok(coverage > 0.5, `German covers only ${Math.round(coverage * 100)}% of the English catalogue`);
});

test("translation coverage is tracked and does not go backwards", () => {
  // The point of this test is not to demand 100% - it is to stop the number
  // drifting down unnoticed while new screens are added in English only. When
  // you translate more components, raise the floor.
  const root = fileURLToPath(new URL("../../apps/web/src/components", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx")) files.push(p);
    }
  };
  walk(root);

  const translated = files.filter((f) => readFileSync(f, "utf8").includes("useT("));
  const pct = (translated.length / files.length) * 100;

  // Recorded so the next person knows where they stand rather than guessing.
  assert.ok(files.length > 50, `only found ${files.length} components`);
  // The floor is today's real number, not an aspiration. 8 of 80 is the sign-in,
  // the desktop chrome, the first-run wizard, the dashboard, Control Panel's
  // navigation and Time & Region - deliberately the screens someone meets
  // before they have decided whether they like OpenNAS. The other 72 are
  // English-only and that is a known, tracked gap rather than a surprise.
  assert.ok(
    translated.length >= 8,
    `translation coverage fell to ${translated.length}/${files.length} (${pct.toFixed(0)}%) - ` +
      "a component that used to call useT() stopped",
  );
});

test("the surfaces someone meets first are translated", () => {
  // Coverage as a percentage says nothing about *which* screens. These are the
  // ones a person sees before they have decided whether they like OpenNAS: the
  // sign-in, the desktop chrome, the first-run wizard and the dashboard.
  const root = fileURLToPath(new URL("../../apps/web/src/components", import.meta.url));
  const mustTranslate = [
    "auth/LoginScreen.tsx",
    "desktop/Taskbar.tsx",
    "desktop/Window.tsx",
    "desktop/AppLauncher.tsx",
    "desktop/Onboarding.tsx",
    "apps/Dashboard.tsx",
    "apps/ControlPanel.tsx",
  ];
  for (const rel of mustTranslate) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.ok(src.includes("useT("), `${rel} is not translated`);
  }
});
