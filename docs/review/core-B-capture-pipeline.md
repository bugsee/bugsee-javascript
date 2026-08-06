# Adversarial review — @bugsee/core, Pass B (capture pipeline / pub-sub)

**Reviewed:** 2026-07-26 · **Scope:** `packages/core/src/` — `emitter.ts` (173/352),
`event-emitter.ts` (50/181), `capture-aggregator.ts` (80/226), `capture-coordinator.ts` (82/176),
`capture-exporter.ts` (75/158), `capture-drain.ts` (37/84), `capture-snapshot.ts` (40/57),
`capture-data-entry.ts` (29/62), `capture-provider-base.ts` (68/155), `interceptor-base.ts` (59/114),
`detection-coordinator.ts` (74/132), `detection-provider-base.ts` (59/131), `filters.ts` (61/44),
`request-context.ts` (36/40), `events.ts` (40/—). Read-only; 40 mutations applied and reverted from `cp`
backups; 26 probe assertions run in three temporary test files (since deleted).
`pnpm --filter @bugsee/core exec tsc --noEmit` passes; 683 tests / 46 files green;
`git status --short packages/` empty at start and at finish.

**Verdict:** The pub/sub substrate itself is the strongest code in this pass and the emitter test suite is
genuinely good — 8/8 emitter mutations and 5/5 `event-emitter` mutations were killed, including every attack
from the mandate that the tests *do* model (throwing listener isolation, mid-dispatch subscribe/unsubscribe,
snapshot semantics, dedup, `onAny` ordering, `onActiveChange` refcounting in both directions). 32 of 40
mutations across the whole pass were caught. The defects are not in the dispatch loop; they are in the two
places where a **user-supplied or subclass-supplied callback meets the pipeline**, and both are entirely
untested — the two mutations that *fix* them (`I1`, `F4`) survived the full suite. SEV1 #1 is the privacy
surface: `runFilter` narrows to `T | null` but never normalizes, so the single most common user-filter
mistake (a filter body with no `return`) becomes a `TypeError` that **throws out of the public
`addBreadcrumb()`/`log()` API into the host app**, and — on the log/network provider paths — is swallowed by
the very listener-isolation guard that makes the emitter safe, silently destroying 100% of that capture
stream with no diagnostic on any sink. SEV1 #2 is the subscriber-presence coupling the brief called out:
`InterceptorBase` marks itself active *before* installing the hook, so one throwing `onActivate()` leaves the
interceptor permanently "active" with no patch installed and **never retried**, for the process lifetime.
Contributing to both: the emitter's `onListenerError` sink — the SDK's only diagnostic channel for the whole
interceptor→provider pipeline — is **never wired by anyone**; all 16 `InterceptorBase` subclasses call a bare
`super()`.

**On the brief's prior — the code agrees, with two clarifications:**
- Confirmed: no event-hub layer (interceptors are the emitters, providers subscribe directly);
  subscriber-presence drives activation (`interceptor-base.ts:41-52`); providers push `CaptureDataEntry` and
  never serialize (`capture-provider-base.ts:60-67`, serialization happens at `capture-aggregator.ts:60`);
  detection→report uses `ReportingRequest` (`detection-provider-base.ts:44-58`); correlation-by-tagging, not
  isolation (`capture-aggregator.ts:37-55`). Runtime portability holds absolutely: **zero** occurrences of
  `globalThis`, `process.`, `window.`, `document.`, `require(` or `node:` across all 15 in-scope files.
- Clarification 1: **`CaptureExporter.stream()` — the "memory-light" read path the design touts — has zero
  production callers.** `client.ts:345` uses only `drain()`. The streaming half of the exporter/snapshot
  contract is exercised by tests alone (SEV3 #9).
- Clarification 2: the aggregator is a **synchronous pass-through with no queue**, so there is no
  back-pressure surface *here* to attack — flooding is bounded (or not) entirely by the `CaptureStore`
  (Pass C). Reported as clean, below.

## SEV1

### 1. `runFilter` never normalizes a non-`null` falsy return; every consumer tests `!== null`, so a user filter that forgets to `return` throws into the host app on two paths and silently annihilates a whole capture stream on two others

- **Where:** `packages/core/src/filters.ts:44-58` (root cause — the `catch` normalizes to `null` but the
  success path returns `filter(value)` verbatim). Consumers:
  `packages/core/src/client.ts:535-541` (`addBreadcrumb`), `packages/core/src/client.ts:550-554` (`log`),
  `packages/capture/src/log-provider.ts:36-38`, `packages/capture/src/network-provider.ts:94-96`.
- **What:** The declared contract is `T | null`, and all four consumers gate on the strict `filtered === null`
  / `out !== null`. A JS user filter that falls off the end of its body returns `undefined`, which passes
  every one of those guards; the next statement immediately dereferences `filtered.timestamp` /
  `out.timestamp`. `filters.ts` already establishes the fail-closed principle for the *throw* case ("we can't
  assume it was scrubbed") but leaves the structurally identical falsy-return case fail-open.
- **Why it matters:** Two distinct binding-rule violations from one root cause.
  - **Escapes into the host app.** `client.addBreadcrumb({...})` and `client.log('...')` are public,
    synchronous API called directly by application code. They throw a raw `TypeError` at the call site. The
    "SDK must never alter host application behavior" rule is broken by a *user configuration mistake*, with
    no diagnostic naming the filter as the cause.
  - **Silently stops capture.** On the provider paths the same `TypeError` is raised *inside an emitter
    listener*, so `MultiKeyEmitterBase.#dispatch` (`emitter.ts:88-94`) catches it and routes it to
    `#onListenerError` — which is `undefined` for every interceptor in the SDK (SEV2 #4). Net effect: every
    log line (or every network event) for the rest of the session is dropped, and **no sink fires** — not the
    aggregator's `onError`, not the filter store's `onError`, not the client's. The user sees a session with
    an empty `log`/`network` file and no explanation. A privacy control silently becomes a data-loss control.
- **Evidence:**
  - Probe `E2`: `runFilter(v => { /* no return */ }, {timestamp:1}, sink)` returns `undefined`;
    `out === null` is `false`; `out.timestamp` throws `TypeError`.
  - Probe `E2-host-a` / `E2-host-b` (real `createClient`):
    `expect(() => client.addBreadcrumb({message:'hi'})).toThrow(TypeError)` and
    `expect(() => client.log('hello')).toThrow(TypeError)` both **pass**. Control
    (`E2-host-control`, a correct `() => null` filter) does not throw and drops the entry — harness valid.
  - Probe `C1` (real `createLogCaptureProvider` + real aggregator + real memory store): with the broken
    filter installed, `source.emit('log', …)` twice → **no throw**, store still holds only the 1 control
    entry, and `onAggError`, `filterError` were both never called.
  - Mutation `F4` — applying the fix (`return filter(value) ?? null`) — **SURVIVED** the whole
    `filters.test.ts` + `client.test.ts` suite, proving the path has no test at all. Control mutations on the
    same function (`F-CTRL` fail-open on throw, `F1` drop `onError`, `F2` `==`→`===`, `F3` drop→keep) were
    all caught, so the harness is sound.

### 2. `InterceptorBase` marks itself active *before* installing the hook — one throwing `onActivate()` permanently disables that capture source, silently, and it is never retried

- **Where:** `packages/core/src/interceptor-base.ts:41-52`, specifically `this.#active = next;` at `:46`
  preceding `this.onActivate();` at `:48`. Reached from `packages/core/src/emitter.ts:79-86` (`#mutate` calls
  `this.onActiveChange(...)` outside any guard) via `emitter.ts:99-105` (`on`).
- **What:** `#updateActive()` commits the new `#active` state and only then calls `onActivate()`. If
  `onActivate()` throws, three things are true simultaneously: (a) the throw propagates out of `on()`, out of
  the provider's `onStart()`, out of `coordinator.start()` — the client's launch guard catches it, so it is
  reported once and forgotten; (b) the listener **is** already in the channel map (the `Map.set` completed
  before `onActiveChange` fired), so `#hasListeners()` stays true; (c) `#active === true` while the runtime
  hook is **not installed**. From there the state machine is permanently wedged: `stop()` leaves it active
  (listeners present), a relaunch's `on()` produces no 0↔≥1 transition so `onActiveChange` never fires again,
  and even an explicit `start()` short-circuits at the `next === this.#active` guard (`:43-45`).
- **Why it matters:** `onActivate()` is where every source in the SDK writes a runtime global —
  `console`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `node:http`
  `Server.prototype.emit`. Assignment to a frozen/non-configurable/non-writable global throws in strict mode
  (all ESM is strict), which is exactly what a hardened realm, a `Object.freeze(console)`, an SES/lockdown
  environment, or another SDK that installed a non-writable accessor produces. One such throw kills that
  entire capture stream for the process lifetime with no retry, no `onDeactivate` cleanup, and — because the
  interceptor keeps reporting itself active — no way for anything to notice. This is precisely the
  "off-by-one refcount ⇒ an interceptor stays installed forever / capture silently stops" hazard, in its
  worse form: the flag says installed, the reality says not.
- **Evidence:** Probe `E1`, all assertions pass — `expect(() => ix.on('a', l1)).toThrow('patch failed')`,
  `installs === 1`; then `ix.stop()` → `uninstalls === 0` (never deactivated); then with the failure cleared,
  `ix.on('b', l2)` → `installs` still `1`; then `ix.start()` → `installs` still `1`. **Never retried.**
  Control `E1b` (non-throwing `onActivate`) installs once and uninstalls on the last `off()` — harness valid.
  Mutation `I1` — applying the fix (move `this.#active = next;` after the `onActivate`/`onDeactivate` call) —
  **SURVIVED** `interceptor-base.test.ts` + `emitter.test.ts` + `capture-provider-base.test.ts`, proving the
  ordering is untested. Controls `I-CTRL` and `I2` on the same method were caught.

## SEV2

### 3. A listener that returns a rejected promise escapes both emitters entirely — an unhandled rejection reaches the host runtime

- **Where:** `packages/core/src/emitter.ts:88-94` + `:157` (`this.#dispatch(() => effective(payload))` —
  the return value is discarded) and `packages/core/src/event-emitter.ts:42-46`. Type surface:
  `emitter.ts:16` (`EventListener<T> = (payload: T) => void`) and `event-emitter.ts:8`.
- **What:** Both dispatch guards are synchronous `try`/`catch`. TypeScript assigns an `async` function to a
  `void`-returning signature without complaint, so `interceptor.on('log', async e => …)` and
  `client.operations.registerObserver(async op => …)` both typecheck; the returned promise is dropped, and a
  rejection is never seen by `onListenerError`.
- **Why it matters:** An unhandled rejection terminates a Node process under the ≥15 default
  (`--unhandled-rejections=throw`), which is the maximal violation of "never alter host application
  behavior" — and it is the *opposite* of what the emitter's own header comment (`emitter.ts:8-11`) promises.
  Ordering is also silently lost: an async listener's work interleaves after the whole emit loop finishes.
  Ranked SEV2 rather than SEV1 only because **no in-SDK subscriber is currently async** — I grepped every
  `.on(`/`.onAny(`/`.subscribe(`/`registerObserver(` production call site and found none. The exposure is
  through the public `EventSubscribable` / `OperationObserver` contracts (`contracts.ts:29`, `:34`), which
  extensions and APM observers are the natural candidates to use.
- **Evidence:** Probe `E6` — subscribing an `async` listener that throws and calling `emit` produced
  `onListenerError` **not** called, and vitest reported a real
  `Unhandled Rejection … ❯ src/emitter.ts:157:32 ❯ MultiKeyEmitterBase.#dispatch src/emitter.ts:90:7` —
  i.e. the rejection escaped the guard into the runtime.

### 4. The `onListenerError` sink is never wired anywhere in the SDK — every listener exception in the entire interceptor→provider pipeline is swallowed with zero diagnostics

- **Where:** `packages/core/src/emitter.ts:51-55` (the constructor parameter) against
  `packages/core/src/interceptor-base.ts:15-18` — `InterceptorBase` declares **no constructor**, so it neither
  accepts nor forwards a handler. All 16 subclasses call a bare `super()`:
  `packages/capture/src/console-interceptor.ts:75`, `fetch-interceptor.ts:225`, `xhr-interceptor.ts:105`,
  `web-socket-interceptor.ts:54`, `sse-interceptor.ts:52`, `web-transport-interceptor.ts:51`,
  `network-interceptor.ts:29`, `packages/node/src/http-interceptor.ts:218`, `node/src/system-events.ts:76`,
  `packages/browser/src/input-source.ts:201`, `browser/src/system-events.ts:62`,
  `browser/src/interaction-source.ts:90`, `browser/src/navigation-source.ts:126`,
  `packages/integration-shims/src/index.ts:56`, `:75`.
- **What:** `#onListenerError` is therefore `undefined` for every emitter the SDK actually constructs in
  production (the sole exception is `operation-dispatcher.ts:12`, which does forward its handler). The
  optional-call at `emitter.ts:92` becomes an unconditional swallow.
- **Why it matters:** The file's own contract (`emitter.ts:8-10`: "failures route to `onListenerError`") is
  not met in any shipped configuration. A capture provider that throws on every event — from a bad user
  filter (SEV1 #1), a malformed payload, a bug in a platform provider — drops 100% of that stream and emits
  **nothing anywhere**: not to the client's `onError`, not to the filter store's `onError`, not to a log.
  Core deliberately has no logger, so `onError` is the *only* diagnostic channel that exists, and the
  highest-traffic component in the SDK is not connected to it. Note the plumbing is already reachable —
  `getFilters()?.onError` is resolved per-event two frames away (`log-provider.ts:34`) — so this is a wiring
  omission, not a design constraint.
- **Evidence:** the `super()` grep above (16/16 bare); probe `C1` asserts all three candidate sinks
  (`onAggError`, `filterError`, no throw) stayed silent while two log entries were destroyed.

### 5. `stop()` on both coordinators is unguarded: a throwing `provider.stop()` strands every remaining provider **and permanently wedges the coordinator**

- **Where:** `packages/core/src/capture-coordinator.ts:74-80` and
  `packages/core/src/detection-coordinator.ts:66-72`.
- **What:** The teardown loop is bare, and the two state resets (`started.clear()`, `session = null`) sit
  *after* it. The first provider whose `stop()` throws aborts the loop, so (a) every later provider is never
  stopped — its global patch stays installed, its subscriptions stay live; (b) `session` is never nulled, so
  every subsequent `start()` throws `"CaptureCoordinator is already started"` forever; and (c) `started` is
  never cleared, so every retry of `stop()` re-enters the same throwing provider and fails identically.
- **Why it matters:** This is the stop-side twin of Pass A #4 (which covers the *start* loops at
  `capture-coordinator.ts:69-71` / `detection-coordinator.ts:61-63`) and it is strictly worse: the start-side
  failure loses a suffix of providers, this one **also destroys the client's ability to ever relaunch**, and
  leaves runtime globals patched after the user asked the SDK to stop. `client.ts:417-422` (`haltCapture`)
  calls both coordinators' `stop()` back to back with no guard, so a capture-provider stop throw also
  prevents `detectionCoordinator.stop()` from running at all.
- **Evidence:** Probe `E8`, all assertions pass — providers `bad` (throws on stop) + `good`:
  `expect(() => c.stop()).toThrow('stop boom')`, `stopped === []` (the healthy provider never stopped),
  `expect(() => c.start(…)).toThrow('already started')`, and a second `c.stop()` throws again.

### 6. A user filter receives the live shared payload object — in-place redaction contaminates every *later* subscriber and the emitter's own payload, making redaction subscription-order-dependent

- **Where:** `packages/core/src/filters.ts:44-58` (`runFilter` passes `value` through with no defensive
  copy), reached with an un-copied payload at `packages/capture/src/log-provider.ts:36` and
  `packages/capture/src/network-provider.ts:94`. On the network path the object is frequently the
  interceptor's own: `gateNetworkBody` (`packages/protocol/src/sanitize.ts:123`) returns the **same
  `event` reference** on two of its three exits.
- **What:** The documented filter contract is "mutate the event (or return a new one)" (`filters.ts:13`), so
  in-place mutation is the *expected* usage — but the object handed over is the one the interceptor
  broadcast to all its subscribers, and `MultiKeyEmitterBase.emit` passes the identical reference to every
  listener in sequence (`emitter.ts:157`).
- **Why it matters:** Whether a second subscriber (a replay consumer, an APM observer, a WebView bridge
  forwarder, an extension) sees redacted or unredacted data depends purely on **subscription order** — a
  non-obvious, non-deterministic privacy property. Core already knows this is wrong and defends against it
  exactly one layer down: `capture-aggregator.ts:29-36` explicitly copies before stamping, with the comment
  "a provider may hand us the very object the source emitter broadcast to all its subscribers … must not
  leak onto it", and `client.ts:535` spreads (`{ ...breadcrumb, timestamp }`) before filtering. The provider
  filter paths do neither.
- **Evidence:** Probe `E2b` — after `runFilter(v => { v.secret = 'REDACTED'; return v; }, value, …)`,
  `value.secret === 'REDACTED'` and `out === value` (same identity). Probe `C3` (real log provider + a
  second subscriber registered after it) — the later subscriber received `'REDACTED'` and the caller's
  original `LogEvent` object was mutated in place.

## SEV3

### 7. `once()` and `on()` clobber each other when given the same listener reference

- **Where:** `packages/core/src/emitter.ts:99-105` (`on` → `channel.set(fn, fn)`) and `:111-121`
  (`once` → `channel.set(fn, wrapper)`) — the channel `Map` is keyed by the *original* reference, so the
  second registration overwrites the first instead of coexisting.
- **What / Why:** `on(k, fn)` then `once(k, fn)` silently **downgrades the permanent subscription to
  one-shot**; `once(k, fn)` then `on(k, fn)` makes the once-listener **permanent**. Node's `EventEmitter`
  keeps both registrations. Bounded (no in-SDK component shares a handler reference across both APIs today),
  but it is a silent capture-loss primitive in a public API.
- **Evidence:** probes `E5a` (`fn` called 1× over two emits — the permanent subscription is gone) and `E5b`
  (`fn` called 2× — the once never fired once-only). Neither is covered by `emitter.test.ts`.

### 8. `emit()` has no re-entrancy guard; a self-emit cycle blows the stack and the `RangeError` is swallowed

- **Where:** `packages/core/src/emitter.ts:150-166` with `emitter.ts:88-94`.
- **What / Why:** A listener that emits the same channel recurses without bound. When the cycle is
  accidental and infinite, the `RangeError: Maximum call stack size exceeded` is caught by `#dispatch` and
  routed to `#onListenerError` — which is `undefined` (SEV2 #4) — so `emit()` returns normally having
  delivered nothing, with the stack near-exhausted and no trace of what happened. Same holds for
  `event-emitter.ts:35-48`.
- **Evidence:** probe `E7` (bounded self-emit reached depth 6, no guard) and `E7b`
  (`expect(() => e.emit(…)).not.toThrow()` passes and `onErr` received a `RangeError`). Untested.

### 9. `CaptureExporter.stream()` is dead API, and it acquires the store snapshot eagerly while releasing it only inside the generator — an abandoned iterator leaks the snapshot forever

- **Where:** `packages/core/src/capture-exporter.ts:30-51` — `store.snapshot()` (`:31`) and
  `snapshot.stream()` (`:32`) run at call time, but `snapshot.release()` (`:48`) lives in the generator's
  `finally`, which only runs once iteration has begun. Related:
  `packages/core/src/capture-snapshot.ts:25-32` captures `frozen` at `stream()` call time, so a `release()`
  issued between `stream()` and the first `next()` is a no-op.
- **What / Why:** `const it = exporter.stream()` with no iteration never releases — for a file-backed store
  a snapshot pins chunk files. Currently latent: **`stream()` has zero production callers** (`client.ts:345`
  uses only `drain()`; the only `.stream()` call in all of `packages/*/src` is the exporter's own at
  `capture-exporter.ts:32`). Worth flagging both ways — the design's memory-light streaming export path is
  shipped, type-exported, and exercised by nothing but its own tests.
- **Evidence:** probe `E9` — `exporter.stream()` then discard → `released === 0`. Mutation `S2`
  (make `capture-snapshot.stream()` read `frozen` lazily, i.e. honour a post-`stream()` release)
  **SURVIVED**, so neither ordering is pinned by a test. Mutations `X1`/`X2` (removing each `release()`
  outright) were caught, so the release itself is well covered.

### 10. `captureAggregator.clear()` is dead API and is the one aggregator method outside the "never propagate into the app" guard

- **Where:** `packages/core/src/capture-aggregator.ts:76-78` — `clear()` calls `store.clear()` directly,
  bypassing the `route()` try/catch at `:57-66`.
- **What / Why:** The file's contract (`:17-21`) is emphatic that a store/disk error "must NEVER propagate
  into the app". `clear()` is the exception. Currently unreachable — `grep -rn 'captureAggregator.clear\|
  aggregator.clear()' packages/` returns **zero** call sites repo-wide — so this is dead surface with a
  latent contract hole rather than a live bug.
- **Evidence:** probe `A5` — `expect(() => agg.clear()).toThrow('clear boom')` with a throwing
  `store.clear`. Contrast probe `A1` (throwing `store.add` → no throw, `onError` called once) and `A4`
  (throwing `getContext` → no throw, `onError` called once), both of which are correctly guarded.

### 11. `ReportHandler.after` is declared public API and is never invoked anywhere

- **Where:** `packages/core/src/filters.ts:21-22`. Confirmed by grep: no `.after` invocation exists in any
  package's `src/`. It is exported through the barrel and shipped in the umbrella's public types, so users
  can supply a callback that will never run and get no warning.

### 12. Test-strength gaps (surviving mutations and unenumerated paths)

40 mutations run, **32 caught, 3 survived, 5 excluded** (2 produced syntax errors — invalid controls —
and 3 were the "apply the fix" mutations already reported above as evidence). Survivors:

| # | Mutation | File | Result |
|---|---|---|---|
| `I1` | move `#active = next` after `onActivate()`/`onDeactivate()` | `interceptor-base.ts:46` | **SURVIVED** → SEV1 #2 is untested |
| `F4` | normalize a falsy filter return to `null` | `filters.ts:53` | **SURVIVED** → SEV1 #1 is untested |
| `S2` | read `frozen` lazily in `stream()` | `capture-snapshot.ts:26` | **SURVIVED** → SEV3 #9 |
| `C5` | delete `started.clear()` from `stop()` | `capture-coordinator.ts:78` | **SURVIVED** |
| `D-CTRL` | delete `started.clear()` from `stop()` | `detection-coordinator.ts:70` | **SURVIVED** |

`C5`/`D-CTRL` mean **both** coordinators' documented "Stop all started providers; **idempotent**" contract
(`capture-coordinator.ts:26`, `detection-coordinator.ts:18`) is unverified: nothing asserts that a second
`stop()` does not re-invoke `provider.stop()` on providers already stopped. A provider whose `stop()` is not
itself idempotent (double-unpatching a global, double-`off()`) would not be caught.

Additional untested paths enumerated while attacking, each verified absent from the corresponding
`.test.ts`: a listener returning a rejected promise (both emitters); `emit()` re-entrancy/recursion;
`onActiveChange` throwing; `once`/`on` same-reference interaction; a throwing `onError` sink passed to
`runFilter`; filter-argument aliasing; `ReportHandler.after`; `aggregator.clear()` error behavior.

## Emitter attack matrix

| Attack (mandate 1) | Verdict | Evidence |
|---|---|---|
| Listener throws — breaks the emit loop? | **CLEAN.** `#dispatch` isolates per listener; later listeners still run. Mutation removing the guard (`E-CTRL`) killed 6 tests. | `emitter.ts:88-94`; `emitter.test.ts:151-171` |
| Listener throws — escapes into the host? | **CLEAN** for sync throws (caught). **NOT CLEAN** for async rejections → SEV2 #3. | probe `E6` |
| Throwing listener leaves no diagnostic? | **SEV2 #4** — `onListenerError` is `undefined` in every shipped configuration. | 16 bare `super()` sites |
| Subscribe during emit | **CLEAN + tested.** `[...channel]` snapshot excludes it; it fires on the next emit. Mutation `M-CTRL-3` (iterate live map) caught. | `emitter.ts:153`; `emitter.test.ts:186-196` |
| Unsubscribe during emit | **CLEAN + tested.** `channel.get(original) === effective` recheck. Mutation `M-CTRL-1` caught; `onAny` equivalent (`M4`) caught. | `emitter.ts:156`, `:162`; `emitter.test.ts:198-205`, `:266-274` |
| Emit during emit (recursion / stack overflow) | **SEV3 #8** — no guard; overflow is swallowed. | probes `E7`, `E7b` |
| Double-unsubscribe | **CLEAN + tested.** `Map.delete`/`Set.delete` are idempotent. | `emitter.test.ts:45-54`; `event-emitter.test.ts:59` |
| Unsubscribe of a never-subscribed handler | **CLEAN + tested** (and correctly fires no `onActiveChange`). | `emitter.test.ts:67`, `:337-341`; `event-emitter.test.ts:82` |
| Same handler subscribed twice | **CLEAN + tested** for `on`+`on` (dedup, fires once, one `off` removes it). **SEV3 #7** for `on`+`once` mixes. | `emitter.test.ts:36-43`; probes `E5a`/`E5b` |
| Handler leak after `stop()` | **BOUNDED, not a finding.** `off()` empties the inner `Map` but leaves the (now empty) channel entry in `#channels` forever, and `#hasListeners()` rescans all channels twice per mutation. Growth is bounded by the **fixed** `StageMap` key set of each interceptor (verified: every production emitter is keyed by a closed union — `Record<NetworkStage, …>`, `{event: …}`, `ConsoleStageMap`), and `emit()` uses `#channels.get` (never `#channel()`), so emitting unknown names cannot grow the map. Worth knowing, not worth fixing. | `emitter.ts:57-64`, `:66-76`, `:131-133`, `:151` |
| Async listeners — awaited or dropped? | **DROPPED → SEV2 #3.** Delivery ordering for sync listeners *is* guaranteed and tested (insertion order via `Map`/`Set`). | `emitter.test.ts:27-34`; `event-emitter.test.ts:24`, `:34` |
| Multi-key: key collisions | **CLEAN.** Per-name `Map<name, Map<fn,fn>>`; cross-channel isolation tested. | `emitter.test.ts:12-21`, `:80-91` |
| Wildcard / `'*'` semantics | **N/A — none exists.** The wildcard facility is `onAny(listener)`, a separate `Set` with no name-key overlap, delivered *after* per-channel listeners; ordering, isolation, mid-dispatch removal and `removeAllListeners()` inclusion are all tested. | `emitter.ts:123-129`, `:161-165`; `emitter.test.ts:208-275` |
| Refcount ON at first subscriber / OFF at last | **CLEAN in the happy path** — both directions tested, including `onAny` counting toward presence, dedup not double-firing, `once` firing as the last listener, and `removeAllListeners`. Mutations `M-CTRL-2`, `M3`, `I-CTRL`, `I2` all caught. **BROKEN on the error path → SEV1 #2.** | `emitter.ts:79-86`; `emitter.test.ts:284-342`; probe `E1` |

## filters.ts privacy analysis

**Fail-closed verdict: correct for the `throw` case, fail-open for the falsy-return case.**

- **Throw → fail-closed. CORRECT and well tested.** `filters.ts:52-57` returns `null` (drop) and routes to
  `onError`. The critical privacy mutation — making the `catch` return `value` (fail-open, i.e. ship the
  unscrubbed event) — was **CAUGHT** (2 test failures), as was turning a `null` drop into a keep (`F3`,
  5 failures). This is the single most important property in the file and it is genuinely locked down.
- **Falsy non-`null` return → fail-open, then crash.** SEV1 #1. `runFilter`'s own signature promises
  `T | null`; it does not enforce it, and all four consumers use strict `!== null`.
- **Garbage (wrong-shaped) return → unvalidated pass-through.** A filter returning a string, a number, or an
  object missing `timestamp` is forwarded to `capture()`/`CaptureDataEntryBase` unchecked. Defensible (the
  user asked for it) but undocumented; only the `undefined` sub-case is dangerous enough to rank.
- **Caller-object mutation.** SEV2 #6 — no defensive copy; the live shared emitter payload is handed over.
- **Throwing `onError` sink escapes.** `filters.ts:55` — already reported as one of the four paths in
  **Pass A SEV1 #1**; re-confirmed here at the filters seam by probes `E2c`
  (`runFilter` re-throws `'sink boom'`) and `E2-host-c` (`client.addBreadcrumb` throws `'sink boom'` into
  the host). Not re-counted as a new finding.

**Bypass audit (is redaction applied on every path that can emit that entry type?).** I enumerated every
production emit site for the three filtered entry types:

| Entry type | Emit sites | Filtered? |
|---|---|---|
| `breadcrumbs` | `client.ts:539` | ✅ `client.ts:535` |
| `log` | `client.ts:554`; `capture/log-provider.ts:38` (filtered branch), `:41` (no-filter branch) | ✅ both — `:41` is only reached when `filters?.log` is falsy |
| `network` | `capture/network-provider.ts:96` / `:99` / `:101` | ✅ user filter XOR default sanitizer, per the documented Android rule; `:101` (raw) only when the user has explicitly disabled the default sanitizer |
| report | `client.ts:440` (`applyReportBefore`) | ✅ returns the value correctly (expression-bodied arrow — verified, not a discarded call) |

**No bypass found.** The `red` provenance flag the brief asked about is **not implemented in core** — grep
for `red` as an entry field returns nothing in `packages/core/src`; it belongs to the `@bugsee/webview`
bridge tier (`packages/webview/src/launch.ts:212` resolves `FiltersToken` for it). Out of Pass B scope; no
finding, but noting the brief's prior does not match core.

**Untested, enumerated** (44 test lines cover exactly 4 shapes: null filter, undefined filter, mutating
filter, dropping filter, throwing filter): a filter returning `undefined`/`false`/`0`/`''`; argument
aliasing / in-place mutation; a throwing `onError`; `ReportHandler.after`; that `createFilterStore` returns
an independent store per call; that the four `FilterStore` fields are independently settable.

## events.ts adjudication

**Type-only and fine — no finding.**

- All four exports are types: `LogEvent`, `Breadcrumb` (`interface`), `BreadcrumbInput` (`type`),
  `InputEvent` (`interface`) — `grep -cE '^export (const|function|class|enum|let|var|default)'` returns
  **0**. Every consumer imports it type-only (`filters.ts:3`, `client.ts:36` use `import type`;
  `client.ts:48`, `index.ts:121` use `export type`), so under `verbatimModuleSyntax` the module is erased
  entirely and never loaded at runtime.
- **Coverage-gate evidence:** `vitest run --coverage` on `@bugsee/core` reports
  `Statements 100% (1176/1176) · Branches 99.67% (605/607) · Functions 100% (315/315) · Lines 100% (1130/1130)`
  and `events.ts` **does not appear in the report at all** — it contributes zero instrumented statements,
  so it can neither pass nor fail the gate. It is not covered indirectly, not excluded, and carries no
  `/* v8 ignore */` (`grep -rn 'v8 ignore' packages/core/src/` → zero results, consistent with Pass A).
  A `.test.ts` would have nothing to assert; the shapes are exercised structurally by
  `filters.test.ts`/`client.test.ts` and type-checked by `tsc --noEmit`.
- Same adjudication applies to `request-context.ts` (36 lines): three interfaces plus one runtime statement,
  `ContextProviderToken = serviceToken<ContextProvider>('context-provider')` (`:36`), which
  `request-context.test.ts:6` asserts by name. Its 40 test lines are proportionate.

## For later passes

- **Pass C (storage).** The aggregator applies **no back-pressure and no ordering guarantee** — it is a
  synchronous pass-through (`capture-aggregator.ts:57-66`), so flood behavior (drop vs unbounded growth) is
  100% a `CaptureStore` property. Probe `A2` confirms out-of-order timestamps are stored as given
  (`agg.addEntry(ts=100)` then `ts=50` → drained as `[100, 50]`), and `bundle-assembler.ts:146-147` only
  computes a `min` for the bundle `start` — it never sorts. If any consumer of the uploaded files assumes
  monotonic timestamps, a backwards wall clock (NTP step, `Date.now()` adjustment) produces a
  non-monotonic file with nothing to detect it. Worth adjudicating in Pass C/D, not here.
- **Pass C (storage).** `CaptureSnapshot.release()` semantics are under-specified where `stream()` is
  concerned (SEV3 #9) — the memory implementation makes a post-`stream()` release inert. Whether the
  file-backed and streaming stores agree should be checked against their own contracts.
- **Pass D (bundle/upload).** `CaptureExporter.stream()` is dead API (zero callers). If the streaming export
  path is intended to become live for large recordings, its eager-snapshot/lazy-release asymmetry needs
  fixing first.
- **Cross-package (not core).** SEV1 #1 and SEV2 #6 both land their *consequences* in
  `packages/capture/src/log-provider.ts` and `network-provider.ts`; the fixes belong in `filters.ts`
  (normalize the return) and/or those two call sites (`out == null` + a defensive copy).
- **Pass A overlap, confirmed not re-counted:** `filters.ts:55`'s unguarded `onError` is Pass A SEV1 #1's
  sixth path; the coordinators' *start*-loop stranding is Pass A SEV2 #4 (my SEV2 #5 is the distinct
  *stop*-side defect).

## Checked and found clean

- **The dispatch loop is correct and the tests prove it.** 8/8 emitter mutations and 5/5 `event-emitter`
  mutations killed, spanning the snapshot, both membership rechecks, `onAny` ordering and clearing, the
  `once` self-removal ordering, unsubscribe identity, and `#hasListeners`. `emitter.test.ts` is **not
  theater**: assertions check delivered payloads (`toHaveBeenCalledWith({url:'/a'})`), exact call counts,
  and cross-listener *ordering* via a push-array (`:27-34`, `:229-236`), not merely "was called".
  `event-emitter.test.ts:13-22` even asserts payload *reference identity* across listeners.
- **`capture-aggregator.ts` is well guarded and well tested.** 4/4 non-control mutations caught, including
  mutating the caller's data in place instead of copying (`G1` — so the anti-mutation property SEV2 #6 is
  missing at the filter layer *is* explicitly locked at the aggregator layer), dropping the `Array.isArray`
  guard, omitting `span_id`, and truncating `addEntries`. Probes `A1` (throwing `store.add`) and `A4`
  (throwing `getContext`) confirm both are contained and reported, never propagated.
- **`capture-exporter.ts` / `capture-drain.ts` torn-record handling is real.** 4/4 and 2/2 mutations caught,
  including "abort the whole export on one bad record" in both files — the crash-resilience property the
  comments claim (`capture-exporter.ts:40-42`, `capture-drain.ts:24-28`) is genuinely enforced.
- **`capture-coordinator.ts` start-path, `detection-coordinator.ts`, `detection-provider-base.ts`,
  `capture-provider-base.ts`, `capture-snapshot.ts`, `capture-data-entry.ts`** — 13/14 mutations caught,
  including gate inversion (14 failures), skipping `init()` (7), dropping the late-start path, passing a
  stale report sink (6), keeping the report sink wired after `stop()`, flipping the default crash
  `mechanism`, returning `null` from the `pipeline` getter instead of throwing, dropping the capture
  timestamp, `groupByType` losing the first record of each type (29), a no-op `release()`, and both
  `serialize`/`deserialize` timestamp mutations.
- **Runtime portability is absolute in this pass.** Zero `globalThis`, `process.`, `window.`, `document.`,
  `require(` or `node:` across all 15 in-scope files — they are pure logic over injected seams, so nothing
  can break at import time on a DOM-less or Node-less runtime. `events.ts`, `request-context.ts` and
  `contracts.ts` imports are all type-only.
- **Non-serializable payloads cannot reach the app.** `CaptureDataEntryBase.serialize()`
  (`capture-data-entry.ts:16-18`) throws on circular refs and `BigInt`; `capture-aggregator.ts:58-65`
  catches it, reports, and drops the entry — exactly as the header comment promises.
- **The stamping path is genuinely non-mutating.** `capture-aggregator.ts:46-54` builds a fresh object and
  replaces `entry.data`; the shared emitter payload a provider passes through (`log-provider.ts:41`) is
  never touched. Verified by mutation `G1` being caught.
- **`removeAllListeners()` / `off()` fire `onActiveChange` correctly in both directions**, and neither fires
  spuriously when the emitter stays non-empty or when removing an absent listener — four separate tests,
  and the `M3`/`M-CTRL-2` mutations confirm they bite.
- **Detection→report routing is a no-op before `start()` and after `stop()`**
  (`detection-provider-base.ts:44-46`, `:33-35`) — both directions mutation-covered.
