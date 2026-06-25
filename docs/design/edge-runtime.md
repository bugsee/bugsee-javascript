# Edge-runtime support (Vercel Edge + Cloudflare Workers) — design

Status: **IN PROGRESS (2026-06-25).** Vercel Edge env builder built (`@bugsee/vercel-edge`, master `54df653`).
Prerequisite for `@bugsee/nextjs` (its Edge runtime resolves `edge-light`). Grounds the scattered edge notes in
`docs/design/sdk-design.md` (§3.x/§7.7/§12.5) with the competitive technique sweep + the full implementation
plan. **All gap-sweep findings are in scope** (user, 2026-06-25).

---

## 1. Context (understanding summary)

- **Targets:** Vercel Edge (`edge-light`) FIRST (unblocks Next.js), then Cloudflare Workers (`workerd`). Both are
  V8-isolate, Web-APIs-only runtimes (fetch/Request/Response/crypto.subtle; NO `node:*`/`fs`/`net`).
- **Capture is INCIDENT-DRIVEN** (see [[edge-capture-incident-driven]] / sdk-design §0.2): a no-incident
  invocation uploads nothing. "Streaming mode" = assemble-and-send a bundle per incident via `waitUntil`, same
  `/upload` endpoint, no new backend.
- **Approach:** reuse the existing bundle-assembly + upload pipeline with **memory-only storage**, a **WinterCG
  fetch transport**, a **portable ALS**, and a **`waitUntil` flush**. The kernel (core/capture/protocol/util/
  performance) is verified `node:*`-free.
- **Non-goal (v1):** edge APM (per-request transactions — opt-in/sampled; the Workers clock is clamped, §3.G9).

---

## 2. Competitive technique sweep (facts, primary-sourced 2026-06-25)

Three parallel agents over @sentry/cloudflare, @sentry/vercel-edge (+ Vercel `@vercel/functions`), and the
broader field (Bugsnag, OTel/`@microlabs/otel-cf-workers`, Datadog, Cloudflare-native, Firebase). Sources cited
inline. **Headline: the field is essentially Sentry vs us** — Bugsnag has no edge support (~6yr, blocked by
unguarded `navigator`/`node:fs`); Firebase has no JS-edge story; Datadog is ingest-only (no in-isolate tracer).
Our node-free-kernel rule clears exactly the bar Bugsnag fails.

### 2.1 The load-bearing techniques (and where a naive SDK fails)
1. **`waitUntil` to survive isolate freeze.** The isolate is frozen the instant `Response` returns; a
   fire-and-forget upload `fetch` is silently dropped. The flush promise MUST be handed to `waitUntil`.
   - **Vercel Edge has NO `ctx` param.** `waitUntil` is read off a global symbol:
     `globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil`, gated on
     `typeof globalThis.EdgeRuntime === 'string'` (Sentry vendors this ~15-line read —
     `core/src/utils/vercelWaitUntil.ts`; Vercel canonical: `@vercel/functions` `get-context.ts`/`wait-until.ts`).
   - **Cloudflare passes `ctx` to the handler** (`fetch(req, env, ctx)` / the DO/WorkerEntrypoint constructor
     `ctx`). Sentry's unified dispatcher (`nextjs .../responseEnd.ts`) tries `Symbol.for('__cloudflare-context__')`
     then `vercelWaitUntil`. `waitUntil` extends execution ~30s (CF) / the function's wall-clock budget (Vercel) —
     so flush has a short bounded timeout (Sentry: `flush(2000)`, `_flushInterval: 0` = no background timer).
   - **Deadlock subtlety (only if you INSTRUMENT `waitUntil`):** Sentry wraps `ctx.waitUntil` to wait for the
     user's background tasks (a flush-lock); the flush itself must then use the *original* un-instrumented
     `waitUntil` (`flush.ts:getOriginalWaitUntil`) or it deadlocks. Our simpler model does NOT wrap the user's
     `waitUntil` → we sidestep it.
2. **Per-invocation isolated transport buffer** (`IsolatedPromiseBuffer`). One isolate serves many concurrent
   requests; an eager `fetch` started in request A but resolved in B throws *"Cannot perform I/O on behalf of a
   different request"*. Sentry's buffer stores **task producers `() => PromiseLike`** (not live promises),
   `add()` defers, and the `fetch`es only fire at `drain()` (flush) — bounded to 30 payloads/invocation; drain
   swallows individual failures + races a timeout. (`vercel-edge/src/transports/index.ts`.) **For our
   incident-driven model** (assemble→enqueue→`flush()` all within ONE request, drained inside `waitUntil`) the
   cross-request hazard is largely sidestepped, BUT we must guarantee no upload `fetch` resolves outside the
   `waitUntil` scope and no I/O object is shared across requests → adopt the lazy-producer buffer to be safe.
3. **Portable ALS.** Read `globalThis.AsyncLocalStorage` (NEVER `import 'node:async_hooks'` in shared edge code);
   `new globalThis.AsyncLocalStorage()`; degrade to a no-op single-slot store + one-time `debug.warn`; **never
   throw at import** (Sentry's vendored `async-local-storage-context-manager.ts` does exactly this). Vercel Edge
   has ALS built-in (WinterCG subset); Cloudflare needs the `nodejs_compat`/`nodejs_als` compat flag.
   - **`enterWith()` is NOT in the WinterCG/Workers ALS subset** (nor `disable()`). Our Node store uses `run` +
     **`enterWith`** — the **edge store must be `run()`-scoped ONLY**. (Easiest portability trap to miss.)
4. **Drain the upload response body.** Cloudflare requires every `fetch` response body to be read/canceled or
   connections stall/deadlock (`cloudflare transport.ts` `await response.text()`). The transport must drain it.
5. **Handler-type coverage beyond `fetch`.** Cron (`scheduled`) and Queue (`queue`) invocations have **no
   incoming Request** → a fetch-only design misses them entirely. Full set (Sentry/otel-cf-workers): `fetch`
   (skip `OPTIONS`/`HEAD`), `scheduled` (`faas.cron`), `queue` (`faas.queue`), `email` (`faas.email`), `tail`
   (error-capture only, no span), Durable Objects (`fetch`/`alarm`/WebSocket/RPC), `WorkerEntrypoint`/RPC. Each
   needs its own context + its own `waitUntil(flush)`. (Vercel Edge is **fetch-only**.)
6. **Global error capture.** No reliable module-worker `'error'`/`process.on('uncaughtException')`. BUT Cloudflare
   exposes `addEventListener('unhandledrejection')` (under `nodejs_compat`; ALS context propagates into it),
   catching floating-promise rejections the handler `try/catch` misses. Sentry **skips** global handlers (handler
   try/catch only) — we ADD `unhandledrejection` where available as a safety net.
7. **Source maps without `fs`.** Single-file edge bundles shift line numbers every deploy → grouping breaks.
   Needs **build-time source-map upload + server-side symbolication** (Bugsnag *fails* here). The runtime stack
   parser must be `fs`-free (vendored regex parser; mark everything `in_app` — one bundled file).
8. **Cloudflare-native enrichment / primitives:** `request.cf` (free colo/country/city/timezone/asn/tls), Tail
   Workers (zero-instrumentation backstop — separate deployed worker, catches OOM/CPU-kill), Analytics Engine.
9. **Constraints:** memory-only (no `fs`/durable queue; isolate evicted >128MB); bundle size (Workers **3MB free
   / 10MB paid** compressed) → lean edge build; CPU-time (Free **10ms**/req) → capture must be near-zero-CPU,
   defer the send into `waitUntil`; **Workers clock is clamped** (updates only on I/O, Spectre mitigation) → CPU
   spans read ~0ms → edge APM timing is unreliable (reinforces deferring edge APM).

---

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Reuse the existing bundle pipeline** + memory storage; no separate "streaming-mode" core rewrite. Incident-driven: `logException`→assemble→enqueue→`client.flush()` inside `waitUntil`. | Edge incident-driven = bundle-mode mechanics with memory + `waitUntil`. `client.flush()` already drains pending uploads + assembling reports. |
| D2 | **Vercel Edge FIRST**, then Cloudflare. | Vercel Edge = simplest (global ALS built-in, fetch-only) AND it's what Next.js Edge resolves (`edge-light`). |
| D3 | **`waitUntil` acquired per-platform**: Vercel = `globalThis[Symbol.for('@vercel/request-context')].get().waitUntil` (gated on `EdgeRuntime` string); Cloudflare = the `ctx` param (`fetch(req,env,ctx)`) / `Symbol.for('__cloudflare-context__')`. A unified resolver tries both. | The #1 thing a naive SDK gets wrong (Vercel has no `ctx`). |
| D4 | **Lazy-producer transport buffer** (`IsolatedPromiseBuffer`-style) + response-body drain. | Avoid cross-invocation I/O ("on behalf of a different request") + Cloudflare body-drain requirement. |
| D5 | **Portable ALS: `run()`-only**, `globalThis.AsyncLocalStorage` probe, no-op single-slot fallback + one-time warn, never throw at import, NO `enterWith`. | `enterWith` absent on the WinterCG/Workers subset; node:async_hooks would break the edge bundle. |
| D6 | **Per-isolate singleton client** (launched once at module load via the user's setup), NOT per-request re-init. Per-request context via ALS; per-request `waitUntil` acquired in the handler wrapper. | Simpler than Sentry's per-request client; our ALS + per-request waitUntil acquisition covers isolation + flush. |
| D7 | **Add an `unhandledrejection` listener** where available (Cloudflare). | Catches floating-promise rejections the handler try/catch misses; cheap safety net Sentry skips. |
| D8 | **Cloudflare: full handler-type coverage** (`fetch`/`scheduled`/`queue`/`email`/`tail`/DO/WorkerEntrypoint). | Cron/Queue have no Request — a fetch-only SDK misses them entirely. |
| D9 | **`request.cf` enrichment** (Cloudflare) into the environment/event. | Free geo/network context. |
| D10 | **Source-map upload tooling** (`@bugsee/vite-plugin`/`@bugsee/webpack-plugin`) tracked as a SEPARATE cross-platform milestone (applies to all platforms; acute for edge single-file bundles). | Not edge-runtime code; build-tooling. Sequenced after the edge runtime. |
| D11 | **Edge APM deferred** (per-request transactions opt-in/sampled; Workers clock clamp makes in-isolate timing unreliable). | Backend appetite + the clock-clamp caveat. |

---

## 4. Implementation plan (slices)

**Shared edge core (built in `@bugsee/vercel-edge` first; extracted to a shared location when Cloudflare lands):**
- [x] **E1. Edge environment builder** — `buildEdgeEnvironment` (master `54df653`).
- [ ] **E2. Portable ALS context store** — `run()`-only, `globalThis.AsyncLocalStorage` probe, no-op fallback +
  one-time warn, never throw, NO `enterWith`. Extracted so node + edge share the builder. (was task #153)
- [ ] **E3. Edge transport** — WinterCG `fetch` + **lazy-producer buffer** (drain-at-flush, bounded) + **response-
  body drain**. (refines D4)
- [ ] **E4. Edge launch composition** — `createClient` + edge transport + memory capture store + console/network
  capture + integration-shims no-op providers + `unhandledrejection` detection; expose `flush()`. (was #151)
- [ ] **E5. `waitUntil` resolver + fetch-handler wrapper** — unified `waitUntil` acquisition (Vercel symbol /
  Cloudflare ctx); wrap an edge `(Request)→Response` handler; `waitUntil(client.flush())` after it. (was #152)
- [ ] **E6. `@bugsee/vercel-edge` wiring** — runtime identity (`isVercelEdge`), exports, README, e2e smoke.

**Cloudflare (`@bugsee/cloudflare`, second):**
- [ ] **C1. Composition** — reuse the shared edge core; `ctx`-param `waitUntil`; `nodejs_compat` ALS; document
  the compat flag + degrade.
- [ ] **C2. Handler-type coverage** — `fetch` (skip OPTIONS/HEAD) + `scheduled` + `queue` + `email` + `tail` +
  Durable Objects + `WorkerEntrypoint`/RPC; each its own context + flush; a `withBugsee(handler)` wrapper.
- [ ] **C3. `request.cf` enrichment** + cloud-context.

**Cross-cutting (tracked; sequenced after the edge runtime):**
- [ ] **X1. Source-map upload tooling** (`@bugsee/vite-plugin` / `@bugsee/webpack-plugin`) — build-time upload +
  `fs`-free runtime stack parser; all platforms, acute for edge.
- [ ] **X2. Edge bundle-size check** (Workers 3MB/10MB).
- [ ] **X3. Edge runtime smoke harnesses** (`dev-packages/{vercel-edge,cloudflare}-tests/`).

Then **`@bugsee/nextjs`** (its Edge runtime now unblocked).

---

## 5. Status of the foundation (already on `master`)
- Verified `node:*`-free kernel (core/capture/protocol/util/performance) — clears the Bugsnag bar.
- `fetchTransport` (`@bugsee/browser-utils`), `createMemoryCaptureStore`/`createMemoryChunkBackend` (core),
  `wrapFetchHandler` (`@bugsee/node`, "future-edge-ready"), `@bugsee/integration-shims` no-op providers,
  `client.flush(timeout)`, `isVercelEdge`/`isCloudflareWorker` (util). `buildEdgeEnvironment` (E1).
