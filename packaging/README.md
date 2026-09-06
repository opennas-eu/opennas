# OpenNAS packaging

Turns the monorepo into a deployable OpenNAS service. This is **slice A** toward
OpenNAS as its own Linux distro: get the backend running as a proper system
service (Alpine + OpenRC) behind nginx on any existing machine. The actual
bootable Alpine ISO + guided TUI installer is **slice B**.

## Layout it produces

```
/usr/lib/opennas/          # code (root:root)
  server/index.js          # the esbuild backend bundle
  web/                     # the static SPA
  package.json             # runtime deps only
  node_modules/            # built on the target (native better-sqlite3)
/etc/conf.d/opennas        # OpenRC env config  (edit me)
/etc/init.d/opennas        # OpenRC service
/etc/nginx/http.d/opennas.conf
/var/lib/opennas/          # data (opennas:opennas) - DB, secrets, shares, avatars
```

The backend listens on `127.0.0.1:4174`; **nginx** serves the SPA and proxies
`/api` + `/api/ws` on port 80, so there's a single public origin.

## Build & install

On a build machine (needs the repo + pnpm + Node):

```bash
packaging/build-dist.sh          # -> packaging/out/opennas/  (staging tree)
```

On the target (Alpine, as root) - copy the repo's `packaging/` dir over, then:

```bash
sudo packaging/install.sh        # installs to the layout above + enables services
rc-service opennas start
rc-service nginx start
```

`install.sh` is idempotent: re-running upgrades the code and rebuilds deps while
preserving `/var/lib/opennas` and your edited `/etc/conf.d/opennas`.

Remove with `sudo packaging/uninstall.sh` (add `--purge` to also drop data/config).

## Notes

- **Native module:** `better-sqlite3` compiles from source on musl, so
  `install.sh` pulls `build-base python3` as a temporary `.opennas-build` apk
  virtual and removes it afterward.
- **Config:** everything is env vars in `/etc/conf.d/opennas` (sourced by OpenRC).
  Set `OPENNAS_RP_ID` / `OPENNAS_ORIGIN` + `OPENNAS_COOKIE_SECURE=true` once you
  have a hostname/HTTPS so passkeys work.
- **arch:** amd64 and arm64 both work via this path (deps build on the target).

## Next (slice B)

- `APKBUILD` so OpenNAS is a real `.apk` (depends on `nodejs`, `nginx`; ships the
  OpenRC service).
- Alpine image profile (`mkimage`/`aports`) baking the package + first-boot setup.
- The guided **TUI installer** (whiptail): target disk, hostname, network, admin.
