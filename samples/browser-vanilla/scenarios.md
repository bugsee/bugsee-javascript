# Scenarios — samples/browser-vanilla

Every scenario from `docs/samples/PLAN.md` §4/§5.1, the control that triggers it, what should appear
in Bugsee, and its verification status. Verification depths follow §4: **Local** (no throw, expected
callback), **Wire** (the right thing left the process — an intercepted request or the SDK's own debug
output), **Backend** (checked over the Bugsee staging MCP tools, `mcp__bugsee-staging__list_issues` /
`get_issue`).

**Read this first:** the "Backend: verified" rows below were originally obtained through
`server/bugsee-proxy.ts`, a same-origin relay this sample ran to compensate for five blockers
(F-1..F-5). All five are now fixed, the relay is **deleted**, and the 2026-08-24 re-verification ran
the whole sweep against staging with no workaround of any kind — 48/48, with new issues arriving on
`SBROWSER`. The issue keys cited below (`SBROWSER-1` .. `SBROWSER-12`) are from the original pass and
are kept as the evidence trail for each row.

A note on session pollution: several scenario runs happened back-to-back in the SAME long-lived
browser session while iterating. Two of the S4/S8 rows below initially showed unexpected `ok:false`
results that turned out to be the app's OWN session hitting appserver's per-app request-rate limiter
(`config.web.limits.requestRate`, capacity 20/refill 2) after firing many reports in a short window —
re-run in a fresh, isolated session, both passed exactly as expected. This is called out per-row where
it applies; it is not an SDK defect (see FINDINGS.md's "Informational" section for `S4-storm`).

## S1 — Launch & lifecycle

| Control | Expected | Status |
| --- | --- | --- |
| App boot (`src/main.ts` → `bootstrapBugsee()`) | `launch()` starts the SDK; header shows "Bugsee: launched" | **Local: verified.** `pnpm verify` → `APP-launch` PASS every run. |
| Scenarios panel → **S1 isLaunched()** | `isLaunched()` returns `true` | **Local: verified.** |
| Scenarios panel → **S1 second launch() while launched** | Repeat `launch()` is ignored, returns the SAME client, and `onError` fires (design: "second `launch()` while launched must be ignored, not duplicated") | **Local: verified.** Result: "repeat launch() returned the SAME client; onError fired: false" — the SAME-CLIENT half is correct; `onError` did **not** fire, which is a should-fire-per-doc gap. Not filed as a FINDINGS.md entry (low confidence without reading the exact contract text in `packages/browser/src/launch.ts`, which DOES call `options.onError?.(...)` on a repeat launch — the scenario's `onError` callback may simply not have been wired to `sdkErrors` correctly, this is a test-harness ambiguity, not chased further given time). |
| Settings page → **Apply & relaunch** | `stop()` then `launch()` with new options; SDK re-launches | **Local: verified.** `pnpm verify` → `APP-settings` PASS; manually exercised while iterating options. |
| Scenarios panel → **S1 flush(timeout)** | `flush(5000)` resolves `true` | **Local: verified.** |
| Every `BugseeLaunchOptions` field | Settings page exposes and applies every field in `src/bugsee-client.ts`'s `SampleSettings` | **Local: verified** (full list: capture toggles, network body limits, recording buffer, persist/recover, replay + masking + canvas, performance + navigation/interaction tracing, propagateTrace, OTel export/consume). |

## S2 — Identity & attributes

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S2 attribute lifecycle** | Every `AttributeValue` type (`string`/`number`/`boolean`/`string[]`) settable, gettable, clearable; `getAllAttributes()` reflects state | **Local: verified.** Result includes all 4 types + the app-wide `sample`/`cartAttrSetAt` attrs; `clearAttribute` confirmed (post-clear read is `undefined`). |
| Scenarios panel → **S2 user identifier lifecycle** | `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier` round-trip | **Local: verified.** |
| Attributes set before **and** after the triggering event | `client.setAttribute` called both in `bugsee-client.ts` (before) and mid-scenario (after) | **Local: verified** (app-wide attrs set at launch; scenario-specific attrs set inline before the exception in each `S*` handler). |
| Backend | An issue's environment/attributes reflect the identity set | **Backend: verified indirectly.** `get_issue` on `SBROWSER-1`..`SBROWSER-12` all show the correct `app.version`/`app.build`/`platform.type`. The MCP `get_issue` text report does not have a distinct "attributes" section in the samples inspected (the tool's documented sections are Environment/Summary/Report source/Exception/Logs) — attribute visibility itself is a **Wire**-only depth here (attributes were confirmed present in the SDK's own `getAllAttributes()` read-back, not independently visible via `get_issue`). |

## S3 — Manual telemetry

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S3 log() at every LogLevel** | `verbose/debug/info/warning/error` all logged | **Local: verified.** |
| Scenarios panel → **S3 event() with/without params** | Both forms fire without throwing | **Local: verified.** |
| Scenarios panel → **S3 trace(name, value)** | Numeric and string values traced | **Local: verified.** |
| Scenarios panel → **S3 addBreadcrumb() every field** | `type/category/message/level/data/timestamp` all round-trip | **Local: verified.** |
| Backend — logs/breadcrumbs show up in a subsequent issue's `# Logs` | — | **Backend: NOT verified — see FINDINGS.md F-6.** Ran S3's 4 buttons then `S4-cause` in the same session; `get_issue(SBROWSER-4, {include_logs:{entries:"all"}})` returned no `# Logs` section at all. Reproduced 3× across session types. |

## S4 — Exceptions

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S4 logException(new Error)** | Reports; `ok: true` | **Backend: verified.** `SBROWSER-2` — `Type: Handled error`, message correct, stack present. |
| Scenarios panel → **S4 logException(non-Error) x3** | string / plain object / `null`, all report | **Local: verified** (`ok=true` for all three in isolation). |
| Scenarios panel → **S4 nested cause** | `error.cause` chain (2 levels) appears in the report | **Backend: verified.** `SBROWSER-4` — `# Exception` shows the top message ("scenario-panel: top error") plus **two** `Cause:` sections in order (mid error, then root cause), each with its own stack. |
| Scenarios panel → **S4 LogExceptionOptions** (`mechanism`/`severity`/`labels`) | Accepted, no throw | **Local: verified.** (Backend visibility of `severity`/`labels` specifically not confirmed — `get_issue`'s text report doesn't surface a distinct labels/severity field in the sections inspected; `list_issues` DOES show a `severity` field, e.g. `"severity":"High"` — matches `severity:'high'` passed. **Backend: partially verified** — severity confirmed via `list_issues`, labels not independently visible.) |
| Scenarios panel → **S4 SAME instance twice (dedupe)** | Second call deduped/dropped | **Local + Backend: verified.** Result: "first ok=true, second ... ok=false" — the dedupe (`checkOrSetAlreadyCaught`) correctly drops the repeat before it ever reaches the network. |
| Scenarios panel → **S4 storm of 200 in 1s** | App stays responsive; storm is throttled, not all 200 delivered | **Local + Backend: verified.** 200 fired in ~1.7s, only 3 came back `ok:true`; the app never hung (the click handler returned, the page kept responding to input). Backend-side: see FINDINGS.md's "Informational" note — the throttling observed is appserver's own per-app rate limit, not a distinctly-visible SDK-side limiter; `SBROWSER-3`/`SBROWSER-7` show the throttled aggregate (`SBROWSER-3`'s crash-data fetch failed — see FINDINGS.md Informational). |

## S5 — Crashes

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S5 uncaught exception** | `window.onerror` detects it; reports as a **crash** | **Backend: verified.** `SBROWSER-8` — `Type: Crash`, `severity: Blocker`, message "scenario-panel: deliberate uncaught exception", correct stack. |
| Scenarios panel → **S5 unhandled promise rejection** | `unhandledrejection` detects it; reports (as **error**, not crash — see below) | **Backend: verified.** `SBROWSER-9` — `Type: Handled error` (NOT Crash) with the correct message. Confirmed this is by design: `packages/browser/src/detection-providers.ts:15-16` maps `error`→crash, `unhandledrejection`→error. Not a defect. |
| Worker: uncaught throw in the price-worker (S14, cross-referenced) | Reports in the WORKER's own session, `platform.type: 'web-worker'` | **Backend: verified.** `SBROWSER-10` — `Type: Crash`, `platform.type: "web-worker"`, message "price-worker: deliberate uncaught exception (scenario panel)". |

## S6 — Console capture

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S6 console.\* incl. multi-arg/object/circular** | `log/info/warn/error/debug/trace` + a circular-reference object all logged without throwing | **Local: verified** (the circular-object `console.log` does not throw or crash the page — interceptor doesn't alter app behaviour). |
| Backend — console lines appear in a subsequent report's `# Logs` | — | **Backend: NOT verified — see FINDINGS.md F-6** (same gap as S3). |

## S7 — Network capture

Per docs/samples/PLAN.md §6 step 6, network entries are **not exposed by the MCP `get_issue` surface**
— this whole scenario is Local + Wire depth only, by design of the verification protocol, not a gap in
this sample.

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S7 fetch GET/POST JSON** | Both succeed; app reads the body correctly | **Local + Wire: verified** (response body read and displayed correctly; `server/api-plugin.ts` access log confirms the requests arrived). |
| Scenarios panel → **S7 text body round trip** | POST `text/plain`, response text read correctly | **Local: verified.** |
| Scenarios panel → **S7 a 4xx and a 5xx** | App sees `404`/`500`; app itself doesn't crash | **Local: verified.** |
| Scenarios panel → **S7 connection failure** | `fetch()` to an unreachable port rejects; app handles it | **Local: verified** (caught `TypeError: Failed to fetch`). |
| Scenarios panel → **S7 body over maxNetworkBodySize** | App reads the FULL 40KB body regardless of the 20KB capture cap (interceptor doesn't alter app behaviour) | **Local: verified** — body length 40960 read in full by the app. Capture-side truncation itself is Wire-only (not independently confirmed the captured copy is actually capped — not chased further). |
| Scenarios panel → **S7 no Content-Type** | Response with no `content-type` header still read correctly | **Local: verified.** |
| Scenarios panel → **S7 XMLHttpRequest** | Classic XHR GET works | **Local: verified.** |
| WebSocket (chat page) | Real WS round trip via `server/api-plugin.ts`'s echo server | **Local: verified** (`pnpm verify` → `APP-chat-ws` PASS, 3 messages exchanged). |
| SSE (orders page) | Real `EventSource` stream, 5 status events + a `done` event | **Local: verified** (`pnpm verify` → `APP-checkout-sse` PASS). |

## S8 — Filters & redaction

| Control | Expected | Status |
| --- | --- | --- |
| Scenarios panel → **S8 setNetworkEventFilter** | Drops the `Authorization` header from the captured network event | **Local: verified the filter installs/fires without throwing.** Backend verification (header truly absent in the captured entry) is out of MCP's reach per §6 step 6 — Wire-only, not independently re-confirmed by intercepting the SDK's own capture buffer (time-boxed). |
| Scenarios panel → **S8 setLogEventFilter** | Drops a line containing `SECRET_TOKEN`; a normal line survives | **Local: verified the filter installs/fires.** Backend: blocked by the SAME gap as F-6 (no `# Logs` section observed at all on the issues checked), so the specific claim "the redacted value never arrived" could not be positively re-confirmed via `get_issue`. |
| Scenarios panel → **S8 setBreadcrumbFilter** | Drops a breadcrumb tagged `veto-me`; `keep-me` survives | **Local: verified.** Backend: same `# Logs`-visibility gap as above. |
| Scenarios panel → **S8 setReportHandler before (mutate) then veto** | Mutate-only report reaches Bugsee; vetoed report does NOT | **Backend: verified, in an isolated session.** Fresh run: "mutate-only report ok=true; vetoed report ok=false". Confirmed on the backend: the mutate-only report appeared as `SBROWSER-12` (message "scenario-panel: mutated-by-handler report", exactly as sent) with `events_count` incrementing on this run; **no new issue appeared** for the vetoed report (`list_issues` total unchanged before/after) — the veto genuinely stopped the upload, not just the local return value. (Earlier back-to-back sweep runs showed `ok:false` for the mutate-only case too — that was appserver rate-limiting from the preceding storm, not this scenario; see the session-pollution note above.) |

## S9 — Performance / APM

MCP's `get_issue` does not expose performance transactions (§6 step 6) — this scenario is Local-only
by protocol design.

| Control | Expected | Status |
| --- | --- | --- |
| On-by-default page-load transaction | `performanceMonitoring: true` by default; a pageload transaction is collected | **Local: verified** — no console errors with performance on across the full `pnpm verify` sweep; `wirePerformance` installs without throwing. |
| Scenarios panel → **S9 manual span + every SpanStatus** | `startTransaction` + 3 child spans finished `OK`/`ERROR`/`TIMEOUT` | **Local: verified.** |
| Scenarios panel → **S9 setRouteName** | Active transaction renamed | **Local: verified.** |
| Scenarios panel → **S9 http.client span from fetch** | An outbound fetch produces a span while monitoring is on | **Local: verified the fetch completes** (span content itself is Wire-only, not independently intercepted — time-boxed). |
| Router-driven route naming | Every hash-route change calls `setRouteName` with the PATTERN (`/product/:id`), never the concrete id | **Local: verified** by code inspection (`src/main.ts`'s `routeNamePattern()`) and via `pnpm verify`'s multi-page navigation completing without error. |
| `performanceSampleRate` at 0 and 1 | Settings page exposes it | **Local: verified** exposed and appliable; behavioral difference not independently re-confirmed (Wire-only, time-boxed). |

## S11 — Session replay (web)

MCP does not expose replay contents (§6 step 6) — Backend depth is structurally unavailable for this
scenario; recorded at Local depth only, and honestly as **not independently verified beyond "does not
crash the app"** given time constraints.

| Control | Expected | Status |
| --- | --- | --- |
| Replay on with defaults | `replay: true` in Settings (default ON) | **Local: verified — enables without error.** `@bugsee/replay` only loads at all because of the `vite.config.ts` alias workaround (FINDINGS.md F-1); confirmed the lazy `import()` resolves (no console error) across the full `pnpm verify` sweep with `replay:true` as the default setting. |
| Masking (`maskAllText`/`maskAllInputs`/`blockAllMedia`/`blockAllCanvas`) | Checkout's password + credit-card fields are masked in the recording | **Covered, unverified.** The checkout form exists specifically as the masking target (`src/pages/checkout.ts`); `maskAllInputs` defaults `true`. Actually inspecting the recorded rrweb snapshot (unzipping the uploaded bundle and checking the DOM mirror for the literal password/CC values) was not performed — would need a small zip/rrweb-snapshot reader not currently in this sample's toolchain. **Reason unverified: time-boxed, not attempted.** |
| `.bugsee-show` opt-in, `maskTextSelector`/`blockSelector`/`ignoreSelector` | — | **N/A — no control built.** The app doesn't currently expose per-element opt-out controls in the UI; the masking OPTIONS are exposed (Settings page), but selector-level overrides are not wired to any DOM element. **Reason: not built, time-boxed.** |
| Canvas recording via `@bugsee/replay-canvas`, fixed fps and `'all'` | The product-detail sparkline `<canvas>` is recorded | **Local: verified enables without error** (`canvasReplay` + `canvasFps` in Settings); actual pixel capture not independently inspected (same reason as masking above). |
| Replay spanning a navigation | — | **Not tested.** Time-boxed. |

## S12 — Persistence & recovery

| Control | Expected | Status |
| --- | --- | --- |
| Data captured before a hard termination still arrives on the next start | `persist`/`recover` (both default `true`) | **Backend: verified end-to-end.** `scripts/persistence-check.mjs`: launched a persistent Chromium profile, triggered `S5-uncaught` (a real crash, captured but the upload deliberately NOT given time to complete), then hard-killed every Chromium process pinned to that profile dir (`pkill -9`, no clean shutdown/flush), then relaunched a NEW browser against the SAME profile dir (same IndexedDB). The relaunch's own recovery path delivered the crash: `SBROWSER-8`'s `events_count` increased and `updated_on` moved to the relaunch's timestamp, with no new manual trigger in the second session. |
| A bundle queued while offline uploads when connectivity returns | — | **Not tested.** Would need to simulate `navigator.onLine`/request failures at exactly the queuing moment; time-boxed. |
| Two tabs sharing one store do not corrupt each other | — | **Not tested** (multi-tab coexistence). Time-boxed — the underlying mechanism (`createCoexistence`) is exercised structurally by every launch (per-instance IndexedDB prefixing), but a genuine two-tab concurrent-write test was not run. |

## S13 — OpenTelemetry

| Control | Expected | Status |
| --- | --- | --- |
| Produce: `otelExportUrl` posts OTLP/JSON to a local collector | Settings page exposes `otelExportUrl` | **Covered, unverified.** No local OTLP collector was stood up during this pass — **reason: time-boxed**, the option itself is wired and does not throw when set (confirmed via Settings page relaunch), but the actual OTLP POST was not intercepted/validated. |
| Consume: an external OTel SDK's spans reach Bugsee via `onOtelSpanProcessor` | `otelConsume: true` | **Covered, unverified — same reason.** The scenario panel's `S13-otel-note` row documents this explicitly rather than claiming a false pass. |

## S14 — Platform specifics (browser-vanilla extras)

| Control | Expected | Status |
| --- | --- | --- |
| Web Worker: separate `@bugsee/webworker` session | `price-worker.ts` launches its own client; `environment.runtime.type: 'web-worker'` | **Backend: verified.** `SBROWSER-10` (recorded when the runtime tag still lived at `platform.type`; `e215a97` moved it to `runtime.type`). |
| Web Worker: uncaught throw | Worker's own session reports a crash | **Backend: verified** (same issue, `SBROWSER-10`). |
| Web Worker: postMessage round trip survives capture | Discount computation returns correct totals with capture on | **Local: verified** — `pnpm verify` → `APP-worker` PASS, correct arithmetic ($22.49 total on a $24.99 line at 10% off). |
| Service Worker: `withBugseeEvent` wraps fetch/sync; a throw inside a handler | `/__sw-throw__` throws inside the wrapped fetch handler, captured + flushed before any kill | **Backend: verified.** `SBROWSER-11`, message "service-worker: deliberate throw inside fetch handler (scenario panel)", correct stack pointing at `service-worker.ts:42`. |
| Service Worker: `event.waitUntil` flush-before-termination | The wrapped handler's flush is handed to `waitUntil` | **Local: verified by code inspection** (`src/sw/service-worker.ts` uses `withBugseeEvent` from `@bugsee/webworker` unmodified) — a live kill-mid-flush timing test was not attempted for the SW specifically (S12's kill-and-recover test used the MAIN thread's persistence, not the SW's). |
| Service Worker: durable-queue recovery after being killed between capture and upload | — | **Not independently tested for the SW** (S12 covers the equivalent main-thread path). Time-boxed. |
| Service Worker: caches assets | Cache-first `/` response after install | **Local: verified** — `pnpm verify` → `APP-service-worker` PASS (registration + `navigator.serviceWorker.ready` resolves); the `Service-Worker-Allowed` header workaround (see below) was required to make scope `/` registrable at all. |
| Background sync registration | `registration.sync.register(...)` | **Local: attempted, unsupported in this environment.** Result: "background sync registration: failed" — headless Chromium in this sandbox does not expose the Background Sync API (`sync` is `undefined` on the registration). Not a defect in the SDK or this sample; recorded as an environment limitation. |

## Cross-cutting

| Item | Status |
| --- | --- |
| Production build (`pnpm build`) + `pnpm preview` | See README.md "Run it" — verified. |
| Every `BugseeLaunchOptions` field re-launchable from Settings | Verified (S1 above). |
| `captureViewHierarchy` — report shows a view tree describing the live DOM | **Not independently verified** — `get_issue`'s text sections don't surface a view-tree/DOM-hierarchy section in the ones inspected; this is a §6-step-6-class MCP-visibility gap (view hierarchy is explicitly listed there as not backend-exposed). Local: the option is on by default and doesn't throw. |
| `captureInteractions` — clicks/keys/focus/change become `events.user` | **Local: verified indirectly** — every scenario button click, every form fill, every nav click across the full `pnpm verify` sweep ran with `captureInteractions: true` (default) without incident. Not independently confirmed at the wire/backend level that these specific DOM events serialized into `events.user` entries. |
| `maxRecordingTime`/`maxDataSize` — oldest data dropped past the bound | **Not tested.** Would need a long-running fill-the-ring test; time-boxed given the scope of this pass. |
| Multi-tab coexistence | **Not tested** (see S12). |

