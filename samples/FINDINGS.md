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

### F-X3 · `request.json` omits `source.type`, so every JS issue has no trigger

- **Severity:** major
- **Package:** `@bugsee/protocol` (`packages/protocol/src/wire.ts:63`), `@bugsee/core` (report assembly)
- **Scenario:** S4 — any `logException`
- **Expected:** the report carries the trigger that produced it. `ReportingSource`
  (`packages/core/src/reporting.ts:33`) models a `type` (`crash`/`error`/`shake`/`code_upload`/…), and
  the collector reads exactly that: *"How a report was triggered, as the SDKs put it on the wire in
  `source.type`"* (appserver `code/constants/issue.js:12`).
- **Observed:** the wire type is `source: { mechanism: Mechanism; origin?: string }` — no `type`. The
  trigger is computed inside the SDK, used to derive the issue type, then dropped before assembly.
  On the backend: every JS issue reports `Trigger: not reported`, and notification filters keyed on
  `source_types` can never match a JS issue, because the field they filter on never arrives.
  `issue.controller.js:77` also branches on `body.source.type === 'code_upload'`, which a JS SDK can
  therefore never reach.
- **Evidence:** issue `SNODE-1`, `# Report source` → `Trigger: not reported`.

### F-X4 · Captured logs never reach the issue

- **Severity:** major
- **Package:** unknown — not yet isolated to the SDK or the backend
- **Scenario:** S3/S6 — manual `log()` and `console.*` before an exception
- **Expected:** `get_issue` with `include_logs` shows the console lines, manual log lines and
  breadcrumbs captured in the session.
- **Observed:** the `# Logs` section is absent for every issue checked, on node and in the browser,
  even when the scenario provably logged first. Reproduced independently by `samples/browser-vanilla`
  (its F-6, 3× across session types) and on `SNODE-1` with `entries: "all"`.
- **Next step:** unzip an uploaded bundle and check whether `log.json` is present and populated. That
  splits it cleanly into "the SDK did not send it" vs "the backend did not surface it".

### F-X5 · SDK frames are attributed to the user

- **Severity:** minor
- **Package:** `@bugsee/core` stack parsing, or the backend's frame classifier
- **Observed:** frames inside `node_modules/@bugsee/node/dist/index.js` are labelled `[UserFrame]` in
  the issue's stack trace. They are SDK frames; marking them as the user's puts SDK internals at the
  top of a trace and into grouping.
- **Evidence:** issue `SNODE-1`, `## Stack trace`.

## Resolved

### F-X2 · Every package is published at version `0.0.0` — **fixed** (`6d63ba8`)

Worse than a packaging nuisance: the collector enforces a per-runtime floor of `0.1.0`, so `0.0.0`
had every session rejected with `UnsupportedSdkError`. All packages and the hardcoded per-platform
`SDK_VERSION` constants are now `0.1.0`, guarded by `dev-packages/packaging-guard`.


_(none yet)_

### F-X6 · The wire contract defects — **fixed** (`0318229`, `84976f7`)

Four defects in `@bugsee/core` that together meant no report from any runtime could reach Bugsee:
`x-client-type: web` (rejected against a `javascript` application), the `{ok, result}` v2 envelope
being ignored (snake_case ids read as camelCase off the top level), a rejection arriving as HTTP 200
being read as success (caching `undefined` as the access token forever), and an
`x-amz-checksum-sha256` header on the signed S3 PUT that the presigned url was never signed for
(403 on every bundle). Independently isolated by three sample builds. The mock collector in
`@bugsee/e2e-kit` had been written from the SDK's assumptions rather than the server's contract,
which is why no test could catch any of them; it now speaks the real wire.

### F-X7 · Seven packages shipped with no `publishConfig` — **fixed** (`3921760`)

`@bugsee/replay`, `replay-canvas`, `rrweb`, `vite-plugin`, `webpack-plugin`, `bundler-plugin-core`
and `electron` published an `exports` map pointing at `./src/*.ts`, which `files: ["dist"]` does not
pack. `@bugsee/electron` also declared three subpath entries its build never emitted, and
`@bugsee/protocol` dropped its `./upload-contract.schema.json` subpath on publish. Guarded by
`dev-packages/packaging-guard`.
