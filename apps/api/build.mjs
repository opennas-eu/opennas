// Bundles the OpenNAS backend into a single, runnable ESM file (dist/index.js).
//
// First-party code AND @opennas/shared are inlined; npm dependencies are kept
// external (loaded from node_modules at runtime - native modules like
// better-sqlite3 can't be bundled). The result runs with plain `node`, so the
// deployed backend no longer needs `tsx` or the TypeScript toolchain - the shape
// we want for shipping it as a systemd service in the OpenNAS distro.
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));

// Externalize real npm deps; bundle the workspace's own @opennas/shared.
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== "@opennas/shared");

// TS source uses NodeNext-style ".js" import specifiers that actually point at
// ".ts" files. tsx/Vite handle this transparently; for esbuild we remap them.
const jsToTs = {
  name: "js-to-ts",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(".")) return undefined;
      const candidate = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return existsSync(candidate) ? { path: candidate } : undefined;
    });
  },
};

await build({
  entryPoints: [resolve(here, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(here, "dist/index.js"),
  sourcemap: true,
  external,
  plugins: [jsToTs],
  // Some externalized CommonJS deps expect a `require` to exist under ESM.
  banner: { js: "import { createRequire as ___cr } from 'module'; const require = ___cr(import.meta.url);" },
  logLevel: "info",
});
