#!/usr/bin/env bash
# Builds and signs an update bundle, and writes the channel manifest that points
# at it.
#
#   packaging/make-release.sh <release-key.pem> [outdir]
#
# Produces, in outdir (default BUILD/release/):
#   opennas-<version>.tar.gz       the payload an installed NAS unpacks
#   opennas-<version>.tar.gz.sig   ed25519 signature over those exact bytes
#   stable.json                    the manifest to publish on the channel URL
#
# ## The key
#
# Generate one once and keep it off the build machine if you can:
#
#   openssl genpkey -algorithm ed25519 -out release.key
#   openssl pkey -in release.key -pubout -out release.pub
#
# `release.pub` ships inside the ISO as /etc/opennas/update-key.pub and is what
# every installed machine checks against. Losing the private key means no
# machine will accept another update until its public key is replaced by hand,
# so back it up somewhere that is not this repository.
set -euo pipefail

KEY="${1:?usage: make-release.sh <release-key.pem> [outdir]}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${2:-$ROOT/BUILD/release}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -f "$KEY" ] || { echo "no such key: $KEY" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)"
FULL="${VERSION}+${COMMIT}"

echo "==> Building $FULL"
"$ROOT/packaging/build-dist.sh" "$STAGE/opennas"

# The helpers and service files travel with the payload, so an update can fix a
# bug in one of them. They land under service/ and are installed by the updater,
# which knows where each belongs - the payload itself must stay self-contained.
echo "==> Adding helpers and service files"
install -m 0755 "$ROOT/packaging/opennas-storage"  "$STAGE/opennas/opennas-storage"
install -m 0755 "$ROOT/packaging/opennas-sysctl"   "$STAGE/opennas/opennas-sysctl"
install -m 0755 "$ROOT/packaging/opennas-logs"     "$STAGE/opennas/opennas-logs"
install -m 0755 "$ROOT/packaging/opennas-firewall" "$STAGE/opennas/opennas-firewall"
install -m 0755 "$ROOT/packaging/opennas-update"   "$STAGE/opennas/opennas-update"
install -m 0755 "$ROOT/packaging/opennas-zfs"      "$STAGE/opennas/opennas-zfs"
install -m 0755 "$ROOT/packaging/opennas-banner"   "$STAGE/opennas/opennas-banner"
install -m 0755 "$ROOT/packaging/opennas-cli"      "$STAGE/opennas/opennas-cli"
install -m 0755 "$ROOT/packaging/gen-self-signed-cert.sh" "$STAGE/opennas/gen-self-signed-cert.sh"

mkdir -p "$STAGE/opennas/service"
for f in opennas.openrc opennas-tls.openrc opennas-firewall.openrc opennas-banner.openrc; do
	install -m 0755 "$ROOT/packaging/$f" "$STAGE/opennas/service/$f"
done
install -m 0644 "$ROOT/packaging/nginx-opennas.conf"   "$STAGE/opennas/service/nginx-opennas.conf"
install -m 0644 "$ROOT/packaging/opennas-avahi.service" "$STAGE/opennas/service/opennas-avahi.service"

mkdir -p "$OUT"
BUNDLE="$OUT/opennas-${FULL}.tar.gz"

echo "==> Packing $BUNDLE"
# Reproducible-ish: sorted, fixed mtime and ownership, so rebuilding the same
# commit produces the same bytes and the checksum means something.
tar --sort=name --owner=0 --group=0 --numeric-owner \
	--mtime="@$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)" \
	-czf "$BUNDLE" -C "$STAGE/opennas" .

echo "==> Signing"
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$BUNDLE" -out "$BUNDLE.sig"
openssl pkeyutl -verify -pubin -inkey <(openssl pkey -in "$KEY" -pubout) \
	-rawin -in "$BUNDLE" -sigfile "$BUNDLE.sig" >/dev/null

SHA="$(sha256sum "$BUNDLE" | cut -d' ' -f1)"
BASE="${OPENNAS_RELEASE_BASE_URL:-https://opennas.org/updates}"

cat > "$OUT/stable.json" <<JSON
{
  "version": "${FULL}",
  "releasedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "notes": "",
  "bundleUrl": "${BASE}/$(basename "$BUNDLE")",
  "signatureUrl": "${BASE}/$(basename "$BUNDLE").sig",
  "sha256": "${SHA}"
}
JSON

echo
echo "Built  $BUNDLE"
echo "Signed $BUNDLE.sig"
echo "Manifest $OUT/stable.json  (publish it at the channel URL)"
echo
echo "Fill in \"notes\" before publishing - it is what people read before updating."
