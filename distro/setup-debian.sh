#!/usr/bin/env bash
# Provision a Debian 13 (trixie) machine as an OpenNAS build host.
#
# Installs everything needed to compile the app AND build the ISOs:
#   - base toolchain (git, build-essential, python3 - for native better-sqlite3)
#   - Docker Engine + Buildx + Compose (the ISO is built in Alpine containers)
#   - qemu-user-static + binfmt (so the arm64 ISO can build on an x86_64 host)
#   - Node.js 22 (NodeSource) + pnpm
#
# Usage:  sudo distro/setup-debian.sh
# Idempotent: safe to re-run.
set -euo pipefail

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run as root:  sudo $0"

# The non-root user that will actually run builds (added to the docker group).
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || true)}"
[ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ] || warn "Could not detect a non-root user; skipping docker-group add."

# --- sanity: Debian ---------------------------------------------------------
. /etc/os-release 2>/dev/null || die "Cannot read /etc/os-release"
CODENAME="${VERSION_CODENAME:-trixie}"
[ "${ID:-}" = "debian" ] || warn "This script targets Debian (found ID=${ID:-?}). Continuing anyway."
log "Debian codename: $CODENAME"

export DEBIAN_FRONTEND=noninteractive
ARCH="$(dpkg --print-architecture)"

# --- base packages ----------------------------------------------------------
log "Installing base packages"
apt-get update -y
apt-get install -y \
	ca-certificates curl gnupg git xz-utils \
	build-essential python3 make g++ \
	qemu-user-static binfmt-support

# --- Docker Engine ----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
	log "Setting up Docker apt repository"
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc

	# If Docker's repo doesn't carry this codename yet (very fresh Debian),
	# fall back to the previous stable (bookworm) which is ABI-compatible.
	DOCKER_CODENAME="$CODENAME"
	if ! curl -fsSL "https://download.docker.com/linux/debian/dists/${CODENAME}/Release" >/dev/null 2>&1; then
		warn "Docker repo has no '${CODENAME}' yet; falling back to 'bookworm'."
		DOCKER_CODENAME="bookworm"
	fi

	echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${DOCKER_CODENAME} stable" \
		> /etc/apt/sources.list.d/docker.list
	apt-get update -y
	apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
	log "Docker already installed: $(docker --version)"
fi

log "Enabling + starting Docker"
systemctl enable --now docker

# --- multi-arch (qemu binfmt for arm64 ISO builds) --------------------------
log "Registering qemu binfmt handlers for cross-arch container builds"
docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64 >/dev/null 2>&1 \
	|| warn "tonistiigi/binfmt step failed; the apt qemu-user-static handlers should still work."

# --- Node.js 22 + pnpm ------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
	major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
	[ "${major:-0}" -ge 20 ] && need_node=0 && log "Node already present: $(node -v)"
fi
if [ "$need_node" = "1" ]; then
	# Added by hand rather than with NodeSource's `curl ... | bash -`, which is
	# what their docs suggest. All that script does is drop a keyring and an apt
	# source - the same two steps taken for Docker above - and this is the
	# machine that holds the release signing key. Piping a remote script into a
	# root shell means whoever controls that URL, today or on any future re-run,
	# controls the box that signs OpenNAS updates.
	log "Setting up the NodeSource apt repository"
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
		| gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
	chmod a+r /etc/apt/keyrings/nodesource.gpg
	echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
		> /etc/apt/sources.list.d/nodesource.list
	apt-get update -y
	apt-get install -y nodejs
	log "Installed Node $(node -v 2>/dev/null || echo '(check failed)')"
fi

log "Installing pnpm"
if command -v corepack >/dev/null 2>&1; then
	corepack enable
	corepack prepare pnpm@latest --activate || npm install -g pnpm
else
	npm install -g pnpm
fi

# --- docker group for the build user ---------------------------------------
if [ -n "${TARGET_USER:-}" ] && [ "$TARGET_USER" != "root" ]; then
	log "Adding '$TARGET_USER' to the docker group"
	usermod -aG docker "$TARGET_USER" || warn "could not add $TARGET_USER to docker group"
fi

# --- summary ----------------------------------------------------------------
echo
log "Done. Versions:"
printf '    docker : %s\n' "$(docker --version 2>/dev/null || echo '?')"
printf '    buildx : %s\n' "$(docker buildx version 2>/dev/null | head -n1 || echo '?')"
printf '    node   : %s\n' "$(node -v 2>/dev/null || echo '?')"
printf '    pnpm   : %s\n' "$(pnpm -v 2>/dev/null || echo '?')"
printf '    qemu   : %s\n' "$(ls /proc/sys/fs/binfmt_misc/ 2>/dev/null | grep -c qemu) handlers"

cat <<EOF

Next steps (as '$TARGET_USER'):

  # log out/in once so docker group membership applies (or: newgrp docker)
  git clone <your-opennas-repo> && cd OpenNAS
  pnpm install
  pnpm build                                  # compile the app
  distro/build.sh                             # x86_64 ISO  -> BUILD/out/
  OPENNAS_ARCHES="x86_64 aarch64" distro/build.sh   # both arches

Tip: with 160 cores, multi-arch builds run great - both ISOs in one go.
EOF
