# Adversarial review — @bugsee/bun + @bugsee/deno

**Reviewed:** 2026-07-26 · **Scope:** `packages/bun`, `packages/deno`
**Real-runtime availability:** **bun 1.3.14** and **deno 2.8.3** are both installed and every behavioural
claim below was executed on the REAL runtime (node baseline v24.15.0 via `tsx`). Probes imported the real
package source by absolute path (so its own bare imports resolve through pnpm's `node_modules`), launched the
real SDK against a mock collector bound to `127.0.0.1` on an ephemeral port, and wrote only under the
scratchpad. Not verified on a real runtime: Bun 1.1.x and Deno 2.0.x (not installed; `bun upgrade` /
`deno upgrade` would mutate the user's toolchain) — see *Version-floor assessment*.

**Verdict:** The prior is **correct about the code and wrong about the outcome**. Both packages are exactly
what they claim structurally — `export * from '@bugsee/node'` plus a runtime-identity probe, a guarded
sampler default, and a native serve wrap — and the parts I could exercise work genuinely well: the identity
probes are right on the wire, the `Bun.serve`/`Deno.serve` wraps and the `node:http` emit patch both produce
**12 distinct, correctly-attributed request contexts under 12-way concurrency with zero cross-talk**, ANR
reports fire end-to-end on both runtimes with the correct `platform.type`, CPU profiling produces valid
`.cpuprofile` data on both, and the liveness primitive matches node exactly when it is permitted to run.
Two of the six inherited node defects behave **better** here: the watchdog does **not** pin the process on
Bun or Deno (node does), and the `openServerContext` stale-context leak does not reproduce on Deno. What is
wrong is concentrated in three places, and each is severe. First, the **documented install path defeats both
packages entirely**: `@bugsee/bugsee` — which every backend adapter, including the Bun-first `@bugsee/elysia`,
re-exports — has no `bun`/`deno` exports condition, so on Bun and Deno it resolves to the Node composition and
I captured `platform.type: "node"` with the node-compat version on the wire, with no native serve wrap and no
guarded sampler. Second, **Deno's permission model is not actually handled**: `deno run --allow-net server.ts`
makes `launch()` throw `NotCapable` straight into the host app, and without `--allow-run` (undocumented,
rarely granted) `pidAlive()` returns **false for every live process**, inverting the multi-instance liveness
gate so a peer treats live siblings as dead. Third, the guarded `perf_hooks` sampler guards against the wrong
failure: Bun and Deno do not *throw*, they return **fabricated healthy numbers** — after 600 ms of deliberate
event-loop stalling Deno reported 0.004 ms of lag (node: 131.8 ms) and event-loop utilization is a permanent
`0` on both. Test quality is respectable for what it covers (14 of 16 targeted mutations caught, control
included) but has a precise blind spot: the guarded-sampler default and the `serverInstrumentations`
concatenation can both be deleted outright with every test still passing, and the real-runtime e2e runs Deno
with `-A`, which is exactly why none of the permission defects were ever seen.

---

## SEV1

### 1. The umbrella `@bugsee/bugsee` resolves to the NODE composition on Bun and Deno — both packages are bypassed on the documented install path

- **Package:** both
- **Where:** `packages/bugsee/package.json:10-29` (the `exports` map offers only `browser` / `node` /
  `default` — there is no `bun` or `deno` condition); `packages/bugsee/src/index.node.ts:13` →
  `packages/bugsee/src/node.ts:1` (`import … from '@bugsee/node'`); the intent is stated at
  `packages/bugsee/src/wire.ts:163` — *"node/bun/deno all run the node umbrella entry"*. Consumers:
  `packages/elysia/src/index.ts:7` and `packages/hono/src/index.ts:7`
  (`export * from '@bugsee/bugsee/node'`), and the same line in the other five backend adapters.
- **What / Why it matters:** Bun resolves the `node` condition (it has no `bun` entry to prefer) and Deno's
  npm compatibility does the same. A user who follows the single-install story — `@bugsee/bugsee`, or any
  backend adapter — gets `@bugsee/node` on Bun and Deno. Three documented behaviours silently disappear:
  the runtime identity, the native `Bun.serve`/`Deno.serve` wrap (so an idiomatic `Bun.serve({fetch})` or
  `Deno.serve(handler)` app gets **zero** incoming instrumentation — no per-request context, no
  `http.server` transaction), and the guarded `perf_hooks` sampler. This is worst precisely where it matters
  most: **Elysia is a Bun-first framework**, and `@bugsee/elysia` binds the Node composition on Bun.
- **Evidence (real runtimes, session envelope captured at the mock collector):**

  | import | runtime | `environment.platform` on the wire |
  |---|---|---|
  | `@bugsee/bugsee` | bun 1.3.14 | `{"type":"node","version":"24.3.0"}` ← Bun's node-compat version |
  | `@bugsee/bugsee` | deno 2.8.3 | `{"type":"node","version":"24.15.0"}` ← node-compat version |
  | `@bugsee/bun` (direct) | bun 1.3.14 | `{"type":"bun","version":"1.3.14"}` ✅ |
  | `@bugsee/deno` (direct) | deno 2.8.3 | `{"type":"deno","version":"2.8.3"}` ✅ |

  Only a **direct** `import { launch } from '@bugsee/bun'` reaches the package under review. Note this
  compounds the backend-routing problem the protocol review already found in `environment.sdk.type`: every
  Bun and Deno session arriving through the umbrella is indistinguishable from Node.

### 2. Deno: `launch()` throws `NotCapable` into the host app without `--allow-env` — the degrade-to-memory guard is one line too late

- **Package:** deno
- **Where:** `packages/node/src/launch.ts:404` — `options.dataRootBase ?? tmpdir()` is evaluated as an
  argument to `resolveDataLocation`, **outside** the `try` at `packages/node/src/launch.ts:414-431` whose own
  comment (`:422-424`) says *"an observability SDK must NEVER crash the host app"*. `tmpdir()` reads
  `process.env.TMPDIR`, which Deno permission-gates.
- **What / Why it matters:** This is the node-tier SEV1 #2 (three eager fs writes outside the guard), but on
  Deno it fires **before any filesystem call, on the most common Deno invocation there is**. `onError` is
  never called; the exception propagates out of `launch()`. It fires even when an explicit `dataDir` is
  passed (the `tmpdir()` argument is evaluated eagerly regardless) and even under `-A --deny-env`.
- **Evidence (deno 2.8.3, `--no-prompt`, static import so module loading is not itself gated):**

  ```
  deno run --allow-net probe.ts        → LAUNCH-THREW NotCapable: Requires env access to "TMPDIR"
  deno run --allow-net --allow-read …  → LAUNCH-THREW NotCapable: Requires env access to "TMPDIR"
  deno run -A --deny-env …             → LAUNCH-THREW NotCapable: Requires env access to "TMPDIR"
  deno run --allow-env …               → LAUNCH-OK  (write + sys failures correctly reach onError)
  ```

  `deno run --allow-net server.ts` is the canonical Deno web-server recipe. `packages/deno/README.md:20-26`
  documents only `--allow-net` / `--allow-read` / `--allow-write` and promises that denied permissions
  *"surface errors via the `onError` sink"* — for `--allow-env` that is false.

### 3. Deno without `--allow-run`: `pidAlive()` reports **false for every live process**, inverting the multi-instance liveness gate

- **Package:** deno
- **Where:** `packages/node/src/liveness.ts:18-28` — `pidAlive` treats only `error.code === 'EPERM'` as
  alive. Deno's `process.kill` requires `--allow-run` and otherwise throws `NotCapable` with
  `code === undefined`, so the `catch` returns `false`. Consumed at
  `packages/node/src/recover-instances.ts:180-182` (`isSiblingDead(pidAlive(owner.pid), …)`) and
  `packages/node/src/sweep-instances.ts:68`. `packages/node/src/liveness.ts:64-66` short-circuits on a dead
  pid, so the heartbeat check that would otherwise protect a live instance is never consulted.
- **What / Why it matters:** The whole D2 design rests on *"a whole-process death is caught instantly by the
  pid probe"*. On Deno the probe answers "dead" unconditionally, so a launching peer classifies **every**
  live sibling as dead and enters `recoverSubtree` against a running instance's capture — draining and
  re-uploading its data, and removing the subtree once drained
  (`packages/node/src/recover-instances.ts:151-153`). `--allow-run` is a very broad privilege that no Deno
  user grants for an observability SDK, and it is listed nowhere in `packages/deno/README.md`.
- **Evidence (deno 2.8.3, evaluating the exact gate expression from `recover-instances.ts:180-182` against a
  known-live pid with a fresh heartbeat):**

  ```
  deno … --allow-read --allow-env             → pidAlive(LIVE pid)=false  isSiblingDead(...)=true   ⇒ RECOVERS A LIVE SIBLING
  deno … --allow-read --allow-env --allow-run → pidAlive(LIVE pid)=true   isSiblingDead(...)=false  ⇒ correctly skipped
  bun 1.3.14 / node 24 (control)              → pidAlive(self)=true, pidAlive(999999)=false          ⇒ correct
  ```

  Honest scope note: in a two-process Deno e2e (one instance live for 6 s, a second launching against the
  same `dataDir`) I did **not** observe the live sibling's subtree being deleted inside the observation
  window — the proven part is that the liveness gate is defeated and the recovery path runs against a live
  sibling; the deletion is gated behind the drain condition at `recover-instances.ts:151-153`.

### 4. The guarded `perf_hooks` sampler guards against a throw that never happens — Bun and Deno return **fabricated** event-loop metrics

- **Package:** both
- **Where:** `packages/node/src/guarded-system-metrics.ts:43-67` (`guardedEventLoop` — try/catch at
  construction and per read) and `:70-87` (`guardedElu`), defaulted in by
  `packages/bun/src/launch.ts:22` and `packages/deno/src/launch.ts:23`. The design premise is stated at
  `guarded-system-metrics.ts:5-11`: *"Bun and Deno support [these] only partially … if either is absent or
  throws … its metric degrades to zero"*.
- **What / Why it matters:** Neither runtime is absent and neither throws. `monitorEventLoopDelay()` and
  `performance.eventLoopUtilization()` both **exist and return successfully** — with values that are simply
  wrong. The guard therefore never fires, and the sampler emits a number that reads as a **healthy event
  loop** while the loop is in fact blocked. A fabricated healthy metric is worse than a missing one: it is
  the exact signal an operator would consult during an incident, and on Deno it will read ~0 ms during a
  total stall. (ANR detection is unaffected — the watchdog uses its own worker-thread `Atomics` heartbeat,
  and it works; see the parity table.)
- **Evidence (identical probe on all three; the loop is deliberately blocked **5 × 120 ms = 600 ms**, then
  the histogram and the sampler are read):**

  | metric | node 24.15.0 | bun 1.3.14 | deno 2.8.3 |
  |---|---|---|---|
  | `event_loop_lag_ms` (mean) | **131.83** | 61.95 | **0.0043** ← 600 ms of real stall |
  | `event_loop_lag_max_ms` | 132.12 | 109.99 | **0.085** |
  | `event_loop_utilization` | **0.899** | **0** | **0** |
  | raw `performance.eventLoopUtilization()` | `{idle:67.6, active:603.7, util:0.899}` | `{idle:0,active:0,utilization:0}` | `{idle:0,active:0,utilization:0}` |

  Both `createGuardedSystemMetricsSampler()` and the *unguarded* `createNodeSystemMetricsSampler()` were run
  side by side on each runtime: neither throws on Bun or Deno, so the guarded override buys nothing against
  the failure mode that actually occurs. Secondary observation on Bun: `monitorEventLoopDelay()` appears to
  return a **shared** histogram — the guarded sampler's `histogram.reset()` (`guarded-system-metrics.ts:61`)
  zeroed the readings of a second, independently-constructed monitor in the same process (node keeps them
  independent), so the SDK can silently clobber a host app's own event-loop monitor on Bun.

---

## SEV2

### 5. Bun: an unhandled rejection is suppressed to `exit 0` **and** no report is delivered in that run (3/3 deterministic)

- **Package:** bun
- **Where:** provider registered at `packages/node/src/launch.ts:636`; listener at
  `packages/node/src/detection-providers.ts:76-95` (`UnhandledRejectionProvider`, `controllingOption =
  BugseeOption.DetectCrash`, default `true`).
- **What / Why it matters:** The inherited node defect (registering the listener suppresses the runtime's
  default non-zero exit) reproduces on Bun, but Bun additionally exits before the report's upload completes,
  so the crashing run delivers nothing. The host sees a clean `exit 0` and the dashboard sees no incident.
  The report *is* persisted and recovered on the next launch against the same `dataDir` (verified), so the
  data is delayed rather than destroyed — which is why this is SEV2 and not SEV1. For a short-lived Bun
  script, a container that is replaced rather than restarted, or an ephemeral `dataDir`, it is lost.
- **Evidence (3 consecutive runs per runtime; `reject-baseline` with no SDK exits 1 on all three):**

  ```
  node  exit=0 issues=1 uploads=1 | exit=0 issues=1 uploads=1 | exit=0 issues=1 uploads=1
  bun   exit=0 issues=0 uploads=0 | exit=0 issues=0 uploads=0 | exit=0 issues=0 uploads=0
  deno  exit=0 issues=1 uploads=1 | exit=0 issues=1 uploads=1 | exit=0 issues=1 uploads=1
  relaunch on the same dataDir: bun run2 uploads=1  (the report is recovered, one launch late)
  ```

### 6. Bun panics (SIGTRAP / segfault) when a context is opened on the root async scope — reachable through the re-exported `openServerContext`

- **Package:** bun
- **Where:** `packages/node/src/server-instrument.ts:263` (`store.enterWith(...)`), re-exported from
  `packages/bun/src/index.ts:6`. Trigger requires the `enterWith` to happen on the **root** async context
  followed by `node:http` server teardown.
- **What / Why it matters:** The Bun process dies with `panic(main thread): Segmentation fault` /
  `Bus error`, killing the host app. **Attribution, verified:** this is an upstream Bun bug, not an SDK
  defect — a control probe using a bare `node:async_hooks` `AsyncLocalStorage.enterWith('TOP')` at module
  scope with **no SDK loaded at all** panics identically. Bun itself prints *"This indicates a bug in Bun,
  not your code."* The SDK's own auto-instrumentation is safe (it uses `store.run`, and `openServerContext`
  called *inside* a request handler is fine on all three runtimes), so this only bites a user who calls the
  exported `openServerContext` outside a request. Recorded because it is a host-crash reachable through a
  package whose README claims full parity and says nothing about it.
- **Evidence:**

  | probe | node 24 | bun 1.3.14 | deno 2.8.3 |
  |---|---|---|---|
  | A: bare `enterWith` at root + `node:http` keep-alive (no SDK) | DONE-OK | **panic: Bus error** | DONE-OK |
  | B: `openServerContext` at root + keep-alive | DONE-OK | **panic: Segmentation fault** | DONE-OK |
  | C: `openServerContext` inside the handler only | DONE-OK | DONE-OK | DONE-OK |
  | D: same, context survives an `await` | DONE-OK | DONE-OK | DONE-OK |
  | E: `runServerRequest` (the auto-instrument path) | DONE-OK | DONE-OK | DONE-OK |

### 7. Neither package declares `engines`; the documented floors are unenforced and one of them rests on an untested module-load assumption

- **Package:** both
- **Where:** `packages/bun/package.json` and `packages/deno/package.json` — **no `engines` field at all**
  (compare `packages/node/package.json:26`). The floors live only in `packages/deno/README.md:28-33` (Deno
  ≥ 2.0) and in project notes (Bun ~1.1).
- **What / Why it matters:** Nothing stops a Bun 1.0 or Deno 1.x install, and the "diagnostics degrade
  gracefully on Deno 2.0" promise depends on `import inspector from 'node:inspector'` at
  `packages/node/src/cpu-profiler.ts:1` — a **static, top-of-module** import. The capability guard at
  `cpu-profiler.ts:64-70` only protects against `mod.Session` being absent; if an older runtime's
  `node:inspector` throws *on import*, the entire `@bugsee/bun` / `@bugsee/deno` entry point fails to load,
  not just the profiler. See *Version-floor assessment*.

### 8. `packages/deno/README.md` understates the required permissions and misstates the failure mode

- **Package:** deno
- **Where:** `packages/deno/README.md:20-26`.
- **What / Why it matters:** It lists `--allow-net`, `--allow-read`, `--allow-write` and states that denied
  permissions *"surface errors via the `onError` sink rather than the bundle"*. Empirically the SDK also
  needs `--allow-env` (mandatory — absence is a hard throw, SEV1 #2), `--allow-sys` (for
  `systemMemoryInfo`; degrades correctly), and `--allow-run` (for the liveness probe; absence silently
  corrupts recovery, SEV1 #3). Full matrix below.

---

## SEV3

### 9. Surviving mutation — the guarded sampler default, one of the two documented overrides, is pinned by **no** test

- **Package:** both
- **Where:** `packages/bun/src/launch.ts:22`, `packages/deno/src/launch.ts:23`.
- **Evidence:** deleting the whole `systemMetricsSampler: createGuardedSystemMetricsSampler(),` line leaves
  **19/19 passing** in `@bugsee/bun` and **22/22** in `@bugsee/deno`. Both READMEs headline this override.
  (Control: the sibling `systemProbe` default is well pinned — flipping `platformType` to `'node'` fails 4
  bun tests, and reordering the spread so `...options` precedes the defaults fails 1.)

### 10. Surviving mutation — the "never spread-replaced" `serverInstrumentations` concatenation is untested

- **Package:** both
- **Where:** `packages/bun/src/launch.ts:33` / `packages/deno/src/launch.ts:35` —
  `...(options.serverInstrumentations ?? [])`, whose contract is spelled out in the comment at
  `packages/bun/src/launch.ts:25-26` (*"CONCATENATED … never spread-replaced, so a user array does not drop
  it"*).
- **Evidence:** deleting that spread — which silently discards every caller-supplied server instrumentation
  — leaves 19/19 and 22/22 passing.

### 11. Test theater — three assertions that are tautologies under vitest-on-node

- **Package:** both
- **Where:** `packages/bun/src/launch.test.ts:96` and `:131`
  (`expect(env?.platform.version).toBe(process.versions.bun ?? process.versions.node)`) and
  `packages/deno/src/environment.test.ts:33`.
- **What:** under vitest (Node) `process.versions.bun` is always `undefined` and the `Deno` global is always
  absent, so these assert the node-compat value against itself and would pass with the Bun/Deno preference
  removed entirely. The *unit* tests that matter are fine — `packages/bun/src/environment.test.ts:8-17` and
  `packages/deno/src/environment.test.ts:12-26` inject both branches and are caught by mutation — so this is
  a hygiene note, not a hole: the real-runtime assertion exists in the e2e
  (`packages/instrumentation-tests/test/instrumentation.e2e.ts:92-108`, which pins the real Deno major).

### 12. Coverage gaps in the real-runtime e2e that map exactly onto the SEV1s

- **Where:** `packages/instrumentation-tests/test/runtimes.ts:65` (Deno is launched with `-A`);
  `packages/instrumentation-tests/app/scenario.ts:127,308` (the only servers are `http.createServer`).
- **What:** the e2e never exercises `Bun.serve` / `Deno.serve` (both native wraps are covered only by
  injected-fake unit tests — I verified them on the real runtimes myself, see the parity table), never
  imports the `@bugsee/bugsee` umbrella under bun/deno (SEV1 #1), and grants Deno every permission (SEV1 #2
  and #3). Everything it *does* cover, it covers well.

---

## Parity verdict table

Every cell was executed on the real runtime unless marked otherwise.

| feature | Node 24.15.0 | Bun 1.3.14 | Deno 2.8.3 | evidence |
|---|---|---|---|---|
| **CPU profiling** (`node:inspector`) | works — 8 nodes / 83 samples, valid JSON | **works** — 5 nodes / 79 samples | **works** — 10 nodes / 82 samples | `createCpuProfiler()` start→collect→stop on each runtime; `packages/node/src/cpu-profiler.ts:91-163` |
| **ANR watchdog** (mechanism) | works — `[["fair",316],["medium",622],["severe",1233]]` | **works** — `[["fair",309],["medium",615],["severe",1228]]` | **works** — `[["fair",306],["medium",611],["severe",1220]]` | `spawnWatchdogWorker` returns a worker on all three; `Worker#unref` exists and does not throw; `packages/node/src/event-loop-watchdog.ts:125-136` |
| **ANR reporting** (end-to-end) | works — 2 `AppHang` issues uploaded | **works** — 2 issues, `platform.type:"bun"` | **works** — 2 issues, `platform.type:"deno"` | real `launch()` + 2.2 s stall → `{"type":"error","summary":"Main thread hang detected","source":{"mechanism":"hang"}}` at the mock collector |
| **watchdog pins the host process** | **YES — SIGKILL'd at 8 s** | **no — exits in 37 ms** | **no — exits in 61 ms** | default `launch()` then idle; `detectHangs:false` exits in 163 ms on node. **The node SEV1 does not reproduce here** |
| **multi-instance coexistence** | works | works (primitive identical to node) | **BROKEN without `--allow-run`** — live siblings judged dead | SEV1 #3; `pidAlive` ESRCH/EPERM/SIGSTOP'd-child semantics identical on all three when permitted |
| **`node:http` interception** | works — 12/12 contexts correct | **works** — 12/12 correct, 0 mismatches | **works** — 12/12 correct, 0 mismatches | real server, 12 overlapping requests with randomized 0-60 ms delays; `distinctCtx=12, mismatched=0, nulls=0` |
| **native serve wrap** | n/a | **works** — `Bun.serve` patched (`s.fetch !== handler`), 12/12 contexts correct | **works** — `Deno.serve` wrapped, 12/12 correct | `packages/bun/src/bun-serve-interceptor.ts:58-70`, `packages/deno/src/deno-serve-interceptor.ts:61-73` |
| **system metrics — process/OS** | works (14 numeric entries) | **works** — identical entries | **works** — identical entries | `createGuardedSystemMetricsSampler()()`; Deno lacks `process.resourceUsage` but the sampler does not use it |
| **system metrics — event loop** | works (131.8 ms lag / 0.899 ELU) | **lag ~ok, ELU fabricated 0** | **BOTH fabricated (~0.004 ms after 600 ms stall)** | SEV1 #4 |
| **runtime identity (direct import)** | `node` / 24.15.0 | **`bun` / 1.3.14** ✅ | **`deno` / 2.8.3** ✅ | session envelope at the collector |
| **runtime identity (umbrella import)** | `node` / 24.15.0 | **`node` / 24.3.0** ❌ | **`node` / 24.15.0** ❌ | SEV1 #1 |
| **crash (`uncaughtException`)** | exit 1, 1 upload | exit 1, 1 upload | exit 1, 1 upload | at parity |
| **flush-on-`'exit'` after SIGTERM** | never fires | never fires | never fires | see defect 3 below |

---

## Inherited node-defect reproduction matrix

| # | node defect | Bun 1.3.14 | Deno 2.8.3 | notes |
|---|---|---|---|---|
| 1 | **Default `launch()` pins the host process** (watchdog MessagePort re-refs after `unref` — `event-loop-watchdog.ts:131` then `:172`) | **DOES NOT REPRODUCE** — exits in 37 ms | **DOES NOT REPRODUCE** — exits in 61 ms | Contradicts pass C's "pinned: yes/yes/yes". Pass C exercised the watchdog **module**; I ran the full default `launch()`. Node is SIGKILL'd at the 8 s cap; both others exit at their no-SDK baseline speed (bun 32 ms, deno 44 ms). The watchdog still detects hangs on both (parity table), so `unref` simply holds on Bun/Deno where node's `worker.on('message')` re-refs. **Bun and Deno are correct here and node is not.** |
| 2 | **Default `unhandledRejection` → `exit 0`, no opt-out** (`detection-providers.ts:76-95`) | **REPRODUCES, WORSE** — exit 0 **and 0 reports delivered** (3/3) | **REPRODUCES** — exit 0, 1 report delivered | Baseline without the SDK is `exit 1` on all three. Bun's report is recovered on the next launch (SEV2 #5). Deno's `unhandledRejection` behaves node-identically — no `--unstable` flag involved on 2.8.3. |
| 3 | **Flush-on-exit bound to `'exit'`, which never fires on signals** (`launch.ts:765-775`) | **REPRODUCES** — killed by the signal (`exit=null, signal=SIGTERM`), no JS teardown | **REPRODUCES** — identical (`exit=null, signal=SIGTERM`) | With **no** user handler, `'exit'` fired **zero** times on SIGTERM on all three. Node at least reports `exit=143`; Bun/Deno die by signal outright, so the window is if anything smaller. SIGINT identical. Loss is bounded by the batched writer's pending buffer — in my probe 400 log lines (~86 KB) were already durable at signal time, so the practical loss is ≤ the `CAPTURE_FLUSH_MS` (1 s) window, not the whole session. |
| 4 | **Live-but-stalled instance's subtree deleted by a sibling** (`liveness.ts:58-70`, `process.kill(pid,0)`) | **REPRODUCES identically** — `pidAlive` semantics match node exactly | **REPRODUCES + a Deno-specific inversion (SEV1 #3)** | Verified against a SIGSTOP'd child **I spawned**: `pidAlive` = true on all three (correct — a frozen process is alive), `ESRCH` → false, `EPERM` (pid 1) → true. Bun raises `SystemError` with the same `.code` strings. Without `--allow-run` Deno's probe collapses to "everything is dead". |
| 5 | **Eager fs writes outside the degrade guard** (`launch.ts:438`, `:499`, `:511`) | **REPRODUCES** (same code, no Bun-specific amplifier) | **REPRODUCES + a far earlier throw**: `tmpdir()` at `launch.ts:404` throws `NotCapable` before any fs call (SEV1 #2). With `--allow-env` but no `--allow-write`, the write failures **do** degrade correctly via `onError`. | On Deno the *write* path is well-behaved; it is the *env* read that is unguarded. |
| 6 | **`openServerContext` hands request #2 request #1's context** (`server-instrument.ts:260`) | **REPRODUCES** — a root-scope context leaked into all 4 keep-alive requests | **DOES NOT REPRODUCE** — each request got its own context | Node 24 also reproduces (pass B saw it on 18/22). Deno's `enterWith` does not propagate a root-scope store into the `node:http` callback, so the leak cannot occur — a bare-ALS control confirms `getStore()` is `undefined` inside the handler on Deno while node/bun see `'TOP'`. **The default auto-instrument path is unaffected on all three** (it uses `runServerRequest`/`store.run`): 12/12 correct contexts under concurrency on `node:http`, `Bun.serve` and `Deno.serve`. |

---

## Deno permission matrix

Measured on deno 2.8.3 with `--no-prompt`, static import (module loading is not permission-gated).

| permission | needed for | missing ⇒ degrade or throw? | file:line |
|---|---|---|---|
| `--allow-env` | `os.tmpdir()` → `TMPDIR`, during data-location resolution — **even when an explicit `dataDir` is passed** | **THROWS out of `launch()` into the host app**; `onError` never called | `packages/node/src/launch.ts:404` (outside the guard at `:414-431`) |
| `--allow-write` | instance subtree, `owner.json`, capture chunks, bundle store | **degrades** — `onError` receives `NotCapable`, launch continues in memory | `packages/node/src/launch.ts:424` inside the guard |
| `--allow-read` | recovery scan, `owner.json`, `.live` heartbeat mtime | **degrades** — `readOwner`/`readLiveMtimeMs` return `undefined` and the subtree is skipped | `packages/node/src/liveness.ts:31-51` |
| `--allow-sys` | `systemMemoryInfo` (total/free RAM in the envelope + system traces) | **degrades** — surfaces via `onError`, launch continues | `packages/node/src/environment.ts` (`realSystemProbe.totalMemory`) |
| `--allow-net` | report/bundle upload to the endpoint | **degrades** (upload fails; capture and durable queue unaffected) | transport in `@bugsee/node-utils` |
| **`--allow-run`** | `process.kill(pid, 0)` liveness probe | **SILENT CORRUPTION** — `pidAlive` returns `false` for live pids, so live siblings are treated as dead (SEV1 #3). Not documented anywhere. | `packages/node/src/liveness.ts:18-28` → `recover-instances.ts:180-182`, `sweep-instances.ts:68` |

`Deno.version.deno` (the identity probe, `packages/deno/src/environment.ts:12`) needs no permission and is
correctly wrapped in try/catch. Worker spawning for the ANR watchdog needs no permission on 2.8.3.

---

## Version-floor assessment

**Neither package declares `engines` at all**, so both floors are documentation-only and unenforced at
install time. On the APIs actually used:

- **Deno ≥ 2.0 — plausible but unverified, and one specific risk.** Everything the packages themselves add
  (`Deno.version.deno`, `Deno.serve` with all three overloads) has existed since 1.x. The inherited
  composition is the exposure: `packages/node/src/cpu-profiler.ts:1` does a **static** `import inspector from
  'node:inspector'`, and `packages/node/src/guarded-system-metrics.ts:1` a static
  `import { monitorEventLoopDelay, performance } from 'node:perf_hooks'`. The README's "diagnostics degrade
  gracefully on 2.0.0" holds only if those modules *import* cleanly on 2.0 and merely lack members — the
  runtime guards (`cpu-profiler.ts:64-70`, `:109-113`) protect against a missing `Session` and a failing
  `post`, not against a throwing module load. On 2.8.3 both import fine and the profiler genuinely works, so
  the "full support on 2.8+" half of the claim is **confirmed**; the 2.0 half I could not test.
- **Bun ~1.1 — the weakest claim of the two.** Four APIs the composition depends on landed or stabilized
  across the 1.1 series: `node:inspector` (statically imported, as above — and the profiler *works* on
  1.3.14, so the "async on purpose because Bun delivers `post` callbacks on a later tick" note at
  `cpu-profiler.ts:4-6` is well-founded), `perf_hooks.monitorEventLoopDelay`, `AsyncLocalStorage.enterWith`
  (`request-context-store.ts`), and `worker_threads` `Worker` with `{eval:true}` + `unref` + `SharedArrayBuffer`
  + `Atomics` (the ANR watchdog). Each is behind a guard **except** the two static module imports. I verified
  all of them present and functional on 1.3.14 and none of them on 1.1.
- **Plain assessment:** the Deno ≥ 2.0 floor is defensible as a *statement* but is not backed by a guard that
  would survive a throwing `node:inspector` import; the Bun ~1.1 floor is a guess ("inferred, tested on 1.3")
  with four version-sensitive dependencies behind it and **no `engines` field to enforce it**. Either add
  `engines` (Bun does read it for warnings, Deno does not) or lower the claim to the versions actually tested.

---

## What is untested on the real runtime

Everything in the parity table and the two matrices above was executed on real bun 1.3.14 / deno 2.8.3. The
following remain **simulation-only or unverified**:

1. **Every unit test in both packages.** All 19 + 22 tests run under **vitest on Node**. The `Bun`/`Deno`
   globals are hand-injected objects (`target` option in `bun-serve-interceptor.ts:27`,
   `deno-serve-interceptor.ts:30`), `process.versions.bun` is always `undefined`, and the `Deno` global is
   a `{version:{deno:'2.0.0'}}` literal (`packages/deno/src/environment.test.ts:24`). They prove the wiring,
   never the runtime.
2. **Neither native serve wrap is exercised against a real `Bun.serve`/`Deno.serve` by the suite** — unit
   tests use injected fakes and the e2e uses only `node:http`. (I ran both for real; they work.)
3. **Bun 1.1.x and Deno 2.0.x** — no binary available; the declared floors rest on inference.
4. **Deno under any restricted permission set** — the e2e runs `-A`
   (`packages/instrumentation-tests/test/runtimes.ts:65`). All three permission findings live in this gap.
5. **The `@bugsee/bugsee` umbrella and the backend adapters under bun/deno** — no test imports them on those
   runtimes; SEV1 #1 lives in this gap.
6. **Event-loop metric fidelity** — no test asserts that a stalled loop produces a non-zero lag reading on
   any runtime, which is why the Deno/Bun fabrication is invisible.
7. **Signal handling (SIGTERM/SIGINT/SIGHUP)** on any runtime.

---

## Checked and found clean

- **Runtime identity probes — correct, injectable, and genuinely pinned.** `packages/bun/src/environment.ts:18-24`
  and `packages/deno/src/environment.ts:18-27` both take the version source as a parameter so both branches
  are testable, and both fall back to the node-compat version rather than emitting `undefined`. Mutations
  `platformType → 'node'`, dropping the `bun`/`deno` version preference, and forcing `liveDenoVersion()` to
  `undefined` were **all caught**. Verified on the wire: `bun/1.3.14` and `deno/2.8.3` via a direct import.
  Deno's `liveDenoVersion` (`environment.ts:10-16`) correctly try/catches the global access.
- **No misidentification risk in the probes themselves.** Each package hardcodes its own `platformType`, so
  there is no precedence order to get wrong; the only misidentification path is the umbrella (SEV1 #1). Both
  packages correctly prefer the runtime's own version over `process.versions.node` (which reads `24.3.0` on
  Bun and `24.15.0` on Deno — a naive node check matches both, and the code does not make that mistake).
- **Native serve wraps — correct under real concurrency.** `Bun.serve({fetch})` and all three `Deno.serve`
  overloads are wrapped; 12 overlapping requests with randomized delays produced **12 distinct context ids,
  0 mismatched URLs, 0 null contexts** on both. Install is idempotent, `uninstall()` restores the original,
  and both self-skip when their global is absent — mutations against the wrap, the uninstall restore, and the
  absent-global guard were all caught (`D7`–`D11`, `B5`, `B6`).
- **Option-override precedence.** `...options` spreading **after** the defaults (so a caller-supplied
  `systemProbe` wins) is pinned in both packages — reversing the spread order fails a test on each.
- **CPU profiling and the ANR watchdog genuinely work on both runtimes**, end to end, with the correct
  runtime identity on the delivered `AppHang` issue. The `node:inspector` and `worker_threads` capability
  guards are real and correctly placed.
- **`pidAlive` semantics match node exactly on Bun, and on Deno when `--allow-run` is granted** — including
  the `EPERM`-means-alive branch (pid 1) and the SIGSTOP'd-live-process case.
- **`process.on('exit')` / teardown ordering is not made *worse* by either package** — the SIGTERM behaviour
  is inherited verbatim from the node tier.
- **`tsc --noEmit` is clean** for both packages; `vitest run` is green (19/19 bun, 22/22 deno); 14 of 16
  targeted mutations were caught, with a control mutation confirming the harness detects failures.
- **The real-runtime e2e harness is strong where it aims.** `packages/instrumentation-tests` runs the SAME
  scenarios on real `bun` and `deno` binaries and asserts real bundles — including an `AppHang` from the real
  watchdog, a CPU profile containing the blocking frame, cross-process multi-instance recovery, disk
  recovery, the off-thread worker writer, and trace propagation. Its Deno identity assertion
  (`instrumentation.e2e.ts:100-107`, "major ≥ 1 and < 18") is a deliberate, well-aimed check that the real
  `Deno.version.deno` — not the node-compat version — reaches the wire.
- **Working tree:** `git status --short packages/` is **empty**. Every mutated file was restored from a `cp`
  backup taken before the first mutation (md5-verified, no `git checkout` used); all experiments wrote only
  under the scratchpad and the only process signalled was a sleeper this review spawned itself.
