# Roadmap

OpenNAS is at **0.9.0-beta.1**. The current beta includes file sharing, storage
management, containers, virtual machines and signed updates. The main work
before 1.0 is broader installation testing and completing the features below.

Statuses describe the implementation in this tree. They do not imply that every
feature has been validated on physical hardware. Installation and system-operation
test results are recorded in the [engineering log](./ENGINEERING-LOG.md).

## Available in the beta

### Storage and sharing

- Disk initialization, SMART monitoring with email alerts, and allocation of
  unpartitioned space on an existing disk.
- Software RAID 0/1/5/6/10 with rebuild and spare management.
- ZFS stripe, mirror and RAIDZ1/2/3 pools; datasets, snapshots, rollback, scrubs,
  quotas, pool export and import.
- Volume usage and configurable locations for VM and container data.
- Scheduled scrubs, TRIM and SMART self-tests.
- SMB, NFS and AFP shares with user and group permissions, folder rules,
  per-share quotas and per-network NFS export rules.
- Per-share recycle bins and Time Machine targets.

### Accounts and security

- Local users and groups, WebAuthn passkeys, TOTP two-factor authentication and
  OIDC sign-in. OpenNAS can also provide OIDC sign-in for other apps.
- Temporary passwords, required passkey enrolment and breached-password checks.
- Checks that prevent removing or disabling the last administrator.
- Encrypted recoverable secrets and hashed session tokens.
- Firewall rules, automatic IP blocking and decoy routes for automated scanners.
- App permission prompts, publisher trust and per-user app access lists.
- Audit logging, rate limiting and dependency auditing in CI.

### Apps, containers and virtual machines

- Signed app packages, the SDK, an app generator and configurable repositories.
- Binary file transfers and upload progress for SDK apps.
- Docker containers, Compose stacks and private registries.
- KVM virtual machines with browser consoles, snapshots and virtual networks.
- USB device passthrough for VMs.

### Desktop and administration

- Windows, an app launcher, global search, keyboard shortcuts and themes.
- Initial account setup and an optional administrator onboarding wizard.
- Phone layout with full-screen apps, a bottom bar and an app switcher.
- File Station with previews, ZIP support, recycle bin, share links, thumbnails
  and drag-and-drop.
- Automatic TLS certificates, dynamic DNS, SSH configuration and the `opennas` CLI.
- Automatic sign-in for selected accounts from configured addresses.
- Scheduled tasks, configuration backup and restore, SMTP and log viewing.

### Appliance

- Alpine-based x86_64 ISO with BIOS and UEFI installation paths, exercised in QEMU.
- A separate data partition and unattended installation from an answer file.
- Signed updates with rollback if the updated service fails its health check.
- mDNS discovery for access by hostname.

## Incomplete or awaiting validation

| Area | Current state and remaining work |
| --- | --- |
| Localization | The translation runtime and partial German catalogue are available. Much of the interface still uses English text directly. |
| PCI passthrough | Device enumeration, IOMMU checks and backend attachment routes exist. The UI disables PCI attachment until it has been validated with a guest on suitable physical hardware. USB attachment is available. |
| VM and container backups | VM snapshots work. Container-volume backups and complete VM backup workflows still need implementation. |
| SDK transport | Binary transfers work. General streaming and WebSocket capabilities are not exposed through the SDK. |
| Scheduled jobs | The system-task catalogue covers configuration backup, scrub, TRIM and SMART tests. It does not accept arbitrary shell jobs. SDK apps have a separate declarative scheduler. |
| Hardware coverage | Installed-system tests have run in QEMU, with fixes and follow-up checks documented in the engineering log. A full physical-hardware installation sweep remains pending. |
| ARM images | The builder accepts `aarch64`. Build, boot and installation validation on ARM hardware remain pending. |

## Before 1.0

- [ ] **Physical-hardware installation tests.** Exercise boot, installation,
  storage, networking, updates and recovery on supported machines.
- [ ] **ARM validation.** Build an arm64 ISO and test installation and boot on
  physical hardware.
- [ ] **Complete localization.** Move the remaining interface text into the
  catalogue and finish the German translations.
- [ ] **UPS support through NUT.** Report battery status and shut down cleanly
  when power is running out.
- [ ] **Disk and power management.** Add spindown settings and scheduled power
  on/off where the hardware supports it.
- [ ] **Backups to another device.** Add scheduled rsync or restic backups to an
  external disk or remote destination.
- [ ] **More notification channels.** Support ntfy, Gotify or webhooks alongside
  email.
- [ ] **LDAP integration.** Connect to an external directory.
- [ ] **FTP and FTPS.** Add service configuration and access controls. SFTP uses
  the SSH service; it does not yet have a separate file-service setup screen.

## Later work and proposals

These items have no committed release dates.

### Storage

- **Snapshot browsing:** expose previous file versions from ZFS snapshots in
  File Station.
- **Replication:** send ZFS snapshots to another NAS.
- **Encryption:** support encrypted datasets and an installer option for
  full-disk encryption.
- **iSCSI targets:** provide block storage over the network.
- **RAIDZ expansion:** add an expansion workflow for compatible OpenZFS versions.
- **Cloud sync:** integrate rclone for remote storage services.

### Networking

- **WireGuard:** configure VPN access to the NAS.
- **Reverse-proxy management:** route traffic to hosted apps.
- **Bonding and VLANs:** support more advanced network configurations.

### Apps and publishing

- **Photos:** browse shared-folder images through thumbnails, albums and a timeline.
- **Download station:** download torrents, Usenet content and HTTP files to shares.
- **Sentinel:** offer camera and NVR tools through Package Center.
- **SIP and telephony:** provide these as installable apps.
- **Community App Store:** build a publishing and discovery workflow on top of
  the existing package and repository support.

### Desktop

- **More languages:** add catalogues and verify plural forms and layouts.
- **Accessibility:** review keyboard access, focus order, contrast and screen readers.
- **PWA installation:** make the desktop installable from supported browsers.
- **Theming/Branding:** expand the oiption for theming, allowing to customize the entire UI

### Further investigation

- **quickemu** as an additional VM backend.
- **Hardware transcoding passthrough** after PCI passthrough validation.
- **Per-user quotas** after addressing file-service identity mapping.
- **Clustering and high availability**, which would require substantial changes
  to storage and service coordination.

## Design constraints

| Topic | Current decision |
| --- | --- |
| Per-user filesystem quotas | In the appliance's default Samba setup, writes use the `opennas` service account. Per-user filesystem quotas would therefore not track individual OpenNAS users. |
| ext4 repair | Filesystem repair requires an unmounted filesystem. OpenNAS does not offer online ext4 repair. |
| Confirmation dialogs | Destructive operations require confirmation. Routine actions should not add unnecessary prompts. |
| Cloud accounts | OpenNAS does not require an external account. Optional services such as update checks, certificate issuance and dynamic DNS make network requests when used. |

## Current limits

- **Encryption uses a local key.** An attacker who can read both the encrypted
  data and its key can decrypt it. Encryption at rest does not protect a
  compromised running service.
- **Configuration exports omit secrets and file contents.** Keep separate
  backups of shared files, VM disks and container volumes.
- **RAIDZ expansion is not exposed by OpenNAS.** The current management workflow
  grows pools by adding vdevs; it does not add disks to an existing RAIDZ vdev.
- **Administrators are trusted.** They can request privileged system operations.
  Allowing a regular user to perform those operations would be a security issue.
- **Share-link tokens are stored in recoverable form** so the UI can reconstruct
  links. Database access can expose those links.

[Engineering log](./ENGINEERING-LOG.md) | [Security policy](./opennas/SECURITY.md)
