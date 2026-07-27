# @bugsee/nextjs — design (research-enhanced)

**Status:** **PARTIALLY BUILT + on `main`** (2026-07-03 design; subsequently implemented). Slices N1–N5/N7
are built. **Slice N6 (the tunnel + the `next.config` wrapper) is DESIGNED BUT NOT BUILT** — verified
2026-07-27 by adversarial review (`docs/review/nextjs.md`): no tunnel route and no config wrapper exist in
`packages/nextjs`. Also unbuilt/unverified: no real `next` dependency exists anywhere in the monorepo, so
no Next.js semantics are exercised by any test, and the **Edge build does not compile** (`register.ts`'s
literal dynamic import pulls all of `@bugsee/node` into the edge graph). Informed by competitor + Next.js-platform research (three sourced reports;
see the Decision Log).

## 1. The key finding: the Next.js instrumentation pattern is SETTLED and Next.js-NATIVE

Every serious vendor now builds on the same **official** Next.js primitives — these are not Sentry inventions,
they are Vercel-shipped seams:

| Hook / surface | File | Runtime(s) | Next version | What we mount |
| --- | --- | --- | --- | --- |
| `register()` | `instrumentation.ts` | node + edge (once each) | flag 13/14 → **stable 15** | `@bugsee/node` (nodejs branch) / edge composition (edge branch), via `await import()` gated on `NEXT_RUNTIME` |
| `onRequestError(err, req, ctx)` | `instrumentation.ts` | node + edge | **Next 15** | server error → Bugsee report + route attribution (`routerKind`/`routePath`/`routeType`/`renderSource`); **does NOT catch middleware** |
| top-level + `onRouterTransitionStart` | `instrumentation-client.ts` | browser | **Next 15.3** | `@bugsee/browser` launch() (earliest client init) + soft-nav breadcrumbs |
| `withBugsee(nextConfig)` | `next.config.ts` | build | any | wrap `webpack`/`turbopack`/`headers`/`rewrites`; source-map upload; optional tunnel; inject `experimental.instrumentationHook` on 13/14 |
| `registerOTel()` / Next's own OTel spans | `instrumentation.ts` | node + edge | flag 13/14 → 15 | **consume** via `@bugsee/opentelemetry` SpanProcessor — do NOT install a 2nd tracer |

**Sentry is the de-facto reference implementation** of this pattern, but the pattern is the framework's. So the
Next-specific work for us is a **thin adapter** — a runtime dispatcher, a config wrapper, an `onRequestError`
bridge, and a trace channel — over platforms we already have.

## 2. Competitive landscape → our differentiation

Two camps, and **neither owns the combination we do**:
- **Trace/metrics camp** (Vercel `@vercel/otel`, Honeycomb, Checkly, New Relic, Grafana Faro): OTel spans + web
  vitals; thin/no error+replay; no video. Honeycomb/Checkly just punt to `@vercel/otel`.
- **Error/replay camp** (Sentry, LogRocket, Highlight, PostHog, Datadog RUM, BugSnag, Rollbar, TrackJS): errors +
  (a subset) rrweb **DOM** replay — **client-only** replay, server error is a separate object linked by an id.

First-class fullstack Next SDKs: **Datadog, Highlight, PostHog, Vercel's own**. **Highlight** is our closest
peer (client+node+edge + a `withHighlightConfig` wrapper + session replay) — it validates the *shape* but its
replay is DOM-reconstruction and its edge/Turbopack story is rough.

**White space = a SINGLE session artifact (video + console + network + logs) stitched to the server-side
`onRequestError` throw and the edge-middleware trace.** No competitor delivers "the full session that led to
*this* RSC / route-handler / server-action failure" as one object. Bugsee's bundle model + runtime-portable
edge/node/browser platforms + FE→BE→FE trace join already point exactly here.

## 3. Architecture — a thin adapter over existing platforms

```
instrumentation-client.ts   →  @bugsee/browser launch()  (+ @bugsee/react boundaries; onRouterTransitionStart)
instrumentation.ts
  register():
    NEXT_RUNTIME==='nodejs'  →  await import('./server') → @bugsee/node launch() + @bugsee/opentelemetry SpanProcessor
    NEXT_RUNTIME==='edge'    →  await import('./edge')   → edge composition (vercel-edge family)
  onRequestError            →  bridge → active-context report with route attribution
next.config.ts: withBugsee(config, opts)  →  source-map upload (bundler-agnostic) + optional tunnel + 13/14 flag
middleware.ts: withBugseeMiddleware(mw)   →  edge; middleware errors (NOT covered by onRequestError)
(optional) withBugseeServerAction(name, fn) →  server-action spans/context (no native OTel spans)
```

**Three hard constraints (drive every decision):**
1. **Split every entry by `NEXT_RUNTIME` with `await import()`** — no static node import reachable from the
   edge/client graph (would break the build). This is exactly our runtime-adapter house style.
2. **Middleware errors need their OWN path** — `onRequestError` does not catch them (Next bug #83404). Provide
   `withBugseeMiddleware`.
3. **Build-time integration must be BUNDLER-AGNOSTIC** — Turbopack is the default bundler in Next 16 and has **no
   webpack-plugin API**; webpack-plugin-only source-map upload silently no-ops. Do it as a **post-build CLI step**
   (+ a `turbopack.rules` loader where injection is needed), NOT a webpack plugin.

## 4. Differentiation we ship (beat, not match)
1. **Full-session capture correlated across all three runtimes to the failing request** (the white space).
2. **Zero-config OTel coexistence:** detect a pre-existing OTel SDK and attach as a `SpanProcessor` by default,
   never install a second tracer (Sentry's #1 double-instrumentation pain).
3. **Collapsed setup surface:** fewer files than Sentry's 4 (client/server/edge configs + instrumentation) — the
   #1 user complaint. Aim for one `withBugsee(next.config)` + minimal instrumentation shims (re-exports).
4. **Turbopack-first** build integration (bundler-agnostic) — immune to the webpack-plugin dead end.
5. **Honest source-map privacy:** hidden maps + **delete client `.map`s by default**; single owner of debug ids
   (no double-injection). (Turbopack currently always emits real-source maps with no toggle → we must delete.)
6. **Safe, framework-aware tunnel** (opt-in): scoped to the project (CVE-2023-46729 lesson), auto-excluded from
   middleware matchers, respects `basePath`, forwards `X-Forwarded-For`.

## 5. Design decisions (CONFIRMED 2026-07-03)
- **D1 — Router scope.** App Router first-class; Pages Router gets *baseline* server coverage for free
  (`onRequestError` + `register` cover it; `routerKind` distinguishes), deep Pages client wrapping deferred.
- **D2 — First slice = the RUNTIME ADAPTER; source-map upload deferred to #158.** The runtime hooks
  (register/onRequestError/instrumentation-client/middleware) need no source maps, so build them first and land
  full-session capture across all three runtimes; the config-wrapper's map UPLOAD composes #158 (bundler-agnostic
  post-build CLI + turbopack loader) when it lands. Symbolication follows.
- **D3 — Tunnel route: SHIP opt-in (default off) + HARDENED** — scoped forwarding to the Bugsee project (no
  CVE-2023-46729 SSRF), auto-exclude from middleware matchers, respect `basePath`, forward `X-Forwarded-For`.
- **D4 — OTel coexistence: DEFAULT-ATTACH** `@bugsee/opentelemetry` as a SpanProcessor consuming Next's native
  spans (the zero-config tracing differentiator; beats Sentry's manual opt-in). `@bugsee/opentelemetry` is a
  (composed) dependency; server tracing works out of the box.
  - **D4.1 — MECHANISM (resolved at N1b start, competitor-grounded).** The OTel-JS global tracer-provider slot
    is **single-owner / first-wins** (`setGlobalTracerProvider` returns `false` on a second call) and
    `getTracerProvider()` returns a `ProxyTracerProvider` with **no `addSpanProcessor`** — so "coexistence"
    never means a second provider. Two paths: **(a) coexist** — expose the wired Bugsee `SpanProcessor` so a
    user running `@vercel/otel` passes it into `registerOTel({ spanProcessors: [processor] })` (Highlight's
    proven pattern; **N1b-1, shipped** via `onSpanProcessor`); **(b) zero-config** — when NO provider is
    registered, self-register our own `NodeTracerProvider` with the processor (Next then emits, we consume;
    **N1b-2**). Improve on **Sentry** (which owns the provider by default with a **hard** OTel dep and **no**
    auto-detection → silent double-provider footgun) by keeping the OTel SDK an **optional peer** (lazy-imported
    only for path b, matching `@bugsee/opentelemetry`'s install-lean philosophy) and **detecting an existing
    provider first** (skip self-register → never clobber a pre-existing `@vercel/otel`). Residual hazard: a user
    who calls `registerOTel` AFTER us is clobbered by first-wins → mitigate with an **opt-out** (Sentry-style)
    + docs ("use `registerOTel({ spanProcessors: [processor] })`, or register Bugsee last"). Vendor split
    confirmed by research: full APM agents (Datadog/New Relic) own the provider; OTLP/backend vendors
    (Highlight/Honeycomb/Grafana) attach a processor to the user's provider.
  - **Build split:** **N1b-1** = performance wiring + `otelConsume` + expose the SpanProcessor (dep-free;
    matches Highlight) — **DONE**. **N1b-2** = zero-config self-registration (optional-peer `@opentelemetry/
    sdk-trace-node`, lazy import, detect-existing + first-wins guard, opt-out).
- **D5 — Setup ergonomics.** Collapse the file surface below Sentry's 4 — a `withBugsee(next.config)` wrapper +
  minimal instrumentation shims (re-exports), a wizard as a follow-up.

## 6. Build slices (each: test-first → mutator loop → multi-agent review → commit)
- **N1** — package scaffold + **server (node) composition**: `registerServer(opts)` = `@bugsee/node` launch()
  + default-attach `@bugsee/opentelemetry` SpanProcessor (consume Next's spans). NEXT_RUNTIME-safe (node-only).
- **N2** — **edge composition**: `registerEdge(opts)` over the vercel-edge family (web-APIs-only, bundle-lean).
- **N3** — the **`register()` dispatcher** (branch `NEXT_RUNTIME` → `await import('./server'|'./edge')`) +
  **`onRequestError` bridge** (server throw → active-context report + route attribution).
- **N4** — **client entry** (`instrumentation-client` helper → `@bugsee/browser` launch() + `@bugsee/react`
  boundaries + `onRouterTransitionStart` soft-nav breadcrumbs).
- **N5** — **`withBugseeMiddleware(mw)`** (edge; middleware errors NOT covered by `onRequestError`).
- **N6** — **`withBugsee(nextConfig, opts)`** config wrapper: `experimental.instrumentationHook` on 13/14 +
  the hardened opt-in tunnel (rewrite/route) + a source-map hook that composes #158 when present.
- **N7** — **trace channel**: `getBugseeTraceData()` for `generateMetadata()` (client→server `<meta>` trace
  continuation) + header propagation via cross-project tracing.
- **(later)** `withBugseeServerAction(name, fn)` for the server-action OTel-span gap; the wizard; Pages-deep client.

## Decision Log (research → design)
- Adopt the **official Next.js seams verbatim** (register / onRequestError / instrumentation-client / config
  wrapper / OTel spans) — frictionless adoption; the pattern is framework-native, not a Sentry lock-in. Chosen
  over inventing our own wrapping (webpack-loader auto-wrap) because that path is a **Turbopack dead end**.
- **Consume** Next's OTel spans (SpanProcessor) rather than install our own server tracer — avoids the
  double-instrumentation class of bugs; we already have the two-way OTel consumer.
- **Thin adapter, not a new platform** — reuse @bugsee/browser + node + vercel-edge + react + opentelemetry +
  cross-project tracing; the Next package is a dispatcher + config wrapper + onRequestError bridge.
- Lead with **full-session capture across runtimes** as the moat; Highlight validates the shape, no one has the depth.

## Sources
Three research reports (Sentry deep-dive, competitor scan, Next.js platform APIs) — full URL lists in-session.
Key primaries: Next.js `instrumentation` / `instrumentation-client` / `turbopack` / `serverExternalPackages` docs;
`@sentry/nextjs` `withSentryConfig` source + Turbopack blog; Highlight `withHighlightConfig`; `@vercel/otel`.
