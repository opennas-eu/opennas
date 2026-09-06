/**
 * Resolve `./thing.js` to `./thing.ts` when only the TypeScript source exists.
 *
 * The API is written for NodeNext, so every relative import inside it names the
 * *emitted* file - `./db/settings.js` - while the file on disk is
 * `./db/settings.ts`. That is correct TypeScript and unloadable by Node, which
 * is normally solved by building first or by a transpiling loader.
 *
 * Tests do neither. They import the sources directly, so a failure points at a
 * line you can edit rather than at a column in a bundle, and so `node --test`
 * needs nothing installed beyond Node itself - no tsx, no ts-node, no vitest,
 * no build step to forget. Node ≥22.18 handles the types on its own; this hook
 * only fixes the extension, which is the one thing it won't do.
 *
 * The runner passes `--experimental-transform-types` rather than relying on
 * strip-only mode, because one constructor in the API uses a TypeScript
 * parameter property - which has no runtime-erasable form, so stripping alone
 * throws on the file. Transforming costs nothing here and means the whole
 * server can be built inside a test rather than only its leaf modules.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (/^\.{0,2}\//.test(specifier) && specifier.endsWith(".js") && context.parentURL) {
    for (const ext of [".ts", ".mts"]) {
      const candidate = new URL(specifier.slice(0, -3) + ext, context.parentURL);
      if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier.slice(0, -3) + ext, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
