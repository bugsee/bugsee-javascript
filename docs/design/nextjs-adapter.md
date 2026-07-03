# @bugsee/nextjs — design (research-enhanced)

**Status:** DESIGN (2026-07-03). Informed by competitor + Next.js-platform research (three sourced reports;
see the Decision Log). Not yet built.

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

## 5. Open design decisions (need confirmation before building)
- **D1 — Router scope.** App Router first-class; Pages Router gets *baseline* server coverage for free
  (`onRequestError` + `register` cover it; `routerKind` distinguishes), deep Pages client wrapping deferred. ✅ recommended.
- **D2 — Source-map dependency.** The config wrapper's map upload is task **#158** (X1, currently a stub). Build a
  minimal post-build upload within nextjs first, or land #158 first as the shared substrate? (Lean: land the
  bundler-agnostic #158 tooling first, then compose.)
- **D3 — Tunnel route.** Ship it opt-in (default off) with the safety hardening above, or defer to a follow-up?
- **D4 — OTel coexistence default.** Default-attach `@bugsee/opentelemetry` as a SpanProcessor consuming Next's
  spans (adds an optional peer dep), or make it opt-in?
- **D5 — Setup ergonomics.** How aggressively to collapse the file surface — a `bugsee-cli init nextjs` wizard +
  re-export shims, vs documented manual files.

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
