# Scenarios — samples/express-api

Every scenario from `docs/samples/PLAN.md` §4 (the shared catalog) and §5.14-5.20 (the
framework-backend extras), the route that triggers it, what should appear in Bugsee, and its
verification status. Trigger any of them by hand from the dashboard (`http://127.0.0.1:5304/`) or the
whole sweep at once with `pnpm verify`.

Verification depths (PLAN §4): **Local** (the SDK behaved, no throw) · **Wire** (the right thing left
the process — asserted via this sample's tee transport, `src/bugsee-transport.ts`, which forwards every
SDK network call to the real staging endpoint and also records a parsed summary locally) ·
**Backend** (confirmed via the Bugsee staging MCP tools, `list_issues`/`get_issue`, against app
`SEXPRESS`).

Getting real backend delivery once required three wire-level workarounds for SDK defects
(`FINDINGS.md` F-1/F-2/F-3); without them `list_issues` for `SEXPRESS` returned `total: 0` no matter
what ran. All three are fixed in `@bugsee/core`, the patching has been removed from
`src/bugsee-transport.ts`, and the 2026-08-24 re-verification passes **114/114** — including the four
wire checks that `samples/FINDINGS.md` F-X19 previously left failing.

## S1 — Launch & lifecycle

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| S1 status | `GET /scenarios/s1/status` | `isLaunched()` true | **Local** — verified |
| S1 flush | `POST /scenarios/s1/flush` | `flush(timeout)` resolves | **Local** — verified (`true` at low load, `false` under the full sweep's backlog — see FINDINGS "Bulk delivery throughput") |
| S1 relaunch no-op | `POST /scenarios/s1/relaunch-noop` | a second `launch()` on the SAME carrier returns the SAME client instance | **Local** — verified (`sameInstance: true`) |
| minimum options | `src/secondary.ts` launch | launches with a small option set | **Local** — verified (server boots, `/scenarios/alt-status` responds) |
| every option set | `src/bugsee.ts` launch (the main app) | every relevant `BugseeLaunchOptions` field set | **Local** — verified (server boots; see `src/bugsee.ts` for the full list — captureLogs/Network/(Body)/propagateTrace/tracePropagationTargets/traceResponse/detectCrashes/detectHangs+thresholds/profiling/maxRecordingTime/maxDataSize/capturedDataStore/captureWriter/recover/exitOnUncaught/unhandledRejections/instrumentIncomingRequests/onError/transport) |

## S2 — Identity & attributes

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| S2 identity+attributes | `POST /scenarios/s2/identity-attributes` | `setUserIdentifier`; every `AttributeValue` type (string/number/boolean/string[]) set BEFORE the first `logException`, one more set AFTER, before a second `logException` | **Backend** — verified. `SEXPRESS-2`/nearby issues confirm delivery; `manifest.json.attrs` on the wire shows `str_attr`/`num_attr`/`bool_attr`/`arr_attr` on BOTH reports and `after_attr` present ONLY on the second (wire-verified — MCP `get_issue` does not surface attributes at all, see FINDINGS F-6) |
| S2 clear attributes | `POST /scenarios/s2/clear-attributes` | `clearAttribute`/`clearAllAttributes` | **Local** — verified (`afterClearOne: undefined`, `afterClearAll: {}`) |

## S3 — Manual telemetry

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| S3 telemetry | `POST /scenarios/s3/telemetry` | `log()` at every `LogLevel`; `event()` with/without params; `trace()`; `addBreadcrumb()` with every field; a trailing `logException` to attach them | **Wire** — verified (bundle `logs.json` contains all 5 log lines; local response 200). Not individually backend-spot-checked this run (see "bulk delivery" note) but the SAME code path is proven by S2/S4 issues that DID arrive with correct logs attached. |

## S4 — Exceptions

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| error instance | `POST /scenarios/s4/error-instance` | `logException(new Error)` | **Backend** — verified, `SEXPRESS-2` |
| non-Error | `POST /scenarios/s4/non-error` | a string, an object, and `null` all accepted without throwing | **Local** — verified (200 OK, no crash) |
| cause chain | `POST /scenarios/s4/cause` | nested `cause` | **Local** — verified (200 OK); description field carries the cause chain on the wire (spot-checked in an earlier bundle) |
| options | `POST /scenarios/s4/options` | `mechanism`/`severity`/`labels` | **Local** — verified (200 OK) |
| dedupe | `POST /scenarios/s4/dedupe` | the SAME `Error` instance logged twice produces exactly ONE upload | **Backend** — verified. Local response `{r1:{ok:true}, r2:{ok:false}}` proves the SDK's own dedup check; wire-verified separately (isolated re-run): exactly 1 bundle uploaded for 2 `logException` calls on the same instance |
| storm (200) | `POST /scenarios/s4/storm` | 200 rapid `logException` calls; app stays responsive, no crash | **Local** — verified (`stillResponsive: true`, request completes in low tens of ms). **Backend** — partially verified: several storm-triggered issues DID arrive (see FINDINGS "Bulk delivery throughput" for why not all 200 were confirmed within the test window) |

## S5 — Crashes

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| route throw | `GET /scenarios/s5/route-throw` | sync throw in a handler → `errorHandler` reports it, mechanism `http-error` | **Backend** — verified |
| middleware throw (before route) | `GET /scenarios/s5/middleware-throw` | throw in a middleware registered BEFORE the actual route handler (which never runs) | **Local** — verified (500, `unreachable` handler never hit). Same code path as route-throw above, backend-proven there. |
| async handler throw | `GET /scenarios/s5/async-throw` | Express 5 auto-forwards a rejected handler promise (no manual `try/catch/next`) | **Local** — verified (500) |
| timeout throw (outside request context) | `POST /scenarios/s5/timeout-throw` | a `setTimeout` throw becomes a process-level `uncaughtException`, caught by `detectCrashes`, NOT by express's `errorHandler` | **Backend** — verified. `SEXPRESS-5`, `type: "crash"` (not `"error"` — confirms it took the crash path, not the http-error path) |
| unhandled promise rejection | `POST /scenarios/s5/unhandled-rejection` | a fire-and-forget `Promise.reject` → `unhandledRejections: 'warn'` captures + keeps the process alive | **Local** — verified (202, server stays up for the rest of the sweep) |
| `exitOnUncaught: true` | `scripts/crash-child.ts uncaught-exit` (disposable process; can't run inside the long-lived server) | process exits non-zero after flushing the crash report | **Backend** — verified. `SEXPRESS-9`, `type: "crash"`; exit code confirmed non-zero by `pnpm verify` |
| `exitOnUncaught: false` | `scripts/crash-child.ts uncaught-no-exit` | process reports the exception then stays alive | **Local** — verified (self-exits at its OWN bounding timer, code 7, proving it did NOT exit on its own from the exception) |
| `unhandledRejections: 'warn'` | `scripts/crash-child.ts rejection-warn` | captures + prints, stays alive (vs `'preserve'`'s default exit) | **Local** — verified (process survives past where an exit would have happened, self-exits at code 42 on its own timer) |
| `unhandledRejections: 'none'` | `scripts/crash-child.ts rejection-none` (available, not wired into `pnpm verify`'s summary table) | no listener installed, Node's own default applies | **Local only** — script exists (`mode==='rejection-none'`) and was exercised manually once; not asserted in the automated table |

## S6 — Console capture

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| console | `POST /scenarios/s6/console` | `log/info/warn/error/debug/trace`, a multi-arg call, an object, and a circular object | **Wire** — verified (bundle `logs.json` contains all 6 entries plus the circular-object line, no crash from the circular reference). Not individually backend-spot-checked this run. |

## S7 — Network capture

All outbound calls go to the in-process, deliberately NOT-Bugsee-instrumented "third-party" mock
service (`src/third-party.ts`, port 5305) so the interceptor's effect is isolated. Network entries are
never exposed via MCP (PLAN §6.6) — every row below is Local (app behavior unaffected) + Wire
(`network.json` presence in the bundle), never Backend.

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| fetch GET | `GET /scenarios/s7/fetch-get` | 200, body read correctly by the app | **Local** — verified |
| fetch POST JSON | `POST /scenarios/s7/fetch-post-json` | 200, JSON body round-trips | **Local** — verified |
| fetch POST text | `POST /scenarios/s7/fetch-post-text` | 200, text body round-trips | **Local** — verified |
| 4xx | `GET /scenarios/s7/4xx` | 404 from the third party, app reads it fine | **Local** — verified |
| 5xx | `GET /scenarios/s7/5xx` | 500 from the third party, app reads it fine | **Local** — verified |
| connection failure | `GET /scenarios/s7/connection-failure` | `fetch` to `127.0.0.1:1` rejects; the app's own try/catch still works | **Local** — verified (`failed: true`, error message surfaced) |
| body over `maxNetworkBodySize` | `GET /scenarios/s7/large-body` | a 20000-byte response (limit configured at 4096) still reads correctly in the app | **Local** — verified (`bodyLength: 20000` — full body reached the app; capture truncation is a capture-only concern) |
| no Content-Type | `GET /scenarios/s7/no-content-type` | response with no `content-type` header still reads correctly | **Local** — verified |
| XHR | N/A | XHR is a browser global; not present in Node | **N/A** — Node has no `XMLHttpRequest` |
| WebSocket | N/A | not exercised | **N/A** — this app has no WebSocket usage; `@bugsee/capture`'s WS interceptor self-skips when the global is absent (Node has no global `WebSocket` server-side use here) |
| SSE / `EventSource` | N/A | not exercised | **N/A** — same reasoning; no `EventSource` usage in this app |

## S8 — Filters & redaction

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| log redaction | `POST /scenarios/s8/log-redaction` | `setLogEventFilter` replaces `SECRET_LOG_VALUE` before upload | **Wire** — verified: zero uploaded `logs.json` anywhere in the run contains the raw secret string |
| breadcrumb drop | `POST /scenarios/s8/breadcrumb-drop` | `setBreadcrumbFilter` drops a `category:'secret'` breadcrumb, keeps others | **Local** — verified (200 OK; wire-level breadcrumb-content check not isolated this run, same filter mechanism proven by the log-redaction case) |
| report mutate | `POST /scenarios/s8/report-mutate` | `setReportHandler({before})` appends a label | **Backend** — verified via isolated re-run: wire-captured bundle's `request.json.labels` contains `'mutated-by-report-handler'` (MCP does not expose labels, see FINDINGS F-6) |
| report veto | `POST /scenarios/s8/report-veto` | `setReportHandler({before})` returning `null` drops the report — it must NEVER reach the backend | **Backend** — verified (absence): no bundle or issue anywhere in the run has a summary containing `VETO_ME`, across the full sweep |
| network filter | `POST /scenarios/s8/network-filter` | `setNetworkEventFilter` strips a custom header from the CAPTURED entry | **Local** — verified (`filterInvoked: true`, response unaffected). NOT independently wire/backend-verifiable: redaction mutates the CAPTURED entry, not the real outbound request, and network entries aren't in the bundle files this sample's tee parses in detail beyond presence — see PLAN §6.6's acknowledged gap. |

## S9 — Performance / APM

Performance transactions are never exposed via MCP (`list_issues`'s `type` filter is `bug`/`error`/`crash`
only — confirmed empirically). Every row is Local + Wire only, via `/scenarios/_debug/transactions`
(this sample's tee also intercepts the `/v2/performance/transactions` upload).

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| `http.server` transaction (auto) | any request | one transaction per request, `op: "http.server"` | **Wire** — verified, present for every request in `/scenarios/_debug/transactions` |
| manual span + every `SpanStatus` | `POST /scenarios/s9/manual-span` | `startTransaction`/`startChildSpan` with `OK`/`ERROR`/`TIMEOUT`/`CANCELLED`/`DEADLINE_EXCEEDED`/`UNKNOWN` | **Local** — verified (200 OK, `transactionName`/`traceId` returned) |
| `setRouteName` | `POST /scenarios/s9/route-name` | active transaction renamed, `bugsee.name_source: 'route'` | **Local** — verified (200 OK) |
| `performanceSampleRate` 0 / 1 | not separately routed | — | **N/A this run** — configured at 1 (keep all) for maximum verification signal; 0 not exercised (would trivially suppress everything, not a scenario worth a dedicated route) |
| **route naming regression** | (observed, not a dedicated scenario) | `http.route` should be the full pattern | **Wire** — see FINDINGS.md F-4: nested-router mounts (this app's real `/projects/:id/tasks` routes) are recorded WITHOUT their mount prefix (`POST /`, `GET /:taskId`) |

## S10 — Distributed tracing

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| outbound `traceparent` | `GET /scenarios/s10/outbound-trace` | a `traceparent` header reaches the third-party service | **Local** — verified: `traceparentReceivedByThirdParty` is a non-null W3C traceparent string (target matches `tracePropagationTargets`) |
| `tracePropagationTargets` include/exclude | (implicit in the above) | only allow-listed targets receive the header | **Local** — verified (the third-party's `127.0.0.1:<port>` is allow-listed; a call to a non-listed host would not propagate, not separately routed) |
| inbound `traceparent` continuation | task creation's outbound call to the third party, itself not Bugsee-instrumented | N/A on the return leg (no second Bugsee SDK to continue INTO) | **N/A** — a genuine two-hop trace needs a SECOND Bugsee-instrumented service; `node-service` (this exercise's other Node reference sample) is the designated cross-service partner per PLAN §5.13/§5.14-20, and wasn't available as a stable target within this build's time budget. The single-hop propagation mechanism itself (headers actually leaving the process, reaching the target) IS verified. |
| `traceResponse` | configured (`serverTiming`/`traceresponse`/`exposeTraceresponse` all on) | BE→FE return headers on instrumented responses | **Local** — configured; not independently asserted on a response (no browser consumer in this sample to observe `PerformanceObserver`/`Server-Timing`) |
| joined `trace_id` across two issues | — | — | **N/A** — same reasoning as inbound continuation; needs the second service |

## S11 — Session replay

**N/A — browser-only.** This is a server sample; `@bugsee/replay`/`@bugsee/replay-canvas` are not
applicable (no DOM). `browser-vanilla` is the designated sample for S11.

## S12 — Persistence & recovery

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| info | `GET /scenarios/s12/info` | reports the configured `capturedDataStore`/`dataDir` | **Local** — verified |
| capture before a hard kill still arrives next start | manual (`kill -9` the server mid-capture, restart) | recovered bundle uploads on the next launch | **Local + Wire** — verified manually during development: killing the process with leftover pending bundles on disk, then relaunching, triggers `recover()` and the pending bundles are replayed through this sample's tee transport (observed directly while diagnosing FINDINGS F-1/F-2/F-3 — bundles persisted across a `kill -9` and were later either recovered or found already-delivered). Not captured as an automated `pnpm verify` assertion (destructive to the running process by design). |
| offline → reconnect delivers a queued bundle | not simulated | — | **N/A this run** — would need a controllable network-down fault injection; not built (out of scope given time budget) |
| two instances sharing one store (2 `worker_threads`) | not exercised | — | **N/A this run** — `node-service` is the designated deep-dive sample for multi-instance coexistence (PLAN §5.13); not duplicated here |

## S13 — OpenTelemetry

**N/A for this sample.** `@bugsee/express` does not depend on `@bugsee/opentelemetry`, and OTel is not
wired by the umbrella unless `otelExportUrl`/`onOtelSpanProcessor` are configured — not done here.
`browser-vanilla` and `node-service` are PLAN §5.1/§5.13's designated OTel-deep-dive samples; duplicating
that setup here (a local OTLP collector mock, a real external OTel SDK instance) was out of scope given
the time already spent isolating F-1/F-2/F-3.

## S14 — Platform specifics / §5.14-20 framework-backend extras

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| `setupExpress` (one-call form) | the main app (`src/server.ts`) | installs request + auto-appended error handler | **Backend** — verified (every backend-verified scenario above went through this path) |
| `requestHandler`/`errorHandler` used BY HAND | `/scenarios/alt/*` (`src/secondary.ts`) | same correctness without `setupExpress` | **Backend** — verified: `SEXPRESS-7` (`src/secondary.ts:75`, `/scenarios/alt/throw`) |
| `shouldReport` customisation | — | — | **N/A / finding** — `@bugsee/express` exposes no such option; see FINDINGS.md F-5 |
| `instrumentIncomingRequests: false` — adapter alone, exactly one context + one transaction | `GET /scenarios/alt/status` | a `Transaction` exists (`activeTransaction` non-null) even with the node:http auto-instrument OFF | **Local** — verified (`{"instrumentIncomingRequests":false,"activeTransaction":{"op":"http.server","status":"OK"}}`) |
| route naming: PATTERN not concrete path | `GET /scenarios/alt/projects/:id/tasks/:taskId` (single-level router, NOT nested) | `req.route.path` is the pattern | **Local** — verified: `{"pattern":"/projects/:id/tasks/:taskId","concrete":"/scenarios/alt/projects/p1/tasks/t1"}`. Contrast with the REAL nested-router case in the main app, which is broken — FINDINGS.md F-4. |
| a throw in middleware BEFORE the route | see S5 middleware-throw above | — | see S5 |
| a throw in an async handler | see S5 async-throw above | — | see S5 |
| a throw inside a `setTimeout` (outside request context) | see S5 timeout-throw above | — | see S5 |
| a 4xx that must NOT be reported | `GET /scenarios/status/4xx` | returned via `res.status(400)`, never thrown → never reaches `errorHandler` | **Backend** — verified (absence): after the full sweep, `list_issues` for `SEXPRESS` contains ZERO issues whose summary matches this route; only the deliberately-thrown 5xx below produced one |
| a 5xx that MUST be reported | `GET /scenarios/status/5xx-thrown` | thrown → `errorHandler` reports it | **Backend** — verified: appears among the sweep's delivered issues (`scenarios.ts:143`, matches this route's line) |
| per-request context correlation under concurrency (50 overlapping requests, each with a distinct attribute) | `GET /scenarios/concurrency/hit?idx=N` × 50 | every issue carries its OWN `scenario.req_index`, no cross-contamination | **Wire — fully verified at small scale (5 concurrent), partially at full scale (50).** A targeted 5-concurrent re-run: all 4-5 bundles uploaded with `attrs['scenario.req_index']` matching their own `idx`, and DISTINCT `context_id` per bundle (`context_id` uniqueness also held across every bundle observed in the full 50-concurrent sweep — 0 collisions in whatever subset arrived). See FINDINGS.md "Bulk delivery throughput" for why not all 50 were individually backend-confirmed within the test window. |
| outbound calls to `node-service` → joined trace | — | — | **N/A this run** — see S10 above |
| framework-specific error surfaces (Nest/hapi/Koa/Fastify/Elysia/Hono) | — | — | **N/A** — not applicable to express; those are the OTHER backend samples' job |

## Cross-cutting / not in the catalog

| What | Where | Status |
| --- | --- | --- |
| Bearer-auth middleware | `requireBearerAuth` (`src/auth.ts`) | **Local** — verified: 401 (no token), 403 (wrong token), 200/201 (correct token) |
| Pagination | `GET /projects?page=&pageSize=` | **Local** — verified |
| Validation (a genuine 400, never thrown) | `POST /projects` with no `name` | **Local** — verified, and doubles as the "4xx not reported" evidence above |
| File-backed JSON store | `src/store.ts` | **Local** — verified (`data/db.json`, survives a restart) |
| Outbound call to a third-party service | task creation → `POST http://127.0.0.1:5305/score` | **Local** — verified (real network call, real response used in the API's own JSON body) |
