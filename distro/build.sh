#!/usr/bin/env bash
# Builds the OpenNAS ISO(s). Stages the payload, builds the Alpine build-env
# image, then runs mkimage inside it to produce a bootable installer ISO.
#
#   distro/build.sh                       # x86_64 only (default)
#   OPENNAS_ARCHES="x86_64 aarch64" distro/build.sh
#
# arm64 builds run the Alpine container under qemu (needs binfmt registered:
# `docker run --privileged --rm tonistiigi/binfmt --install arm64`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/BUILD"
ARCHES="${OPENNAS_ARCHES:-x86_64}"
ALPINE_VER="${ALPINE_VER:-3.21}"
DOCKER="${DOCKER:-docker}"

"$ROOT/distro/stage.sh"

# /out is written by the unprivileged `build` user inside the container.
mkdir -p "$BUILD/out"
chmod 0777 "$BUILD/out"

for arch in $ARCHES; do
	case "$arch" in
		x86_64)  platform=linux/amd64 ;;
		aarch64) platform=linux/arm64 ;;
		*) echo "error: unsupported arch '$arch' (use x86_64 or aarch64)" >&2; exit 1 ;;
	esac

	echo "==> [$arch] building build-env image"
	"$DOCKER" build --platform "$platform" \
		--build-arg "ALPINE_VER=$ALPINE_VER" \
		-t "opennas-isobuilder:$arch" \
		-f "$BUILD/Dockerfile" "$BUILD"

	echo "==> [$arch] building ISO (this downloads packages and takes a while)"
	"$DOCKER" run --rm --platform "$platform" \
		-v "$BUILD/payload:/payload:ro" \
		-v "$BUILD/mkimage:/mkimage:ro" \
		-v "$BUILD/out:/out" \
		-e "ARCH=$arch" -e "ALPINE_VER=$ALPINE_VER" \
		"opennas-isobuilder:$arch" \
		/mkimage/run-mkimage.sh
done

echo
echo "==> Done. ISO(s):"
ls -lh "$BUILD/out"/*.iso 2>/dev/null || echo "  (no ISO produced - check the log above)"
