#!/bin/sh -e
# Runs inside the Alpine build-env container. Builds the per-arch node_modules,
# then invokes Alpine's mkimage.sh with the OpenNAS profile to produce the ISO.
ARCH="${ARCH:-x86_64}"
ALPINE_VER="${ALPINE_VER:-3.21}"
OUT="${OUT:-/out}"
WORK="$HOME/work"

echo "==> [$ARCH] preparing payload (building native deps)"
rm -rf "$WORK"
mkdir -p "$WORK/payload"
cp -a /payload/. "$WORK/payload/"
# better-sqlite3 compiles here, against this container's arch + musl.
( cd "$WORK/payload/usr/lib/opennas" && npm install --omit=dev --no-audit --no-fund )

echo "==> installing OpenNAS profile into aports/scripts"
cp /mkimage/mkimg.opennas.sh /aports/scripts/
cp /mkimage/genapkovl-opennas.sh /aports/scripts/
chmod +x /aports/scripts/genapkovl-opennas.sh

# Brand the live bootloader menu. mkimg.base.sh titles every boot entry
# "Linux <flavor>", so the firmware prints `Booting 'Linux lts'`. Rename only the
# human-visible title (GRUB menuentry + syslinux MENU LABEL) to "OpenNAS
# installer". The syslinux LABEL/DEFAULT keys stay "$_f" (= the flavor), so boot
# selection is untouched - only what's shown on screen changes.
echo "==> branding bootloader menu (-> 'OpenNAS installer')"
sed -i \
	-e 's/menuentry "Linux \$_f"/menuentry "OpenNAS installer"/' \
	-e 's/MENU LABEL Linux \$_f/MENU LABEL OpenNAS installer/' \
	/aports/scripts/mkimg.base.sh

export OPENNAS_PAYLOAD="$WORK/payload"
MIRROR="${ALPINE_MIRROR:-http://dl-cdn.alpinelinux.org/alpine}"

echo "==> running mkimage"
cd /aports/scripts
sh mkimage.sh \
	--tag "opennas" \
	--outdir "$OUT" \
	--arch "$ARCH" \
	--repository "$MIRROR/v$ALPINE_VER/main" \
	--repository "$MIRROR/v$ALPINE_VER/community" \
	--profile opennas

# Friendly, arch-tagged filename.
for iso in "$OUT"/*opennas*.iso; do
	[ -e "$iso" ] || continue
	mv -f "$iso" "$OUT/opennas-$ALPINE_VER-$ARCH.iso" 2>/dev/null || true
done
