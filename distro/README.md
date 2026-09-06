# OpenNAS distro / ISO build

Builds a bootable, Alpine-based **OpenNAS installer ISO**. The build runs inside
an Alpine **Docker container** (using Alpine's own `mkimage` tooling), so it works
the same on your local machine and on GitHub Actions - no Alpine host required.

## Provision a build host (Debian 13)

On a fresh Debian 13 (trixie) machine, one script installs everything (Docker +
buildx, qemu/binfmt for arm64, Node 22, pnpm, native toolchain):

```bash
sudo distro/setup-debian.sh
# log out/in once (docker group), then:
pnpm install
```

## Quick start (build)

```bash
distro/build.sh                              # x86_64 ISO  -> BUILD/out/
OPENNAS_ARCHES="x86_64 aarch64" distro/build.sh   # both arches
```

`build.sh` runs `stage.sh` for you. To only stage (no ISO): `distro/stage.sh`.

Requirements: Docker. For `aarch64` on an x86 host, register qemu once (the setup
script does this): `docker run --privileged --rm tonistiigi/binfmt --install arm64`.

## How it fits together

```
distro/
  stage.sh          copies everything needed into BUILD/ (payload + tooling)
  build.sh          stage -> build Alpine build-env image -> run mkimage -> ISO
  Dockerfile        the Alpine build environment (mkimage tools + node)
  mkimage/
    run-mkimage.sh      (in container) builds per-arch node_modules, runs mkimage
    mkimg.opennas.sh    mkimage profile: packages + kernel + apkovl for the ISO
    genapkovl-opennas.sh builds the boot overlay (bakes OpenNAS in, autostarts installer)
  installer/
    opennas-install   the guided whiptail installer (runs on the live ISO)
    opennas-answers.conf.example  template for an unattended install
BUILD/                work dir + ISO output (git-ignored)
  payload/            OpenNAS app + service files + installer (from stage.sh)
  out/                opennas-<ver>-<arch>.iso
```

### Flow
1. **stage.sh** builds the app (`packaging/build-dist.sh`) and assembles
   `BUILD/payload` (the OpenNAS tree, OpenRC service, nginx conf, installer).
2. **build.sh** builds the Alpine build-env image per arch and runs it.
3. In the container, **run-mkimage.sh** runs `npm install --omit=dev` (compiling
   `better-sqlite3` for that arch/musl), then calls `mkimage.sh` with the
   **opennas** profile.
4. The resulting live ISO boots, applies the apkovl, and auto-launches
   **opennas-install**, which installs Alpine + OpenNAS to the chosen disk and
   enables the `opennas` + `nginx` services. Reboot → open `http://<box>/`.

## Installing

### Interactive

Boot the ISO. The first question is the **keyboard layout**, deliberately -
everything you type afterwards (including the admin password) uses it, and a
password typed on the wrong layout is one you can't reproduce at the login
prompt later.

Then pick the disk and how to divide it:

- **split** (default) - a system partition (`SYSTEM_SIZE`, 32 GiB by default)
  plus a second partition holding everything else, mounted at
  `/var/lib/opennas`. Shares, app data and uploads live there, so reinstalling
  or resizing the OS doesn't put them at risk, and filling a share can't fill
  the system partition.
- **whole** - one filesystem for everything, as before.

Note that Docker images (`/var/lib/docker`) and libvirt VM disks stay on the
system partition unless you point them at a data volume in
**Control Panel → Storage**, which is why the system partition defaults to a
generous 32 GiB.

### Unattended

Copy `installer/opennas-answers.conf.example` to a USB stick as
`opennas-answers.conf`. The installer looks for `/media/*/opennas-answers.conf`
at startup and, if it finds one with `UNATTENDED=yes`, runs with no prompts at
all - no whiptail, no questions. You can also pass `--answers <file>` directly.

The file is parsed as plain `KEY=value`; it is never sourced, so nothing in it
executes. Before erasing anything the installer prints what it's about to do and
counts down (`CONFIRM_DELAY`, 10s by default) so a forgotten stick in a booting
machine can still be caught with Ctrl-C.

`ADMIN_PASSWORD` is plain text in that file - treat the stick accordingly.

## Status

This is the **first-draft** ISO pipeline (slice B). The structure is complete and
verifiable (staging, container, profile), but the live-boot + installer behavior
is expected to need iteration on a real VM - in particular:

- `opennas-install` does destructive disk ops; **test in a VM**. Root-partition
  detection and the EFI/BIOS path may need tuning per firmware.
- The **split** layout partitions with `sfdisk` and then installs the base system
  into the mounted root via `setup-disk -m sys <mountpoint>`. The partition table
  it produces has been verified (1 MiB BIOS-boot + 512 MiB ESP + system + data,
  correct GPT type GUIDs), and the answer-file parser and size checks have unit
  tests - but the end-to-end install has **not** been booted on hardware yet.
- The installer auto-launch (profile.d on tty1) may want to become a proper
  getty/inittab entry.
- arm64 ISO boot artifacts (UEFI) may need profile tweaks vs x86_64.

### Troubleshooting boot

- **"Booting OpenNAS installer" then the VM resets / CPU halted (triple fault):** the
  initramfs panicked - almost always a missing driver for the boot media or disk.
  The profile's `initfs_features` must include `cdrom` (read the ISO/modloop),
  `ata`/`scsi` (SATA/IDE + VMware LSI), `squashfs`, etc. (fixed in
  `mkimg.opennas.sh`). Rebuild after changing it.
- To read a panic that scrolls off/resets: add a serial port to the VM (the
  profile already sets `console=ttyS0,115200`) and capture it to a file, or set
  the VM firmware to BIOS and give it ≥2 GB RAM (the apkovl loads into RAM).

Build the ISO, boot it in qemu, and iterate. See the repo `packaging/` dir for the
non-ISO path (install OpenNAS onto an already-running system).
