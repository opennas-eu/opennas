# Reporting a security problem

**Please don't open a public issue for a security bug.** Email
**security@opennas.org** instead, or use GitHub's *Report a vulnerability*
button on the Security tab, which is private.

Describe the problem and include any details you have. The OpenNAS version
(Control Panel -> Update & Information), steps to reproduce, and connection setup
(direct access, nginx or another proxy) help us investigate.

## What to expect

| | |
| --- | --- |
| First reply | Within 3 days. If you don't hear back, assume the mail went missing and try the GitHub form. |
| An assessment | Within 7 days - whether it's a real issue, how bad, and what happens next. |
| A fix | As fast as the severity warrants. Anything remotely exploitable is a same-week release. |
| Credit | Named in the release notes and here, unless you'd rather not be. |

This is a hobby project with no bug-bounty budget. We investigate reports and
credit contributors publicly, unless they prefer to remain anonymous.

Please give us a chance to ship a fix before publishing. 90 days is the usual
ceiling, but if a fix is taking longer than that, say so and we'll agree
something rather than let the clock run out silently.

## Which versions get fixes

OpenNAS is pre-1.0. Only the **latest release** is supported - there are no
backports to older betas. Updating is a click in Control Panel -> Update &
Information, and updates are signed (see below).

## What's in scope

Anything that lets someone do more than they should on a NAS running OpenNAS:

- authentication or session bypass, privilege escalation between users, or an
  admin-only action reachable by a regular user
- escaping the app sandbox - an installed app reading another app's data, the
  desktop's cookies, or files outside what its grants allow
- anything that turns web access into code execution on the host, especially
  through the `doas`-permitted helpers, the update path, or the shell scripts
  under `packaging/` and `distro/`
- path traversal out of a share, or reading files the caller has no grant for
- a way to install an unsigned or tampered update
- credentials or secrets written somewhere they shouldn't be (logs, the audit
  log, config exports, world-readable files)
- getting an admin locked out of their own machine - the auto-ban and firewall
  paths are deliberately conservative, and a way to weaponise them counts

## What's already known, and why

The following design limits are known. Please report any impact beyond what
is described here.

**AES-GCM is used carefully, not casually.** The nonce is 96 bits, and a repeat
under the same key is catastrophic rather than merely bad, it leaks GHASH's `H`
and lets an attacker forge anything under that key. Values are therefore sealed
with a **per-value key**: a fresh random 256-bit salt, HKDF-SHA256 to derive the
key actually used, then AES-256-GCM. Two values share a GHASH `H` only if their
salts collide as well as their nonces. The older single-key format (`enc1:`) is
still read, and upgraded in place on boot.

AES-GCM is also not key-committing. That matters where an attacker supplies
candidate keys, password-based encryption with a partitioning oracle, or
multi-recipient messaging. OpenNAS has one randomly generated key per machine and
no such oracle, so it does not apply here; if you can show otherwise, that is a
report we want.

**Encryption at rest doesn't protect a running machine.** TOTP secrets, the SMTP
password and the dynamic-DNS token are sealed with AES-256-GCM, but the key is a
0600 file on the same disk - it has to be, because an appliance must come back
up unattended after a power cut, and the alternative is someone typing a
passphrase at the console on every boot. This narrows the blast radius of a
*leaked file*: a backup, a snapshot, a config export, a disk sold or binned. It
does nothing against someone who already has root, or the `opennas` account, on
a live box. See `apps/api/src/db/secrets.ts`.

**Share-link tokens are stored in the clear, on purpose.** The URL has to be
reconstructable so the copy button works, and anyone who can read the database
can read the shared files directly anyway.

**An admin is trusted.** Admins can run privileged operations by design -
storage, services, updates. "An admin can reach the shell" is not a
vulnerability; "a regular user can" very much is.

**The IPv6 side of the never-ban check is a textual prefix match.** It's coarse,
but it only ever *widens* the exempt set, so the failure is an address that
could have been banned and wasn't - never a wrongly-banned one.

**ZFS pool operations are irreversible by nature.** `zpool create` erases every
member disk and `zfs rollback` discards newer snapshots. Both are admin-only and
confirmed in the UI. A way for a *non-admin* to reach either, or a pool or
dataset name that escapes the helper's validation and reaches `zpool`/`zfs` as
something other than a name, is very much in scope.

**PCI passthrough is not finished** and is greyed out in the UI. USB passthrough
is available. Reports about the PCI path are welcome but it isn't shipped.

## Out of scope

- Findings from an automated scanner with no demonstrated impact, especially
  version-banner and "missing header" reports against a self-hosted LAN service
- Denial of service by simply sending a lot of traffic
- Anything requiring physical access to the machine, or a hostile hypervisor
- Social engineering, or reports about the project's own web hosting
- Vulnerabilities in Alpine's packages - report those to Alpine; we'll pick up
  the fix with the base system

## How OpenNAS is built to fail safely

Security boundaries to check when reviewing the code:

- The backend runs as the unprivileged `opennas` user. It reaches root only
  through a `doas` policy that allow-lists a handful of helpers **by absolute
  path** - never a shell, never an interpreter.
- **Update signatures are verified by the root helper, not by the backend.** If
  the process that downloads a bundle were also the one deciding it's genuine, a
  web bug would become a way to install code as root. `packaging/opennas-update`
  checks Ed25519 against a key only root can replace, and treats everything it's
  handed as hostile.
- `X-Forwarded-For` is trusted from loopback only.
- Apps run in a sandboxed iframe on an opaque origin and reach OpenNAS only
  through the SDK bridge, limited to the capabilities their manifest declares and
  an admin approved.
- The data directory is 0700; the database and its WAL are 0600.

Please report any case where these protections fail.
