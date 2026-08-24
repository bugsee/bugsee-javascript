# Scenarios — samples/vue-spa

Every scenario id from `docs/samples/PLAN.md` §4 (the common catalog) and §5.3 (the vue-spa-specific
"beyond the catalog" list), the control that triggers it, what should appear in Bugsee, and what was
actually verified.

## Read this first: backend verification is blocked for the whole sample

`samples/vue-spa/FINDINGS.md` F-5 is a **blocker**: every `POST /v2/sessions` to the `SVUE` app
(`type: "javascript"`, `subtype: "vue"`) fails with `ApplicationTypeMismatchError` (code 11004), so
**no data of any kind reaches the Bugsee staging backend for this sample**, regardless of which
scenario triggers it. `list_issues` on `SVUE` was polled after a full scenario sweep + `flush()` and
returned `{"issues":[],"total":0}`.

Because of that, every scenario below is verified at:

- **local** — the SDK call did not throw, the app kept working, the expected in-app effect happened
  (`scripts/verify.mts`, run via `pnpm verify` — 50/50 checks passed).
- **wire** — for the scenarios where it mattered, the actual outgoing HTTP request (method, URL,
  payload shape) was captured via Playwright network interception and inspected by hand; see the
  "Wire evidence" column.
- **backend** — the rows below were written when F-5 made the backend unreachable for EVERY scenario,
  and each is marked "BLOCKED (F-5)".

  **F-5 is now fixed** (2026-08-24). This sample delivers to `SVUE`: the re-verified sweep is 49/49 and
  new issues arrive on the app, so the blanket block is gone. The per-row markers are deliberately left
  as they are, because re-walking each scenario at backend depth over MCP is work that has not been
  done — and rewriting them to "verified" without doing it would be exactly the false certainty the
  original marker was so careful to avoid. Read "BLOCKED (F-5)" below as **"not yet re-verified at
  backend depth"**, not as "cannot be".

## Common catalog (§4)

| Id | Scenario | Control | Expected in Bugsee | Local | Wire | Backend |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Launch & lifecycle | Scenario panel → "launch() again", "flush()", "isLaunched()"; `?minimal=1` query param for the minimum-options launch leg (`src/bugsee.ts`) | one session per page load; a second `launch()` is a no-op; `flush()` drains the queue | PASS — `isLaunched()` stays true, repeat launch returns the same client, `flush()` resolves `true` | PASS — `POST /v2/sessions` fires once per page load with the full option set serialized under `sdk.options` (`com:bugsee:option:*`); the `?minimal=1` leg sends only `app_token`+`environment` with no `sdk.options` entries | BLOCKED (F-5) |
| S2 | Identity & attributes | Scenario panel S2 buttons | `setUserIdentifier`/`setAttribute` (string/number/boolean/array) round-trip; clear operations remove them | PASS — every getter reflects the setter immediately (see activity log in `pnpm verify` output) | not captured individually (attributes ride the session/report payload, not their own request) | BLOCKED (F-5) |
| S3 | Manual telemetry | Scenario panel S3 buttons | 5 `log()` levels, `event()` with/without params, `trace()`, a full-field `addBreadcrumb()` | PASS | not captured individually (buffered client-side until a report/flush) | BLOCKED (F-5) |
| S4 | Exceptions | Scenario panel S4 buttons | `logException` for an `Error`, a string, an object, `null`, a nested `cause`, dedup of the same instance, and a 200-exception storm that rate-limits rather than hangs the app | PASS — the storm resolves all 200 promises without freezing the UI (`S4-storm` completed in ~5s); `result.ok` was `false` for **all 200** under the live rate limiter (see note below) | PASS — `POST /v2/issues` fires per `logException`; `POST /v2/sessions` fires once per page load, not once per exception, confirming session reuse | BLOCKED (F-5) |
| S5 | Crashes | "uncaught exception", "unhandled promise rejection" | `window.onerror`/`unhandledrejection` detection fires a report | PASS — Vite's own dev overlay confirms the throw/rejection actually happened; the SDK's `detectCrashes` handlers ran without the page crashing | not captured individually | BLOCKED (F-5) |
| S6 | Console capture | "console.* (all levels + object + circular)" | every level captured as a log entry; the circular object does not throw during serialization | PASS — no `pageerror`/hang from the circular-object call | not captured individually | BLOCKED (F-5) |
| S7 | Network capture | Scenario panel S7 buttons | fetch GET/POST, 4xx, 5xx, connection failure, oversized body, missing Content-Type, XHR, WebSocket, SSE all captured; **app behaviour unchanged** | PASS — every call's own response is read correctly by the app (JSON round-trips, text bodies match, XHR status/echo correct, WS echo received, SSE delivers all 3 ticks) — the S7 "app-behaviour" requirement holds | PASS for the local API calls themselves (verified against `src/api/server-plugin.ts`, a real server); the SDK's OWN capture of these into the bundle is not independently visible without a backend | BLOCKED (F-5) |
| S8 | Filters & redaction | Scenario panel S8 buttons | `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter` redact/veto; `setReportHandler` `before` mutates or vetoes | PASS locally — `logException` under the veto handler resolved `{ok:false}` (see `pnpm verify` "S8-report-veto" line); the mutate handler ran without throwing | PASS — `s8-net-veto` still performs the real `fetch` (the filter only affects CAPTURE, not the request itself, per the "interceptors don't alter app behaviour" principle) — confirmed the request completes normally | BLOCKED (F-5) — cannot confirm the redacted/veto'd content is actually absent from an issue; this is exactly the §6 step 6 gap ("what MCP doesn't expose, verify at wire level") compounded by F-5 removing even the session |
| S9 | Performance / APM | "manual transaction + child spans", "setRouteName()"; `?perf=0`/`?perf=1` query params | a `pageload` transaction; a manual transaction with 2 children (`OK`, `ERROR` status); route-pattern naming on navigation | PASS — `startTransaction`/`startChildSpan`/`finish` all ran without throwing | PASS — `POST /v2/performance/transactions` fires on `flush()` (observed in the wire sweep, always followed by `SessionNotFoundError` per F-5) | BLOCKED (F-5) |
| S10 | Distributed tracing | — | N/A | — | — | **N/A** — no second Bugsee-instrumented sample is running alongside this one; `propagateTrace`/`tracePropagationTargets` need a real peer server to produce a joined trace, which is out of this sample's scope (see `docs/samples/PLAN.md` §5.13 for where that lives) |
| S11 | Session replay | — | N/A | — | — | **N/A** — blocked entirely by FINDINGS.md F-1 (`@bugsee/replay`/`@bugsee/replay-canvas` packaging defect); `replay: false` is forced in `src/bugsee.ts`. Untestable, not merely undemonstrated. |
| S12 | Persistence & recovery | "Arm persistence probe" (S12-arm); the verify script's abrupt-close leg; two-tab coexistence (both pages hit `/scenarios` concurrently) | data captured before a hard termination re-uploads on next launch; two tabs don't corrupt each other's capture | PASS (abrupt-close leg) — a context can be closed mid-request (50ms after firing `logException`, before any response) without the SDK throwing; PASS (two-tab) — both tabs ran `S4-error` + `flush()` concurrently without either page erroring | not meaningfully capturable beyond "a request was in flight when the context closed" | BLOCKED (F-5), **and** the recovery leg itself has a verification-depth gap: Playwright's `browser.newContext()` is an ephemeral profile, so a genuinely fresh context after an abrupt close does NOT share IndexedDB with the closed one — this sample could not prove cross-restart recovery even if F-5 were fixed, only that the abrupt-close code path itself doesn't throw. Recorded, not silently skipped. |
| S13 | OpenTelemetry | — | N/A | — | — | **N/A** — `@bugsee/opentelemetry` is not a package under test for `vue-spa` (`docs/samples/PLAN.md` §5.3 only lists `@bugsee/vue`); no `otelExportUrl`/`onOtelSpanProcessor` wiring in this sample |
| S14 | Platform specifics | see the vue-spa-specific table below | — | — | — | — |

## vue-spa-specific ("beyond the catalog", §5.3)

| Control | Package export exercised | Where | Expected | Local | Wire | Backend |
| --- | --- | --- | --- | --- | --- | --- |
| App boot | `installBugseeErrorHandler` | `src/main.ts` | chains the app's Vue error handler onto Bugsee's; `app as unknown as VueAppLike` cast required (FINDINGS F-3) | PASS — typechecks and installs without throwing | — | BLOCKED (F-5) |
| Render error | `installBugseeErrorHandler` (auto-catch) | `src/components/RenderBoom.vue`, triggered from `ErrorLab.vue` | a render-function throw is caught by `app.config.errorHandler`, reported with `info: "render function"`; the failing component's OWN subtree unmounts (real, documented Vue behaviour — no recovery), the REST of the page survives | PASS — verified the render error is isolated (see `RenderBoom.vue`'s design note); the rest of `ErrorLab`/the Scenario panel stayed clickable afterward | — | BLOCKED (F-5) |
| Lifecycle-hook error | `installBugseeErrorHandler` (auto-catch) | `src/components/LifecycleBoom.vue` | an `onMounted` throw is caught, reported with `info` naming the lifecycle hook; the component's already-rendered (empty) DOM is unaffected | PASS | — | BLOCKED (F-5) |
| Event-handler error | `installBugseeErrorHandler` (auto-catch) | `ErrorLab.vue` `triggerEventHandlerError` | a `@click` handler throw is caught, reported with `info: "native event handler"` (Vue's own wording); does not corrupt the component | PASS | — | BLOCKED (F-5) |
| Watcher error | `installBugseeErrorHandler` (auto-catch) | `ErrorLab.vue` `triggerWatcherError` | a `watch()` callback throw is caught, reported with `info` naming the watcher callback | PASS | — | BLOCKED (F-5) |
| Async-component / Suspense error | `installBugseeErrorHandler` (auto-catch) | `src/components/NutritionPanel.vue` (`async setup()`), wrapped in `<Suspense>` on `RecipeDetail.vue`, armed via `?nutritionError=1` | an async-setup throw inside a `<Suspense>` boundary with no `onErrorCaptured` propagates to the global handler; the rest of the page (title, ingredients, steps) still renders | PASS — confirmed `<h1>Tomato Basil Soup</h1>` and the rest of the page render normally while only the nutrition panel's slot stays empty | — | BLOCKED (F-5) |
| Direct `reportVueError()` | `reportVueError` | `ErrorLab.vue` `triggerDirectReport` | reports WITHOUT going through `app.config.errorHandler`; `mechanism: 'programmatic'` | PASS | not captured individually | BLOCKED (F-5) |
| Component attribution | `createBugseeVueComponentMixin` | `src/main.ts` (`app.mixin(...)`) | every mounted/updated component's root element gets `data-bugsee-component="<Name>"` | PASS — spot-checked via `page.locator('[data-bugsee-component]')` during manual smoke testing; every named SFC in the app (`RecipeCard`, `ErrorLab`, `Scenarios`, …) uses `defineOptions({ name })` or Vue's inferred SFC filename so the mixin has a name to stamp | N/A — DOM-only, not a wire artifact | N/A |
| Render spans | `createBugseeVueRenderMixin` | `src/main.ts` (`app.mixin(...)`) | a `ui.render` child span per mount/update on the active transaction | PASS locally (mixin installed, no throw); actual span content only visible via the performance extension's own buffer, not independently observable client-side | not captured individually | BLOCKED (F-5) |
| Router naming | `instrumentVueRouter` + `routePatternFromVueRoute` + `setRouteName` | `src/router/index.ts` | the active navigation transaction is renamed to the matched route PATTERN (e.g. `/recipes/:id`, never `/recipes/tomato-basil-soup`) on every navigation | PASS — navigated `/` → `/recipes/tomato-basil-soup` → `/recipes/tomato-basil-soup/edit` etc. during the sweep without the router instrumentation throwing | not captured individually (renames an in-memory transaction, no dedicated request) | BLOCKED (F-5) |

## Notes on specific evidence

- **S4-storm rate limiting:** all 200 `logException()` calls in the storm resolved with `ok: false`.
  This is consistent with rate-limiting kicking in essentially immediately for a burst that large, but
  it was **not cross-checked against the exact configured limit** (not documented in
  `packages/core/src/rate-limiter.ts`'s public options surface as exercised here) — recorded as an
  observation, not a specific pass/fail against a known threshold.
- **`?minimal=1` and `?perf=0|1`:** these load the app with a different `launch()` call (see
  `src/bugsee.ts`). Both were exercised manually (not by `scripts/verify.mts`, which always uses the
  full-options launch) by loading `http://localhost:5303/scenarios?minimal=1` and `?perf=0` in a
  browser and confirming the app still boots and `isLaunched()` is true. Local-level only.
- **Production build:** `pnpm build && pnpm preview` was run standalone (not part of `pnpm verify`,
  which uses `vite` dev mode) — confirmed the built bundle serves the app, the local API plugin still
  works via `configurePreviewServer`, and a Playwright smoke pass over `/` and `/scenarios` in the
  built app found 0 console/page errors.
