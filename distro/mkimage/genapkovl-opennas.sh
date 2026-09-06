#!/bin/sh -e
# Generates the OpenNAS apkovl (the overlay the live ISO applies at boot).
# It bakes the OpenNAS payload (app + node_modules + service files + installer)
# into the live system and auto-launches the installer on the main console.
#
# mkimage calls this as: genapkovl-opennas.sh <hostname>
# It must emit <hostname>.apkovl.tar.gz in the current directory.
#
# OPENNAS_PAYLOAD points at the prepared payload tree (set by run-mkimage.sh).
HOSTNAME="${1:-opennas}"
PAYLOAD="${OPENNAS_PAYLOAD:-/payload}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/etc"
echo "$HOSTNAME" > "$tmp/etc/hostname"

# Bake the OpenNAS payload into the live filesystem (etc/ + usr/).
cp -a "$PAYLOAD/." "$tmp/"

# Auto-launch the OpenNAS installer on the main console via inittab - more
# reliable than a login hook (it runs even without an interactive login, so you
# never land in the plain Alpine live shell / setup-alpine).
mkdir -p "$tmp/usr/local/sbin"
cat > "$tmp/usr/local/sbin/opennas-tui" <<'EOF'
#!/bin/sh
# Live-ISO entrypoint. The Alpine live root is minimal - the profile's packages
# only live in the ISO's apk *repo*, not the running system - so first pull the
# installer's tools from that repo into RAM (offline), then run the installer.
CDREPO=""
for d in /media/*/apks; do [ -d "$d" ] && CDREPO="$d" && break; done

echo "Preparing the OpenNAS installer..."
if [ -n "$CDREPO" ]; then
	# Everything needed is on the ISO. --no-network makes that a guarantee rather
	# than a hope: without it, a repo miss silently falls through to the network
	# and the boot appears to hang here for minutes on a machine with slow or no
	# internet, with nothing on screen to say why.
	apk add --quiet --no-progress --allow-untrusted --no-network \
		--repository "$CDREPO" \
		alpine-conf kbd-bkeymaps newt parted sfdisk util-linux lsblk blkid \
		e2fsprogs dosfstools btrfs-progs xfsprogs mdadm \
		grub grub-bios grub-efi efibootmgr \
		|| echo "warning: some installer tools could not be installed from the ISO" >&2
else
	echo "warning: no apk repository found on the install media." >&2
	echo "         Falling back to the network - this may take a while, or fail." >&2
	apk add --quiet --no-progress \
		alpine-conf kbd-bkeymaps newt parted sfdisk util-linux lsblk blkid \
		e2fsprogs dosfstools btrfs-progs xfsprogs mdadm \
		grub grub-bios grub-efi efibootmgr \
		|| echo "warning: could not install some installer tools" >&2
fi

/usr/local/sbin/opennas-install
echo
echo "OpenNAS installer exited. Type 'opennas-install' to run it again."
exec /bin/sh -l
EOF
chmod +x "$tmp/usr/local/sbin/opennas-tui"

cat > "$tmp/etc/inittab" <<'EOF'
# OpenNAS live ISO inittab - runs the installer on tty1; tty2/3 + serial are
# plain shells for troubleshooting (Alt-F2).
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default

tty1::respawn:/usr/local/sbin/opennas-tui
tty2::respawn:/sbin/getty 38400 tty2
tty3::respawn:/sbin/getty 38400 tty3
ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100

::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
EOF

# DHCP networking for the live system (and copied to the target by setup-disk).
# Without this, "networking" fails with "could not parse /etc/network/interfaces".
mkdir -p "$tmp/etc/network"
cat > "$tmp/etc/network/interfaces" <<'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
EOF

# Enable the base OpenRC services the live system needs (NOT opennas/nginx -
# the installer enables those on the *target* disk). This mirrors Alpine's own
# live overlay; the critical one is `modloop`, which mounts /lib/modules - without
# it `modprobe` fails and NO hardware drivers (incl. the NIC) load.
rl_add() { # <runlevel> <svc...>
	level="$1"; shift
	mkdir -p "$tmp/etc/runlevels/$level"
	for svc in "$@"; do
		ln -sf "/etc/init.d/$svc" "$tmp/etc/runlevels/$level/$svc"
	done
}
rl_add sysinit devfs dmesg mdev hwdrivers modloop
rl_add boot modules sysctl hostname bootmisc syslog networking
rl_add shutdown killprocs savecache mount-ro

tar -c -C "$tmp" etc usr | gzip -9n > "$HOSTNAME.apkovl.tar.gz"
