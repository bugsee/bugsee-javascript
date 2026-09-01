# Capture-API research — frontend frameworks and meta-frameworks

Researcher: frontend/meta-framework subject. Read first: `README.md` (schema + rules) and the shipped
adapters at `packages/{react,vue,svelte,solid,angular,preact-compat,nextjs,nuxt,remix,sveltekit,astro,web-adapter}/src`
(read-only). Every "already built" note below reflects what those adapters do TODAY, so the rows here are
strictly additive.

## Top 5 across all frameworks

1. **Angular Router phase events — `GuardsCheckStart`↔`GuardsCheckEnd`, `ResolveStart`↔`ResolveEnd`,
   `RouteConfigLoadStart`↔`RouteConfigLoadEnd`** (`@angular/router`, all supported versions). The SDK
   already names the active navigation transaction from the router's activated-route snapshot; these four
   paired events turn that single transaction into a real **navigation-phase span breakdown** — a
   guard-execution span, a resolver (data-loader) span, and a lazy-chunk-load span — for free, from a
   public, documented, zero-cost-beyond-subscription API. `NavigationError` on the same event stream is
   also a strictly richer error source than the existing `ErrorHandler` seam (it carries the route `url`
   and target snapshot the bare thrown error doesn't).
2. **React 19 `onRecoverableError`** (`createRoot`/`hydrateRoot` root option, standard since React 18).
   Distinguishes "React recovered from a hydration mismatch" from every other uncaught error — something
   neither the existing `BugseeErrorBoundary` nor the React-19 `onCaughtError`/`onUncaughtError` handlers
   (already built) can say. Production-viable, near-zero implementation cost, directly improves
   error-path fidelity for the single most common SSR-era incident class.
3. **Remix / React Router v7 `middleware` + `clientMiddleware`** (stabilized RR 7.9+). The framework's own
   primitive for wrapping the entire loader/action tree of a navigation — exactly the "**data-loader
   span**" the task brief calls out by name. Brackets server AND client data-fetching as one timed span
   per navigation; requires the app to opt in (same pattern as `BugseeProfiler`), but is the only
   zero-config-adjacent way to get loader/action timing without instrumenting app code directly.
4. **Route-transition span pair: SvelteKit `beforeNavigate`/`afterNavigate` + Astro's
   `astro:before-preparation`→`astro:page-load` chain**. Both frameworks already feed `afterNavigate`-class
   events into the SDK for route-NAME refinement only; neither currently TIMES the transition. Bracketing
   start→visible-and-loaded turns an existing, already-wired hook into a genuine **route-transition span**
   — the second span type the task brief names explicitly — for two frameworks at once, with no new
   capture surface to build.
5. **Nuxt/Nitro `request` + `beforeResponse` hooks**. Today's `@bugsee/nuxt` edge path is honestly
   documented as incomplete ("full per-request context/trace correlation on edge needs Nitro fetch-entry
   wrapping — a v2") because only the framework-agnostic `error` hook is wired. `request`/`beforeResponse`
   fire on BOTH node and edge Nitro presets (unlike the node-only `node:http` emit-patch this SDK relies on
   elsewhere) and, paired, yield a real `http.server` span with a genuine start/end duration — closing a
   documented gap rather than adding a new one.

Runner-up mentions: Pinia `$onAction`/Vuex `subscribeAction` (business-logic action spans, gated hard behind
redaction — see Privacy notes throughout); Preact's `options.diffed` (the one internals-class seam with a
real production story, since Preact has no dev/production split at all); Next.js's own OTel span catalog
(already flows through the existing `otelConsume` bridge — the incremental ask is relabeling, not new
capture, so it just misses the cut for "top 5 net-new work").

## The table

Schema per `README.md`: `API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence`.
Split into per-framework sections for readability; all sections share one schema and concatenate.

### React (18 / 19)

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `createRoot(el, { onRecoverableError })` / `hydrateRoot(el, ui, { onRecoverableError })` | React DOM ≥18, standard root option | `error` (React's synthesized recoverable error) + `errorInfo.componentStack`; fires specifically for hydration mismatches and other errors React recovers from without unmounting — distinct from `onCaughtError`/`onUncaughtError` (already built) | event | NEW — `crash`/`log` labeled `mechanism: hydration-mismatch`, richer attribution than a global handler | Negligible — one callback, fires only on actual mismatches | Standard React DOM API since React 18; production-viable (unlike `<Profiler>`). React calls `console.error` here by default if left unset | Component stack + occasional DOM-diff text could echo rendered content | verified — [react.dev/reference/react-dom/client/createRoot](https://react.dev/reference/react-dom/client/createRoot), [hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot) |
| `error.digest` on an RSC-thrown error | React Server Components ≥18 / Next.js App Router, de-facto (host-framework convention layered on RSC) | In production, an RSC throw's real `message`/`stack` are stripped server-side and replaced with a generic string; only the opaque `digest` id survives to the CLIENT error boundary | event | Correlation label on the client-side error report, joining it back to the FULL server-side report `@bugsee/nextjs`'s `onRequestError` already captures with the real message | None beyond existing boundary cost | Production-ONLY behavior (dev keeps the real message — the inverse of most dev/prod splits here) | The digest is deliberately opaque/safe; upstream message-stripping is the RSC host's own privacy control | verified — [github.com/vercel/next.js/discussions/57699](https://github.com/vercel/next.js/discussions/57699) (React itself doesn't define `digest`; it's a Next.js convention) |
| `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(rendererID, root)` | React DOM (all versions incl. 19), **vendor-only / undocumented internal** — present and callable in production, unlike `<Profiler>` | Full committed Fiber tree per commit (component names, hooks state); `actualDuration` is reported as `0` for every fiber in production builds even though the hook fires | stream — fires every commit, whole app | NEW — could synthesize app-wide `ui.render` spans with zero app wiring, but with degraded (non-numeric) timing in production | High if walking the whole fiber tree per commit; real tools that do this (bippy, react-scan) warn about the cost | Must self-inject the hook object *before* React DOM loads — a real integration constraint | Full component tree/props are walkable — materially larger exposure than the SDK's current DOM-annotation approach | verified (hook existence) — [github.com/aidenybai/bippy](https://github.com/aidenybai/bippy) ("may break production apps... uses React internals which can change at any time"); production zero-duration behavior is documented via secondary sources, not independently confirmed against React source |

**Not recommending** (negative findings, no row): `startTransition`/`useTransition` — `isPending` is a
local boolean only, no timing or priority exposed anywhere observable
([react.dev/reference/react/useTransition](https://react.dev/reference/react/useTransition)). `<Suspense>`
boundary reveal — no official `onSuspend`/reveal callback exists, only the documented 300ms throttle
behavior. `use()`/`cache()` (React 19) — no callback or introspection surface at all. React's
`<Profiler onRender>` is already built (`@bugsee/react` `BugseeProfiler`) — not re-proposed, though this
research confirms `phase` actually carries three values (`mount`/`update`/`nested-update`), not the two the
current span currently distinguishes.

### Preact

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `preact.options.diffed(vnode)` | Preact ≥10, **internal** (options hooks, no leading-underscore alias but explicitly a devtools/debug seam, not stable public API) | Fires after a vnode finishes rendering — the closest Preact analog to React's `onRender`, per-vnode rather than per-subtree; this is the exact hook Preact's own devtools/debug packages are built on | event | NEW — `ui.render` span per component | Moderate — one call per rendered vnode per update | Preact ≥10; doc warns hooks can change "without an extended announcement period" across major versions, but this specific hook is de-facto stable since Preact's own first-party devtools depends on nothing else | Component name/props | verified — [preactjsateway: options guide](https://github.com/preactjs/preact-www/blob/master/content/en/guide/v10/options.md) |
| `preact.options.vnode(vnode)` | Preact ≥10, internal (same doc) | Fires on every VNode creation — component type, props, key | stream — very high frequency (every element) | NEW, but too fine-grained for a render span alone; would need aggregation up to component-commit granularity | High — fires per-element | Same version/stability caveat as `diffed` | Full props tree walkable | verified — same source |
| `preact.options._catchError(error, vnode, oldVNode)` | Preact ≥10, **explicitly internal** (underscore-prefixed; doc states it's "the only hook initialized by default in the core") | The thrown error + the vnode where it occurred, called BEFORE Preact searches ancestors for an error boundary — strictly richer attribution than only wiring `componentDidCatch`, since it fires even when a boundary later handles it | event | NEW — could replace/augment a manual boundary for Preact-native apps | Negligible (only fires on throws) | Underscore-prefixed = explicitly unstable. **Today there is no native `@bugsee/preact` package at all** — Preact users go through `preact/compat` + `@bugsee/react` (confirmed against `docs/design/frontend-adapters.md`), so this hook is currently unused by any shipped adapter | Error + component tree at the fault site | verified (existence + internal framing) — same source |

### Vue (3.x unless noted; Vue 2 called out explicitly)

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `app.config.performance` | Vue ≥3.0, standard | `performance.mark`/`measure` entries per component, labeled by phase (init / compile / render / patch) — a 4-phase superset of the SDK's existing 2-phase render mixin | stream | NEW — finer-grained render-phase breakdown | Effectively free (Vue's own `performance.mark` calls, compiled out of production) | **Dev-only** — no-ops entirely outside development builds | None (timing only) | verified — [vuejs.org/api/application](https://vuejs.org/api/application) |
| `onErrorCaptured` (Composition) / `errorCaptured` (Options) | Vue 2 & 3, standard | `(err, instance, info)` at the COMPONENT level, fired bottom-up BEFORE `app.config.errorHandler` (already built); returning `false` swallows the error | event | Same error/`crash` stream as the existing global handler, but a genuinely earlier interception point per component | Negligible — one hook per instrumented component | Standard, prod + dev | Error message/stack + component name/info, same class as the existing seam | documented — propagation order per [vuejs.org/api/composition-api-lifecycle](https://vuejs.org/api/composition-api-lifecycle); whether a Bugsee mixin hook is guaranteed to run before an app's own same-level `onErrorCaptured` is unverified |
| `app.config.warnHandler` | Vue ≥3.0, standard | `(msg, instance, trace)` — Vue's own internal runtime warnings (invalid prop, missing `:key`, bad template usage) | event | NEW — diagnostic breadcrumb, not an error | Negligible | **Dev-only** — ignored entirely in production | Warning text can echo prop values in some cases | verified — same source |
| `__VUE_DEVTOOLS_GLOBAL_HOOK__` / `@vue/devtools-api` | Vue 2 & 3, **de-facto / vendor-only** (owned by the separate devtools project) | Component-tree events + instance-tree walk, roughly comparable to React's devtools hook | event/stream | NEW — could replace the manual mixin | Near-zero to consume | **Not present in production by default** — gated behind `__VUE_PROD_DEVTOOLS__` (default off); must feature-detect | Full component tree + props — high exposure | unverified — no official spec, community-maintained |
| `<Suspense>` `@pending`/`@resolve`/`@fallback` | Vue ≥3.3, **experimental** (Vue's own docs: "not guaranteed to reach stable status, API may change") | Three discrete lifecycle transitions per async boundary, no data payload | event | NEW span — `ui.suspense` bracketing pending→(fallback\|resolve) | Negligible | Works in prod + dev (only the *shape* is unstable, not gated to dev) | None | documented |
| Hydration-mismatch console warning | Vue ≥3.0 | Console-only warning text; `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__` build flag surfaces the DETAILED message in production console output too | event (via the SDK's existing console interceptor) | Not a new stream — already captured as generic `log`; the incremental value is a Vue-specific classifier tagging the line as a hydration-mismatch breadcrumb | String-matching console output is ~free | Detailed message needs an explicit prod build flag; without it, production gives only a terse generic message | Hydration-mismatch text can include real rendered DOM content | documented flag exists; exact prod-message content unverified |
| Pinia `store.$subscribe` | Vue 3 + Pinia, de-facto standard state library | `mutation.type` (`'direct'`/`'patch object'`/`'patch function'`), `mutation.storeId`, `mutation.payload` (patch-object calls only), new state | stream — fires per mutation | NEW breadcrumb stream — `state.mutation` | One extra call per mutation; needs throttling in chatty apps | Opt-in per store, or global via a Pinia plugin (mirrors `app.mixin`) | **High** — payload/state is raw app state; must run through the redaction pipeline, cannot default-on | verified — [pinia.vuejs.org/core-concepts/state](https://pinia.vuejs.org/core-concepts/state.html) |
| Pinia `store.$onAction` | Vue 3 + Pinia | `name`, `args`, `after(result)`, `onError(error)` — a start/end bracket around an action call | event bracket → span | NEW — `ui.store_action` span (name, duration, success/failure); real value since Pinia actions are typically where async business logic lives | Negligible per call | Global via Pinia plugin, no core-Vue dependency | **High** — args/result are raw app data | verified |
| Vuex `store.subscribe` / `store.subscribeAction` | Vue 2 (and 3 via Vuex 4), standard | `mutation.type`/`payload` or `action.type`/`payload` per dispatch | stream | Same value class as the Pinia rows, for apps still on Vuex | Negligible | Standard | **High** — same raw-state exposure as Pinia | verified — [vuex.vuejs.org/api](https://vuex.vuejs.org/api/) |

### Svelte (4.x options-API and 5.x runes called out separately) / SvelteKit client

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `beforeUpdate`/`afterUpdate` | Svelte **4.x** (and Svelte 5 components NOT opted into runes) — deprecated/disallowed once a component uses runes | Bracket around a component's reactive update pass | event bracket | Fills exactly the update-span gap the shipped `startSvelteRenderSpan` deliberately leaves for Svelte 5 (init-only) — `ui.render` 'update' phase, for legacy (non-runes) components only | Negligible | Svelte 4, or Svelte 5 in non-runes mode; unavailable once runes are used | None | verified — deprecation documented in the [Svelte 5 migration guide](https://svelte.dev/docs/svelte/v5-migration-guide) |
| `$inspect(value).with((type, ...values) => …)` | Svelte **5.x** runes, standard | `type: 'init'|'update'` + the tracked value(s), on every change | event | NEW — a fine-grained, OPT-IN per-value state-change breadcrumb (the app must write `$inspect(x).with(...)` itself; no global auto-wire) | Negligible per call | **Dev-only** — explicit no-op in production builds | Raw value payload | verified — [svelte.dev/docs/svelte/$inspect](https://svelte.dev/docs/svelte/$inspect) |
| `svelte/store` `.subscribe(run, invalidate?)` | Svelte 4 & 5 (stores still interop under runes), standard | Current value synchronously on subscribe + on every mutation | stream | NEW generic state stream, opt-in PER STORE (no compiler-level or global auto-wire, unlike Pinia's plugin system) | Negligible | Standard, prod + dev | **High** — raw store value | verified — [svelte.dev/docs/svelte/svelte-store](https://svelte.dev/docs/svelte/svelte-store) |
| `afterNavigate` → `navigation.type` field | SvelteKit ≥1.0, standard | `'enter'` (initial hydration) \| `'form'` \| `'link'` \| `'goto'` \| `'popstate'` — already present on the object the SDK's `instrumentSvelteKitNavigation` receives today, currently unused | event | Enrichment of the EXISTING naming call (tag hydration-entry vs. real client transition), not a new stream | Negligible — the field is already in hand | Standard | None | verified — `afterNavigate` does fire on initial hydration; see [SvelteKit discussion #10719](https://github.com/sveltejs/kit/discussions/10719) |
| `beforeNavigate` / `afterNavigate` as a timed span pair | SvelteKit ≥1.0, client-side only | `from`/`to` route info, navigation `type`, `willUnload` | event pair → span | NEW — a client route-TRANSITION span (start `beforeNavigate`, end `afterNavigate`) with real duration; today `afterNavigate` is used only to rename the active transaction, never to time the transition | Low — two subscriptions | Client-only | Route pattern only (`/users/[id]`) — no params/query by default | documented |

**Not recommending**: `nextTick()` — a single global microtask-flush boundary with no attribution to which
state change triggered it, not worth a capture row. SvelteKit `handleFetch` — SvelteKit's own
internal-fetch-rewrite seam (URL rewriting / cookie forwarding for `load`-triggered fetches only); the SDK's
existing global fetch capture already sees the same underlying network calls with broader coverage, so
wiring this would double-capture with worse coverage, not add value. SvelteKit per-`load`-function timing —
no zero-config hook exists; timing an individual loader requires instrumenting the app's own `load` export,
out of scope for a framework-level adapter.

### Solid

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `DEV.hooks.{afterUpdate, afterCreateOwner, afterCreateSignal, afterRegisterGraph}` / `DEV.writeSignal` / `DEV.registerGraph` | Solid.js 1.x core — a real, **named** export of `solid-js` (not underscore-private), but explicitly documented as "intended for tooling, diagnostics, and library code" | `afterCreateOwner` ≈ component/effect-scope creation; `afterUpdate` fires after an effect reruns; `afterCreateSignal` fires (with value) on every signal creation | event/stream — very high frequency, every signal write app-wide | NEW — the only realistic render/update-span source for Solid, since no compiler-mixin or built-in Profiler exists | Fires continuously through the app's life; needs aggressive sampling given per-signal frequency | **`undefined` in production and server bundles by design** — no build flag exists to force it on, stricter than Vue's devtools-flag story | Signal VALUES are exposed via `afterCreateSignal`/`writeSignal` — raw app state | verified — [docs.solidjs.com/reference/rendering/dev](https://docs.solidjs.com/reference/rendering/dev) |
| `useTransition()` → `pending()` / `start(fn)` | Solid.js 1.x, standard | `pending()` boolean accessor; `start(fn)` returns a Promise resolving when the transition completes | sample (`pending`) + a Promise the app's own wrapper could time | NEW — `ui.transition` span, but only if the app wraps `start()` with a timing helper (opt-in per call-site, like Angular's manual tracker) | Negligible | Current Solid 1.x; one lower-confidence search result claims removal in a not-yet-released Solid 2.0 in favor of a different `isPending` model | None (boolean/promise only) | documented; the Solid-2.0-removal claim is lower confidence (migration-guide search snippet, not a stable release) |
| Manual `createEffect`/component-body timing wrapper | Solid.js 1.x — **a pattern, not a framework API** | Start/end bracket the app inserts around a component's setup call or an effect body | event bracket | `ui.render` span — the Solid analog of Angular's `createBugseeRenderTracker` | Negligible; requires app code changes per component, opt-in only | No version gate, no framework enforcement | None | documented as a viable pattern by first-principles reasoning about Solid's architecture (component setup runs once — no re-render concept — so this only usefully times INIT, the same limitation Svelte's init-only span has); not a Solid-documented feature |

**Not recommending**: Solid has no `<Suspense>` `onError`/lifecycle-event props comparable to Vue's
`@pending`/`@resolve`/`@fallback` — verified absent; Solid delegates entirely to a separate
`<ErrorBoundary>`, which the SDK already wires.

### Angular (pre- and post-zoneless called out explicitly)

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `ApplicationRef.isStable` | Angular ≥2, standard public API | `Observable<boolean>`; a `false→true` transition marks "app became interactive" (no pending macro/microtasks) | stream — fires on stability transitions | NEW — a time-to-interactive metric/span, or a "never became stable" breadcrumb on timeout | Low — one subscription, runs outside the Angular zone | Zone-based apps in practice; a recurring `setInterval`/`interval()` in the app can permanently starve it (documented false-negative). **Zoneless behavior is unverified** — Angular's docs confirm `NgZone.isStable` pins to `true` under zoneless but say nothing about `ApplicationRef.isStable` specifically; treat as provisional until confirmed | None — boolean only | verified (zone-based) / unverified (zoneless) — [angular.dev/api/core/ApplicationRef](https://angular.dev/api/core/ApplicationRef), [angular.dev/guide/zoneless](https://angular.dev/guide/zoneless) |
| `NgZone.onStable` / `onUnstable` / `onMicrotaskEmpty` | Angular ≥2, **zone-based only** | `onUnstable` fires on VM-turn entry (CD-cycle start); `onMicrotaskEmpty` fires per drained microtask queue (can fire many times per turn); `onStable` fires once, after the last `onMicrotaskEmpty` | stream — paired start/end events | NEW — a `ui.change_detection` span (start `onUnstable`, end `onStable`), with `onMicrotaskEmpty` count as a chattiness attribute | **Non-trivial**: a global CD-turn span fires on EVERY interaction/timer/XHR in a zone-patched app — real production overhead and high span volume, needs sampling before shipping, not a no-op | Requires zone.js (default in zone-based Angular). **Explicitly documented to never fire under zoneless** (Angular ≥18 opt-in, default v21+) — any implementation MUST feature-detect zoneless and fall back rather than silently reporting a permanently-empty stream | None (timing only) | verified — same source |
| `Router` events — `GuardsCheckStart`↔`GuardsCheckEnd` | `@angular/router`, Angular ≥4.1, standard | `{id, url, urlAfterRedirects, state}` on start; end adds `shouldActivate: boolean` — whether the navigation was BLOCKED by a guard | event pair → span | NEW — `nav.guards` child span under the navigation transaction; `shouldActivate:false` is a genuinely useful "why did this route not load" attribute | Low — Router already fires these | Router-only, identical zoneless or not | Route URLs may carry path params, same class as the existing route-naming seam | documented — field shapes via the general Router-events guide, not independently re-fetched per-event this session |
| `Router` events — `ResolveStart`↔`ResolveEnd` | `@angular/router`, Angular ≥4.1, standard | Same `{id, url, urlAfterRedirects, state}` shape, bracketing route-resolver (data-loader) execution | event pair → span | NEW — `nav.resolve` child span; directly comparable to a backend adapter's data-loader span | Low | Router-only, zoneless-safe | Resolved data itself is NOT exposed (timing only) — safe by construction | documented |
| `Router` events — `RouteConfigLoadStart`↔`RouteConfigLoadEnd` | `@angular/router`, Angular ≥4.1 (lazy-loading), standard | `{route: Route}` — brackets a lazy-loaded route chunk's dynamic `import()` | event pair → span | NEW — `nav.lazy_chunk_load` span; catches "the lazy chunk failed to load" at its source rather than only via the terminal `NavigationError` | Low | Router-only; only fires for `loadChildren`/`loadComponent` routes | Chunk path may reveal internal route structure — low sensitivity | documented |
| `Router` events — `NavigationError` | `@angular/router`, Angular ≥2, standard | `{id, url, error, target?: RouterStateSnapshot}` — the router's own capture of a navigation-time throw, including guard/resolver/lazy-chunk failures | event → error report | A BETTER SOURCE than the existing `ErrorHandler` seam for this subset: carries route `url` + target snapshot directly, vs. `ErrorHandler` getting a bare error. Recommend wiring into `reportAngularError` with route-context labels | Negligible | Router-only, zoneless-safe | `url` may carry path params | verified — [angular.dev/api/router/NavigationError](https://angular.dev/api/router/NavigationError) |
| `ng.getComponent()` / `ng.profiler` / Angular DevTools console internals | Angular ≥9 (Ivy debug APIs), **dev-mode only, explicitly undocumented/unstable** — no `angular.dev` API-reference page | Live component instance/injector/listeners for a DOM node; DevTools' own profiler taps the same private Ivy internals | snapshot (console-only) | Do not build on this — no stable identifier, no documented shape | — | **Stripped to no-ops in production builds** — confirmed dev-mode-only, so this is worth little for a shipped app | Could expose component internals/injected services if misused | documented via community sources, not an official reference — appropriately low-confidence |
| Hydration mismatch (`NG0500` family) | Angular ≥16 SSR hydration (`provideClientHydration()`) | A DOM-structure-mismatch diagnostic, location-specific — but the docs describe only console-level surfacing, **no documented programmatic hook** | event (channel unclear) | Unclear whether it reaches `ErrorHandler` (thrown → catchable) or is console-only regardless of environment — this determines scope entirely | — | Requires `provideClientHydration()`; the whole NG0500-NG0504/NG05000 class reads as dev-diagnostic-flavored even though hydration runs in prod | DOM snippet in the error message could contain rendered page content | unverified — could not confirm the delivery channel from official docs; needs source-level verification |

**Not recommending**: `NgZone.onError` — zone.js's own error-forwarding channel, but no verified case exists
where it sees an error `ErrorHandler.handleError` (already built) misses; adding it is redundant without a
demonstrated gap. `Router` `NavigationCancel` — useful only as a FILTER (to avoid reporting a benign
superseded-navigation as an error), not as a new capture stream in its own right. Signals `effect()` — no
documented public introspection API for signal writes or effect scheduling exists today; a negative finding,
not an oversight.

### Next.js (App Router unless noted; Pages Router differences called out)

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `after()` (stable name; `unstable_after` pre-15.1) | Next.js ≥15.1, App Router, node runtime primarily | A callback scheduled to run after the response is sent/flushed — runs even if the request errored or `notFound()`/`redirect()` fired | event | NEW — wrap the app's `after()` callback to emit a background-task span + catch/report a throw inside it. **Unverified** whether a throw inside `after()` already reaches `onRequestError` natively — flag this to a customer rather than assume | Low — one wrapper call, already off the request's critical path | Per Next's own platform-support table: unsupported for Static export, "platform-specific" for third-party Adapters — not automatically available everywhere Next.js itself runs | The docs' own example logs a session cookie from inside `after()` — any span attribute here must go through the same redaction path as everything else | documented (behavior) / unverified (error routing) |
| Next.js built-in OTel spans (`next.span_type`: `BaseServer.handleRequest`, `Render.getServerSideProps`, `Render.getStaticProps`, `ResolveMetadata.generateMetadata`, `AppRender.getBodyResult`, `NextNodeServer.findPageComponents`, …) | Next.js's own instrumentation, App + Pages Router; full catalog needs `NEXT_OTEL_VERBOSE=1` | `next.route`, `next.page`, `next.segment`, `http.method`/`status_code`/`route`/`target` per span type | stream — span tree per request | **Already flows through the existing SDK OTel-consume bridge** (`otelConsume: true` default) once a TracerProvider exists — the incremental ask here is presentation (relabel `next.span_type` values as first-class Bugsee ops, e.g. `Render.getServerSideProps` → a friendly "data loader" span), not new capture | Zero marginal cost — the spans already flow; the ask is a mapping table | Full catalog needs `NEXT_OTEL_VERBOSE=1` (unset → only the root request span visible) | Route/page attrs are patterns, not raw params — low exposure | verified — Next's own instrumentation docs list the exact span-type strings and attributes |
| `fetch [method] [url]` OTel span (`AppRender.fetch`) | Next.js App Router, node+edge, on by default once OTel is wired | `http.method`, `http.url` (FULL url incl. query), `net.peer.name`/`port` | event | **Overlap** — duplicates the SDK's own fetch/network capture once OTel-consume is on; recommend NOT double-instrumenting, prefer the native network-capture entry (which already runs the URL through `sanitizeUrl`) over the OTel-sourced copy for the identical request | N/A (overlap) | Disable via `NEXT_OTEL_FETCH_DISABLED=1` if a customer wants to avoid the duplicate | `http.url` carries the FULL query string, unlike the SDK's own scrubbed network capture — a real token-in-URL risk if this path is consumed uncritically | verified |

### Nuxt (Nitro server-engine hooks)

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| Nitro `request` hook | Nitro (Nuxt's server engine) ≥2.x, fires on EVERY incoming request | `event.path`, method, headers — the request start | event | NEW — open the request span/context at `request` rather than relying on `node:http`'s emit-patch, which **does not exist on edge presets**. This may close the documented "v2: full per-request context/trace correlation on edge needs Nitro fetch-entry wrapping" gap already noted in the SDK's own `nitro-edge.ts` | Low — one hook subscription per server start | Present on BOTH node and edge Nitro presets per docs (unlike the node-only `node:http` patch) — a real edge-parity improvement over what's shipped today | Path/method only if kept as attrs; headers must go through redaction before capture | documented |
| Nitro `beforeResponse` hook | Nitro ≥2.x, fires just before the response is sent, node+edge | `event`, `{ body }` — response status/headers, paired with `request` gives a request DURATION | event, paired with `request` → span | NEW — `request`+`beforeResponse` bracket a real `http.server` span with start/end timestamps, edge-capable; the currently-wired `error` hook alone has no duration at all | Low-moderate — read status/headers only, never buffer/log the body wholesale | Same node+edge availability as `request` | Response body must NOT be captured — only status/size; body content is app data | documented |
| Nitro `close` hook | Nitro ≥2.x, fires on server shutdown | Shutdown signal, no documented payload | event | Minor — a place to force a final `client.flush()` on graceful shutdown | Negligible | Node only in practice (edge isolates have no graceful "close") | None | documented |
| `useRuntimeHook('page:start' / 'page:finish')` | Nuxt ≥3.x composable, client-only (wraps `nuxtApp.hooks`), fires around the `<Suspense>` inside `<NuxtPage>` | Fires on navigation start / when the new page's Suspense resolves | event pair → span | NEW — a client route-TRANSITION span timing the actual page-load/hydration gap, distinct from the already-built `instrumentVueRouter` (which only renames the transaction, never times the Suspense resolution) | Low — two hook callbacks | Client-only, no server equivalent | None | documented |
| Nuxt `app:error` hook | Nuxt ≥3.x, fires on a FATAL app error, server AND client | The thrown error | event | Marginal but real — can fire for errors OUTSIDE Vue's own render/lifecycle (e.g. during Nuxt's own bootstrap) that never reach `app.config.errorHandler` (already wired) — worth a defensive second hook, not a primary one | Low | Server + client | Same as any error report | documented |

**Not recommending**: Nuxt's `vue:error` hook is literally Vue's `onErrorCaptured` bubbling to root, surfaced
under a Nuxt name — the already-wired global `app.config.errorHandler` covers the same errors at the same
granularity; wiring this too is low novel value unless component-LOCAL capture without replacing the global
handler is specifically wanted.

### Remix / React Router v7

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `middleware` (server) | React Router ≥7.9 (stabilized from `unstable_middleware`), opt-in via config or the route `middleware` export | `request`, `context` (typed cross-route data), and a `next()` you `await` that resolves AFTER all nested loaders/actions for the matched route tree run | event → span, brackets the WHOLE loader/action tree for a request, not per-loader | NEW — one span covering all loaders+actions for a navigation/request; this is the "data-loader span" the task brief names directly. **Cannot** time an individual loader/action without app code changes — out of a zero-config adapter's reach | Low — one wrapper around `next()` | Requires the app to explicitly enable middleware AND add the export — not automatic | `context` can carry session/user data the app's own middleware sets — never read it, only wrap timing | documented |
| `clientMiddleware` | React Router ≥7.9, client-side SPA navigations only | Wraps client-side loader execution for a navigation; `next()` resolves with the client dataStrategy results | event → span | NEW — client-side navigation-with-data span, distinct from the already-built `instrumentReactRouter` (which only renames, never times data loading) | Low | Client-only; requires the same middleware opt-in flag | Loader results may carry app data — only time it, don't read result payloads | documented |

**Not recommending**: per-loader/per-action individual timing has no zero-config seam — `middleware`/
`clientMiddleware` bracket the WHOLE tree, and going finer requires instrumenting the app's own loader/action
exports directly, which is out of scope for a framework-level adapter.

### SvelteKit — see the Svelte section above for the client-side rows (`beforeNavigate`/`afterNavigate`,
`$inspect`, `svelte/store`); no additional server-hook rows beyond what's already built (`handle`,
`handleError`) survived this research as net-new.

### Astro

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| View Transitions chain: `astro:before-preparation` → `astro:after-preparation` → `astro:before-swap` → `astro:after-swap` → `astro:page-load` | Astro ≥3.2 (`page-load`/`after-swap`), ≥3.6 (`before-preparation`/`after-preparation`/`before-swap`); requires the `<ClientRouter />` (View Transitions) integration active, client-side only | `before-preparation`: nav started, `event.loader` present; `after-preparation`: new page fetched+parsed; `before-swap`: `event.newDocument`, `event.swap`; `after-swap`: right after DOM swap; `page-load`: once the new page is visible + blocking resources loaded | event chain → span | NEW — bracket `astro:before-preparation`→`astro:page-load` as a client route-transition span (start-to-fully-loaded); richer than the already-built Next.js `onRouterTransitionStart` breadcrumb since Astro's chain gives both a real START and a true visible-and-loaded END | Low — 2 listeners for start/end; the middle events are optional finer-grained sub-spans | **Only fires when the app uses Astro's View Transitions router** (`<ClientRouter />` / `transition:*` directives) — a classic MPA Astro site has none of these events; must feature-detect | Route/URL of the new document — same scrub as any navigation URL | verified |

**Not recommending**: Astro island hydration (`client:load`/`idle`/`visible`/`media`/`only`) — confirmed
ABSENT from Astro's public docs: no custom event, data attribute, or callback is exposed for "island N
finished hydrating." Observing real hydration timing would require patching Astro's internal hydration
runtime — undocumented, version-fragile, and explicitly out of scope per this research's own internals
boundary. This is a genuine gap Astro itself doesn't expose, not an oversight on our part.

## Production-viable vs. dev-only seams

**Hard dev-only (no-op in a standard production build, confirmed against docs):**
- React's `<Profiler onRender>` (already built, already flagged in `packages/react/src/profiler.ts`) —
  needs `react-dom/profiling` to work at all in production.
- Vue's `app.config.performance` and `app.config.warnHandler`.
- Svelte 5's `$inspect(...).with(...)`.
- Solid's `DEV.hooks` / `DEV.writeSignal` / `DEV.registerGraph` — the STRICTEST case of the three: `DEV` is
  `undefined` in production and server bundles **by design**, with no build flag to force it on (stricter
  than Vue's devtools-flag story, where an app CAN opt in).
- Angular's `ng.getComponent()`/`ng.profiler`/DevTools console internals — dev-mode-only, confirmed via
  community sources (no official reference page exists at all).

**Production-viable, with real costs to disclose:**
- React's `onCaughtError`/`onUncaughtError` (already built) and `onRecoverableError` (new, #2 above) — plain
  root options, no special build.
- React's DevTools global hook fires in production, but with degraded fidelity — `actualDuration` reads `0`
  for every fiber, so it is production-*present* but production-*useless* for timing without a workaround.
- `error.digest` is the INVERSE case — present only in production (dev keeps the real message), worth
  remembering when someone assumes "dev-only" means safer to rely on.
- Preact's `options.diffed`/`options._catchError` have no dev/production split at all — always active,
  which is unusual among the internals-class seams researched here.
- Angular's `NgZone.onStable`/`onUnstable`/`onMicrotaskEmpty` run in production too, but are a real
  **production tax**, not a no-op: zone.js's monkey-patch overhead plus firing a span on every
  interaction/timer/XHR is expensive at scale and needs sampling before shipping — a materially different
  risk profile from a true dev-only no-op.
- All five meta-frameworks' server/edge hooks (`onRequestError`, `handleError`, Nitro's `error`/`request`/
  `beforeResponse`, Astro's middleware, RR7's `middleware`) are production-first by construction — these are
  request-lifecycle hooks, not dev tooling.

## Public API vs. internals

**Documented, versioned public API — safe to build on now:** React's `onCaughtError`/`onUncaughtError`/
`onRecoverableError`; Vue's `onErrorCaptured`, `app.config.performance`/`warnHandler`, `<Suspense>` events
(marked experimental in Vue's own docs, so pin behavior to a version range); Pinia/Vuex/`svelte/store`
subscriptions (official ecosystem-canonical state libraries, not framework internals — their risk is
PRIVACY, not stability); Svelte 4's `beforeUpdate`/`afterUpdate`, Svelte 5's `$inspect`, SvelteKit's
`afterNavigate`/`beforeNavigate`; Solid's `useTransition` and `DEV.hooks` (a real *named* export of
`solid-js`, more stable in *shape* than Vue's community-owned devtools hook, even though it is strictly
dev-only in practice); Angular's `ApplicationRef.isStable`, `NgZone.*`, and the full `Router` event
taxonomy; every meta-framework hook researched (`after()`, Next's OTel catalog, Nitro's hooks,
`useRuntimeHook`, RR7's `middleware`/`clientMiddleware`, Astro's View Transitions chain).

**Internals — real seams real tools depend on, but not contractually stable:**
- React's `__REACT_DEVTOOLS_GLOBAL_HOOK__` — used by bippy/react-scan/the React DevTools extension itself;
  those projects' own READMEs warn it "may break production apps" and "uses React internals, which can
  change at any time."
- Preact's `options.*` family — underscore-prefixed (`_catchError`) or otherwise flagged internal; Preact's
  own docs state hooks can change "without an extended announcement period" across major versions.
- Vue's `__VUE_DEVTOOLS_GLOBAL_HOOK__` — community-owned (a separate devtools project), no official spec at
  all, and off by default in production regardless (`__VUE_PROD_DEVTOOLS__`).
- Angular's `ng.getComponent()`/`ng.profiler`/DevTools console globals — Ivy-implementation-coupled, no
  stability guarantee, and dev-only anyway, which caps the downside of relying on them.

**Recommendation: build only on documented, versioned public API for anything the SDK ships default-on or
presents as a core capture stream.** The internals-class seams above are defensible ONLY as strictly
optional, feature-detected, best-effort enrichment that silently degrades to nothing when absent or changed
— never load-bearing, never the sole source of a capture stream — and should ship behind an explicit opt-in
flag with a "may break on a framework upgrade with no warning" note in the docs. Concretely: React's
DevTools hook and Angular's `ng.*` globals are not worth the maintenance burden given the degraded/no
production value already documented above (React: zeroed timings in prod; Angular: dev-only regardless).
Preact's `options.diffed`/`options._catchError` are the one internals-class case worth revisiting — but
only if/when a native (non-`compat`) `@bugsee/preact` package is ever built, since today Preact users are
routed entirely through `preact/compat` + `@bugsee/react` and this hook is unused by any shipped adapter.

## What we would NOT recommend

- **React**: `startTransition`/`useTransition` (no timing/priority exposed anywhere observable), `<Suspense>`
  boundary reveal (no callback API exists, only an undocumented 300ms throttle), `use()`/`cache()` (no
  introspection surface). The DevTools global hook for a general zero-wiring app-wide render-span source —
  feasible, but the instability + zeroed production timings make the risk/value ratio poor next to the
  already-built `<Profiler>` (with its documented caveat) plus the new `onRecoverableError`.
- **Vue**: `nextTick()` (no attribution to the triggering state change). The Vue devtools hook, same
  reasoning as React's — opportunistic only, never load-bearing.
- **Angular**: `NgZone.onError` (no verified gap versus the already-built `ErrorHandler` seam — redundant
  without a demonstrated case). `NavigationCancel` as its own capture stream (filtering value only). Signals
  `effect()` introspection (no documented API exists at all — a negative finding, not an oversight).
- **Solid**: Solid has no `<Suspense>` `onError`/lifecycle props at all — don't invent one; the existing
  `<ErrorBoundary>` wiring is already the framework's actual seam.
- **SvelteKit**: `handleFetch` — overlaps the SDK's existing global network capture with narrower coverage
  (only `load`-triggered fetches); would double-capture the same request while missing others. Per-`load`
  timing without app code changes — no zero-config hook exists.
- **Remix/RR7**: per-loader/per-action individual timing without app code changes — `middleware` only
  brackets the whole tree; going finer is out of scope for a framework-level adapter.
- **Nuxt**: `vue:error` — redundant with the already-wired `app.config.errorHandler` at the same granularity.
- **Next.js**: the `fetch [method] [url]` OTel span — duplicates existing network capture, and worse, carries
  the FULL un-scrubbed query string where the SDK's own network capture already applies `sanitizeUrl`;
  consuming it naively would be a privacy regression, not an improvement.
- **Astro**: island hydration timing (`client:load`/`idle`/`visible`/`media`/`only`) — no documented public
  seam exists; would require patching Astro's internal hydration runtime, which is both undocumented and
  version-fragile. A real gap in what Astro itself exposes, not a shortcut we're declining to take.

## Could not verify

- The exact version-to-version shape changes of React's `__REACT_DEVTOOLS_GLOBAL_HOOK__` across 16→18→19 —
  corroborated only by secondary sources (bippy's README, general search summaries), not by reading
  `react-devtools-shared` source directly.
- Vue's exact production hydration-mismatch message content without `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`
  set (no primary-source example found); whether a Bugsee-installed `onErrorCaptured` mixin is guaranteed to
  observe an error when the SAME component ALSO defines its own same-level `onErrorCaptured` returning
  `false`; `__VUE_PROD_DEVTOOLS__`'s default consistency across build tools.
- The claim that Solid 2.0 removes `useTransition`/`startTransition` — sourced from a single migration-guide
  search snippet, not a stable Solid 2.0 release (not generally available at research time).
- Whether `ApplicationRef.isStable` (as opposed to `NgZone.isStable`, which IS documented) behaves
  meaningfully under zoneless Angular — the docs are silent on this specific API; whether Angular's NG0500
  hydration-mismatch diagnostic is delivered via a throw (reaching `ErrorHandler`) or console-only regardless
  of environment; exact field shapes of `GuardsCheckStart`/`GuardsCheckEnd` and `ResolveStart`/`ResolveEnd`
  (existence and general shape confirmed, individual API-reference pages not independently re-fetched this
  session).
- Whether a throw inside Next.js's `after()` callback is automatically routed to `onRequestError` — the
  official docs describe `after()`'s own semantics but say nothing about error-reporting integration.
- Nitro's exact hook-firing behavior on non-Vercel edge presets (Cloudflare Workers vs. Netlify Edge)
  specifically for `request`/`beforeResponse` — reconstructed from search snippets and a related Nuxt doc
  page rather than Nitro's own current hooks reference (which did not resolve during this research);
  recommend a direct spike against a real Nitro app on each target preset before committing to this as the
  edge per-request-context fix.
- Nuxt's `useRuntimeHook` execution context (server vs. client vs. both) — inferred client-primary from its
  component-unmount cleanup behavior, not explicitly confirmed for server usage.
