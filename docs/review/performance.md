# Adversarial review — @bugsee/performance

**Reviewed:** 2026-07-26 · **Scope:** `packages/performance` (impl ~2291 LOC across 26 files, tests ~4098 LOC across 26 files; 214 tests, 100 % line/fn/stmt, 99.17 % branch). Read-for-context (not in scope, cited only where the boundary is load-bearing): `packages/bugsee/src/wire.ts`, `packages/bugsee/src/node.ts`, `packages/node/src/server-instrument.ts`, `packages/node/src/http-server-interceptor.ts`, `packages/node/src/trace-propagation.ts`, `packages/core/src/{clock,capture-aggregator,capture-provider-base,bundle-assembler,request-context}.ts`, `docs/design/frontend-adapters.md` §D11/§D12.

**Method:** 70 targeted mutations applied from `cp` backups and reverted (plus 1 "fix mutation"); 10 probe assertions run in three temporary test files (since deleted). `pnpm --filter @bugsee/performance exec tsc --noEmit` passes; 214 tests / 26 files green. `git status --short packages/` empty at start and at finish.

**Verdict:** The **architectural boundary holds cleanly** — all 11 `@bugsee/core` imports are published `index.ts` exports, there is not one deep import, and the package has zero `node:*`/DOM imports (every global read goes through a `globalThis` cast or the injected `WebVitalsEnv`). The **test suite is the strongest I have measured in this repo**: 69 of 70 mutations were killed, including every clock-selection, duration-arithmetic, unit-multiplier, threshold-boundary, cap, sampling and span-finalization mutation I could construct. This is not theater — `span.test.ts:173` asserts `durationNanos === 2_500_000` exactly, `metric.test.ts:13-17` pins both rating boundaries on the correct side, and `page-load.test.ts` asserts real navigation-timing arithmetic. The defects are therefore **not in the algorithms; they are in what the package is wired to and what it never lets go of.** Two are SEV1 and both were reproduced empirically: (1) the browser's deliberately-single-slot `getActiveSpan` **leaks into Node** because the umbrella passes `networkSource` unconditionally, so under any server concurrency an outgoing `http.client` span is attached to a *different request's* transaction — the very hazard the same file's comment at `wire.ts:255-259` says must be avoided, correctly avoided for trace propagation and missed here; (2) the browser `pageload` transaction is anchored at **SDK-launch time, not `timeOrigin`**, so it omits everything before the SDK booted and its resource/long-task children provably start *before their own parent*. Beyond those, `stop()` is a lie for the pageload path: 7 `PerformanceObserver`s and 14 DOM listeners are installed by default and **zero** are removed — `extension.stop()` is a literal empty body.

**On the brief's prior — the code agrees, with four corrections:**
- **Correction 1:** nothing in this package extends `InterceptorBase`. The `#active`-before-`onActivate` defect has **no direct blast radius here**; the package uses `CaptureProviderBase` (`capture-provider.ts:17`), whose `start()` is a plain `onStart()` call with no active-flag. The *indirect* radius is real but read-only: `collectHttpSpans` subscribes to the network umbrella (`wire-performance.ts:82-85`), so if that interceptor is killed upstream, every `http.client` span silently disappears with no diagnostic.
- **Correction 2:** `runFilter` has **no blast radius here at all**. Performance entries reach the store via `CaptureProviderBase.capture` → `captureAggregator.addEntry` (`core/src/capture-aggregator.ts:57-66`), which applies context stamping and a try/catch but **never calls a filter**. Verified by grep: the string `filter` does not appear in `packages/performance/src`.
- **Correction 3:** "on-by-default via the umbrella" is understated. It is on by default (`options.ts:32`) *and* the umbrella passes `networkSource` on **every** runtime including Node (`wire.ts:214`), which is what makes SEV1 #1 reachable. On the browser the default cost is 7 observers + 14 listeners.
- **Correction 4:** the two D11 tradeoffs I was told not to re-litigate are indeed accepted and I do not report them. But `docs/design/frontend-adapters.md:133-134` scopes D11/D12 explicitly to **"Browser active-context"**; it makes no claim about Node, and Node is where the model is actually unsound.

---

## SEV1

### 1. The browser single-slot `getActiveSpan` leaks into Node — outgoing `http.client` spans are attached to a *different concurrent request's* transaction

- **Where:** `packages/bugsee/src/wire.ts:214` (`networkSource: internals.network.interceptor,` — passed unconditionally, not gated on `platform.pageload`), consumed by `packages/performance/src/wire-performance.ts:81-86` and `packages/performance/src/http-spans.ts:106` (`const active = deps.getActiveSpan();` — read at **completion** time, not at request start), over the single-slot `active` in `packages/performance/src/controller.ts:78,113,117`. The Node path is `packages/bugsee/src/node.ts:27` (`wireUmbrella(..., { pageload: false, startupAtMs })`) and the transactions come from `packages/node/src/server-instrument.ts:396` (`transaction = perf.startTransaction({ ... operation: 'http.server' })`).

- **What:** `collectHttpSpans` resolves the parent transaction when the request *ends*, from a module-scoped single slot that always holds the **most recently started** transaction. On the browser this is the designed behaviour (D12: "the single active slot follows the MOST RECENT"). On Node, `perf.startTransaction` is called once per **incoming HTTP request**, and a Node server serves requests concurrently. So the slot is "whichever request arrived last", and every outgoing call that completes is parented to it regardless of which request actually made it.

- **Why it matters:** this is misattribution, not absence — the mandate's worst category. A downstream database/API call made by request A appears in request B's trace, with B's `traceId` and B's root as `parentSpanId`; A's transaction ships with **zero** child spans. The resulting waterfall is not merely incomplete, it is *wrong*, and there is no signal that it is wrong. It also produces a structurally invalid span: the child's `startTimestampMs` pre-dates its parent transaction's. Amplifier: a long-poll / SSE / slow request that is the last to start holds the slot for its whole lifetime, so **every** outgoing call from every other request during that window lands on it (up to `MAX_HTTP_SPANS = 100`). The team already knows this hazard — `wire.ts:255-259` says, for the *trace-propagation* decorator, that the perf-sourced single slot "would leak the ambient transaction's trace across concurrent server requests" and correctly gates that on `platform.pageload`; the same gate is simply missing on `networkSource`. `packages/node/src/trace-propagation.ts:5` repeats the warning verbatim.

- **Evidence (empirical, real `createPerformanceController` + real `collectHttpSpans`):** request A starts (`http.server`, t=1000000), A issues a fetch (`before`, id `req-1`), request B starts at t=1000010 and steals the slot, A's fetch completes at t=1000020:
  ```
  A spans: []
  B spans: [{"spanId":"7f82…","parentSpanId":"0c16…","operation":"http.client",
             "startTimestampMs":1000000,"endTimestampMs":1000020,
             "description":"GET https://db/a", …}]
  B start: 1000010   child start: 1000000     ← child begins 10 ms BEFORE its parent
  ```
- **Test status:** untested in both directions. Applying the *fix* (bind the owner span at the `before` stage and use it at completion — `http-spans.ts:98`) **breaks no test** (mutation `F1`, SURVIVED), so nothing pins the current behaviour; and `grep -rl concurren packages/performance/src` returns nothing.

### 2. The browser `pageload` transaction is anchored at SDK-launch time, not `performance.timeOrigin` — the page-load window silently omits everything before the SDK booted, and its children pre-date it

- **Where:** `packages/performance/src/page-load.ts:129` (`const transaction = api.startTransaction({ name, operation: 'pageload' })`) → `packages/performance/src/span.ts:191` (`this.#startTimestampMs = env.clock.wallNow();`). `TransactionOptions` (`span.ts:84-100`) has **no** start-time field, so the anchor cannot be overridden. Children are anchored differently: `page-load.ts:102-105` and `page-load.ts:83-88` use `timeOrigin + entry.startTime`.

- **What:** the transaction that represents the page load starts when `wirePerformance` runs — i.e. when the SDK finishes initialising — while every resource span, long-task span and web-vital value it carries is measured from `performance.timeOrigin` (navigation start). The two time bases are never reconciled.

- **Why it matters:** (a) the transaction's own window excludes the entire pre-SDK portion of the load, which for an async/deferred SDK tag is the *most interesting* part (TTFB, HTML parse, the first render-blocking assets) and is exactly the interval a customer is trying to measure; (b) it is not merely truncated, it is **inconsistent**: `web_vital.ttfb.value` / `.fcp.value` / `.lcp.value` are timeOrigin-relative numbers stamped onto a transaction whose own origin is a different, later instant, so a viewer plotting a vital against the transaction window places it outside the window; (c) every resource asset fetched before the SDK booted becomes a child span with `startTimestampMs < parent.startTimestampMs`, which any waterfall renderer will draw as a negative offset. Note the asymmetry that proves the intent: the **Node** startup transaction is correctly anchored — `wire.ts:230-241` builds the `app.start` wire by hand with an explicit `startTimestampMs: platform.startupAtMs`. Only the browser pageload has no way to do that. This is distinct from the D12 statement that the pageload "finishes on tab-hide"; D12 governs the *end*, and says nothing about the start.

- **Evidence (empirical):** with `timeOrigin = 1700000000000` and the SDK booting 2000 ms in, one resource fetched at `startTime = 120`:
  ```
  timeOrigin: 1700000000000 | pageload txn start: 1700000002000 | delta from timeOrigin (ms): 2000
  resource child start: 1700000000120 | predates parent by (ms): 1880
  ```

---

## SEV2

### 3. `stop()` never tears down the pageload capture — 7 `PerformanceObserver`s and 14 DOM listeners survive the SDK's own off switch, permanently

- **Where:** `packages/performance/src/extension.ts:84` (`stop() {}` — an empty body, with the docstring at `:50` conceding "no long-lived resources yet"), `packages/performance/src/wire-performance.ts:71-78` (`collectPageLoadVitals(...)` — return type `void`, no teardown captured) vs `wire-performance.ts:121-127` (`stop()` tears down only interactions/nav/http/uploader). The un-removed registrations are `page-load.ts:145,149`, `cls.ts:59,61`, `lcp.ts:48,58-66`, `inp.ts:90,92,97,112`, `fcp.ts:22`, `visibility.ts:17,24`. `observe.ts` never returns a disposer to its caller and `onHidden`'s cleanup (`observe.ts:51-54`) is discarded by every one of those call sites.

- **What / Why it matters:** `client.stop()` is composed to call `wired.stop()` (`wire.ts:281-286`), so this is the documented and only way a host turns APM off after launch. After it runs, the SDK is still observing `paint`, `largest-contentful-paint`, `layout-shift`, `event` (twice — once at the 40 ms threshold, once at threshold 0), `first-input` and `longtask` for the rest of the page's life, still holds `keydown`/`click`/`pagehide`/`visibilitychange` listeners, and on the next hide will still finish a transaction into a store nobody drains. `layout-shift` and threshold-0 `event` are the two highest-frequency observer types in the platform; keeping them attached after an explicit stop is a host-behaviour violation (it is CPU the host asked us to stop spending) and it leaks the whole transaction/env graph they close over. Compounding it, `extension.stop()` also never removes the capture provider or unregisters `ext('performance')`.

- **Evidence (empirical, `wirePerformance(...).stop()` against a counting fake env):**
  ```
  observers installed: paint,largest-contentful-paint,layout-shift,event,first-input,event,longtask
  doc listeners: visibilitychange ×6 | win listeners: pagehide ×5, keydown, click
  after stop -> disconnected: 0 / 7
  removed doc: (none) | removed win: (none)
  ```
  `wire-performance.test.ts:325` asserts only that "stop() tears down the uploader interval and unsubscribes http spans"; no test asserts observer disconnection.

### 4. A runtime whose `performance` lacks `timeOrigin` emits resource/long-task spans timestamped in **1970**

- **Where:** `packages/performance/src/page-load.ts:94` and `:77` — `const timeOrigin = env.performance?.timeOrigin ?? 0;`, then `startTimestampMs: timeOrigin + r.startTime` (`:102`) / `timeOrigin + e.startTime` (`:84`). The contract makes this reachable: `web-vitals/env.ts:65` declares `readonly timeOrigin?: number` (optional).

- **What / Why it matters:** this is precisely the monotonic→wall-clock confusion the mandate asks about. With the fallback, a `performance.now()`-domain value (a few thousand ms since page start) is written into a field the wire defines as unix-ms. There is no guard and no skip: the span ships with a plausible-looking small integer that a consumer will render as 1 Jan 1970. Every other timestamp in the same transaction is a real unix-ms, so the transaction becomes internally incoherent rather than obviously broken. The correct behaviour for a missing `timeOrigin` is to **skip** these spans (exactly what `collectNavigationTiming` does for missing phase endpoints, `page-load.ts:21-23`), not to substitute 0.

- **Evidence (empirical):** with `timeOrigin` absent and one resource at `startTime: 1234`:
  ```
  resource span start: 1234 -> 1970-01-01T00:00:01.234Z
  ```

### 5. Work recorded after a transaction finishes is silently discarded — including late web-vitals and every long task after page-hide

- **Where:** `packages/performance/src/span.ts:204-207` (`setAttribute` has no `#finished` guard) and `span.ts:215-233` (`recordChildSpan` likewise). The transaction is serialized once, inside `finish()` → `controller.ts:103-106`; anything mutated afterwards mutates an object nobody will read again. The concrete producers are `page-load.ts:134-144` (the `stamp()` closures each vital calls) and `page-load.ts:79-89` (the long-task observer, which is never disconnected — see #3).

- **What / Why it matters:** the pageload's correctness depends entirely on an **undocumented listener-ordering invariant**: the LCP/CLS/INP `onHidden` finalizers (`lcp.ts:66`, `cls.ts:61`, `inp.ts:112`) must run before the pageload's own `onHidden` (`page-load.ts:149`). Today they do, because they are registered first and DOM listeners fire in registration order — and `page-load.ts:146-147` says so. But nothing *enforces* it: reorder the five `on*` calls at `page-load.ts:140-144`, add a vital, or introduce any deferral into a finalizer, and that vital is dropped with no error, no warning, and no test failure. The API silently accepting the write is what makes the failure invisible. The long-task case is unconditional rather than conditional: the observer stays attached forever, so every long task after the first hide is recorded onto a dead transaction — CPU spent producing data that is thrown away.

- **Evidence (empirical):**
  ```
  delivered wire attrs: undefined          ← setAttribute('web_vital.lcp.value', 1234) after finish()
  longtask spans before finish: 0  after post-finish entry: 1   ← recorded onto an already-serialized txn
  spans before finish-serialize: 0  after: 2                    ← child spans added post-finish
  ```

### 6. A span that is never closed ships as `status: 'OK'` with no end time — indistinguishable from a healthy span

- **Where:** `packages/performance/src/span.ts:270-282` (`toSpanWire` emits `status` unconditionally from `#status`, whose initial value is `'OK'` at `span.ts:170`, and omits `endTimestampMs`/`durationNanos` when absent). `TransactionImpl.toTransactionWire` (`span.ts:333`) serializes **every** span in `env.spans`, finished or not.

- **What / Why it matters:** the public API hands out child spans (`startChildSpan`, `span.ts:212-214`) with no lifetime enforcement, and a forgotten `finish()` is the single most common instrumentation bug in any span API. The wire representation of that bug is a span reported as **successful** with no duration — so it is counted as a real, healthy unit of work rather than surfaced as an unterminated one. `SpanStatus` already has `'UNKNOWN'` (`span.ts:10`) which is exactly the right value here, and `finish()` already knows how to clamp (`span.ts:261-264`); neither is applied at serialization time.

- **Evidence (empirical):** `txn.startChildSpan('child.never.closed')` then `txn.finish()`:
  ```
  [{"spanId":"ef4d…","operation":"child.never.closed","status":"OK",
    "startTimestampMs":1000020,"parentSpanId":"e528…"}]     ← no end, no duration, status OK
  ```

---

## SEV3

### 7. Surviving mutation: the pageload's double-finalize guard is untested
- **Where:** `packages/performance/src/page-load.ts:148-155` (`let finalized = false; onHidden(env, () => { if (finalized) return; … })`).
- **What:** mutation `M27` (`if (finalized) return;` → `if (false) return;`) **SURVIVED** the full 214-test suite — the only survivor of 70. `onHidden` fires for both `visibilitychange` *and* `pagehide` (`observe.ts:44-50`), so on a normal tab close the guard is load-bearing for avoiding a second full `collectNavigationTiming` + `collectResourceTiming` pass (up to 100 duplicate resource spans plus a re-read of the whole resource buffer, on the unload path). Wire impact is nil today only because `TransactionImpl.finish` is itself idempotent (`span.ts:316-320`) so the duplicates are never serialized — i.e. the guard is protected by an accident of a *different* file. Add a test that fires hidden twice and asserts `collectResourceTiming` ran once.

### 8. `collectHttpSpans` `pending` map has no cap and no TTL
- **Where:** `packages/performance/src/http-spans.ts:92` (`const pending = new Map(...)`), written at `:98`, released only at `:104` (matched end stage) or `:130` (teardown).
- **What:** a request that emits `before` and never emits `complete`/`error`/`abort` — a WebSocket or SSE stream held open for the session, a request cancelled in a way the interceptor does not surface — leaves its entry forever. Every other bound in this package is explicit and per-transaction (`MAX_HTTP_SPANS`, `MAX_RESOURCE_SPANS`, `MAX_LONGTASK_SPANS`, the store's `maxTransactions`, and a `WeakMap` deliberately chosen at `:95` "so finished transactions are GC'd, never leaking entries over a long SPA session"). This one map is the exception. Bounded in practice by concurrent long-lived connections, so low severity — but it is the only unbounded structure in the request path.

### 9. `TraceEnv.spans` grows without limit for spans created through the public API
- **Where:** `packages/performance/src/span.ts:193` (`env.spans.push(this)` in every `SpanImpl` constructor) and `:232` (`this.env.spans.push(new RecordedSpan(wire))`), read at `:333`.
- **What:** the three *internal* producers are individually capped, but `startChildSpan`/`recordChildSpan` are exported API (`index.ts:73`) with no ceiling, and the array is per-trace and lives as long as the transaction. A long-lived transaction instrumented in a loop accumulates indefinitely; verified at 5000 spans with no eviction and no warning. Given `TransactionWire.spans` is JSON-serialized into `performance.json` and POSTed, a per-transaction span cap belongs in `SpanImpl`, not only in the three call sites that happen to have one.

### 10. Live spans and recorded spans derive `durationNanos` from **different clocks**
- **Where:** `span.ts:258-264` (live: `endTimestampMs` from `wallNow()`, `durationNanos` from `monotonicNow()` deltas) vs `span.ts:223-226` (recorded: `durationNanos` derived from the caller's **wall** `endTimestampMs - startTimestampMs`).
- **What:** for a live span, `endTimestampMs - startTimestampMs` (wall) and `durationNanos / 1e6` (monotonic) are two independent measurements of the same interval and can disagree across an NTP step; a backwards step yields `endTimestampMs < startTimestampMs` while `durationNanos` stays correct and clamped ≥ 0 (`span.ts:261`). For a recorded span they can never disagree, because the duration is *defined* by the wall timestamps — which means an NTP step during an `http.client` request silently clamps a real duration to 0 (`span.ts:223`). Neither is wrong in isolation; the wire simply does not say which derivation produced a given `durationNanos`, so a consumer cannot know whether to trust the timestamps or the duration. Both behaviours are deliberate and commented; flagging the *inconsistency between the two kinds*, not either choice.

### 11. `collectResourceTiming` reports the **earliest** 100 assets, not a sample of the page
- **Where:** `packages/performance/src/page-load.ts:93` (`env.performance?.getEntriesByType('resource')`) and `:43,96-97` (`MAX_RESOURCE_SPANS = 100`, `break` on reaching it).
- **What:** two truncations stack silently. The browser's resource-timing buffer defaults to 250 entries and stops recording (not evicting) once full, so on a resource-heavy page `getEntriesByType('resource')` already returns only the first 250; the loop then `break`s at the first 100. The header comment says the cap exists so "a resource-heavy page can't bloat the bundle", which is true, but the selection is positional, so the slow late-loading assets a user is investigating are exactly the ones guaranteed to be absent. Worth an explicit `nav.resources_truncated` marker so the omission is visible rather than inferred.

### 12. INP drops the reference implementation's `first-input` de-duplication
- **Where:** `packages/performance/src/inp.ts:80-92` — `handleEntries` is registered for both the `event` observer (`:90`) and the `first-input` observer (`:92`) and calls `processEntry` unconditionally; `processEntry` (`:58-73`) groups by `entry.interactionId ?? 0`.
- **What:** Google's `web-vitals` `onINP` — named as the design reference at `inp.ts:7` — guards the `first-input` path with a "no matching entry already recorded (same `duration` and `startTime`)" check precisely because the same physical first interaction can be delivered through both observers. That guard is absent here, so a `first-input` entry with a falsy `interactionId` is filed under id `0` as a **separate** interaction alongside the same event's own group. Effect is bounded: `estimateP98` (`:75-78`) selects index `floor(interactionCount()/50)`, which is 0 below 50 interactions, so the reported value is unaffected for short sessions; above 50 the phantom entry can shift the selected outlier by one. Reachability depends on whether the running Chrome assigns `interactionId` to `first-input` entries, which I did not verify in a real browser — reported as a deviation from the cited reference with that caveat, not as a confirmed miscount.

### 13. APM wiring is unguarded — a throw during extension setup escapes `launch()`
- **Where:** `packages/bugsee/src/wire.ts:205-221` (`const wired = wirePerformance({…})`, no try/catch) and `packages/bugsee/src/node.ts:27` / `packages/bugsee/src/launch.ts:28`; inside, `wire-performance.ts:66-67` (`extension.setup(client)`, `client.ext('performance')`) and `page-load.ts:149` → `observe.ts:49-50` (`env.document?.addEventListener(...)`).
- **What:** `observe()` is individually hardened (`observe.ts:29-38` try/catch, feature detection at `:26`) but the surrounding assembly is not. Every reachable throw source is host-controlled DOM (`document.addEventListener`, `window.addEventListener` on a page that has proxied them) or a core registration error, so I could not construct a realistic trigger and do not claim one. Reporting the structural gap only: an **opt-out-able, on-by-default extension** should not be able to fail the host's `launch()` call, and the file already models the right pattern for its siblings (`server-instrument.ts:417-419` wraps the identical `perf.startTransaction` call in `catch { transaction = undefined }` with the comment "APM wiring failure must never break the request").

### 14. `@bugsee/core` encodes the extension's wire envelope
- **Where:** `packages/core/src/bundle-assembler.ts:88-91` — `if (type === 'performance') { return { transactions: payloads }; }`.
- **What:** see the boundary audit below. The APM→core direction is clean; this is the one place the kernel hard-codes knowledge of a shape the extension owns.

---

## Core-boundary audit (does APM pierce the core?)

**Verdict: it does not.** All 11 `@bugsee/core` imports resolve to symbols exported from `packages/core/src/index.ts`; `grep -rn "@bugsee/core/" packages/performance/src` returns **nothing** (no deep/subpath imports); the only other cross-package imports are `@bugsee/protocol` types, a `declare module '@bugsee/types'` merge, and `@bugsee/util` in one test.

| import from core | symbol(s) | published seam or reach-through | file:line |
|---|---|---|---|
| `type Scheduler` | `Scheduler` | **published** (`core/src/index.ts:56`) | `performance-uploader.ts:1` |
| `type EventSubscribable` | `EventSubscribable` | **published** (`core/src/index.ts:114`) | `http-spans.ts:1` |
| `type Clock` | `Clock` | **published** (`core/src/index.ts:59`) | `span.ts:1` |
| `BugseeApi`, `BugseeError`, `HttpTransport` | 3 | **published** (`index.ts:190`, `:119`, `:196`) | `performance-send.ts:1` |
| `type EventSubscribable` | `EventSubscribable` | **published** (`index.ts:114`) | `interactions.ts:1` |
| `type EventSubscribable` | `EventSubscribable` | **published** (`index.ts:114`) | `navigations.ts:1` |
| `type BugseeClient`, `ClockToken` | 2 | **published** (`index.ts:51`, `:59`) | `extension.ts:1` |
| `type BugseeClient`, `type Scheduler` | 2 | **published** (`index.ts:51`, `:56`) | `wire-performance.ts:1` |
| `type CaptureProvider`, `CaptureProviderBase` | 2 | **published** (`index.ts:30` + contracts block) | `capture-provider.ts:1` |
| `type Clock` | `Clock` | **published** (`index.ts:59`) | `controller.ts:1` |
| `type OptionDefinition` | `OptionDefinition` | **published** (`index.ts:153`) | `options.ts:1` |
| *(tests only)* `createMultiKeyEmitter`, `resolveLaunchOptions` | 2 | **published** | `*.test.ts` |

One noted widening, self-declared: `extension.ts:41` takes the full `BugseeClient` rather than the minimal `Client` contract, because it needs `getService(ClockToken)` + `registerExt`. The file documents this at `:11-15` and flags the reconciliation. It is a *wider* published seam, not a private one.

**Reverse direction — does core know about performance concepts it shouldn't?** Five sites, one of which is a genuine leak:
- `core/src/bundle-assembler.ts:88-91` — **the real one.** The kernel hard-codes `{ transactions: [...] }` as the envelope for `FileType 'performance'`. That JSON shape is §8.8, owned by this extension (`package.json` description: "owns … Span/Transaction types"). If the extension changes its envelope, core must change. The seam that would avoid it (a per-FileType serializer supplied by the provider) does not exist. Mild, and the file already carries a second special case for `profile`, so it is a known pattern rather than an oversight.
- `core/src/transport.ts:97` — `OutcomeCategory` includes `'performance'`. Acceptable: outcome accounting is §7.5 core protocol vocabulary.
- `core/src/request-context.ts:21-23` — `RequestContext.trace`. Acceptable: W3C trace-context is a correlation primitive, not an APM one, and it is what the node adapters use *instead of* this package's slot.
- `core/src/extension-registry.ts:5` and `core/src/contracts.test-d.ts:160` — the string `'performance'` in a comment and a type test. Cosmetic.
- `@bugsee/protocol/src/constants.ts:30,48` — the `'performance'` FileType → `performance.json`. Correct location (protocol owns the file catalogue).

---

## Clock / unit consistency audit

| computation | site | clock | verdict |
|---|---|---|---|
| span `startTimestampMs` | `span.ts:191` | `clock.wallNow()` → `Date.now()` | wall — correct for the wire |
| span monotonic baseline | `span.ts:192` | `clock.monotonicNow()` → `performance.now()+timeOrigin` | monotonic — correct |
| span `endTimestampMs` | `span.ts:258` | `clock.wallNow()` | wall — correct |
| live span `durationNanos` | `span.ts:261-264` | monotonic delta × 1e6, clamped ≥ 0 | correct; **differs in derivation** from recorded spans → SEV3 #10 |
| recorded span `durationNanos` | `span.ts:223-226` | **wall** delta × 1e6, clamped ≥ 0 | internally consistent; clamps a real duration to 0 on a backwards NTP step |
| `http.client` start/end | `http-spans.ts:98,116` | `NetworkEvent.timestamp` ← `capture/fetch-interceptor.ts:226` `Date.now()` | wall — **consistent** with `recordChildSpan`'s expectation ✔ |
| resource span start/end | `page-load.ts:102-103` | `timeOrigin + startTime` | wall ✔ — **except** the `?? 0` fallback → SEV2 #4 |
| long-task span start/end | `page-load.ts:84-85` | `timeOrigin + startTime` | wall ✔ — same `?? 0` fallback → SEV2 #4 |
| `nav.<phase>_ms` | `page-load.ts:20-23` | timeOrigin-relative deltas, `end >= start` guarded | duration, not timestamp — correct, and the guard is tested (M21/M22 caught) |
| `nav.<milestone>_ms` | `page-load.ts:31-33` | timeOrigin-relative, truthiness-guarded | offset-from-navigation-start — correct |
| web-vital values | `ttfb.ts:22`, `fcp.ts:27`, `lcp.ts:41`, `cls.ts` (unitless), `inp.ts:84` | `performance` timeline (ms), `activationStart`-adjusted, clamped ≥ 0 | correct; every mutation caught (M18/M20) |
| `firstHiddenTime` | `visibility.ts:15` | `performance.now()` | compared only against `entry.startTime` — same base ✔ |
| CLS session windows | `cls.ts:41-42` | `entry.startTime` deltas | same base ✔ |
| `app.start` (Node) | `wire.ts:229,236-238` | `wallNow()` end, `Date.now() - uptime*1000` start | wall ✔ — and explicitly anchored, unlike the browser pageload (SEV1 #2) |
| metric id | `metric.ts:47` | `Date.now()` | an id, not a measurement ✔ |

**Monotonic value serialized as wall-clock:** exactly one path — `page-load.ts:77,94` `timeOrigin ?? 0` (SEV2 #4). **Wall value serialized as monotonic:** none found. **Transaction-vs-child base mismatch:** the pageload (SEV1 #2) — the parent uses `wallNow()` at SDK-init while the children use `timeOrigin`-derived wall times, so they are the same *unit* but a different *origin event*.

---

## On-by-default cost

A user who installs `@bugsee/bugsee` and never mentions APM gets `performanceMonitoring: true` (`options.ts:32`), `performanceSampleRate: 1` (`:33`) and a 30 s flush (`:39`). Measured by counting against a fake env:

- **Observers (browser, 7):** `paint`, `largest-contentful-paint`, `layout-shift`, `event` (durationThreshold 40), `first-input`, `event` **again** at `durationThreshold: 0` (the `interactionCount` polyfill, `inp.ts:96-110` — only when `performance.interactionCount` is absent), `longtask`. All `buffered: true`. Two of these (`layout-shift`, threshold-0 `event`) are the highest-frequency entry types available. **None is ever disconnected** (SEV2 #3).
- **DOM listeners (browser, 14):** 6 × `visibilitychange` (capture), 5 × `pagehide` (capture), 1 × `keydown`, 1 × `click` (both capture+once, LCP stop signals). **None is ever removed** (SEV2 #3).
- **Node (7 observers → 0, listeners → 0):** `pageload: false` (`node.ts:27`) skips all of it. What Node *does* get by default is `collectHttpSpans` on the network umbrella (`wire.ts:214`) — which is SEV1 #1 — plus the 30 s uploader interval and one `app.start` transaction.
- **CPU:** all computation is O(entries) inside observer callbacks, deferred a microtask (`observe.ts:31-32`) so nothing runs synchronously inside a browser task the SDK didn't cause. INP does an `Array.sort` per qualifying entry (`inp.ts:71`) over a ≤10-element list — negligible. The heaviest single act is `getEntriesByType('resource')` + up to 100 `recordChildSpan` calls, executed **once**, on the unload path (`page-load.ts:152-153`) — i.e. at the worst possible moment for a slow operation, though the volume is small.
- **Network:** one `POST /v2/performance/transactions` every 30 s, but **only when the buffer is non-empty** (`performance-uploader.ts:39`), and a session/Bearer handshake shared with the bundle upload (`performance-send.ts:22`). A quiet page sends nothing. Good.
- **Memory:** bounded — 100 transactions (`transaction-store.ts:22`, FIFO), 100 http spans *per transaction* via a `WeakMap` (`http-spans.ts:95`, an explicitly reasoned choice), 100 resources, 50 long tasks, 10 INP interactions. The exceptions are SEV3 #8 and #9.
- **Bundle:** `sideEffects: false` and the whole extension is behind `if (!options.monitoring) return undefined` (`wire-performance.ts:59`), but the umbrella imports `wirePerformance` statically (`wire.ts:21`), so setting `performanceMonitoring: false` **skips the work, not the bytes** — the code still ships. Nothing here is lazy-imported the way `@bugsee/replay-canvas` is from the browser tier.

**Host-behaviour verdict (the specific question asked):** `clearResourceTimings` / `clearMarks` / `clearMeasures` / `setResourceTimingBufferSize` appear **nowhere** in the package — verified by grep. The host application's own resource-timing data is left completely intact. That is the right call and it is worth keeping that way.

---

## Node concurrency verdict

**Split, and the split is the bug.** The parts of Node that were designed with concurrency in mind get it right; the part that was inherited from the browser does not.

- ✅ Per-request **context** is `AsyncLocalStorage`, not a slot: `server-instrument.ts:350` uses `store.run(context, …)` for the `run`-scoped path (node:http emit patch, native serve wraps, express/koa) and `enterWith` for hook adapters (`:319`), with first-owner-wins re-entrancy at `:314-317`.
- ✅ **Trace propagation** explicitly refuses the perf slot: `node/src/trace-propagation.ts:38-47` sources the outbound `traceparent` from `store.getCurrent()?.trace`, and `:5` states the reason — the perf `getActiveSpan` "is wrong under server concurrency". `wire.ts:261` gates the umbrella's perf-sourced decorator on `platform.pageload` so it never registers on Node.
- ✅ The `http.server` **transaction object itself** is per-request and correctly scoped — it is captured in the `makeSpan` closure (`server-instrument.ts:391`) and finished from `res.once('close')` (`http-server-interceptor.ts:148-154`), so concurrent requests never share or clobber each other's transaction. `writableFinished` correctly distinguishes completion from client abort. A hung socket is **not** a leak: `'close'` always fires eventually, so the span always terminates.
- ❌ **Outgoing `http.client` spans do use the browser single slot.** `wire.ts:214` passes `networkSource` unconditionally; `wire-performance.ts:81-86` builds the collector with `getActiveSpan: () => api.getActiveSpan()`; `controller.ts:78` is one module-scoped variable. Under concurrency this cross-attributes (SEV1 #1). The fix is symmetric with the one already applied to propagation — either gate `networkSource` on `platform.pageload`, or (better, and it fixes the browser's own "request in flight across a navigation" case too) bind the owner span at the `before` stage in `http-spans.ts:98` rather than resolving it at completion.

So: the browser model did *not* stay in the browser. It leaked into Node through exactly one line.

---

## Test quality

**69 of 70 mutations killed.** This is the strongest suite reviewed so far, and it is strong in precisely the places the mandate flagged as theater-prone.

- **Duration arithmetic & units — 6/6 killed.** `*1e6 → *1e3` (a plausible ns/µs slip) killed in **both** the live-span path and the `recordChildSpan` path; `*1e6 → *1` killed; `Math.round` nearest-vs-floor pinned at `span.test.ts:189-199`; the ≥0 clamp pinned at `:202-210`. Values are asserted exactly (`toBe(2_500_000)`), not `toBeGreaterThan(0)`.
- **Clock selection — 2/2 killed.** Swapping `wallNow()` → `monotonicNow()` for either `startTimestampMs` or `endTimestampMs` fails tests. The fakes return *different* values for the two clock methods, which is what makes this detectable at all.
- **Span finalization — killed.** Idle-timeout OK, final-timeout `DEADLINE_EXCEEDED`, `cancel()` → `CANCELLED`, the idempotence guard, and keepAlive's timer reset are each pinned (`idle-transaction.test.ts:86-100` and siblings).
- **Web-vitals — 16/16 killed.** CLS session gap, session max, largest-window-not-total, `hadRecentInput` filtering; INP's `/50` p98 index, max-not-last latency, the 10-interaction window, the `/7` id increment; LCP/TTFB `activationStart` subtraction; FCP's `first-contentful-paint`-not-`first-paint` name check; `buffered: true`; the microtask defer; `supportedEntryTypes` feature detection; the visibility watcher's `min`. Rating boundaries are pinned on the correct side of `>` at `metric.test.ts:13-17`.
- **Real entry shapes:** the fakes are structural (`{ name, entryType, startTime, duration, … }`) rather than `vi.fn()` blanks, and `performance-bundle.integration.test.ts` goes end-to-end through a real zip (`unzipSync`) to assert the `performance.json` envelope — so the wire shape is checked against the real bundle path, not a mock.
- **Gaps (all listed above as findings, not separate items):** (a) `M27` — the only survivor, the double-finalize guard (SEV3 #7); (b) `F1` — applying the SEV1 #1 fix breaks nothing, so the misattribution is unpinned in both directions; (c) no test asserts observer disconnection on `stop()` (SEV2 #3); (d) no test constructs a `performance` without `timeOrigin` (SEV2 #4); (e) no test exercises two overlapping transactions with interleaved network events, which is the shape that would have caught SEV1 #1.

---

## Checked and found clean

- **Runtime portability.** Zero `node:*` imports, zero direct DOM identifiers outside the injected `WebVitalsEnv`; every ambient access is a lazy `globalThis` cast (`span.ts:116` WebCrypto with a `Math.random` fallback, `idle-transaction.ts:42` timers, `env.ts:81` the browser surfaces). Nothing is evaluated at import time. `WebVitalsEnv` fields are all optional so each signal self-noops where its API is absent (`observe.ts:26`), which is what makes the package degrade correctly on workers/edge.
- **Host resource-timing data is not destroyed** — no `clearResourceTimings`/`clearMarks`/`clearMeasures`/`setResourceTimingBufferSize` anywhere.
- **Long tasks cannot back-date the transaction.** `collectLongTasks` uses `recordChildSpan` (an independent span) rather than opening-and-closing a live child, so the classic Sentry `startAndEndSpan` back-dating rake is structurally avoided — as `page-load.ts:70-73` claims.
- **`observe()` is correctly hardened:** feature-detects `supportedEntryTypes`, wraps `new Ctor` + `observe()` in try/catch, defers callbacks a microtask for Safari's synchronous delivery. All three pinned by mutation.
- **`onHidden` never uses `unload`** (`observe.ts:44-50` uses `visibilitychange` + `pagehide` only), so bfcache is not broken. `onBFCacheRestore` exists (`:58-68`) though no metric currently subscribes to it.
- **Sampling:** `createRateSampler` short-circuits both endpoints and uses strict `<`; both boundary mutations killed. Continuation correctly **adopts** the upstream sampling decision rather than re-rolling (`controller.ts:93`), and only sampled transactions are buffered (`:103`) — all pinned.
- **Trace-context parsing** in `http-spans.ts:35-49` correctly rejects the `ff` forbidden version, all-zero trace/span ids, and non-hex; the deliberate leniency about the `flags` segment is documented at `:32-34` and is the right call for a header we did not author. Mutations against the zero-id checks were killed.
- **URL cardinality/PII:** query + fragment are stripped from both resource descriptions (`page-load.ts:58`) and http-span descriptions (`http-spans.ts:117`); `data:`/`blob:` payloads are collapsed (`:55-57`). Both pinned by mutation.
- **Upload path:** best-effort by construction — the batch is drained before send, failures go to `onError` and the batch is dropped, `start`/`stop` are idempotent, empty batches skip the request entirely, and `teeSend` uses `allSettled` so an OTLP failure cannot suppress the Bugsee upload. All pinned.
- **Interaction/navigation coexistence:** the "a navigation already owns the slot → skip the interaction" gate (`interactions.ts:77`) and the "orphaned interaction must not be propped up by the navigation's network activity" keepalive guard (`:104-107`) are both implemented as documented and both pinned by mutation.
- **The two accepted D11 tradeoffs** (slot clears to `undefined` rather than reverting to the lingering pageload; an orphaned interaction idle-finishes on its own) are implemented exactly as `docs/design/frontend-adapters.md:134` describes, with the reasoning restated in `controller.ts:108-112`. **No divergence between code and doc.** Not reported, per the brief.
- **`InterceptorBase` blast radius: none.** No class in this package extends it.
- **`runFilter` blast radius: none.** No filter is invoked on any path in this package.
