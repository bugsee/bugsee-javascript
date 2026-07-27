# Adversarial review — @bugsee/web-adapter

**Reviewed:** 2026-07-27 · **Scope:** packages/web-adapter (impl 141 LOC over 3 files: `index.ts` 22, `adapter.ts` 69, `render-span.ts` 49; tests 245 LOC over 2 files, 20 tests, all green)

**What this package actually is:** the prior is **mostly right but too broad in one respect and too narrow in another**.

- CORRECT: it is the shared foundation under exactly five frontend adapters (`react`, `vue`, `angular`, `svelte`, `solid` — each declares `"@bugsee/web-adapter": "workspace:*"`, e.g. `packages/react/package.json:28`). Nothing else in the monorepo depends on it.
- **REFUTED — it does NOT participate in navigation detection at all.** There is zero `history`/`pushState`/`replaceState`/`currententrychange` reference anywhere in `packages/web-adapter/src`. All history monkey-patching + Navigation-API listening lives in `@bugsee/browser` (`packages/browser/src/navigation-source.ts:160-196`). Mandate item 3 is therefore almost entirely N/A here; what this package owns is only the *naming* of an already-open transaction.
- **REFUTED — it has NO module-level mutable state, no install/uninstall, no listeners, no observers, no spans it owns.** Every export is a pure pass-through function taking an injectable `getClient`. So the whole HMR / double-import / two-React-roots / mount-unmount-leak class of hazard (mandate item 1) is *structurally* absent rather than merely untested. That is a genuinely good design property and I could not break it.
- BROADER THAN THE PRIOR: it is not just "D1 plumbing". It owns two things with real blast radius: (a) the **only error-reporting entry point** all five adapters use from inside host framework lifecycles, and (b) the **only render-span recorder** (`recordRenderSpan`) that four of the five adapters funnel through — so the span op/attribute vocabulary and the span-volume policy for the whole frontend fleet are decided here.
- Note for the record: there is a *second*, sibling shared kit — **`@bugsee/adapter-kit`** — serving the five SSR meta-framework adapters, with a near-duplicate error reporter (`reportServerError`). The two kits' contracts have diverged; see SEV1.1 and SEV3.4.

**Verdict:** Small, clean, side-effect-free, SSR-import-safe (verified by running it in a bare Node process), and structurally immune to the state-leak class of defects. But it fails the one rule that matters most for a package that is called from inside `componentDidCatch`, `app.config.errorHandler`, `ErrorHandler.handleError` and `handleError`: **it provides no error containment whatsoever**. I proved empirically that all three entry points propagate a throw straight into the host framework's lifecycle, that the throw is reachable through the *real* core `logException` path (an app-installed `Error.prepareStackTrace` hook is enough), and that its own sibling kit `@bugsee/adapter-kit` guards the identical operation with an explicit "never throws" contract — so this is a divergence, not an unknown. Secondary: the render-span recorder passes framework timestamps through unclamped (adapter spans provably start 4.5 s *before* their parent under the known pageload-anchoring defect), imposes no span-volume cap (20 000 render spans landed on one transaction in a real controller, while the sibling resource-span path caps at 100), and `setRouteName` renames *whatever* transaction is active with no operation guard (proven renaming a `ui.interaction` transaction to `/users/:id`). Tests are honest for what they cover but are pure unit-with-mock: no test crosses the web-adapter↔performance package boundary, no SSR test, and two guard branches survive deletion undetected.

---

## SEV1

### 1. Zero error containment: a throw from the SDK propagates into React's commit phase, and skips the app's own error handler in three adapters

- **Where:** `packages/web-adapter/src/adapter.ts:54-61` (`reportError`), `packages/web-adapter/src/adapter.ts:65-69` (`setRouteName`), `packages/web-adapter/src/render-span.ts:33-49` (`recordRenderSpan`)
- **What:** none of the three entry points wraps its call into the client. `reportError` calls `void client.logException(...)` bare (`adapter.ts:57`); `setRouteName` calls `tryGetPerf(client)?.setRouteName(name)` where the `try/catch` in `tryGetPerf` (`adapter.ts:36-42`) covers **only** the `client.ext('performance')` lookup, not the subsequent method call; `recordRenderSpan` calls `getActiveSpan()` and `active.recordChildSpan(...)` (`render-span.ts:34`, `render-span.ts:37`) entirely outside any guard.
- **Why it matters:** these functions are invoked from host framework lifecycle callbacks, and in three adapters they run **before** the application's own handler, so a throw both re-enters the framework and silently suppresses the customer's error handling:
  - `packages/react/src/error-boundary.ts:46-53` — `componentDidCatch` calls `reportReactError` at line 48, then `this.props.onError?.(...)` at line 53. React treats a throw inside `componentDidCatch` as a commit-phase error: it is re-thrown to the next boundary above, and with no boundary above it **unmounts the customer's entire root**. This is the exact failure the binding rule ("interceptors must not alter app behavior") exists to prevent.
  - `packages/vue/src/error.ts:45-48` — reports at line 46, then calls the app's pre-existing `errorHandler` at line 47. A throw at 46 means the app's handler never runs.
  - `packages/angular/src/error.ts:47-50` — reports at 48, delegates (default `ErrorHandler` console logging) at 49. Same suppression.
  - `packages/svelte/src/error.ts:43-50` — reports at 45, then `return appHandler?.(input)` at 49. A throw escapes SvelteKit's `handleError` hook entirely.
  - `packages/solid/src/error.ts:29` — the handler wired into `<ErrorBoundary fallback>` / `catchError`.
  - `recordRenderSpan` is called from `packages/react/src/profiler.ts:81` (React's `onRender`, i.e. the commit phase), `packages/angular/src/render-tracker.ts:50` (`ngAfterViewInit`), `packages/svelte/src/render-span.ts:33` (`onMount`). Only `packages/vue/src/render-mixin.ts:56-67` wraps it in a `try/catch` — one adapter out of five defends itself, which is evidence the hazard is recognized but was fixed in the wrong layer.
- **Evidence (empirical, this run):** a probe importing the real `packages/web-adapter/src/index.ts` in Node:
  ```
  P2 reportError PROPAGATED: TypeError core blew up
  P3a setRouteName PROPAGATED: setRouteName blew up
  P3b recordRenderSpan PROPAGATED: recordChildSpan blew up
  P3c setRouteName on a non-PerformanceApi ext PROPAGATED: tryGetPerf(...)?.setRouteName is not a function
  P3d recordRenderSpan on a non-PerformanceApi ext PROPAGATED: getPerformanceApi(...)?.getActiveSpan is not a function
  ```
  (P3c/P3d: `ext('performance')` returning any object that is *not* a `PerformanceApi` — e.g. a foreign extension registered under that name — yields an unguarded `TypeError`. `getPerformanceApi` returned `{}` typed as `PerformanceApi`, so the type gives no protection either.)
- **Evidence that this is REACHABLE through the real core, not just a synthetic mock:** `logException` reads the error's `.stack` unguarded at `packages/core/src/client.ts:121` (`describeError`, called at `:595`) and again via `buildCrashJson` at `:598`. V8 invokes `Error.prepareStackTrace` lazily on first `.stack` access, so an app-installed hook that throws (source-map / stack-trace libraries install these) makes that read throw. Proven against the real exported core function:
  ```
  Q1 buildCrashJson THREW -> app prepareStackTrace hook threw     (the exact call at core/src/client.ts:598)
  Q2 reportError PROPAGATED -> app prepareStackTrace hook threw
  ```
  A second, independent reachable throw on the same path: `packages/react/src/report.ts:35` assigns `error.cause = frame`, which throws on a frozen thrown value — proven end-to-end through the componentDidCatch entry point:
  ```
  Q3 reportReactError(frozen) THREW -> TypeError: Cannot add property cause, object is not extensible
  ```
  (that line lives in `@bugsee/react`, but it reaches the host through the same unguarded kit contract and confirms the class of failure is live today, with no exotic app configuration at all).
- **Divergence from the sibling kit (this is the clincher):** `packages/adapter-kit/src/report-server-error.ts:24-33` — the *same shared-kit role*, for the SSR adapters — wraps the entire body in `try { … } catch { }` with the comments *"Never throws — safe to call from any framework error hook"* (`:21`) and *"Never replace / disrupt the framework's own error handling"* (`:32`). The two kits therefore ship contradictory containment contracts for the identical operation, and the frontend one — the one running inside React's commit phase — is the unguarded one.

---

## SEV2

### 1. `setRouteName` renames whatever transaction is active, with no operation guard — proven to rename a `ui.interaction` transaction (and, on a server, a concurrent request's transaction)

- **Where:** `packages/web-adapter/src/adapter.ts:65-69`
- **What:** the seam forwards straight to `PerformanceApi.setRouteName`, which renames the single active slot unconditionally and stamps provenance `bugsee.name_source: 'route'` (`packages/performance/src/controller.ts:128-132`). Neither layer checks the active transaction's `operation`. The JSDoc at `adapter.ts:63` claims it refines "the active **navigation** transaction" — the code has no such restriction.
- **Why it matters:** a span/transaction attributed to the wrong activity is worse than none. The codebase's own peer code establishes that operation-guarding is the expected discipline under the single-slot model: `packages/performance/src/interactions.ts:77` explicitly checks `getActiveSpan()?.getOperation() === 'navigation'` before opening an interaction. The naming seam skipped that guard. All five adapters re-export `setRouteName` as public API (`react/src/router.ts:10`, `vue/src/router.ts:12`, `angular/src/router.ts:13`, `svelte/src/router.ts:13`, `solid/src/router.ts:13`), so any app or router callback firing while a click interaction (or, under SSR, an `http.server` transaction resolved from the node carrier by `resolveClient`, `adapter.ts:32-34`) owns the slot corrupts that transaction's name and provenance. `packages/react/src/router.ts:74` (`apply(router.state)` at wire time) and Solid's `createEffect` wiring (`packages/solid/src/router.ts:10`) are the two call sites most likely to fire at an arbitrary moment.
- **Evidence (empirical, real `createPerformanceController`):**
  ```
  P7 after setRouteName, the ui.interaction txn is named: /users/:id | name_source = "route" | operation = ui.interaction
  ```
  This is NOT one of the two accepted D11 tradeoffs — those concern the slot *clearing*; this is the slot being *written to* by the wrong producer.

### 2. `recordRenderSpan` imposes no span-volume cap — 20 000 render spans landed on a single transaction

- **Where:** `packages/web-adapter/src/render-span.ts:33-49` (no cap), enabled by `packages/performance/src/span.ts:232` (`env.spans.push(...)`, unbounded)
- **What / Why it matters:** the array is retained for the transaction's whole lifetime and serialized wholesale at finish (`span.ts:333`). The browser `pageload` transaction lingers until tab-hide (`packages/performance/src/page-load.ts:148-157`), so in a no-navigation SPA **every** render span of the entire page session accumulates on one transaction. `packages/vue/src/render-mixin.ts:70-83` registers a **global** Vue mixin recording a span per component `mount` *and* per `update`, app-wide — a moderately reactive Vue app produces thousands. The same file's own `minDurationMs` knob (`render-mixin.ts:28`, default `0` = record everything) is the only throttle in the fleet and it lives in one adapter, not in the kit. The codebase already recognizes this hazard class one file away: `packages/performance/src/page-load.ts:44` caps resource spans at `MAX_RESOURCE_SPANS = 100` with the comment *"cap the count so a resource-heavy page can't bloat the bundle"*. Render spans, which are far more numerous, got no such cap.
- **Evidence (empirical, real controller + real span model):**
  ```
  P6 spans recorded on ONE transaction after 20000 renders = 20000
  ```
  Consequence: unbounded memory growth on a long-lived page plus a `performance.json` / transaction upload of the same magnitude.

### 3. Adapter render spans inherit the pageload-anchoring defect unclamped: a child span provably starts 4.5 s before its parent

- **Where:** `packages/web-adapter/src/render-span.ts:37-40` (timestamps forwarded verbatim), consumed by `packages/performance/src/span.ts:221-222` (written to the wire raw; only `durationNanos` is clamped ≥0 at `:223-226`)
- **What / Why it matters:** *blast-radius of the already-reviewed `@bugsee/performance` SEV1, not a new root cause* — the `pageload` transaction is created when the extension starts (`packages/performance/src/page-load.ts:129-133`), so its `startTimestampMs` is `clock.wallNow()` at SDK launch, not `timeOrigin`. Every adapter feeds true epoch-ms render times (`react/src/profiler.ts:50-51` = `timeOrigin + startTime`; the `defaultNow()` in vue/angular/svelte = `timeOrigin + performance.now()`), so any render that happened before launch — the initial mount/hydration whenever Bugsee is launched from a deferred or lazily-imported chunk, which is the common Next/Nuxt/SvelteKit wiring — produces a child that pre-dates its parent. The kit is the one place that could clamp or drop such a span and does neither.
- **Evidence (empirical, real controller + real `serializeTransaction`; launch simulated at timeOrigin+5000 ms, component mounted at +500 ms):**
  ```
  P5 root.start = 5000 | child.start = 500 | child predates parent by ms: 4500
  P5 child op/desc/attrs = ui.render App {"ui.render_duration_ms":400,"ui.render_phase":"mount"}
  ```
  The span is otherwise correct (op, description, attributes, parent-by-spanId), so this renders as a temporally inverted trace rather than a dropped one — the worst kind for an APM waterfall.

### 4. Every frontend-adapter error is reported as `mechanism: 'uncaught'` but with `crash.handled: true`

- **Where:** `packages/web-adapter/src/adapter.ts:58` (`mechanism: options.mechanism ?? 'uncaught'`) against `packages/core/src/client.ts:598`
- **What / Why it matters:** the kit overrides `logException`'s documented default (`'programmatic'`, `client.ts:600`), but `logException` unconditionally builds the structured crash payload with `handled: true` and the comment *"logException is a programmatically-logged (caught) exception"* (`client.ts:596-598`). The wire object therefore carries `source.mechanism = 'uncaught'` and `crash.handled = true` simultaneously, on **every** error from all five adapters. There is no seam in `ReportErrorOptions` (`adapter.ts:19-24`) to reconcile them. Handled-vs-unhandled drives issue classification/grouping on the backend, so this mislabels the entire frontend error corpus one way or the other. Compounding the drift: the sibling kit defaults to a third value, `'http-error'` (`packages/adapter-kit/src/report-server-error.ts:16`).

---

## SEV3

### 1. Dead exports: half the public surface is unused by all five adapters

- **Where:** `packages/web-adapter/src/index.ts:4` (`PerformanceApi`), `:8` (`getPerformanceApi`), `:16-19` (`RENDER_DURATION_ATTRIBUTE`, `RENDER_PHASE_ATTRIBUTE`, `RENDER_SPAN_OP`, `RenderSpanInput`)
- A repo-wide grep (excluding `dist`/`coverage`/`node_modules`) finds **no** consumer importing any of them from `@bugsee/web-adapter`. `getPerformanceApi` is used only internally by `render-span.ts:34`; the `RENDER_*` constants only by this package's own tests. `index.ts:3` (`Bugsee`) is imported by exactly one file and it is a test (`packages/react/src/profiler.test.ts:1`). Notably, `render-span.ts:7` claims "ONE source of truth for the op + attribute keys" — but the four consuming adapters' tests hardcode the string literals (`react/src/profiler.test.ts:36,41-42`, `vue/src/render-mixin.test.ts:39`), so the constants are a source of truth nobody imports, and `packages/react/src/profiler.ts:16` even defines its own uncatalogued key `ui.render_base_duration_ms`.

### 2. Two guard branches survive deletion undetected; `tryGetPerf`'s bare `catch` conflates "not registered" with a real SDK failure

- **Where:** `packages/web-adapter/src/adapter.ts:50` and `:66-67`; `packages/web-adapter/src/adapter.ts:36-42`
- Verified by mutation (backed up with `cp`, restored from backup, `git status --short packages/` empty afterwards):
  - Deleting `if (client === undefined) return;` from `setRouteName` (`:66-67`) → **20/20 tests still pass**.
  - Replacing `getPerformanceApi`'s `client === undefined ? undefined : …` with an unconditional `tryGetPerf(...)` (`:50`) → **20/20 tests still pass**.
  Both survive because `tryGetPerf`'s `catch` swallows the resulting `TypeError` and returns `undefined`, so the guards are behaviourally redundant and no test can distinguish them. Control mutations proved the harness works: swapping `startTimestampMs`/`endTimestampMs` in `render-span.ts:38-39` → 1 failure; changing the default mechanism at `adapter.ts:58` → 1 failure; caching the active span in module state → 4 failures.
  The same `catch {}` also means a *genuine* fault inside `ext()` (e.g. an extension whose registration throws) is indistinguishable from "performance monitoring is off" and is reported nowhere — no `onError`, no log. Both `@bugsee/nestjs` (`packages/nestjs/src/shared.ts:86`) and `@bugsee/node` (`packages/node/src/server-instrument.ts:124`) contain a third and fourth hand-rolled copy of the same helper.

### 3. Test theater: nothing in the repository exercises this package against the real performance extension

- **Where:** `packages/web-adapter/src/render-span.test.ts:11-18`, `packages/web-adapter/src/adapter.test.ts:5-22`
- Every test uses a hand-rolled `vi.fn()` fake of `ext('performance')`. Four near-identical copies of the same `fakeActive()` helper exist (`web-adapter/src/render-span.test.ts:11`, `react/src/profiler.test.ts:11-18`, `vue/src/render-mixin.test.ts:5-12`, plus `angular/src/render-tracker.test.ts`), and because `recordChildSpan` is a bare `vi.fn()` the suites assert nothing about the real `Span.recordChildSpan` contract — a signature or semantic change in `packages/performance/src/span.ts:215` would leave all of them green while producing zero spans in production. `docs/implementation-standards.md` §3 requires integration tests at cross-module/cross-package boundaries; there is none here, and my ~15-line real-controller probe surfaced SEV2.2 and SEV2.3 immediately, which is what such a test would have caught. Also missing: (a) any SSR / DOM-less import-safety test, despite five SSR meta-framework adapters sitting above the consumers; (b) any test that the span lands on the *active* transaction — the fake's `getActiveSpan()` returns a constant, so "active" is never validated; (c) any containment test (there is nothing to assert — see SEV1.1); (d) the `getPerformanceApi` tests never assert a *second* call re-resolves the client, which is why the module-state mutation was only caught incidentally, via cross-test pollution.

### 4. Divergent copies of primitives the kit should own

- `defaultNow()` — the identical 4-line epoch-ms clock is copy-pasted in `packages/vue/src/render-mixin.ts:34-38`, `packages/angular/src/render-tracker.ts:29-33`, `packages/svelte/src/render-span.ts:17-21`, with a fourth variant `realTimeOrigin()` in `packages/react/src/profiler.ts:34-35`. Every consumer of `recordRenderSpan` needs it; the kit provides none.
- The render-volume throttle (`minDurationMs`, `packages/vue/src/render-mixin.ts:28`) exists in one adapter only.
- Two shared kits with near-duplicate reporters and divergent contracts: `web-adapter`'s `reportError` (`adapter.ts:54-61`, unguarded, default `'uncaught'`) vs `adapter-kit`'s `reportServerError` (`packages/adapter-kit/src/report-server-error.ts:23-34`, fully guarded, default `'http-error'`, additionally supports an `event` route-attribution stamp). Divergent copies are exactly how a shared foundation rots.

---

## Five-adapter usage audit

| adapter | exports used | used as promised? | re-implements kit functionality? | file:line |
| --- | --- | --- | --- | --- |
| **react** | `reportError`, `resolveClient`, `AdapterMechanism`, `ReportErrorOptions`, `recordRenderSpan`, `AdapterClientOptions`, `setRouteName` + `RouteNamingOptions` (re-exported), `Bugsee` (type, test only) | Yes. Correctly converts React's `performance.now()`-relative `startTime`/`commitTime` to epoch via `timeOrigin`, and passes `actualDuration` as the explicit `durationMs` — exactly the case the `durationMs` field was documented for | Yes — `realTimeOrigin()` (own epoch clock) and its own attribute key `ui.render_base_duration_ms`, not in the kit's key catalog | `report.ts:1-6`, `profiler.ts:1,16,34-35,47-57`, `router.ts:1,10`, `error-boundary.ts:48` |
| **vue** | `reportError`, `AdapterMechanism`, `ReportErrorOptions`, `recordRenderSpan`, `AdapterClientOptions`, `setRouteName` + `RouteNamingOptions` (re-exported) | Yes — and it is the **only** adapter that defends itself against the SEV1.1 containment gap (`try/catch` around `recordRenderSpan`) | Yes — `defaultNow()`; plus `minDurationMs`, a volume throttle that belongs in the kit | `error.ts:1,38`, `render-mixin.ts:1,28,34-38,56-67`, `router.ts:1,12` |
| **angular** | `reportError`, `AdapterMechanism`, `ReportErrorOptions`, `recordRenderSpan`, `AdapterClientOptions`, `setRouteName` + `RouteNamingOptions` (re-exported) | Yes | Yes — `defaultNow()` | `error.ts:1,33`, `render-tracker.ts:1,29-33,50`, `router.ts:1,13` |
| **svelte** | `reportError`, `AdapterMechanism`, `ReportErrorOptions`, `recordRenderSpan`, `AdapterClientOptions`, `setRouteName` + `RouteNamingOptions` (re-exported) | Yes | Yes — `defaultNow()` | `error.ts:1,33`, `render-span.ts:1,17-21,33`, `router.ts:1,13` |
| **solid** | `reportError`, `AdapterMechanism`, `ReportErrorOptions`, `setRouteName` + `RouteNamingOptions` (re-exported) | Yes. No render-span integration (Solid has no comparable lifecycle hook) — a documented gap, not drift | No | `error.ts:1,23`, `router.ts:1,13,37` |

Unused by every adapter: `getPerformanceApi`, `PerformanceApi`, `RENDER_SPAN_OP`, `RENDER_PHASE_ATTRIBUTE`, `RENDER_DURATION_ATTRIBUTE`, `RenderSpanInput` (SEV3.1). No adapter misuses a signature; no adapter re-implements `reportError`/`setRouteName`/`recordRenderSpan` themselves — the drift is confined to the timing/threshold helpers the kit never provided, and to the parallel `@bugsee/adapter-kit`.

## SSR import-safety verdict

**Safe — verified empirically, not assumed.** Importing `packages/web-adapter/src/index.ts` in a bare Node process (`typeof window === 'undefined'`) succeeds, and calling all three entry points with no launched SDK is a clean no-op:

```
P1 import ok; typeof window = undefined
P1 no-client calls:  all no-op, no throw. resolveClient() = undefined
```

Mechanism: the only value-level import in the entire package is `getCarrierClient` from `@bugsee/core` (`adapter.ts:2`), which is runtime-portable. `@bugsee/browser` and `@bugsee/performance` are consumed **type-only** (`adapter.ts:1,3`, `index.ts:3-4` use `import type` / `export type`), so `verbatimModuleSyntax` erases them — confirmed in the built output: `packages/web-adapter/dist/index.js:1` contains exactly one import, `@bugsee/core`. No DOM/global access at module scope, no top-level side effects, `"sideEffects": false`. `resolveClient` on a server correctly resolves the node carrier client, which is the desired behaviour for error reporting (but is the vector for SEV2.1's SSR variant).

## Span lifecycle + attribution analysis

- **Parenting** is delegated entirely to `Span.recordChildSpan` (`packages/performance/src/span.ts:215-233`), which sets `parentSpanId` to the active transaction's own span id. Correct, and `recordRenderSpan` re-resolves the active span on **every** call (`render-span.ts:34`) rather than caching — so there is no stale-parent hazard. Verified by mutation: introducing a module-level cache broke 4 tests.
- **Closure on every path:** this package never *opens* a span. `recordChildSpan` records an already-completed span from explicit timestamps in a single synchronous call, so there is no "span left open" state anywhere in the kit — a component unmounting mid-interaction, a navigation cancelling an in-flight interaction, or a throw during render cannot leak a span *from this package*. (The per-adapter start/end brackets — Angular's `start()`/`end()`, Svelte's returned closure, Vue's `WeakMap` — hold only a number, and Vue/Angular correctly consume-and-clear it: `render-tracker.ts:47-49`, `render-mixin.ts:53-55`.) This is the cleanest part of the package.
- **Attribution is record-at-END-time.** The span is attributed to whatever transaction is active when the render *finishes*, though its `startTimestampMs` reflects when it *began*. A component whose mount spans a click (interaction transaction opens mid-mount) therefore lands on the interaction with a start that pre-dates it. This is the same model `http.client` spans use (`packages/performance/src/http-spans.ts:106-114`) and is consistent with D12's "attach to whatever is active", so I am not raising it separately — but it compounds SEV2.3's inverted parenting.
- **Inherited pageload anchoring:** confirmed to manifest, unclamped, in adapter spans — 4500 ms of negative offset in the probe (SEV2.3). `recordChildSpan` clamps `durationNanos` to ≥0 (`span.ts:223-226`) but not `startTimestampMs`, so the inversion reaches the wire.
- **Accepted D11 tradeoff, noted not reported:** when a navigation idle-finishes before the framework router's callback fires, the slot is `undefined` and `setRouteName` silently no-ops (`controller.ts:129`), leaving the transaction with its raw high-cardinality URL name — the naming-loss face of accepted tradeoff (a). Worth a doc line in `frontend-adapters.md` §D5 since D11 currently frames the tradeoff only in terms of network spans.
- **No finished-span hazard:** `getActiveSpan()` cannot return a finished transaction — the controller clears the slot inside the same synchronous `onFinish` that serializes it (`controller.ts:102-114`). Checked specifically.

## History/router interference

**Not applicable to this package, verified rather than assumed.** `packages/web-adapter/src` contains no reference to `history`, `pushState`, `replaceState`, `Navigation`, `currententrychange`, `addEventListener`, or `window`. All history patching lives in `@bugsee/browser` (`packages/browser/src/navigation-source.ts:167-176` patches, `:188-196` restores the saved originals — it prefers the Navigation API and only falls back to patching, calls the original **first**, and restores `#origPush`/`#origReplace` on teardown, which is the correct "restore what we saved" discipline; whether that composes with another library's wrapper is a `@bugsee/browser` question).

Router coexistence from this package's side is structurally safe: every router integration is a **pull** (the app hands its own router/match object in) rather than a patch — `react/src/router.ts:66-76` subscribes via the router's own `subscribe` and **returns the unsubscribe function** for teardown; `vue/src/router.ts:37-41` uses `afterEach`; `svelte/src/router.ts:29-35` and `solid/src/router.ts:32-38` return plain callbacks the app wires; `angular/src/router.ts:48-53` is a pure read of the snapshot tree. No adapter imports its router library, so no version coupling. The one real router-adjacent defect is the missing operation guard in the naming seam itself (SEV2.1). Note `packages/vue/src/router.ts:37-41` has no unsubscribe (vue-router's `afterEach` does return one; the adapter discards it) — bounded, since the guard is idempotent-safe and app routers are singletons, but it is the one asymmetry versus React's teardown-returning integration.

## Checked and found clean

- **Idempotency / double-install / HMR / multiple framework roots** — no module-level mutable state, no registration, nothing to double-install. Two React roots, or React + Vue on one page, share only the process-singleton carrier client, which is the intended design. Verified by reading all 141 impl lines and by mutation (introducing module state broke tests).
- **Teardown / SPA mount-unmount leaks** — the kit owns no listener, observer, timer, or open span. Nothing to leak.
- **`resolveClient` injection contract** — `(getClient ?? defaultGetClient)()` (`adapter.ts:33`) correctly prefers the injected resolver; deleting the fallback selection breaks a test.
- **Attribute precedence in `recordRenderSpan`** — extras are spread *first* so the canonical `ui.render_duration_ms` / `ui.render_phase` stay authoritative (`render-span.ts:44-46`); the collision test at `render-span.test.ts:59-74` genuinely validates it, and the mutation reversing the spread order is caught.
- **`durationMs` override semantics** — React's `actualDuration` correctly overrides the wall-clock extent for the attribute while the span extent stays start→commit; documented and tested (`render-span.test.ts:41-48`).
- **Floating promise in `reportError` (`adapter.ts:57`)** — investigated as a candidate unhandled-rejection source and **cleared**: `packages/core/src/client.ts:386-401` (`track`) attaches `report.then(onFulfilled, forget)` to the *same* promise object it returns, so the promise is already marked handled and `void`-ing it cannot surface an unhandled rejection.
- **`labels` omission** — `reportError` omits the key entirely rather than passing `undefined` (`adapter.ts:59`), tested at `adapter.test.ts:68-72`.
- **Carrier fallback** — `getCarrierClient` (`packages/core/src/carrier.ts:109-111`) is a plain property read; no throw path.
- **`tsc --noEmit`** passes for the package; `vitest run` is 20/20 green before and after all mutation work.
- **Repo hygiene** — every mutated file was backed up with `cp` and restored from the backup; `git status --short packages/` is empty and both sources `diff`-identical to their pre-review backups.
