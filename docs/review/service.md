# Adversarial review — @bugsee/service

**Reviewed:** 2026-07-26 · **Scope:** packages/service (impl 248 LOC, tests 413 LOC)

**Verdict:** First, a correction to the review brief: this package is **not** a start/stop service-lifecycle
abstraction. It is a **DI/IoC service container** (Firebase `@firebase/component` pattern, renamed) —
`serviceToken` / `defineService` / `createServiceContainer` / `Provider`. There is no `start()`, no `stop()`,
no state machine, and no registry of stoppable things anywhere in `packages/service/src/index.ts`. The
whole "double start / stop-before-start / async start racing stop / reverse shutdown ordering" mandate is
inapplicable — I have substituted the container's real state machine (unregistered → registered →
instantiating → instantiated / failed → cleared) and attacked that instead. **Trust the code: the brief
disagrees with it.** On substance, the implementation is disciplined and the test suite is genuinely
strong — 39/39 green, 100% stmt/branch/fn/line, `tsc --noEmit` clean, zero `node:*`/DOM/timer/global
references (fully runtime-portable), and 12 of 14 injected mutations were caught, including every
mutation to a real invariant. But there is **one real, currently-shipping contract violation**:
`getImmediate({ optional: true })` does not honor `optional` on the *first* access to a service whose
factory throws — it rethrows into the caller. Eight production call sites depend on that guard, six of
them inside host-application request paths, which makes it a direct hazard to the SDK's binding
"must never alter host app behavior" rule. Two SEV2s follow (a container-authored unhandled rejection
that can terminate a Node process, and misattributed + poisoning behavior on mutual dependency cycles);
the rest is hygiene, doc drift, and dead public surface.

---

## SEV1

### 1. `getImmediate({ optional: true })` throws on FIRST access when the factory throws — `optional` is silently not honored

- **Where:** `packages/service/src/index.ts:143-171` (specifically the fall-through to `return instantiate();` at `packages/service/src/index.ts:170`)
- **What:** The `optional` guard is only consulted for an *already-cached* failure (`packages/service/src/index.ts:152-157`). On the first call, `failure` is still `null`, so control falls past every optional check to `return instantiate()` at line 170, and the factory's exception propagates straight out of `getImmediate` — despite the caller having explicitly asked for the non-throwing form. The declared contract at `packages/service/src/index.ts:57-59` says *"Returns the instance synchronously; throws if unavailable (**or returns null when optional**)"*, and the README repeats it (`packages/service/README.md:7`: "`getImmediate()` (sync; throws or `{ optional: true }` → null)"). The behavior is also **non-deterministic across calls**: the same call returns `null` the second time, because by then `failure` is populated.
- **Why it matters:** `getImmediate({ optional: true })` is the SDK's designated *"probe without exploding"* primitive, and it is used in exactly that spirit at eight production sites — six of which execute inside the host application's request path:
  - `packages/express/src/middleware.ts:71`
  - `packages/fastify/src/hooks.ts:67`
  - `packages/hapi/src/hooks.ts:66`
  - `packages/elysia/src/hooks.ts:67`
  - `packages/nestjs/src/shared.ts:83`
  - `packages/node/src/server-instrument.ts:122`
  - `packages/webview/src/launch.ts:212`
  - `packages/adapter-kit/src/trace-data.ts:26`

  All six adapters use the identical idiom `…getImmediate({ optional: true }) ?? undefined`, i.e. they are written on the assumption that this call **cannot throw** and will degrade gracefully to "no request context". If any registered factory ever throws on first resolution, the exception escapes into user middleware and becomes a failed HTTP request in the customer's application. That is a direct violation of the repo's binding rule that the SDK must never alter host app behavior (CLAUDE.md; `docs/design/sdk-design.md` §1501 lineage). It is latent *today* only because every current factory is a `() => preBuiltValue` closure that cannot throw (e.g. `packages/node/src/launch.ts:546`) — but `defineService`/`addService` are public API re-exported from `packages/core/src/index.ts:5-15`, so any extension or platform package registering a computing factory arms it.
- **Evidence:** Ran a probe against the real source via a scratch vitest config (nothing written into the repo):
  ```
  FIRST  getImmediate({optional:true}) -> THREW: storage-init-failed
  SECOND getImmediate({optional:true}) -> null
  adapter idiom -> ESCAPED INTO HOST REQUEST PATH: boom-in-factory
  ```
  The second probe replicates the exact `?? undefined` idiom from the six adapters above.
- **Why the tests miss it:** `packages/service/src/service.test.ts:294-307` *looks* like it covers this — it asserts `expect(p.getImmediate({ optional: true })).toBeNull()` at line 305 — but that assertion runs only **after** two prior `getImmediate()` calls (lines 302-303) have already cached the failure. The first-call path is never exercised with `optional: true`. This is the one place in the suite that gives false confidence.

---

## SEV2

### 2. `clearInstance()` produces an unhandled promise rejection that can terminate the host Node process

- **Where:** `packages/service/src/index.ts:202-212` (the rejection is created at `packages/service/src/index.ts:207`)
- **What:** `clearInstance()` unconditionally calls `deferred.reject(new Error(...))` on any live deferred. The deferred's promise was handed out by `get()` (`packages/service/src/index.ts:140`). If the caller did not retain and `.catch()` it, the container itself has just authored an unhandled rejection. The same shape occurs on the re-entrancy path: a factory that calls `get()` re-entrantly and then throws causes `instantiate`'s catch (`packages/service/src/index.ts:109-112`) to reject that inner deferred, which nobody holds.
- **Why it matters:** Node's default since v15 is `--unhandled-rejections=throw`, i.e. an unhandled rejection **crashes the process**. An SDK internal bookkeeping call taking down the customer's server is the worst possible violation of "must not alter host app behavior". In browsers it instead fires `window.onunhandledrejection` — which the SDK's *own* global error capture then records, manufacturing a phantom error report attributed to the host app. Note this is not accidental: rejecting pending deferreds on `clearInstance` is the *specified* behavior (`docs/design/sdk-design.md` §7.4: "**`clearInstance(id)` rejects pending Deferreds** — fixing Firebase's wart"). The design mandates the rejection but nothing owns the consequence. Because the container has no `onError` seam (see SEV3 #9), it cannot even route this somewhere safe.
- **Reachability (honest):** currently **unreachable in-repo** — `clearInstance` has zero non-test callers and `get()` has zero non-test callers (only `packages/core/src/client.test.ts:202`). This is why it is SEV2 and not SEV1. It becomes SEV1 the moment anyone calls `clearInstance()`, and both methods are shipped public API via `packages/core/src/index.ts:5-15`.
- **Evidence:** Probe output against the real source:
  ```
  P5/P6 unhandled rejections observed: factory-boom | Service "T6" was cleared before it initialized
  ```
  P6 is the plain `get()` → `clearInstance()` sequence with the promise discarded.

### 3. Mutual (A→B→A) dependency cycles are misattributed and permanently poison the innocent intermediate provider

- **Where:** `packages/service/src/index.ts:91-92` (message) and `packages/service/src/index.ts:109-112` (failure caching)
- **What:** The `instantiating` re-entrancy flag is per-provider, so a mutual cycle **is** correctly detected — good. But two things go wrong afterwards:
  1. The error text is hardcoded to `Service "${name}" has a circular dependency **on itself** during creation`. For A→B→A this is factually false (A depends on B, which depends on A) and it names only A, giving the developer no clue that B is in the loop. For a DI container, the cycle error *is* the debugging signal.
  2. As the exception unwinds, **every** provider in the chain runs `failure = { error }` at `packages/service/src/index.ts:110`. So provider B — which has no self-cycle and may be perfectly well-formed — permanently caches *A's* error as its own. Since failure caching is permanent (only `clearInstance()` resets it, and nothing calls it), B is dead for the process lifetime, and any later access to B reports an error about a *different* service.
- **Why it matters:** A transient startup mis-wiring in one service silently and permanently disables an unrelated one, with a misleading diagnostic. In a container whose whole job is dependency resolution, this converts a fixable wiring bug into a confusing cascading outage.
- **Evidence:** Probe against the real source with `A → B → A`:
  ```
  P1 mutual-cycle throw:      Service "A" has a circular dependency on itself during creation
  P1 B re-access after cycle: Service "A" has a circular dependency on itself during creation
  ```
  The second line is a direct access to **B**, returning A's error.
- **Test gap:** all three re-entrancy tests (`packages/service/src/service.test.ts:311`, `:322`, `:337`) are **self**-cycles (`S → S`). There is no test for a mutual cycle anywhere in the suite, which is why both defects survive.

---

## SEV3

### 4. An `onInit` callback that calls `clearInstance()` breaks the singleton invariant (two live instances)

- **Where:** `packages/service/src/index.ts:101-116` — `instance = created` (line 103) is committed *before* the callback loop at lines 105-107, and `clearInstance()` can null it mid-loop.
- **What:** `instantiate()` sets `instance`, resolves the deferred, then fires `onInit` callbacks. A callback that calls `clearInstance()` sets `instance = null` while the loop continues, and `instantiate()` still returns `created`. The provider therefore hands out an instance it no longer holds, `isInitialized()` reports `false` immediately after a successful `getImmediate()`, and the next access re-runs the factory — producing a second live instance of a declared singleton.
- **Why it matters:** Torn state in the one method whose contract is "exactly one instance". Bounded because `onInit` and `clearInstance` have zero non-test callers, but both are exported public API.
- **Evidence:** Probe output — `P2 returned id=1 isInitialized=false` then `P2 second id=2 sameSingleton=false factoryCalls=2`.

### 5. The `as Provider<T>` cast silently accepts a **missing** interface member

- **Where:** `packages/service/src/index.ts:223` (`} as Provider<T>;`)
- **What:** The cast exists because the implementation signature `getImmediate(opts?: { optional?: boolean }): T | null` cannot satisfy the two-overload declaration at `packages/service/src/index.ts:57-59` by assignment. But `as` is a two-way comparability check, not an assignability check: it rejects a member with the *wrong type*, yet accepts a member that is *absent entirely*.
- **Why it matters:** A future refactor that drops a `Provider` method from the returned object literal type-checks clean, and callers get `undefined is not a function` at runtime on a fully-typed call.
- **Evidence:** Empirically verified by temporary mutation + `tsc --noEmit` (fully reverted):
  - remove `isServiceSet` from the returned object → **tsc CLEAN** (drift hidden)
  - change `isInitialized` to return `string` → `TS2352` (caught)
  - change `name` to `123` → `TS2352` (caught)

### 6. Dead public surface: `isServiceSet`, `isInitialized`, `clearInstance`, `onInit`, `initialize` / EXPLICIT mode

- **Where:** `packages/service/src/index.ts:50`, `:51`, `:61`, `:65`, `:67`; mode branch at `packages/service/src/index.ts:164`
- **What:** Repo-wide grep (excluding `packages/service/**`, `dist/`, `node_modules/`) finds **zero** call sites for `isServiceSet`, `isInitialized`, `clearInstance`, and `onInit` — the only `onInit` hit outside the package is a doc comment at `packages/core/src/services.ts:14`. `'EXPLICIT'` appears nowhere outside this package's own tests (the other repo hits are unrelated prose using the English word). All of it is nonetheless re-exported as public API from `packages/core/src/index.ts:5-15`.
- **Why it matters:** ~40% of the `Provider` surface is untested-in-anger, unexercised machinery that still carries maintenance and correctness cost — and it is exactly where SEV2 #2 and SEV3 #4 live. Design §7.4 justifies EXPLICIT with "e.g. `ReplayEncoder` needs masking options"; `@bugsee/replay` shipped without using it, so the justification has lapsed.

### 7. README and design §7.4 document the pre-token string API (stale)

- **Where:** `packages/service/README.md:5-7`; `docs/design/sdk-design.md` §7.4
- **What:** The README documents `defineService(name, factory, mode?)` and `getProvider<T>(name)`, but the shipped signatures take a `ServiceToken<T>` (`packages/service/src/index.ts:40-46`, `:72`). Design §7.4 is further behind, showing `provider.get('foo')`, `addService('foo', factory)` and `clearInstance(id)` — a per-id API that does not exist (`clearInstance()` takes no argument, `packages/service/src/index.ts:202`). The README also still claims the typed facade is `NameServiceMapping`-based, which `docs/design/sdk-design.md:302` itself records as superseded by `ServiceToken`.
- **Why it matters:** This is tier-0 foundation documentation for the DI substrate every platform package wires through; stale signatures mislead the next implementor.

### 8. Circular-dependency message is asserted only by `/circular/` — surviving mutation

- **Where:** assertions at `packages/service/src/service.test.ts:319` and `:334`
- **What:** I replaced the entire message at `packages/service/src/index.ts:91-92` with the bare string `` `circular` `` — dropping the service name and all explanatory text — and **39/39 tests still passed**. Combined with SEV2 #3 (the message is already wrong for mutual cycles), the suite provides no protection for the container's primary diagnostic.
- **Evidence:** mutation M3 → `Tests 39 passed (39)`. Control mutation M1 (removing the `[...onInitCallbacks]` snapshot at `packages/service/src/index.ts:105`) correctly failed 1 test, proving the harness works.

### 9. No `onError` seam — internal failures are either thrown at the caller or silently swallowed

- **Where:** `packages/service/src/index.ts:83-89` (`safeInvoke`)
- **What:** A throwing `onInit` callback is caught and discarded with an empty `catch` and no diagnostic path. The package has no `onError` parameter, no injectable reporter, and no logger dependency. `@bugsee/core` deliberately has no logger and routes internal faults through an `onError` seam; this tier-0 package participates in neither — it has only two disposal routes for an error: throw it at the caller, or drop it on the floor.
- **Why it matters:** Swallowing is the right *default* (a faulty callback must not break instantiation — correctly tested at `packages/service/src/service.test.ts:387`), but with zero observability a broken service-init hook is undebuggable in production. Combined with SEV1 #1 and SEV2 #2, this package has no safe place to put an error it cannot throw. An optional `onError` on `createServiceContainer()` would resolve #1, #2 and #9 together.

### 10. No disposal API; `providers` grows monotonically and retains every instance

- **Where:** `packages/service/src/index.ts:226-248` — `const providers = new Map(...)` with no `delete`, no `clear()`, no `dispose()`
- **What:** `getProvider(token)` creates and permanently retains a provider for *any* name, including names never registered (`packages/service/src/index.ts:229-236`), and the container exposes no way to release instances. `clearInstance()` drops a provider's instance reference but never notifies the instance, so anything a factory acquired (timer, listener, socket) has no teardown path.
- **Why it matters — and why it is only SEV3:** I verified this does **not** leak across SDK restarts: `createServiceContainer()` is called fresh per `launch()` (`packages/node/src/launch.ts:382`, `packages/browser/src/launch.ts:283`), so `stop()` + relaunch drops the whole container graph. It also does not bite today because no factory in the repo acquires a resource — all are `() => preBuiltValue`. The hazard is that `docs/design/sdk-design.md` §7.4 **explicitly instructs the opposite**: *"Services that need to do periodic work (the 30s performance flush) implement it inside their `LAZY` factory: the first `getImmediate()` call schedules the timer."* Any service that follows that documented guidance leaks its timer, because nothing will ever tell it to stop. Node currently sidesteps this by owning the interval outside the container (`packages/node/src/launch.ts:670` / `:823`).

### 11. Async factories silently yield a `Promise` from `getImmediate()`

- **Where:** `packages/service/src/index.ts:11` (`ServiceFactory<T> = (container, options?) => T`)
- **What:** Nothing rejects a factory returning a thenable. With a loosely-inferred token the container caches the promise as the instance, and `getImmediate()` / `client.getService(token)` hand the caller a `Promise` typed as `T`.
- **Evidence:** probe `P4 async factory -> getImmediate returns Promise? true`. No current consumer does this (verified by grep over all `defineService(` call sites), so it is a documentation gap, not an active bug.

### 12. Undocumented, untested: `clearInstance()` does not clear `onInitCallbacks`

- **Where:** `packages/service/src/index.ts:202-212` vs the `onInitCallbacks` set at `packages/service/src/index.ts:81`
- **What:** After `clearInstance()` and re-instantiation, every previously registered `onInit` callback fires again with the new instance. That may well be intended, but it is neither documented at `packages/service/src/index.ts:66` nor covered by any test.
- **Evidence:** probe `P3 onInit fired for: [1,2]`.

### 13. Misleading comment: the `get()` catch does not do what it says

- **Where:** `packages/service/src/index.ts:135-138` (and the identical comment at `packages/service/src/index.ts:195-197`)
- **What:** The comment reads *"failure recorded + deferred rejected inside instantiate"*. That holds for a factory throw, but **not** for the circular-dependency throw, which fires at `packages/service/src/index.ts:97-99` — *before* the `try` block — so neither `failure` nor `deferred` is touched. Mutation M5 showed the only test that reaches this catch is the re-entrant `get()` test (`packages/service/src/service.test.ts:337`), i.e. precisely the path the comment describes incorrectly. The behavior is correct (the outer `instantiate` resolves the deferred afterwards); only the reasoning is wrong. There is also no test exercising `get()` → registered-LAZY-factory-throws, since `packages/service/src/service.test.ts:282` goes through `setService` and `:294` pre-caches the failure via `getImmediate`.

---

## Lifecycle state-machine analysis

The brief's start/stop machine does not exist. The real machine per `Provider` is
**`unregistered → registered → instantiating → instantiated | failed → cleared`**, with `service`,
`instance`, `deferred`, `failure`, `instantiating` as state. Transitions attacked:

| Transition / attack | Verdict |
|---|---|
| Double registration (`addService` twice, same name) | **Correct** — throws `already registered` (`index.ts:186-189`), tested `service.test.ts:92`. |
| Registration after instantiation | Impossible — `setService` guards on `service !== null` first. |
| `getImmediate` before registration | **Correct** — throws, or `null` when optional (`index.ts:158-163`), tested `:68`, `:74`. |
| `get()` before registration, then late LAZY registration | **Correct** — pending deferred resolves (`index.ts:191-199`), tested `:100`. |
| `get()` before registration, then late EXPLICIT registration | **Correct** — stays pending until `initialize()`, tested `:134` with a sentinel race. |
| Double `initialize()` | **Correct** — throws `already initialized` (`index.ts:180-182`), tested `:181`. |
| `initialize()` before registration | **Correct** — throws `is not registered`, tested `:177`. |
| Factory throws (the "start that throws") | **Correct and consistent** — failure cached, deferred rejected, error rethrown, `instantiating` reset in `finally` (`index.ts:109-115`). Provider is re-usable after `clearInstance()`, tested `:251`. |
| Factory throws + `{ optional: true }` on first access | **BROKEN — SEV1 #1.** |
| Re-entrant `getImmediate()` during own construction (self-cycle) | **Correct** — circular error from either guard, tested `:311`, `:322`. |
| Re-entrant `get()` during own construction | **Correct** — no double-build; the outer construction resolves the inner deferred, tested `:337`. |
| Mutual A→B→A cycle | Detected, but **misattributed + poisons B — SEV2 #3**; untested. |
| `clearInstance()` before anything (no deferred, no instance) | **Correct** no-op; false branch of `index.ts:206` covered by `:203`. |
| `clearInstance()` on a settled deferred | **Correct** — native promises are idempotent; the invariant that `deferred != null && instance != null ⇒ settled` holds by construction and is tested `:233`. |
| `clearInstance()` on a pending, un-retained `get()` | **Unhandled rejection — SEV2 #2.** |
| "Restart": `clearInstance()` → re-access | **Correct** — instance/deferred/failure all reset, factory re-runs, tested `:203`, `:222`, `:251`. |
| `clearInstance()` from inside an `onInit` callback | **Torn state — SEV3 #4.** |
| Concurrent / interleaved operations | **Not applicable, and that is a genuine strength.** Every state transition is fully synchronous — there is no `await` between any check and its corresponding write anywhere in the file, so no TOCTOU window exists. `get()` returns a promise but performs zero async work. The absence of concurrency tests is therefore correct, not a gap. |
| Ordering guarantees on teardown | **None exist, and none are needed** — there is no teardown (see SEV3 #10). |

## Consumer contract violations

1. **Six backend adapters treat `getImmediate({ optional: true })` as non-throwing** — `packages/express/src/middleware.ts:71`, `packages/fastify/src/hooks.ts:67`, `packages/hapi/src/hooks.ts:66`, `packages/elysia/src/hooks.ts:67`, `packages/nestjs/src/shared.ts:83`, `packages/node/src/server-instrument.ts:122`. All use `… ?? undefined` with no `try/catch`, inside host request paths. Per SEV1 #1 the call *can* throw. The adapters are honoring the documented contract; the container is the one violating it — but these are the blast radius, so they are listed here.
2. **`packages/koa/src/middleware.test.ts:43` and `packages/hono/src/middleware.test.ts:38` mock `getServiceProvider` as `() => ({ getImmediate: () => opts.store ?? undefined })`** — returning `undefined` where the real `Provider.getImmediate` returns `T | null`, and omitting eight of the nine `Provider` members. The mock cannot catch a `null`-vs-`undefined` regression in the production path, and (unlike express/fastify/hapi/elysia) koa and hono have **no production `RequestContextStoreToken` resolution at all** — only these test doubles. Worth confirming those two adapters actually wire request context.
3. **No consumer honors the `Provider` teardown contract, because there isn't one** — every `defineService` call site in the repo (`packages/core/src/client.ts:282`–`:340`, `packages/node/src/launch.ts:384`–`:546`, `packages/browser/src/launch.ts:285`–`:362`, `packages/webworker/src/launch.ts:180`–`:257`, `packages/vercel-edge/src/launch.ts:150`, `:183`) passes a `() => preBuiltValue` closure and manages resource lifetime outside the container. That is the *correct* workaround for SEV3 #10, but it means the container's LAZY instantiation is unused in practice — every registered service is eagerly constructed by the platform before registration.
4. **Dead API is publicly re-exported** — `packages/core/src/index.ts:5-15` re-exports `createServiceContainer`, `defineService`, `Provider`, `Service`, `ServiceContainer`, `ServiceFactory`, `ServiceToken`, `InstantiationMode` and `serviceToken` from the SDK's public entry point, including the never-used `clearInstance`/`onInit`/`initialize` surface carrying SEV2 #2 and SEV3 #4.

## Checked and found clean

- **Runtime portability — exemplary.** `grep` for `node:`, `globalThis`, `window.`, `document.`, `process.`, `setTimeout`, `setInterval`, `require(` across `packages/service/src` returns **nothing**. The only import is `@bugsee/util`'s `createDeferred` (`packages/service/src/index.ts:6`), itself pure (`packages/util/src/deferred.ts`). No timers, no listeners, no global state, no module-level mutable state — so the edge-runtime concern (no long-lived timers between invocations) simply does not apply. Works unchanged on every target runtime.
- **No leak across SDK restarts.** Verified `createServiceContainer()` is invoked fresh per `launch()` (`packages/node/src/launch.ts:382`, `packages/browser/src/launch.ts:283`), so `stop()` + relaunch drops the entire container and every retained instance. The unbounded `providers` map (SEV3 #10) is scoped to one session.
- **No TOCTOU / race windows.** Every mutation of `service` / `instance` / `deferred` / `failure` / `instantiating` is synchronous with its guard; there is no `await` in the file.
- **Re-entrancy guard is correct by construction.** `instantiating` is set before the factory call and cleared in a `finally` (`packages/service/src/index.ts:100`, `:113-115`), so a throwing factory cannot wedge the provider — confirmed by test `:251` and by mutation (removing the `finally` fails a test).
- **Failure caching is coherent** across `get()` / `getImmediate()` / `initialize()`, and the factory is provably not re-run — the `expect(factory).toHaveBeenCalledTimes(1)` assertions at `:198`, `:306`, `:113` are load-bearing (I confirmed by mutation that removing failure caching passes the `toThrow` assertion and is caught *only* by the call-count assertion).
- **Token-name keying is deliberate and tested.** `packages/service/src/service.test.ts:32-43` verifies two distinct token objects sharing a name converge on one provider — the property that lets duplicated module copies interoperate. Good, non-obvious test.
- **`onInit` callback-set snapshotting** (`packages/service/src/index.ts:105`) correctly prevents skipping a callback that is unsubscribed mid-emit; tested at `:400` and confirmed by control mutation M1.
- **Test suite strength: high.** 39/39 pass; coverage 100% statements (94/94), 100% branch (47/47), 100% functions (19/19), 100% lines (93/93) — genuinely met, not threshold-gamed. **12 of 14 injected mutations were caught**, including: `onInit` snapshot removal, `optional`-null on cached failure, `clearInstance` failure reset, `clearInstance` deferred reset, `clearInstance` pending-rejection, `getImmediate` circular guard, `setService` eager-instantiation, `defineService` default mode, `onInit` unsubscribe, `get()` catch swallow. The only survivors were the error-message text (SEV3 #8) and one genuinely **equivalent** mutant (swapping `instance = created` with `deferred?.resolve(created)` at `packages/service/src/index.ts:103-104` — unobservable, since promise reactions are always async; correctly not a finding).
- **No test theater found.** Assertions check outcomes (instance identity, factory invocation counts, promise settlement, error identity via `toBe(boom)`), not just state flags. `packages/service/src/service.test.ts:80-90` asserts `isServiceSet`/`isInitialized` but pairs them with the actual `getImmediate()` effect.
- **`tsc --noEmit` clean**; no import cycles introduced (single-file package, one dependency).
- **Repo left untouched:** `git status --short packages/service` is empty and `sha256(src/index.ts)` matches the pre-review backup (`c0e2d383…6196`). All mutation and probe work ran from the scratchpad; the full suite re-verified green (39/39) afterwards.
