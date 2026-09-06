#!/usr/bin/env bash
# Copies everything the ISO build needs into BUILD/ (the work + output dir).
#
# Produces:
#   BUILD/payload/                  <- baked into the image; the installer copies
#     usr/lib/opennas/{server,web,package.json,VERSION}   (arch-independent JS;
#                                    node_modules are built per-arch in build.sh)
#     etc/conf.d/opennas
#     etc/init.d/opennas
#     etc/nginx/http.d/opennas.conf
#     usr/local/sbin/opennas-install
#   BUILD/mkimage/                  <- Alpine mkimage profile + apkovl + runner
#   BUILD/Dockerfile                <- the Alpine build environment
#   BUILD/out/                      <- where the ISO(s) land
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/BUILD"

echo "==> Cleaning BUILD/ (keeping out/)"
rm -rf "$BUILD/payload" "$BUILD/mkimage" "$BUILD/Dockerfile"
mkdir -p "$BUILD/payload" "$BUILD/out"

echo "==> Building OpenNAS app tree"
"$ROOT/packaging/build-dist.sh" "$BUILD/payload/usr/lib/opennas"

echo "==> Adding service + proxy files"
install -D -m 0644 "$ROOT/packaging/opennas.confd"      "$BUILD/payload/etc/conf.d/opennas"
install -D -m 0755 "$ROOT/packaging/opennas.openrc"     "$BUILD/payload/etc/init.d/opennas"
install -D -m 0755 "$ROOT/packaging/opennas-tls.openrc" "$BUILD/payload/etc/init.d/opennas-tls"
install -D -m 0755 "$ROOT/packaging/opennas-banner.openrc" "$BUILD/payload/etc/init.d/opennas-banner"
install -D -m 0755 "$ROOT/packaging/opennas-firewall.openrc" "$BUILD/payload/etc/init.d/opennas-firewall"
install -D -m 0644 "$ROOT/packaging/nginx-opennas.conf" "$BUILD/payload/etc/nginx/http.d/opennas.conf"
install -D -m 0644 "$ROOT/packaging/opennas-avahi.service" "$BUILD/payload/etc/avahi/services/opennas.service"
install -D -m 0755 "$ROOT/packaging/gen-self-signed-cert.sh" "$BUILD/payload/usr/lib/opennas/gen-self-signed-cert.sh"
install -D -m 0755 "$ROOT/packaging/opennas-storage" "$BUILD/payload/usr/lib/opennas/opennas-storage"
install -D -m 0755 "$ROOT/packaging/opennas-sysctl" "$BUILD/payload/usr/lib/opennas/opennas-sysctl"
install -D -m 0755 "$ROOT/packaging/opennas-logs" "$BUILD/payload/usr/lib/opennas/opennas-logs"
install -D -m 0755 "$ROOT/packaging/opennas-firewall" "$BUILD/payload/usr/lib/opennas/opennas-firewall"
install -D -m 0755 "$ROOT/packaging/opennas-update" "$BUILD/payload/usr/lib/opennas/opennas-update"
install -D -m 0755 "$ROOT/packaging/opennas-zfs" "$BUILD/payload/usr/lib/opennas/opennas-zfs"
# The public half of the release key. Every installed machine checks update
# bundles against this, so an ISO built without one simply cannot self-update -
# which is the safe failure, rather than accepting anything.
if [ -f "$ROOT/packaging/update-key.pub" ]; then
	install -D -m 0644 "$ROOT/packaging/update-key.pub" "$BUILD/payload/etc/opennas/update-key.pub"
else
	echo "    (no packaging/update-key.pub - this ISO will not be able to self-update)"
fi
install -D -m 0755 "$ROOT/packaging/opennas-banner" "$BUILD/payload/usr/lib/opennas/opennas-banner"
install -D -m 0755 "$ROOT/packaging/opennas-cli" "$BUILD/payload/usr/sbin/opennas"

echo "==> Adding installer"
install -D -m 0755 "$ROOT/distro/installer/opennas-install" "$BUILD/payload/usr/local/sbin/opennas-install"
# Ship the unattended-install template alongside it, so it can be copied off the ISO.
install -D -m 0644 "$ROOT/distro/installer/opennas-answers.conf.example" "$BUILD/payload/usr/share/opennas/opennas-answers.conf.example"

echo "==> Adding build tooling"
cp -r "$ROOT/distro/mkimage" "$BUILD/mkimage"
cp "$ROOT/distro/Dockerfile" "$BUILD/Dockerfile"

echo "==> Staged into $BUILD"
