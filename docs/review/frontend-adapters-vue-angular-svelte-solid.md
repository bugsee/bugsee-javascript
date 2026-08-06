# Adversarial review — @bugsee/vue + angular + svelte + solid

**Reviewed:** 2026-07-27 · **Scope:** the four frontend adapters over `@bugsee/web-adapter` + `@bugsee/browser`
| package | impl LOC | test LOC | tests |
| --- | --- | --- | --- |
| `packages/vue` | 287 | 609 | 53 |
| `packages/angular` | 199 | 348 | 29 |
| `packages/svelte` | 149 | 253 | 22 |
| `packages/solid` | 88 | 157 | 15 |

**Frameworks actually exercised:** **vue 3.5.38** (real `createApp`/`mount` on jsdom 25 — full control matrix), **solid-js 1.9.13 + solid-js/web** (real `render()` + real `<ErrorBoundary>` + real `catchError`), **svelte 5.56.3** (real `svelte/compiler` compile + real `mount()`/`flushSync()` on jsdom), **@sveltejs/kit 2.67.0** (real `handleError` hook shape + its call sites read from kit's shipped `client.js`), **@angular/core 22.0.2** (real `Injector.create` DI resolution + real default `ErrorHandler` + its real unguarded call sites read from the shipped `fesm2022` bundles; a full Angular app bootstrap was **not** possible — `@angular/platform-browser`, `zone.js`, `rxjs` and `@angular/common` are not installed, so the Angular lifecycle consequence is established from Angular's own shipped source plus a faithful replay of `AfterRenderImpl.execute()`, not from a live render). **@solidjs/router 0.16.1** pattern semantics established from its shipped `dist/routing.js`, not a live router.

**Verdict:** The prior is broadly correct and the four packages are genuinely well-built on the axes their tests cover — 11 of 13 targeted real-behaviour mutations were caught, coverage is a real 100/100/100/100, the structural-peer discipline holds (not one hard framework import), route names are properly parameterized patterns with no raw-URL fallback, and importing every package on the server is safe. But the confirmed `@bugsee/web-adapter` zero-containment SEV1 has a **worse blast radius here than in React**, and it is unmitigated in all four: with real Vue 3.5.38 I proved a control matrix in which a customer's render error is *survivable* with their own `errorHandler` (app renders, sibling components intact) and becomes a **total app-mount failure with an empty DOM** the moment Bugsee is installed and the SDK throws; with real solid-js I proved an `<ErrorBoundary>`'s fallback UI **never renders**; with real SvelteKit hook semantics I proved the customer's `handleError` never runs and `undefined` reaches kit's error-page recovery. In all four the customer's own chained handler is *skipped* precisely when it matters, because every adapter reports **before** it chains. Separately, Angular's documented one-line wiring silently deletes the app's `ErrorHandler`. The two mutations that survived are exactly the two that encode this gap, and no test in any of the four packages ever injects a client that throws.

---

## SEV1

### 1. An SDK throw inside the framework error seam escapes into the framework and skips the customer's own handler — in all four adapters

- **Package(s):** vue · angular · svelte · solid
- **Where:**
  - `packages/vue/src/error.ts:45-48` (`reportVueError` at :46 is unguarded; `previous(...)` chain at :47 is unreachable when it throws)
  - `packages/angular/src/error.ts:47-50` (`reportAngularError` at :48 unguarded; `options.delegate?.handleError` at :49 unreachable)
  - `packages/svelte/src/error.ts:43-50` (`reportSvelteError` at :45 unguarded; `return appHandler?.(input)` at :49 unreachable)
  - `packages/solid/src/error.ts:22-24` and `:28-30` (`reportError` / `solidErrorHandler` unguarded)
  - shared root cause: `packages/web-adapter/src/adapter.ts:54-61` — `reportError` calls `client.logException(...)` with no `try`/`catch` (the already-reviewed base SEV1)

- **What:** Every adapter calls the reporting path *first* and chains to the pre-existing handler *second*, with no containment in between. Any synchronous failure inside the SDK — a throwing `logException`, a broken carrier, a serialization error on a hostile error object — therefore does two things at once: it propagates out into the host framework's error pipeline, and it prevents the customer's own handler from ever running.

- **Why it matters:** This is strictly worse than "a report is lost". Each framework's error seam exists to make errors *survivable*; the SDK converts a recoverable error into an unrecoverable one, and does so only in the situation the customer most needs their handler.

- **Evidence — Vue, real `vue@3.5.38`, control matrix (a customer render-phase error during initial mount):**

  | configuration | `mount()` threw | sibling component rendered | resulting DOM |
  | --- | --- | --- | --- |
  | C0 no SDK, no customer handler (Vue default) | `render-phase customer error` | no | `""` |
  | C1 customer `errorHandler` only, **no Bugsee** | **no** | **yes** | `<div><p>SIBLING</p><!----></div>` |
  | C2 Bugsee + healthy SDK | **no** | **yes** | `<div><p>SIBLING</p><!----></div>` |
  | **C3 Bugsee + SDK throws** | **`SDK BOOM`** | **no** | **`""`** |

  C1 vs C3 isolates the SDK as the sole cause: installing Bugsee turns a fully-recovered mount into an empty DOM and a throw out of `app.mount()`, so every line of the customer's bootstrap after `mount()` is skipped. A second real-Vue scenario (throw from `onMounted`) confirmed the customer's own `errorHandler` ran on the healthy path and did **not** run when the SDK threw, and that the report was lost (`logException` recorded 0). Vue's own stack in the failure was `app.config.errorHandler (packages/vue/src/error.ts:46) → reportError (packages/web-adapter/src/adapter.ts:57) → callWithErrorHandling → handleError`.

- **Evidence — Solid, real `solid-js@1.9.13` + `solid-js/web` `render()` with a real `<ErrorBoundary>` wired exactly as `packages/solid/src/error.ts:7` documents:**

  | configuration | `render()` threw | fallback ran | resulting DOM |
  | --- | --- | --- | --- |
  | healthy SDK | no | 1 | `<span>FALLBACK-UI</span>` |
  | **SDK throws** | **`SDK BOOM`** | 1 | **`""`** |

  The boundary's entire purpose is defeated: the fallback executes but its UI is discarded and the throw escapes `render()`. Real `catchError(fn, handler)` behaves the same — the throw escapes the reactive root into the caller.

- **Evidence — SvelteKit, real hook contract (`@sveltejs/kit@2.67.0`):** healthy → the app's hook ran and its `App.Error` (`{message: 'CUSTOMER ERROR PAGE MESSAGE'}`) was forwarded; SDK throws → escaped `handleError`, **the customer's hook never ran**, and **`undefined`** was produced instead of their error page. Kit calls this **unguarded** at `packages/svelte/node_modules/@sveltejs/kit/src/runtime/client/client.js:2204`, and every caller is inside an error-*recovery* path (`client.js:1226`, `:1320`, `:1347`, `:1492`, `:1748`, `:3058`) — including `load_root_error_page` at `:1492`, the last-resort fallback that rewrites `document.head`/`body`. A throw there means no error page renders at all and the navigation dies.

- **Evidence — Angular, real `@angular/core@22.0.2`:** `createAngularErrorHandler(...).handleError()` throws out to the caller and the chained delegate does not run (verified live). Angular **never** guards a `handleError` call — every shipped call site is bare: `_pending_tasks-chunk.mjs:2642` (`INTERNAL_APPLICATION_ERROR_HANDLER`, the primary uncaught-error path), `_debug_node-chunk.mjs:4353`, `core.mjs:1526`, `_resource-chunk.mjs:62`; a repo-wide search for a `try` around `handleError` in `fesm2022/*.mjs` returns nothing. The `_debug_node-chunk.mjs:4353` site is inside `AfterRenderImpl.execute()`, whose structure is:

  ```
  4339  this.executing = true;
  4345      try { …run afterRender hook… }
  4351      catch (err) { sequence.erroredOrDestroyed = true; this.errorHandler?.handleError(err); }   // unguarded
  4357  this.executing = false;
  4358  for (const sequence of this.sequences) sequence.afterRun();   // + once-sequence disposal
  4365  for (const sequence of this.deferredRegistrations) this.sequences.add(sequence);
  ```

  A faithful replay driving the **real** SDK handler confirmed: the throw escapes `execute()` (i.e. escapes Angular's change-detection tick), `this.executing` is left stuck `true`, and the whole post-loop cleanup is skipped. While stuck, `register()` diverts every new sequence to `deferredRegistrations` (`:4384-4388`) and `unregister()` stops actually deleting sequences (`:4395-4402`), so component teardown leaks them.

- **Fix shape:** contain in the adapter seam (or in `reportError`) and chain in a `finally`, so the customer's handler runs on every path.

### 2. Angular's documented one-line wiring silently deletes the app's `ErrorHandler`

- **Package(s):** angular
- **Where:** `packages/angular/src/error.ts:56-61` (`BugseeErrorHandler`), recommended at `packages/angular/src/error.ts:54-55` and `:4-5`
- **What:** `BugseeErrorHandler` builds its inner handler with `createAngularErrorHandler()` — **no `delegate`** (`:57`). Since the documented wiring is `{ provide: ErrorHandler, useClass: BugseeErrorHandler }`, it *replaces* whatever `ErrorHandler` the application had, and nothing is chained.
- **Why it matters:** an app that provides its own custom `ErrorHandler` and follows the adapter's own recommended snippet loses it entirely, with no warning at build or runtime. Even an app with no custom handler loses Angular's default, which is the only thing that surfaces uncaught errors in the console.
- **Evidence (real `@angular/core@22.0.2`):** Angular's default handler is
  `class ErrorHandler { _console = console; handleError(error) { this._console.error('ERROR', error); } }` (`packages/angular/node_modules/@angular/core/fesm2022/_pending_tasks-chunk.mjs:2623-2628`) — measured live: **1** `console.error` call. Resolving `Injector.create({providers:[{provide: ErrorHandler, useClass: BugseeErrorHandler}]})` and calling `handleError` produced **0** `console.error` calls. DI resolution itself succeeds (zero-arg constructor, no `@Injectable()` needed) — the class is instantiable, it just silently swallows.
- **Note:** the factory `createAngularErrorHandler({ delegate })` does support chaining and is mentioned at `:55`, so the safe path exists — but the lossy variant is the one presented as the primary wiring, and its loss is invisible.

---

## SEV2

### 3. Render-span helpers propagate SDK throws into the render lifecycle (svelte, angular) — unlike Vue's, which is correctly guarded

- **Package(s):** svelte · angular
- **Where:** `packages/svelte/src/render-span.ts:32-37` · `packages/angular/src/render-tracker.ts:50-53` · shared unguarded `active.recordChildSpan(...)` at `packages/web-adapter/src/render-span.ts:37-48`
- **What:** neither wraps `recordRenderSpan`. Vue's equivalent **does** (`packages/vue/src/render-mixin.ts:56-67`, with the correct rationale in the comment at `:66`), which makes the omission in the other two an inconsistency rather than a deliberate policy.
- **Evidence:** real `svelte@5.56.3` compile + `mount()` + `flushSync()`, with the preprocessor's documented injection `onMount(startSvelteRenderSpan('Demo'))`: control (no SDK) and healthy SDK both mount cleanly to `<p>SVELTE-CONTENT</p>`; with a throwing `recordChildSpan` the throw **escaped `mount()`/`flushSync()`** (`SPAN BOOM`). In a real SvelteKit app that caller is kit's client bootstrap (`client.js:702`, `root = new app.root({...})`), so a hydration/boot failure follows. Bounded: a subsequent `mount()` succeeded, so Svelte's global state is not corrupted. The same real-Vue harness confirmed the Vue mixin is **contained** — `mount()` did not throw and the DOM rendered normally with a throwing `recordChildSpan`.

### 4. Under SSR the re-exported `launch` is the **Node** SDK while TypeScript resolves the **browser** umbrella

- **Package(s):** vue · angular · svelte · solid
- **Where:** `packages/vue/src/index.ts:7` · `packages/angular/src/index.ts:7` · `packages/svelte/src/index.ts:7` · `packages/solid/src/index.ts:7` (`export * from '@bugsee/bugsee'`); umbrella conditions at `packages/bugsee/package.json` `exports['.']`; `tsconfig.base.json` (`moduleResolution: "Bundler"`, no `customConditions`)
- **What:** measured, the star re-export contributes exactly **one** runtime value — `launch` — and its identity flips with the resolution condition:

  | condition | `@bugsee/{vue,angular,svelte,solid}`.launch === browser launch | === node launch |
  | --- | --- | --- |
  | node (SSR) | false | **true** |
  | browser | **true** | false |

  Meanwhile TS Bundler resolution matches neither `browser` nor `node` and falls through to `default` → `packages/bugsee/src/index.ts`, the **browser** entry (`launch(appToken, BugseeLaunchOptionsWithPerformance)`).
- **Why it matters:** `@bugsee/nuxt` sits on vue, `@bugsee/sveltekit` on svelte, `@bugsee/astro` above several. A user writing `import { launch } from '@bugsee/vue'` in universal code typechecks against the browser signature but at SSR runtime starts the **Node** SDK (`packages/bugsee/src/index.node.ts`, `BugseeNodeLaunchOptions`) — a different composition root with a different option shape, silently. Note this is a *wrong-SDK / type-divergence* defect, **not** an import crash: see the SSR table below, all four import cleanly on the server.
- **Blast-radius note:** this is the per-package manifestation of the already-reported umbrella condition SEV1; it is listed here because the four adapters are what a meta-framework user actually imports.

### 5. Vue: installing the error handler twice silently doubles every report

- **Package(s):** vue
- **Where:** `packages/vue/src/error.ts:43-49` — `installBugseeErrorHandler` captures `app.config.errorHandler` as `previous` (`:44`) with no idempotence guard, so a second call chains Bugsee to Bugsee.
- **Evidence:** measured — two installs, one dispatched error, **2** `logException` calls.
- **Why it matters:** realistic triggers are a Nuxt/Vite plugin that runs on both the server and client pass, HMR re-execution of the setup module, or a shared bootstrap imported twice. The result is duplicated issues and doubled quota with no signal. The sibling `@bugsee/angular` is immune (DI provides once) and `@bugsee/svelte` is immune (the user exports one hook).

### 6. Svelte: when the preprocessor silently skips a component, `@bugsee/svelte` reports zero render spans with no signal

- **Package(s):** svelte
- **Where:** `packages/svelte/src/render-span.ts:4` and `:23-25` document that `@bugsee/svelte-plugin-component-annotate` injects `onMount(startSvelteRenderSpan('<Name>'))`; the injection lives at `packages/svelte-plugin-component-annotate/src/render-span-inject.ts:38-40`.
- **What:** `@bugsee/svelte` neither depends on nor re-exports the preprocessor (verified: `packages/svelte/package.json` lists only the three `@bugsee/*` deps; the only references are comments). `startSvelteRenderSpan` is exported but nothing in `@bugsee/svelte` ever calls it. Combined with the already-confirmed preprocessor SEV1 (a bare `catch` that silently disables annotation for TypeScript-on-Svelte-4 and for SCSS everywhere), the observable outcome for a user is: **some components simply produce no `ui.render` spans, and neither package emits any diagnostic.** There is no wiring point in `@bugsee/svelte` at which the failure could surface.
- **Mitigating:** the render-span injection is opt-in and defaults to `false` (`packages/svelte-plugin-component-annotate/src/index.ts:26`), which bounds who is affected.

---

## SEV3

### 7. Test theater: no test in any of the four packages ever injects an SDK client that throws — and the two mutations encoding that gap survived

- **Package(s):** vue · angular · svelte · solid
- **Where:** every `fakeClient()` helper returns a `logException` that always resolves: `packages/vue/src/error.test.ts:5-13` · `packages/angular/src/error.test.ts:5-11` · `packages/svelte/src/error.test.ts:5-13` · `packages/solid/src/error.test.ts:5-11`.
- **What:** all 22 `not.toThrow()` assertions across the four packages cover only two situations — "no SDK is launched" (`getClient: () => undefined`) and "a hostile/malformed *component instance*". Neither is the failure mode that matters. Given the confirmed unguarded base and the proven React unmount precedent, the absence of a throwing-client test is itself the finding.
- **Mutation evidence** (harness validated by 3 control mutations, all **CAUGHT**; every file restored from a `cp` backup, `git status --short packages/` verified empty afterwards):

  | mutation | package | result |
  | --- | --- | --- |
  | CTRL drop Vue handler chaining (`error.ts:47`) | vue | CAUGHT (1) |
  | CTRL drop Angular delegate (`error.ts:49`) | angular | CAUGHT (1) |
  | CTRL drop SvelteKit hook return (`error.ts:49`) | svelte | CAUGHT (1) |
  | **H1 swap report/chain order in `installBugseeErrorHandler`** | **vue** | **SURVIVED** |
  | **H2 wrap `reportVueError` in `try {} catch {}` (i.e. apply the fix)** | **vue** | **SURVIVED** |
  | H3 solid route pattern → shallowest match | solid | CAUGHT (2) |
  | H4 vue route pattern → shallowest match | vue | CAUGHT (1) |
  | H5 angular tracker: don't consume `startMs` | angular | CAUGHT (1) |
  | H6 svelte render span: start at mount not init | svelte | CAUGHT (1) |
  | H7 vue mixin: `update` phase → `mount` | vue | CAUGHT (1) |
  | H8 vue annotate: drop idempotence skip | vue | CAUGHT (1) |
  | H9 angular `MAX_ROUTE_DEPTH` 64 → 1 | angular | CAUGHT (4) |
  | H10 `BugseeErrorHandler.handleError` → no-op | angular | CAUGHT (1) |
  | H12 vue: drop the component label | vue | CAUGHT (5) |
  | H13 solid: handler ignores options | solid | CAUGHT (2) |
  | H14 angular: drop `ngOriginalError` unwrap | angular | CAUGHT (1) |

  11 of 13 real mutations caught is a genuinely strong suite. The **only** two survivors are H1 (chaining order — proves nothing pins "the app's handler runs even when reporting fails") and H2 (adding containment is entirely test-neutral, in either direction).

### 8. No package exercises its real framework, and none declares it as a devDependency

- **Package(s):** vue · angular · svelte · solid
- **Where:** `packages/vue/package.json`, `packages/angular/package.json`, `packages/svelte/package.json`, `packages/solid/package.json` — **none has a `devDependencies` field at all** (frameworks appear in `node_modules` only via pnpm's auto-installed optional peers). All four `vitest.config.ts` files set `environment: 'node'` and justify it as "STRUCTURAL PEER … tested injection-first with plain objects".
- **What:** the structural-peer discipline is correct for the *implementation*; applying it to the *tests* means real lifecycle semantics are never exercised. Every finding in SEV1/SEV2 above required standing up the real framework by hand to observe — none is visible from the plain-object fakes. This is precisely how the React `componentDidCatch` unmount escaped its own review.
- **Suggested minimum:** one real-framework containment test per package (real Vue mount, real Solid `<ErrorBoundary>`, real Svelte `mount`, real Angular DI + default `ErrorHandler` chaining) with the frameworks added as devDependencies. All four are already installed and all four harnesses ran in well under a second.

### 9. No SSR import-safety test in any package

- **Package(s):** vue · angular · svelte · solid
- **Where:** `packages/{vue,angular,svelte,solid}/src/reexport.test.ts` (12 lines each) assert only `adapter.launch === umbrella.launch`.
- **What:** nothing pins that importing the package on a server does not throw, and nothing pins which `launch` you get under the `node` condition — the exact divergence in SEV2 #4. Verified manually that all four import cleanly under both conditions, so today the assertion would pass; it just is not written. Also absent: any `*.test-d.ts` (the vitest configs exclude the pattern but no such file exists), so the "manual-API types" claim in each `index.ts:5-6` comment is untested — though note the runtime surface is complete, since `launch` is the umbrella's *only* runtime export.

### 10. Vue render mixin records a span for **every** mount and **every** update by default

- **Package(s):** vue
- **Where:** `packages/vue/src/render-mixin.ts:46` — `const minDurationMs = options.minDurationMs ?? 0;`, applied at `:60`.
- **What:** as a *global* mixin (`app.mixin(...)`), the four hooks run for every component in the app; with the default threshold of `0` every mount and every re-render emits a `ui.render` child span. On a moderately sized app that is hundreds of spans per navigation. The knob exists and the mixin is explicitly opt-in (`:10-11`), so this is a default-tuning concern, not a correctness bug — but `0` is an unusually aggressive default for a span-volume control.

### 11. Doc/code divergence: the Angular `TraceService` described in the design doc was never built

- **Package(s):** angular
- **Where:** `docs/design/frontend-adapters.md:84` ("a `TraceService` subscribes to…") and `:245` ("`@bugsee/angular` (`ErrorHandler` + `TraceService` over…"); no `TraceService` exists anywhere in `packages/angular/src/`.
- **What:** the shipped router integration is instead `setRouteNameFromRouter` (`packages/angular/src/router.ts:48-54`), which the user wires to `NavigationEnd` themselves (documented at `router.ts:8-10`). The design doc should be reconciled to the as-built seam.

### 12. `BugseeErrorHandler` is not an `instanceof` Angular's `ErrorHandler`

- **Package(s):** angular
- **Where:** `packages/angular/src/error.ts:56` — a bare `class BugseeErrorHandler` that does not `extends ErrorHandler`.
- **Evidence:** verified live against real `@angular/core@22.0.2` — `resolved instanceof BugseeErrorHandler` is `true`, `resolved instanceof ng.ErrorHandler` is `false`. DI resolution and `handleError` dispatch both work (duck typing is sufficient for Angular's call sites, all of which do a plain `.handleError(...)`), so this is hygiene: any application or library code that brand-checks the injected handler with `instanceof ErrorHandler` will not recognise it.

---

## Per-package summary

| package | SEV1 | SEV2 | SEV3 | headline |
| --- | --- | --- | --- | --- |
| vue | 1 | 2 | 4 | Proven with real Vue 3.5.38: an SDK throw turns a *survivable* render error into an **empty DOM and a throw out of `app.mount()`** — the customer's own `errorHandler`, which recovered the app without Bugsee, is skipped. Double-install doubles every report. |
| angular | 2 | 2 | 5 | Two independent SEV1s: the documented `useClass: BugseeErrorHandler` wiring **deletes the app's `ErrorHandler`** (0 `console.error` vs Angular's default 1, measured), and a throw escapes into Angular's uniformly **unguarded** `handleError` call sites, leaving `AfterRenderImpl.executing` stuck `true`. |
| svelte | 1 | 3 | 3 | The customer's `handleError` never runs and `undefined` reaches kit's error-page recovery (unguarded at `client.js:2204`, incl. the last-resort `load_root_error_page`). Render-span throw escapes a real `mount()`. |
| solid | 1 | 1 | 3 | Proven with real solid-js 1.9.13: `<ErrorBoundary>`'s **fallback UI never renders** (`dom=""`) and `render()` throws — the boundary is fully defeated. Otherwise the smallest and cleanest of the four. |

## Throw-containment matrix

| framework | integration point | SDK throw reaches framework? | consequence | file:line |
| --- | --- | --- | --- | --- |
| Vue 3 | `app.config.errorHandler` | **YES** (proven, real render) | render-phase error → empty DOM, `mount()` throws, sibling components lost, customer handler skipped, report lost | `packages/vue/src/error.ts:45-48` |
| Vue 3 | render mixin (`beforeMount`/`mounted`/`beforeUpdate`/`updated`) | **no — contained** (proven) | span dropped; mount unaffected | `packages/vue/src/render-mixin.ts:56-67` |
| Vue 3 | component-annotate mixin | **no — contained** | attribute not stamped | `packages/vue/src/component-annotate.ts:42-47` |
| Angular | `ErrorHandler.handleError` | **YES** (proven at the seam; Angular call sites verified unguarded) | escapes the CD tick; `AfterRenderImpl.executing` stuck `true`, post-loop cleanup skipped, later `register()` diverted to `deferredRegistrations`, `unregister()` leaks sequences; delegate skipped | `packages/angular/src/error.ts:47-50`; Angular `_debug_node-chunk.mjs:4353`, `_pending_tasks-chunk.mjs:2642`, `core.mjs:1526` |
| Angular | `createBugseeRenderTracker().end()` (`ngAfterViewInit`) | **YES** | throws inside the customer's lifecycle hook | `packages/angular/src/render-tracker.ts:50-53` |
| SvelteKit | `handleError` hook | **YES** (proven) | customer hook never runs; `undefined` instead of their `App.Error`; kit's error-page recovery receives a throw | `packages/svelte/src/error.ts:43-50`; kit `client.js:2204` (callers `:1226 :1320 :1347 :1492 :1748 :3058`) |
| Svelte 5 | `onMount(startSvelteRenderSpan(...))` | **YES** (proven, real mount) | escapes `mount()`/`flushSync()` → kit client bootstrap fails; recoverable (next mount OK) | `packages/svelte/src/render-span.ts:32-37` |
| Solid | `<ErrorBoundary fallback>` | **YES** (proven, real render) | fallback UI discarded (`dom=""`), `render()` throws | `packages/solid/src/error.ts:28-30` |
| Solid | `catchError(fn, handler)` | **YES** (proven) | throw escapes the reactive root to the caller | `packages/solid/src/error.ts:22-24` |
| all | `setRouteName` / `recordRenderSpan` | **YES** | `ext('performance')` is guarded, but `perf.setRouteName(...)` / `active.recordChildSpan(...)` are not | `packages/web-adapter/src/adapter.ts:65-69`, `packages/web-adapter/src/render-span.ts:37-48` |

## Handler-chaining audit

| framework | pre-existing handler preserved? | file:line |
| --- | --- | --- |
| Vue 3 | **Yes on the happy path** — `previous` is captured and invoked with the original `(err, instance, info)`. **Not preserved when reporting throws** (report runs first, at `:46`). No idempotence guard, so a double install chains Bugsee to Bugsee and doubles reports. | `packages/vue/src/error.ts:44-48` |
| Angular | **Only if the app explicitly passes `delegate`.** The `createAngularErrorHandler({ delegate })` factory chains correctly; the documented `BugseeErrorHandler` `useClass` wiring passes **no** delegate and therefore replaces the app's (or Angular's default) handler outright — **SEV1 #2**. Not preserved when reporting throws either way. | `packages/angular/src/error.ts:49` (chain) · `:57` (no delegate) |
| SvelteKit | **Yes on the happy path** — the app's hook runs and its `App.Error` return is forwarded verbatim (verified live). **Not preserved when reporting throws** (report at `:45` precedes the delegate at `:49`). | `packages/svelte/src/error.ts:45-49` |
| Solid | **N/A by design and correct** — Solid has no global handler slot; the adapter ships only a reporter the user composes into their own `ErrorBoundary` fallback / `catchError` handler, so nothing can be clobbered. Documented at `:6-9`. | `packages/solid/src/error.ts:26-30` |

## SSR import-safety

| package | server import throws? | hydration risk | file:line |
| --- | --- | --- | --- |
| vue | **No** (verified, node condition, 75 ms) | **None from the adapter itself.** The only DOM mutation is `el.setAttribute('data-bugsee-component', …)` in the component mixin, driven exclusively by the client-only `mounted`/`updated` hooks — it cannot run during SSR and so cannot desynchronize markup. Confirmed on a real Vue render: `<div data-bugsee-component="RootCmp">…`, with a fragment-root component correctly skipped. | `packages/vue/src/index.ts:7`; `packages/vue/src/component-annotate.ts:37-48, 52-61` |
| angular | **No** (verified) | none — no DOM writes anywhere in the package | `packages/angular/src/index.ts:7` |
| svelte | **No** (verified) | none — no DOM writes anywhere in the package | `packages/svelte/src/index.ts:7` |
| solid | **No** (verified) | none — no DOM writes anywhere in the package | `packages/solid/src/index.ts:7` |

Importing any of the four on the server **does not** pull `@bugsee/browser` into the loaded-module graph (measured: 0 matching entries). The real SSR concern is not a crash but the wrong-`launch` identity documented in SEV2 #4.

## Checked and found clean

- **Structural-peer discipline holds exactly.** A repo-wide search for a hard import of `vue`, `vue-router`, `@angular/*`, `svelte`, `@sveltejs/kit`, `solid-js` or `@solidjs/router` across all four `src/` trees returns **zero** real imports (the single grep hit, `packages/solid/src/error.ts:8`, is inside a documentation comment). Every entry point takes the framework object as an injected argument, so absence degrades gracefully. Routers are likewise never imported.
- **Route names are parameterized patterns, never raw URLs — no privacy or cardinality leak.** Vue takes the deepest `matched` record's `path` (`packages/vue/src/router.ts:27-33`); Angular joins `routeConfig.path` down `firstChild` into `/users/:id` with a `MAX_ROUTE_DEPTH` cycle bound (`packages/angular/src/router.ts:33-44`); SvelteKit's own route id `/users/[id]` is used verbatim (`packages/svelte/src/router.ts:21-24`); Solid takes the deepest match's `route.pattern` (`packages/solid/src/router.ts:22-28`) — and `@solidjs/router@0.16.1` builds child patterns from the parent's (`dist/routing.js:272`, `createBranches(def.children, route.pattern, …)`), so the deepest pattern is genuinely the full one, and it is derived from the *route definition*, never the URL (`routing.js:219-220`). Critically, **all four no-op when no pattern is available** rather than falling back to a raw URL.
- **Vue does not touch `onErrorCaptured` at all** — verified by search. It therefore cannot accidentally return `false` and swallow the application's own error propagation, which was the specific hazard flagged for review.
- **Vue's two mixins are correctly opt-in** (explicit `app.mixin(...)`, `packages/vue/src/component-annotate.ts:52`, `packages/vue/src/render-mixin.ts:42`), are observe-only, and both guard their DOM/instance reads (`component-annotate.ts:42-47`, `render-mixin.ts:56-67`). The annotate mixin is idempotent (`:43`) and correctly skips fragment/text roots — confirmed on a real Vue render where a two-root component was not stamped.
- **Angular's `ngOriginalError` handling and its version comment are accurate.** A search of the shipped Angular 22.0.2 `fesm2022` bundles finds **no** `ngOriginalError`, exactly as `packages/angular/src/error.ts:18-21` states; the unwrap is a correct no-op on 19+ and still correct on ≤18.
- **Angular DI wiring works without `@Injectable()`** — `Injector.create({providers:[{provide: ErrorHandler, useClass: BugseeErrorHandler}]})` resolves against real Angular 22 (zero-arg constructor). The duck-typed `handleError` contract is what every Angular call site uses, so standalone/NgModule and zone/zoneless all dispatch identically.
- **The declared peer ranges are consistent with the APIs used** — vue `>=3` (`app.config.errorHandler` is Vue-3 shaped), angular `>=16` (verified working against 22.0.2), svelte `>=4` with the deliberate init-only `onMount` choice documented at `packages/svelte/src/render-span.ts:8-9` because `beforeUpdate`/`afterUpdate` are disallowed under Svelte 5 runes, solid `>=1.6`. All are `peerDependenciesMeta.optional`.
- **Single-install re-export is collision-free.** Measured across all four: zero names shadowed between the adapter's own exports and the umbrella, zero suspicious/internal names leaked (`_*`, `Internal*`, `Carrier*`, `ServiceContainer`, `__*`), and no ambiguous star-export exclusions.
- **Coverage is real, not nominal** — `@bugsee/vue` measures 100% statements (64/64), 100% branches (59/59), 100% functions (19/19), 100% lines (53/53) against the configured 100/90 gate.
- **The test suites are strong on the behaviours they do cover** — 11 of 13 targeted real-behaviour mutations were caught, several with multiple failing assertions (H9 → 4, H12 → 5). Route-pattern depth selection, render phase labelling, span-start timing, start-consumption, annotation idempotence, error unwrapping and option threading are all genuinely pinned.
- **Documented §D11 single-slot tradeoffs were re-read and are correctly scoped** (`docs/design/frontend-adapters.md:134`); per instruction they are not reported, and no *additional* single-slot hazard was found in these four packages — none of them touches the active-span slot except through the shared `setRouteName`/`recordRenderSpan` seams.

---

### Review hygiene

All mutations were applied to a `cp` backup and restored from that backup (never `git checkout`). Final `git -C /Users/alexeykarimov/Projects/Bugsee/javascript status --short packages/` is **empty**; the only working-tree entry is `?? docs/review/`, this report's own directory. All framework harnesses ran under the session scratchpad; no network calls were made.
