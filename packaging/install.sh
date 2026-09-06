#!/bin/sh
# Install OpenNAS onto a running system (Alpine / OpenRC primary target).
#
#   1. build the staging tree:   packaging/build-dist.sh
#   2. install it (as root):     sudo packaging/install.sh [staging-dir]
#
# Idempotent: re-running upgrades the code in place and preserves /var/lib/opennas
# and the existing /etc/conf.d/opennas config.
set -eu

PREFIX=/usr/lib/opennas
DATA=/var/lib/opennas
SVC_USER=opennas
SVC_GROUP=opennas

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/out/opennas}"

[ "$(id -u)" = "0" ] || { echo "error: run as root (sudo)." >&2; exit 1; }
[ -d "$SRC" ] || { echo "error: staging tree not found at '$SRC'. Run packaging/build-dist.sh first." >&2; exit 1; }

is_alpine=0
[ -f /etc/alpine-release ] && is_alpine=1

echo "==> Installing runtime packages"
if command -v apk >/dev/null 2>&1; then
	apk add --no-cache nodejs npm nginx >/dev/null
else
	echo "    (no apk; ensure nodejs, npm and nginx are installed)" >&2
fi

echo "==> Creating service user '$SVC_USER'"
if ! id "$SVC_USER" >/dev/null 2>&1; then
	if [ "$is_alpine" = "1" ] || command -v addgroup >/dev/null 2>&1; then
		addgroup -S "$SVC_GROUP" 2>/dev/null || true
		adduser -S -D -H -h "$DATA" -s /sbin/nologin -G "$SVC_GROUP" "$SVC_USER" 2>/dev/null || true
	else
		groupadd -r "$SVC_GROUP" 2>/dev/null || true
		useradd -r -g "$SVC_GROUP" -d "$DATA" -s /usr/sbin/nologin "$SVC_USER" 2>/dev/null || true
	fi
fi

echo "==> Laying out files"
mkdir -p "$PREFIX" "$DATA/shared" "$DATA/avatars" "$DATA/generated"
# Replace code dirs, keep node_modules across upgrades unless package.json changed.
rm -rf "$PREFIX/server" "$PREFIX/web"
cp -r "$SRC/." "$PREFIX/"

echo "==> Installing production dependencies (compiles better-sqlite3 for this host)"
build_virtual=""
if command -v apk >/dev/null 2>&1; then
	apk add --no-cache --virtual .opennas-build build-base python3 >/dev/null && build_virtual=".opennas-build"
fi
( cd "$PREFIX" && npm install --omit=dev --no-audit --no-fund )
[ -n "$build_virtual" ] && apk del "$build_virtual" >/dev/null 2>&1 || true

echo "==> Installing service + reverse proxy"
install -D -m 0644 "$HERE/opennas.confd" /etc/conf.d/opennas.new
# Don't clobber an existing, user-edited config.
if [ -f /etc/conf.d/opennas ]; then
	echo "    keeping existing /etc/conf.d/opennas (new template at /etc/conf.d/opennas.new)"
else
	mv /etc/conf.d/opennas.new /etc/conf.d/opennas
fi
install -D -m 0755 "$HERE/opennas.openrc" /etc/init.d/opennas
install -D -m 0644 "$HERE/nginx-opennas.conf" /etc/nginx/http.d/opennas.conf

echo "==> Permissions"
chown -R root:root "$PREFIX"
chown -R "$SVC_USER:$SVC_GROUP" "$DATA"
chmod 0750 "$DATA"

echo "==> Enabling services"
if command -v rc-update >/dev/null 2>&1; then
	rc-update add opennas default 2>/dev/null || true
	rc-update add nginx default 2>/dev/null || true
fi

cat <<EOF

OpenNAS installed.

  code:    $PREFIX
  data:    $DATA   (owned by $SVC_USER)
  config:  /etc/conf.d/opennas
  service: /etc/init.d/opennas   nginx: /etc/nginx/http.d/opennas.conf

Start it:
  rc-service opennas start
  rc-service nginx start

Then open http://<this-host>/ and complete the setup wizard.
EOF
