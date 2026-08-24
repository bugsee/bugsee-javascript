# Scenarios — samples/react-spa

Every scenario in `docs/samples/PLAN.md` §4, plus react-spa's own (§5.2 "Beyond the catalog"). Verified
against Bugsee staging app **`SREACT`** (`6a86d8e8990cb94c0b8e8ef8`).

**Read this first:** the "Backend (MCP)" verifications below were originally obtained with
`scripts/staging-workarounds.mjs`'s diagnostic-only bypasses installed, because four stacked defects
(CORS, a hardcoded client-type header, a session-response decode bug, and an S3 signature mismatch)
then rejected 100% of real-browser JS SDK traffic. All four are fixed and that script is **deleted**:
the 2026-08-24 re-verification ran the whole sweep on stock Chromium against staging, 46/46, with new
issues arriving on `SREACT`. The caveat that used to sit here — "verified means the SDK is correct,
not that it works unmodified against staging" — no longer applies.

Depth key (PLAN §4 "Verification depth"): **L** = local (no throw, app behaved) · **W** = wire (the
right request left the process, inspected via Playwright) · **B** = backend (confirmed via MCP
`list_issues`/`get_issue`).

## S1 — Launch & lifecycle

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `/scenarios` → "isLaunched()" | `true` after `launchApp()` | L | `verify.mjs`: `s1-is-launched` |
| "Flush" (`s1-flush`) | `flush(5000)` resolves `true`, drains queue | L/W | `verify.mjs`: `s1-flush` |
| "Call launch() again" (`s1-duplicate-launch`) | same client instance returned, not a 2nd launch | L | `verify.mjs`: `s1-duplicate-launch` → `same instance returned: true` |
| "Relaunch minimal" (`s1-relaunch-minimal`) | `launch(token, {})` — every option at its default | L/W | `verify.mjs`: relaunch succeeds locally; **backend**: the default `sdkVersion` (`0.0.0`, `packages/browser/src/launch.ts:79`) is rejected by staging with `UnsupportedSdkError` — this is expected/by-design staging behavior once F-2/F-3 are worked around, not itself a finding (an unversioned pre-publish SDK SHOULD be rejected) |
| "Relaunch full" (`s1-relaunch-full`) | every `BugseeLaunchOptions` field set (see `src/bugsee.ts` `FULL_LAUNCH_OPTIONS`) | L/B | issue `SREACT-1` etc. arrive correctly afterward |

## S2 — Identity & attributes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| Settings → display name → "Save" | `setUserIdentifier` | B | wire capture: issue body `"email":"mcp-check-user@bugsee.dev"` after setting it (see `FINDINGS.md`'s investigation trail — confirmed correct once verified via CLIENT-SIDE nav, not a full `page.goto` reload) |
| Settings → "Clear" | `clearUserIdentifier` / `getUserIdentifier() -> null` | L | manual check |
| Settings → attributes (string/number/boolean/string[]) | `setAttribute`/`getAttribute`/`clearAttribute`/`clearAllAttributes`/`getAllAttributes` | L | `verify.mjs`: `s2-attributes` — DOM dump shows all 4 types incl. `"tags":["alpha","beta","gamma"]` |
| — | attributes travel in the bundle manifest (`context.attributes`, `bundle-assembler.ts:185-189`), NOT the `/v2/issues` metadata call — confirmed by code read, **not independently visible via `get_issue`** (no attributes section in its output) | L (code) | documented gap, not re-recorded in `FINDINGS.md` per PLAN §6.6 (per-sample note only) |

## S3 — Manual telemetry

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `log()` × 5 levels (error/warning/info/debug/verbose) | one log line per level | L/W | `verify.mjs`: `s3-log` |
| `event()` with/without params | `card_created`/`scenario_panel_opened` | L | `verify.mjs`: `s3-event` |
| `trace(name, value)` | trace entry | L | `verify.mjs`: `s3-trace` |
| `addBreadcrumb()` — every field | type/category/message/level/data | L | `verify.mjs`: `s3-breadcrumb` |
| — | logs are visible via `get_issue({include_logs})` — not individually re-checked per level here (would need a triggering report each time); the mechanism is proven by S8's log-redaction check below, which DOES read logs back via MCP | B | see S8 |

## S4 — Exceptions

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException(new Error)` | issue, correct message + stack | B | `SREACT-1` — full `get_issue` output matches: message `S4: logException(new Error(...))`, stack resolves to `ScenarioPage.tsx:539` |
| non-Error: string/object/null | 3 separate issues, all reported (not dropped) | W/B | `verify.mjs`: `s4-string`/`s4-object`/`s4-null` all produced an `/v2/issues` call; `SREACT-9` (`Error at at onClick`) confirmed via `list_issues` |
| nested `cause` chain | `Caused by:` chain in the description | B | `get_issue` supports a `Cause:` section (confirmed via `SREACT-13`/`SREACT-23`'s `linkComponentStack` case, which uses the same mechanism) |
| `LogExceptionOptions` (mechanism/severity/labels) | labels present | W | wire capture of the `/v2/issues` POST body: `"labels":["scenario-panel","s4-options"]`, `"source":{"mechanism":"programmatic"}`, `"severity":3` |
| same instance twice (dedupe) | 1 issue call, not 2 | W | `verify.mjs`: `s4-dedupe` → `1 issue calls` |
| storm: 200 in ~1s | rate-limited (few requests), app stays responsive | W/B | `verify.mjs`: `s4-storm` → `3 issue calls (of 200 attempted)`; **see `FINDINGS.md` F-8**: one of the resulting issues (`SREACT-2`) shows `"Crash data for the issue was not found"` on `get_issue` — an anomaly, not confirmed root-caused |
| — | cross-session dedup | B | `SREACT-10` events_count grew 2→4→32 across separate `verify.mjs` runs (separate SDK sessions) — same signature, one issue |

## S5 — Crashes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| uncaught exception (`window.onerror`) | `Type: Crash`, correct message/stack | B | `SREACT-8`: `Type: Crash`, message `S5: uncaught exception outside any try/catch or React boundary`, stack `ScenarioPage.tsx:818` |
| unhandled promise rejection | `Type: Crash` | W/B | `verify.mjs`: `s5-rejection` produced an issue call; not independently `get_issue`'d beyond the uncaught case above (same detection path, `detectCrashes: true`) |
| `exitOnUncaught`/`unhandledRejections` modes | N/A — Node-only options, not in `BugseeLaunchOptions` (browser) | N/A | browser has no process-exit window; see `@bugsee/node`'s `node-service` sample instead |

## S6 — Console capture

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `console.log/info/warn/error/debug/trace` | one log line each | L/W | `verify.mjs`: `s6-console` (6 methods) |
| multi-arg call, object, circular object | captured without throwing | L | `verify.mjs`: `s6-circular` — no page error from the circular-reference `console.log` call |
| — | app-behaviour check ("interceptors don't alter app behaviour") | L | every `console.*` call in the app continued to print to the real console (visible via Playwright's own `console` event listener throughout the sweep) — capture is additive, not a replacement |

## S7 — Network capture

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| fetch GET / POST JSON / POST text | captured, body readable by the app | L/W | `verify.mjs`: `s7-get`/`s7-post-json`/`s7-post-text` — each control's status line shows the ACTUAL response body the app read (e.g. `POST JSON -> {"received":{"hello":"world","n":42}}`), proving the interceptor didn't alter the response |
| 4xx / 5xx | captured with status | L/W | `verify.mjs`: `s7-4xx`/`s7-5xx` — status lines show 404/500 |
| connection failure | app catches it, no crash | L | `verify.mjs`: `s7-connfail` — a real `fetch` to a closed port, caught in the handler |
| body over `maxNetworkBodySize` (2048, set in `FULL_LAUNCH_OPTIONS`) | captured copy truncated; APP still reads the FULL body | L | `verify.mjs`: `s7-large-body` status line reports the full 64 KB read client-side, unaffected |
| response with no `Content-Type` | captured via `captureNetworkBodyWithoutType: true` | L | `verify.mjs`: `s7-no-content-type` |
| XHR | captured (different code path from fetch) | L | `verify.mjs`: `s7-xhr` |
| WebSocket | captured; real bidirectional traffic (board activity feed) | L | app itself uses this for real (`ActivityFeed.tsx`); `verify.mjs`'s app-smoke section exercises card create/move, which broadcasts over the same socket |
| SSE (`EventSource`) | captured | L | `verify.mjs`: `s7-sse` — 5 real server-sent events read |
| — | network entries are **not** visible via `get_issue` (documented MCP-surface gap, PLAN §6.6) — all of the above is L/W only, never B | — | — |

## S8 — Filters & redaction

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `setNetworkEventFilter` — drop a header + redact a body field | the filter fires, header/field redacted in the CAPTURED copy | L | `verify.mjs`: `s8-network` — the in-app filter log records `droppedSecretHeader=true redactedSsn=true`. **Not verified at Backend depth** — network entries aren't in `get_issue` (same S7 gap) |
| `setNetworkEventFilter` — veto | request dropped from capture entirely | L | in-app filter log records `network: VETOED …/scenario/get?veto-me=1` |
| `setLogEventFilter` | secret redacted from the log line | L | in-app filter log: `log: redacted "leaking SECRET_TOKEN=abc123 in a log line"` |
| `setBreadcrumbFilter` | secret redacted from breadcrumb data | L | in-app filter log: `breadcrumb: redacted data.secret` |
| `setReportHandler` `before` — mutate | report proceeds, label added | B | issue `SREACT-24`: `get_issue` confirms the issue arrived with message `S8: report handler should mutate this`; the ADDED label (`redacted-before`) is not independently visible via `get_issue` (no labels section — see S4's `LogExceptionOptions` row, verified at WIRE depth instead) |
| `setReportHandler` `before` — veto | **no issue created** | B | `s8-report-veto` clicked in every `verify.mjs` run; no `SREACT` issue with the message `S8: report handler should VETO this` ever appeared across 4 sweep runs + manual checks — confirmed absent |

## S9 — Performance / APM

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| page-load transaction | automatic (`performanceMonitoring: true` default via the umbrella) | L | every page navigation in the app exercises this; not independently visible via MCP (performance transactions aren't in `get_issue`'s surface — documented gap) |
| navigation transactions | `traceNavigations: true` | L | every SPA nav in `verify.mjs`'s app-smoke section |
| `http.client` spans for outbound calls | automatic | L | every `fetch`/XHR call in S7 |
| manual `client.ext('performance').startTransaction()` + child spans + every `SpanStatus` | 6 child spans (`OK`/`ERROR`/`TIMEOUT`/`CANCELLED`/`DEADLINE_EXCEEDED`/`UNKNOWN`), transaction finishes `OK` | L | `verify.mjs`: `s9-manual-transaction` — no throw; see `FINDINGS.md` F-9 for a TypeScript-only gap around `ext('performance')`'s type |
| `setRouteName` (direct call) | renames the active transaction | L | `verify.mjs`: `s9-set-route-name` |
| `performanceSampleRate` 0 and 1 | N/A — not independently exercised (would need a 2nd relaunch pair; `FULL_LAUNCH_OPTIONS` uses `performanceSampleRate: 1`) | N/A | out of scope for this pass |

## S10 — Distributed tracing

| — | — | — | — |
| --- | --- | --- | --- |
| N/A | react-spa has no server counterpart of its own, and no other sample was confirmed reachable during this build (the wave-1 samples are built by separate, concurrent agents). `propagateTrace`/`tracePropagationTargets` are set in `FULL_LAUNCH_OPTIONS`; the local API server has an `/api/scenario/echo-headers` endpoint that would let a `traceparent` header be confirmed locally, but no two-hop join was attempted. |

## S11 — Session replay

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `replay: true` (defaults) | fail-closed masking (maskAllText/maskAllInputs/blockAllMedia) | L | `verify.mjs`: `s11-replay-defaults` — clean relaunch, no console errors (this ALSO exercises `FINDINGS.md` F-7's `@bugsee/replay`/`@bugsee/replay-canvas`/`@bugsee/rrweb` publishConfig defect — see the workaround note there) |
| explicit masking (`maskTextSelector`/`blockSelector`/`ignoreSelector`/`blockAllCanvas`) | applied | L | `verify.mjs`: `s11-replay-masking` |
| `.bugsee-show` opt-out | the `#s11-shown` field opts out of masking | L | present in the DOM (`src/routes/ScenarioPage.tsx`'s S11 section); not independently screenshotted |
| canvas recording, fixed fps | `replay.canvas: { fps: 2 }` | L | `verify.mjs`: `s11-replay-canvas-fixed` |
| canvas recording, `fps: 'all'` | every draw call | L | `verify.mjs`: `s11-replay-canvas-all` |
| — | replay CONTENT is not visible via `get_issue` (documented gap, PLAN §6.6) — every row above is Local only. No replay-spanning-a-navigation check was attempted (time-boxed out). | — | — |

## S12 — Persistence & recovery

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException` then immediate hard-reload (`s12-crash-and-reload`) | `persist`/`recover` (both on in `FULL_LAUNCH_OPTIONS`) re-upload the exception from IndexedDB on the next launch | W | `verify.mjs` triggers this as its last step; the recovered report is one of the `SREACT` issues from each sweep run (message `S12: persist+recover across a hard reload`) — present in `list_issues`, not individually re-`get_issue`'d per run |
| bundle queued while offline | N/A — not attempted (would need to simulate offline mid-upload, out of scope for this pass) | N/A | — |
| two-tab coexistence | N/A — not attempted | N/A | — |

## S13 — OpenTelemetry

| — | — | — | — |
| --- | --- | --- | --- |
| N/A | `@bugsee/opentelemetry` is wired on-by-default via the `@bugsee/bugsee` umbrella `launch()` (confirmed by code read — `packages/bugsee/src/launch.ts` calls `wireUmbrella`), but neither `otelExportUrl` (produce) nor `onOtelSpanProcessor` (consume) was exercised — no local OTel collector was stood up for this sample. `browser-vanilla`/`node-service` are the PLAN-designated OTel-focused samples. |

## S14 — Platform specifics

N/A — no react-spa-specific platform item beyond what's in the catalog above.

## React-specific (§5.2 "Beyond the catalog")

| Item | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `BugseeErrorBoundary` / `withBugseeErrorBoundary` — LOCAL boundary around a throwing component | catches, reports, custom fallback renders | L | `verify.mjs`: `react-error-boundary-hoc` — `guarded-widget-fallback` renders |
| `BugseeErrorBoundary` wrapping the WHOLE app (outside `<RouterProvider>`) — unguarded route-level throw | **GAP** — see `FINDINGS.md` F-5: react-router's own boundary intercepts first, nothing is reported | W/B | `verify.mjs`: `react-error-boundary-global-GAP` — confirmed every run: react-router's own fallback shown, app's `BugseeErrorBoundary` fallback never shown |
| `createBugseeErrorHandlers` wired into `createRoot({onUncaughtError, onCaughtError})` | React 19 seam; on React 18 (this sample's pinned version, `^18.3.1`) `createRoot` ignores unknown option keys, so this is INERT at the React level — the handlers themselves work when called directly | L | `verify.mjs`: `react-root-handlers` calls `handlers.onUncaughtError(...)` directly and confirms it doesn't throw; not exercised via an actual React-19 uncaught error (would need upgrading the sample off React 18) |
| `BugseeProfiler` / `withBugseeProfiler` | render spans on a deliberately slow list | L | `verify.mjs`: `react-profiler-slow-list` — `SlowList` (300 CPU-burning items) mounts inside `<BugseeProfiler>`; per the package's own doc, this only records in a `react-dom/profiling` build (not aliased here) or via the component's post-commit fallback path, which DOES fire unconditionally |
| `recordReactRenderSpan` (direct) | manual span with a measured duration | L | `verify.mjs`: `react-record-render-span` |
| `reportReactError` (direct) | issue reported, componentStack linked | B | issue confirmed arriving (`react-report-error` in `verify.mjs`); message `React: reportReactError called directly` |
| `linkComponentStack` (direct) + `logException` | `error.cause` chain includes the linked frame | B | `SREACT-13`/`SREACT-23`: `get_issue` shows a `Cause:` section — `at ManuallyLinked (scenario-panel)` |
| `instrumentReactRouter` (wired globally in `router.tsx`, self-subscribing on the data router) | active transaction named by route PATTERN, not URL | L | every navigation in `verify.mjs` (`/board/board-1`, etc.) goes through this; transaction NAMES aren't visible via MCP (S9 gap) |
| `instrumentRouterMatches` + `routePatternFromMatches` (direct, manual-router style) | `/board/:id/card/:cardId` from a synthetic matches array | L | `verify.mjs`: `react-route-pattern` → `routePatternFromMatches(...) -> "/board/:id/card/:cardId"` (exact match asserted) |
| `setRouteName` | see S9 | L | `verify.mjs`: `s9-set-route-name` |
| `@bugsee/babel-plugin-component-annotate` | `data-bugsee-component` on every host JSX element, in BOTH dev and production builds | L | confirmed 14 annotated elements on `/boards` in the production build (`RootLayout` first); see `FINDINGS.md` "Also confirmed working" |
| `@bugsee/vite-plugin` — production build, debug-IDs, source-map upload, backend resolution | minified stack resolves to original TSX + line number | B | issue `SREACT-25`: `onClick () (../../src/routes/ScenarioPage.tsx:296)` — matches the exact source line. **Required the `BUGSEE_CLI_PATH` workaround** — see `FINDINGS.md` F-6. |
