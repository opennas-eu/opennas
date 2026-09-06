# OpenNAS

OpenNAS is a NAS operating system with a desktop in your browser. Manage shared
folders, users, disks, containers and virtual machines from one interface. It
runs on your own hardware and does not require a cloud account.

![status](https://img.shields.io/badge/status-0.9.0--beta.1-orange)
![licence](https://img.shields.io/badge/licence-GPL--3.0--or--later-blue)
![stack](https://img.shields.io/badge/stack-Node%20%2F%20React%20%2F%20Fastify-lightgrey)

> **Beta:** installation and system operations have been exercised in QEMU.
> A full installation test on physical hardware is still pending. Keep a
> separate backup of any data you use with OpenNAS.

## Features

- **Storage:** disk initialization, unallocated-space claiming, software RAID
  0/1/5/6/10, and ZFS pools with datasets, snapshots, rollback and quotas. SMART
  monitoring includes email alerts and scheduled self-tests, scrubs and TRIM.
- **File sharing:** SMB, NFS and AFP shares with user and group permissions,
  folder rules, per-share quotas, recycle bins and Time Machine targets.
- **Accounts:** local users and groups, passkeys, TOTP two-factor authentication
  and OIDC single sign-on. OpenNAS can also act as an OIDC provider for other apps.
- **Apps:** built-in file management, monitoring and administration tools, plus
  installable apps that run in a sandbox with approved permissions.
- **Containers and VMs:** Docker containers, Compose stacks and private registries;
  KVM virtual machines with browser consoles, snapshots and virtual networks.
- **System administration:** signed updates with automatic rollback, firewall
  rules, automatic IP blocking, dynamic DNS, TLS certificates, audit logs and
  configuration backup and restore.

The desktop adapts to phone screens. English is the default language; German
translations cover part of the interface.

## Run locally

Use Node 22.18 or later and pnpm. Run these commands from this directory:

```sh
pnpm -C opennas install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173> to create the initial admin account. The API listens
on port 4174.

The default system mode is `demo`. It generates service configurations without
applying privileged system changes. Local application data is still written to
disk. Leave `OPENNAS_SYSTEM_MODE` unset or set to `demo` for development.

```sh
pnpm test
pnpm typecheck
pnpm build
```

See the [test guide](./opennas/tests/README.md) for test setup and requirements.

## Build an installer ISO

The ISO builder needs Docker as well as the Node/pnpm toolchain. See the
[distribution guide](./opennas/distro/README.md) for host setup and architecture
options. From this directory:

```sh
pnpm -C opennas install --frozen-lockfile
opennas/distro/build.sh
```

The default build targets x86_64 and writes ISOs to `opennas/BUILD/out/`.
Cutting a release you intend to publish — including the update signing key,
which is generated once and never changes — is documented in
[`opennas/packaging/RELEASING.md`](./opennas/packaging/RELEASING.md).
The builder also accepts `aarch64`, but ARM installation and boot validation
remain on the roadmap.

Write the ISO to a USB drive, boot the target machine and follow the installer.
For unattended installation, see the
[example answer file](./opennas/distro/installer/opennas-answers.conf.example).

`pnpm -C opennas dist` builds a deployment staging tree at
`opennas/packaging/out/opennas/`. It does **not** build an ISO.

## Project layout

Each area has its own dependencies, lockfile and build commands.

| Directory | Contents |
| --- | --- |
| [opennas/](./opennas/) | NAS API, web desktop, shared types, tests, installer and system helpers. |
| [sdk/](./sdk/README.md) | App SDK, app generator, and example apps and themes. |
| [repo-server/](./repo-server/README.md) | App repository server and web catalogue. |
| [website/](./website/README.md) | Public website and static export. |

The root package provides shortcuts for the NAS workspace. `pnpm build` builds
OpenNAS; it does not build all four areas. Use `pnpm build:sdk`,
`pnpm build:website` or `pnpm build:repo-server` for the other projects after
installing their dependencies.

See [STRUCTURE.md](./STRUCTURE.md) for the directory boundaries. The SDK has its
own [development guide](./sdk/README.md), including how to update the hosted SDK
copy in the NAS web app.

## Deployment and configuration

The appliance serves the desktop and API through nginx on the same origin.
For a separately hosted frontend, set `VITE_OPENNAS_API_BASE` when building the
web app and `OPENNAS_CORS_ORIGINS` on the backend.

Environment options are listed in [opennas/.env.example](./opennas/.env.example).
Many account, storage and service settings can also be changed in Control Panel.

For OIDC sign-in, configure a provider and set:

```env
OPENNAS_OIDC_ISSUER=https://auth.example.com/application/o/opennas/
OPENNAS_OIDC_CLIENT_ID=opennas
OPENNAS_OIDC_CLIENT_SECRET=replace-with-your-client-secret
OPENNAS_OIDC_REDIRECT_URI=https://your-nas/api/auth/oidc/callback
```

The sign-in screen then offers SSO. `OPENNAS_OIDC_AUTOCREATE=true` allows the
first sign-in to create a local account.

## Security

The backend runs as an unprivileged service account. Privileged system operations
use dedicated shell helpers, allowed by absolute path in the `doas` policy.
The helpers validate their own arguments.

- Passwords use scrypt; session tokens are stored as SHA-256 hashes.
- Recoverable secrets use AES-256-GCM with a local key file restricted to mode
  0600. This does not protect against an attacker who can read both the data and
  its key, or who controls the running service.
- The data directory uses mode 0700; the database and its WAL and shared-memory
  files use mode 0600.
- Forwarded client addresses are trusted only from loopback.
- Third-party apps run in opaque-origin iframes and use the SDK bridge to access
  approved capabilities.
- The privileged update helper verifies Ed25519 signatures before installing a
  bundle, independently of the backend that downloads it.

Configuration exports omit secrets. They are not backups of shared files, VM
disks or container volumes.

To report a vulnerability, follow the [security policy](./opennas/SECURITY.md).

## Licence

OpenNAS is licensed under the [GNU GPL, version 3 or later](./opennas/LICENSE).
The [SDK and generated app templates](./sdk/LICENSE) use the MIT licence.

[Roadmap](./ROADMAP.md) | [Structure](./STRUCTURE.md)
