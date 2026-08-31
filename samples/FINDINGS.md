# Findings — cross-cutting

SDK defects, data-arrival failures and data inconsistencies found while building the sample
applications, that are not specific to one sample. Per-sample findings live in
`samples/<name>/FINDINGS.md`.

Severity: **blocker** (ships broken / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-X18 · One issue displayed a message and a stack trace from different events

- **Severity:** major if real — **not reproduced**
- **Observed once** by `samples/express-api` on a merged issue. Recorded so it is not lost; it needs a
  deliberate reproduction before it can be acted on.
- **Still not reproduced** in the wave-1 re-verification (2026-08-24), which ran the full express-api
  sweep again. Not evidence of absence — the original sighting was a one-off on a merged issue.

## Resolved

### F-X22 · The viewer's context panel could not show an OS and a browser at once — **fixed** (viewer)

- **Severity:** was major (display), surfaced by F-X20's fix.
- `elements-recording-context.component.ts` read `if (env.browser) … else if (env.platform) …`, which
  was correct only while nothing sent both. The moment the web tier began reporting a real OS, showing
  the browser would have HIDDEN it. Two independent `if`s now.
- Two more things the same code path had been hiding, both only reachable once an SDK filled `browser`:
  the template rendered a **"Browser" heading with no browser row** (nothing referenced `browserInfo`
  in that table), and `createBrowserInfo` dereferenced `browser.type` unguarded, so a `browser` object
  without a `type` took the whole context panel down. Both fixed, plus a `chromeos` platform branch for
  the Chromebooks the SDK can now identify.

### F-X20 · The browser tier reported a user-agent string where the backend expects an OS version — **fixed** (in-browser)

- **Severity:** was major (wrong data, every browser-family session). **Closed 2026-08-25.**
- **Was:** `platform.type: 'web'` with the whole user-agent string as `platform.version` — the field the
  backend indexes as `os_version` — so a browser session was the only kind of Bugsee session naming no
  operating system at all.
- **Decision: identify the OS and the browser IN THE BROWSER**, not on the collector. Chromium declares
  its OS synchronously via `navigator.userAgentData.platform` (~70% of usage) and the user-agent string
  covers the rest; doing it client-side costs the server nothing per report. UA reduction FROZE the
  tokens this relies on rather than removing them, so they are more stable now than they have ever
  been — at the cost of precision (Windows 11 reports as `10`, every recent macOS as `10.15.7`), which
  is a better failure than reporting no OS.
- **Built** as `packages/browser/src/user-agent.ts`: OS name from UA-CH where declared, OS version and
  browser identity always parsed, and an empty `type` for anything unrecognised — never a guess.
  Applied to `@bugsee/browser` AND `@bugsee/webworker`, which had the identical conflation and the same
  readable `navigator`.
- **`environment.browser` is now filled** — `{type, version}`, a block the appserver schema has declared
  for far longer than any JS SDK populated it, so **no backend change was needed**. `runtime.version`,
  which shipped empty on every web session, now carries the browser version.
- **Verified end to end** on staging (`SBROWSER-40`):

  ```yaml
  platform: { type: macos, version: 10.15.7 }
  browser:  { type: Chrome, version: 151.0.7922.34 }
  runtime:  { type: web,    version: 151.0.7922.34 }
  ```

- **The real run caught a bug the unit tests did not.** The first end-to-end attempt reported
  `browser: {type: Safari, version: ''}` — because the sweep's headless Chromium sends
  `HeadlessChrome/151…`, and `\bChrome/` matches nothing inside `HeadlessChrome` (no word boundary), so
  the trailing `Safari/537.36` claimed it. That is what every Playwright/Puppeteer/CI browser reports.
  Fixed, along with `CriOS`/`FxiOS` (Chrome and Firefox on iOS, which are WebKit and would otherwise all
  read as Safari). **A UA parser cannot be validated on a corpus its author chose** — the agents worth
  testing are the ones you did not think of.
- **Two of the parser's own tests were asserting protections that did not exist**, found by the mutator
  loop: "iOS before macOS" and "ChromeOS before Linux" both survived reordering, because an iOS UA's
  `like Mac OS X` carries no version (so the versioned macOS rule cannot match it) and a CrOS UA
  contains no `Linux` at all. Only Android-before-Linux is a genuine ordering hazard. Rewritten to pin
  what actually holds.

### F-X19 · Sample harness checks measured a clock, not the SDK — **fixed** (harness), and its premise was wrong

- **Severity:** was major. **Closed 2026-08-24.**
- **The recorded diagnosis was wrong.** This entry claimed `express-api` reported "21 of 50,
  reproducibly" and concluded the loss was "something in this sample's own wiring". Neither half
  survived measurement. Isolating the 50-concurrent block gives **50 of 50**; reproducing the full
  sweep gives 103 uploads, which decomposes exactly as 23 + 50 + 30 — the capture rate limiter's
  100-per-60s budget doing its job, not a leak. The original "21" was a drain snapshot read while
  uploads were still in flight.
- **What was actually wrong** was the harness, in two places, both now fixed:
  - `express-api/scripts/verify.ts` gave every route a flat 10 s client budget while asking S1.flush
    for a **15 s** flush, so a flush that was working still had to fail. The call now gets a budget
    that exceeds what it requests.
  - `react-spa/scripts/verify.mjs` asserted that a `/v2/issues` request appeared within a fixed
    1500 ms of a click. Replaced by two evidence-driven waits — `waitForCalls` (resolves the moment
    the evidence arrives, so the common case is faster than the sleep it replaced) and `waitForQuiet`
    (for upper-bound checks, which are only meaningful once an extra call would have had time to show
    up).
- **The four express-api checks this entry left failing now pass**, including
  `concurrency isolation: 50/50 bundles arrived, each with its OWN req_index`. Full sweep: **114/114**.
  The SDK-side credit belongs to `4381b86` (stop discarding a burst of incidents), `d15a777` (wait for
  an upload slot) and `f17baa8` (snapshot attributes at submit).
- **Lesson worth keeping:** a fixed evidence window fails in BOTH directions. It can miss a real report
  that a backlog delayed, and it can pass on a *neighbouring* scenario's late upload — which is exactly
  how it hid F-X21 below.

### F-X21 · `react-spa` relaunched onto a private carrier, silently disabling every carrier-resolved API — **fixed** (sample)

- **Severity:** was blocker for the React adapter's public surface, in this sample.
- **Found** by the F-X19 harness fix: once `react-report-error` waited for evidence instead of a clock,
  it failed honestly.
- **Cause:** `samples/react-spa/src/bugsee.ts` set `carrier = {}` before relaunching, commented "a fresh
  carrier bypasses the 'already launched' guard". The guard did not need bypassing — `stop()` clears the
  carrier's client slot **synchronously** (`packages/browser/src/launch.ts:569`) before it awaits the
  drain. The private object meant `globalThis.__BUGSEE__['0.1.0'].client` stayed `undefined` from the
  first relaunch onward, so every adapter API that resolves the client from the carrier by default —
  `reportReactError`, `createBugseeErrorHandlers`, `reportRouteError`, `BugseeErrorBoundary` — became a
  silent no-op for the rest of the session. Confirmed directly: the carrier read `hasClient: false`, and
  the two carrier-resolved controls produced **no network calls at all** while the sample's own
  `client.logException` worked.
- **Two checks were hiding it.** `react-report-error` passed on a neighbour's late upload inside its
  fixed window, and `react-root-handlers` was `record(..., true)` — an assertion that could not fail.
  Both now assert real wire evidence.
- **The SDK is not at fault**, but the sharp edge is real and worth noting: passing a custom `carrier`
  to `launch()` silently decouples every adapter helper that defaults to `globalThis`, with no
  diagnostic. Worth a doc note, or an `onError` warning, if a customer is ever expected to pass one.

### F-X10 · The collector's CORS policy made the browser SDK unusable for any customer — **fixed** (appserver) and **verified deployed**

- **Severity:** was blocker (backend, not this repo)
- **Fix:** appserver `c632f5a7`, `19099ecb`, `e4b94dfe`, `4db0e059` — an open, route-declared policy
  (`ACAO: *`, no `Allow-Credentials`, the SDK's headers allowed, `Max-Age: 86400`, CORP `cross-origin`)
  on exactly the three browser-origin ingest POSTs, written through one module (`code/cors.js`). The
  dashboard policy is untouched everywhere else.
- **Verified live on staging 2026-08-24**, by preflight from a third-party origin:

  | route | `access-control-allow-origin` |
  | --- | --- |
  | `POST /v2/sessions` | `*` |
  | `POST /v2/issues` | `*` |
  | `POST /v2/performance/transactions` | `*` |

  with `access-control-allow-headers` carrying `x-app-token`, `x-client-type` and `x-bugsee-internal`.
  The fourth hop needed no change and was re-confirmed too: `bugsee-upload-west2` answers a
  customer-origin `PUT` preflight with `ACAO: *`, `Allow-Methods: GET, HEAD, PUT`,
  `Allow-Headers: filename` — and the bundle PUT sends only `fileName` and `Content-Length`.
- **All three sample workarounds are gone**, which is the part no local test could stand in for:
  - `browser-vanilla` — `server/bugsee-proxy.ts` DELETED; the SDK now points at the real endpoint and
    the browser makes the genuine cross-origin call.
  - `react-spa` — `scripts/staging-workarounds.mjs` DELETED; stock Chromium, no flags.
  - `vue-spa` — `--disable-web-security` removed from `scripts/verify.mts`.
- **Re-verified end to end** against real staging with those workarounds removed: `browser-vanilla`
  48/48, `react-spa` 46/46, `vue-spa` 49/49, with new issues arriving on `SBROWSER`, `SREACT` and
  `SVUE`. `vue-spa`, whose every scenario was previously recorded as "BLOCKED", now reaches backend
  depth for the first time.

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
- **Package:** **backend/viewer** — the SDK side is confirmed correct (see "Next step" below: the
  uploaded bundle carries populated `logs.json`/`breadcrumbs`/`network.json`). Previously recorded as
  "unknown — not yet isolated to the SDK or the backend"; that attribution was superseded by this
  entry's own closure and is now corrected in place rather than only noted at the bottom.
- **Scenario:** S3/S6 — manual `log()` and `console.*` before an exception
- **Expected:** `get_issue` with `include_logs` shows the console lines, manual log lines and
  breadcrumbs captured in the session.
- **Observed:** the `# Logs` section is absent for every issue checked, on node and in the browser,
  even when the scenario provably logged first. Reproduced independently by `samples/browser-vanilla`
  (its F-6, 3× across session types) and on `SNODE-1` with `entries: "all"`.
- **Next step:** ~~unzip an uploaded bundle and check whether `log.json` is present and populated. That
  splits it cleanly into "the SDK did not send it" vs "the backend did not surface it".~~ **CLOSED by
  `samples/solid-spa` (round-3 review pass).** Both halves were measured there:
  - the SDK DOES send them — an intercepted S3 bundle PUT from `solid-spa` (a session with real
    `console.*`, `log()` and `addBreadcrumb()` activity before the throw) is an 11-entry zip carrying
    `logs.json` (816 B uncompressed / 219 B stored), `breadcrumbs` (208 B / 157 B) and `network.json`
    (1081 B / 425 B), alongside `request.json`, `manifest.json`, `apptoken`, `traces.system.json`,
    `events.system.json`, `events.user.json`, `viewtree.json` and `crash.json` — all present and
    populated. (Sizes are per-session, so exact byte counts vary run to run; presence and non-emptiness
    are the finding.) Entry names/sizes read from the zip central directory, no decompression needed;
  - MCP still shows nothing — `get_issue("SSOLID-76", include_logs: { entries: "all" })`, on an issue
    from a session with real console activity, returns **no `# Logs` section at all**.

  **Verdict: the backend/MCP does not surface them.** The package attribution above has been updated to
  backend/viewer accordingly. Samples must stop attributing their log-visibility
  gaps to "MCP has no per-call surface" and cite this finding instead (`samples/solid-spa/scenarios.md`
  S3 row is corrected accordingly).

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

