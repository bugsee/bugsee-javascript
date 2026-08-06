# Adversarial review — @bugsee/node, Pass A (launch / composition / environment / detection)

**Reviewed:** 2026-07-26 · **Scope:** `packages/node/src/launch.ts` (855 impl / 2000 test), `index.ts` (93, no test), `options.ts` (31 / 22), `environment.ts` (96 / 136), `detection-providers.ts` (104 / 153). Read-only; upstream (`core`, `node-utils`, `capture`, `system-events`, `liveness-heartbeat`, `instance-layout`) read only to verify wiring.

**Verdict:** The composition root is well-built where it was designed deliberately — the singleton guard, the degrade-to-memory path, the server-instrumentation partial-install rollback, and the crash flush-before-exit ordering are all real and tested, and the privacy posture is genuinely good (the environment envelope is pinned by assertion and carries no argv/env/cwd/hostname; the options resolver structurally cannot leak undeclared keys to the wire). All SDK timers are `unref`'d, so the "CLI never exits" SEV1 class does **not** apply here. What is wrong is concentrated in **process-lifecycle policy**, and it is serious. The SDK installs an `unhandledRejection` listener by default that silently converts a would-be process crash into a clean `exit 0` with no opt-out and no emulation of the default behavior; the `uncaughtException` handler suppresses Node's default stderr crash print and lets the doomed process keep executing for up to 3 s; and the flush-on-exit hook is bound to `'exit'`, which — empirically — never fires on SIGTERM/SIGINT/SIGHUP, so the single most common production shutdown path loses up to a second of capture including the shutdown event itself. Separately, three eager filesystem writes sit **outside** the very guard whose comment promises the SDK "must NEVER crash the host app" — I reproduced `launch()` throwing `EEXIST` into the caller with `onError` never invoked. Test quality is above average in the areas the author thought about (ordering assertions, listener counts, exact envelope matching) but has a blind spot exactly where the SEV1s live: `unhandledRejection` appears **zero** times in 2000 lines of `launch.test.ts`, and deleting its entire registration passes the suite.

## SEV1

### 1. The default `unhandledRejection` listener suppresses Node's process crash — no opt-out, no emulation
- **Where:** `packages/node/src/launch.ts:636` (`client.addDetectionProvider(createUnhandledRejectionProvider(proc))`); listener installed at `packages/node/src/detection-providers.ts:48`; gate `packages/node/src/detection-providers.ts:79` (`controllingOption = BugseeOption.DetectCrash`, default `true` via `packages/core/src/options.ts:78`).
- **What:** Registering *any* `unhandledRejection` listener disables Node's default `--unhandled-rejections=throw` disposition. The provider (`detection-providers.ts:82-93`) only submits a report — it never re-raises, never exits, and never warns.
- **Why it matters:** A Node service that would have crashed and been restarted by systemd/k8s/pm2 now continues running in an indeterminate state, and its exit code flips from 1 to 0 so supervisors, CI, and health checks read success. This is the textbook "alters host behavior" violation. It is on by default, and it cannot be turned off independently: both providers share `controllingOption = BugseeOption.DetectCrash` (`detection-providers.ts:60` and `:79`), so `detectCrashes: false` is an all-or-nothing switch that also discards uncaught-exception crash reporting. Peer SDKs treat this as requiring an explicit policy knob (Sentry's `onUnhandledRejection` has `mode: 'none' | 'warn' | 'strict'`); the code comment at `detection-providers.ts:11-12` claims the "warn, stay alive" behavior but **nothing warns** — there is no logger sink (see verdict below), so the event is silent.
- **Evidence:** Empirical, Node v24.15.0:
  ```
  with listener:    "SDK saw rejection" / "STILL ALIVE 200ms later" / exit=0
  control (none):   stack printed to stderr                          / exit=1
  ```
- **Blast radius:** `@bugsee/bun` and `@bugsee/deno` re-export this composition verbatim (`packages/bun/src/launch.ts:21`, `packages/deno/src/launch.ts:23`), so all three runtimes inherit it.

### 2. Three eager filesystem writes sit outside the degrade-to-memory guard and throw out of `launch()`
- **Where:** guard is `packages/node/src/launch.ts:414-431` (covers only `ensureSecureDataRoot` at `:419` and `writeInstanceOwner` at `:424`). Unguarded eager writes: `packages/node/src/launch.ts:438` (`createNodeBundleStore` → `packages/node-utils/src/bundle-store.ts:14 ensureDir`), `packages/node/src/launch.ts:499` (`createBatchedFsChunkStorage` → `packages/node-utils/src/batched-fs-chunk-storage.ts:108 ensure(root)`), `packages/node/src/launch.ts:511` (`createNodeReportMarkerStore` → `packages/node-utils/src/report-marker-store.ts:17 ensureDir`).
- **What / Why it matters:** `launch.ts:422-423` states the contract explicitly — *"an observability SDK must NEVER crash the host app: report it and DEGRADE this launch to in-memory capture"* — and the guard implements it correctly for the first write only. The next three eager `mkdir`s are outside the `try`, so any `EEXIST` / `ENOSPC` / `EROFS` / `EACCES` / quota failure on the instance subtree propagates straight out of `launch()` into the host's startup path, killing the application before it starts. `onError` is never called, so the failure is not even observable.
- **Evidence:** Reproduced against the real `launch()` (scratchpad only; artifacts removed). Pinned `instanceIdentity`, explicit `dataDir`, one squatter file per run:
  ```
  GUARDED-write1-owner.json    -> threw:NO (degraded)  onError-calls:1   <- guard works
  pending(bundleStore:438)     -> threw:YES EEXIST     onError-calls:0
  capture(chunkStorage:499)    -> threw:YES EEXIST     onError-calls:0
  incidents(markers:511)       -> threw:YES EEXIST     onError-calls:0
  ```
- **Mitigating detail (do not over-rate):** all three throws occur *before* `createClient` (`:548`) and before any global is patched, so this is a clean host crash, not a torn/partially-patched state.

### 3. SIGTERM / SIGINT / SIGHUP lose up to `CAPTURE_FLUSH_MS` of capture — the flush-on-exit hook never runs
- **Where:** `packages/node/src/launch.ts:765-775` installs the flush **only** on `'exit'`; cadence constant `packages/node/src/launch.ts:107` (`CAPTURE_FLUSH_MS = 1000`).
- **What:** Node's `'exit'` event does not fire when the process is terminated by a signal under its default disposition. The batched writer's un-`flushSync`'d buffer is therefore discarded on every signal-driven shutdown.
- **Why it matters:** SIGTERM is the normal shutdown path for Kubernetes, Docker, systemd, and every process supervisor — i.e. the *most common* termination in production, not an edge case. Up to one second of capture is lost each time. Worse, the SDK's own `process_signal` capture entry is emitted synchronously and then dies in the buffer with everything else, so the recording cannot even explain why it ends.
- **Evidence:** Empirical, Node v24.15.0:
  ```
  SIGTERM -> exit=143  exit-handler: DID NOT RUN
  SIGINT  -> exit=130  exit-handler: DID NOT RUN
  SIGHUP  -> exit=129  exit-handler: DID NOT RUN
  ```
  And with the `system-events.ts` observe-then-re-raise handler installed, `'exit'` still does not run (`SDK-OBSERVED-SIGNAL` written, `EXIT-HANDLER-RAN` absent, exit=143).
- **Note on the stated rationale:** `launch.ts:762-764` justifies the `'exit'`-only choice by saying a SIGTERM handler *"would swallow the signal"*. The codebase itself disproves this — `packages/node/src/system-events.ts` already installs SIGTERM/SIGINT handlers and preserves default termination via the `listenerCount(signal) === 1` → remove-self → re-raise trick. The safe pattern exists in-tree; it is simply not applied to flushing.

### 4. The `uncaughtException` handler suppresses the default crash output and keeps a fatally-broken process running
- **Where:** `packages/node/src/launch.ts:741-757`; budget `packages/node/src/launch.ts:103` (`DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000`), applied at `:749`.
- **What:** Installing a listener suppresses Node's default handler, which prints the error and stack to stderr. Nothing in the SDK re-prints it (there is no logger sink — see verdict). `process.exit(1)` is deferred until `client.flush(3000)` settles, during which the event loop keeps running: timers fire, I/O callbacks run, and host code continues executing after a fatal error.
- **Why it matters:** Operators lose the crash stack from their stdout/stderr log pipeline — the primary artifact they reach for first. And the host runs post-mortem business logic for up to 3 s, which for a corrupted process can mean writes committed after the invariant broke.
- **Evidence:** Empirical, Node v24.15.0. With the handler, stderr printed nothing and:
  ```
  HOST CODE RAN *AFTER* THE FATAL THROW (t=50ms)
  HOST CODE RAN AT t=100ms TOO
  exit=1
  ```
  Control (no listener): stack printed to stderr, no host code ran, exit=1.
- **Correctly preserved:** exit code 1 matches Node's default. `exitOnUncaught: false` (`:740`) turns even that off — documented, but it makes the SDK fully swallow a fatal crash.

## SEV2

### 5. No validation of option values — hostile or typo'd numerics reach timers and byte caps
- **Where:** `packages/core/src/options.ts:52` assigns the raw user value with no type/range check; consumed at `packages/node/src/launch.ts:475` (`maxRecordingTime * 1000`), `:476` (`maxDataSize * 1024 * 1024`), `:575` (`rollingIntervalMs: maxRecordingTime * 1000`), `:572`, `:640-642`.
- **What / Why it matters:** `maxRecordingTime: '60'` (a string, e.g. straight from `process.env`) yields `NaN`. Verified: `setInterval(fn, NaN)` is coerced by Node to **1 ms**, so with `profiling: true` the rolling CPU-profile collect fires ~1000×/s instead of once per recording window — an SDK-induced CPU burn from a single typo'd option. `maxDataSize: -1` yields a negative byte cap (`-1048576`). Neither is rejected, clamped, or reported.
- **Evidence:** `node -e` — `setInterval(fn, NaN)` → `TimeoutNaNWarning: Timeout duration was set to 1`; 50 ticks in 56 ms. `'abc' * 1000 === NaN`; `-1 * 1024 * 1024 === -1048576`.
- **Test gap:** `options.test.ts` is 22 lines and asserts only that the two profiling constants have the expected literal strings/defaults. It exercises no resolution, no precedence, no coercion, and no hostile input. There is no env-var precedence layer at all (options are code-only), so that dimension is moot.

### 6. One throwing capture provider strands every provider registered after it
- **Where:** `packages/core/src/capture-coordinator.ts:42` starts providers in a bare loop (documented at `:10` — *"a throwing provider.start propagates"*); `packages/core/src/client.ts:629-633` catches only at the **coordinator** level. Registration order is fixed by `packages/node/src/launch.ts:596` (log), `:611` (network), `:624` (system traces), `:630` (system events).
- **What / Why it matters:** A single failure in the console/log provider's `start()` aborts the loop, so network, system-traces, and system-events capture never start — one broken source silently costs three others. `client.launch()` itself stays safe (the error goes to `onError`), so the client looks healthy while three-quarters of capture is missing. This compounds with the known `InterceptorBase` defect (`packages/core/src/interceptor-base.ts:46-48` sets `#active` before `onActivate()`): an interceptor whose `onActivate` throws is both permanently dead *and* the trigger that strands its siblings.
- **Root cause is core**, but the blast radius is decided by launch.ts's fixed ordering — flagged here for that reason.

### 7. `os.machine()` requires Node ≥ 18.9, but the package declares `engines: ">=18"`
- **Where:** `packages/node/src/environment.ts:36` (`machine: () => os.machine()`); `packages/node/package.json:29` (`"node": ">=18"`).
- **What / Why it matters:** `os.machine()` landed in Node v18.9.0 / v16.18.0. On Node 18.0.0–18.8.x — inside the declared supported range — it is `undefined`, so `realSystemProbe.machine()` throws `TypeError`, taking `buildNodeEnvironment` with it. `getEnvironment` is lazy (`launch.ts:456`, called at report/session assembly), so this does not break `launch()`, but it breaks session creation and every report on a runtime the package claims to support.
- **Evidence:** verified present on node v24.15.0, **bun 1.3.14**, and **deno 2.8.3** — so Bun/Deno are fine; the gap is strictly the Node 18.0–18.8 window. The declared floor should be `>=18.9` (or the probe should fall back).

## SEV3

### 8. Surviving mutations — four behaviors are executed but never asserted
Harness: mutate → `pnpm --filter @bugsee/node exec vitest run src/{launch,options,environment,detection-providers}.test.ts` → restore from `cp` backup. Baseline **109 passed**. Control mutation (breaking the crash-handler registration) correctly produced **3 failures**, so the harness detects.

| id | mutation | file:line | result |
|---|---|---|---|
| M3 | delete `chunkStorage?.flushSync?.()` from the uncaught handler | `launch.ts:744-748` | **109 passed — SURVIVED** |
| M5 | delete `heartbeat?.stop()` from `stop()` | `launch.ts:821` | **109 passed — SURVIVED** |
| M6 | delete `profilingController?.stop()` from `stop()` | `launch.ts:820` | **109 passed — SURVIVED** |
| M11 | delete the whole `unhandledRejection` provider registration | `launch.ts:636` | **109 passed — SURVIVED** |

M3 is the crash-durability guarantee the comment at `launch.ts:742-743` sells ("a catchable crash loses nothing") — unasserted. M5 leaves a dead instance's `.live` heartbeat advancing forever after `stop()`, so peers never reclaim its subtree. M6 leaves the V8 CPU profiler sampling after `stop()`. M11 is the most damning: 2000 lines of `launch.test.ts` contain **zero** occurrences of `unhandledRejection`, so the SEV1 above has no test that would have prompted the design question.

*Caught correctly* (for calibration): dropping `proc.on('exit')` → 3 failures; dropping `proc.off('exit')` → 1; dropping the flush-timer `clearInterval` → 1; flipping the `exitOnUncaught` default → 1; `shutdownTimeoutMs` 3000→0 → 1; `CAPTURE_FLUSH_MS` 1000→3.6e6 → 1; `maxDataSize` 50→5000 → 1; skipping `install()` → 7; dropping `durable.recover()` → 1; detection `off()` removal → 4; crash mechanism swap → 1; `device_id` default change → 1; **injecting `process.argv` into the envelope → 2** (the privacy shape is genuinely pinned).

### 9. Untested keywords in `launch.test.ts` (2000 lines) — the coverage is real but the aim is off
`unhandledRejection` 0 · `SIGTERM` 0 · `SIGINT` 0 · `signal` 0 · `shutdownTimeoutMs` 0. The suite is **not** test theater in the usual sense — it asserts real ordering (`launch.test.ts:551` `expect(order).toEqual(['put','exit'])`), real listener counts (`:563`, `:581`, `:583`), and exact wire envelopes (`:621-625`) — but it verifies the paths the author designed and none of the process-lifecycle policy paths where the SEV1s live.

### 10. `void client.flush(...).finally(...)` re-raises a rejection as unhandled
- **Where:** `packages/node/src/launch.ts:749`.
- **What:** `p.finally(fn)` returns a promise that rejects with `p`'s reason; `void` attaches no handler. Verified empirically: the pattern surfaces `!!! UNHANDLED REJECTION SURFACED` while still running the `finally` branch.
- **Why only SEV3:** I traced reachability and **`client.flush()` cannot currently reject** — `packages/core/src/client.ts:406-412` and `packages/core/src/upload-pipeline.ts:192-201` are `Promise.allSettled`/`race(sleep)` chains, and `durable-upload-pipeline.ts:143-145` merely delegates. So this is latent, not live. It is still worth fixing because core explicitly documents avoiding this exact construct for this exact reason (`packages/core/src/client.ts:388-390`), and because the site is *inside the uncaughtException handler*, where an unhandled rejection would be caught by the SDK's own `unhandledRejection` listener and turned into another report mid-crash.

### 11. Launch options that never reach `environment.sdk.options` — support cannot see the active configuration
- **Where:** `NODE_OPTION_DEFINITIONS` at `packages/node/src/launch.ts:117-127`; the omitted options are read raw at `:443`/`:508` (`recover`), `:740` (`exitOnUncaught`), `:739` (`shutdownTimeoutMs`), `:784` (`instrumentIncomingRequests`), `:492` (`captureWriter`), `:616` (`propagateTrace`), plus `capturedDataStore`, `traceResponse`.
- **Why it matters:** Only declared definitions land in `resolved.canonical` (`packages/core/src/options.ts:50-53`). A support engineer holding a bundle cannot tell whether disk capture, durable recovery, incoming-server instrumentation, trace propagation, or crash-exit were active — all of which change how the bundle should be read.

### 12. `isEnabled` treats every non-`false` value as enabled
- **Where:** `packages/core/src/options.ts:57` — `(key) => canonical[key] !== false`.
- **What:** `detectCrashes: 0`, `detectCrashes: 'false'`, and `detectCrashes: null` all **enable** crash detection. Given that `detectCrashes` is the only switch controlling the SEV1 `unhandledRejection` listener, a user who "turned it off" with a falsy-but-not-`false` value gets the opposite of their intent, silently.

### 13. Dead dependency: `@bugsee/integration-shims`
- **Where:** `packages/node/package.json:32`. Verified: zero imports anywhere in `packages/node/src/`. (Also declared-but-unimported by `browser` and `vercel-edge`.) `@bugsee/performance` at `packages/node/package.json:34` is *not* dead — it is a legitimate `import type` in `server-instrument.ts:3` (Pass B).

### 14. `SDK_VERSION` is a hardcoded `'0.0.0'`
- **Where:** `packages/node/src/launch.ts:101`, surfaced as `sdk.version` via `environment.ts:90` and in the user-agent. The `sdkVersion` option doc at `launch.ts:138` says "Default the package version", but nothing reads `package.json`. Every bundle from a released build will report `0.0.0` unless the release pipeline rewrites this constant.

### 15. `index.ts` has no test file — adjudicated **defensible barrel**, with one caveat
93 lines, every one a re-export; no logic, no side effects (`"sideEffects": false`). It passes the 100% gate **vacuously, not by being tested**: no test in the package imports `./index` (verified), and under the ESM transform a pure `export … from` barrel emits no executable statements, so v8 records `0/0` and cannot lower the ratio. Package coverage is `100% stmts / 98.48% branch / 100% funcs / 100% lines` (994 stmts, 967 lines) and the gate holds. Caveat: nothing in this package fails if an export is dropped from the barrel; the partial safety net is `tsc --noEmit` plus `@bugsee/bun` / `@bugsee/deno` / `@bugsee/electron`, which import `@bugsee/node` and would break on symbols *they* consume — symbols nothing else consumes are unprotected.

## Process-handler audit

| handler | installed? | host behavior preserved? | removed on stop? | file:line |
|---|---|---|---|---|
| `uncaughtException` | YES ×2 (detection provider + launch's flush/exit), when `detectCrashes` (default on) | **PARTIAL** — exit code 1 kept; default stderr stack print LOST; host keeps running up to 3 s | YES (`launch.ts:815` + provider `onStop`) | `launch.ts:756`, `detection-providers.ts:48` |
| `unhandledRejection` | YES, default on | **NO** — default crash fully suppressed; exit 1 → 0 | YES (`detection-providers.ts:52`) | `launch.ts:636` |
| `exit` | YES, only when the batched writer is in use | YES (sync work only, never alters exit) | YES (`launch.ts:818`) | `launch.ts:774` |
| `beforeExit` | YES, via the system-events source | YES (observe-only) | YES (`onDeactivate`) | `system-events.ts` `onActivate` |
| `SIGTERM` | YES, via the system-events source | YES — `listenerCount === 1` → remove self → re-raise | YES (`onDeactivate`) | `system-events.ts` (`DEFAULT_SIGNALS`) |
| `SIGINT` | YES, via the system-events source | YES — same re-raise path | YES (`onDeactivate`) | `system-events.ts` |
| `SIGHUP` | NO | YES (default disposition untouched) | n/a | — |
| `warning` | YES, via the system-events source | YES (observe-only) | YES (`onDeactivate`) | `system-events.ts` `onActivate` |

## Exit-path flush matrix

| termination | `'exit'` fires? | capture flushed? | verdict |
|---|---|---|---|
| clean event-loop drain | YES | YES (`launch.ts:774` → `flushSync`) | **no loss** |
| explicit `process.exit()` | YES | YES | **no loss** |
| `uncaughtException` (default) | YES (after `proc.exit(1)`) | YES ×2 — `flushSync` at `:745`, then `flush(3000)`, then the `'exit'` hook | **no loss** |
| **SIGTERM** | **NO** | **NO** | **up to 1 s LOST** (exit 143) |
| **SIGINT** | **NO** | **NO** | **up to 1 s LOST** (exit 130) |
| **SIGHUP** | **NO** | **NO** | **up to 1 s LOST** (exit 129) |
| SIGKILL / OOM | NO | NO | up to 1 s lost — uncatchable, by design |
| unhandled rejection | n/a | n/a | **process does not terminate at all** (SEV1 #1) |

## Logger-sink wiring verdict

**Definitive: `@bugsee/node` registers no logger sink and has no logger at all.** A grep for `@bugsee/logger` / `warnOnce` / `setLogSink` / `registerLogSink` across `packages/node/src/` **and** `packages/node/package.json` returns **zero hits** — it is not even a declared dependency. The sole internal-error channel is the caller-supplied `options.onError`, invoked exclusively through optional chaining (`launch.ts:363`, `:426`, `:674`, `:803`, and elsewhere), so when the host omits `onError` — the default — every internal failure is discarded silently: the double-launch warning (`:363-368`), the degrade-to-memory event (`:426`), capture-flush failures (`:674`), and instrumentation-install failures (`:803`).

The ordering question ("in what order relative to the first `warnOnce`") is therefore **moot for this platform**: no sink is ever registered, at any point, so no ordering exists. The `docs/PROGRESS.md` claim that platforms wire `onError` to the logger is **false for `@bugsee/node`**.

## Upstream-defect blast radius

- **`InterceptorBase` `#active` before `onActivate()`** (`packages/core/src/interceptor-base.ts:46-48`) — **APPLICABLE.** `launch()` installs four interceptors that patch globals: console (`:591`), node-http (`:600`), the network leaves (`:605`), and the system-events source (`:630`). The last is the most exposed: `system-events.ts onActivate` calls `this.emit('event', {name:'process_started'})` **before** registering its `exit`/`beforeExit`/`warning`/signal listeners, so a throwing subscriber leaves the source marked active with **no** listeners registered — permanently blind to every process lifecycle event, including the signal capture. Compounds with SEV2 #6.
- **`runFilter` falsy-return** — **NOT APPLICABLE.** Pass A sets no filters; `launch.ts` never calls `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`/`setReportHandler`.
- **`getImmediate({optional:true})` rethrow** — **NOT APPLICABLE.** The only use is `launch.ts:388`, non-optional, over the trivial factory at `:384` (`() => internalTagged(options.transport ?? httpRequest)`), which cannot throw.
- **`@bugsee/performance` browser single-slot `getActiveSpan`** — **OUT OF SCOPE / neither enabled nor mitigated here.** `launch.ts` does not wire `@bugsee/performance`; the package's only reference is `import type` in `server-instrument.ts:3` (Pass B). The umbrella owns that wiring. Belongs to Pass B or the umbrella review.
- **`@bugsee/integration-shims` dead dep** — **CONFIRMED for this package**: declared at `packages/node/package.json:32`, imported nowhere in `packages/node/src/`. (SEV3 #13.)
- **node-utils batched writer answers ENOSPC with unbounded memory growth** — **APPLICABLE BY DEFAULT.** `launch.ts:499` selects `createBatchedFsChunkStorage` as the default write path whenever disk capture is on, which is the default on node/bun/deno. Fix belongs to node-utils (Pass C), but every default Node launch carries it.
- **node-utils flush-on-exit does not run on SIGTERM** — **CONFIRMED, and it is `launch.ts`'s responsibility**, since `launch.ts:765-775` owns the process-signal wiring. Escalated to SEV1 #3.

## Bun/Deno compatibility risks

- **`os.machine()`** (`environment.ts:36`) — verified present on **bun 1.3.14** and **deno 2.8.3**; the only gap is Node 18.0–18.8 (SEV2 #7). Bun/Deno override only `platformType`/`runtimeVersion` (`packages/bun/src/environment.ts:20-22`, `packages/deno/src/environment.ts:23-25`) and spread `realSystemProbe` for everything else, so any future probe addition inherits the same exposure.
- **`worker_threads`** (`launch.ts:493` → `createWorkerThreadRingWorker`) — **clean.** `packages/node-utils/src/worker-ring-worker.ts:123` falls back to an on-thread sync worker when `worker_threads` is unavailable, and `:126`/`:160` `unref` the worker and its timer.
- **Signal semantics** — the re-raise at `system-events.ts` uses `process.kill(process.pid, signal)`. Its `SignalControl` default reads the **real** `process` even when a fake `proc` is injected (documented at the option), which is correct in production but means the re-raise path is only exercised through the injected seam in tests.

## For later passes

- **Pass B** — `@bugsee/performance`'s single-slot `getActiveSpan` leaking into Node: `server-instrument.ts` is the consumer; verify per-request span attribution there.
- **Pass B** — `launch.ts:784-805` wraps `install()` in a try/catch that, on failure, calls `uninstall()` on **all** installables including ones that never installed, and leaves `serverInstallables` populated so `stop()` (`:826-828`) uninstalls a second time. `launch.test.ts:1958` asserts stop idempotency, but the *failed-install* → *later stop* double-uninstall sequence is not covered; confirm `HttpServerInterceptor.uninstall()` is idempotent from the never-installed state.
- **Pass C** — `node-utils` batched writer ENOSPC unbounded buffering (reached by default via `launch.ts:499`).
- **Pass C** — `profiling-controller.ts:45` does `void profiler.start()`; confirm `CpuProfiler.start()` cannot reject (its doc contract says it no-ops on inspector failure, but the `void` discards a rejection either way).
- **Pass C** — `liveness-heartbeat.ts` runs on the main-thread scheduler; already noted in-file as a deferred hardening.

## Checked and found clean

- **Privacy / PII in the environment envelope** — `environment.ts:67-95` emits only OS type/release/machine, CPU count, total memory, UTC offset, locale, runtime version, and caller-supplied app metadata. **No** `process.argv`, `process.env`, `cwd`, hostname, username, or user paths. Verified twice: by reading, and by mutation — injecting `process.argv` into the envelope fails 2 tests, so the shape is genuinely pinned by assertion.
- **Options resolver cannot leak injectable seams to the wire** — `packages/core/src/options.ts:50-53` builds `canonical` strictly from declared definitions, so `transport`, `carrier`, `bundleStore`, `dataDir`, `process`, and `captureStore` structurally cannot reach `environment.sdk.options`.
- **The SDK never keeps a Node process alive** — the default scheduler `unref`s every interval (`packages/core/src/client.ts:94-100`), as do the ring worker and its timer (`worker-ring-worker.ts:126`, `:160`). The capture-flush interval (`launch.ts:670`), the heartbeat (`liveness-heartbeat.ts`), the profiler tick, and the core capture tick all route through it. No SEV1 process-hang.
- **Double `launch()` / launch-after-`stop()`** — guarded at `launch.ts:361-369`, released at `:829`; tested at `launch.test.ts:662` (returns the same client, builds nothing new) and `:678` (a post-`stop` launch builds fresh). *Concurrent* launches are not a concern: `launchCore` is fully synchronous end-to-end.
- **`{...client}` spread at `launch.ts:812`** — safe. `createClient` returns a plain object literal (`packages/core/src/client.ts:489`) with no getters, setters, `defineProperty`, or prototype methods, so nothing is lost or snapshotted by the spread.
- **`chunkStorage.dispose()` before `stopCore()`** (`launch.ts:825` → `:830`) — investigated as a suspected data-loss ordering bug and **cleared**: `closePath` flushes before closing (`batched-fs-chunk-storage.ts:140`), and both `read()` and `append()` are fd-independent (`append` lazily reopens at `:167`). A mutation swapping the order passes, but the order genuinely does not matter. Not a finding.
- **`client.launch()` never throws** — `packages/core/src/client.ts:629-643` wraps both coordinator starts and routes to `onError` (the per-provider granularity gap is SEV2 #6).
- **Server-instrumentation partial-install rollback** — present at `launch.ts:793-804` and well covered (removing `install()` fails 7 tests).
- **`recoverInstances`** — `packages/node/src/recover-instances.ts:157-163` is internally guarded (4 `try` blocks); the `void`'d promise at `launch.ts:721` will not surface an unhandled rejection.
- **`sweepAgedInstances`** — internally guarded (`sweep-instances.ts:52`, `:63`).
- **Coverage gate** — `100% stmts / 98.48% branch / 100% funcs / 100% lines` (994 stmts, 967 lines, 233 funcs). `options.ts`, `environment.ts`, and `detection-providers.ts` are at 100% on every axis including branch; `launch.ts` is at 98.19% branch (uncovered: `:497`, `:532`, `:570`).
- **Repo left untouched** — all mutations restored from `cp` backups (byte-identical, verified with `cmp`); `git status --short packages/` is empty. All experiments ran in the scratchpad and were deleted.
