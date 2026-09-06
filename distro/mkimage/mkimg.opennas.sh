# OpenNAS mkimage profile. Defines a live "installer" ISO: boots a minimal
# Alpine that auto-launches the OpenNAS guided installer (opennas-install).
# The OpenNAS payload + service files ride along in the apkovl (see
# genapkovl-opennas.sh) so the installer can copy them onto the target disk.
#
# Sourced by aports/scripts/mkimage.sh as: mkimg.opennas.sh -> profile_opennas()

profile_opennas() {
	profile_base
	title="OpenNAS"
	desc="OpenNAS installer (Alpine-based)"
	profile_abbrev="opennas"
	image_ext="iso"
	# Must be set explicitly, not left to be derived from image_ext.
	# mkimage.sh only defaults output_format *after* the section loop has run,
	# and section_syslinux() tests it - so leaving it unset means the syslinux
	# section silently returns early, no isolinux.bin is produced, and
	# create_image_iso() then builds a UEFI-only ISO that no BIOS machine can
	# boot. (section_grub_efi keys off $grub_mod instead, which is why UEFI
	# worked and this went unnoticed.)
	output_format="iso"
	arch="x86_64 aarch64"
	kernel_cmdline="unionfs_size=768M console=tty0 console=ttyS0,115200"
	syslinux_serial="0 115200"
	kernel_flavors="lts"
	# IMPORTANT: append to (don't replace) profile_base's defaults, and make sure
	# the initramfs can reach the boot media + modloop. Missing 'cdrom' is what
	# triple-faults the kernel right after "Booting Linux LTS" (VMware shows the
	# CPU reset). 'ata'/'scsi' cover SATA/IDE and VMware's LSI controller; 'nvme'
	# and 'virtio' cover other VM/host disk types; 'squashfs' loads modloop.
	initfs_features="$initfs_features ata base cdrom ext4 mmc nvme raid scsi squashfs usb virtio xfs btrfs"
	# Everything OpenNAS needs ships ON the ISO, so the installer installs the
	# whole system from the CD's apk repo - no network mirror required.
	apks="$apks
		alpine-base
		alpine-conf
		kbd-bkeymaps
		linux-lts
		linux-firmware-none
		mkinitfs
		nodejs
		nginx
		openssl
		samba
		nfs-utils
		netatalk
		avahi
		avahi-tools
		dbus
		wsdd
		mdadm
		lvm2
		cryptsetup
		btrfs-progs
		xfsprogs
		exfatprogs
		ntfs-3g
		e2fsprogs
		dosfstools
		smartmontools
		nvme-cli
		hdparm
		docker
		docker-cli
		docker-cli-compose
		libvirt
		libvirt-daemon
		qemu-system-x86_64
		qemu-img
		qemu-modules
		rsync
		dcron
		lm-sensors
		tzdata
		newt
		dialog
		parted
		sfdisk
		util-linux
		lsblk
		blkid
		findmnt
		wipefs
		musl-utils
		nftables
		quota-tools
		e2fsprogs-extra
		chrony
		openssh
		grub
		grub-bios
		grub-efi
		efibootmgr
		syslinux
		"
	apkovl="genapkovl-opennas.sh"
}
