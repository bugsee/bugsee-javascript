# Adversarial review — @bugsee/react

**Reviewed:** 2026-07-27 · **Scope:** packages/react (impl 380 LOC across 6 files, tests 617 LOC across 5 files; 56 tests, 100% stmt/branch/fn/line coverage)
**Verdict:** The package is small, clean-reading and correct on its happy paths — route names are genuinely
parameterized (no privacy leak), there is no history patching, no DOM mutation, no hydration risk, and a
server-side import does not throw. But it is the **most exposed consumer of the already-confirmed
`@bugsee/web-adapter` "zero error containment" SEV1**, and I proved the worst case concretely with a real
react-dom 18 render: **an SDK throw inside `componentDidCatch` unmounts the customer's entire React tree
(blank page), the error is never reported, and the app's own `onError` prop never runs** — identical in the
development AND production react-dom builds. The same is true of the `<Profiler>` `onRender` path. Separately,
`<BugseeProfiler>` — the entire D4 render-span feature — is a **guaranteed no-op in every production React
build** (`onRender` does not exist in `react-dom.production.min.js`; measured 0 spans vs 1 in development).
None of this is detectable by the test suite, because **no test in this package ever renders with React**
(`react-dom` is not even a devDependency) and **no test ever makes an SDK call throw**. 100% coverage is
carrying no weight here: I landed **5 surviving mutations against 2 controls that were caught**, including one
(report-before-link) that silently deletes the component stack from every report — the adapter's headline
feature.

Corrections to the review brief's prior, where the code disagreed:
- The package has **no `.tsx` files and no JSX** — everything is `createElement` in `.ts`.
- **react-router is not a devDependency either** — it is absent from the dev matrix entirely. The integration
  is purely structural over a `{ route: { path } }` shape (stronger than the prior claimed, but also
  completely unverified against a real router).
- **D2/D3 component attribution (`componentNameFromElement`, `data-bugsee-component`) is NOT in this package.**
  Nothing in `packages/react/src` reads a component annotation; attribution here comes only from React's own
  `errorInfo.componentStack` and the `<Profiler id>`.
- There are **no wrapped event handlers and no hooks**. `handlers.ts` is the React-**19 root** error-handler
  factory (`onUncaughtError`/`onCaughtError` for `createRoot`), not event-handler wrapping.

---

## SEV1

### 1. An SDK throw inside `componentDidCatch` unmounts the customer's whole app — and the error is never reported

- **Where:** `packages/react/src/error-boundary.ts:46-54` (unguarded `reportReactError` call);
  `packages/react/src/report.ts:35` (`error.cause = frame`), `:45` (`resolveClient`), `:48` (`reportError`)
- **What:** `componentDidCatch` calls `reportReactError` with no `try`/`catch`. Every statement inside it can
  throw synchronously: `resolveClient(options.getClient)` (report.ts:45) invokes user/carrier code;
  `linkComponentStack` **assigns** `error.cause = frame` (report.ts:35) on the app's own error object; and
  `reportError` → `client.logException(...)` (`packages/web-adapter/src/adapter.ts:57`) is the core path the
  web-adapter review already proved has reachable sync throws (`.stack` getters, `describeError`,
  `buildCrashJson` with a user `stackParser`). React treats a throw from `componentDidCatch` as the boundary
  itself failing.
- **Why it matters:** the consequence is the worst one available. Measured, not inferred:

  | scenario | DOM after | reported? | app `onError` prop? |
  |---|---|---|---|
  | control — ordinary error | `<div>BUGSEE FALLBACK</div>` | yes (1 `logException`) | ran |
  | frozen error → `report.ts:35` TypeError | **`""` (tree unmounted)** | **no (0 `logException`)** | **never ran** |
  | `client.logException` throws (core path) | **`""` (tree unmounted)** | **no** | **never ran** |

  Identical results under `NODE_ENV=development` and `NODE_ENV=production`. So the SDK (a) destroys the
  customer's UI, (b) **loses the very error it exists to capture** — `linkComponentStack` runs *before*
  `reportError` (report.ts:47 then :48), so a throw at :35 means nothing is ever sent — and (c) skips the
  customer's own recovery hook at error-boundary.ts:53.
- **Evidence:** real React 18 + react-dom 18.2.0 render in jsdom, driving the *actual*
  `BugseeErrorBoundary`/`report.ts` sources
  (`scratchpad/h/t1-containment.tsx`, `t2-prod-profiler.tsx`). Verbatim stack of the reachable throw:

  ```
  TypeError: Cannot add property cause, object is not extensible
      at linkComponentStack (src/report.ts:35:9)
      at reportReactError (src/report.ts:47:3)
      at BugseeErrorBoundary.componentDidCatch (src/error-boundary.ts:48:5)
      at commitLayoutEffectOnFiber (react-dom.development.js:23364:13)
  ```

  Two independently reachable triggers for report.ts:35 alone, both proven: a **frozen** error
  (`Object.freeze(err)`) and an error class with a **getter-only `cause`** (`class E extends Error { get cause(){…} }`)
  — ES modules are always strict mode, so both assignments throw `TypeError`. The `client.logException`-throws
  case reproduces the same unmount without needing any exotic error at all.
- **Extra consequence — the SDK's error replaces the app's error.** With an outer (customer) error boundary
  wrapping `BugseeErrorBoundary`, the SDK's `TypeError` **escapes the Bugsee boundary** and is caught by the
  outer one, which then rendered `OUTER CAUGHT: Cannot add property cause, object is not extensible` — the
  app's real error (`frozen boom 2`) is gone, replaced by SDK-internal noise in the customer's own fallback UI.
- **Zero test coverage of this:** no test in `packages/react/src/*.test.ts` ever makes an SDK call throw. Every
  `.not.toThrow()` assertion (report.test.ts:46, :66; error-boundary.test.ts:81; handlers.test.ts:56;
  profiler.test.ts:52, :57; router.test.ts:70, :79) covers only the *no-client no-op* path.

### 2. A throw from the `<Profiler>` `onRender` path also unmounts the tree

- **Where:** `packages/react/src/profiler.ts:73-84` (unguarded `onRender`) → `:47-57` (`recordRenderSpan`) →
  `packages/web-adapter/src/render-span.ts:37` (`active.recordChildSpan(...)`, unguarded)
- **What / Why it matters:** `onRender` fires inside React's commit phase, so a throw there behaves exactly
  like the `componentDidCatch` throw — and there is no boundary semantics to soften it: this is instrumentation
  wrapped around *working* application code, so the SDK converts a healthy app into a blank page.
  `getPerformanceApi` only guards `client.ext('performance')` (`packages/web-adapter/src/adapter.ts:36-42`);
  `getActiveSpan()` and `recordChildSpan()` are both called unguarded.
- **Evidence:** real render, `scratchpad/h/t5-profiler-throw.tsx` — `recordChildSpan` throwing gives
  `DOM after: ""`, `TREE UNMOUNTED: true`, uncaught `TypeError: SDK span recorder blew up`. The rendered
  `APP CONTENT` never survives to the DOM.

### 3. `<BugseeProfiler>` / `withBugseeProfiler` / the whole D4 render-span feature is a guaranteed no-op in production React

- **Where:** `packages/react/src/profiler.ts:66-88` (`BugseeProfiler`), `:91-102` (`withBugseeProfiler`),
  `:37-58` (`recordReactRenderSpan`); documented as built in `docs/design/frontend-adapters.md:5` ("D4 React
  Profiler") and `README.md`-adjacent design §7:237
- **What:** React only invokes `<Profiler onRender>` in development builds and in the explicit
  `react-dom/profiling` build. The stock production build does not contain the callback at all.
- **Why it matters:** every customer running a normal production React app gets **zero** `ui.render` spans, with
  no warning, no log, and no documentation of the limitation anywhere in `packages/react/README.md`,
  `profiler.ts`'s header comment (`:10-14`, which claims the opposite — "records a `ui.render` child span … for
  each commit"), or the design doc. The feature is advertised as working and is inert for 100% of production
  users.
- **Evidence:** two independent confirmations.
  1. Static: `grep -c onRender` on react-dom 18.2.0 → `react-dom.development.js: 6`,
     **`react-dom.production.min.js: 0`**, `react-dom.profiling.min.js: 1`.
  2. Dynamic (`scratchpad/h/t2-prod-profiler.tsx`, same code, both builds):
     `NODE_ENV=development` → `ui.render spans recorded: 1`; **`NODE_ENV=production` → `ui.render spans recorded: 0`**
     (`NONE — onRender never fired`). Same for the StrictMode variant (1 dev / 0 prod).
- Note this also means SEV1 #2's unmount is confined to development/profiling builds — but SEV1 #1 is not, and
  was reproduced in the production build.

---

## SEV2

### 1. `linkComponentStack` mutates the app's error even when the report is dropped, and chains a new frame per attempt

- **Where:** `packages/react/src/report.ts:44-49` — `linkComponentStack` (:47) runs unconditionally once a
  client exists, *before* `reportError` (:48) reaches the core's instance-dedup
  (`packages/core/src/client.ts:587`), rate limiter (`:591`) and stopped/killed check (`:583`).
- **What / Why it matters:** the core silently drops the 2nd..Nth report of the same error instance, but the
  mutation is not deduped, so the customer's error object accumulates one synthetic `cause` frame per attempt.
  This is a live path, not a hypothetical: under React 19 a boundary-caught error fires **both**
  `componentDidCatch` (error-boundary.ts:48) **and** the root `onCaughtError` if the app also wired
  `createBugseeErrorHandlers` (handlers.ts:33) — the exact pairing handlers.ts:6-8 recommends and claims is
  safe because of "instance-dedup". The dedup protects the *report*, not the *error object*. It also means an
  error reported after `stop()` is still mutated even though the SDK is a documented no-op there
  (report.ts:46's comment "don't touch the error" only holds for the no-client case).
- **Evidence:** `scratchpad/h/t4-nesting.ts` — three `reportReactError` calls with a dedup-faithful fake client:
  `reports actually accepted by the client: 1 (dedup dropped 2)`, `component-stack frames chained on error: 3`,
  chain printed as three identical `React component stack:\n    in Widget` frames. No test covers repeat
  reporting of one instance.

### 2. Once the boundary catches, it renders the fallback forever — no reset on prop/route change

- **Where:** `packages/react/src/error-boundary.ts:38` (`state`), `:41-43` (`getDerivedStateFromError`),
  `:56-62` (`render`)
- **What / Why it matters:** `hasError` is never cleared. There is no `resetKeys`, no `reset()` on the fallback,
  and no reset when `props.children` changes. In an SPA — the stated audience — a single caught render error on
  `/orders/42` leaves the boundary pinned to the fallback across every subsequent client-side navigation,
  because the boundary instance is not remounted by a route change. The customer's only recovery is a full page
  reload. `BugseeErrorBoundaryProps` (`:17-27`) documents no reset contract, so this is a capability gap rather
  than a broken promise — but it makes the boundary strictly worse than the `react-error-boundary` shape users
  expect, and the README (`:11-20`) presents it as a drop-in.

### 3. The router integration propagates SDK throws into the app and into react-router's listener loop

- **Where:** `packages/react/src/router.ts:70-75` (`apply` + the synchronous `apply(router.state)` at `:74` and
  the `router.subscribe(apply)` listener at `:75`); `:43-50` (`instrumentRouterMatches`)
- **What / Why it matters:** `setRouteName` is called unguarded. `tryGetPerf` only wraps `client.ext(...)`
  (`packages/web-adapter/src/adapter.ts:36-42`), so a throw from `PerformanceApi.setRouteName` escapes.
  `instrumentReactRouter` is documented as "wire once" (`router.ts:63`) and is therefore typically called at
  module scope or in a root effect — an SDK throw there prevents the app from booting. Worse, the *same*
  function is the subscribe listener, so a throw lands inside react-router's own state-notification loop and
  can abort the notification of every subsequent listener.
- **Evidence:** `scratchpad/h/t5-profiler-throw.tsx` with the real `router.ts` against a `setRouteName` that
  throws → `threw out of instrumentReactRouter: TypeError: SDK setRouteName blew up`. (My first run of this
  probe reported "contained" — that was a resolution artifact: the file under `packages/` bound the real
  web-adapter with no launched client. Re-verified with the source copied into the harness.)

### 4. `BugseeErrorBoundary` does not catch — or report — server-render errors

- **Where:** `packages/react/src/error-boundary.ts:34-63`; consumed by `@bugsee/nextjs` and `@bugsee/remix`
- **What / Why it matters:** React's server renderer does not support error boundaries, so under
  `renderToString` the child's error bypasses the boundary entirely and `componentDidCatch` never runs. The
  README (`:6-23`) and design §6 (`docs/design/frontend-adapters.md:218-220`) describe the boundary without any
  server-side caveat, and this package is the documented base for two SSR meta-framework adapters. A customer
  who wraps their app in `<BugseeErrorBoundary>` for an SSR app gets neither the fallback nor the report on the
  server.
- **Evidence:** `scratchpad/h/t3-ssr.tsx` (no DOM globals in-process) —
  `[SSR boundary, child throws] ESCAPED the boundary: Error: server render boom`,
  `logException calls during SSR: 0`.

### 5. Umbrella re-export: TypeScript resolves the **browser** entry while Node/SSR runtime resolves the **node** entry

- **Where:** `packages/react/src/index.ts:6` (`export * from '@bugsee/bugsee'`);
  `packages/bugsee/package.json` `exports["."]` (browser/node/default)
- **What / Why it matters:** the two umbrella entries export *different* `launch` signatures and types —
  browser: `BugseeLaunchOptionsWithPerformance` + `Bugsee` from `@bugsee/browser`
  (`packages/bugsee/src/launch.ts:18-21`); node: `BugseeNodeLaunchOptions` + `Bugsee` from `@bugsee/node`
  (`packages/bugsee/src/index.node.ts:12-13`). A Next.js/Remix server module importing `launch` from
  `@bugsee/react` is **type-checked against the browser launch and executes the node launch**. Node-only launch
  options fail to typecheck; browser-only options typecheck and are wrong at runtime.
- **Evidence:** measured both sides.
  - Runtime (`tsx`, node condition, importing the real `packages/react/src/index.ts`):
    `launch === NODE umbrella launch: true`, `launch === BROWSER umbrella launch: false`. (The import itself
    succeeds — SSR-import-safe, see the SSR section.)
  - Types (`ts.resolveModuleName` from `packages/react/src/index.ts`, repo `tsconfig.base.json`
    `moduleResolution: "Bundler"` — also the standard Vite/Next app setting):
    `@bugsee/bugsee -> packages/bugsee/src/index.ts` (**browser**), while `NodeNext` resolves
    `-> packages/bugsee/src/index.node.ts` (**node**).
  - `reexport.test.ts:9` cannot detect this: it compares `adapter.launch` to `umbrella.launch` where both
    resolve through the *same* condition, so it passes identically in either world.

### 6. TEST THEATER — swapping report/link order deletes the component stack from every report and **no test fails**

- **Where:** assertions at `packages/react/src/report.test.ts:36-43` (esp. `:42`),
  `error-boundary.test.ts:66`, `handlers.test.ts:22`; implementation `report.ts:47-48`
- **What / Why it matters:** every "component stack is linked" test reads `err.cause` **after** the call
  returns, on the same object the SDK mutates — so it passes whether the link happened before or after the
  report was submitted. But `logException` reads the cause chain **synchronously** via `describeError`
  (`packages/core/src/client.ts:595`), so linking after reporting means the component stack — the adapter's
  entire headline feature (D8) — never reaches the report.
- **Evidence — surviving mutation (rolled back):** reordering report.ts:47/48 to
  `reportError(...); linkComponentStack(...)` → **`Tests 56 passed (56)`**. Control mutation
  (`router.ts:36` drops the leading slash) → `7 failed | 49 passed`, so the harness detects real breakage.
  The fix is to assert on what the *client received* at call time (e.g. snapshot `err.cause` inside the
  `logException` fake), not on the mutated object afterwards.

### 7. TEST THEATER — the Profiler's `phase` and `withBugseeProfiler`'s options are effectively unasserted

- **Where:** `packages/react/src/profiler.test.ts:21-28` (fixture), `:40-44`, `:101-104`, `:108-143`;
  implementation `profiler.ts:52` and `:99`
- **What / Why it matters:** two surviving mutations (both rolled back, both `Tests 56 passed (56)`):
  1. `profiler.ts:52` `phase: profile.phase` → `phase: 'update'` **survives**. The only phase assertion
     (`profiler.test.ts:41`) uses a fixture whose phase already *is* `'update'`, and the one test that drives a
     real `'mount'` commit (`:100`) asserts with `expect.objectContaining({ description, startTimestampMs,
     endTimestampMs })` (`:101-104`) — it never inspects `attributes`. Every mount would be mislabelled as an
     update and no test would notice.
  2. `profiler.ts:99` dropping `...options` → **survives**. `withBugseeProfiler`'s third parameter
     (`getClient`/`timeOrigin`) is never passed by any test in `:108-143`, so the entire options-threading path
     of the public HOC is uncovered in behaviour despite 100% line coverage.
- **Also vacuous:** `profiler.test.ts:47-54` — the `recordChildSpan` spy created at `:51` is never wired to the
  client built at `:48-50`, so `expect(recordChildSpan).not.toHaveBeenCalled()` at `:53` is unfalsifiable by
  construction; no mutation of `profiler.ts` can make it fail.

---

## SEV3

### 1. Dead argument: the linked frame's `Error` message is always overwritten
- **Where:** `packages/react/src/report.ts:32-33` — `new Error(\`React component stack:${componentStack}\`)`
  then `frame.stack = \`React component stack:${componentStack}\``.
- Mutating `:32` to `new Error("")` **survives** (`Tests 56 passed (56)`), confirming the message is dead
  (only `.stack` is ever read). Harmless, but it is untested surface and duplicates the template string.

### 2. Design doc contradicts itself about the real-React probe
- `docs/design/frontend-adapters.md:223` states "Probed against the real React + react-router (e2e), like the
  backend adapters were", while `:301-304` states "**DEFERRED**: a real-React + real-react-router e2e … tracked
  as a follow-up". The second is correct: no `react-dom`, no `react-router`, and
  `packages/react/vitest.config.ts:4-7` explicitly documents "NOT a react-dom renderer".
- `:302-303` justifies the deferral with "the injection-first unit tests are comprehensive" — SEV1 #1/#3 and
  the 5 surviving mutations refute that; the deferred renderer test is exactly what would have caught them.

### 3. "React is imported only in the boundary" is false in three places
- Claimed at `packages/react/README.md:3-4`, `packages/react/src/index.ts:2`, `error-boundary.ts:14`, and
  `docs/design/frontend-adapters.md:300`. React is also imported by
  `packages/react/src/profiler.ts:2-8` (`Profiler`, `createElement`, `ComponentType`).

### 4. A React-19-only API ships with a React-18-only dev matrix
- `packages/react/src/handlers.ts:23-34` builds `onUncaughtError`/`onCaughtError`, which exist only on React
  19's `createRoot`/`hydrateRoot`. `packages/react/package.json` declares `peerDependencies: react >=18` with
  `devDependencies: react ^18.3.1`, `@types/react ^18.3.0`. On React 18 those options are silently ignored, and
  nothing in the repo ever typechecks or runs against React 19 types/runtime. (The APIs actually used —
  `Component`, `createElement`, `Profiler` — are all React ≥16.5, so `>=18` is otherwise conservative-but-safe.)

### 5. Documented `onError` ordering is unasserted
- `error-boundary.ts:23` documents "Called AFTER the error is reported"; moving
  `this.props.onError?.(...)` (`:53`) **before** `reportReactError` (`:48`) **survives** (`56 passed`).
  Ordering matters here — see SEV1 #1, where the app's `onError` never runs at all.

### 6. react-router support is claimed but wholly unverified, and the listener has no de-duplication
- `README.md:25-38` claims react-router v6/v7 support; react-router appears nowhere in
  `packages/react/package.json` (not even a devDependency) and is exercised only by a hand-written fake
  (`router.test.ts:106-122`). `router.ts:70-75` re-runs `apply` on **every** router notification with no
  memo of the last pattern, so `setRouteName` is re-issued for unrelated state changes (fetchers, revalidation,
  `navigation.state` transitions). I could not verify react-router's exact notification semantics locally —
  the *code* facts (no de-dup, no real-router test) are what I am reporting, not a specific mis-naming outcome.

---

## Throw-containment matrix (the key question)

Base defect: `@bugsee/web-adapter`'s `reportError`/`setRouteName`/`recordRenderSpan` have no `try`/`catch`
(`packages/web-adapter/src/adapter.ts:54-69`, `render-span.ts:33-49`); this package adds none of its own and
also introduces its own throw site at `report.ts:35`.

| React integration point | can an SDK throw reach React? | consequence | file:line | verified how |
|---|---|---|---|---|
| **ErrorBoundary `componentDidCatch`** | **YES** | **Whole tree unmounts (blank page); error NEVER reported (`logException` = 0); app's `onError` prop never runs. With an outer boundary the SDK's `TypeError` escapes and REPLACES the app's error in the customer's fallback.** | `error-boundary.ts:46-54` → `report.ts:35`/`:45`/`:48` | Real react-dom 18.2 render, **dev AND production** builds (`t1-containment.tsx`, `t2-prod-profiler.tsx`); 3 independent triggers (frozen error, getter-only `cause`, throwing `logException`) |
| **`<Profiler>` `onRender`** | **YES** | Whole tree unmounts (blank page) — instrumentation kills a *healthy* app. Dev/profiling builds only (SEV1 #3). | `profiler.ts:73-84` → `profiler.ts:47` → `render-span.ts:37` | Real render, `t5-profiler-throw.tsx`: `DOM after: ""`, `TREE UNMOUNTED: true` |
| **Router integration** (`instrumentReactRouter`, `instrumentRouterMatches`) | **YES** | Throws out of the app's wire-up call (typically module scope / root effect → app fails to boot); as the subscribe listener it throws inside react-router's notification loop. | `router.ts:70-75`, `:47-49` | `t5-profiler-throw.tsx`: `threw out of instrumentReactRouter: TypeError: …` |
| **React-19 root handlers** (`createBugseeErrorHandlers`) | **YES (path), consequence not verified** | Identical unguarded call shape; React 19 was not available locally to confirm what React does with a throwing root handler. Reported as a path, not an outcome. | `handlers.ts:26-32` | Code read only — deliberately NOT claimed as an outcome |
| **Wrapped event handlers** | **N/A** | This package does not wrap event handlers. | — | `grep` over `packages/react/src` |
| **Hooks / effects** | **N/A** | This package ships no hooks and no `useEffect`. | — | `grep` over `packages/react/src` |
| **Rendering (`render`, HOCs)** | **NO** | `render` (`error-boundary.ts:56-62`) and both HOCs touch no SDK code. Clean. | `error-boundary.ts:56-75`, `profiler.ts:91-102` | Code read + real render control case |

**Fix shape:** a single `safeCall(fn)` wrapper (report → `onError`, never rethrow) around the three
`@bugsee/web-adapter` primitives is the correct place; this package should additionally not leave
`componentDidCatch`/`onRender`/`apply` bare. A regression test must render with a real renderer and assert
the tree is still mounted after an SDK method throws — the current suite has no such test.

## Profiler analysis

- **Opt-in:** yes, correctly. Nothing installs a `<Profiler>` automatically; the customer must place
  `<BugseeProfiler id>` or apply `withBugseeProfiler` (`profiler.ts:66-102`). No whole-tree default, no
  per-customer performance tax by default. **Clean.**
- **Production overhead / correctness:** moot, because the callback never fires in production — see SEV1 #3
  (0 spans measured under `NODE_ENV=production`, 1 under development; `onRender` absent from
  `react-dom.production.min.js`). A customer who *does* opt into `react-dom/profiling` to get the data pays
  React's profiling-build cost tree-wide, which is undocumented.
- **StrictMode double-count:** verified clean on React 18.2 — one logical mount inside `<StrictMode>` produced
  exactly **1** `ui.render` span with phase `mount` (`t2-prod-profiler.tsx`). React's StrictMode double-*render*
  does not double-*commit*, and `onRender` is per commit.
- **Discarded / interrupted / suspended renders:** structurally safe. `recordReactRenderSpan` is a pure
  fire-and-forget record at commit time (`profiler.ts:39-58`) — it opens no span and holds no state, so there
  is **nothing to leak** when a concurrent render is discarded (React simply never commits, so `onRender` never
  fires). This is a genuinely good design choice and I could not construct a phantom-span case.
- **Parenting / timestamps:** the span is attached to whatever the single-slot `getActiveSpan()` returns at
  commit (`render-span.ts:34`), with absolute `timeOrigin + startTime` / `timeOrigin + commitTime`
  (`profiler.ts:50-51`). Two blast-radius notes on already-known defects: (a) with the confirmed
  `@bugsee/performance` SEV1 (pageload anchored at SDK launch, not `timeOrigin`), the first commits after
  launch produce `ui.render` children whose `startTimestampMs` **pre-dates the parent transaction**; (b) a
  commit deferred across a navigation attaches to the *new* transaction while carrying the *old* render's
  timestamps. Both are consequences of already-filed findings, so I am not double-counting them.
- **Attribution correctness:** the `phase` field is effectively untested (SEV2 #7) and `withBugseeProfiler`'s
  options are unthreaded-and-untested (SEV2 #7).

## Route-name extraction

**Parameterized, not raw URLs — no privacy or cardinality problem.** `routePatternFromMatches`
(`router.ts:22-37`) reads exclusively `m.route.path`, which in react-router is the declared *pattern*
(`users`, `:id`), never `location.pathname` and never a resolved param value. There is no `window.location`,
`URL`, `href` or `pathname` access anywhere in `packages/react/src` (verified by grep). Ids, emails and tokens
therefore cannot enter a span name via this package. Pathless/layout/index routes are correctly skipped
(`:29`), slashes are normalized (`:30`), the `//users` double-slash case under a `'/'` layout is handled
(`:33-34`, tested at `router.test.ts:44-48`), and the root route yields `'/'`. Cardinality is bounded by the
route table. **Clean — this is the strongest part of the package.**

Caveats, both already filed: the pattern is only applied if the app calls `instrumentRouterMatches` /
`instrumentReactRouter` (otherwise the transaction keeps whatever raw-URL phase-1 name the browser tier gave
it — a `@bugsee/browser`/`@bugsee/performance` concern, not this package's); and none of it is verified against
a real react-router (SEV3 #6).

**History patching: none.** `instrumentReactRouter` (`router.ts:66-76`) only calls the router's own
`subscribe` and returns its unsubscribe verbatim (`:75`, asserted at `router.test.ts:160-165`). No global
`history.pushState` wrapper, so there is nothing to clobber and nothing to restore incorrectly — the teardown
contract is exactly react-router's own. Calling `instrumentReactRouter` twice subscribes twice (no idempotence
guard, `router.ts:75`), which duplicates `setRouteName` calls but is value-idempotent; each call returns its
own unsubscribe, so teardown is still correct.

## SSR / hydration safety

- **Server import does not throw. Verified.** `import('packages/react/src/index.ts')` under plain Node (no DOM
  globals) succeeded and yielded 13 runtime exports. `error-boundary.ts:1` and `report.ts` import
  `@bugsee/browser` as `import type` only (fully erased); the only value import into the SDK is
  `@bugsee/web-adapter`, whose own DOM/performance imports are type-only
  (`packages/web-adapter/src/adapter.ts:1,3`, `index.ts:3-4`). **No DOM code is pulled in.**
- **Rendering on the server does not throw.** `renderToString` of `<BugseeErrorBoundary>` → `<div id="app">hello</div>`;
  of `<BugseeProfiler>` → `<div>hi</div>` (`t3-ssr.tsx`).
- **Hydration: no mismatch risk. Verified.** Neither component emits any wrapper element, attribute, comment or
  text node — `BugseeErrorBoundary.render` returns `children` verbatim (`error-boundary.ts:61`) and
  `BugseeProfiler` renders React's own `<Profiler>` which is transparent. Nested SSR markup was byte-identical
  to the un-instrumented tree (`"<div id=\"x\">stable</div>"`). No DOM mutation and no attribute injection
  anywhere in the package. **Clean.**
- **Which umbrella entry resolves:** node runtime → the **node** entry (`launch === NODE umbrella launch: true`);
  TypeScript under `moduleResolution: "Bundler"` → the **browser** entry. The runtime side is defensible for
  isomorphic use, but the types/runtime split is a real hazard for `@bugsee/nextjs`/`@bugsee/remix` — filed as
  SEV2 #5. The umbrella's missing export conditions (its own SEV1) do not cause a *wrong-entry* resolution here:
  browser bundlers get `browser`, Node gets `node`, everything else gets `default` (= browser). No test pins
  either resolution (SEV2 #5, evidence).
- **Server-render errors are silently uncaught and unreported** — SEV2 #4.

## Single-install re-export correctness

Verified clean.
- **No name collisions, no shadowing.** The umbrella's *runtime* surface is exactly one binding (`launch`);
  this package exports 12 of its own. Measured export list from a real import: `BugseeErrorBoundary,
  BugseeProfiler, createBugseeErrorHandlers, instrumentReactRouter, instrumentRouterMatches, launch,
  linkComponentStack, recordReactRenderSpan, reportReactError, routePatternFromMatches, setRouteName,
  withBugseeErrorBoundary, withBugseeProfiler` (13 total). No duplicate, so `export *`'s
  silent-explicit-wins rule is never engaged. Type-level names are likewise disjoint.
- **No internals leaked.** The umbrella entries re-export only curated public types
  (`packages/bugsee/src/index.ts:5-17`), not `@bugsee/core`'s index.
- **Tree-shaking intact.** `packages/react/package.json:22` sets `"sideEffects": false`; the re-export is a
  static `export *`; the tsup preset keeps `@bugsee/*` external (`tsup.config.base.ts`) so nothing is
  duplicated into the bundle.
- `setRouteName` is exported twice from within the package (`router.ts:10` re-export + `index.ts:38`) — a
  single consistent binding, not a collision.

## Test quality

100% statements / 100% branches / 100% functions / 100% lines (v8), 56 tests, `tsc --noEmit` clean. The
coverage number is not measuring what it appears to.

**Mutation results (all mutations rolled back; `git status --short packages/` verified empty afterwards):**

| # | mutation | file:line | result |
|---|---|---|---|
| C1 | drop the leading `/` from the route pattern | `router.ts:36` | **CAUGHT** (7 failed) — control |
| C2 | remove `export * from '@bugsee/bugsee'` | `index.ts:6` | **CAUGHT** (1 failed) — control |
| C3 | `onCaughtError` becomes a no-op | `handlers.ts:33` | **CAUGHT** (1 failed) |
| C4 | hard-code the span id instead of the Profiler id | `profiler.ts:82` | **CAUGHT** (1 failed) |
| **M1** | report **before** linking the component stack | `report.ts:47-48` | **SURVIVED** — kills the D8 feature |
| **M2** | hard-code `phase: 'update'` | `profiler.ts:52` | **SURVIVED** — every mount mislabelled |
| **M3** | drop `...options` in `withBugseeProfiler` | `profiler.ts:99` | **SURVIVED** — public param unthreaded |
| **M4** | run `onError` **before** reporting | `error-boundary.ts:53` | **SURVIVED** — documented order unasserted |
| **M5** | blank the linked frame's `Error` message | `report.ts:32` | **SURVIVED** — dead argument |

Structural gaps, each of which is itself a finding given what it hides:
- **No test renders with React.** `react-dom` is not a devDependency; `vitest.config.ts:4-7` states the
  boundary is driven "by direct invocation … NOT a react-dom renderer". Consequence: nothing verifies that
  `BugseeErrorBoundary` actually catches, that `<Profiler onRender>` actually fires, or that the tree survives
  — the three things SEV1 #1-#3 turn on.
- **No test makes an SDK call throw.** Every `.not.toThrow()` covers the trivial no-client path only.
- **No SSR test, no StrictMode test, no concurrent/Suspense test, no React-19 test.**
- **Vacuous assertion:** `profiler.test.ts:53` (spy unreachable by construction).
- **Assert-the-mutated-object anti-pattern:** `report.test.ts:42`, `error-boundary.test.ts:66`,
  `handlers.test.ts:22` all read `err.cause` after the call rather than what the client received (root cause of
  surviving mutation M1).

## Checked and found clean

- **Route-name privacy + cardinality** — patterns only, no URL/pathname access anywhere in the package.
- **No history/global patching**, no monkey-patching of any kind; teardown returns react-router's own
  unsubscribe verbatim (`router.ts:75`).
- **Structural-peer discipline** — react-router is never imported (grep: only comments/docstrings); React is a
  true peer (`package.json` `peerDependencies`), imported only in `error-boundary.ts` and `profiler.ts`.
- **Hydration safety** — zero DOM mutation, zero attribute/wrapper injection; SSR markup byte-identical to the
  uninstrumented tree.
- **Server import safety** — no DOM code reachable; `@bugsee/browser` is `import type` only.
- **Discarded/suspended renders** — no span is opened before commit, so no phantom or leaked span is possible.
- **StrictMode** — no render-span double-count on React 18.2 (measured).
- **`sideEffects: false`, dual-module `publishConfig`, externalized deps** — packaging is consistent with
  `docs/design/packaging-dual-module.md`.
- **`linkComponentStack` non-destructiveness** — an existing `cause` is correctly chained behind the new frame
  (`report.ts:34`, mutation-tested by `report.test.ts:78-85`); the non-Error and empty-stack guards
  (`report.ts:31`) are real and tested.
- **HOC displayName derivation** — the `||`-not-`??` reasoning at `error-boundary.ts:72-73` / `profiler.ts:96-97`
  is correct for anonymous components (empty-string `name`) and is properly tested.
- **`tsc --noEmit`** passes; `git status --short packages/` empty after all mutation work.
