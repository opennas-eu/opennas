# Tests

```sh
pnpm test           # all tests
pnpm test:unit      # unit tests, no root or network needed
pnpm test:system    # API integration and system tests
pnpm test:watch
```

Tests use Node's built-in runner. Node 22.18 or later runs the TypeScript
sources directly. The resolve hook in `hooks.mjs` maps the API's `.js` imports
to `.ts` files, so failures point to source files rather than generated bundles.
Install the project's dependencies before running the suite.

`setup.mjs` runs before imports in every test process. It registers the hook
and sets `OPENNAS_DATA_DIR` to a fresh temporary directory unless the variable
is already set. This must happen before `config.ts` loads: setting the variable
inside a test body is too late to keep imports from using the default data directory.

## Test directories

| Directory | Contents |
| --- | --- |
| `unit/` | Isolated logic tests. |
| `system/` | Tests using Linux sysfs, shell helpers, external commands or the API server through `buildServer()` and `inject`. Tests skip when a required capability is unavailable. |
| `helpers/` | Shared fixtures and sandbox setup. |

## What to test

Check observable effects as well as return values. For example, the PCI tests
check that devices sharing an IOMMU group with a mounted disk's controller are
excluded. Session tests read the database file to verify that raw tokens are
not stored.

Exercise the shipped implementation where possible. The update tests run a copy
of `packaging/opennas-update` with Ed25519 keys and an HTTP health endpoint in a
temporary installation. They rewrite four path constants in that copy. The
shipped helper does not accept environment overrides for those paths, and a
separate test checks its constants.

The update tests also cover the health-check timeout. GNU wget's default retry
behaviour previously extended the rollback window beyond the intended 90 seconds.

## Adding a test

Name the file `<thing>.test.ts` and place it in `unit/` or `system/`. Use the
fixtures in `helpers/` for tests that touch the database. `setup.mjs` prepares
the temporary data directory before those helpers load.

For route tests, build the server and send requests through `inject`:

```ts
const app = await buildServer();
const res = await app.inject({ method: "GET", url: "/api/health", headers: { cookie } });
```

This exercises request parsing, path resolution and permission checks together.

Skip tests when a required capability is missing:

```ts
const skip = existsSync("/sys/bus/pci/devices") ? false : "needs Linux sysfs";
test("lists PCI devices", { skip }, async () => {
  // Check device discovery here.
});
```
