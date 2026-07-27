# Adversarial review — @bugsee/node, Pass C (diagnostics / multi-instance / system probes)

**Reviewed:** 2026-07-26 · **Scope:** `packages/node/src/` — diagnostics: `cpu-profiler.ts` (164/226 test),
`event-loop-watchdog.ts` (204/273), `hang-detection-provider.ts` (77/106), `profiling-controller.ts` (64/172);
multi-instance/disk: `data-location.ts` (120/179), `instance-layout.ts` (92/68), `liveness.ts` (71/107),
`liveness-heartbeat.ts` (50/105), `recover-instances.ts` (191/574), `sweep-instances.ts` (79/249); system
probes: `system-events.ts` (120/147), `system-metrics.ts` (120/145), `guarded-system-metrics.ts` (104/149).
Read-only. `launch.ts`, `node-utils`, `core` read only to verify wiring. All experiments ran in the
scratchpad against throwaway trees and self-spawned child processes; `git status --short packages/` is empty.

**Verdict:** The multi-instance code is *better tested than it is designed*. Its test suite is genuinely
strong — 22 of 23 mutations I injected into the liveness predicate, the sweep's path derivation and the
recovery guards were caught, including the path-escape mutation (`join(dataDir,'..',id)`) and the
drop-the-live-pid-guard mutation — and the deletion blast radius is correctly bounded: every delete derives
from a `readdirSync` basename, `remove()` on a symlinked subtree unlinks only the link (verified), and the
`*.map`-style escape found in a sibling package has no analogue here. What is wrong is the *policy* those
well-tested guards implement. Because the atomic-rename claim is deferred and the heartbeat rides the
**main-thread** scheduler, "alive pid + heartbeat older than 120 s" is treated as DEAD — so I took a real
child process, `SIGSTOP`ped it (a `docker pause` / VM suspend / debugger break / death-spiral GC), and a
sibling coordinator **deleted its entire capture subtree while it was still alive**; on resume every
subsequent write failed `ENOENT` forever. With no claim of any kind, two coordinators starting together both
recovered the same subtree — **4 uploads for 2 bundles** — and both deleted it, over a window equal to the
whole recovery, not a microsecond. The diagnostics side hides a worse, entirely non-obvious defect: the
watchdog worker **is** `unref`'d, but `worker.on('message', …)` immediately re-refs its `MessagePort`, so a
default `launch()` leaves the host process **permanently unable to exit** — proven end-to-end on Node, Bun
and Deno with a `detectHangs:false` control that exits in 8 ms. Pass A's "all SDK timers are `unref`'d, so
the CLI-never-exits class does not apply" is correct about timers and wrong about the conclusion. On the
question Pass D handed over: **`cpu-profiler.ts` is not the producer of the torn `profile` record** — profile
entries never reach disk. Privacy is clean: system metrics are 14 numeric samples, system events carry no
env/argv/cwd/hostname.

## SEV1

### 1. The hang watchdog re-refs its worker's MessagePort — a default `launch()` makes the host process unable to exit

- **Where:** `packages/node/src/event-loop-watchdog.ts:131` (`w.unref()`), then
  `packages/node/src/event-loop-watchdog.ts:172` (`worker.on('message', …)`), reached from
  `packages/node/src/hang-detection-provider.ts:54` → `packages/node/src/launch.ts:638-649`; on by default via
  `packages/node/src/launch.ts:123` (`detectHangs`, default `true`).
- **What:** `spawnWatchdogWorker` unrefs the worker at `:131`, and the comment there and the interface doc at
  `:48-50` state the invariant — *"Stop pinning the parent process alive (the watchdog must never block a
  clean exit)"*. But `start()` then attaches a `'message'` listener at `:172`. In Node, adding a message
  listener **starts and re-refs** the worker's public `MessagePort`, undoing the unref. The order is fixed and
  unconditional, so the pin is always installed.
- **Why it matters:** Every short-lived Node/Bun/Deno program that calls `launch()` — a CLI, a migration
  script, a CI job, a seed/cron task, a serverless handler, a build step — hangs forever instead of exiting.
  This is the textbook "SDK alters host behavior" violation, and it is on by default on all three runtimes.
  Only an explicit `Bugsee.stop()` (which `watchdog.stop()` → `worker.terminate()` reaches) releases it —
  verified: with `stop()` the process exits in 505 ms.
- **Evidence (empirical, Node v24.15.0, real `launch()` against a local 127.0.0.1 mock collector):**
  ```
  detectHangs ON (default) : launched → STILL ALIVE at 5s, active=["MessagePort"]   exit=3 (forced)
  CONTROL detectHangs:false: launched → EXITED naturally after 8ms                  exit=0
  ```
  Isolated to the exact two lines, with controls, using plain `node:worker_threads`:
  ```
  w.unref()                      (no message listener) -> exited after 0ms      exit=0
  w.unref(); w.on('message',fn)  (the SDK's sequence)  -> PINNED, active=["MessagePort"]
  w.unref(); w.on('message',fn); w.unref()             -> exited after 0ms      exit=0
  ```
  Cross-runtime, driving `createEventLoopWatchdog` directly and never calling `stop()`:
  ```
  [node] STILL ALIVE 3s after work finished — PINNED
  [bun]  STILL ALIVE 3s after work finished — PINNED
  [deno] STILL ALIVE 3s after work finished — PINNED
  ```
- **Test theater:** `packages/node/src/event-loop-watchdog.test.ts:92-102` asserts only that `unref()` was
  *called* on a fake worker whose `unref` is `() => { unrefed = true }`. Deleting the real `w.unref()` line is
  caught by that assertion, but the property it claims to protect — the process can still exit — is never
  exercised, so the defect is invisible to the suite.

### 2. A live-but-stalled instance has its capture subtree recovered and deleted, and is left permanently unable to write

- **Where:** `packages/node/src/liveness.ts:58-70` (`isSiblingDead`: alive pid + heartbeat older than
  `DEFAULT_PATIENT_MS` = 120 s ⇒ DEAD), gate at `packages/node/src/recover-instances.ts:180-184`, deletion at
  `packages/node/src/recover-instances.ts:152` (`remove(sub)`); the heartbeat that must keep beating runs on
  the **main-thread** scheduler at `packages/node/src/liveness-heartbeat.ts:44`.
- **What:** The only signal that an alive-pid instance is still using its subtree is a `.live` mtime younger
  than 120 s, written by a `setInterval` **on the very event loop that stalls**. Any whole-instance stall
  longer than 120 s — `docker pause`/CRIU freeze, a laptop/VM suspend, a debugger break, a death-spiral GC, or
  a genuinely blocked event loop (the exact condition this SDK ships ANR detection for) — makes a live
  instance indistinguishable from a dead one, and the coordinator recovers *and deletes* its subtree
  underneath it. For `worker_threads` this is worse, not better: worker threads exist precisely to run long
  synchronous CPU-bound work, and a worker blocked for >2 minutes keeps a live pid while its own heartbeat
  timer cannot fire.
- **Why it matters:** This is data loss plus permanent capture death, and it is silent. After the subtree is
  removed the surviving instance's `appendFileSecure` calls fail `ENOENT` forever (nothing recreates the
  tree), and those failures go to `onError`, which most hosts do not set.
- **Evidence (empirical; real child process spawned by me, real `createInstanceLayout` +
  `writeInstanceOwner` + `startLivenessHeartbeat` + `appendFileSecure`, real `recoverInstances`; the 200 s
  stall is modelled by aging the `.live` mtime, the default patient window being 120 s):**
  ```
  STALLED the child (SIGSTOP). pid=33898 captured 12 entries so far.
    pid still alive during the stall?  true
  AFTER the sibling ran recovery:
    stalled instance still ALIVE?      true
    its subtree still on disk?         false
    its 12 captured entries:           DESTROYED
  RESUMED the child; its next writes:
    [child] CHILD WRITE FAILED: ENOENT   (x14, and forever after)
    subtree recreated by the still-running instance? false
  ```
  Second, independent reproduction with a **real live child pid** and no aging of anything else:
  ```
  E1 LIVE process (pid 26725, confirmed alive) + 200s-stale heartbeat
     pid still alive after recovery? true
     subtree still on disk?          false
  E2 CONTROL live pid + FRESH heartbeat → subtree kept? true
  ```
- **Note:** `packages/node/src/instance-layout.ts:29` documents the opposite of the implementation — *"its
  mtime is touched from the watchdog thread"*. It is not; `liveness-heartbeat.ts:5-8` correctly calls the
  worker-thread carrier a deferred hardening. That deferral is exactly what makes this reachable.

## SEV2

### 1. There is no claim of any kind — two coordinators recover the same subtree, double-upload it, and both delete it

- **Where:** `packages/node/src/recover-instances.ts:180-190`: the liveness check at `:180-184` and
  `recoverSubtree` at `:186` are separated by nothing — no lock file, no `owner.json` CAS, no atomic rename
  (documented as deferred at `:34`). Deletion at `:152`.
- **What:** The TOCTOU window is not a race between two adjacent instructions; it is the **entire recovery**,
  which contains `await uploadPipeline.enqueue(...)` per pending bundle (`:87`) plus `recoverNativeCrashes`
  (`:121`) plus `recoverReports` (`:139`). Every one of those is a network round-trip.
- **Why it matters:** Duplicate incidents (Pass D established there is **no idempotency key** anywhere in the
  wire contract, so the in-code claim at `:32` that *"the backend dedups a duplicate"* is unsupported at this
  layer), and both coordinators call `remove(sub)` — so one can delete chunk files while the other is still
  reading them in `recoverReports`. I proved the duplicate upload; I did **not** prove a torn bundle from the
  concurrent delete, so I state that only as an exposure.
- **Evidence (empirical, two `recoverInstances` over one dead subtree holding 2 real serialized bundles,
  120 ms simulated upload latency):**
  ```
  total enqueue() calls (2 bundles expected): 4
  peak concurrent uploads:                    2
  claim window measured (ms, check→remove):   245
  subtree removed?                            true   (by both)
  ```
  245 ms with a 120 ms mock; with real upload latency and several incidents the window is seconds to minutes.

### 2. `recoverInstances` rejects on any non-ENOENT `owner.json` read error, aborting recovery for every remaining sibling

- **Where:** `packages/node/src/recover-instances.ts:176` (`readOwner`) and `:181` sit **outside** the
  per-subtree `try` at `:185-189`; the loop at `:168-190` has no guard of its own (only `listFiles` is wrapped,
  `:159-165`). `readFileBytes` (`packages/node-utils/src/fs-storage.ts:37-46`) swallows only `ENOENT` and
  rethrows everything else. `packages/node/src/launch.ts:721` calls it as `void recoverInstances(...)`.
- **What:** An unreadable (`EACCES`) or non-directory (`ENOTDIR`) entry throws out of the loop, so the async
  function rejects — and every sibling later in `readdir` order is never recovered.
- **Why it matters:** Data loss (unrecovered crash bundles) plus a promise rejection escaping a module whose
  contract at `:35-36` is *"a failure on one subtree goes to onError and never blocks the others or the
  launch."* `sweepAgedInstances` makes the identical `readOwner` call **inside** its per-subtree `try`
  (`sweep-instances.ts:63-77`) and survives the same input — proving the asymmetry is an oversight. In a
  default launch the SDK's own `unhandledRejection` provider swallows it (turning an internal SDK failure into
  a report attributed to the customer's app); with `detectCrashes:false` it reaches the host unhandled.
- **Evidence (empirical):**
  ```
  stray FILE named `1-0-strayfile` in dataDir:
    sweep survived a stray FILE entry; onError: [ 'ENOTDIR' ]
    !! UNHANDLED REJECTION escaped recoverInstances: ENOTDIR
  unreadable owner.json (chmod 000) in the FIRST subtree, a second recoverable sibling after it:
    !! UNHANDLED REJECTION: EACCES
       later sibling 9999-0-bbbb still present (never recovered)? true
  ```

### 3. `ProfilingController.stop()` bypasses its own serialization chain and silently drops the incident's `profile.json`

- **Where:** `packages/node/src/profiling-controller.ts:61` (`void profiler.stop()`) — not enqueued on the
  `chain` built at `:36-41`, which `snapshot()` (`:52`) and the rolling tick (`:47`) both go through.
- **What:** The module's own comment at `:10-12` states the invariant: *"Both the rolling timer and the report
  snapshot call profiler.collect() … so they MUST be serialized — two concurrent Profiler.stop calls would
  corrupt the inspector session."* `stop()` is a third caller of `Profiler.stop` and it is not serialized.
  Worse, because `snapshot()`'s collect is deferred onto a microtask by the chain while `stop()` runs
  synchronously, `stop()` **wins the race** and disconnects the session before the report's collect runs.
- **Why it matters:** A report that coincides with shutdown (i.e. the crash-flush path — the most valuable
  incident there is) loses its `profile.json` entirely, and the session sees two overlapping `Profiler.stop`
  calls in the window the comment forbids.
- **Evidence (empirical, an instrumented profiler recording enter/exit):**
  ```
  order = stop:enter | collect:enter | stop:exit | collect:exit
  PEAK concurrent profiler ops (1 = serialized, 2 = overlapping stop): 2
  ```

### 4. A shared explicit `dataDir` makes one app upload another app's recorded session under its own token

- **Where:** `packages/node/src/data-location.ts:116-118` — the per-app-token path segment is applied **only**
  to the default root; an explicit `options.dataDir` is used verbatim. `packages/node/src/recover-instances.ts:87`
  re-uploads a sibling's serialized bundle bytes through **this** instance's pipeline, and
  `packages/core/src/bugsee-api.ts:41,69` authenticates/routes with **this** instance's `appToken`
  (`packages/node/src/launch.ts:723` passes `appToken` into the recovery context).
- **What:** `data-location.ts:9-10` states the safety property — *"The per-APP-TOKEN segment scopes recovery +
  the sibling sweep to THIS app, so two different Bugsee apps sharing a host never recover/delete each other's
  data through the wrong app token."* That property does not hold for an explicit `dataDir`, and nothing warns.
- **Why it matters:** Two services in one base image / one k8s `emptyDir` configured with the same
  `dataDir: '/var/lib/bugsee'` is an ordinary ops choice. App A then uploads app B's console logs, network
  bodies and user identifiers into app A's project — cross-tenant data disclosure — and deletes B's subtrees.

### 5. `system-events` re-raises SIGTERM synchronously, discarding the only window in which the SDK could flush

- **Where:** `packages/node/src/system-events.ts:83-92` (`#onSignal`: emit, then `off` + `reRaise` at `:91`).
- **What:** Registering a SIGTERM listener suppresses Node's default termination — that suppression is the one
  opportunity to flush disk capture. The SDK deliberately gives it back **synchronously**, before any flush,
  and the process then dies by default action, so `'exit'` never fires.
- **Why it matters:** Pass A established the flush hook is bound to `'exit'` and never runs on
  SIGTERM/SIGINT/SIGHUP; this is the file where the decision is made. The `process_signal` entry the SDK just
  emitted is itself lost with everything else.
- **Evidence (empirical, real `createNodeSystemEventsSource` active):**
  ```
  SDK captured system event: {"name":"process_signal","params":{"signal":"SIGTERM"}}
  exit=143   (no `exit` event fired — identical to the no-SDK control)
  ```

### 6. A dead worker thread's subtree can never be reaped by the TTL sweep while its process lives

- **Where:** `packages/node/src/sweep-instances.ts:68` (`pidAlive(owner.pid, options.kill)` → skip). A worker
  thread's subtree records the **process** pid (`packages/node/src/instance-layout.ts:59-62`), so
  `process.kill(pid, 0)` cannot tell a dead thread from a live process.
- **What:** The sweep — described at `:8-10` as *"the last-resort reaper for the truly abandoned"* — is
  structurally incapable of reaping the one case the layout was designed for. Only `recoverInstances` reclaims
  it (after 120 s of staleness), and that path is gated on `recover !== false`
  (`packages/node/src/launch.ts:508,720`).
- **Evidence (empirical):**
  ```
  E4 sweep: dead+aged removed?                                                  true
     LIVE pid + 8-day-stale heartbeat kept?                                     true
     DEAD WORKER THREAD (tid 7) in a LIVE process, 30 DAYS aged — kept?         true
  ```
- **Consequence:** with `recover: false`, a long-lived server that churns worker threads accumulates one
  never-reclaimed subtree per dead worker, forever.

### 7. `AppHang` reports have no cross-episode rate limit

- **Where:** `packages/node/src/event-loop-watchdog.ts:157,173-181` — `reported` caps an episode at 3 reports
  (fair/medium/severe), and `:174` resets it to 0 on the worker's `recovered` message. Nothing bounds the
  number of *episodes*.
- **What:** Every stall that recrosses `fairMs` produces a fresh set of up to three reports, with no cooldown
  and no per-process cap.
- **Why it matters:** An app with a recurring >3 s synchronous phase (a large sync parse loop, a batch job, a
  sync crypto/compression step) emits 3 `AppHang` reports per occurrence indefinitely.
- **Evidence (empirical, thresholds 300/600/1200 ms, two consecutive 1.5 s blocks):**
  ```
  EPISODE-1 reports: [["fair",316],["medium",618],["severe",1222]]
  EPISODE-2 reports: [["fair",325],["medium",628],["severe",1233]]
  ```
  Mitigating: at the Android-canonical defaults (3000/5000/10000 ms, `launch.ts:124-126`) ordinary sync work
  is below `fair` — a 400 k-element `JSON.parse` took 31 ms and produced zero reports.

## SEV3

1. **`owner.json` does not disambiguate PID reuse at all.** `packages/node/src/instance-layout.ts:84-91`
   persists `instanceId`, `pid`, `threadId`, `startedAt`, `version`; grep shows **only** `owner.pid`
   (`liveness.ts:38`, via `recover-instances.ts:181` / `sweep-instances.ts:68`) and `owner.startedAt`
   (`sweep-instances.ts:43`) are ever read. `instanceId`, `threadId` and `version` are write-only, the pid in
   the *directory name* is never cross-checked against `owner.pid`, and no process-identity token (pid start
   time, boot id) is recorded — so nothing distinguishes "pid 1234 is the original owner" from "pid 1234 is a
   recycled unrelated process". Only heartbeat staleness covers it. Harm is bounded (see race analysis).
2. **Unvalidated pid from a file is passed straight to `process.kill`.** `liveness.ts:38` accepts any
   `typeof === 'number'`. Empirically, `{"pid":0}` → `process.kill(0,0)` (this process's **process group**)
   and `{"pid":-1}` → `process.kill(-1,0)` (**every** signalable process) both return "alive", so those
   subtrees are pinned on disk forever and never reclaimed by either path. Signal 0 delivers nothing today, so
   the harm is a permanent leak, not a signal — but the call shape is one refactor away from being dangerous.
   ```
   E5  4-0-zero removed=false   5-0-neg removed=false   6-0-huge removed=true
   ```
3. **`cpu-profiler.collect()` throws away a profile it already collected, and permanently disables profiling.**
   `packages/node/src/cpu-profiler.ts:132-137`: `Profiler.stop` succeeds, `Profiler.start` (the rolling
   restart) fails, the `catch` tears the session down and `:139` returns `undefined` — the collected profile is
   dropped on the floor and `running` is false forever after. Empirically:
   `collect() → undefined (PROFILE DISCARDED); profiler.running after the failure: false`.
4. **The `INSTANCE_DIR` shape filter is untested in isolation (surviving mutation).** Deleting
   `!INSTANCE_DIR.test(id)` from `sweep-instances.ts:59` leaves the whole suite green, including
   `sweep-instances.test.ts:174` (*"never touches a non-instance-shaped (foreign) directory"*), because the
   foreign fixture is also owner-less and the `owner.json` guard alone produces the asserted outcome. This is
   consistent with the design (`:12-15` calls the regex a cheap first filter, not the safety boundary), so it
   is a test-strength gap rather than a defect — but 22 of my other 23 mutations were caught, so it stands out.
   The corresponding `recover-instances.ts:169` mutation **was** caught.
5. **`guarded-system-metrics` builds and `enable()`s a histogram it may never use, and the guard is
   type-legally defeatable.** `packages/node/src/guarded-system-metrics.ts:100-101` evaluates
   `guardedEventLoop(...)`/`guardedElu(...)` eagerly, *before* `...nodeDeps` (`:102`) can override them — so a
   caller supplying its own `eventLoop` still pays for a `monitorEventLoopDelay()` histogram that is enabled
   and then discarded. And because the repo does not set `exactOptionalPropertyTypes` (`tsconfig.base.json`
   has only `strict: true`), passing `{ eventLoop: undefined }` is legal and overwrites the guarded reader with
   `undefined`, at which point `system-metrics.ts:80` falls back to the **unguarded** Node histogram — on Bun
   or Deno, silently defeating the entire point of the module.
6. **The perf_hooks histogram has no teardown.** `packages/node/src/system-metrics.ts:48-60` calls
   `histogram.enable()` and nothing ever calls `disable()`; the sampler exposes no stop handle. Repeated
   launch/stop cycles accumulate enabled histograms (200 samplers ≈ +1.2 MB rss, measured). Sampling cost
   itself is fine: 0.109 ms/sample, of which `os.cpus()` (called per sample at `system-metrics.ts:82,99`) is
   0.014 ms.
7. **The watchdog's built-in default scheduler does not `unref`.** `packages/node/src/event-loop-watchdog.ts:200-204`
   wraps bare `globalThis.setInterval`, unlike core's default scheduler which unrefs
   (`packages/core/src/client.ts:94-103`). The `launch()` path always injects the client scheduler
   (`launch.ts:644`), so this is latent — but a direct `createEventLoopWatchdog`/`createHangDetectionProvider`
   consumer gets a second, independent process pin. Verified: `watchdog-default` shows two `Timeout` handles
   where `watchdog-unref` shows one.
8. **`ensureSecureDataRoot` has a mkdir→lstat TOCTOU.** `packages/node/src/data-location.ts:82-83` creates
   each level then `lstat`s it; the checks are correct (symlink / foreign uid / group-other mode) but an
   attacker can swap the directory between the two calls, and every later write addresses the path by name
   with no re-verification. Narrow, and only the shared default root is in scope by design (`:66-69`).
9. **Recovered incidents carry the *recovering* instance's environment and SDK version.**
   `packages/node/src/recover-instances.ts:50-51` + `packages/node/src/launch.ts:723`
   (`context: () => ({ appToken, environment: getEnvironment(), clock })`). `owner.json` records the dead
   instance's `version` (`instance-layout.ts:89`) and it is never consulted, so a bundle recovered across an
   SDK upgrade or a differently-configured peer is stamped with the wrong envelope.
10. **`instance-layout.test.ts` never asserts the on-disk permissions** it depends on — no test that
    `writeInstanceOwner` produces a `0600` `owner.json` inside a `0700` root
    (`instance-layout.ts:83,91` → `node-utils` `DIR_MODE`/`FILE_MODE`). The 68 test lines are otherwise
    proportionate: the 92 impl lines are mostly interface/comment, and the executable body is fully covered.

## Multi-instance race analysis

- **PID reuse — verdict: `owner.json` does NOT disambiguate; harm is nonetheless bounded.** Only `owner.pid`
  is ever read (`liveness.ts:38` → `recover-instances.ts:181`, `sweep-instances.ts:68`); `instanceId`,
  `threadId` and `version` are written and never consulted, and no pid-start-time / boot-id token is recorded.
  The *only* thing separating "the original owner" from "a recycled pid" is heartbeat staleness. Enumerating
  the directions: (a) a dead instance whose pid was recycled by a live process reads as alive → the TTL sweep
  can never reclaim it (`sweep-instances.ts:68`), but recovery does after 120 s of staleness — delayed, not
  lost; (b) a live instance cannot read as dead *via the pid probe* (its own pid is always alive); (c) a
  foreign process's data can never be touched, because only subtrees under our own `dataDir` carrying a valid
  `owner.json` are ever considered (`recover-instances.ts:169-179`, `sweep-instances.ts:59-70`) — I verified a
  regex-matching `2024-01-02` directory with real content is left alone. **Missing/corrupt/truncated
  `owner.json`:** verified safe — truncated JSON, a missing `pid`, and a string `pid` all yield `undefined`
  and the subtree is skipped (`liveness.ts:36-41`); `{"pid":0}` and `{"pid":-1}` are accepted and pin the
  subtree forever (SEV3 #2).
- **TOCTOU claim window — verdict: EXISTS, and it is the whole recovery, not an instant.** There is no claim
  primitive at all: `recover-instances.ts:184` falls straight through to `:186`, and the deferred atomic rename
  is acknowledged in-file at `:34`. Measured: two coordinators over one dead subtree with two pending bundles
  produced **4 enqueues, peak concurrency 2**, both deleted the subtree, elapsed 245 ms with a 120 ms mock
  upload — i.e. the window scales with upload latency × (bundles + incidents), reaching seconds or minutes in
  production. Consequences proven: duplicate uploads. Consequence exposed but **not** proven: one coordinator's
  `remove(sub)` (`:152`) landing while the other is mid-`recoverReports` (`:139`) could truncate a bundle.
- **Suspended / frozen processes — verdict: BROKEN (SEV1 #2).** The 120 s patient window
  (`liveness.ts:15`) is measured against a heartbeat written by a **main-thread** `setInterval`
  (`liveness-heartbeat.ts:44`, 10 s period → 12 missed beats of tolerance). `docker pause`, VM/laptop suspend,
  a debugger break, a death-spiral GC and a genuine event-loop hang all exceed it, and the coordinator then
  deletes a live instance's data. Demonstrated end-to-end with `SIGSTOP` on a self-spawned child.
- **Clock changes — verdict: asymmetric; forward steps are dangerous.** `isSiblingDead` computes
  `nowMs - liveMtimeMs > patientMs` (`liveness.ts:70`) with `nowMs = Date.now()` of the *recovering* process
  and `liveMtimeMs` an mtime stamped by the *stalled* process's kernel. A **backward** step makes the
  difference negative → never dead → safe. A **forward** step of >120 s (an NTP correction on a
  freshly-booted VM/container with a skewed RTC — routine) instantly ages every live sibling past the window
  and triggers the SEV1 #2 deletion path with no stall at all. The 7-day sweep needs a >7-day step and is
  effectively immune. DST is irrelevant (both sides are UTC epoch ms).
- **Dead worker thread in a live process — verdict: reclaimed by recovery, never by the sweep.** Verified
  empirically: a `<pid>-7-<nonce>` subtree whose process is alive is kept by `sweepAgedInstances` even at 30
  days (SEV2 #6), because `sweep-instances.ts:68` gates on `!pidAlive`. `recoverInstances` does reclaim it
  after 120 s of heartbeat staleness — which is the *same* mechanism that makes SEV1 #2 possible. With
  `recover: false` (`launch.ts:508,720`) it leaks forever.

## Deletion blast-radius audit

| delete call site | path derived | can it escape the intended subtree? | can it hit a LIVE instance? |
|---|---|---|---|
| `remove(sub)` — full subtree | `join(dataDir, id)`, `id` a `readdirSync` basename (`recover-instances.ts:161,172`) | **No.** basenames cannot contain `/` or `..`; the `join(dataDir,'..',id)` mutation is caught by the suite; `remove` = `rmSync(recursive,force)`, which on a symlinked subtree unlinks only the link (verified) | **YES — SEV1 #2.** Guards: `id !== ownInstanceId`, `/^\d+-\d+-/`, valid `owner.json`, `isSiblingDead` — the last of which is false-positive on a stalled instance |
| `remove(sub)` — TTL reaper | `join(dataDir, id)`, same derivation (`sweep-instances.ts:53,62`) | **No.** same reasoning; the path-escape mutation is caught | **No.** `!pidAlive(owner.pid)` (`:68`) is a hard gate; verified a live-pid subtree survives an 8-day-stale heartbeat. Can delete a *dead* instance's >7-day-old data by design (`:9-11`) |
| `store.remove(id)` — unparseable blob purge | `join(sub,'pending', id + '.bundle')` (`recover-instances.ts:83`; `node-utils/bundle-store.ts:15,28`) | **No.** `id` comes from `store.list()` = `readdir` basenames minus suffix | Only within a subtree already judged dead |
| `store.remove(id)` — delivered blob drop | same as above (`recover-instances.ts:89`) | **No.** | Only within a subtree already judged dead |
| `crashpad.remove()` — session marker | `join(sub,'incidents')` store (`recover-instances.ts:118,131`) | **No.** | Only within a subtree already judged dead |
| `recoverReports(...)` generation sweep | `join(sub,'capture')` via `createFsChunkStorage` (`recover-instances.ts:105,139`) | **Not from here.** Note: if `dataDir` is an unchecked explicit path and `<sub>` is a symlink, these writes/deletes resolve *through* it — `ensureSecureDataRoot` only guards the default root (`data-location.ts:66-69`) | Only within a subtree already judged dead; **and** racing a second coordinator (SEV2 #1) |

No glob/recursive-unlink-by-pattern exists anywhere in this scope — the `*.map` escape class found in a
sibling package has no analogue here.

## profile.json integrity

**The Pass D torn-`profile`-record defect is not produced by this pass's code — the precondition is
unreachable through the node profiling path.** Chain of evidence:

1. `cpu-profiler.ts` returns either a well-formed V8 profile object or `undefined`. Every stop path is
   guarded: `collect()` (`:128-140`) and `stop()` (`:142-154`) wrap `post` in `try`, and `profileOf`
   (`:88-89`) dereferencing a null/absent result throws a `TypeError` that lands in the same `catch`. There is
   no truncation path — `Profiler.stop` returns a complete object or nothing.
2. `profiling-controller.ts:53` emits **zero** entries when the profile is `undefined`
   (`return profile ? [new CaptureDataEntryBase('profile', now, profile)] : []`), so it can never contribute
   an entry with a malformed payload.
3. **Profile entries never reach disk.** `profilingSnapshot` is registered as a `ReportSnapshotSource`
   (`launch.ts:568-578,551-558`), and `packages/core/src/client.ts:349-365` merges snapshot entries into the
   **already-drained** `capturedByType` map at assembly time. They are never handed to the capture aggregator,
   so no `profile` record is ever written to a capture chunk. A repo-wide grep confirms
   `profiling-controller.ts:53` is the only producer of `'profile'` entries outside the assembler and the
   filename constant.
4. Therefore the empty-`profile`-group condition Pass D exploits (`capture-drain.ts` emitting a group whose
   every record failed to deserialize → `serializeFileData` returning `payloads[0] === undefined` at
   `bundle-assembler.ts:92-97`) cannot arise from node diagnostics: on the recovery path there is no profile
   group at all, and on the live path the group is non-empty by construction. Pass D's framing that
   *"(opt-in profiling + SIGKILL) is a real configuration"* does not hold for this producer. **The
   `bundle-assembler.ts` defect is still real** — it just needs a different (or hypothetical future) on-disk
   producer of `profile` records, e.g. if the snapshot were ever routed through the aggregator.

Well-formedness verified on all three runtimes: `JSON.parse(JSON.stringify(profile))` round-trips
(`node nodes=7 samples=239 jsonOK=true`, `bun nodes=7 samples=235 jsonOK=true`,
`deno nodes=11 samples=240 jsonOK=true`).

Size/overhead at the shipped defaults (1 ms sampling, `rollingIntervalMs = maxRecordingTime × 1000` = **60 s**,
`launch.ts:472,575`): a 15 s synthetic segment with 200 distinct call sites produced 264 nodes / 10 658
samples / **0.13 MB** JSON → ~0.5 MB per 60 s window. Bounded and reasonable; the rolling tick discards each
segment (`profiling-controller.ts:47`) so nothing accretes in RAM. Not a finding.

Remaining integrity gaps are behavioural, not structural: SEV2 #3 (shutdown drops the report's profile) and
SEV3 #3 (a failed rolling restart discards an already-collected profile and kills profiling permanently).
There is no path that produces a *malformed* `profile.json`.

## Watchdog worker lifecycle

- **`unref`'d?** Called — `event-loop-watchdog.ts:131` — and then **undone** by `worker.on('message', …)` at
  `:172`, which re-refs the `MessagePort`. Net effect: not unref'd. SEV1 #1.
- **Terminates on `stop()`?** Yes. `:193` `worker?.terminate()` clears the timer, releases the MessagePort and
  the process exits promptly (verified: 505 ms). `stop()` is idempotent-safe (`worker = undefined` at `:194`)
  and `start()` is idempotent (`:161-162`).
- **Terminates on host exit?** Yes, once the host actually exits — but SEV1 #1 means a host with nothing else
  pending never gets there.
- **Can it block host exit?** **Yes — always, by default, on Node, Bun and Deno.** Proven end-to-end.
- **Can the worker itself hang?** No — it is a separate thread doing an `Atomics.load` + subtraction per poll
  (`:97-116`), with no I/O and no allocation growth. A failure to load `node:worker_threads` is swallowed by
  `.catch(() => {})` at `:115`, leaving an inert worker (silent no-op, correct).
- **False positives / thresholds:** `validateThresholds` (`:60-65`) enforces strictly-increasing positive
  thresholds and falls back to the Android-canonical 3000/5000/10000; the heartbeat is clamped to
  `min(configured, fairMs/2)` at `:147-150` so inter-beat staleness cannot false-positive; an initial beat is
  stored before the worker spawns (`:166`). A 31 ms 400 k-element `JSON.parse` produced zero reports. Episode
  dedup by rank works; there is no cross-episode limit (SEV2 #7).
- **Degradation:** absent `worker_threads` → `spawnWatchdogWorker` returns `undefined` (`:133-135`) and
  `start()` no-ops at `:168-170`. Correct.

## Bun/Deno parity verdict

**The claimed full parity holds functionally — and it inherits SEV1 #1 verbatim.** Verified by running the
real modules under Bun 1.3.14 and Deno 2.8.3:

| capability | Node v24.15.0 | Bun 1.3.14 | Deno 2.8.3 |
|---|---|---|---|
| watchdog worker (`new Worker(src, {eval:true})`) + hang detection | `[["fair",316],["medium",620],["severe",1225]]` | `[["fair",308],["medium",611],["severe",1217]]` | `[["fair",304],["medium",607],["severe",1213]]` |
| `node:inspector` `Profiler.start/stop`, `collect()` | nodes=7 samples=239 jsonOK | nodes=7 samples=235 jsonOK | nodes=11 samples=240 jsonOK |
| `stop()` returns a profile and clears `running` | yes | yes | yes |
| **host process pinned by the watchdog** | **yes** | **yes** | **yes** |

No unguarded Node-only API was found in this scope: `node:worker_threads` is behind the
`spawnWatchdogWorker` try/catch (`event-loop-watchdog.ts:129-135`), `node:inspector` behind
`newInspectorSession` + the `createSession` try/catch (`cpu-profiler.ts:64-70,109-113`), `perf_hooks` behind
`guarded-system-metrics.ts:43-87`, and the worker body dual-loads `require`/`import` with a swallowing
`.catch` (`:115`) for Deno's ESM data-URL worker. `process.kill` is used only via `pidAlive`
(`liveness.ts:18-28`), which both runtimes implement. `node:crypto`'s `randomUUID` is deliberately preferred
over the global `crypto` for Node 18 (`instance-layout.ts:50-52`) — correct. The one parity caveat is SEV3 #5:
`{ eventLoop: undefined }` is type-legal and would swap the guarded reader for the unguarded Node one on
exactly the two runtimes the module exists for.

## Checked and found clean

- **Privacy (mandate item 4) — clean.** A `createNodeSystemMetricsSampler()` sample is 14 entries, **all
  numeric** (`process_memory_*`, `ram_system_*`, `cpu_usage_*`, `event_loop_*`) — verified by dumping a live
  sample. No `process.env`, `argv`, `cwd`, hostname, username or filesystem path appears anywhere in
  `system-metrics.ts`, `guarded-system-metrics.ts` or `system-events.ts`. System events carry only
  `{name}`/`{code}`/`{signal}`; the only free-form field is `warningParams` (`system-events.ts:48-51`), which
  takes a Node warning's `name` + `message` (or `String(warning)`) — bounded and non-secret, though a runtime
  warning can embed a module path.
- **Path traversal in the deletion logic — clean.** Every delete derives from a `readdirSync` basename joined
  to a configured root; the `join(dataDir,'..',id)` mutation is caught by the suite; `remove()` on a symlinked
  subtree removes only the link (verified against a `victim/precious.txt` decoy that survived intact).
- **Foreign-directory safety — clean.** A `2024-01-02` directory containing real user content, which matches
  the shape regex, is left untouched by both the sweep and recovery (no `owner.json`).
- **Own-subtree protection — clean.** Mutating away the `id === ownInstanceId` guard is caught in both
  `sweep-instances.ts` and `recover-instances.ts`.
- **Recovery retry semantics — clean and well tested.** A subtree is removed only when bundles, markers and
  pending native crashes are all drained (`recover-instances.ts:151-153`); mutating that to an unconditional
  `remove(sub)`, or to never dropping a delivered blob, is caught.
- **Liveness predicate — strongest-tested code in this pass.** All five mutations (boundary `>`→`>=`, dead-pid
  inversion, `EPERM`→`ESRCH`, dropping the pid shape guard, arming-instance inversion) are caught, and
  `liveness.test.ts:30-35` uses a real `process.kill` on a real pid rather than a mock.
- **Whole-process suspend does not (in this run) produce a false ANR.** A 12 s `SIGSTOP`/`SIGCONT` of a child
  running the real watchdog emitted **0** hang reports — on resume the main thread's heartbeat timer refreshed
  the SharedArrayBuffer before the worker's poll read it. Note this is a race between two resumed intervals,
  not a designed guarantee; a *partial* freeze (main thread only, e.g. a debugger breakpoint) is by
  construction reported as a hang.
- **Sampler cost — clean.** 0.109 ms per system-metrics sample; `os.cpus()` per sample costs 0.014 ms.
- **`data-location`** — the `mkdir`-then-`lstat` hardening correctly rejects a non-directory, a
  foreign-uid, and a group/other-accessible root at both the base and leaf level, and is skipped for an
  explicit `dataDir` by design; `hashAppToken` is deterministic 64-bit namespacing with the token kept out of
  the path.
- **Diagnostics test strength — good.** All six diagnostics mutations were caught, including removing the
  `collect()` serialization chain, `stop()` never stopping the profiler, `collect()` never restarting
  sampling, a wrong sampling interval, removing `worker.unref()`, and loosening the hang-rank dedup to `>=`.
- **Full suite integrity after mutation testing:** 13 files / 146 tests pass, and
  `git status --short packages/` is empty — every mutation was restored from a `cp` backup, never via git.
