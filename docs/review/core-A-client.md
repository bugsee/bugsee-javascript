# Adversarial review — @bugsee/core, Pass A (client / lifecycle / public API / DI)

**Reviewed:** 2026-07-26 · **Scope:** `packages/core/src/` — `client.ts` (670/1461), `bugsee-api.ts` (94/170),
`carrier.ts` (132/198), `options.ts` (80/142), `environment.ts` (58/95), `contracts.ts` (254, `.test-d` only),
`index.ts` (215, `.test-d` only), `services.ts` (21, `.test-d` only), `extension-registry.ts` (39/64),
`errors.ts` (24/54), `clock.ts` (36/66). Read-only; all mutations reverted from `cp` backups; final
`git status --short packages/` empty.

**Verdict:** The kernel's lifecycle state machine is sound in its *intended* transitions and the test suite is
genuinely strong — a 23-mutation battery killed 20, including all 8 aimed at `client.ts`'s lifecycle
(relaunch, kill-state idempotence, drain-timeout race, `haltCapture`, dedup, cause-depth). This is not test
theater: assertions reach real effects (timer handle installed/cleared, `tick` called with the injected
clock, a dedicated `unhandledRejection` watcher). The defects are at the *edges* the state machine does not
model. Two are SEV1: (1) the `onError` seam — the one user-supplied callback in core that is **not**
wrapped, while every other one (filters, report handler, snapshot sources, operation observers) is — turns
four guard paths into host-crash paths, directly violating the binding "never alter host application
behavior" rule and the explicitly-tested §15.1 "launch never throws" contract; (2) `stop()` halts the
evictor but not the manual-capture entry points, so post-stop capture accumulates in an unbounded, never
rotated part. Beyond those, the carrier's version-namespacing is inert (`BUGSEE_SDK_VERSION` is a hardcoded
`'0.0.0'` that no build step substitutes — verified in the shipped `dist/`), a single throwing provider
strands every provider registered after it, and `resolveLaunchOptions` converts an explicitly-`undefined`
option into `undefined` rather than its default — reachable in production because both platform launchers
pass the user's raw options object straight through.

**Three corrections to the brief — the code disagrees with the prior:**
- **There is no consent API.** `grep -rn 'grantConsent\|revokeConsent\|deleteCollectedData\|isCapturing'
  packages/` returns **zero hits repo-wide**. There is no consent surface to audit; `stop()` is the only
  "stop collecting" affordance, which is why SEV1 #2 is ranked where it is.
- **There is no `pause`/`resume` on the client.** The only `pause` in core is
  `streaming-capture-store.ts:37`, a host-driven forwarding flag for the WebView/Electron path — not a
  client lifecycle state.
- **`internals === undefined` on a repeat launch is platform behavior, not core.** Confirmed at
  `packages/node/src/launch.ts:368` and `packages/browser/src/launch.ts:271`. Core's `createClient` has no
  `internals` concept; its own re-entrancy guard is `launch()`'s `if (killed || launched) return`
  (`client.ts:622`).

Confirmed as stated: the DI container is `@bugsee/service` (core only wraps it — `client.ts:497-505`); core
has **no logger dependency** (verified: only the `onError` seam); `flush()`/`stop()` do await in-flight
reports (`client.ts:385-413`).

## SEV1

### 1. The `onError` seam is never guarded — a throwing error-handler escapes into the host from four paths, including a bare timer callback and a promise handler
- **Where:** `packages/core/src/client.ts:431` (`enterKillState`), `client.ts:632` and `client.ts:642`
  (`launch()`), `client.ts:651` (tick timer), `client.ts:464` and `client.ts:472` (report markers); also
  `packages/core/src/filters.ts:55` (`runFilter`).
- **What:** Every internal guard has the shape `try { risky() } catch (e) { onError(e) }`, but `onError`
  itself is never wrapped. `onError` is a **public, user-supplied** option (`client.ts:268`,
  `CreateClientOptions.onError`) that both platforms forward verbatim from user input
  (`packages/node/src/launch.ts:845`, `packages/browser/src/launch.ts:539`). This is the *only* user callback
  in core without isolation — `runFilter` (filters.ts:52-57), the report handler, `reportSnapshots`
  (client.ts:352-364) and the operation observer are all wrapped.
- **Why it matters:** Binding rule — "the SDK must never alter host application behavior" — is broken four
  ways, each with a distinct host-visible failure mode:
  - `client.ts:651`: the throw leaves a `setInterval` callback → **`uncaughtException`**. The comment two
    lines above (`client.ts:645-646`) states this exact outcome "could take down the host".
  - `client.ts:632`/`642`: `launch()` **throws**, breaking the §15.1 contract that `client.test.ts:817`
    (`expect(() => client.launch()).not.toThrow()`) exists to protect.
  - `client.ts:431`: the throw escapes `track`'s `.then` handler (`client.ts:394-400`) whose derived promise
    is discarded → **unhandled rejection**, which terminates the process under Node ≥15 defaults.
  - `client.ts:464`/`filters.ts:55`: `logException` — declared `Promise<UploadResult>` but not `async` —
    **throws synchronously**, so a caller doing `client.logException(e).catch(...)` gets a raw throw instead.
- **Evidence:** Four probes, each passing, run via a temporary
  `packages/core/src/zz-review-probe.test.ts` (since deleted):
  - PROBE 1 — `expect(() => sched.calls[0]?.cb()).toThrow('onError boom')` with a throwing `store.tick` and a
    throwing `onError`. Contrast the existing `client.test.ts:1433-1443`, which asserts the callback never
    throws — but only with a *non-throwing* `onError`.
  - PROBE 2 — `expect(() => client.launch()).toThrow('onError boom')` with a throwing capture provider.
  - PROBE 7 — a fatal `UploadResult` trips `enterKillState`; a `process.on('unhandledRejection')` watcher
    captured exactly 1 rejection.
  - PROBE 11 — `expect(() => client.logException(new Error('x'))).toThrow('onError boom')` via a throwing
    `setReportHandler({before})`.

### 2. `stop()` disables the evictor but not manual capture — capture continues after stop into an unbounded, never-rotated part
- **Where:** `packages/core/src/client.ts:530`, `:544`, `:557`, `:571` (`addBreadcrumb`/`log`/`event`/`trace`
  gate on `killed` only, never on `stopped`) against `client.ts:662` → `client.ts:417-422` (`haltCapture`
  clears `tickTimer`).
- **What:** `stop()` sets `stopped = true` and clears the tick timer, but the four manual capture entry
  points keep writing to the store. `chunk-capture-store.ts:83` (`tick`) is the **only** time-window
  evictor; `add()` (`chunk-capture-store.ts:74-81`) calls only `enforceByteCap`, which returns immediately
  when `maxDataSizeBytes === undefined` (`chunk-capture-store.ts:61-63`) — and that is the default, because
  `client.ts:291-294` constructs the memory store with `maxRecordingTimeMs` only. Worse, without `tick()`
  the current part is never *closed*, so even a configured byte cap cannot evict it (the
  `parts.length > 1` guard at `chunk-capture-store.ts:64` never trims the lone open part).
- **Why it matters:** Two consequences. (a) **Unbounded memory growth**: after `stop()`, every
  `client.log()` / `addBreadcrumb()` / `event()` / `trace()` accumulates forever with no rotation, no time
  eviction and no byte cap — in a long-lived Node service that called `stop()`, this is a monotonic leak.
  (b) **Collection continues after the user asked the SDK to stop.** With no consent API in the SDK,
  `stop()` is the only affordance a user has to halt collection, and it does not halt it. The asymmetry is
  self-evidently unintended: `logException` *is* gated on `stopped` (`client.ts:583`) with the comment
  "manual captures that upload become no-ops (§1501)".
- **Evidence:** PROBE 4 — launch, `await stop()`, clear the recorder, then call all four entry points:
  `expect(added).toHaveLength(4)` passes; all four records reached `CaptureStore.add`. Eviction-path claim
  verified by reading `chunk-capture-store.ts:55-99`.
- **Note for later passes:** on Node the default store is *file-backed*, and capture recovery rebuilds
  bundles from durable chunks — so post-stop entries may also surface in a recovered bundle. That
  interaction lives in `capture-recovery.ts` / `file-chunk-backend.ts`, outside Pass A.

## SEV2

### 3. The carrier's version-namespacing is inert: `BUGSEE_SDK_VERSION` is a hardcoded `'0.0.0'` no build step replaces
- **Where:** `packages/core/src/carrier.ts:26`, consumed at `carrier.ts:57-61`.
- **What:** The literal `'0.0.0'` is the slot key. There is no build-time substitution: `tsup.config.base.ts`
  declares no `define`/`replace`, and the **shipped artifacts** contain the literal —
  `packages/core/dist/index.js:512` (`var BUGSEE_SDK_VERSION = "0.0.0";`) and
  `packages/core/dist/index.d.ts:867`.
- **Why it matters:** `carrier.ts:16-23` states the design goal — "Different SDK versions get separate slots
  so they coexist without fighting over the same global (the documented Sentry-carrier trade-off)". That
  property does not hold: **every** published version collides on slot `'0.0.0'`. Two SDK versions in one
  process (mixed dep ranges across framework adapters — the exact scenario the carrier exists for) share one
  `interceptors` Map and one `client` slot, so `getCarrierClient()` can hand a v1 client to v2 code, and
  `getOrCreateInterceptor` can return a v1 interceptor to a v2 caller expecting a different stage map. Note
  the intra-version dedup (the actual duplicate-module hazard) **does** work correctly — verified by
  mutation, see "Checked and found clean".
- **Evidence:** `grep -rn 'BUGSEE_SDK_VERSION'` across `packages/` + `tsup.config.base.ts`; inspected
  `packages/core/dist/index.js` and `dist/index.d.ts`.

### 4. One throwing provider strands every provider registered after it — permanently, across relaunches
- **Where:** `packages/core/src/capture-coordinator.ts:69-71` and
  `packages/core/src/detection-coordinator.ts:61-63` (unguarded `for` loops), against the client's
  coordinator-level guard at `client.ts:629-643`.
- **What:** The client wraps `coordinator.start()` as a whole, so the *first* provider that throws aborts the
  start loop; providers later in registration order never start. `capture-coordinator.ts:10-11` documents
  coordinator-level isolation as intentional, and `client.ts:627-628` claims only that "a failed capture
  start must not prevent **detection** from starting" — per-provider isolation is nowhere claimed, but
  nowhere provided either.
- **Why it matters:** A single provider that throws on an exotic runtime (a platform probe, an
  extension-contributed provider) silently disables an arbitrary suffix of the capture pipeline, and the
  user sees exactly one `onError` call for the one that threw — nothing indicates that N others never
  started. Silent, partial, order-dependent data loss.
- **Evidence:** PROBE 3 — providers `a`, `bad` (throws), `c`: `started === ['a']`, `onError` called once,
  `isLaunched() === true`. A second test confirms a `stop()` → `launch()` cycle does **not** rescue `c`
  (`started === []` across two launches, because `bad` throws again and re-aborts the loop).

### 5. `resolveLaunchOptions` turns an explicitly-`undefined` option into `undefined`, defeating both its default and every provider's fallback
- **Where:** `packages/core/src/options.ts:52` (`Object.hasOwn(values, def.friendly) ? values[def.friendly]
  : def.default`) interacting with `options.ts:12` (`Object.hasOwn(values, key) ? values[key] : fallback`).
- **What:** `{ maxNetworkBodySize: undefined }` has the own key, so `canonical[key]` is assigned `undefined`
  rather than `20480`. `createOptionsContainer` then also sees an own key, so
  `options.get(key, 20480)` returns `undefined` — bypassing the definition default **and** the caller's
  fallback. `options.ts:7-8` documents own-key semantics as deliberate for `createOptionsContainer`; the
  interaction with `resolveLaunchOptions`'s default application appears unintended.
- **Why it matters:** Reachable in production, not a synthetic case: `packages/node/src/launch.ts:374-377`
  and `packages/browser/src/launch.ts:276` pass the caller's **raw options object** in. The idiomatic TS
  pattern `launch(token, { maxNetworkBodySize: cfg?.limit })` with an absent `cfg.limit` therefore silently
  disables the 20 KB body cap default, handing consumers `undefined` where a number is expected — the
  mandate's "invalid option silently disables a feature" shape.
- **Evidence:** PROBE 5, with an omitted-key control in the same test:
  `omitted.options.get('com.bugsee.option.capture.network.body-size-limit', 20480) === 20480` (control
  passes) while `resolved.options.get(same, 20480)` is `undefined`.

### 6. Boolean launch options honor only the literal `false`; every other falsy value silently leaves capture ON
- **Where:** `packages/core/src/options.ts:57` — `isEnabled: (key) => canonical[key] !== false`.
- **What:** `captureNetwork: null`, `captureLogs: 0`, `captureSystemTraces: 'false'` all evaluate to
  *enabled*. There is no type validation and no diagnostic for a non-boolean value on a boolean option.
- **Why it matters:** Privacy-relevant fail-open. Config-driven opt-outs routinely produce `null` (JSON /
  a database column), `0` (an env-var parse), or `'false'` (a raw `process.env` string). Every one of those
  keeps capture running while the operator believes it is off — and nothing surfaces the mismatch. The
  behavior is documented (`options.ts:41`), but documenting a fail-open default does not make it safe;
  fail-closed on a *recognized* option key with an unusable value would.
- **Evidence:** PROBE 5b, using the real `BugseeOption.*` identifiers (an earlier run with guessed keys
  passed vacuously — corrected before drawing this conclusion): all three assert `isEnabled(...) === true`.

### 7. Edge runtimes get the default 1-second global `setInterval`, which core's own documentation says they must not
- **Where:** `packages/core/src/client.ts:94-103` (`defaultScheduler`) + `client.ts:323`
  (`options.scheduler ?? defaultScheduler`), against the contract stated at `client.ts:78-79`: "Injectable
  for tests and for edge/lambda (where a long-lived timer is undesirable — **pass a no-op**)".
- **What:** No edge platform discharges that obligation. `packages/vercel-edge/src/launch.ts:195` forwards a
  scheduler *only if the user supplied one* (`...(options.scheduler !== undefined ? {...} : {})`), and
  `@bugsee/cloudflare` reuses the same `launchEdge` (`packages/cloudflare/src/launch.ts:1`). The `unref?.()`
  softener at `client.ts:99` is a no-op on those runtimes (no `unref` on their timer handles).
- **Why it matters:** A 1 Hz timer runs for the isolate's lifetime, ticking a memory store that
  edge's incident-driven model does not need — wasted CPU on a platform billed by CPU time, and precisely
  the "lingering timer in an edge runtime is a bug" case in the mandate.
- **Evidence:** `grep -rn 'scheduler' packages/vercel-edge/src/*.ts packages/cloudflare/src/*.ts`; read
  `packages/vercel-edge/src/launch.ts:185-197`. **Cross-package** — the fix may belong in either the edge
  launcher (pass a no-op) or in core (default to no-op and let platforms opt in).

### 8. `stop()`/`flush()` with no timeout can hang host shutdown indefinitely
- **Where:** `packages/core/src/client.ts:405-413` — the `Promise.race` bound applies only inside
  `if (timeout === undefined) { return drained; }`'s else path.
- **What:** `stop()` and `flush()` both take an *optional* timeout, and both are documented as
  "bounded by `timeout`" (`client.ts:403-404`). With the argument omitted there is no bound at all: a
  trigger pipeline whose `assemble` or upload never settles leaves `drainPending` pending forever.
- **Why it matters:** `await bugsee.stop()` is the natural call in a shutdown hook or a Node CLI's exit path.
  An unresponsive collector or a stuck assemble converts an SDK teardown into a hung host process — again
  the SDK altering host behavior. The existing test `client.test.ts:1287-1297` covers only the *released*
  case; `client.test.ts:1299` covers the bounded case. The unbounded-hang case is untested.

### 9. Detection reports bypass the capture rate limiter that protects `logException`
- **Where:** `packages/core/src/client.ts:591` (`rateLimiter.tryAcquire()`, `logException` only) versus the
  detection path `client.ts:635-640` → `submitReport` (`client.ts:447`), which has no limiter.
- **What:** `captureRateLimit` (`client.ts:220-221`, default 100/60 s) is described as "capture-storm rate
  limit (§7.7)" but guards only the manual path. Every detection submission is tracked into `pendingReports`
  (`client.ts:385`) unthrottled.
- **Why it matters:** A misbehaving detector (a hang detector re-firing, a global error handler in a render
  loop) floods `pendingReports` with unbounded promises and issues unbounded upload attempts — the exact
  storm the limiter exists to prevent, on the path most likely to storm.
- **Evidence:** PROBE 13 — `captureRateLimit: { limit: 2, windowMs: 60_000 }`, then fire 50 detection
  reports: `expect(report).toHaveBeenCalledTimes(50)` passes.

## SEV3

### 10. `getCarrier` throws a `TypeError` when `globalThis.__BUGSEE__` exists and is not a writable object
- **Where:** `packages/core/src/carrier.ts:50-61` — `registry` is only checked for `undefined` (`:52`), then
  written at `:60`.
- **What:** If `__BUGSEE__` is a primitive or a frozen object, `registry[BUGSEE_SDK_VERSION] = slot` throws
  under ESM strict mode. The throw propagates out of `getCarrier` → out of `launch()`.
- **Why it matters:** Low likelihood (requires a pre-existing conflicting global), but the failure mode is
  maximal: the SDK crashes the host's startup. The null-prototype hardening one line up (`:54`) shows the
  hostile-global threat model is already in scope here; this is the same class, unhandled.
- **Evidence:** PROBE 6 — `getCarrier({__BUGSEE__: 1})` and `getCarrier({__BUGSEE__: Object.freeze({})})`
  both throw `TypeError`; clean-global control returns a slot.

### 11. `registerExt` throws on a duplicate name and the public client exposes no way to pre-check
- **Where:** `packages/core/src/extension-registry.ts:22-24` (throws) and `client.ts:492`; the
  `ExtensionRegistry` interface declares `hasExt` (`extension-registry.ts:15`) but `BugseeClient` re-exports
  only `registerExt`/`ext` (`client.ts:146-147`).
- **What:** A public API that throws, with no non-throwing probe, so callers must `try`/`catch`. There is
  also no deregistration at all — the mandate's "is deregistration idempotent" question has no
  implementation to answer.
- **Why it matters:** Bounded today because the umbrella skips extension wiring on a repeat launch
  (`packages/bugsee/src/node.ts:20`), so the throw is not reachable through the sanctioned path. It remains
  a public throwing API in an SDK whose stated rule is not to throw into the host.
- **Evidence:** PROBE 10.

### 12. `stop()` on a never-launched client reports success without draining and leaves the client live
- **Where:** `packages/core/src/client.ts:657-659`.
- **What:** Returns `Promise.resolve(true)` — "drained" — without draining, and without setting `stopped`, so
  `logException` continues to assemble and upload afterwards.
- **Why it matters:** Narrow (platform launchers always call `client.launch()`, so this needs a direct
  `createClient()` or a deferred launch), but `stop()` returning `true` while doing nothing is a state-machine
  inconsistency: `true` is documented as "drained within timeout".
- **Evidence:** PROBE 8 — `await client.stop()` is `true`, then `logException` still reaches the trigger
  pipeline (`report` called once).

### 13. `contributeServiceManifest` appends without bound and offers no removal
- **Where:** `packages/core/src/carrier.ts:92-101`; read back at `carrier.ts:104-106`.
- **What:** A process-global array that only ever grows. Under HMR / a dev server that re-initializes
  modules, each re-init appends again; re-running a duplicated manifest then throws on the second
  registration of the same service name.
- **Why it matters:** Dev-time only, and the docstring (`carrier.ts:88-91`) acknowledges the semantics.
  Noting it because it is the one carrier structure with no cleanup path.

### 14. No validation on `maxRecordingTime`
- **Where:** `packages/core/src/client.ts:293` — `(options.maxRecordingTime ?? 60) * 1000`.
- **What:** Negative and `NaN` values are accepted silently. A negative window puts every record
  out-of-window; `NaN` makes the `chunk-capture-store.ts:89-94` eviction comparison always false.
- **Evidence:** PROBE 12 — neither value throws or is clamped.

### 15. Surviving mutations and coverage gaps (test strength)
Each verified by injecting the mutation, running the file's own suite, and restoring from a `cp` backup:

- **`options.ts:52` — `Object.hasOwn(values, def.friendly)` → `(def.friendly in values)` SURVIVED**
  (16/16 pass). The `in` form walks the prototype chain, so a polluted `Object.prototype` or a
  class-instance options bag would leak inherited values into the canonical options. The revealing detail:
  the *same* mutation applied to `options.ts:12` (`createOptionsContainer`) was **CAUGHT** by
  `options.test.ts:46` ("treats only own keys as present"). The resolver simply lacks the equivalent test.
- **`environment.ts:46` — `attributes.delete(key)` → `attributes.set(key, undefined)` SURVIVED**
  (12/12 pass). `environment.test.ts:61-68` *does* assert `getAllAttributes()`, but with
  `expect(...).toEqual({ b: 2 })`, and Vitest's `toEqual` ignores keys whose value is `undefined`. So a
  regression in which `clearAttribute` stops actually deleting is invisible — while `getAllAttributes()`
  (read into every bundle at `client.ts:370`) would then still carry the cleared key. Since
  `clearAttribute` is the API for removing PII a user previously set, this matters: `toStrictEqual` at
  `environment.test.ts:67` and `:74` closes it.
- **`bugsee-api.ts:26` — `isOk` widened from `status < 300` to `status < 400` SURVIVED** (11/11 pass).
  `bugsee-api.test.ts` exercises only 200, 401 and 500 — the 2xx/3xx boundary is unpinned, so a redirect
  being treated as success is undetectable by the suite.
- **`client.ts` branch coverage is 98.4%, with lines `432` and `637` uncovered.** `client.ts:637`
  (`if (handled !== null)`) is the meaningful one: **the report-handler veto on the detection/crash path is
  never tested**. The equivalent veto on the `logException` path *is* tested. A user's
  `setReportHandler({ before: () => null })` — a PII-scrubbing / drop-this-report feature — has its
  crash-path branch unexercised. `client.ts:432` (`if (launched)` inside `enterKillState`) is the benign
  kill-while-not-launched branch.

## Lifecycle state-machine analysis

`client.ts` has three independent booleans — `launched` (`:326`), `stopped` (`:329`), `killed` (`:331`) —
plus `tickTimer` (`:333`). `launch()` and `stop()` are **fully synchronous** up to the drain, which removes
an entire class of hazards the mandate asked about.

| Transition | Verdict |
|---|---|
| `launch()` × 2 | **Correct.** `client.ts:622` returns early; no double timer, no double coordinator start. Locked by `client.test.ts:706`. |
| `launch()` → `stop()` → `launch()` | **Correct.** `stop()` nulls both coordinator sessions (`capture-coordinator.ts:79`, `detection-coordinator.ts:71`), so the "already started" throw cannot fire; `client.ts:626` resets `stopped`. Mutation M1 (dropping `stopped = false`) was **caught**. |
| `stop()` mid-`launch()` (torn state) | **Not reachable — clean.** `launch()` performs no async work: coordinators start synchronously and `tickTimer` is assigned before `launch()` returns (`client.ts:647`). There is no window in which `stop()` observes `launched === false` while a deferred init later installs handlers. This is the classic leak the mandate asked about and core is structurally immune to it. |
| Concurrent / interleaved `launch` + `stop` | **Clean** for the same reason; JS single-threaded + no `await` inside either. |
| Component throws during start | **Partially correct — SEV2 #4.** Coordinator-level isolation holds (a failing capture start still lets detection start — `client.test.ts:823`), and the client remains relaunchable. But providers *after* the thrower never start, permanently. Partially-acquired resources are released correctly: `started` (`capture-coordinator.ts:37`) holds only successfully-started providers, so `stop()` never calls `stop()` on one that never started. |
| `launch()` throws | **Broken only via `onError` — SEV1 #1.** Provider throws are contained (`client.ts:629-643`); a throwing `onError` is not. |
| Shutdown ordering / in-flight work | **Correct.** `drainPending` (`client.ts:405-413`) awaits `pendingReports` *then* `uploadPipeline.flush` — the ordering matters because a report still *assembling* has no upload enqueued yet, which `uploadPipeline.flush` alone would miss. Confirmed by `client.test.ts:1260-1297`. Nested timeouts are correctly bounded overall by the outer `Promise.race`. Two gaps: no bound when `timeout` is omitted (SEV2 #8), and `Promise.allSettled([...pendingReports])` snapshots the set, so a report submitted *during* the drain is not awaited (verified — PROBE 9: `flush()` resolved `true` with a mid-drain report still pending; bounded and arguably correct semantics, so not filed as a finding). |
| Kill-state (fatal auth error) | **Correct and well-tested.** `enterKillState` (`client.ts:426-436`) is idempotent, halts capture, and blocks relaunch (`client.ts:622`). Mutations M2/M3/M5 all **caught**. |
| Consent / `revokeConsent` / purge | **No such API exists** (verified repo-wide). The nearest affordance, `stop()`, does not stop manual capture and never purges the store — `CaptureStore.clear()` (`contracts.ts:110`) is never called by any lifecycle path. See SEV1 #2. |
| `pause`/`resume` | **No such API on the client.** |

## Untested-file adjudication

Measured directly from `coverage-summary.json` (`vitest run --coverage --coverage.reporter=json-summary`).
The default text reporter hides fully-covered files, which is why only `client.ts` appears in the console
table — every other file is at 100%.

| File | Source lines | **Executable** lines | Verdict |
|---|---|---|---|
| `contracts.ts` | 254 | **1** (1/1, 100%) | **Type-only and fine.** The single executable statement is `CaptureStoreToken = serviceToken<CaptureStore>('captureStore')` (`contracts.ts:115`); everything else is `interface`/`type`. Covered indirectly because `client.ts:27` imports the token. `contracts.test-d.ts` (233 lines) is the correct test form. No finding. |
| `services.ts` | 21 | **0** (0/0, 100%) | **Type-only and fine.** Two interfaces, one type-only import. Nothing to execute; `services.test-d.ts` is correct. No finding. |
| `index.ts` | 215 | **0** (0/0, 100%) | **Pure re-export barrel — no runtime logic**, so no *implementation* finding. But the 100% is **vacuous**: v8 records zero statements, `0/0` is reported as 100%, and no runtime test imports it (only `index.test-d.ts`). The coverage gate therefore cannot detect a broken barrel (bad path, dropped symbol, name collision) in this package. **Mitigated**, and honestly so: every downstream package resolves `@bugsee/core` to `./src/index.ts`, so a broken export breaks `@bugsee/node`/`@bugsee/browser` typecheck and tests. Residual risk is low; worth knowing the gate contributes nothing here. |

**`/* v8 ignore */` annotations:** `grep -rn 'v8 ignore' packages/core/src/` returns **zero results**. No
coverage is being suppressed anywhere in core, so the "does each ignore carry a one-line justification?"
question is moot — there are none to justify. This is a genuinely clean result.

## For later passes

Root causes outside Pass A, noted while verifying how Pass A code is used:

- **`chunk-capture-store.ts:60-69` (`enforceByteCap`)** — the `parts.length > 1` guard means a lone open
  part is never trimmed, so the byte cap provides no protection at all when `tick()` is not running. This is
  the mechanism behind SEV1 #2; the store-side half belongs to the storage pass.
- **`chunk-capture-store.ts:89-94`** — the eviction cut-off does no validation of `maxRecordingTimeMs`;
  `NaN` makes the `<` comparison permanently false (see SEV3 #14 for the client-side half).
- **Capture recovery + post-stop entries** — on Node the store is file-backed by default, so entries written
  after `stop()` (SEV1 #2) are durable and may be picked up by `capture-recovery.ts` on the next launch.
  Worth confirming in the recovery pass.
- **`packages/vercel-edge/src/launch.ts:195` / `packages/cloudflare/src/launch.ts`** — neither passes the
  no-op scheduler that `client.ts:78-79` requires of edge runtimes (SEV2 #7). Cross-package, not core-internal.
- **`upload-pipeline.ts:46`** uses a raw `globalThis.setTimeout` with no `unref`, unlike `client.ts:107-111`
  which unrefs its deadline timer. Possible process-liveness asymmetry for the upload pass to confirm.

## Checked and found clean

- **Mutation resistance is real, not claimed.** 8/8 mutations on `client.ts` were caught by
  `client.test.ts`: dropping `stopped = false` in `launch()`; disabling fatal-error detection; removing
  kill-state idempotence; collapsing `drainPending`'s timeout race; letting a killed client relaunch;
  changing `MAX_CAUSE_DEPTH`; skipping `haltCapture()` in `stop()`; disabling instance dedup. 20/23 caught
  across all Pass A files. The 1461 test lines translate into defect detection, not setup boilerplate.
- **Assertions reach effects, not flags.** `client.test.ts:1396-1460` asserts the scheduler handle was
  installed, the interval value, that `tick` was called with the *injected clock's* value, and that the
  handle was cleared on `stop()` — including a real-timer variant proving the tick stops. `client.test.ts:1306`
  installs a live `process.on('unhandledRejection')` watcher specifically to prove `track` uses
  `.then(forget, forget)` rather than `.finally` (whose discarded derived promise would re-raise). That is
  the opposite of theater.
- **Runtime portability holds.** No `node:*` import and no unconditional DOM reference anywhere in core.
  Every runtime-global access is a guarded cast: `client.ts:90`, `client.ts:105`, `clock.ts:26`,
  `debug-id.ts:61`, `crash.ts:130`, `streaming-capture-store.ts:44`, `upload-pipeline.ts:46`. `clock.ts:27`
  correctly feature-detects both `performance.now` *and* `performance.timeOrigin` before use, with a
  `Date.now()` fallback — and both halves are mutation-covered.
- **Prototype-pollution hardening is real and locked by tests.** `environment.ts:27` (Map-backed attributes)
  and `:55` (`Object.fromEntries`), `carrier.ts:54` (`Object.create(null)` registry). Mutating
  `Object.create(null)` → `{}` and `Object.fromEntries` → manual assignment were both **caught**.
- **The intra-version carrier dedup works.** Mutating the interceptor cache to always re-create was caught
  (2 failures), as was ignoring the version key (13 failures). The duplicate-module hazard the carrier
  actually exists to neutralize *is* neutralized — only the cross-*version* namespacing is inert (SEV2 #3).
- **`dedup.ts:20-29`** handles frozen/sealed/non-extensible errors correctly via `try`/`catch` around
  `Object.defineProperty`, and correctly rejects primitives at `:13`. `client.logException(Object.freeze(e))`
  does not throw — a plausible SEV1 that is genuinely handled.
- **`describeError` (`client.ts:119-132`)** bounds the `cause` chain at depth 5 and uses a `seen` set, so a
  cyclic `cause` cannot loop. Both properties are tested (`client.test.ts:903`, `:915`) and the depth
  mutation was caught.
- **Report request-context capture (`client.ts:314`, `:451-454`)** uses a `WeakMap` keyed on the request, so
  entries are collected with the request — no manual cleanup, no leak. The submit-time vs assembly-time
  distinction (capturing the async context *before* the trigger pipeline detaches) is correct and tested
  (`client.test.ts:136`).
- **`pendingReports` cleanup** removes on both settle paths (`client.ts:391-400`), so the set does not grow
  across normal operation.
- **`sleep` (`client.ts:107-111`)** and `defaultScheduler` (`:99`) both `unref?.()` their handles, so on Node
  neither the deadline timer nor the tick timer keeps a CLI process alive. Correct and deliberate.
- **`bugsee-api.ts`** memoizes the access token and exposes `invalidateSession` for the 401-retry path;
  removing the memoization was caught. `errors.ts` `fatal` defaults to `false` and the mutation was caught.
- **Core has no logger dependency** — confirmed; the only diagnostic path is the `onError` seam (whose
  robustness is SEV1 #1, but whose *architecture* is as designed).
- **`pnpm --filter @bugsee/core exec tsc --noEmit`** passes; full suite **683 tests / 46 files green**;
  `git status --short packages/` empty at start and at finish.
