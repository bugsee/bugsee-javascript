# Findings — cross-cutting

SDK defects, data-arrival failures and data inconsistencies found while building the sample
applications, that are not specific to one sample. Per-sample findings live in
`samples/<name>/FINDINGS.md`.

Severity: **blocker** (ships broken / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-X10 · The collector's CORS policy makes the browser SDK unusable for any customer

- **Severity:** blocker (backend, not this repo)
- **Status:** **fixed in appserver, awaiting deploy to staging.** Pushed to appserver `main`
  (`c632f5a7`, `19099ecb`, `e4b94dfe`, `4db0e059`).
- **Scenario:** any browser-family sample against `apidev.bugsee.com`
- **Observed:** `Access-Control-Allow-Origin` is answered from an allowlist
  (`cfg.web.cors.trusted_origins`) with a hardcoded fallback of `https://appdev.bugsee.com`, never
  reflecting the requesting origin — and `Access-Control-Allow-Headers` omits `x-app-token` and
  `x-bugsee-internal`, which the SDK sends on every call. A customer's domain can never be on that
  allowlist, so a browser session cannot be created at all. Verified with a direct preflight.
- **Scope (measured, not assumed):** the browser-origin surface is exactly three appserver routes —
  `POST /v2/sessions`, `POST /v2/issues` (`packages/core/src/bugsee-api.ts:81,108`) and
  `POST /v2/performance/transactions` (`packages/performance/src/performance-send.ts:23`).
  Nothing else in the SDK builds a URL. The fourth hop, the bundle PUT, goes to a presigned S3 URL
  and needs **no change**: `bugsee-upload-west2` already answers a customer-origin preflight with
  `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, HEAD, PUT`, `Allow-Headers: filename`.
- **Fix applied:** an open policy — `ACAO: *`, no `Allow-Credentials`, the SDK's headers allowed,
  `Max-Age: 86400`, CORP `cross-origin` — that the **route declares** rather than a middleware
  sniffs. `middleware.common.publicCors` is listed on exactly the three ingest POSTs (and their two
  `/v1` twins); `GenericRouter` lifts it to the route's `onRequest` hook and auto-registers a
  matching `OPTIONS` route answered from the same hook, which is what makes it win over the global
  dashboard policy (route `onRequest` runs before global `preValidation`). The dashboard policy is
  untouched everywhere else and stands aside only when the route opted in. All of it writes through
  one module, `code/cors.js`, shared by the middleware, the router and `error.router.js` — so a
  rejected ingest call stays readable and the SDK can surface the collector's reason instead of an
  opaque network error. Config lives in `config/default.js` under `web.cors.public`.
- **Impact on the samples:** until the fix is deployed, `browser-vanilla` keeps its same-origin
  relay and `react-spa`/`vue-spa` keep the Chromium `--disable-web-security` flag. **All three
  workarounds should be stripped and the samples re-verified once staging carries the fix** — that
  re-verification is the real end-to-end proof, which no local test can stand in for.

### F-X18 · One issue displayed a message and a stack trace from different events

- **Severity:** major if real — **not reproduced**
- **Observed once** by `samples/express-api` on a merged issue. Recorded so it is not lost; it needs a
  deliberate reproduction before it can be acted on.

### F-X19 · Two sample harness checks measure timing, not SDK behaviour

- **Severity:** major, **and not yet attributed** — the SDK measures clean in isolation
- **Scenario:** 50 concurrent requests that throw, against real staging
- **What the SDK does now**, measured three ways after the F-X8 work:
  - direct `logException` × 20 → 20 uploaded; × 50 with realistic upload latency → 50 uploaded;
    × 200 → 100 uploaded, which is exactly the capture rate limiter's 100-per-60s budget doing its job;
  - a minimal Express app with the default `setupExpress(app)` → 50 of 50 requests reported.
- **What this sample does:** 21 of 50, reproducibly, and 21 of ~280 across the full sweep. Both the
  `/v2/issues` count and the bundle-PUT count are 21, so the loss is upstream of the network.
- **Therefore:** something in this sample's own wiring — its router mounting, its second client, or
  its scenario routes — and not the SDK path the isolated app exercises. It needs bisecting against
  the minimal app rather than more SDK changes.
- **Consequence:** four of `express-api`'s wire checks (`S4.dedupe`, `S8.report-mutate`, `S2 attribute
  after`, `concurrency isolation`) fail for this reason, and `react-spa`'s `react-report-error` check
  fails the same way — it asserts that a `/v2/issues` request happens within 1500 ms of a click, which
  a backlog draining behind it can miss. They are left failing rather than relaxed: a green check that
  measures the wrong thing is worse than a red one, and these should be rewritten to wait for the
  evidence rather than for a clock.

## Resolved

### F-X17 · MCP `get_issue` did not surface labels, mechanism or attributes — **fixed** (appserver `b103f2cf`)

- **Severity:** minor (tooling, not the SDK)
- **Observed:** the SDK sends all three, but `get_issue` showed none of them, so a sample could not
  verify S2/S4 at backend depth and fell back to wire depth.
- **Three different causes, one per field:**
  - **labels** — persisted all along; the MCP projection never asked for it and the renderer never
    printed it. Now a default `# Labels` section.
  - **mechanism** — never reached disk. `RequestJson.source.mechanism`
    (`packages/protocol/src/wire.ts:86`) is required and always sent, and the collector passes the
    body straight to `dao.issues.create`, but the issue schema declared only `source.type` and
    `source.origin`, so **mongoose strict mode dropped it on every write**. Declaring
    `source.mechanism` is the fix. Now rendered next to `Trigger:` in `# Report source`, and left
    absent (not defaulted) when the SDK reported none.
  - **attributes** — reachable on `recording.manifest.attrs` but never rendered. Unbounded, so
    opt-in behind a new `include_attributes` argument; keys are mongo-unescaped on the way out.
- **Caveat:** issues created before that deploy carry no mechanism — only new reports will have one.
- **Verification:** re-run a browser or node sample and read the issue back through
  `get_issue` with `include_attributes: true`; `# Labels`, `Mechanism:` and `# Attributes` should
  all be present. That is what lifts S2/S4 from wire depth to backend depth.

### F-X1 · `@bugsee/rrweb`'s git dependency — **fixed** (`e60…`, this change)

`@bugsee/rrweb-record` — the prebuilt record-only fork bundle — was a `github:bugsee/rrweb#<sha>`
RUNTIME dependency on a private repository, so pnpm 11 refused it in a subdependency by default and,
even with that disabled, no customer could fetch it. It is now a BUILD-time dependency that tsup
inlines into `@bugsee/rrweb`'s dist (~56 KB gzip, in the one package whose whole purpose is to be that
record path). Verified: `@bugsee/react` installs with pnpm's defaults, and both `@bugsee/rrweb` and
`@bugsee/replay` load from the packed artifact. `dev-packages/packaging-guard` now fails any published
package that declares a git/file/link/url dependency.

### F-X2 · Every package is published at version `0.0.0` — **fixed** (`6d63ba8`)

Worse than a packaging nuisance: the collector enforces a per-runtime floor of `0.1.0`, so `0.0.0`
had every session rejected with `UnsupportedSdkError`. All packages and the hardcoded per-platform
`SDK_VERSION` constants are now `0.1.0`, guarded by `dev-packages/packaging-guard`.

_(none yet)_

### F-X3 · `request.json` omits `source.type`, so every JS issue has no trigger — **fixed** (`811a4bd`)

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

### F-X4 · Captured logs never reach the issue — **not an SDK defect**

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

### F-X5 · SDK frames are attributed to the user — **fixed** (`5a46942`)

- **Severity:** minor
- **Package:** `@bugsee/core` stack parsing, or the backend's frame classifier
- **Observed:** frames inside `node_modules/@bugsee/node/dist/index.js` are labelled `[UserFrame]` in
  the issue's stack trace. They are SDK frames; marking them as the user's puts SDK internals at the
  top of a trace and into grouping.
- **Evidence:** issue `SNODE-1`, `## Stack trace`.

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

### F-X8 · A burst of more than 4 concurrent reports is deferred to the next process start — **fixed** (`5a46942`)

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

### F-X9 · `logException` with a non-Error produces an issue with no crash payload — **fixed** (`811a4bd`)

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

### F-X11 · `@bugsee/express` drops the mount prefix from `http.route` — **fixed** (`30ef2cd`)

- **Severity:** major
- **Package:** `@bugsee/express` (`packages/express/src/middleware.ts:68`)
- **Observed:** `routeOf` is `req.route?.path`, which is the path RELATIVE to the router. For a router
  mounted with `app.use('/projects/:id/tasks', router)`, a `POST /` handler reports `http.route: "/"`
  and `GET /:taskId` reports `"/:taskId"`. `req.baseUrl` — which holds the mount prefix — is never
  read, so every nested router in a real Express app is misattributed and grouped wrongly.
- **Verified:** by reading the source; originally found by `samples/express-api` against its own
  nested routers.

### F-X12 · `@bugsee/bundler-plugin-core` resolves `bugsee-cli` off `PATH` — **fixed** (`30ef2cd`)

- **Severity:** blocker (publish)
- **Package:** `@bugsee/bundler-plugin-core` (`packages/bundler-plugin-core/src/run-cli.ts:95`)
- **Observed:** `resolveBugseeCli` returns the bare string `'bugsee-cli'` unless `BUGSEE_CLI_PATH` is
  set. The binary is installed by the `@bugsee/bugsee-cli` dependency, whose `.bin` is NOT linked into
  a consuming project's root `node_modules/.bin` under pnpm — so a real consumer's build fails with
  `ENOENT`. It works inside this monorepo only because the binary happens to be on PATH there.
- **Fix direction:** resolve the binary from the installed `@bugsee/bugsee-cli` package
  (`createRequire(import.meta.url).resolve(...)`) and fall back to PATH.
- **Verified:** by reading the source; reproduced by `samples/react-spa` on a production build.

### F-X13 · `@bugsee/express` has no `shouldReport` — **fixed** (`30ef2cd`)

- **Severity:** major
- **Package:** `@bugsee/express`
- **Observed:** every other backend adapter (koa, hapi, …) exposes a `shouldReport` predicate; express
  does not, so its `errorHandler` reports every error reaching it regardless of status. An app that
  throws a 404 or a validation error as an exception cannot opt out.

### F-X14 · `BugseeErrorBoundary` never sees a route-element throw under a react-router data router — **fixed** (`c9665e6`)

- **Severity:** major
- **Package:** `@bugsee/react`
- **Observed:** with a react-router v6 DATA router, the router's own per-route `RenderErrorBoundary`
  intercepts a route element's render throw before any ancestor boundary, so a `BugseeErrorBoundary`
  wrapping `<RouterProvider>` is never invoked and nothing is reported — silently. Reported by
  `samples/react-spa`, which demonstrates it in its scenario panel.
- **Fix direction:** document the `errorElement` seam, and/or provide a route-level helper.

### F-X15 · A failed bundle PUT discards the underlying transport error — **fixed** (`5a46942`)

- **Severity:** minor
- **Package:** `@bugsee/core` (`packages/core/src/bundle-uploader.ts`)
- **Observed:** the `catch` around the transport returns `{ ok: false, status: 0, retryable: true }`
  and drops the caught error entirely, so a DNS failure, a TLS failure and an aborted socket are
  indistinguishable to anything downstream — including the user's `onError`.

### F-X16 · Two typing gaps found by real applications — **fixed** (`c9665e6`)

- **Severity:** minor
- `installBugseeErrorHandler(app)` (`@bugsee/vue`) does not typecheck against a real Vue `App`, only
  against the package's own `VueAppLike` test double — reported by `samples/vue-spa`.
- `client.ext('performance')` has no usable type without an extra, undocumented direct dependency on
  the package that declaration-merges `NameExtensionMapping` — reported by `samples/react-spa`.

