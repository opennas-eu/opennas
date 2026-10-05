#!/bin/sh
# Generate a self-signed TLS certificate for OpenNAS if one isn't present.
# Run on first boot (by the opennas-tls service, as root) and on demand from the
# web UI (as the opennas user, with FORCE=1 to replace the existing cert).
# Installed to /usr/lib/opennas/.
#
# ## Why root never writes into the tls directory
#
# The directory belongs to the opennas service account, because the web UI
# installs uploaded and ACME certificates into it. So when this runs as root,
# every path inside it is one the service account could have swapped for a
# symlink - and `openssl -keyout` would follow it, letting a compromised backend
# overwrite any file on the system at the next boot. As root the pair is made in
# a private directory beside it (in /etc/opennas, which only root can write),
# handed to the service account there, and renamed into place; a rename replaces
# a symlink rather than following it.
set -eu

TLS_DIR="${OPENNAS_TLS_DIR:-/etc/opennas/tls}"
CERT="$TLS_DIR/cert.pem"
KEY="$TLS_DIR/key.pem"
OWNER="${OPENNAS_USER:-opennas}"

if [ ! -d "$TLS_DIR" ]; then
	mkdir -p "$TLS_DIR"
	# Just created by us, so this is our own directory, not a link.
	if [ "$(id -u)" = "0" ]; then
		chown "$OWNER:$OWNER" "$TLS_DIR" 2>/dev/null || true
		chmod 0750 "$TLS_DIR"
	fi
fi

# Keep an existing cert unless explicitly forced (so the cert is stable across
# reboots, and a user-uploaded cert is never clobbered automatically).
if [ "${FORCE:-0}" != "1" ] && [ -s "$CERT" ] && [ -s "$KEY" ]; then
	exit 0
fi

host="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo opennas)"

if [ "$(id -u)" != "0" ]; then
	# Unprivileged (the web UI): the directory is ours, so there is nothing a
	# symlink in it could make us reach that we could not reach anyway.
	openssl req -x509 -newkey rsa:2048 -nodes \
		-keyout "$KEY" -out "$CERT" -days 3650 \
		-subj "/CN=$host" \
		-addext "subjectAltName=DNS:$host,DNS:localhost"
	chmod 0644 "$CERT"
	chmod 0640 "$KEY"
	exit 0
fi

parent="$(dirname "$TLS_DIR")"
# The private directory is only private if nobody else can write its parent.
[ -O "$parent" ] && [ ! -L "$parent" ] || { echo "refusing: $parent is not root-owned" >&2; exit 1; }
case "$(ls -ld "$parent" | cut -c6,9)" in *w*) echo "refusing: $parent is writable by others" >&2; exit 1;; esac
[ -L "$TLS_DIR" ] && { echo "refusing: $TLS_DIR is a symlink" >&2; exit 1; }

work="$(mktemp -d "$parent/.tls-gen.XXXXXX")"
trap 'rm -rf "$work"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes \
	-keyout "$work/key.pem" -out "$work/cert.pem" -days 3650 \
	-subj "/CN=$host" \
	-addext "subjectAltName=DNS:$host,DNS:localhost"

# Owned by the OpenNAS service so it can replace the cert from the web UI;
# nginx's master process reads the key as root before dropping privileges.
# These are regular files we just created in a directory only root can write,
# so the chown cannot be redirected anywhere else.
chown "$OWNER:$OWNER" "$work/cert.pem" "$work/key.pem" 2>/dev/null || true
chmod 0644 "$work/cert.pem"
chmod 0640 "$work/key.pem"

for f in cert.pem key.pem; do
	dst="$TLS_DIR/$f"
	# A directory (or a link to one) would make mv put the file *inside* it.
	[ -d "$dst" ] && { echo "refusing: $dst is a directory" >&2; exit 1; }
	mv -f "$work/$f" "$dst"
done
