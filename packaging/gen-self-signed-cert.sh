#!/bin/sh
# Generate a self-signed TLS certificate for OpenNAS if one isn't present.
# Run on first boot (by the opennas-tls service) and on demand from the web UI
# (with FORCE=1 to replace the existing cert). Installed to /usr/lib/opennas/.
set -eu

TLS_DIR="${OPENNAS_TLS_DIR:-/etc/opennas/tls}"
CERT="$TLS_DIR/cert.pem"
KEY="$TLS_DIR/key.pem"
OWNER="${OPENNAS_USER:-opennas}"

mkdir -p "$TLS_DIR"

# Keep an existing cert unless explicitly forced (so the cert is stable across
# reboots, and a user-uploaded cert is never clobbered automatically).
if [ "${FORCE:-0}" != "1" ] && [ -s "$CERT" ] && [ -s "$KEY" ]; then
	exit 0
fi

host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo opennas)"

openssl req -x509 -newkey rsa:2048 -nodes \
	-keyout "$KEY" -out "$CERT" -days 3650 \
	-subj "/CN=$host" \
	-addext "subjectAltName=DNS:$host,DNS:localhost"

# Owned by the OpenNAS service so it can replace the cert from the web UI;
# nginx's master process reads the key as root before dropping privileges.
chown "$OWNER:$OWNER" "$CERT" "$KEY" 2>/dev/null || true
chmod 0644 "$CERT"
chmod 0640 "$KEY"
