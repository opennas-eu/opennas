# Cutting a release

## Once, ever: the signing key

Every installed machine only accepts updates signed by the key baked into the ISO
it was installed from. It is generated once and never changes.

```sh
openssl genpkey -algorithm ed25519 -out packaging/release.key
openssl pkey -in packaging/release.key -pubout -out packaging/update-key.pub
```

- `update-key.pub` **is** committed — it ships inside every ISO.
- `release.key` is **never** committed (`.gitignore` excludes `*.key`). Back it up
  somewhere that is not this machine.
- Lose it and no installed machine will accept another update until somebody
  replaces `/etc/opennas/update-key.pub` by hand, on each machine.

Confirm a build carries the key you think it does:

```sh
openssl pkey -pubin -in packaging/update-key.pub -outform DER | sha256sum
```

## Every release

1. Bump the version in every `package.json` (`opennas/`, `apps/*`,
   `packages/shared`), and in `sdk/` if the SDK changed.
2. `pnpm test && pnpm typecheck && pnpm build`
3. Build the ISO:
   ```sh
   pnpm -C opennas dist        # or opennas/distro/build.sh
   ```
   Output lands in `opennas/BUILD/out/`.
4. Checksum it, because the download page tells people to check:
   ```sh
   cd opennas/BUILD/out
   sha256sum opennas-*.iso > opennas-<version>-x86_64.iso.sha256
   ```
5. Build and sign the **update bundle**, so existing machines can update to this
   version without reinstalling:
   ```sh
   packaging/make-release.sh packaging/release.key
   ```
   That writes `opennas-<version>.tar.gz`, its `.sig`, and `stable.json`.
6. Publish `stable.json` at the channel URL the appliance polls
   (`https://opennas.org/updates/stable.json` by default). Fill in its `notes`
   first — that is what people read before deciding to update.
7. Attach the ISO and its `.sha256` to the GitHub release.

## What not to do

- Don't ship an ISO built without `update-key.pub`. Self-update refuses
  everything on those installs, and the only fix is a reinstall.
- Don't rotate the signing key between releases. Machines installed from the old
  ISO will refuse the new bundles.
- Don't hand-edit `stable.json` to point at a bundle you signed with a different
  key. The helper checks the signature, not the manifest.
