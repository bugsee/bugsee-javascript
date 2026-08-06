# Adversarial review — @bugsee/nextjs

**Reviewed:** 2026-07-27 · **Scope:** packages/nextjs (impl 512, tests 1059)
**Next.js actually exercised:** **NONE.** `next` is not installed anywhere in the monorepo (`find . -name package.json -not -path '*/node_modules/*' | xargs grep -l '"next"'` → no hits; `node_modules/next` absent). There is no `nextjs-e2e` package, although `nuxt-e2e`, `sveltekit-e2e` and `astro-e2e` all exist and install their real frameworks (`nuxt@^4.4.8`, `@sveltejs/kit@^2`, `astro@^5`). Runtime resolution was therefore verified with **esbuild using Next's edge condition set** (`edge-light,worker,browser`), and behaviour was verified with **real launched Bugsee clients** (node + edge) plus decompressed upload bundles.

**Verdict:** The prior handed to me was substantially wrong about scope and I am reporting the code, not the prior. **There is no tunnel and no `next.config` wrapper in this package** — slice N6 (`withBugsee`, source-map upload, `experimental.instrumentationHook`, the hardened tunnel) is designed in `docs/design/nextjs-adapter.md:117` but **not built**, so mandate items 3 and 4 have no code to audit and the SSRF/config-preservation questions are moot-by-absence. What *is* built is small, disciplined and unusually well tested: **12/12 injected mutations were caught, zero survivors**, and I empirically confirmed the differentiator works on the node runtime — the uploaded report carries `trace_id` equal to the browser-propagated trace and a `context_id` that matches the route-attribution event. The umbrella's 3-condition gap does **not** bite here, because every entry either uses an explicit subpath or bypasses the umbrella. The serious problem is elsewhere and it is structural: **the portable `.` entry cannot be compiled for Next's Edge runtime.** `register()`'s dynamic imports are static literal specifiers, which bundlers follow, so compiling `instrumentation.ts` for edge drags all of `@bugsee/node` + `@bugsee/node-utils` and 13 `node:*` builtins into the edge graph — 42 unresolved-module errors. The comment in the file asserting the opposite is reasoning about the SDK's own tsup build, not the customer's. Secondarily, the N7 trace channel has no interaction with Next's render-cache model, which is where the mis-stitch risk lives.

## SEV1

### 1. `register()`'s dynamic imports pull the entire Node SDK into the Edge bundle — the edge build cannot compile
- **Where:** `packages/nextjs/src/register.ts:41` (and `:44`), comment at `packages/nextjs/src/register.ts:5-10`
- **What:** `register()` is exported from the runtime-portable `.` entry and is the documented `instrumentation.ts` entry point (`register.ts:28-33`). It dispatches with `await import('@bugsee/nextjs/server')`. That is a **static literal specifier**, which every bundler statically resolves and follows — it is not deferred to runtime resolution. Next compiles `instrumentation.ts` for **both** the `server` and `edge-server` compilations, and the edge compilation bundles everything (there is no `node_modules` resolution in an edge isolate). So the `NEXT_RUNTIME === 'nodejs'` branch — which can never *execute* on edge — is nonetheless *compiled into* the edge graph.
- **Why it matters:** this breaks the customer's `next build` outright for any app that has middleware or an edge route, which is precisely the configuration this adapter targets (it ships `./edge` and `withBugseeMiddleware`). It is also the exact hazard the file claims to have solved.
- **Evidence:** bundling a canonical `instrumentation.ts` (`import { register } from '@bugsee/nextjs'`, verbatim from the docblock at `register.ts:28-33`) with Next's edge conditions:
  ```
  esbuild entry.ts --bundle --format=esm --splitting \
    --conditions=edge-light,worker,browser --platform=neutral
  → 42 errors
  ```
  13 distinct builtins are dragged in: `node:async_hooks, node:buffer, node:crypto, node:fs, node:http, node:https, node:inspector, node:os, node:path, node:perf_hooks, node:process, node:worker_threads, node:zlib` — from `../node/src/launch.ts`, `../node/src/http-server-interceptor.ts`, `../node/src/event-loop-watchdog.ts`, `../node/src/cpu-profiler.ts`, `../node-utils/src/fs-storage.ts`, `../node-utils/src/worker-ring-worker.ts`, and ~20 more.
  **Counterfactual (proves the dynamic import is the cause, not the package layout):** bundling `@bugsee/nextjs/edge` directly under the same conditions produces exactly **one** unrelated error (finding SEV2-4) instead of 42. **Control:** the same entry under `--conditions=node --platform=node` builds cleanly.
  The comment at `register.ts:5-10` — *"a bare specifier stays EXTERNAL to the bundler in BOTH formats"* — is true of the package's own tsup build (confirmed: `dist/index.js:32` and `dist/index.cjs:34` both preserve the literal `await import('@bugsee/nextjs/server')`) but does not hold for the consumer's webpack/Turbopack edge compilation, which is the case that matters.
- **Note:** the guard test at `register.test.ts:48-53` asserts the specifier *is* the self-subpath form — i.e. it actively locks in the shape that causes this. Both dynamic-import branches are mocked (`register.test.ts:9-10`), so no test ever resolves them for real.

### 2. N7's trace channel ignores Next's render-cache model — silently absent on static routes, shared across users on cached ones
- **Where:** `packages/nextjs/src/trace-data.ts:30-34`; underlying read at `packages/adapter-kit/src/trace-data.ts:20-33`
- **What:** `getBugseeTraceData()` is documented for use inside `generateMetadata()` (`trace-data.ts:22-28`) and returns a **per-request** value read from the active `RequestContext.trace`. Next decides whether a route is statically rendered or cached using **its own** dynamic-API signals (`headers()`, `cookies()`, `searchParams`, `connection()`). Reading a third-party AsyncLocalStorage is invisible to Next, so this call provides no dynamic signal and the route's default rendering mode is unchanged.
  - **Statically rendered route (the App Router default):** at build time there is no active request context, so `getTraceparent` returns `undefined` (`adapter-kit/src/trace-data.ts:27-28`) and `getBugseeTraceData()` returns `{}` → **no `<meta name="traceparent">` is emitted at all**, and the BE→FE half of the stitch silently never happens. There is no warning and no documentation of this.
  - **ISR / full-route-cached route:** the HTML is rendered once and served to many users for the revalidate window, **including the baked `<meta name="traceparent">`**. Every browser that loads it adopts that trace id as its pageload trace (`packages/browser/src/meta-trace.ts:35-43` — `readMetaTraceContinuation` adopts `traceId` and `parentSpanId` with no freshness or ownership check). Since `trace_id` is the report-level cross-project join key (`packages/core/src/bundle-assembler.ts:130-133`, `packages/protocol/src/wire.ts:73-78`), a server error occurring in user B's request joins a trace that user A's browser session also adopted — **user A's session and user B's server error become one artifact.**
- **Why it matters:** the first limb silently disables the differentiator for the most common rendering mode; the second is a cross-user correlation defect in a privacy-sensitive product.
- **Evidence (proven vs. inferred — stated explicitly):** *Proven here* — the value is strictly per-request and is `{}` with no context (`trace-data.test.ts:37-42`, and my probe returned `{}` when called outside a request); adoption is unconditional (`meta-trace.ts:35-43`); `trace_id` is the join key (`bundle-assembler.ts:130-133`); and there is **no** dynamic-render opt-out, cache-busting, freshness stamp, or test anywhere in `packages/nextjs` — `grep -niE "static|cache|dynamic|prerender|ISR|force-dynamic"` over `docs/design/nextjs-adapter.md` returns nothing about N7. *Inferred* — that Next serves a cached `generateMetadata` result to multiple users is documented Next behaviour I could not execute here, since `next` is not installed. If that interaction is confirmed on a real build, this is unambiguously a privacy defect; either way the missing cache-interaction design is real and actionable.

## SEV2

### 3. Edge `onRequestError` never extends the isolate lifetime — the incident upload races the freeze
- **Where:** `packages/nextjs/src/on-request-error.ts:59-73`; report is fire-and-forget at `packages/adapter-kit/src/report-server-error.ts:30`
- **What:** `onRequestError` is the single hook for both runtimes (`on-request-error.ts:8-11`). It calls `reportServerError`, which does `void client.logException(...)` and returns. Nothing calls `client.flush()` and nothing routes through `waitUntil`. On the Edge runtime the isolate freezes the moment the `Response` is returned — the codebase documents this itself: *"An edge isolate freezes the instant the `Response` is returned, so a fire-and-forget upload `fetch` is silently dropped"* (`packages/vercel-edge/src/wait-until.ts:2-3`).
- **Why it matters:** the upload is a **3-hop sequential handshake** — I measured `POST /v2/sessions` → `POST /v2/issues` → `PUT https://s3.test/put` — with nothing holding the isolate open, against a response that is returned immediately. Every other edge path in the repo deliberately guards this (`packages/vercel-edge/src/edge-context.ts:67-73` wraps the flush in `waitUntil`; `fetch-handler.ts:51-55` likewise). The flagship server-error path is the one that omits it. `withBugseeMiddleware` is *not* a mitigation: it covers `middleware.ts` only (`middleware.ts:47-59`), not edge Route Handlers or edge RSC renders.
- **Evidence:** probe with a real launched edge client — `onRequestError(...)` with no flush did complete the 3 hops **when the test's event loop was kept alive artificially** (`uploadedWithoutFlush: true`, urls `["…/v2/sessions","…/v2/issues","https://s3.test/put"]`). That is the *generous* case and is exactly what does **not** hold on Vercel Edge. `on-request-error.test.ts:174` masks this by calling `await client.flush()` explicitly, and there is no edge-runtime test of `onRequestError` at all.
- Note this is currently shadowed by SEV1-1 (edge does not build), but must be fixed alongside it.

### 4. Even the pure edge entry fails to bundle — `node:crypto` reached from `@bugsee/util`
- **Where:** `packages/util/src/sha256.ts:24`, reached via `packages/nextjs/src/edge.ts:11` → `@bugsee/vercel-edge`
- **What:** `digestSha256` prefers global WebCrypto and falls back to `await import('node:crypto')`. The fallback is unreachable at runtime on edge (WebCrypto is present), but the specifier is a static literal so bundlers must still resolve it.
- **Evidence:** bundling `@bugsee/nextjs/edge` alone with `--conditions=edge-light,worker,browser` yields exactly one error: `Could not resolve "node:crypto"` at `../util/src/sha256.ts:24:38`. Attribution is `@bugsee/util`/`@bugsee/vercel-edge` (blast radius, not a nextjs defect), but it means fixing SEV1-1 alone will **not** make the edge build pass.

### 5. Zero real-Next coverage — the whole adapter is tested against structural stand-ins
- **Where:** `packages/nextjs/src/register.test.ts:9-10`; absence of `packages/nextjs-e2e`
- **What:** every Next surface is modelled structurally with no `next` dependency (deliberate, per `on-request-error.ts:21-36`), and no test ever runs Next. Specifically missing: any test that a Next **edge** compilation resolves (would have caught SEV1-1); any test of `onRequestError` on the edge runtime (SEV2-3); any browser↔server stitch round-trip through real SSR'd HTML; any `generateMetadata`/static-render test (SEV1-2). `register.test.ts` mocks *both* dynamic-import targets, so the resolution behaviour that actually breaks is never exercised.
- **Why it matters:** the sibling adapters set the bar — `nuxt-e2e`, `sveltekit-e2e` and `astro-e2e` each install and run the real framework. `nextjs`, the flagship and the template the other four were modelled on, has no equivalent, and `next` is absent from the monorepo entirely.
- **Not test theater in the small:** within their chosen scope these tests are strong (see mutation results below) — the gap is scope, not rigour.

### 6. Slice N6 is unbuilt, and the README documents none of the required wiring
- **Where:** `docs/design/nextjs-adapter.md:117-118` vs. `packages/nextjs/src/` (no `withBugsee`, no tunnel — `grep -rniE "tunnel|withBugsee\b|next\.config|webpack|turbopack" packages/nextjs/src packages/nextjs/README.md packages/nextjs/package.json` returns **zero** hits); `packages/nextjs/README.md` is 5 lines
- **What:** the design's build-time integration — `withBugsee(nextConfig, opts)`, source-map upload composing #158, `experimental.instrumentationHook` injection for Next 13/14, and the hardened opt-in tunnel — does not exist. Users must hand-write `instrumentation.ts`, `instrumentation-client.ts`, `generateMetadata`, and `middleware.ts` wiring from docblocks. On Next 13/14 the adapter cannot work at all without the `experimental.instrumentationHook` flag that N6 was to inject, and `register()` silently no-ops in that case (see SEV3-8).
- No SSRF, request-size, method, rate-limit or token-validation audit is possible or needed: **there is no tunnel route.** If N6 is built later, that audit must happen then.

### 7. Blast radius: a throwing host `waitUntil` in middleware takes the whole site down
- **Where:** `packages/nextjs/src/middleware.ts:56-58` → `packages/vercel-edge/src/edge-context.ts:67-73`
- **What:** the previously-confirmed `@bugsee/vercel-edge` SEV1 — `waitUntil(client.flush())` sits in an unguarded `finally`, so a throwing host `waitUntil` propagates out and destroys the response — reaches its **maximum** blast radius here, because Next middleware runs on **every matched request**. A failure mode that is per-route elsewhere is site-wide here. `withBugseeMiddleware` adds no guard of its own. Inherited, but this adapter is where it hurts most; the fix belongs upstream.

## SEV3

### 8. `register()` silently no-ops when `NEXT_RUNTIME` is unset, with no diagnostic
- **Where:** `packages/nextjs/src/register.ts:39-46`
- **What:** if `NEXT_RUNTIME` is neither `'nodejs'` nor `'edge'`, `register()` falls through and returns having done nothing — no log, no `onError`, no throw. This is exactly the Next 13/14-without-`instrumentationHook` case, and any misconfiguration. The user's only symptom is that Bugsee never reports. `register.test.ts:37-42` asserts the silent no-op as intended behaviour, so it is locked in.

### 9. `NextRequestErrorRequest.headers` is declared but never read
- **Where:** `packages/nextjs/src/on-request-error.ts:25` (declared); `grep -rn "\.headers" packages/nextjs/src/*.ts` excluding tests → no reads
- **What:** Next passes the request headers to `onRequestError` and the adapter models the field, then discards it. On the edge runtime — where nothing opens a per-request context for route handlers or RSC renders — the inbound `traceparent` header is the *only* available join key, and it is thrown away. Reading it would let the edge path recover the correlation that SEV2-3 and SEV1-1 otherwise cost it. Low effort, directly serves the differentiator.

## Three-runtime resolution matrix

| Next runtime | condition resolved | SDK entry loaded | correct? | evidence |
|---|---|---|---|---|
| **browser** (client) | `browser` | `@bugsee/bugsee` → `src/index.ts` (browser) | ✅ **yes** | `client.ts:12` imports the bare umbrella; umbrella `exports` has a `browser` condition (`packages/bugsee/package.json:12-15`). Next's client compilation sets `browser`, so the 3-condition gap is dodged. |
| **node server** | n/a — explicit subpath | `@bugsee/bugsee/node` → `src/index.node.ts` | ✅ **yes** | `server.ts:16-21` imports the explicit `/node` subpath (`packages/bugsee/package.json:22-25`), bypassing condition resolution entirely. Verified by launching a real client: node capture + APM + reports all work. |
| **edge** (`edge-light`) | would be `edge-light` → falls to `default` | **the module graph does not resolve at all** | ❌ **no — build fails** | `edge.ts:11` correctly bypasses the umbrella and imports `@bugsee/vercel-edge` directly, so the missing `edge-light` condition is *also* dodged. But the edge graph still fails to compile for two independent reasons: SEV1-1 (`register.ts:41` drags `@bugsee/node`, 42 errors) and SEV2-4 (`node:crypto` via `util/src/sha256.ts:24`, 1 error). |

**Headline answer to the highest-value question:** the confirmed umbrella 3-condition gap does **not** cause a wrong-entry resolution in this adapter — all three entries sidestep it (explicit subpath / direct-package / genuine `browser` condition). The edge story is nonetheless broken, but by the dynamic-import bundling defect, not by condition resolution.

`register()` idempotency: `registerServer` is a per-process singleton (covered, `server.test.ts:174`); `registerEdge` idempotency I verified directly by probe (two `registerEdge('tok', …)` calls returned the identical client, `c1 === c2` → `true`). `register()` itself holds no guard and re-runs the `await import` per invocation, which is harmless given the singletons.

## Session-stitching analysis

**Mechanism (three legs, all confirmed present in code):**
1. **FE→BE** — the browser propagates W3C `traceparent` (+ `bugsee=` `tracestate`) on outgoing requests (`packages/capture/src/traceparent.ts`, gated by same-origin/allowlist at `:33-34`). The server continues it as a true child (`packages/node/src/server-instrument.ts:395-414`).
2. **BE→FE** — `getBugseeTraceData()` (`trace-data.ts:30-34`) emits `traceparent` into `Metadata.other`; the browser adopts it on pageload (`packages/browser/src/meta-trace.ts:35-43`).
3. **Join key** — the report envelope carries `trace_id`/`span_id` plus `context_id` (`packages/core/src/bundle-assembler.ts:129-133`), and every capture entry is stamped with the same context (`packages/core/src/capture-aggregator.ts:48`).

**Empirically verified end-to-end on the node runtime.** I launched a real `registerServer` client, opened a real server request via `runServerRequest` carrying an inbound browser traceparent `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`, called `getBugseeTraceData()` (as `generateMetadata` would) and then `onRequestError`, then decompressed the uploaded bundle:

```
getBugseeTraceData()  → { traceparent: "00-0af7651916cd43dd8448eb211c80319c-d48aca3f8993c0b1-01" }
request.json  trace_id   = 0af7651916cd43dd8448eb211c80319c   ← the BROWSER's trace, continued
request.json  span_id    = d48aca3f8993c0b1                    ← fresh server span
request.json  context_id = a88319189a34497fa908e7c9f8adc749
events.user.json[0].context_id = a88319189a34497fa908e7c9f8adc749   → MATCH
events.user.json[0].params = {routerKind:"App Router", routePath:"/api/users/[id]",
                              routeType:"route", method:"POST", path:"/api/users"}
```
The trace id is adopted from the browser, the span id is fresh (correct parent-child), the route attribution and the report share one `context_id`. **The differentiator genuinely works on node.** (An earlier probe of mine appeared to show a missing `trace_id`; that was my own error — I had called `runServerRequest` with the wrong arity. Re-checked with the correct `(info, options, dispatch)` signature, it is correct. Flagging because vitest does not typecheck, so the wrong-arity call ran silently.)

**Failure modes:**
- **No inbound trace** (direct API call, bot, `curl`) — the server mints a fresh root trace; the report is self-consistent but has no browser session to join. Correct and graceful.
- **Statically rendered route** — no meta tag emitted at all (SEV1-2 limb 1); BE→FE stitching silently absent.
- **Edge runtime** — no per-request context is opened for route handlers or RSC renders (only `withBugseeMiddleware` opens one, and only for middleware), so an edge `onRequestError` report carries neither `context_id` nor `trace_id`, and `request.headers` — which holds the inbound traceparent — is discarded (SEV3-9). Compounded by SEV2-3.

**Mis-stitch risk:** the only route to attaching user A's session to user B's error is a **shared trace id**. Forging one requires guessing a 128-bit random value — not a practical attack. The realistic vector is **cache-mediated, not adversarial**: a cached/ISR `generateMetadata` result serving one traceparent to many browsers (SEV1-2). Notably `parseTraceparent` (`packages/capture/src/traceparent.ts:71-90`) strictly validates hex, length, the forbidden `ff` version and all-zero ids, so malformed or injected values are rejected rather than adopted.

## Tunnel security audit

**Not applicable — there is no tunnel.** `grep -rniE "tunnel" packages/nextjs/` returns zero hits across src, README and package.json. The tunnel is a design item only (`docs/design/nextjs-adapter.md:117`, slice N6, "the hardened opt-in tunnel"). There is consequently no SSRF surface, no destination allowlist to audit, no request-size/method/rate limiting to check, and no token validation to verify — because no route proxies anything. **This audit must be performed if and when N6 is built**; the specific questions to carry forward are: destination allowlisted to Bugsee endpoints only (not attacker-supplied), method restricted to POST, body size capped, app-token validated server-side, and rate limiting present.

## next.config wrapper safety

**Not applicable — there is no config wrapper.** No `withBugsee` exists (`grep -rniE "withBugsee\b|next\.config|nextConfig|webpack|turbopack" packages/nextjs/src` → zero hits). Nothing modifies the customer's `next.config`, so nothing can drop their `webpack`/`experimental`/`redirects` keys — the shallow-merge class of defect is absent by construction. Equally, none of the promised build-time integration exists: no source-map/debug-id upload (so the confirmed recursive-`*.map`-unlink and `build.sourcemap` default-off defect classes in `@bugsee/bundler-plugin-core` are **not reachable from this package** — it does not depend on it), and no `experimental.instrumentationHook` injection for Next 13/14. Turbopack-vs-webpack compatibility is therefore untested but also unexercised — **except** that SEV1-1 is a *bundler-level* defect that will manifest under both webpack and Turbopack, since both statically resolve literal dynamic imports.

The mutation I was asked to prioritise — "drops a user's `next.config` key" — has no target. I ran the nearest equivalent instead: deleting `...launchOptions` from `registerServer` (`server.ts:62`), i.e. silently discarding every user-supplied option. **Caught** (13 tests failed).

## Trace-meta injection safety

**Escaping — clean, and better than the adapter-kit finding implies.** This package uses `traceMetaEntries` (`trace-data.ts:33`), which returns `Record<string, string>` for Next's `Metadata.other` — Next renders that through React, which attribute-escapes. It does **not** use `traceMetaTag` (`packages/adapter-kit/src/trace-data.ts:47-50`), the unescaped raw-HTML sink from the prior SEV2. So that sink is unreachable from `@bugsee/nextjs`.

**The hex invariant is genuinely enforced upstream**, contrary to the prior's framing that it is merely asserted. The only path by which user-controlled input could reach the traceparent is an inbound `traceparent` request header, and `parseTraceparent` (`packages/capture/src/traceparent.ts:71-90`) rejects anything that is not `HEX2-HEX32-HEX16-HEX2`, rejects version `ff`, and rejects all-zero ids — a header containing `"` or `<` cannot survive it. Combined with React escaping this is defence in depth. **No XSS reachable here.**

**Hydration:** `<meta>` tags emitted via `generateMetadata` are rendered server-side into `<head>` and are not part of the React component tree that hydrates, so this does not itself produce a hydration mismatch. The real correctness problem with this injection is caching, not hydration (SEV1-2).

## Checked and found clean

- **Mutation testing: 12 injected mutations, 12 caught, 0 survivors.** Control mutation (`event name 'next.request-error' → 'next.MUTANT'`) caught, proving the harness. Also caught: dropping the route-attribution `event`; `mechanism: 'http-error' → 'uncaught'`; `path: request.path → context.routePath`; deleting `...launchOptions`; `otelConsume: true → false`; trace channel returning `{}`; dropping `getClient` forwarding; the `nodejs` dispatch branch never matching; removing the middleware context wrapper; the breadcrumb losing its `data` payload; ignoring OTel first-wins. Each mutation was applied from a `cp` backup and restored from that backup; final `shasum` of `src/*.ts` matches the pre-review baseline exactly and `git status --short packages/` is empty.
- **Umbrella 3-condition gap does not bite** — see the resolution matrix. All three entries sidestep it by construction.
- **`@bugsee/opentelemetry` fabricated root span id (`traceId.slice(0, 16)`) is NOT exposed here.** That defect lives in `packages/opentelemetry/src/to-otlp.ts:99`, on the **produce** (OTLP export) path. This adapter default-attaches **consume** only (`server.ts:62` `otelConsume: true`, gated at `packages/bugsee/src/wire.ts:247`) and never enables produce. Transactions upload natively via `performance.json`, not OTLP.
- **Host-app safety — every hook is guarded, and the guards were mutation-verified.** `reportServerError` try/catch (`adapter-kit/src/report-server-error.ts:24-33`); `createOnRouterTransitionStart` try/catch (`client.ts:62-73`); `getTraceparent` try/catch (`adapter-kit/src/trace-data.ts:21-32`); `attachBugseeOtelProvider` fully defensive (`otel-provider.ts:70-97`). `on-request-error.test.ts:78-87` proves a throwing client cannot escape the hook; `trace-data.test.ts` proves a hostile client yields `{}` rather than breaking `generateMetadata`. The proven `@bugsee/react` `componentDidCatch` unmount defect is not reachable through anything this package invokes — `@bugsee/react` is only re-exported for the user to mount themselves (`client.ts:20`, and `registerClient` explicitly does not auto-wire it, `client.ts:16-19`).
- **Middleware error capture is real, not just documented.** `runInEdgeContext` genuinely captures **and rethrows** (`packages/vercel-edge/src/edge-context.ts:55-64`), so the docblock claim at `middleware.ts:5-6` is accurate. `middleware.test.ts` uses a real launched edge client with `importOriginal` (not a stub) and asserts the incident actually uploads for sync throws, async throws, and the `undefined`-continue path — genuinely good tests.
- **No query-string leak on the edge path.** `requestAttributes` strips the query and keeps only the pathname (`packages/vercel-edge/src/fetch-handler.ts:26-45`). Confirmed empirically: with a request URL of `https://app.test/api/users/7?token=SECRET`, the string `SECRET` does not appear anywhere in the decompressed upload bundle.
- **`registerEdge` is idempotent** (probe: two calls → identical client), and `registerServer` is a per-process singleton (`server.test.ts:174`) — dev-HMR re-entry is safe on both.
- **OTel first-wins is correctly implemented** — `otel-provider.ts:83` checks the return value of `setGlobalTracerProvider` and never clobbers a pre-existing `@vercel/otel`, emitting a coexistence diagnostic instead (`:86-92`). Mutation-verified.
- **The portable `.` entry is genuinely node-free at the source level** — `index.ts` re-exports only `on-request-error`, `register` and `trace-data`, whose static imports are `@bugsee/adapter-kit` and `@bugsee/core` only; the `./server` and `./edge` imports in `register.ts:11-12` are `import type` and are erased. The defect in SEV1-1 is purely the *dynamic* import, not the static graph.
- Package `exports` map, `sideEffects: false`, and `publishConfig` dual-format entries are consistent across all five subpaths.
- `pnpm --filter @bugsee/nextjs exec vitest run` → **8 files, 57 tests, all passing**, ~0.4s.

---
*Read-only review. Every file mutated during testing was backed up with `cp` and restored from that backup; no `git checkout` was used. Final `git status --short packages/` is empty and `src/*.ts` checksums match the pre-review baseline. No network requests were made to Bugsee infrastructure; no credentials were used; nothing was deployed.*
