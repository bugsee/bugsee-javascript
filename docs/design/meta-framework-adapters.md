# Meta-framework adapters — design (Nuxt / Remix / SvelteKit / Astro)

**Status:** BUILT + on `main` (2026-07-05 design; subsequently implemented). Informed by four sourced research reports (one per framework, each mapping
the framework's instrumentation seams + Sentry's reference adapter to Bugsee's existing platforms). Sibling of `docs/design/nextjs-adapter.md` — read that first; this doc is deliberately the
"same shape, different seam names" follow-on.

## 1. The finding: all four are the @bugsee/nextjs adapter with different seam names

@bugsee/nextjs proved out a **thin meta-adapter** over the existing platforms (`@bugsee/browser` + a UI
adapter, `@bugsee/node`, `@bugsee/vercel-edge`) wired through a fixed set of reusable primitives. Every one
of Nuxt/Remix/SvelteKit/Astro needs the **same** primitives; only the framework's **seam names** and its
**delivery mechanism** (module / Vite plugin / integration / entry files) differ. No new platform work is
required — this is composition + per-framework glue.

### The 6 reusable primitives (already built for Next.js)
| # | Primitive | Provided by | Next.js form |
| --- | --- | --- | --- |
| P1 | **Client init** — earliest browser launch + UI error/nav seam | `@bugsee/browser` + `@bugsee/{react,vue,svelte,solid}` | `instrumentation-client` → `registerClient` |
| P2 | **Server init** — start the node (or edge) SDK | `@bugsee/node` `launch()` / `@bugsee/vercel-edge` `launchEdge()` | `register()` dispatcher |
| P3 | **Per-request context** — ALS scope + `http.server` txn | `@bugsee/node` (node:http emit-patch + ALS) / `runInEdgeContext` | automatic |
| P4 | **Server-error bridge** (the `onRequestError` analog) — stitch a server throw to the session | `getCarrierClient()` + `client.event(attribution)` + `logException` (portable) | `onRequestError` |
| P5 | **Trace `<meta>` channel** — inject W3C `traceparent` into SSR HTML so the client pageload joins the server trace | `getBugseeTraceData()` (portable — reads `RequestContext.trace`) | `getBugseeTraceData()` |
| P6 | **Build integration + source-map upload** | a Vite/Rollup plugin — **task #158** | `withBugsee(nextConfig)` |

## 2. Per-framework seam map (the whole design in one table)

| Primitive | **Nuxt** (Vue + Nitro) | **Remix / RR7** (React) | **SvelteKit** (Svelte) | **Astro** (islands) |
| --- | --- | --- | --- | --- |
| UI adapter | `@bugsee/vue` | `@bugsee/react` | `@bugsee/svelte` | **agnostic** — user adds `@bugsee/{react,vue,svelte,solid}` |
| P1 client init | `plugins/*.client.ts` (Nuxt plugin, auto-injected by the module) + `vueApp.config.errorHandler`/`vue:error` | `app/entry.client.tsx`; **RR7** `<HydratedRouter onError={bugseeOnError}>`; **v2** `withBugsee(App)` + `ErrorBoundary` | `src/hooks.client.ts` + `handleError: HandleClientError` | `injectScript('page', …)` (browser launch only) |
| P2 server init | **Nitro server plugin** `server/plugins/*` (auto via `addServerPlugin`) | preload `instrument.server.mjs` (`--import`) or custom-server top import | `src/instrumentation.server.ts` (≥2.31, exp flag) **or** top of `hooks.server.ts` | `injectScript('page-ssr', …)` |
| P3 request context | `node:http` emit-patch under `node-server` preset (Bugsee's own ALS) | `node:http` emit-patch under `remix-serve`/Express | `handle` hook wraps `resolve()` → open ALS `store.run()` (works on **every** adapter) | `defineMiddleware` wraps `next()` → ALS/edge context |
| P4 server-error bridge | `nitroApp.hooks.hook('error', …)` (filter H3Error 404/422) | **`export function handleError(err,{request})`** (skip aborted + thrown `Response`) | **`export const handleError: HandleServerError`** (not called for `error()` helper) | **no hook** — try/catch around `next()` in middleware, rethrow |
| P5 trace `<meta>` | Nitro `render:html` → `html.head.push('<meta traceparent>')` | **RR7** `getMetaTagTransformer` stream; **v2** `Server-Timing` header (least intrusive) or root-loader+`meta()` | `handle` `transformPageChunk` → splice after `<head>` | middleware rewrites the HTML response (splice after `<head>`) |
| P6 build + maps | **Nuxt Module** (`defineNuxtModule`) + `addVitePlugin` + #158 | Vite plugin + #158 (+ optional route-manifest plugin) | **Vite plugin** `bugseeSvelteKit()` (must precede `sveltekit()`) + #158 | **Integration** `bugsee()` (`astro:config:setup`) + `updateConfig(vite)` + #158 |
| Edge | Nitro `vercel-edge`/`cloudflare` preset → `@bugsee/vercel-edge`/`@bugsee/cloudflare` in the server plugin | `@react-router/cloudflare` → `@bugsee/vercel-edge`/`@bugsee/cloudflare` | per-route `config.runtime:'edge'` → `@bugsee/vercel-edge` **(Sentry unsupported here — our differentiator)** | Vercel edge adapter (`edgeMiddleware`) → `@bugsee/vercel-edge` |
| Runtime dispatch | **build-time preset** (no per-request `NEXT_RUNTIME`) | Web-Fetch handler; per-adapter | per-route `config` / per-adapter | per-adapter (Vercel node+edge) |
| Delivery surface | one **Nuxt Module** in `modules[]` | entry-file exports + a Vite plugin | one **Vite plugin** + `hooks.{client,server}` helpers | one **Integration** in `integrations[]` |

## 3. Shared "meta-framework kit" (the key architectural decision)

P4 (server-error bridge) and P5 (trace-data) are **runtime-portable and framework-agnostic** — they use only
`getCarrierClient()` + `client.event/logException` and `RequestContext.trace`. Today they live as internal
files in `@bugsee/nextjs` (`on-request-error.ts`, `trace-data.ts`). With **five** meta-adapters
(nextjs + these four) they should be **extracted once** and reused, not copied 5×:

- `reportServerError(getClient, error, { mechanism, attributes })` — the generic P4 bridge (each adapter maps
  its framework's error-context → `attributes`).
- `getTraceparent(getClient)` / `traceMetaTag(getClient)` — the generic P5 helper (already portable — it *is*
  `getBugseeTraceData`'s body).

Precedent exists for shared adapter cores: the **backend** adapters share the server-instrument core in
`@bugsee/node`; the **frontend** adapters share `@bugsee/web-adapter`. Recommendation (**D1**): extract these
two primitives into a small shared module and have all five meta-adapters consume it. Location decided at
build (candidates: a new `@bugsee/adapter-kit`, or fold P4/P5 into `@bugsee/node`/`@bugsee/core` since they're
portable). This also lets us retrofit `@bugsee/nextjs` onto the shared kit (no behaviour change).

## 4. Differentiation (same moat as Next.js, extended)
1. **Full-session capture stitched to the server throw, across runtimes** — the white space; no competitor
   ships "the client session that led to *this* SSR failure" as one artifact for these frameworks either.
2. **Edge where Sentry doesn't go** — notably **SvelteKit on Vercel Edge** (Sentry explicitly unsupported)
   and Nuxt edge presets; we already have `@bugsee/vercel-edge`/`@bugsee/cloudflare`.
3. **Zero-config trace join** — the `<meta traceparent>` channel + FE→BE propagation already built.
4. **Fewer moving parts than Sentry** — Bugsee's `node:http` **emit-patch** (not `import-in-the-middle`) means
   the Nuxt/Remix node server init does **not** need Sentry's fragile `--import` preload; a normal server
   plugin / entry import suffices (verify: patch installs before the first request).

## 5. Design decisions (D1 + D7 CONFIRMED 2026-07-05; D2–D6 proposed defaults)
- **D1 — Extract a shared meta-framework kit** (P4 server-error bridge + P5 trace helper); retrofit nextjs onto
  it. Avoids 5× duplication of the moat logic. **✅ CONFIRMED — extract + retrofit** (slice **K0**, first).
- **D2 — Runtime-adapter first; defer source-maps (P6) to #158** — identical to nextjs D2. The runtime seams
  (client/server/error/trace/edge) need no source maps; build them first, land full-session capture, wire P6
  when #158 ships.
- **D3 — Remix = React-Router-v7 (framework mode) first**, Remix v2 as a thin back-compat variant. RR7 is the
  go-forward target with the cleaner surface (`onError` prop, `getMetaTagTransformer`, native instrumentation
  API); v2 differs in client-error wiring + trace channel only.
- **D4 — Astro ships the browser launch only, island-framework-agnostic** — `injectScript('page')` boots
  `@bugsee/browser`; the user adds the matching `@bugsee/<framework>` island adapter (mirrors Astro's renderer
  model + our structural-peer convention). Don't couple `@bugsee/astro` to one UI adapter.
- **D5 — SvelteKit supports edge** (`config.runtime:'edge'` → `@bugsee/vercel-edge`) — a concrete win over
  Sentry. Init default = top-of-`hooks.server.ts` (version-portable), with optional `instrumentation.server.ts`
  support. Context opens in the `handle` hook (`store.run` around `resolve`) — one seam covers every adapter.
- **D6 — Nuxt ships as a Nuxt Module**; server via a Nitro server plugin (no `--import` preload — emit-patch);
  runtime chosen at build from the Nitro preset (node vs edge/cloudflare), not per-request.
- **D7 — Build order: ✅ CONFIRMED ECOSYSTEM-FIRST → `K0 → Remix(RR7) → Nuxt → SvelteKit → Astro`.** Extract
  the shared kit (K0) first, then the biggest ecosystems (React's Remix, Vue's Nuxt) before Svelte/Astro.

## 6. Build slices (per framework — each: test-first → mutator → review → commit, like nextjs)
Shared **K0 — ✅ DONE:** extracted into the new portable package **`@bugsee/adapter-kit`**
(`reportServerError` (P4) + `getTraceparent`/`traceMetaEntries` (P5), deps: `@bugsee/core` only); retrofitted
`@bugsee/nextjs` onto it (behavior-identical, 57 tests unchanged, `.` entry still node-free). The four
adapters below consume the kit.

- **SvelteKit** — S1 client (`hooks.client.ts` helpers + `@bugsee/svelte`) · S2 `bugseeHandle()` (ALS context +
  first-owner-wins) + `handleErrorWithBugsee` (P4) · S3 trace via `transformPageChunk` · S4 init placement
  (`instrumentation.server.ts` + hooks-top) · S5 edge (`config.runtime:'edge'`) · S6 Vite plugin + #158.

  **AS-BUILT STATUS (2026-07-07) — @bugsee/sveltekit COMPLETE (node + edge), real-boot validated.** SK1–SK4
  shipped (`880edd7`/`0771d67`/`2937a1f`/`53aec9e`/`d940009`/`e305926`). Function-exports (like Remix): `.`
  portable (`handleErrorWithBugsee`+`handle`/trace) · `./server` (`registerServer`=bugsee/node) · `./client`
  (`registerClient`+`export * from @bugsee/svelte`) · `./edge` (`registerServerEdge`+`createEdgeHandle`).
  **EDGE is the differentiator:** SvelteKit's `handle` WRAPS `resolve()`, so `createEdgeHandle` wraps it in
  `runInEdgeContext` → a FULL run()-scoped per-request context on edge (Sentry unsupported; better than Nuxt
  edge, which can't wrap). Validated by a real-SvelteKit adapter-node **boot e2e** (`@bugsee/sveltekit-e2e`:
  thrown endpoint → uploaded bundle w/ `http-error` + message; SSR HTML carries the injected `<meta
  traceparent>`). Multi-agent reviewed to convergence: 1 MAJOR fixed (missing publishConfig.exports); edge
  flush/report ordering verified (resolve() doesn't throw on load/render error → `handleError` reports INSIDE
  the edge ctx → `runInEdgeContext` finally flushes it; no double-report). **REMAINING:** edge BOOT e2e (needs
  adapter-vercel/cloudflare + edge VM — follow-up; edge module is unit + bundle-isolation verified) · S6
  source-maps (#158). Known-minor: hook types return `unknown` (idiomatic un-annotated usage works, matches
  @bugsee/svelte).
- **Remix/RR7** — R1 server error bridge + preload init (RR7 `handleError`) · R2 client entry + `bugseeOnError`
  (RR7) · R3 trace (`getMetaTagTransformer`) · R4 server txn + route names (native instrumentation API) · R5
  Remix-v2 back-compat entry set · R6 build/source-maps (#158).
- **Nuxt** — U1 module skeleton (`defineNuxtModule`) · U2 client plugin (`@bugsee/browser`+`@bugsee/vue`) · U3
  Nitro server plugin (`launch()`; verify patch-before-first-request) · U4 `nitroApp.hooks('error')` bridge · U5
  trace via `render:html` · U6 edge/cloudflare preset branch · U7 source-maps (#158).

  **AS-BUILT STATUS (2026-07-07) — @bugsee/nuxt MOAT COMPLETE + real-boot validated.** U1–U5 shipped
  (`893422b`/`84afc54`/`edc5b64`/`ea96f7c`/`83a64a7`) + a **real-Nuxt boot e2e** (`510b98f`,
  `@bugsee/nuxt-e2e`: nuxi-builds a fixture app → boots the node-server `.output` → asserts a thrown route
  uploads a bundle with our `http-error` mechanism + the real message, and the SSR HTML carries the injected
  `<meta name="traceparent">`). Note U3+U4 landed together inside `installBugseeNitro` (one Nitro plugin does
  launch + `error` hook + `render:html`); the U1 module ships the client plugin as a generated `#imports`
  template (no heavy `nuxt` dep) + the shipped `runtime/nitro-plugin`.
  - **U6 edge/cloudflare preset — ✅ DONE (`153ec49`).** The module branches the shipped runtime plugin on the
    build-time preset (`isEdgePreset(nuxt.options.nitro.preset)` → `runtime/nitro-plugin.edge`), so an edge
    preset bundles ONLY the edge SDK, never `bugsee/node` (verified both ways in the built output).
    `installBugseeNitroEdge` (`@bugsee/nuxt/edge`, composes `@bugsee/vercel-edge`) launches the edge SDK + wires
    `nitroApp.hooks('error')` → report via `logException`+`flush`, held past the Response by
    `resolveWaitUntil(ctx)` (Cloudflare's `event.context.cloudflare.context`, else Vercel Edge's global
    request-context symbol). Validated by a **real-Nuxt `vercel-edge` build e2e** (`@bugsee/nuxt-e2e`
    `edge-build.e2e.ts`: nuxi-builds the fixture for the edge preset, asserts the edge function bundle carries
    `installBugseeNitroEdge`+`launchEdge` and NOT the node core / `node:http` emit-patch). **v1 = edge ERROR
    REPORTING** (the differentiator; Sentry has no Nuxt edge). **v2 (documented, not built):** full per-request
    `run()`-context + trace on edge — needs Nitro fetch-entry wrapping (Nitro owns the entry; the edge store is
    `run()`-only, no `enterWith`, so a point-hook can't open a request-scoped context), plus per-preset
    `@bugsee/cloudflare` enrichment (request.cf) instead of the shared vercel-edge composition, and a `deno-deploy`
    branch (currently classified node).
  - **U7 source-maps — BLOCKED on #158** (the shared Vite/Rollup source-map-upload plugin). Not Nuxt-specific;
    every adapter's build slice waits on #158. Wires in as an `addVitePlugin` once #158 ships. **This is the
    ONLY remaining Nuxt item, and it is externally blocked.**
- **Astro** — A1 integration skeleton + client `injectScript('page')` · A2 server `injectScript('page-ssr')` +
  node/edge branch · A3 middleware (context + try/catch error capture, `order:'pre'`) · A4 trace via response
  rewrite · A5 source-maps (#158) · A6 real-Astro e2e.

  **AS-BUILT STATUS (2026-07-07) — @bugsee/astro COMPLETE (node + edge), real-boot validated. ALL 4
  META-FRAMEWORKS DONE.** Commits `67ef8f8`/`6b2aea1`/`5f29fb1`/`b925f91`/`3564b91`/`4903eb7`/`efd5d75`.
  Island-agnostic (browser-launch only; user adds their UI adapter). `.` = the `bugsee()` Integration
  (build-time) · `./middleware` (portable — `createBugseeMiddleware`: wraps `next()` try/catch → report +
  rethrow, since Astro has NO onRequestError; trace = HTML response-rewrite before `</head>`) · `./server`
  (node) · `./client` (browser) · `./edge` (`createEdgeMiddleware` wraps `next()` in `runInEdgeContext` — full
  run()-context). **KEY FIX (review-caught major):** the server SDK launches from the MIDDLEWARE (a generated
  virtual module wired via `addMiddleware`), NOT `injectScript('page-ssr')` — Astro only prepends page-ssr to
  `.astro` PAGE modules, so an endpoint-first cold request would drop its report. Validated by an
  **endpoint-first** real-Astro `@astrojs/node` boot e2e (`@bugsee/astro-e2e`: probes `/api/health`, hits
  `/api/boom` before any page → the report still uploads) + the page trace `<meta>`. 2-round review CONVERGED.
  Remaining: A5 source-maps (#158) · edge boot e2e (adapter-vercel/cloudflare).

## 🎉 The 4 SSR meta-framework adapters are COMPLETE (2026-07-07)

Remix + Nuxt + SvelteKit + Astro — all shipped over the shared `@bugsee/adapter-kit`, each **real-boot
validated** (a fixture app built + booted against a mock collector: a thrown server route uploads a bundle
with the `http-error` mechanism + the real message, and the SSR HTML carries the injected
`<meta name="traceparent">`) and **multi-agent reviewed to convergence**. Node everywhere; edge on
Nuxt/SvelteKit/Astro (Sentry-unsupported differentiator). The two shared follow-ups are external/deferred:
**source-maps** (blocked on #158 — every adapter's P6) and the **edge boot e2e** for SvelteKit/Astro (needs
adapter-vercel/cloudflare + an edge VM; the edge modules are unit + bundle-isolation verified).

## 7. Open verification items (flagged by research — resolve at each build)
- **Nuxt/Remix/SvelteKit(node):** confirm Bugsee's `node:http` emit-patch attaches to the framework's server
  instance and installs **before the first request** (else fall back to a Sentry-style preload for that case).
- **SvelteKit:** whether to lean on native `getRequestEvent()` ALS vs Bugsee's own context (avoid
  double-instrumentation); `handleError` doesn't fire for the `error()` helper (expected) — pair with a
  `handle` try/catch for `handle`-level throws.
- **Remix v2 vs RR7:** two entry-file variants; RR7 SDK surface is **beta** (pin ≥7.15 for the instrumentation
  API); confirm RR7 `handleError` fires for middleware errors.
- **Astro:** prerendered-page-first can leave server-islands uninstrumented until an SSR route warms init
  (mirror Sentry's caveat); Astro-native ALS isolation is unverified — own the context. Defer Cloudflare-Astro
  worker-wrap (upstream in flux).
- **All:** P6 (source-map upload) is blocked on **#158**; every adapter's build slice depends on it.

## 8. Sources
Four research reports (Nuxt/Nitro + @sentry/nuxt; Remix v2 + React Router v7 + @sentry/remix/@sentry/react-router;
SvelteKit + @sentry/sveltekit; Astro + @sentry/astro), each citing primary docs + Sentry source. Full URL lists
in-session (agent transcripts). Key primaries: Nitro deploy/plugins/hooks docs; Remix/RR7 `entry.{client,server}`
+ `handleError` docs + Sentry source; SvelteKit hooks/observability/adapters docs + `@sentry/sveltekit` source;
Astro Integration/Middleware/on-demand-rendering docs + `@sentry/astro` source.
