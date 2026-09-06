#!/bin/sh
# Remove an OpenNAS install. Keeps /var/lib/opennas (your data) unless --purge.
set -eu

PREFIX=/usr/lib/opennas
DATA=/var/lib/opennas
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" = "0" ] || { echo "error: run as root (sudo)." >&2; exit 1; }

if command -v rc-service >/dev/null 2>&1; then
	rc-service opennas stop 2>/dev/null || true
	rc-update del opennas 2>/dev/null || true
fi

rm -rf "$PREFIX"
rm -f /etc/init.d/opennas /etc/nginx/http.d/opennas.conf

if [ "$PURGE" = "1" ]; then
	echo "==> Purging data and config"
	rm -rf "$DATA"
	rm -f /etc/conf.d/opennas
	if id opennas >/dev/null 2>&1; then deluser opennas 2>/dev/null || userdel opennas 2>/dev/null || true; fi
else
	echo "==> Kept $DATA and /etc/conf.d/opennas (use --purge to remove)."
fi

echo "Done."
