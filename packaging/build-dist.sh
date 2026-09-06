#!/usr/bin/env bash
# Builds OpenNAS and assembles a self-contained "staging tree" ready to be laid
# down at /usr/lib/opennas by install.sh (or packaged into the Alpine ISO later).
#
# Output tree:
#   out/opennas/
#     server/        the esbuild backend bundle (index.js + sourcemap)
#     web/           the built static SPA
#     package.json   minimal runtime manifest (api deps, no devDeps/workspace)
#     VERSION
#
# node_modules is NOT produced here: better-sqlite3 is native and must be built
# for the *target* (Alpine/musl, amd64 or arm64), so install.sh runs
# `npm install --omit=dev` on the target instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/packaging/out/opennas}"
cd "$ROOT"

# pnpm, however this machine provides it.
#
# A global `pnpm` is the common case, but plenty of setups get it from corepack
# or npx instead — and a build script that hard-requires one on PATH fails at the
# very first step with "pnpm: command not found", which is a poor way to find out.
# The version is pinned for the fallback so an ISO build can't quietly pick up a
# different major.
if command -v pnpm >/dev/null 2>&1; then
	PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
	PNPM="corepack pnpm"
elif command -v npx >/dev/null 2>&1; then
	PNPM="npx --yes pnpm@9"
else
	echo "error: need pnpm (or corepack, or npx) to build" >&2
	exit 1
fi

echo "==> Building artifacts ($PNPM build)"
$PNPM build

echo "==> Staging into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/server" "$OUT/web"
cp -r apps/api/dist/. "$OUT/server/"
cp -r apps/web/dist/. "$OUT/web/"

# GPLv3 §6 asks that the licence travel with the binaries. The bundle is
# minified and stripped of workspace structure, so a copy of the terms and a
# pointer to the source is the only thing on the appliance that tells its owner
# what they are allowed to do with it.
cp "$ROOT/LICENSE" "$OUT/LICENSE"
cat > "$OUT/README" <<'EOR'
OpenNAS - https://github.com/opennas/opennas

This directory holds a compiled build. OpenNAS is free software under the GNU
General Public License version 3 or later; the full terms are in LICENSE beside
this file. The corresponding source for this exact build is the commit named in
VERSION after the "+", from the repository above.
EOR

echo "==> Generating runtime package.json"
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("apps/api/package.json", "utf8"));
  const deps = { ...(pkg.dependencies || {}) };
  delete deps["@opennas/shared"]; // bundled into server/index.js by esbuild
  const out = {
    name: "opennas",
    version: pkg.version,
    private: true,
    type: "module",
    main: "server/index.js",
    dependencies: deps,
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$OUT/package.json"

# A real version number, not a commit hash: the updater compares these to decide
# whether a release is newer, and "3f9a1c2" does not compare to anything. The
# commit rides along as build metadata after a "+", which semver ignores when
# ordering.
_ver="$(node -p "require('$ROOT/package.json').version")"
_commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)"
printf '%s+%s\n' "$_ver" "$_commit" > "$OUT/VERSION"

echo "==> Staged $(cat "$OUT/VERSION") -> $OUT"
echo "    Next: sudo packaging/install.sh   (on the target machine)"
