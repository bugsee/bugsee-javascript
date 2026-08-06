# Adversarial review — @bugsee/vercel-edge

**Reviewed:** 2026-07-26 · **Scope:** packages/vercel-edge (impl 706 LOC across 7 files, tests 1002 LOC across 6 files)
**Verdict:** The invocation-isolation core is **sound** — I could not find any module-level mutable state, `enterWith` appears nowhere in the package, and an empirical two-invocation interleaving harness against a real `AsyncLocalStorage` showed each report correctly seeing its **own** route (`/B`, `/A`), never the other's. The previously-learned "capture must run inside `store.run()`" lesson is genuinely implemented (`edge-context.ts:55-66`), the "no incident ⇒ upload nothing" invariant holds, the memory-only constraints are bounded (capture ring by bytes, upload queue by `bufferSize` with an overflow drop), and the esbuild bundle is genuinely lean and clean — **21.7 KB min+gzip, zero IndexedDB / coexistence / Web-Locks / `node:` / DOM code**, so the `browser-utils` and `integration-shims` blast-radius concerns from prior reviews do **not** materialize here. The real defects are on the **`waitUntil` edge**: a host `waitUntil` that throws propagates out of the `finally` and **destroys the user's successful `Response`** or **masks the original application error** (verified empirically — SEV1), and the flush is **never** bounded by a timeout, so on the Durable-Object `awaitFlush` path a hung collector holds the request open indefinitely (verified). Separately, when `globalThis.AsyncLocalStorage` is absent the fallback silently loses **all** context for **every `async` handler** — i.e. every realistic edge handler — and the test suite cannot see this because it only ever exercises a truly-synchronous non-`async` handler, the single shape that survives the fallback. Despite **100% statement/branch/function/line coverage**, a mutation that swaps the flush promise for an unrelated `Promise.resolve()` — the exact "silently dropped upload" failure this package exists to prevent — **survives all 17 relevant tests**.

## SEV1

### 1. A throwing host `waitUntil` destroys the user's `Response` and masks the application error
- **Where:** `packages/vercel-edge/src/edge-context.ts:67-74` (the `finally` block is unguarded); reached from `packages/vercel-edge/src/fetch-handler.ts:50-55`.
- **What:** `runInEdgeContext`'s `finally` calls `waitUntil(client.flush())` (line 72) / `await client.flush()` (line 70) with **no `try`/`catch`**. A `finally` that throws replaces the block's completion value. If the host's `waitUntil` throws, the SDK's exception escapes into the host handler in place of the handler's result.
- **Why it matters:** This violates the repo's binding principle that instrumentation must not alter app behavior. A working request becomes a 500 that the application never caused, and on the error path the SDK's exception **replaces** the user's real error — breaking their own error handling and losing the true failure. Blast radius is all five downstream consumers (`cloudflare`, `astro`, `nextjs`, `nuxt`, `sveltekit`). A throwing `waitUntil` is reachable in practice: workerd throws `Cannot perform I/O on behalf of a different request` when an `ExecutionContext` is used outside its own request, and `packages/cloudflare/src/instrument-class.ts:90` forwards a caller-supplied `ctx` whose freshness the SDK does not control.
- **Evidence:** Scratch harness (outside `packages/`) driving the real `runInEdgeContext` with a `ctx.waitUntil` that throws:
  ```
  clean handler + throwing waitUntil : THREW into the host handler: Cannot perform I/O on behalf of a different request
  throwing handler + throwing waitUntil: host saw: Cannot perform I/O on behalf of a different request
  ```
  The clean handler had returned `'USER-RESPONSE'`; the caller never received it. The throwing handler's real error (`ORIGINAL-APP-ERROR`) never reached the host. No test in the package passes a throwing `waitUntil` — `wait-until.test.ts` only covers *absent* / *non-function* `waitUntil`, never a *throwing* one.

## SEV2

### 2. The flush is never time-bounded; on the Durable-Object path a hung collector holds the request open indefinitely
- **Where:** `packages/vercel-edge/src/edge-context.ts:70` and `:72` — both call `client.flush()` with **no `timeout` argument**.
- **What:** `client.flush(timeout?)` is explicitly bounded-on-demand: `packages/core/src/client.ts:400-412` (`drainPending`) and `packages/core/src/upload-pipeline.ts:192-201` both short-circuit the `Promise.race` deadline when `timeout === undefined` and then simply `await` the drain forever. No edge call site anywhere passes a timeout (verified by grep across `packages/vercel-edge/src` and `packages/cloudflare/src`).
- **Why it matters:** On the `awaitFlush: true` path — used by Durable Objects (`packages/cloudflare/src/instrument-durable-object.ts:61`, plumbed at `instrument-class.ts:63,90`) — the invocation's promise cannot resolve until the upload settles, so a slow or unreachable collector directly delays, and can indefinitely stall, the **user's** request. On the `waitUntil` path an unbounded flush burns the invocation's wall-clock budget that `docs/design/edge-runtime.md:87-89` flags as a hard constraint.
- **Evidence:** Same harness, `awaitFlush: true` with a `flush()` that never settles:
  ```
  awaitFlush + hung collector (300ms)  : invocation resolved=false  <-- request held open indefinitely (no timeout)
  ```

### 3. With no `AsyncLocalStorage`, every `async` handler silently loses its context entirely
- **Where:** `packages/vercel-edge/src/request-context-store.ts:42-56` (`createSingleSlotStore`) and `:60-71` (`probeRunScopedStore`).
- **What:** The fallback's `run()` restores its slot in a `finally` that executes as soon as `fn()` returns — for an `async` `fn` that is the moment it first suspends, not when it completes. Every continuation after the first `await` therefore observes `undefined`. Since `runInEdgeContext`'s `capture` is itself `async` (`edge-context.ts:55-64`), an `async` handler's `catch` runs after the slot is already cleared.
- **Why it matters:** Real edge handlers are `async fetch(request)`. Under the fallback their incident reports carry **no `contextId` and no route attributes** — the route-stamping feature the design calls out is silently inert, and reports become uncorrelated. The only signal is a one-time `warnOnce`. This is the default state for Cloudflare Workers without the `nodejs_compat` / `nodejs_als` flag, and `@bugsee/cloudflare` builds directly on this package. **Note this degrades to *no* context, not to another request's context** — I verified there is no cross-invocation contamination here, so this is data *loss*, not data *leakage*.
- **Evidence:** Harness comparing handler shapes against real ALS vs the fallback:
  ```
  ALS      + sync throw            contextId=present    route={"http.url":"/pay/9"}
  ALS      + async throw           contextId=present    route={"http.url":"/pay/9"}
  ALS      + async AFTER await     contextId=present    route={"http.url":"/pay/9"}
  FALLBACK + sync throw            contextId=present    route={"http.url":"/pay/9"}
  FALLBACK + async throw           contextId=UNDEFINED  route=LOST
  FALLBACK + async AFTER await     contextId=UNDEFINED  route=LOST
  ```

### 4. TEST THEATER — the flush promise can be dropped and every test still passes
- **Where:** `packages/vercel-edge/src/edge-context.test.ts:64` and `packages/vercel-edge/src/fetch-handler.test.ts:42` — both assert only `expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise)`.
- **What:** The implementation is **correct** (`edge-context.ts:72` really does pass `client.flush()`), but no test asserts promise *identity*, so any promise satisfies the assertion.
- **Why it matters:** "The flush promise must reach `waitUntil`" is the single load-bearing invariant of this package — `docs/design/edge-runtime.md:35-36` states a fire-and-forget upload is *silently* dropped when the isolate freezes. A regression here loses every edge incident with no error anywhere, across all five downstream packages, and CI would stay green.
- **Evidence:** Mutation `void client.flush(); waitUntil(Promise.resolve());` at `edge-context.ts:72` → **all 17 tests in `edge-context.test.ts` + `fetch-handler.test.ts` still pass**. Control mutations prove the harness works: a module-shared context object → 4 failures; a memoized cross-invocation `waitUntil` → 3 failures. Both fully reverted. Note this survives despite **100% branch/line/function coverage**.

### 5. TEST THEATER — no concurrent or repeated-invocation test exists in a package whose entire risk model is isolate reuse
- **Where:** `packages/vercel-edge/src/*.test.ts` — grep for `concurrent|parallel|Promise.all|interleav|two requests|twice` returns exactly one unrelated hit (`launch.test.ts:63`, an `afterEach` teardown).
- **What / Why it matters:** Every test drives a single invocation to completion before the next. Cross-invocation leakage — the SEV1-class risk for a reused edge isolate serving different users and tenants — is structurally undetectable by this suite. I verified by external harness that the real-ALS behaviour is currently **correct** (interleaved `/A` and `/B` each saw their own route), so this is a test-strength gap guarding a working implementation, not a live defect — but nothing would catch a regression.

### 6. TEST THEATER — correlation is only ever proven for the one handler shape that also passes when broken
- **Where:** `packages/vercel-edge/src/fetch-handler.test.ts:120-122` and `packages/vercel-edge/src/edge-context.test.ts:77-79` — both use a non-`async` arrow that throws synchronously. The test comments at `fetch-handler.test.ts:117-119` and `edge-context.test.ts:75` explicitly acknowledge avoiding "real-ALS cross-await timing".
- **What:** `packages/vercel-edge/vitest.config.ts:8` sets `environment: 'node'`, and `globalThis.AsyncLocalStorage` is **undefined** in Node (verified: `node -e "console.log(typeof globalThis.AsyncLocalStorage)"` → `undefined`). So every `createEdgeRequestContextStore()` in `edge-context.test.ts:9` and `fetch-handler.test.ts:9` silently constructs the **single-slot fallback**, never a real ALS — as the fixture comments themselves note ("single-slot in node").
- **Why it matters:** Per finding #3's evidence table, the synchronous-throw shape is the *only* shape that stays correlated under the fallback. The suite therefore proves correlation exclusively in the case that cannot distinguish a working ALS from a broken one, and never exercises the ALS semantics the package documents as its foundation.

### 7. Outgoing `fetch` URLs are captured verbatim, query string and all — the confirmed capture-tier credential leak reaches edge
- **Where:** `packages/capture/src/fetch-interceptor.ts:342` (`before` event) and `:279` (`complete` event) emit the raw `url`; enabled by default here via `packages/vercel-edge/src/launch.ts:78` (`captureNetwork` default true) and wired at `launch.ts:213`.
- **What / Why it matters:** Grep for `searchParams|stripQuery|scrubUrl|\.search` across `packages/capture/src` and `packages/protocol/src/sensitive.ts` returns **nothing** — there is no query-string scrubbing anywhere. An edge worker calling an upstream with `?api_key=…` / `?token=…` ships that credential into the incident bundle in the clear. Edge is fetch-native and workers overwhelmingly proxy to upstream APIs, so exposure here is higher than on other tiers. **Contrast:** the *incoming* request URL is handled correctly — `packages/vercel-edge/src/fetch-handler.ts:32-38` deliberately reduces it to `pathname`, with the reasoning documented at `fetch-handler.ts:23-25`.

### 8. A hard-coded private Vercel symbol behind an `EdgeRuntime` gate fails silently
- **Where:** `packages/vercel-edge/src/wait-until.ts:17` (`Symbol.for('@vercel/request-context')`) and `:29` (`typeof globalThis.EdgeRuntime === 'string'`), falling through to the no-op at `:38`.
- **What / Why it matters:** If Vercel renames or removes this undocumented private symbol, or changes the holder's `get()` shape, the resolver returns a no-op and **every edge incident upload is silently dropped** — no throw, no `onError`, no warning. The `EdgeRuntime` gate additionally means any Vercel runtime that exposes the request-context symbol *without* setting `EdgeRuntime` gets the no-op path (asserted as intended behaviour at `wait-until.test.ts:59-68`). The failure mode is correct in the "don't break the app" sense — it degrades to losing telemetry rather than throwing — but nothing surfaces the loss.

### 9. Unhandled rejections that fire after the response are lost
- **Where:** `packages/vercel-edge/src/detection.ts:16-17` (documented in-source), provider at `:43-79`.
- **What / Why it matters:** The `unhandledrejection` provider is the only safety net for floating-promise rejections, but a rejection arriving after the handler returned has no `waitUntil` to attach to — the design comment concedes it is "flushed by the next request, or lost on isolate freeze". On a low-traffic worker whose isolate is evicted between requests, that is permanent incident loss. Called out as accepted-but-real rather than a coding error.

## SEV3

### 10. Two declared dependencies are never imported
- **Where:** `packages/vercel-edge/package.json:30` (`@bugsee/integration-shims`) and `:31` (`@bugsee/logger`).
- **What:** Grep for `from '@bugsee` across `packages/vercel-edge/src` (excluding tests) shows imports of only `core`, `capture`, `protocol`, `util`, and `browser-utils` — neither shim nor logger appears. Confirmed absent from the esbuild output too. `docs/design/edge-runtime.md:122` (slice E4) specifies wiring "integration-shims no-op providers"; that never happened, and since the shims are no-ops nothing is lost by it. Manifest hygiene only — no bundle-size impact, because tree-shaking already removes them.

### 11. A source comment misdescribes the fallback's actual failure mode
- **Where:** `packages/vercel-edge/src/request-context-store.ts:40-41` — "a concurrent request can transiently observe another's context between awaits".
- **What:** Empirically (finding #3) a continuation observes `undefined`, never another request's context, because the slot is restored synchronously when `fn()` suspends. The comment overstates the risk in the leakage direction while understating the real one (total context loss for all `async` handlers). Worth correcting, as it is the primary reasoning artifact for anyone assessing the fallback's safety.

### 12. The edge bundle-size gate is not enforced in CI
- **Where:** `.github/workflows/ci.yml:54` runs `pnpm exec turbo run test:coverage`; `docs/design/edge-runtime.md:149-151` records X2 as DONE but located in `@bugsee/instrumentation-tests` (`test/edge.e2e.ts`), which runs under `pnpm test:e2e` — explicitly not part of `pnpm test` per CLAUDE.md.
- **What / Why it matters:** The 150 KB regression budget protecting the Cloudflare 3 MB/10 MB limit is aspirational in practice — a dependency change that drags IndexedDB or Node code into the edge entry would not be caught on any PR. Current actual measured below, so this is preventive.

## Invocation-isolation audit

| module-scope mutable state | can it leak across invocations? | file:line |
| --- | --- | --- |
| `SDK_VERSION`, `DEFAULT_ENDPOINT`, `DEFAULT_MAX_DATA_SIZE_MB` | No — immutable string/number literals | `launch.ts:49`, `:50`, `:52` |
| `EDGE_OPTION_DEFINITIONS` | No — read-only definition array, never mutated | `launch.ts:54-57` |
| `internalTagged` | No — pure curried function, no captured per-request state | `launch.ts:122-125` |
| `ALS_UNAVAILABLE_WARNING` | No — constant string | `request-context-store.ts:36` |
| `VERCEL_REQUEST_CONTEXT` | No — a `Symbol.for` key, immutable | `wait-until.ts:17` |
| `EdgeContextStoreToken` | No — DI token identity only | `launch.ts:61-63` |
| carrier client slot (`setCarrierClient`) | Per-isolate **by design** (documented singleton, D6); holds the client, not request data | `launch.ts:229`, `:233` |

**No module-scope `let` or `var` exists anywhere in the package** (verified by grep) — every module-level binding is a `const` holding an immutable value or a pure function. This is the correct posture for a reused isolate.

**`run()`-only ALS verdict: HOLDS.** `enterWith` appears **nowhere** in `packages/vercel-edge` or `packages/cloudflare` source (only in generated `dist/` comments describing its absence). Context is opened exclusively via `storage.run()` (`request-context-store.ts:86`), called from `edge-context.ts:66`. The load-bearing "capture must run inside `store.run()`" lesson is genuinely implemented: `capture` (`edge-context.ts:55-64`) wraps `fn` and calls `client.logException` from **inside** the `run()` frame, not from an outer catch — I confirmed by mutation that restructuring this to an outer catch is caught by the tests. Empirically verified with a real `AsyncLocalStorage` that two concurrent, interleaved invocations each produce a report carrying **their own** route (`reports saw routes=[/B, /A]`) — no clobbering of context, report, or identity.

**No-ALS fallback behaviour: degrades to NO-context, not to a shared global.** This is the safe direction and refutes the SEV1 hypothesis. The fallback (`request-context-store.ts:42-56`) is a module-*local* closure variable, not a global, and its slot is restored synchronously on suspension — so a concurrent request reads `undefined`, never another request's context. The cost is total silent context loss for `async` handlers (finding #3), not cross-tenant leakage. Constructor failure also degrades rather than throwing (`:63-67`), and nothing throws at import.

## waitUntil reliability

- **Is the flush promise actually passed?** **Yes** — `edge-context.ts:72` is literally `waitUntil(client.flush())`; the promise is created and handed over in one expression, not created-then-discarded. Correct as written. But **no test would catch its removal** (finding #4).
- **Symbol lookup fragility.** `wait-until.ts:17,29-36` reads an undocumented private Vercel symbol behind an `EdgeRuntime` string gate. The lookup itself is defensively written — optional chaining on both `holder?.get?.()` and `requestContext?.waitUntil`, plus a `typeof … === 'function'` check before binding, and `.bind()` so the host's `this` survives (asserted at `wait-until.test.ts:18` and `:35`). **Failure mode if the symbol is renamed/removed: a silent no-op** (`:38`) — the SDK neither throws into the host nor blocks the response, but every incident upload is lost with no diagnostic. Preferring an explicit `ctx` over the symbol is correct and tested (`wait-until.test.ts:46-57`).
- **What if `waitUntil` throws?** **Unhandled — SEV1 finding #1.** Propagates out of the `finally` and replaces the user's `Response` or their real error.
- **Incident after the handler returned?** Lost or deferred to the next invocation — finding #9, conceded at `detection.ts:16-17`.
- **Time bounds.** **None.** No `timeout` is passed to `flush()` at any edge call site — SEV2 finding #2. On the default `waitUntil` path the user's response is *not* delayed (the flush is deferred, which is the right shape); on the `awaitFlush` Durable-Object path it directly gates the response, unbounded.
- **Deadlock:** correctly sidestepped — the SDK never wraps the user's `waitUntil`, per `docs/design/edge-runtime.md:45-48`.

## Dependency weight audit

Measured by bundling `packages/vercel-edge/src/index.ts` with esbuild (`--format=esm --platform=neutral --external:node:*`): **132,528 B raw / 34,052 B gzip; 59,953 B minified / 21,761 B min+gzip** — matching the ~21 KB the design doc claims, and far under the Cloudflare 3 MB limit.

| declared dep | actually imported? | what it drags into the edge bundle | file:line |
| --- | --- | --- | --- |
| `@bugsee/browser-utils` | Yes — `fetchTransport` only | **Only `browser-utils/src/fetch-transport.ts`.** Zero IndexedDB, coexistence, Web-Locks, or report-marker code | `launch.ts:1` |
| `@bugsee/core` | Yes — heavily | ~35 kernel modules (client, pipelines, memory stores). No `node:`/DOM | `launch.ts:7-30`, `detection.ts:1-8` |
| `@bugsee/capture` | Yes | console + network interceptors (xhr/ws/sse/webtransport self-skip at runtime but are still bundled) | `launch.ts:2-6` |
| `@bugsee/protocol` | Yes | constants, levels, options, sanitize, sensitive, shapes | `launch.ts:31`, `environment.ts:1` |
| `@bugsee/util` | Yes — `randomId` etc. | backoff, deferred, json-safe-stringify, random-id, sha256, utf8-byte-length | `edge-context.ts:2` |
| `@bugsee/integration-shims` | **No** | **Nothing** — absent from the bundle | declared `package.json:30` |
| `@bugsee/logger` | **No** | **Nothing** — absent from the bundle | declared `package.json:31` |

**The `browser-utils` IndexedDB concern does not materialize.** Verified zero occurrences of `indexedDB`, `IDBKeyRange`, `createIdbBlobStore`, `createPersistentBundleStore`, `createIdbChunkBackend`, `navigator.locks`, `createWebLockLiveness`, `recoverDeadInstances`, `createCoexistence` in the bundled output; also zero `node:` specifiers and zero `document.` references. `browser-utils` has no subpath exports, so the barrel is imported whole, but its `sideEffects: false` plus per-symbol ESM imports let tree-shaking remove everything but `fetch-transport`. The published CJS variant externalizes deps (`require('@bugsee/browser-utils')`) and would load the full barrel — but edge runtimes are ESM-only, so this is not a practical edge risk.

## Privacy audit

- **Incoming request URL — correct.** `fetch-handler.ts:32-38` reduces `request.url` to `new URL(url).pathname` before stamping `http.url`, with the reasoning documented at `:23-25` (report attributes bypass the redaction pipeline). Malformed/relative URLs keep the raw value, which is a reasonable best-effort. Asserted at `fetch-handler.test.ts:59`.
- **Outgoing `fetch` URLs — leaking (finding #7).** `capture/src/fetch-interceptor.ts:342` and `:279` emit the full URL including query string, with no scrubbing anywhere in `packages/capture/src` or `packages/protocol/src/sensitive.ts`. `captureNetwork` defaults to **true** on edge (`launch.ts:78`, wired `launch.ts:213`), so this is on by default.
- **Headers.** Captured into `custom.headers` for both request and response; edge inherits whatever redaction the shared capture tier applies — not re-litigated here per scope, but the exposure surface is identical to the browser/node tiers.
- **Bodies.** Gated by `captureNetworkBodies` (default true, `launch.ts:80`) and bounded by `maxNetworkBodySize` (default 20480, `launch.ts:82` / `launch.ts:212`). The capture-tier `clone()`-tee suspended-read-frame defect is inherited unchanged; on a long-lived edge isolate a leaked frame per over-cap body accumulates against the isolate's memory ceiling rather than being reclaimed at process exit, so the consequence is somewhat worse here than on node.
- **SDK self-traffic** is correctly excluded via the `x-bugsee-internal` header (`launch.ts:122-125`, asserted `launch.test.ts:128-143`), so the SDK does not capture its own uploads.

## Checked and found clean

- **No module-level mutable state.** Zero `let`/`var` at module scope across all 7 source files.
- **`run()`-only ALS invariant holds**; `enterWith` absent from the entire package and from `@bugsee/cloudflare`.
- **Concurrent-invocation isolation works** under a real `AsyncLocalStorage` — verified empirically, each report saw its own route and its own user.
- **Capture genuinely runs inside `store.run()`** (`edge-context.ts:55-66`); the "outer catch loses the context" restructure is caught by the existing tests.
- **"No incident ⇒ upload nothing" holds.** `client.flush()` fires on every invocation (`edge-context.ts:72`) but is a true no-op when idle: `core/src/client.ts:400-412` short-circuits on an empty `pendingReports`, and `core/src/upload-pipeline.ts:193-195` returns `true` immediately when `inFlight` is empty. No background/periodic upload path exists — the only `setInterval` is the capture-store tick, and it is injectable.
- **Memory bounded.** Capture ring bounded in **bytes** via `maxDataSizeBytes` (default 10 MB, `launch.ts:169-176`; unit math asserted at `launch.test.ts:257-274`). Upload queue bounded by `bufferSize` with a `queue_overflow` drop (`core/src/upload-pipeline.ts:180-183`), `inFlight` entries deleted on settle (`:187`), retries capped at 3 — **no unbounded retention of failed bundles** in a long-lived isolate.
- **Import-time safety.** No top-level runtime-global dereference; `globalThis.AsyncLocalStorage` is probed defensively and a throwing constructor degrades (`request-context-store.ts:60-71`); the detection provider self-skips when `addEventListener` is absent (`detection.ts:55`, `:61`).
- **No `@bugsee/performance` dependency** — the browser single-slot `getActiveSpan` leak does **not** reach edge.
- **`resolveEdgeStore` degrades safely** when the client is not a launched edge client (`edge-context.ts:15-21`).
- **`.bind()` preserved** on both `waitUntil` acquisition paths, with `this`-identity assertions (`wait-until.test.ts:18`, `:35`).
- **Environment builder is pure and injectable** (`environment.ts:35-56`); no hardware/os probing attempted on edge.
- **`pnpm --filter @bugsee/vercel-edge exec tsc --noEmit` clean**; 63 tests pass; coverage **100% statements / 100% branches / 100% functions / 100% lines**.
- **Working tree left untouched** — `git status --short packages/` empty after every mutation was reverted from `cp` backups.
