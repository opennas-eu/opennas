# Alpine build environment for the OpenNAS ISO.
#
# Contains Alpine's own `mkimage` tooling (from aports/scripts) plus node/npm to
# build the native better-sqlite3 for the image's arch. Built per-arch via
# `--platform` (arm64 runs under qemu binfmt), so it works identically on a
# local machine and on GitHub Actions.
ARG ALPINE_VER=3.21
FROM alpine:${ALPINE_VER}

# mkimage + ISO tooling, plus the toolchain to compile node native deps on musl.
RUN apk add --no-cache \
        alpine-sdk build-base apk-tools alpine-conf busybox fakeroot \
        xorriso squashfs-tools mtools dosfstools \
        grub grub-bios grub-efi syslinux mkinitfs \
        doas git bash nodejs npm python3

# Only the scripts/ subtree of aports is needed (mkimage.sh + helpers).
RUN git clone --depth=1 --filter=blob:none --sparse \
        https://gitlab.alpinelinux.org/alpine/aports.git /aports \
    && git -C /aports sparse-checkout set scripts

# mkimage / abuild must run as a non-root user that owns a signing key.
RUN adduser -D build \
    && addgroup build abuild \
    && echo 'permit nopass build' > /etc/doas.d/build.conf \
    && chown -R build:build /aports
USER build
RUN abuild-keygen -ina
WORKDIR /home/build
