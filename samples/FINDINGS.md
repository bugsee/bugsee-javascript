# Findings — cross-cutting

SDK defects, data-arrival failures and data inconsistencies found while building the sample
applications, that are not specific to one sample. Per-sample findings live in
`samples/<name>/FINDINGS.md`.

Severity: **blocker** (ships broken / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-X1 · `@bugsee/rrweb` ships a git dependency, which breaks installation for consumers

- **Severity:** blocker (publish blocker)
- **Package:** `@bugsee/rrweb` (`packages/rrweb/package.json`)
- **Scenario:** installing any browser-family package from a packed tarball
- **Expected:** `pnpm add @bugsee/react` resolves every transitive dependency from the registry.
- **Observed:** `@bugsee/rrweb` declares
  `"@bugsee/rrweb-record": "github:bugsee/rrweb#d50d8d7e0786e095bfaa12bdaadc59b7447ed920"`. Installing
  it fails on pnpm 11 with `ERR_PNPM_EXOTIC_SUBDEP` ("Exotic dependency … is not allowed in
  subdependencies when blockExoticSubdeps is enabled"), which is the default. Even with that setting
  disabled, a git dependency requires every consumer to have git and network access to the
  `bugsee/rrweb` repository — which is not public — so the published package would be uninstallable
  for customers.
- **Reproduce:**
  ```
  node scripts/pack-local.mjs
  node scripts/new-sample.mjs tmp "@bugsee/react"
  # remove the `blockExoticSubdeps: false` line the scaffolder writes
  cd samples/tmp && pnpm install
  ```
- **Fix direction (not applied):** publish `@bugsee/rrweb-record` to npm, or vendor the fork's built
  record bundle into `@bugsee/rrweb`'s own `dist` so it has no external dependency.
- **Workaround in samples:** `scripts/new-sample.mjs` writes `blockExoticSubdeps: false` into each
  sample's `pnpm-workspace.yaml`.

### F-X2 · Every package is published at version `0.0.0`

- **Severity:** major (publish blocker)
- **Package:** all of `packages/*`
- **Expected:** packed manifests carry a real version, and inter-package dependencies pin it.
- **Observed:** every `package.json` is `"version": "0.0.0"`, so `pnpm pack` rewrites `workspace:*`
  to `"0.0.0"`. Samples must override **every** `@bugsee/*` name to a local tarball for installation
  to succeed. Harmless in the monorepo; it needs a release/versioning pass (changesets is already a
  devDependency) before publishing.

## Resolved

_(none yet)_
