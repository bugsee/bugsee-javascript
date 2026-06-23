# Frontend adapters — design (Draft v1, 2026-06-23)

Status: **IN PROGRESS.** F0 (backend CORS) + F1 (navigation foundation) BUILT + reviewed-to-convergence on
`master`; F2–F7+ pending. Supersedes the brief "Frontend hooks" stub in
`docs/design/cross-project-tracing.md` (§"Frontend hooks"). Builds on the completed cross-project tracing
backend (X0–X5/Y1/X3b/X4) and the existing `@bugsee/performance` (web-vitals + pageload) + `@bugsee/browser`.

User-chosen scope (2026-06-23):
- **Foundation + tracing first**, THEN thin per-framework adapters. **React first → fan out** to vue/svelte/
  angular/nextjs.
- **Full cross-origin return path** (read both `Server-Timing` + `traceresponse`; extend the backend X4 to
  also emit `Timing-Allow-Origin` + `Access-Control-Expose-Headers`).
- **Non-goals (this milestone):** session replay (rrweb), React Native (separate SDK).

---

## 1. Competitive research (facts, primary-sourced 2026-06-23)

Five parallel research agents over Sentry, OpenTelemetry-JS + Grafana Faro, Datadog RUM + New Relic Browser,
Firebase + Bugsnag + LogRocket, and the raw web-platform mechanics (MDN/W3C). Facts only; inferences marked.
(Full sourced briefs retained in the session transcript; key URLs inline where load-bearing.)

### 1.1 Convergent industry patterns
- **The SPA model is universal: pageload vs navigation vs interaction.** Sentry (`pageload`/`navigation`
  transactions), Datadog (`loading_type: initial_load | route_change` *views*), New Relic (`BrowserInteraction`),
  Bugsnag (full-page-load vs route-change spans). A FE "root activity" = a transaction. Our §8.8 transaction
  model already fits this exactly (and we map transactions→OTLP spans via `to-otlp`).
- **SPA route detection = History-API monkey-patch + `popstate` + `hashchange`.** Hard fact (MDN):
  `popstate` does **not** fire on `pushState`/`replaceState`, so those MUST be wrapped. New Relic names
  `pushState`/`replaceState`/`popstate` explicitly; Datadog uses the History API (+ `HashChangeEvent`).
- **Parameterized route names are table stakes** (`/users/:id`, not `/users/123`), supplied by per-framework
  router integrations. Sentry's **Angular two-phase pattern** is the cleanest copyable design: start the span
  with the **raw URL** on `NavigationStart`, then **rename to the parameterized route** on `ResolveEnd` and tag
  a provenance attribute (`source: 'url' | 'route'`). A manual `startView()`/`setCurrentRouteName()` escape
  hatch is universal (Datadog `startView`, New Relic `setCurrentRouteName`, Sentry `beforeStartSpan`).
- **Idle-transaction lifecycle** closes open-ended SPA transactions. Sentry: `idleTimeout 1000ms` (finish when
  no unfinished child for that long) / `finalTimeout 30000ms` (hard cap) / `childSpanTimeout 15000ms` +
  background-cancel (mark cancelled when the tab hides). We need an equivalent.
- **Web-vitals on SPAs:** LCP/FCP are reported on the **initial view only**; **CLS/INP on every view**
  including route changes (Datadog explicit; aligns with Chrome's Soft Navigations stance). The official
  `web-vitals` lib (which `@bugsee/performance` already mirrors) is the measurement layer; its
  `web-vitals/attribution` build gives INP phase breakdown (inputDelay/processingDuration/presentationDelay) +
  `interactionTarget`.
- **Interaction tracing = the Event Timing API.** `PerformanceEventTiming.interactionId` ties the events of one
  interaction (pointerdown/up/click) together — the INP unit. `PerformanceObserver({type:'event'})`,
  `durationThreshold` (min 16ms). Chromium-biased (CLS Chromium-only); degrade gracefully cross-browser.

### 1.2 The two hard browser constraints
1. **What the FE can read back cross-origin (decisive for our X4 return path):**
   - `Server-Timing` → readable via `PerformanceResourceTiming.serverTiming`, **cross-origin requires the
     server to send `Timing-Allow-Origin`** (NOT `Access-Control-Expose-Headers`); else the entry is opaque
     (duration 0, description ""). Works for **any** resource, even ones the SDK did not issue (passive).
   - `traceresponse` (custom header) → readable via the fetch `Response.headers`, **cross-origin requires
     `Access-Control-Expose-Headers: traceresponse`** AND the SDK must own the fetch call (active).
   - These are the **only two channels**, each needs a **different** server opt-in header, each has different
     reach. → validates X4's dual-emission; surfaces the **gap: backend X4 emits the headers but not the
     CORS-exposure headers**, so cross-origin reads fail until it does (closed by §5 below).
   - Same-origin: both fully readable, no extra server headers.
2. **Distributed tracing is INJECT-ONLY industry-wide.** Sentry, OTel-JS, Datadog, New Relic, Bugsnag all
   inject request headers and **none reads a response header to adopt the backend span** (Sentry has an *open
   request*, #14210, for Server-Timing). → **Reading the return path is a genuine Bugsee differentiator.** The
   server→client **pageload** link is instead universally an injected **`<meta name="traceparent">`** the
   client reads on load (OTel `document-load`, Sentry SSR `getTraceMetaTags()`).

### 1.3 OTel-compat note (we are OTel-interoperable)
OTel's browser model has bifurcated: **spans** for fetch/xhr (`http.client`) + the initial document-load tree;
**events** (OTLP log records) for web-vitals (`browser.web_vital`), navigation (`browser.navigation`),
user-action (`browser.user_action.click`), errors, console (the newer `open-telemetry/opentelemetry-browser`
repo). OTel has **no first-class SPA-navigation span**. Our model differs deliberately: a FE root activity is a
**transaction** (→ OTLP root span via `to-otlp`), matching Sentry/Datadog/New Relic. We stay
wire-interoperable by keeping network/pageload as spans and (optionally, later) mirroring web-vitals as the
`browser.web_vital.*` attributes/events OTel uses. Resource attrs `browser.brands/platform/mobile/language`
are cheap parity wins.

### 1.4 Per-framework adapter shapes (what to copy)
- **React:** `ErrorBoundary` + `withErrorBoundary` HOC + (React 19) an `onUncaughtError`/`onCaughtError` global
  handler; the component stack is linked to the error via **`error.cause`** (Sentry `LinkedErrors`). react-router
  v6/v7 integration supplies parameterized names (wrap `createBrowserRouter` / instrument `<Routes>`). Datadog
  ships `@datadog/browser-rum-react` (react-router v6/v7 + TanStack); Faro `@grafana/faro-react`.
- **Vue:** pass the `app` to init → registers `app.config.errorHandler`; router via the integration, `routeLabel:
  'name' | 'path'`.
- **Angular:** provide a `createErrorHandler()` as the `ErrorHandler` token; a `TraceService` subscribes to
  `Router.events` (the two-phase naming).
- **Svelte/SvelteKit:** `handleError` hook + a Vite plugin.
- **Next.js:** three runtimes (client `instrumentation-client.ts` / server / edge), `instrumentation.ts`
  `register()`, `onRequestError`, build wrapper, `app/global-error.tsx`, and the SSR→client `<meta>` link.
- **Firebase gap = our opening:** Firebase Perf has **no SPA route-change auto-traces, no distributed tracing/
  `traceparent`, and no browser crash SDK** (Crashlytics is mobile-only) — a clear differentiation for the web
  tier. Bugsnag is the closest API-parity target for FE error capture; LogRocket is replay-first.

---

## 2. Understanding summary

- **What:** a framework-agnostic browser **foundation** that (a) opens a **transaction per pageload /
  navigation / interaction**, (b) **reads** the backend's `Server-Timing`/`traceresponse` to refine the FE
  network span and complete FE↔BE↔FE one-trace, (c) exposes a **route/interaction naming seam**; then **thin
  per-framework adapters** (React first) that plug route + error context into it.
- **Why:** complete the cross-project trace on the frontend (the backend half is done) and give framework apps
  idiomatic error + performance instrumentation. No competitor reads the return path — a differentiator.
- **For whom:** browser SPA apps (React/Vue/Svelte/Angular/Next.js); the foundation also serves vanilla JS.
- **Builds on:** `@bugsee/performance` (transactions, web-vitals, pageload), `@bugsee/browser` (global error +
  network capture), `@bugsee/capture` (fetch/xhr interceptors, the X3b traceparent+bugsee= decorator), X4
  (the backend now EMITS the return headers).
- **Non-goals (this milestone):** session replay (rrweb), React Native, the OTel events-vs-spans re-modelling.

### Assumptions (mark any wrong)
- A1. The FE root activity is a **transaction** in our existing `@bugsee/performance` model (NOT a new OTel
  "event" type). Navigation/interaction are transactions with `operation: 'navigation' | 'ui.interaction'`.
- A2. The foundation is **umbrella-wired** (like the existing browser performance + propagation), not in the
  bare `@bugsee/browser` package (it needs the performance extension's active transaction).
- A3. Cross-origin return path is acceptable to gate behind the backend also emitting TAO + ACEH (a backend
  config the app owns), and reads degrade to same-origin when those are absent.

---

## 3. Decision log

| # | Decision | Rationale / source |
|---|----------|--------------------|
| D1 | **FE root activity = a `@bugsee/performance` transaction** (pageload / navigation / interaction). Web-vitals attach to it; it maps to an OTLP root span via `to-otlp`. | Matches Sentry/Datadog/NR + our existing transaction model; OTel's "navigation=event" is a deliberate divergence, kept wire-interoperable. |
| D2 | **Navigation detection = History-API patch (`pushState`/`replaceState`) + `popstate` + `hashchange` as the floor; feature-detect-upgrade to the Navigation API (`navigation` 'navigate' event) where present.** | `popstate` doesn't fire on pushState (MDN); Navigation API only "Newly Baseline" early-2026 (FF147/Safari26.2) → can't be sole mechanism. NR/DD use History API. |
| D3 | **Return path = read BOTH channels: `Server-Timing` via `PerformanceResourceTiming.serverTiming` (passive) + `traceresponse` via the owned fetch `Response` (active); extend backend X4 to emit `Timing-Allow-Origin` + `Access-Control-Expose-Headers` (config-gated) for cross-origin.** | The two channels have different reach + need different server headers (MDN/W3C). The differentiator. User: "full cross-origin support". |
| D4 | **SSR→client pageload trace continuation via an injected `<meta name="traceparent">` (+ `bugsee=`) the client reads on load** (instead of a new root trace). The backend adapters inject it into SSR HTML. | Universal pattern (OTel document-load, Sentry `getTraceMetaTags`). Backend has no readable inbound traceparent on a top-level document navigation. |
| D5 | **Naming = two-phase (raw URL on navigation-start → parameterized route on resolve, with a `source: 'url'\|'route'` provenance attr) + a manual `setRouteName()/startView()` escape hatch.** | Sentry Angular pattern; universal escape hatch (DD/NR). |
| D6 | **Web-vitals attribution: LCP/FCP on the initial pageload transaction only; CLS/INP on every transaction incl. navigations.** | Datadog-explicit; Chrome Soft-Navigations stance. |
| D7 | **Idle-transaction lifecycle**: finish a nav/interaction transaction after an idle gap with no open child (default ~1s), a hard cap (~30s), per-child timeout, and background-cancel on tab hide. **F1: idle + final + background-cancel BUILT; `childSpanTimeout` (Sentry's per-child 15s cap) DEFERRED** — the idle-keepalive + the final cap cover the runaway case. Also: "child activity" == NETWORK activity for now (the keepalive resets on fetch/xhr start+end); DOM/interaction keepalive is F4. | Sentry idleTimeout/finalTimeout/childSpanTimeout + markBackgroundSpan. |
| D8 | **React first**, then fan out. Adapter = framework error seam (`ErrorBoundary`/`withErrorBoundary`, componentStack via `error.cause`) + router→naming seam (react-router v6/v7). | User choice; backend precedent (express-first). |
| D9 | **OTel-interoperable, not OTel-shaped.** Keep transactions→spans; defer the `browser.*` events re-modelling. Add `browser.*` resource attrs as a cheap parity win. | We are OTel-compatible (Y1/X2); full event re-modelling is out of scope. |
| D10 | **Navigation lives in `@bugsee/browser` as an EXTENSIBLE pub/sub SOURCE.** Framework adapters both REFINE built-in (browser-global) navigations AND EMIT their own for URL-less framework navigations (virtual/tab/modal routes). **F1 delivers the EMIT half** (`startNavigation()`); the **REFINE half** (renaming the in-flight nav's route on the active transaction) is **F5** (the naming seam, D5) — `collectNavigations` keeps the active handle private until then. | User direction; the thin-kernel pub/sub model (sources are listenable; adapters are additional sources/refiners) — same shape as the backend server-instrument. |
| D12 | **Pageload + navigation transactions COEXIST (F1).** The pageload owns the initial load + web-vitals and finishes on tab-hide (web-vitals-coupled, NOT idle); navigations own route changes (idle-finished). The single active slot (D11) follows the MOST RECENT — `http.client` spans attach to whatever is active. The first navigation does NOT finish the pageload (it lingers to capture page-session vitals through hidden). | Our pageload is web-vitals-coupled, unlike Sentry (which finishes the pageload on the first route change). Per-navigation vitals (D6) + a possible pageload-handoff are a later slice. |
| D11 | **Browser active-context = the performance ext's single-slot `getActiveSpan` (correlation-by-tagging to the current activity), NOT AsyncLocalStorage.** In-flight fetch/xhr attach to the one open pageload/navigation/interaction transaction; the async tail of an interaction is captured by a bounded **activity window** (count in-flight requests / DOM activity, close on idle). zone.js-style async-propagation is a deferred opt-in. | RESEARCH (facts): the browser is single-threaded / run-to-completion with no request concurrency (MDN), so a single "current activity" pointer suffices — exactly what **Sentry-browser** (attach-to-root-span; "async context in browser still not implemented") and **OTel's default `StackContextManager`** ("doesn't fully support async") do. Datadog uses a current-view-by-time + click activity-window. Only New Relic pays for full API-wrapping (its own zone.js-equivalent). Sentry registers AsyncLocalStorage only on Node, nothing on browser — mirrors our server-ALS / browser-tagging split. |

---

## 4. Architecture — the framework-agnostic foundation

Mirrors the backend's split (platform package detects → calls `@bugsee/performance` via `client.ext`; tier-4
adapters refine + name), so the FE reuses the proven seam shape:

```
@bugsee/browser (platform: browser-global hooks)        @bugsee/performance (APM, umbrella-wired)
 ├─ navigation-source       ── perf.startTransaction ──▶  ├─ navigation / interaction transactions
 │   History patch + popstate + hashchange                │   (operation: navigation | ui.interaction)
 │   ↑ upgrade: Navigation API                            ├─ idle-transaction lifecycle (D7)
 ├─ interaction-instrument  ── perf.startTransaction ──▶  ├─ web-vitals attribution (D6) [exists, extend]
 │   Event Timing (interactionId)                         ├─ pageload transaction [exists]
 ├─ pageload <meta> reader   ── perf.continuation ─────▶  └─ route/interaction NAMING seam (setRouteName)
 │   <meta name=traceparent> + bugsee=  (D4)
 └─ return-header reader     ── refine http.client span ─▶  (network span refinement)
     Server-Timing via PerformanceResourceTiming + traceresponse via owned Response  (D3)

@bugsee/capture (shared)                  tier-4 adapters (@bugsee/react first)
 └─ fetch/xhr interceptor exposes the      └─ ErrorBoundary + router → naming seam (D8)
    response Server-Timing/traceresponse
    to the return-header reader
```

Key components (all new unless noted):
1. **`navigation-source` (`@bugsee/browser`, `createBrowserNavigationSource`) — an EXTENSIBLE navigation SOURCE** (D10) [BUILT, F1]. It is a listenable
   pub/sub source (extends the core multi-key emitter / interceptor base, like every other source — the
   thin-kernel pub/sub model). It has two halves:
   - **Built-in browser-global detectors** (History `pushState`/`replaceState` patch + `popstate` + `hashchange`,
     upgraded to the Navigation API where present). On a detected route change it emits a navigation event;
     the foundation finishes the previous nav transaction (idle) and starts a new one (`operation:
     'navigation'`, raw-URL name, `source: 'url'`). Self-skips when the globals are absent (SSR/worker).
   - **A public extension API for framework adapters** (the key requirement): an adapter can (a) **REFINE** an
     in-flight navigation — set the parameterized route name (the two-phase naming, like the backend's refining
     handle), and (b) **EMIT its OWN navigation event** — `startNavigation({ name, source })` — for framework
     navigations that do NOT switch the browser origin/path (virtual routes, tab/modal/wizard steps, an RSC
     transition that never touches History). The adapter thus becomes a first-class navigation *source*, not
     just a refiner. Built-in and adapter-emitted navigations are handled by ONE uniform path.
2. **`interaction-instrument` (`@bugsee/browser`)** — Event Timing observer; on a qualifying interaction starts
   a short interaction transaction. In-flight fetch/xhr attach to the active transaction via the single-slot
   `getActiveSpan` (D11); the interaction's async tail is captured by a bounded activity window (Datadog-style)
   rather than zone.js (O1 resolved).
3. **Idle-transaction lifecycle (`@bugsee/performance`)** — D7. Generalizes the existing transaction finish.
4. **Return-header reader (`@bugsee/browser` + `@bugsee/capture`)** — D3. The capture fetch/xhr interceptor
   already clones the response; expose its `Server-Timing`/`traceresponse`. The reader refines the
   `http.client` span (and can adopt the backend span id as the child link). Passive `PerformanceObserver
   ({type:'resource'})` reads `serverTiming` for non-instrumented/cross-origin-TAO resources.
5. **Pageload `<meta>` continuation (`@bugsee/browser`)** — D4. Read `<meta name="traceparent">` + the
   `bugsee=` state on boot; continue that trace for the pageload transaction (reusing the existing
   `continuation` API from X2) instead of starting fresh.
6. **Naming seam (`@bugsee/performance`)** — D5. `setActiveTransactionName(name, { source })` + a public
   `startNavigation()/setRouteName()` for the manual escape hatch; the adapters call it.
7. **`@bugsee/browser` launch wiring** — install the detectors when the performance extension is present
   (umbrella), gated by options (`tracePageload`/`traceNavigations`/`traceInteractions` — names TBD).

---

## 5. Backend X4 cross-origin extension (closes the return-path gap, D3)

The backend (`@bugsee/node` server-instrument + the http/native serve wraps) currently emits `traceresponse` +
`Server-Timing` but NOT the CORS-exposure headers, so the FE cannot read them cross-origin. Extend the X4
`traceResponse` option to ALSO emit, config-gated:
- **`Timing-Allow-Origin`** (so `Server-Timing` is exposed to `PerformanceResourceTiming.serverTiming`
  cross-origin) — value from a configured allowlist or `*`.
- **`Access-Control-Expose-Headers: traceresponse`** (so the FE can `response.headers.get('traceresponse')`).
Same write sites as X4 (node:http `setHeader` at open; native-serve append/set). Default off (these only
matter once a cross-origin FE consumes them); on when the FE return-path is in use. Test-first + the same
mutator/review discipline.

> **STATUS — F0 BUILT (2026-06-23, on `master`).** The X4 `traceResponse` option gained `timingAllowOrigin?:
> string | readonly string[]` (emits `Timing-Allow-Origin` alongside `Server-Timing`, list-joined) and
> `exposeTraceresponse?: boolean` (appends `traceresponse` to `Access-Control-Expose-Headers`). Each is gated
> on its trace header being on (only expose what we emit). The native-fetch path APPENDS the CORS list headers
> (coexist with the app's own); node:http sets at open. Flows through all three launches via the existing
> `traceResponse` forwarding (no launch change). Mutation-verified; node 100%/98.6%, repo green.

---

## 6. The React adapter (Phase 2, after the foundation)

`@bugsee/react` (structural-peer; React is a devDep/peer, never imported into shared code):
- **Error seam:** `BugseeErrorBoundary` component (catch subtree → `logException` with the React component
  stack linked via `error.cause`, + fallback UI) and a `withBugseeErrorBoundary` HOC; optionally a React-19
  `onUncaughtError`/`onCaughtError` global handler. Dedup consistent with the core.
- **Router naming:** react-router v6/v7 integration — wrap `createBrowserRouter`/instrument `<Routes>` to set
  the **parameterized** route on the active navigation transaction via the naming seam (D5, two-phase).
- Probed against the real React + react-router (e2e), like the backend adapters were.

---

## 7. Fan-out (Phase 3)

Replicate the adapter pattern over the foundation: `@bugsee/vue` (`app.config.errorHandler` + vue-router),
`@bugsee/svelte`(+kit) (`handleError` + Vite plugin), `@bugsee/angular` (`ErrorHandler` + `TraceService` over
`Router.events`), `@bugsee/nextjs` (client/server/edge + the SSR `<meta>` injection — the highest-value, most
complex; closes FE↔BE in one app). Each: per-framework error seam + router→naming, probed against the real
framework first (table per adapter, as the backend did).

---

## 8. Implementation slices (each: test-first → per-entity mutator → multi-agent review → commit)

- **F0** [DONE 2026-06-23] Backend X4 CORS extension (§5) — `timingAllowOrigin` + `exposeTraceresponse` on the
  `traceResponse` option; unblocks cross-origin FE reads.
- **F1** [DONE 2026-06-23] Navigation detection (`@bugsee/browser` History-patch + Navigation-API upgrade) →
  navigation transactions, idle lifecycle (D2, D7, D10-emit, D11, D12). Built as F1a (idle-transaction,
  `@bugsee/performance`) + F1b (the extensible navigation source, `@bugsee/browser`) + F1c (`collectNavigations`
  + `wirePerformance` wiring) + the umbrella connection (`traceNavigations`, browser-only). Reviewed-to-
  convergence (3-agent: 0 SEV1; closed 3 SEV2 test-strength gaps + doc deferrals for D7 `childSpanTimeout` /
  D10 refine→F5). The keepalive is network-only (DOM/interaction is F4); the refine/naming seam is F5.
- **F2** [DONE 2026-06-23 — continuation half] Pageload `<meta name="traceparent">` continuation (D4):
  `readMetaTraceContinuation` (`@bugsee/browser`, reads `<meta name=traceparent>` → parses via capture's
  `parseTraceparent` → a child continuation; fully guarded) threaded through `wirePerformance`
  `pageloadContinuation` → `collectPageLoadVitals` (the pageload adopts the server trace id + becomes a child
  of the server span). Umbrella reads it browser-only. Mutation-verified + umbrella integration test (`<meta>`
  → pageload joins the SSR trace). **DEFERRED: the `browser.*` resource attrs (D9)** — a cheap OTel-parity add
  (browser.brands/platform/mobile/language from navigator.userAgentData), OTLP-tee-only + orthogonal; small
  follow-up.
- **F3** [DONE 2026-06-23 — active path] Return-header READER (D3, the cross-project differentiator F0
  unblocked). In `@bugsee/performance/http-spans.ts`: on a completed request, read the backend `http.server`
  span id from the response's `traceresponse` (preferred) / `Server-Timing: traceparent;desc="…"` (fallback)
  header — already captured in the NetworkEvent's `custom.headers` for SDK-owned requests — and stamp it on
  the FE `http.client` span as `bugsee.server_span_id` (the FE↔BE link recorded on the frontend side). Parsed
  inline (performance has no capture dep); case-insensitive; rejects invalid/zero ids. Mutation-verified +
  a `wirePerformance` e2e test. NO competitor reads this. **DEFERRED: the PASSIVE `PerformanceObserver`
  (`PerformanceResourceTiming.serverTiming`) path** — for resources the SDK did NOT issue (cross-origin,
  TAO-gated); the active path covers the common SDK-owned case. Follow-up F3b.
- **F4** Interaction transactions (Event Timing) + the active-context binding (O1) (D6 INP attribution).
- **F5** The naming seam (D5) + the manual `setRouteName()/startNavigation()` API.
- **F6** `@bugsee/react` — ErrorBoundary + react-router naming (Phase 2).
- **F7+** fan-out: vue / svelte / angular / nextjs (Phase 3).

(F0–F5 = the foundation milestone; F6 proves the adapter pattern; F7+ fan out.)

---

## 9. Open questions / to resolve in design

- **O1. [RESOLVED 2026-06-23 — research-backed]** Use the performance ext's **single-slot `getActiveSpan`**
  (correlation-by-tagging to the current activity); NO browser AsyncLocalStorage. Matches Sentry-browser
  (attach-to-root-span) and OTel's default `StackContextManager`. The async tail of an interaction is captured
  by a bounded **activity window** (Datadog-style), not zone.js. Full zone.js-style async propagation = a
  deferred opt-in (only New Relic pays that cost). See D11.
- **O2. [RESOLVED 2026-06-23]** Navigation/interaction detection lives in **`@bugsee/browser`** as an
  **extensible pub/sub source** (D10): browser-global detectors built in; framework adapters refine in-flight
  navigations AND emit their own (URL-less framework navigations). Calls `@bugsee/performance` via `ext`.
- **O3. Option surface.** Backend (F0, LOCKED): `traceResponse.{timingAllowOrigin, exposeTraceresponse}`.
  FE foundation (later slices, proposed): `traceNavigations`/`traceInteractions`/`readReturnHeaders` — names +
  on/off defaults TBD at F1/F3/F4 (web-vitals/pageload are on via the umbrella today).
- **O4. OTel events (deferred):** whether/when to ALSO emit `browser.web_vital`/`browser.navigation` OTLP
  events for OTel-native consumers, or keep transaction-only.
- **O5. Replay (out of scope) integration seam** — leave a clean hook but build nothing.
