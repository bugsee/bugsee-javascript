# Adversarial review — @bugsee/cloudflare

**Reviewed:** 2026-07-26 · **Scope:** packages/cloudflare (impl 402 LOC across 7 files, tests 919 LOC across 7 files; 48 tests, 100% stmt/branch/fn/line)
**Real-runtime availability:** **REAL `workerd` USED** — miniflare `4.20260722.0` / workerd `1.20260722.1`, installed under the scratchpad (never in the repo). Every headline finding below was reproduced by bundling the real `@bugsee/cloudflare` source with esbuild and running it inside actual `workerd` isolates with real Durable Object bindings, real service-binding RPC, a real `ExecutionContext`, and a real signed-PUT bundle upload to a loopback mock collector. Nothing was deployed to Cloudflare; no real credentials or network egress beyond `127.0.0.1` and the npm registry.
**Verdict:** This package's distinctive code — class instrumentation for Durable Objects and `WorkerEntrypoint` — is **broken in the two ways that matter most on the real runtime**, and both were invisible to a 100%-covered, all-green suite because **no test in the repo has ever run on `workerd`**. First, the per-instance own-property shadowing at `instrument-class.ts:89` makes every instrumented method **non-callable over Cloudflare RPC**: `stub.increment()` on a DO instrumented with `instrumentRpcMethods` throws `The RPC receiver does not implement the method "increment"`, while the identical method on an uninstrumented control works — so the documented opt-in does not merely fail to instrument, it **deletes the user's RPC surface**. Second, three *different* Durable Objects (different IDs — i.e. different tenants) provably share one isolate, one lazily-launched client and one in-memory capture ring, so tenant C's incident bundle arrived at the collector **containing tenant A's and tenant B's console logs verbatim, secrets included** — verified by extracting `logs.json` from the real uploaded zip. Compounding both, `globalThis.AsyncLocalStorage` is **`undefined` on `workerd` under every flag combination tested** (`nodejs_compat`, `nodejs_als`, both, across four compatibility dates) — the probe at `request-context-store.ts:61` therefore *always* degrades to the single-slot fallback on Cloudflare, making per-request context isolation permanently inert and the README's remedy at `README.md:85-94` factually wrong; the working source, `node:async_hooks`, is deliberately never read. Separately the module-handler path drops `this` (`with-bugsee.ts:78-84`), turning a `this`-using handler into a 500 on real workerd, and a missing `env` secret propagates a raw `TypeError` out of `launch-config.ts:26` on **every** request/DO construction, taking the customer's Worker down entirely. The inherited vercel-edge `waitUntil` SEV1 and unbounded-flush SEV2 both reproduce here on all Cloudflare paths, and the flush-promise mutation survives all 48 tests exactly as it did upstream. What *is* sound: the class mixin genuinely preserves `this`, private `#` fields, `instanceof`, the prototype chain, statics, getters/setters and inheritance; `alarm()` dispatch survives instrumentation on real workerd; the bundle is lean (22.9 KB gzip) and free of IndexedDB/DOM/`node:` code; and the attribute builders are defensively written and properly tested.

## SEV1

### 1. `instrumentRpcMethods` makes the user's RPC methods uncallable — instrumentation deletes the RPC surface
- **Where:** `packages/cloudflare/src/instrument-class.ts:89` (`(this as Record<string, unknown>)[name] = …` — a per-instance OWN property), reached from `packages/cloudflare/src/instrument-durable-object.ts:60` and `packages/cloudflare/src/with-bugsee.ts:71`.
- **What:** Cloudflare's RPC dispatch only exposes methods found on the **class prototype**. The wrapper shadows each target method with an own data property on the instance, which RPC does not see — so the method vanishes from the RPC surface entirely.
- **Why it matters:** This is not degraded telemetry, it is **breaking the customer's Worker**. `instrumentRpcMethods: true | [names]` is a documented, advertised opt-in (`README.md:60-66`, `instrument-durable-object.ts:22`, `with-bugsee.ts:31`); a user who enables it finds every RPC call to their Durable Object or `WorkerEntrypoint` throwing at runtime. The default is `false`, which bounds the blast radius — but the feature as shipped is actively harmful when used.
- **Evidence:** Real `workerd`, one DO class, selective instrumentation `{ instrumentRpcMethods: ['increment'] }` so the same instance carries one shadowed method and one untouched prototype method — a perfect internal control:
  ```
  increment_SHADOWED : THREW: The RPC receiver does not implement the method "increment".
  readPriv_PROTOTYPE : PROTO-METHOD-OK
  ```
  Cross-checked against a fully uninstrumented DO (`increment` → `6`, works) and against `WorkerEntrypoint` over a real service binding: with `instrumentRpcMethods: true` → `THREW: The RPC receiver does not implement the method "add"`; the same entrypoint wrapped **without** RPC instrumentation → `add: 5`. DO `fetch` and `alarm` keep working because workerd dispatches those through dedicated paths, not generic RPC method lookup.

### 2. Durable Objects for different tenants share one capture buffer — an incident bundle ships other tenants' data
- **Where:** `packages/cloudflare/src/launch-config.ts:32-41` (`createLazyLauncher` caches ONE client in a closure that lives for the isolate) + `packages/cloudflare/src/instrument-durable-object.ts:39` (one launcher per `instrumentDurableObject` call, evaluated at module scope).
- **What:** Multiple Durable Object instances with **different IDs** are hosted in the same JS isolate, so they share the single lazily-launched Bugsee client, its global console/fetch interceptors and its one in-memory capture ring. An incident in one DO uploads a bundle containing every other DO's captured data.
- **Why it matters:** Durable Objects are Cloudflare's canonical **per-user / per-room / per-tenant** primitive — "one DO per customer" is the archetypal usage. Mixing their capture is direct cross-tenant data leakage into an incident bundle that leaves the customer's infrastructure. This is materially worse than the ordinary "one isolate serves many requests" situation on the fetch path, because there the requests belong to the same tenant by construction. Nothing in the design doc, the README, or the code acknowledges this.
- **Evidence:** Real `workerd`, three DOs (`tenant-A`, `tenant-B`, `tenant-C`) via `idFromName`. Isolate identity and launch count first:
  ```
  [{"name":"tenant-A","isolateId":"5dylil","launchCount":1,"doId":"48712c5b"},
   {"name":"tenant-B","isolateId":"5dylil","launchCount":1,"doId":"253fd54a"},
   {"name":"tenant-C","isolateId":"5dylil","launchCount":1,"doId":"9f409890"}]
  ```
  Then the decisive end-to-end run: A and B each log a secret and return cleanly; C throws. The real signed-PUT bundle that reached the mock collector was unzipped and searched:
  ```
  upload#0 entries=[request.json, manifest.json, apptoken, logs.json, crash.json]
     contains SECRET-OF-A: YES | token sk-A: YES
     contains SECRET-OF-B: YES | token sk-B: YES
     contains SECRET-OF-C: YES | token sk-C: YES
     contains INCIDENT-IN-C: YES
  ```
  Tenant C's incident bundle carries tenant A's and tenant B's secrets.

### 3. `globalThis.AsyncLocalStorage` does not exist on `workerd` under ANY flag — per-request context isolation is permanently inert on Cloudflare, and the README's remedy is wrong
- **Where:** `packages/vercel-edge/src/request-context-store.ts:61` (`(globalThis as {AsyncLocalStorage?}).AsyncLocalStorage`); documented as working at `packages/cloudflare/README.md:85-94`, `packages/cloudflare/src/launch.ts:11-13`, and mandated at `docs/design/edge-runtime.md:65-68` / `:102` ("Read `globalThis.AsyncLocalStorage` (NEVER `import 'node:async_hooks'`…)").
- **What:** On Cloudflare, `AsyncLocalStorage` is exposed **only** as an export of the `node:async_hooks` module, never as a global. The probe therefore always misses and always falls back to the single-slot store — meaning the fallback is not an edge case on Cloudflare, it is the **only** state the SDK is ever in.
- **Why it matters:** Combined with the upstream vercel-edge finding #3 (the single-slot `run()` restores its slot the moment an `async` `fn` suspends), every realistic `async fetch` handler loses its context after the first `await`: incident reports carry **no `contextId` and no route/`faas.*`/`cf.*` attributes**. Route stamping and per-request correlation — this package's headline features — are silently dead on 100% of Cloudflare deployments, including ones that follow the README exactly. The only signal is a one-time warning that itself tells the user to add a flag that does not fix anything. Note this is context **loss**, not cross-request contamination (the slot is restored synchronously on suspension), so it compounds finding #2 rather than causing leakage itself — with no `contextId` on entries, capture from different DOs is not even separable after the fact.
- **Evidence:** Bare worker (no SDK), real `workerd` 1.20260722.1, matrix over flags × compatibility dates:
  ```
  2026-07-01 ["nodejs_als"]         {"globalALS":"undefined","nodeAsyncHooks":"function"}
  2026-07-01 ["nodejs_compat"]      {"globalALS":"undefined","nodeAsyncHooks":"function"}
  2023-01-01 ["nodejs_als"]         {"globalALS":"undefined","nodeAsyncHooks":"function"}
  2024-09-23 ["nodejs_compat"]      {"globalALS":"undefined","nodeAsyncHooks":"function"}
  ```
  And through the real SDK bundle with `["nodejs_compat","nodejs_als"]` together: `{"globalALS":"undefined","nodeAsyncHooks":"function"}`. Confirmed from the other side too — `node:async_hooks` is **absent** from the shipped edge bundle (probe of the esbuild output), i.e. the working source is never referenced.

### 4. The module-handler path drops `this` — a handler that calls a sibling method 500s
- **Where:** `packages/cloudflare/src/with-bugsee.ts:78` (`const fetchFn = handler.fetch;`) and `:84` (`() => fetchFn(request, env, ctx)`); the same extract-then-call-unbound shape repeats for `scheduled` (`:87`,`:93`), `queue` (`:96`,`:100`), `email` (`:103`,`:107`) and `tail` (`:110`,`:114`).
- **What:** Cloudflare invokes `handler.fetch(...)` with `this === handler`. The wrapper extracts the function into a `const` and calls it unbound, so `this` is `undefined` under ESM strict mode. (The **class** path is correct — `instrument-class.ts:91` uses `method.apply(this, methodArgs)`.)
- **Why it matters:** Violates the repo's binding principle that instrumentation must not alter app behavior. `export default { fetch(req,env,ctx){ return this.route(req) }, route(){…} }` is a legitimate, documented-style Cloudflare handler; wrapping it converts every request into a 500 the application never caused. Additionally `const wrapped: ExportedHandler = { ...handler }` (`:76`) is an own-enumerable spread, so `export default someClassInstance` loses all prototype members other than the five handler names read explicitly.
- **Evidence:** Real `workerd`, handler with a `helper()` sibling — `GET /this` → `500 TypeError: Cannot read properties of undefined (reading 'helper')`. Node harness against the same source, showing the before/after directly:
  ```
  T1 raw handler   : this = OBJECT    | body = HELPER-OK
  T1 wrapped       : this = UNDEFINED | THREW: Cannot read properties of undefined (reading 'helper')
  ```
  No test in `with-bugsee.test.ts` uses `this` inside a handler, so the suite cannot see this.

### 5. A missing `env` secret takes the customer's Worker down on every request
- **Where:** `packages/cloudflare/src/launch-config.ts:26` (`const { appToken, ...options } = value;`), reached from `:36` and thus from `with-bugsee.ts:83` and `instrument-class.ts:81`.
- **What:** When the config callback returns `undefined` — the exact result of `(env) => env.BUGSEE_APP_TOKEN` in an environment where the secret was never set — the destructure throws a raw `TypeError`. `createLazyLauncher` caches only on success (`:37-38`), so the throw repeats on **every** subsequent invocation rather than degrading once.
- **Why it matters:** A forgotten secret in a preview/staging environment is a routine misconfiguration; the SDK escalates it into a total outage of the customer's Worker, including at Durable Object **construction** time. An observability SDK must degrade to "no telemetry", never to "no service".
- **Evidence:**
  ```
  M1 resolveConfig(missing secret): THREW -> Cannot destructure property 'appToken' of 'value' as it is undefined.
  M2 request #1: THREW -> Cannot destructure property 'appToken' of 'value' as it is undefined.
  M2 request #2: THREW -> Cannot destructure property 'appToken' of 'value' as it is undefined.
  M3 DO constructor(missing secret): THREW -> Cannot destructure property 'appToken' of 'value' as it is undefined.
  ```
  (An empty-string token is handled fine — `M4 empty token: 200 ok` — so only the `undefined` case bites.)

### 6. A throwing host `waitUntil` destroys the user's `Response` and masks their real error (inherited, reproduced on every Cloudflare path)
- **Where:** `packages/vercel-edge/src/edge-context.ts:67-74` — the `finally` is unguarded; reached from `packages/cloudflare/src/with-bugsee.ts:80-116` (all five module handlers) and `packages/cloudflare/src/instrument-class.ts:90` (WorkerEntrypoint, `awaitFlush` false).
- **What / Why it matters:** Carried over from `docs/review/vercel-edge.md` finding #1, confirmed to reproduce through this package's own entry points. The Cloudflare-specific trigger is concrete: `workerd` throws `Cannot perform I/O on behalf of a different request` when an `ExecutionContext` is used outside its own request, and `instrument-class.ts:82` deliberately captures the **constructor's** `ctx` and reuses it for every later method call on that instance — a lifetime the SDK does not control.
- **Evidence:** Node harness driving the real `withBugsee` with a `ctx.waitUntil` that throws that exact workerd message:
  ```
  T4 module fetch  : THREW into host -> Cannot perform I/O on behalf of a different request (user Response DESTROYED)
  T4 scheduled     : THREW into host -> Cannot perform I/O on behalf of a different request
  T4 entrypoint    : THREW into host -> Cannot perform I/O on behalf of a different request (user Response DESTROYED)
  T4 masking       : host saw -> Cannot perform I/O on behalf of a different request
  ```
  The clean handler's `USER-RESPONSE` never reached the caller; the throwing handler's `ORIGINAL-APP-ERROR` was replaced. No test passes a throwing `waitUntil` anywhere in `packages/cloudflare`.

## SEV2

### 7. Without `nodejs_compat` the Worker does not load at all — the README claims the opposite
- **Where:** `packages/util/src/sha256.ts:24` (`await import('node:crypto')`), surfaced through the cloudflare bundle; contradicted by `packages/cloudflare/README.md:93-94` ("Without it the SDK still runs but degrades to a single-slot context store … it never throws") and `packages/cloudflare/src/launch.ts:12-13`.
- **What:** `workerd` resolves dynamic `import()` specifiers when the module graph is built, not when the expression executes. The guard at `sha256.ts:20-22` prevents the import from *running* on edge but not from being *resolved*, so the whole Worker fails to instantiate without the flag.
- **Why it matters:** The documented failure mode is "degrades gracefully"; the real failure mode is "the Worker will not start". Anyone who reads the README and decides the flag is optional gets a hard deployment failure. Impact is bounded because the README's primary instruction is to add `nodejs_compat` anyway — but the stated contract is wrong, and `node:crypto` is confirmed present in the shipped bundle.
- **Evidence:** Real `workerd`, identical bundle, flags removed:
  ```
  ===== compatibilityFlags = ["nodejs_compat"] =====   /als : 200 {...}
  ===== compatibilityFlags = []                  =====   /als : Unable to resolve "script-0" dependency "node:crypto": no matching module rules.
  ```
  Every route failed identically. Bundle probe confirms `node:crypto` PRESENT, `node:async_hooks` absent.

### 8. The flush is never time-bounded; on the Durable-Object path a hung collector holds the request open indefinitely
- **Where:** `packages/vercel-edge/src/edge-context.ts:70` and `:72` — `client.flush()` with no `timeout`; the `awaitFlush: true` path is selected for every DO at `packages/cloudflare/src/instrument-durable-object.ts:61`.
- **What / Why it matters:** Inherited from `docs/review/vercel-edge.md` finding #2, but **amplified on Cloudflare**: `docs/design/edge-runtime.md:87-89` records Workers' hard CPU-time limits, and a DO method that cannot resolve holds the object's input gate, stalling every queued request to that DO until the platform kills it. `client.flush(timeout?)` supports a bound; no Cloudflare call site passes one.
- **Evidence:** Harness instrumenting the argument and a never-settling collector:
  ```
  T5 flush timeout arg = undefined
  T5 DO request settled after 250ms with hung collector: false
  ```

### 9. Double-wrapping a class double-counts the incident and double-flushes — no idempotency guard
- **Where:** `packages/cloudflare/src/instrument-class.ts:77-95` — the returned subclass reads `this[name]` (`:84`), which finds the inner wrapper's own property, and wraps it again.
- **What / Why it matters:** A class wrapped twice (re-exported through two instrumented barrels, or passed to both `instrumentDurableObject` and `withBugsee`) produces **two** `logException` calls for one error — inflating incident counts and issue dedup — plus two flushes and two nested contexts, with the inner context winning. Nothing detects or prevents re-instrumentation.
- **Evidence:**
  ```
  T3 double-wrapped: logException calls = 2 | flush calls = 2
  T3 single-wrapped: logException calls = 1 | flush calls = 1
  ```

### 10. The lifecycle scan reads `this[name]`, invoking a same-named prototype getter during construction
- **Where:** `packages/cloudflare/src/instrument-class.ts:84` (`const original = (this as Record<string, unknown>)[name];`).
- **What / Why it matters:** For every configured lifecycle name (`fetch`, `alarm`, `webSocketMessage`, `webSocketClose`, `webSocketError`) the constructor performs a property **get** on the instance. If a class exposes any of those as an accessor, its getter runs at construction time with whatever side effects it has. `instrument-class.test.ts:118-144` asserts getters are never read — but that test only covers the **RPC-enumeration** path (which correctly uses `getOwnPropertyDescriptor`, `:44-45`), not the lifecycle path, so the guarantee the test appears to establish does not hold where it matters.
- **Evidence:** Prototype accessor named `alarm` on a DO → `T8 getter invocations during construction: 100` (the sentinel increments by 100 only when the getter is read).

## SEV3

### 11. TEST THEATER — the flush promise can be swapped for an unrelated promise and all 48 tests still pass
- **Where:** `packages/cloudflare/src/with-bugsee.test.ts:56,75,95,111,127`, `instrument-class.test.ts:64`, `instrument-durable-object.test.ts:48` — all assert only `toHaveBeenCalledTimes(1)` on `flush` / `ctx.waitUntil`, never promise identity.
- **Evidence:** Mutation at `packages/vercel-edge/src/edge-context.ts:72` → `void client.flush(); waitUntil(Promise.resolve());` → **48/48 pass**. The same blind spot reported upstream reproduces verbatim here. Control mutations prove the harness works: `method.apply(this,…)` → `method(…)` = 3 failures; `awaitFlush true→false` = 1 failure; dropping `ctx` from the fetch options = 1 failure; `env` read from arg 0 = 2 failures; dropping attributes = 8 failures. All mutations reverted from `cp` backups.

### 12. TEST THEATER — the suite asserts the RPC-breaking property as if it were correct behavior
- **Where:** `packages/cloudflare/src/instrument-class.test.ts:172-174` (`expect(Object.hasOwn(instance, 'ownRpc')).toBe(true)`), `:204-206`.
- **What / Why it matters:** `Object.hasOwn(instance, name) === true` is *precisely* the condition that makes a method invisible to Cloudflare RPC (finding #1). The suite encodes the defect as the specification, so no amount of coverage could surface it. No test anywhere calls an instrumented method **through an RPC stub**; "wrapped" is only ever proven structurally.

### 13. TEST THEATER — nothing in the repo runs on `workerd`; the "real edge" e2e is a WinterCG VM
- **Where:** `packages/cloudflare/vitest.config.ts:8` (`environment: 'node'`, with an in-file note "no real workerd isolate"); `packages/instrumentation-tests/test/edge.e2e.ts:39-56` uses `@edge-runtime/vm`, and its own comment at `docs/design/edge-runtime.md:155` concedes "a workerd/miniflare-accurate Cloudflare harness is a possible later upgrade".
- **What / Why it matters:** `@edge-runtime/vm` has no `ExecutionContext`, no Durable Objects, no RPC, and no Cloudflare compatibility flags — so the e2e's "Durable Object" test (`edge.e2e.ts:84-88`) exercises a plain class, not a DO. Findings #1, #2 and #3 are all invisible to every existing test and were only reachable with real `workerd`, which took ~15 minutes to stand up. Note `pnpm test:e2e` is not part of `pnpm test` or the CI gate either.

### 14. MUT7 survived — the RPC name-list de-duplication is untested
- **Where:** `packages/cloudflare/src/instrument-class.ts:71` (`rpc.filter((name) => !instrumented.has(name))`).
- **Evidence:** Mutating it to plain `rpc` (so a name that is already a lifecycle method gets wrapped twice) → **48/48 pass**. Minor, but it is the guard against exactly the double-wrap behavior of finding #9.

### 15. Instrumented classes are anonymous
- **Where:** `packages/cloudflare/src/instrument-class.ts:77` — `return class extends TargetClass {…}` is returned directly, so no name is inferred.
- **What:** `Counter.name === ""` and `TestEntrypoint.name === ""` on real workerd (base classes were `"CounterBase"`). DO bindings still resolve — wrangler/miniflare bind by **export** name, verified working — so this is cosmetic, surfacing only in stack traces and diagnostics.

## Class-instrumentation safety matrix

Verified on real `workerd` where the property is runtime-observable, otherwise against the real source in node.

| property | preserved? | file:line / evidence |
| --- | --- | --- |
| `this` binding (class path) | **Yes** — `method.apply(this, methodArgs)` | `instrument-class.ts:91`; mutation to unbound call = 3 test failures |
| `this` binding (handler-object path) | **NO — finding #4** | `with-bugsee.ts:78,84`; real workerd `500 TypeError` |
| prototype chain | Yes — `Object.getPrototypeOf(I.prototype) === Base.prototype` | `instrument-class.ts:77`; workerd `protoOk: true` |
| `instanceof` (base and grandparent) | Yes | harness `T2`: `instanceof Child: true`, `instanceof Base: true` |
| `instanceof DurableObject` | Yes | workerd `isSubclassOfDO: true` |
| static fields / static methods | Yes — inherited via constructor chain | `T2`: `STATIC-OK`, `STATIC-METHOD-OK` |
| private `#` fields | Yes — subclass + own-property shadowing, not a Proxy | `instrument-class.ts:14-17`; workerd DO fetch returned `"priv":"PRIVATE-OK"` |
| inheritance from `DurableObject`/`WorkerEntrypoint` | Yes — `super(...args)` forwards `(ctx, env)`; `this.ctx`/`this.env` set | workerd `hasCtx: true` |
| getters / setters (unwrapped, still functional) | Yes | `T2`: `GETTER-OK`, setter `SET` |
| getters NOT invoked during RPC enumeration | Yes — `getOwnPropertyDescriptor` | `instrument-class.ts:44-45` |
| getters NOT invoked during lifecycle scan | **NO — finding #10** | `instrument-class.ts:84` |
| **RPC callability of instrumented methods** | **NO — finding #1** | `instrument-class.ts:89`; workerd `The RPC receiver does not implement the method` |
| RPC callability of un-instrumented methods | Yes (unchanged, on prototype) | workerd control: `readPriv_PROTOTYPE: PROTO-METHOD-OK`, `add: 5` |
| method `.name` / `.length` | No — `""` / `0` | `T2`; cosmetic, no observed workerd impact |
| class `.name` | No — `""` (finding #15) | `instrument-class.ts:77` |
| reserved RPC names (`dup`, `connect`) excluded | Yes | `instrument-class.ts:35`; mutation = 1 test failure |
| idempotent under double wrapping | **No — finding #9** | `instrument-class.ts:84` |

## Entry-point flush matrix

| entry point | ExecutionContext available? | flush reliable? | file:line |
| --- | --- | --- | --- |
| `fetch` (module handler) | Yes — 3rd arg, per-invocation | Deferred via `ctx.waitUntil`; **unbounded**, and a throwing `waitUntil` destroys the response (#6) | `with-bugsee.ts:80-85` |
| `scheduled` (Cron) | Yes — 3rd arg | Same as fetch | `with-bugsee.ts:89-94` |
| `queue` | Yes — 3rd arg | Same as fetch | `with-bugsee.ts:98-101` |
| `email` | Yes — 3rd arg | Same as fetch | `with-bugsee.ts:105-108` |
| `tail` | Yes — 3rd arg | Same as fetch | `with-bugsee.ts:112-115` |
| `WorkerEntrypoint` methods | Yes — but from the **constructor**, reused for the instance's whole lifetime | Deferred via `waitUntil`; stale-`ctx` exposure is the concrete #6 trigger | `instrument-class.ts:82,90` |
| `WorkerEntrypoint` RPC methods | Same | **Method is uncallable when instrumented (#1)** | `instrument-class.ts:89` |
| Durable Object `fetch` | `DurableObjectState` — real, and `waitUntil` **exists and is callable without throwing** on workerd 1.20260722.1 (verified: `waitUntilType: "function"`, `wuResult: "callable-no-throw"`), but is a documented no-op | Flush is **awaited in-request** (`awaitFlush: true`) — correct, but unbounded (#8) | `instrument-durable-object.ts:61`, `edge-context.ts:70` |
| Durable Object `alarm` | Same `DurableObjectState` | **Works** — verified on real workerd that own-property `alarm` is still dispatched and fires (instrumented: 1, uninstrumented control: 1); flush awaited | `instrument-durable-object.ts:45` |
| Durable Object `webSocketMessage`/`Close`/`Error` | Same | Instrumented by default; flush awaited | `instrument-durable-object.ts:47-58` |
| Durable Object RPC methods | Same | **Method is uncallable when instrumented (#1)** | `instrument-class.ts:89` |
| DO `blockConcurrencyWhile` callbacks | n/a | **Not instrumented** — a throw inside one is uncaptured (bypasses all wrappers) | not present in source |
| Unhandled rejection after the response | None | Lost or deferred to the next invocation | `vercel-edge/src/detection.ts:16-17` |

## Durable Object longevity analysis

- **Unbounded growth: no.** The capture ring is byte-bounded (`maxDataSize`, default 10 MB, `vercel-edge/src/launch.ts:91`), the upload queue is bounded by `bufferSize` with an overflow drop, and `inFlight` entries are deleted on settle — re-verified as still true on the Cloudflare composition. A DO isolate alive for hours will hold up to ~10 MB but will not grow without limit; failed uploads are not retained forever (retries capped at 3). Against the 128 MB isolate ceiling this is a meaningful but survivable resident cost.
- **State leakage between requests within one DO: not observed, but not *isolated* either.** Cloudflare's input gate serialises DO requests (verified: two concurrent `stub.fetch` calls to one DO returned `hits: 1` then `hits: 2`, i.e. strictly sequential), so the single-slot context store cannot interleave *within* a DO. But because ALS never engages on Cloudflare (#3), entries carry no `contextId` at all — so capture from consecutive requests is indistinguishable in the bundle, which is data commingling by a different route.
- **State leakage ACROSS DO instances: yes — finding #2, the dominant issue here.** One isolate hosts many DOs, one client, one ring.
- **Hibernation / eviction: silent total loss.** Edge storage is memory-only by design (`docs/design/edge-runtime.md:87`) and this package inherits it — there is no durable bundle queue and no capture recovery on the edge tier (confirmed: zero IndexedDB/coexistence/marker code in the bundle). When a DO hibernates or its isolate is evicted, all buffered capture and any not-yet-completed upload vanish with no diagnostic. The `awaitFlush: true` choice for DOs (`instrument-durable-object.ts:61`) is the right mitigation for the in-request case and is well-reasoned in-source; nothing covers the between-requests case. This is a documented-in-design consequence rather than a coding error, but it is **not** stated in the package README.
- **`blockConcurrencyWhile`:** not instrumented at all — a throw inside a `blockConcurrencyWhile` callback (a common place to do DO bootstrap I/O, and one that resets the object when it throws) is invisible to the SDK.

## ALS / compatibility-flag analysis

| configuration | `globalThis.AsyncLocalStorage` | `node:async_hooks` | SDK behaviour |
| --- | --- | --- | --- |
| no flags | n/a — **Worker fails to load** (`node:crypto`, #7) | n/a | nothing runs |
| `nodejs_compat` (the README's instruction) | `undefined` | `function` | single-slot fallback + one-time warning; context lost after first `await` |
| `nodejs_als` | `undefined` | `function` | same (and the SDK bundle still fails to load — `nodejs_als` does not provide `node:crypto`) |
| `nodejs_compat` + `nodejs_als` | `undefined` | `function` | same |
| compat dates 2023-01-01 / 2024-09-23 / 2026-07-01 | `undefined` in all | `function` in all | same |

The probe never throws and never crashes at import — the "never throw" half of the contract holds (`request-context-store.ts:60-71`). What fails is the premise: `docs/design/edge-runtime.md:65` mandates reading the global and explicitly forbids `node:async_hooks`, reasoning that a static `node:async_hooks` import would break the edge bundle. That reasoning is sound for a *static* import but the package already ships a *dynamic* `node:crypto` import, and on Cloudflare `nodejs_compat` is required anyway — so the constraint that produced the design rule does not actually bind here. The fallback degrades to **no context**, never to another request's context (single-threaded isolate + synchronous slot restore), so this is data loss rather than leakage; the comment at `request-context-store.ts:40-41` claiming a concurrent request "can transiently observe another's context" remains inaccurate in the alarming direction, as noted upstream.

## Inherited vercel-edge defect reproduction

1. **Throwing `waitUntil` → SEV1 #6. REPRODUCES** on all five module-handler paths and the `WorkerEntrypoint` class path, with a concrete workerd trigger (constructor-captured `ctx` reused for the instance's lifetime, `instrument-class.ts:82`).
2. **Unbounded flush → SEV2 #8. REPRODUCES**, and is worse here: `awaitFlush: true` is selected for every Durable Object, and Cloudflare's CPU/duration limits plus the DO input gate mean a hung collector stalls the object's whole request queue. `flush timeout arg = undefined` verified.
3. **Flush-promise mutation survives → SEV3 #11. REPRODUCES EXACTLY** — the mutation passes all 48 tests of this package despite 100% coverage; every assertion is a call-count, never promise identity.
4. **Isolation core → re-verified, still sound *as written*, but its premise fails on Cloudflare.** No module-scope `let`/`var` exists in `packages/cloudflare/src` (the only `let` is `client` inside the `createLazyLauncher` closure, `launch-config.ts:33` — per-isolate caching by documented design). `enterWith` appears nowhere. Context is opened only via `store.run()`. **But** the DO/class paths introduce two isolation problems the fetch path did not have: the per-isolate client is shared across *different tenants'* Durable Objects (#2), and the ALS the whole design rests on is never actually available on this runtime (#3).

## Privacy audit

- **Incoming request URL: correct.** Reduced to `pathname` before stamping (verified on real workerd: `http.url: "/items/3"`), inherited from `vercel-edge/src/fetch-handler.ts:32-38`.
- **`request.cf` enrichment: appropriately curated.** `cfAttributes` (`request-cf.ts:35-44`) stamps colo/country/city/timezone/AS-org/protocol/TLS and numeric ASN only, deliberately excluding latitude/longitude per design D9; each field individually type-guarded, absent `cf` yields `{}`. City + ASN is still coarse-grained location data, but it is a conscious, documented decision.
- **Email PII: correct.** `emailAttributes()` (`handler-attributes.ts:47-49`) takes no argument at all, so `from`/`to` cannot leak; asserted at `handler-attributes.test.ts:54-56`. Message bodies never touched.
- **Trigger payloads: correct.** Queue stamps only name + count, tail only a count — no message bodies.
- **Outgoing `fetch` URLs: the inherited capture-tier leak applies unchanged.** `captureNetwork` defaults true, and `packages/capture/src/fetch-interceptor.ts:342,279` emit full URLs including query strings with no scrubbing anywhere. Workers overwhelmingly proxy to upstream APIs, so exposure is high on this tier. Not re-litigated — already filed against `@bugsee/capture`.
- **The cross-tenant bundle leak (#2) is fundamentally a privacy defect**, and the empirical evidence above is a credential (`sk-A-abcdef`) crossing a tenant boundary.

## What is unverified on real workerd

- Behaviour of a `WorkerEntrypoint` `ctx` genuinely outliving its originating request (an RPC stub held across caller requests). I demonstrated the *consequence* of a throwing `waitUntil` in node and confirmed workerd's error text is real, but did not construct a workerd scenario that makes `ctx.waitUntil` actually throw.
- Real DO **hibernation** and **eviction** — miniflare does not evict on the timescales a real colo does. The "buffered capture is lost" conclusion follows from the memory-only architecture, not from an observed eviction.
- Whether Cloudflare's production DO placement shares isolates across tenants as aggressively as miniflare does. Isolate sharing across three distinct DO IDs is confirmed in `workerd` itself (the same binary production uses), and Cloudflare documents co-location of same-class DOs, but I did not measure production placement.
- Real Cloudflare **CPU-time enforcement** against an unbounded flush (#8) — the hang was demonstrated, the platform kill was not.
- The `email` handler end-to-end (miniflare has no email binding); `tail` end-to-end (no tail producer configured). Their wrappers are structurally identical to the verified `scheduled`/`queue` paths.
- Deployment through real `wrangler` (only esbuild + miniflare were used), so the exact `node:crypto` build-time error text a user would see is inferred, not captured.

## Checked and found clean

- **Class mixin preserves the hard things.** `this`, private `#` fields, `instanceof` (including `instanceof DurableObject`), prototype chain, statics, getters/setters, and inheritance all verified intact on real workerd — the "subclass + own-property shadowing, NOT a Proxy" decision documented at `instrument-class.ts:14-17` is correct reasoning and correctly implemented. Its one unforeseen consequence is the RPC visibility rule (#1).
- **`alarm()` survives instrumentation** on real workerd — own-property `alarm` is still dispatched and fired exactly once, matching an uninstrumented control.
- **`awaitFlush` for Durable Objects is right and well-reasoned** (`instrument-durable-object.ts:61`, `edge-context.ts:30-35`); the mutation to `false` is caught by a genuinely good test (`instrument-durable-object.test.ts:52-81`) that asserts the request does not settle until the flush resolves.
- **Attribute builders are defensive and well-tested.** `scheduledAttributes`/`queueAttributes`/`tailAttributes` guard every field, and the out-of-range-epoch → `Invalid Date` case is explicitly covered (`handler-attributes.test.ts:26-34`). `cfAttributes` handles `null`, non-object, and non-string/non-numeric fields.
- **Absent handler methods are left absent**, and the original handler object is not mutated (`with-bugsee.test.ts:266-277`).
- **The `export *` + explicit-`launch` shadowing works** and is asserted for identity, not just presence (`index.test.ts:17-19`).
- **Bundle is lean and clean: 63,468 B minified / 22,951 B gzip** — far under the Workers 3 MB free limit. Probed the output for `indexedDB`, `IDBKeyRange`, `createIdbBlobStore`, `navigator.locks`, `createWebLockLiveness`, `createCoexistence`, `document.`, `integration-shims`, `enterWith`: **all absent**. The `browser-utils` IndexedDB and `integration-shims` dead-code concerns from earlier reviews do **not** materialise here.
- **No module-scope mutable state** in `packages/cloudflare/src`; no `enterWith` anywhere.
- **Lazy per-isolate launch works as designed** and is asserted (`with-bugsee.test.ts:146-156`, `instrument-durable-object.test.ts:184-204`).
- **`pnpm --filter @bugsee/cloudflare exec tsc --noEmit` clean**; 48 tests pass; coverage 100% statements / 100% branches / 100% functions / 100% lines.
- **Working tree left untouched** — `git status --short packages/` empty after every mutation was restored from `cp` backups (verified twice: immediately after the mutation harness and at the end of the review). All scratch work, miniflare, workerd and esbuild installs live under the scratchpad, never in the repo.
