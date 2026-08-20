# Sample applications — sweep, plan and verification protocol

Status: **active**. Owner: this doc is the contract every sample author (human or agent) works from.

## 0. Why this exists

Before the JavaScript SDK is published we need evidence that each package works — not in a test
harness, but in a real application, installed the way a customer installs it, sending real data to a
real Bugsee backend. Unit tests, mutation tests and property tests cover the code; they cannot cover
the *artifact* (the `dist` bundle, the `exports` map, the declared dependencies) or the *round trip*
(does the bundle arrive, is it processed, is the data on the issue correct?).

Each sample therefore has three jobs, in priority order:

1. **Be a usable application.** A customer clones `samples/<name>`, sets an app token, runs one
   command, and gets something that does real work — a working web app, a working API.
2. **Exercise the package under test exhaustively.** Every exported function, every launch option,
   every capture source, every failure mode.
3. **Verify the data end to end** against Bugsee staging via MCP, and record every discrepancy in
   `samples/<name>/FINDINGS.md`.

Sample authors **never fix SDK code.** A defect found is a finding, written down, triaged later.

## 1. Package sweep

55 workspace packages. Three buckets.

### 1a. Sampled directly — a package a customer installs, so it gets an application

| Sample | Packages under test |
| --- | --- |
| `browser-vanilla` | `@bugsee/bugsee` (browser entry), `@bugsee/browser`, `@bugsee/replay`, `@bugsee/replay-canvas`, `@bugsee/performance`, `@bugsee/opentelemetry`, `@bugsee/webworker` (Web **and** Service Worker) |
| `react-spa` | `@bugsee/react`, `@bugsee/vite-plugin`, `@bugsee/babel-plugin-component-annotate` |
| `vue-spa` | `@bugsee/vue` |
| `svelte-spa` | `@bugsee/svelte`, `@bugsee/svelte-plugin-component-annotate` |
| `solid-spa` | `@bugsee/solid` |
| `angular-spa` | `@bugsee/angular` |
| `webpack-sourcemaps` | `@bugsee/webpack-plugin`, `@bugsee/bundler-plugin-core` |
| `nextjs-app` | `@bugsee/nextjs` (all 5 entries) |
| `nuxt-app` | `@bugsee/nuxt` (module + client + nitro + edge) |
| `remix-app` | `@bugsee/remix` |
| `sveltekit-app` | `@bugsee/sveltekit` (node + edge) |
| `astro-app` | `@bugsee/astro` |
| `node-service` | `@bugsee/bugsee/node`, `@bugsee/node`, `@bugsee/node-utils`, `@bugsee/opentelemetry` (two-way) |
| `express-api` | `@bugsee/express` |
| `fastify-api` | `@bugsee/fastify` |
| `nestjs-api` | `@bugsee/nestjs` |
| `koa-api` | `@bugsee/koa` |
| `hapi-api` | `@bugsee/hapi` |
| `hono-api` | `@bugsee/hono` |
| `elysia-api` | `@bugsee/elysia` (Bun) |
| `bun-service` | `@bugsee/bun`, `@bugsee/bugsee/bun` |
| `deno-service` | `@bugsee/deno`, `@bugsee/bugsee/deno` |
| `cloudflare-worker` | `@bugsee/cloudflare` (+ Durable Objects) |
| `vercel-edge-app` | `@bugsee/vercel-edge` |
| `electron-app` | `@bugsee/electron` (main / renderer / preload / native crash) |
| `webview-host` | `@bugsee/webview` (IIFE bundle + a mock native host) |

26 samples.

### 1b. Covered transitively — no standalone application

These are internal tiers or glue. Every one of them is on the code path of at least one sample above,
and a defect in them surfaces there. Building an app "for `@bugsee/core`" would be a test harness, not
an application — precisely what this exercise is not.

`@bugsee/types`, `@bugsee/util`, `@bugsee/logger`, `@bugsee/protocol`, `@bugsee/service`,
`@bugsee/core`, `@bugsee/capture`, `@bugsee/browser-utils`, `@bugsee/node-utils`,
`@bugsee/web-adapter`, `@bugsee/adapter-kit`, `@bugsee/integration-shims`, `@bugsee/rrweb`,
`@bugsee/bundler-plugin-core` (exercised through both bundler plugins).

Each sample plan below names which of these it puts under load, so the coverage is traceable.

### 1c. Not sample-able — existing test harnesses

`@bugsee/e2e-kit`, `@bugsee/instrumentation-tests`, `@bugsee/nextjs-e2e`, `@bugsee/nuxt-e2e`,
`@bugsee/sveltekit-e2e`, `@bugsee/astro-e2e`. Never published.

## 2. How a sample consumes the SDK

**From a pre-publish tarball, never from the workspace source.**

Inside the monorepo `packages/*` resolve `.` → `./src/index.ts`; only `publishConfig.exports` points
at `dist`, and it is applied by `pnpm pack`/`pnpm publish`. Installing a sample from source would
therefore test something we are not shipping. Instead:

```bash
node scripts/pack-local.mjs        # build every package, pack each to .local-registry/<name>.tgz
node scripts/new-sample.mjs my-sample "@bugsee/react"
cd samples/my-sample && pnpm install
```

`scripts/new-sample.mjs` writes a `pnpm-workspace.yaml` that (a) makes the sample its own pnpm root —
so parallel sample work never contends on the monorepo lockfile — and (b) pins **every** `@bugsee/*`
package, transitive ones included, to its local tarball via `overrides`. Transitive pinning is
required: packed manifests carry `"@bugsee/browser": "0.0.0"`, a version that does not exist on npm.

This path is itself pre-publish verification. It exercises the `exports` map, the dual ESM/CJS output,
and the declared runtime dependencies — all things only the artifact can prove.

After changing anything under `packages/`, re-run `pack-local.mjs` (`--only @bugsee/x` for one
package) and `pnpm install` in the sample.

## 3. Shared conventions

Every sample:

- lives in `samples/<name>/`, is a standalone pnpm project, and has a `README.md` whose first section
  is **Run it** — clone, token, one command;
- reads `BUGSEE_APP_TOKEN` and `BUGSEE_ENDPOINT` from `.env` (`.env.example` is committed, `.env` is
  not) and passes `endpoint: process.env.BUGSEE_ENDPOINT` so data lands on **staging**
  (`https://apidev.bugsee.com`), never production;
- sets `appVersion` and `appBuild` to values that make its issues identifiable in the dashboard
  (`appVersion: '1.0.0'`, `appBuild` = a build counter), and calls `setUserIdentifier` with a stable
  sample user;
- exposes a **Scenario panel**: a UI page (web samples) or a set of HTTP routes (server samples) with
  one control per scenario in §4, so every flow can be triggered by hand and by script;
- ships a `scenarios.md` mapping each scenario id to the control that triggers it and to what should
  appear in Bugsee;
- keeps a `FINDINGS.md` (see §6).

The application itself must do real work. A server sample is a working API with real endpoints and
real responses; a web sample is a working app with real pages, navigation and state. The scenario
panel is a *part* of the app, not the whole of it — several scenarios (network capture, route naming,
render spans, per-request context) are only meaningful when there is a genuine app around them.

## 4. The scenario catalog

The common contract. Every sample implements every scenario that applies to its runtime; a sample
plan in §5 adds its package-specific ones. `scenarios.md` records any scenario marked N/A and why.

| Id | Scenario | What must be exercised |
| --- | --- | --- |
| S1 | Launch & lifecycle | `launch(token, options)`; `isLaunched()`; `flush(timeout)`; `stop(timeout)`; a second `launch()` while launched (must be ignored, not duplicated); launch with the minimum options and with every option set |
| S2 | Identity & attributes | `setUserIdentifier` / `getUserIdentifier` / `clearUserIdentifier`; `setAttribute` / `getAttribute` / `clearAttribute` / `clearAllAttributes` / `getAllAttributes`; every `AttributeValue` type; attributes set before **and** after the triggering event |
| S3 | Manual telemetry | `log(msg, level)` at every `LogLevel`; `event(name, params)` with and without params; `trace(name, value)`; `addBreadcrumb()` with every field |
| S4 | Exceptions | `logException(new Error)`; a non-Error throwable (string, object, `null`); nested `cause`; `LogExceptionOptions` (`mechanism`, `severity`, `labels`); the SAME instance twice (must dedupe); a storm of 200 in a second (must rate-limit, not drop the app) |
| S5 | Crashes | uncaught exception; unhandled promise rejection; (node) `exitOnUncaught` both ways and each `unhandledRejections` mode; (browser) `window.onerror` and `unhandledrejection` |
| S6 | Console capture | `console.log/info/warn/error/debug/trace`, plus a multi-arg call, an object, and a circular object |
| S7 | Network capture | `fetch` GET/POST; JSON and text bodies; a 4xx and a 5xx; a connection failure; a body over `maxNetworkBodySize`; a response with no `Content-Type`; XHR; WebSocket; SSE (`EventSource`). **And the app-behaviour check**: the app must still read every response body correctly with capture on — the binding principle is that interceptors do not alter app behaviour |
| S8 | Filters & redaction | `setNetworkEventFilter` (drop a header, redact a body field, veto a request); `setLogEventFilter`; `setBreadcrumbFilter`; `setReportHandler` `before` (mutate) and `before` returning `null` (veto). Verify on the backend that the redacted value never arrived |
| S9 | Performance / APM | on-by-default page-load transaction (web) or `http.server` transaction (server); navigation and interaction transactions; `http.client` spans for outbound calls; manual `client.ext('performance').startTransaction()` with child spans and every `SpanStatus`; `setRouteName`; `performanceSampleRate` at 0 and 1 |
| S10 | Distributed tracing | outbound `traceparent` on a call to another sample; `tracePropagationTargets` include/exclude; continuation of an inbound `traceparent`; `traceResponse` on and off; a two-hop trace whose `trace_id` joins the issues on both ends |
| S11 | Session replay (web) | replay on with defaults; masking (`maskAllText`, `maskAllInputs`, `blockAllMedia`, `blockAllCanvas`) verified by inspecting the replay for the secret; `.bugsee-show` opt-in; `maskTextSelector` / `blockSelector` / `ignoreSelector`; canvas recording via `@bugsee/replay-canvas` at a fixed fps and at `'all'` |
| S12 | Persistence & recovery | data captured before a hard termination still arrives on the next start (`persist` / `recover`); a bundle queued while offline uploads when connectivity returns; two instances sharing one store (browser: two tabs; node: two `worker_threads`) do not corrupt each other |
| S13 | OpenTelemetry | produce: `otelExportUrl` posts OTLP to a local collector, and the payload is valid OTLP/JSON; consume: an external OTel SDK's spans reach Bugsee via `onOtelSpanProcessor` |
| S14 | Platform specifics | see the per-sample plan |

### Verification depth

For every scenario, three levels — a sample is only "done" at level 3 where the backend exposes it:

1. **Local** — the SDK behaved (no throw, the app still works, the expected callback fired).
2. **Wire** — the right thing left the process (assert on an intercepted request, or on the SDK's own
   debug output).
3. **Backend** — the data arrived and is correct, checked over MCP (§6).

## 5. Per-sample plans

Every plan below lists: the app concept (what makes it genuinely useful), the API surface to exercise
beyond the catalog, and the sample-specific scenarios. The catalog in §4 applies in full unless a
scenario is marked N/A in `scenarios.md`.

### 5.1 `browser-vanilla` — the browser reference sample

**Packages:** `@bugsee/bugsee` (browser), `@bugsee/browser`, `@bugsee/replay`, `@bugsee/replay-canvas`,
`@bugsee/performance`, `@bugsee/opentelemetry`, `@bugsee/webworker`. Loads `@bugsee/core`,
`@bugsee/capture`, `@bugsee/browser-utils`, `@bugsee/rrweb`.

**App:** a no-framework "Widget Shop" (Vite, TypeScript, plain DOM): product grid fetched from a small
local JSON API, product detail, a cart with `localStorage` state, a checkout form with a **password
field and a credit-card field** (the masking targets), a `<canvas>` sparkline of price history, an
image gallery, and a live "order status" feed over SSE and a chat over WebSocket. A Web Worker does
price computation; a Service Worker caches assets and handles a background sync.

**Beyond the catalog:**
- every `BugseeLaunchOptions` field, each toggled from a settings page that re-launches the SDK;
- `captureViewHierarchy` — trigger a report and confirm the view tree describes the live DOM;
- `captureInteractions` — clicks, key presses, focus, change events become `events.user`;
- `maxRecordingTime` and `maxDataSize` — fill the ring past both bounds and confirm the oldest data is
  what gets dropped;
- `persist` / `recover` — capture, then kill the tab (`chrome://crash` or a forced reload mid-flight),
  then confirm the next launch recovers it (S12);
- multi-tab coexistence: two tabs on the same token, both capturing, both uploading;
- **Web Worker**: `@bugsee/webworker` `launch()` inside the worker, an exception thrown in the worker,
  and a `postMessage` round trip that must survive capture;
- **Service Worker**: `withBugseeEvent` wrapping `fetch`/`push`/`sync` handlers, a throw inside a
  handler, and `event.waitUntil` flush-before-termination; then a durable-queue recovery after the SW
  is killed between capture and upload;
- **replay**: §4 S11 in full, plus a replay that spans a navigation;
- **OTel**: both directions against a locally-run collector.

### 5.2 `react-spa`

**Packages:** `@bugsee/react`, `@bugsee/vite-plugin`, `@bugsee/babel-plugin-component-annotate`.

**App:** a "Kanban" board — boards, lists, draggable cards, a card detail modal, optimistic updates
against a small local API, React Router with nested and dynamic routes (`/board/:id/card/:cardId`),
and a settings page.

**Beyond the catalog:**
- `BugseeErrorBoundary` and `withBugseeErrorBoundary` — a component that throws during render, with
  `fallback` and with the error re-thrown; the component stack must reach Bugsee;
- `createBugseeErrorHandlers` wired into `createRoot({ onUncaughtError, onCaughtError, onRecoverableError })`;
- `BugseeProfiler` / `withBugseeProfiler` / `recordReactRenderSpan` — render spans on a deliberately
  slow list;
- `reportReactError` and `linkComponentStack` called directly;
- `instrumentReactRouter` + `instrumentRouterMatches` + `routePatternFromMatches` + `setRouteName` —
  transactions must be named by route **pattern** (`/board/:id`), never by the concrete URL;
- `@bugsee/babel-plugin-component-annotate` — `data-bugsee-component` on rendered elements, and
  component attribution on captured interactions;
- `@bugsee/vite-plugin` — a production build with source maps and debug ids; then throw from the
  minified build and confirm the stack is resolved to original sources on the backend.

### 5.3 `vue-spa`

**Packages:** `@bugsee/vue`.

**App:** a "Recipe book" — recipe list, detail, an editor with a rich form, favourites in
`localStorage`, Vue Router with dynamic routes, Pinia store.

**Beyond the catalog:** `installBugseeErrorHandler` (`app.config.errorHandler`) with a render error, a
lifecycle-hook error and an event-handler error; `reportVueError` direct; `createBugseeVueComponentMixin`
(component attribution) and `createBugseeVueRenderMixin` (render spans); `instrumentVueRouter` +
`routePatternFromVueRoute` — pattern naming; a Suspense/async-component error.

### 5.4 `svelte-spa`

**Packages:** `@bugsee/svelte`, `@bugsee/svelte-plugin-component-annotate`.

**App:** a "Habit tracker" — habits, a calendar heat map, streak stats, a settings drawer, client-side
routing.

**Beyond the catalog:** `handleErrorWithBugsee` and `reportSvelteError`; `startSvelteRenderSpan`;
`instrumentSvelteKitNavigation` + `routeIdFromNavigation` + `setRouteName`; the Svelte preprocessor
annotating components, verified in the DOM and in captured interactions.

### 5.5 `solid-spa`

**Packages:** `@bugsee/solid`.

**App:** a "Bug tracker" — issue list with filters, issue detail, comments, `@solidjs/router` with
nested routes.

**Beyond the catalog:** `solidErrorHandler` in an `ErrorBoundary`; `reportSolidError`;
`setRouteNameFromSolidMatches` + `routePatternFromSolidMatches`; an error inside a `createResource`.

### 5.6 `angular-spa`

**Packages:** `@bugsee/angular`.

**App:** an "Expense report" app — expenses list, a reactive form with validation, file attachment,
approval flow, Angular Router with lazy-loaded feature modules and route guards.

**Beyond the catalog:** `BugseeErrorHandler` / `createAngularErrorHandler` registered as Angular's
`ErrorHandler`; an error thrown in a component, in a service, inside an RxJS pipeline, and in an
`HttpClient` call; the `originalError` unwrap path; `createBugseeRenderTracker`;
`setRouteNameFromRouter` + `routePatternFromSnapshot` with a lazy route and a guard redirect;
`HttpClient` (XHR) network capture, which is a different code path from `fetch`.

### 5.7 `webpack-sourcemaps`

**Packages:** `@bugsee/webpack-plugin`, `@bugsee/bundler-plugin-core`.

**App:** a small webpack 5 "Markdown notes" app (deliberately not a framework, so the plugin is the
subject). Real value: it is the copy-paste reference for a webpack build.

**Beyond the catalog:** plugin options in full; a production build with `hidden-source-map`; debug-id
injection; the upload step against staging; **then throw from the minified bundle and verify the
backend resolves the stack to original sources and line numbers**; a build with the upload
misconfigured (bad token) must fail loudly, not silently ship unsymbolicated builds; a build where the
CLI is killed by a signal must fail the build (regression guard for the `code ?? 0` defect).

### 5.8 `nextjs-app`

**Packages:** `@bugsee/nextjs` (`.`, `./server`, `./client`, `./edge`, `./middleware`), `@bugsee/react`.

**App:** a "Storefront" — App Router, server components, a route handler API, a server action for
checkout, a middleware-protected `/account` area, one page pinned to the edge runtime, ISR on the
product page.

**Beyond the catalog:** `register()` in `instrumentation.ts` for both the node and edge runtimes;
`instrumentation-client.ts`; `onRequestError` catching a server-component throw, a route-handler throw
and a server-action throw; the middleware entry; `getBugseeTraceData` injecting the trace into the
document so a client error joins the server trace; the config wrapper; consuming Next's own OTel
spans; and **one session artifact**: a client-side click that triggers a server throw must produce one
issue whose trace ties the browser session (console, network, replay) to the server stack.

### 5.9 `nuxt-app`

**Packages:** `@bugsee/nuxt` (module + `./client` + `./server` + `./edge`), `@bugsee/vue`.

**App:** a "Travel journal" — Nuxt 3, SSR pages, a Nitro server API, `useFetch`, one route rendered on
the edge preset.

**Beyond the catalog:** the module writing public vs private runtime config; the generated client
plugin; the Nitro `error` hook; **the `nitro:init` preset correction** — build once with a node preset
and once with `cloudflare-pages` and confirm the right server plugin is bundled each time; a throw in
a server route, in `asyncData`, and during hydration.

### 5.10 `remix-app`

**Packages:** `@bugsee/remix`.

**App:** a "Bookstore" — loaders, actions, nested routes, a form post, an error boundary route.

**Beyond the catalog:** `handleError` server hook; the client entry; `getBugseeTraceMetaTags` +
the meta-tag transformer joining the client session to the server trace; a loader throw, an action
throw, and a `Response` thrown as a redirect (must NOT be reported as an error).

### 5.11 `sveltekit-app`

**Packages:** `@bugsee/sveltekit` (`./server`, `./client`, `./edge`), `@bugsee/svelte`.

**App:** a "Meal planner" — SSR, form actions, `+server.ts` endpoints, a route on the edge adapter.

**Beyond the catalog:** `handleErrorWithBugsee` on both server and client; `createHandle` and
`createEdgeHandle`; the trace `<meta>` injection through `transformPageChunk`; the edge path's
`waitUntil` holding the upload past the response; a `getClient` that throws (must degrade, never 500).

### 5.12 `astro-app`

**Packages:** `@bugsee/astro`.

**App:** a "Docs site" — static pages plus SSR routes, an island (React or Vue), an API route.

**Beyond the catalog:** the integration; the middleware; the client entry; the edge entry; a throw in
an SSR page, in an API route and in an island; **a non-UTF-8 HTML response must pass through
unchanged** (regression guard for the encoding defect).

### 5.13 `node-service` — the Node reference sample

**Packages:** `@bugsee/bugsee/node`, `@bugsee/node`, `@bugsee/node-utils`, `@bugsee/opentelemetry`.
Loads `@bugsee/core`, `@bugsee/capture`, `@bugsee/service`.

**App:** a "Link shortener" on plain `node:http` — create/resolve/stats endpoints, a JSON file store,
a small HTML dashboard, and a background job that expires links. No framework, so `@bugsee/node` is
the subject.

**Beyond the catalog:**
- every `BugseeLaunchOptions` field in `packages/node/src/launch.ts`, driven from a config file;
- **CPU profiling**: `profiling: true` + `profilingSamplingIntervalMicros`; a `/burn` endpoint that
  spins; confirm `profile.json` reaches the backend;
- **ANR / hang detection**: `detectHangs` with each of `hangFairMs`/`hangMediumMs`/`hangSevereMs`; a
  `/block?ms=` endpoint that blocks the event loop; confirm an `AppHang` report per threshold;
- **disk capture**: `capturedDataStore` / `dataDir` / `captureWriter: 'inline' | 'worker'`; kill the
  process with `SIGKILL` mid-capture and confirm the next start recovers and uploads it;
- **multi-instance coexistence**: run the server in a cluster of 3 `worker_threads` plus a second
  process on the same `dataDir`; kill one; confirm the survivor recovers the dead sibling's subtree
  and that no data is duplicated or lost;
- **incoming-server auto-instrumentation**: `instrumentIncomingRequests` on (default) and off; one
  `http.server` transaction per request and one request context, with no double-instrumentation;
- **per-request context**: concurrent requests must not cross-contaminate — fire 50 overlapping
  requests each setting a distinct attribute and assert every issue carries its own;
- **trace propagation**: `propagateTrace`, `tracePropagationTargets`, `traceResponse` — call
  `express-api` and assert one trace across both;
- `exitOnUncaught` both ways; each `unhandledRejections` mode; `shutdownTimeoutMs` on `SIGTERM`;
- **OTel two-way** against a local collector.

### 5.14–5.20 The framework backends

`express-api`, `fastify-api`, `nestjs-api`, `koa-api`, `hapi-api`, `hono-api`, `elysia-api`.

Each is a **different real API**, not the same app seven times — they are the reference sample for
that framework's users and should look idiomatic for it. Suggested: express = "Task API" (REST CRUD +
auth middleware); fastify = "Metrics ingest" (schema validation, hooks); nestjs = "Orders" (modules,
DI, guards, interceptors, pipes); koa = "File uploads"; hapi = "Reservations" (plugins, route config,
validation); hono = "URL router / redirect service"; elysia = "Realtime scoreboard" (Bun, WebSocket).

**Every backend sample covers:**
- the package's setup function (`setupExpress`/`setupFastify`/`setupNest`/`setupKoa`/…) and, where the
  package exposes them separately, the middleware and error-handler halves used by hand;
- a throw in a route handler, in middleware **before** the route, in an async handler, and inside a
  `setTimeout` callback (outside the request context);
- a 4xx that must NOT be reported and a 5xx that must;
- per-request context correlation under concurrency (as in §5.13);
- route naming — `http.route` must be the **pattern** (`/users/:id`), never the concrete path;
- `shouldReport` customisation;
- `instrumentIncomingRequests: false` — the adapter alone must still work, with exactly one context
  and one transaction (the first-owner-wins re-entrancy rule);
- outbound calls to `node-service` producing a joined trace;
- framework-specific error surfaces: NestJS's interceptor / `ExceptionFilter` / `both` seams; hapi's
  `onPreResponse`; Koa's `app.on('error')`; Fastify's `setErrorHandler` interaction with the hook;
  Elysia's `onError`; Hono's `onError`.

### 5.21 `bun-service` · 5.22 `deno-service`

**Packages:** `@bugsee/bun` / `@bugsee/deno`.

**App:** the `node-service` link shortener, ported to `Bun.serve` / `Deno.serve` and idiomatic for the
runtime (Bun: `bun:sqlite`; Deno: `Deno.openKv`). Same coverage as §5.13 including profiling and hang
detection (parity is a claim we must prove), plus the native `serve` interceptor and the runtime
identity probe (`environment.platform` must say bun/deno, not node).

### 5.23 `cloudflare-worker`

**Packages:** `@bugsee/cloudflare`.

**App:** an "Edge feature-flag service" — a Worker with KV-backed flags, a Durable Object per tenant
holding rollout state, and a scheduled handler.

**Beyond the catalog:** `withBugsee` on a `WorkerEntrypoint`; the plain `fetch` handler wrapper; a
Durable Object instrumented via `instrumentDurableObject`, with **tenant isolation proven** (two DOs,
concurrent, no cross-talk); `waitUntil` holding the upload past the response; `cfAttributes` /
`cloudflareRequestAttributes` on the issue; the scheduled handler; a throw in each of the three
handler kinds; the no-incident invocation uploading nothing.

### 5.24 `vercel-edge-app`

**Packages:** `@bugsee/vercel-edge`.

**App:** an "A/B redirect + geo personalisation" edge function set.

**Beyond the catalog:** `withBugseeFetch`; `runInEdgeContext`; the `@vercel/request-context` symbol
resolution and the fallback when it is absent or non-callable; route stamping; `requestAttributes`;
incident-driven upload (no incident → no upload).

### 5.25 `electron-app`

**Packages:** `@bugsee/electron` (`.`, `./main`, `./renderer`, `./preload`).

**App:** a "Screenshot annotator" desktop app — main process with a menu and file IO, one main window
plus a second renderer window, a preload bridge.

**Beyond the catalog:** one session across main + both renderers; renderer capture streamed up over
IPC; the control channel (handshake / pause / resume / flush / stop); a throw in main, a throw in a
renderer, and a renderer process kill (`renderer-gone`); **native crash** via `crashReporter` — crash
the renderer natively and confirm the minidump is harvested at the next launch and stitched to the
crashed session; rrweb DOM replay by default; opt-in pixel video (`video: { source }`) via both
`capturePage` and `MediaRecorder`.

### 5.26 `webview-host`

**Packages:** `@bugsee/webview`.

**App:** a mobile-style web app (the kind a native app embeds) — a login screen, a product list, a
form — served over HTTP, plus a **mock native host** page that loads it in an `<iframe>` and
implements the native side of the bridge protocol, printing every message and validating it against
the shipped `bridge-protocol.schema.json`.

**Beyond the catalog:** the IIFE bundle loaded via `<script>` and the npm entry; the `hello` handshake
and capability negotiation; full-parity capture entries streamed up; the report path; every control
command; obscuring (secure-area rects, `.bugsee-show` opt-out, sub-frame composition with a
cross-origin child); redaction filters and the `red` provenance flag; bundle size guard.
Real-device Android/iOS receivers are out of scope here — the mock host is the contract.

## 6. Backend verification protocol (MCP)

The Bugsee **staging** MCP server (`bugsee-staging`) is the oracle. For each sample:

1. **Create the app once**, with `create_application`:
   `type: "javascript"`, `subtype` = the sample's runtime (`browser`, `react`, `nextjs`, `node`,
   `express`, `cloudflare`, `electron`, …), `name` = `Sample · <sample-name>`, `key` =
   `S<SHORT>` (unique, uppercase). Record the returned `app_token` in the sample's `.env`
   (**not** committed) and the app `key` + `id` in the sample's `README.md`.
2. **Run each scenario**, then `flush()`.
3. **Poll `list_issues`** for the app (`type` filter as appropriate) until the expected issue appears
   or a timeout elapses. A timeout **is a finding** — record how long you waited.
4. **`get_issue`** and assert the content:
   - `# Environment` — platform, OS, app version/build, SDK version are right for the runtime;
   - `# Summary` and `# Exception` — the message, type and stack are correct, and for a minified build
     the stack is resolved to original sources;
   - `# Report source` — the trigger type and mechanism match what fired it;
   - `# Logs` (`include_logs`) — the console lines, manual `log()` lines and breadcrumbs are present,
     in order, with the right levels;
   - attributes, labels and the user identifier set in S2 are present;
   - anything redacted in S8 is **absent**.
5. **Record every discrepancy** in `samples/<name>/FINDINGS.md` using the template the scaffolder
   writes. A finding is: severity, package + `file:line` if known, scenario id, expected, observed,
   reproduction steps, and the issue key as evidence.
6. What the MCP surface does **not** expose (replay contents, network entries, performance
   transactions, view hierarchy) is verified at level 2 (wire) instead — intercept the SDK's own
   upload and assert the bundle — and the gap itself is recorded once in `samples/FINDINGS.md`.

**Never** point a sample at production. **Never** commit an app token.

## 7. Orchestration

Samples are built by sub-agents, five at a time, one agent per sample.

- **Build** — a Sonnet agent builds the sample against its plan in §5. It creates the staging app,
  builds the app, runs every scenario, verifies over MCP, and writes `README.md`, `scenarios.md` and
  `FINDINGS.md`. It does not touch `packages/`.
- **Review** — when a build agent finishes, an Opus agent reviews that sample read-only: does the app
  really work, is the plan's coverage actually implemented (not merely claimed), are the findings
  real and reproducible, are there SDK defects the build agent missed or misattributed, is anything
  asserted that cannot fail. Every finding cites `file:line`.
- **Fix** — the review is handed back to a Sonnet agent, which fixes what is real and records
  dismissals with reasons.
- **Re-review** — if the fix round changed anything, a fresh Opus review runs. Repeat until a full
  review yields zero new real findings.

Waves:

| Wave | Samples |
| --- | --- |
| 1 | `browser-vanilla`, `react-spa`, `vue-spa`, `express-api`, `node-service` |
| 2 | `svelte-spa`, `solid-spa`, `angular-spa`, `webpack-sourcemaps`, `fastify-api` |
| 3 | `nextjs-app`, `nuxt-app`, `remix-app`, `sveltekit-app`, `astro-app` |
| 4 | `nestjs-api`, `koa-api`, `hapi-api`, `hono-api`, `elysia-api` |
| 5 | `bun-service`, `deno-service`, `cloudflare-worker`, `vercel-edge-app`, `webview-host` |
| 6 | `electron-app` |

Wave 1 sets the conventions the rest copy: `browser-vanilla` is the reference for every web sample,
`node-service` for every server sample.

Findings are aggregated into `samples/FINDINGS.md` at the end of each wave and triaged **later** —
the goal of this exercise is to find and record, not to fix.
