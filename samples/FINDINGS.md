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

### F-X8 · A burst of more than 4 concurrent reports is deferred to the next process start

- **Severity:** major
- **Package:** `@bugsee/core` (`packages/core/src/upload-pipeline.ts:190`)
- **Scenario:** S4/S5 under concurrency — several incidents at once
- **Expected:** a server that fails 50 concurrent requests reports 50 incidents in that process.
- **Observed:** the upload pipeline admits at most `bufferSize` (default **4**) in-flight uploads and
  refuses everything beyond that with `queue_overflow`, returning a non-permanent failure. The
  durable pipeline writes each bundle to disk BEFORE the attempt and keeps the copy when the result
  is not settled, so nothing is destroyed — but **nothing retries in-process either**:
  `durable-upload-pipeline.recover()` is called exactly once, at launch
  (`packages/node/src/launch.ts:715`), and there is no timer-based drain. On a long-running server a
  refused report waits for the next restart.
- **Reproduce:** `samples/express-api`, fresh process, 20 concurrent `POST /scenarios/s4/error-instance`
  then one `flush` — 10 bundles upload and the count is stable thereafter, indefinitely. Over the
  sample's full sweep (~260 reports) only 6 arrive. Each scenario passes on its own.
- **Evidence:** `samples/express-api` wire checks `S4.dedupe`, `S8.report-mutate`, `S2 attribute
  after`, `concurrency isolation 0/50` — all four fail for this one reason, and all four pass when
  their scenario runs alone.
- **Fix direction (not applied):** drain the durable queue on a timer (and after a successful upload)
  rather than only at launch, so backpressure defers by seconds rather than until restart.

### F-X9 · `logException` with a non-Error produces an issue with no crash payload

- **Severity:** major
- **Package:** `@bugsee/core` (`packages/core/src/crash.ts`, the report path)
- **Scenario:** S4 — `logException('a string')`, `logException({ code, message })`, `logException(null)`
- **Expected:** a usable issue. Passing a non-Error throwable is part of the documented surface (the
  scenario catalog names it, and JS code throws non-Errors routinely), so it should produce a
  synthetic exception — a type derived from the value and a stack captured at the call site.
- **Observed:** the uploaded bundle contains **no `crash.json` at all**. `request.json` carries the
  stringified value as `summary`, and nothing else; the backend answers `get_issue` with
  *"Crash data for the issue was not found"*. The issue exists, is counted, and is useless.
- **Reproduce:** launch, `await client.logException('a plain string throwable')`, flush, then unzip
  the PUT body — `crash.json` is absent (an `Error` in the same harness produces it).
- **Evidence:** issues `SBROWSER-3` (28 events) and `SVUE-4`, both `<missing crash details>`.

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

### F-X10 · The collector's CORS policy makes the browser SDK unusable for any customer

- **Severity:** blocker (backend, not this repo)
- **Scenario:** any browser-family sample against `apidev.bugsee.com`
- **Observed:** `Access-Control-Allow-Origin` is answered from an allowlist
  (`cfg.web.cors.trusted_origins`) with a hardcoded fallback of `https://appdev.bugsee.com`, never
  reflecting the requesting origin — and `Access-Control-Allow-Headers` omits `x-app-token` and
  `x-bugsee-internal`, which the SDK sends on every call. A customer's domain can never be on that
  allowlist, so a browser session cannot be created at all. Verified with a direct preflight.
- **Fix direction:** the SDK ingest routes authenticate by app token and need no cookie credentials,
  so they want their own policy: `Access-Control-Allow-Origin: *`, no credentials, and the SDK's
  headers allowed. `appserver/code/middleware/common/cors.middleware.js`.
- **Impact on the samples:** `browser-vanilla` must keep a same-origin relay; `react-spa` and
  `vue-spa` must keep a Chromium `--disable-web-security` flag. None of these is available to a real
  user.

### F-X11 · `@bugsee/express` drops the mount prefix from `http.route`

- **Severity:** major
- **Package:** `@bugsee/express` (`packages/express/src/middleware.ts:68`)
- **Observed:** `routeOf` is `req.route?.path`, which is the path RELATIVE to the router. For a router
  mounted with `app.use('/projects/:id/tasks', router)`, a `POST /` handler reports `http.route: "/"`
  and `GET /:taskId` reports `"/:taskId"`. `req.baseUrl` — which holds the mount prefix — is never
  read, so every nested router in a real Express app is misattributed and grouped wrongly.
- **Verified:** by reading the source; originally found by `samples/express-api` against its own
  nested routers.

### F-X12 · `@bugsee/bundler-plugin-core` resolves `bugsee-cli` off `PATH`

- **Severity:** blocker (publish)
- **Package:** `@bugsee/bundler-plugin-core` (`packages/bundler-plugin-core/src/run-cli.ts:95`)
- **Observed:** `resolveBugseeCli` returns the bare string `'bugsee-cli'` unless `BUGSEE_CLI_PATH` is
  set. The binary is installed by the `@bugsee/bugsee-cli` dependency, whose `.bin` is NOT linked into
  a consuming project's root `node_modules/.bin` under pnpm — so a real consumer's build fails with
  `ENOENT`. It works inside this monorepo only because the binary happens to be on PATH there.
- **Fix direction:** resolve the binary from the installed `@bugsee/bugsee-cli` package
  (`createRequire(import.meta.url).resolve(...)`) and fall back to PATH.
- **Verified:** by reading the source; reproduced by `samples/react-spa` on a production build.

### F-X13 · `@bugsee/express` has no `shouldReport`

- **Severity:** major
- **Package:** `@bugsee/express`
- **Observed:** every other backend adapter (koa, hapi, …) exposes a `shouldReport` predicate; express
  does not, so its `errorHandler` reports every error reaching it regardless of status. An app that
  throws a 404 or a validation error as an exception cannot opt out.

### F-X14 · `BugseeErrorBoundary` never sees a route-element throw under a react-router data router

- **Severity:** major
- **Package:** `@bugsee/react`
- **Observed:** with a react-router v6 DATA router, the router's own per-route `RenderErrorBoundary`
  intercepts a route element's render throw before any ancestor boundary, so a `BugseeErrorBoundary`
  wrapping `<RouterProvider>` is never invoked and nothing is reported — silently. Reported by
  `samples/react-spa`, which demonstrates it in its scenario panel.
- **Fix direction:** document the `errorElement` seam, and/or provide a route-level helper.

### F-X15 · A failed bundle PUT discards the underlying transport error

- **Severity:** minor
- **Package:** `@bugsee/core` (`packages/core/src/bundle-uploader.ts`)
- **Observed:** the `catch` around the transport returns `{ ok: false, status: 0, retryable: true }`
  and drops the caught error entirely, so a DNS failure, a TLS failure and an aborted socket are
  indistinguishable to anything downstream — including the user's `onError`.

### F-X16 · Two typing gaps found by real applications

- **Severity:** minor
- `installBugseeErrorHandler(app)` (`@bugsee/vue`) does not typecheck against a real Vue `App`, only
  against the package's own `VueAppLike` test double — reported by `samples/vue-spa`.
- `client.ext('performance')` has no usable type without an extra, undocumented direct dependency on
  the package that declaration-merges `NameExtensionMapping` — reported by `samples/react-spa`.

### F-X17 · MCP `get_issue` does not surface attributes, labels or the report mechanism

- **Severity:** minor (tooling, not the SDK)
- **Observed:** the SDK sends them (`manifest.attrs` in the uploaded bundle carries the attributes,
  confirmed by unzipping a real upload), but the MCP surface never shows them, so a sample cannot
  verify S2/S4 at backend depth and falls back to wire depth.

### F-X18 · One issue displayed a message and a stack trace from different events

- **Severity:** major if real — **not reproduced**
- **Observed once** by `samples/express-api` on a merged issue. Recorded so it is not lost; it needs a
  deliberate reproduction before it can be acted on.

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
