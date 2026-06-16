# Multi-instance on-disk coexistence + recovery (worker_threads & multi-process) — DESIGN

**Status:** DESIGN — approach accepted (liveness = Hybrid PID-probe + heartbeat; scope = on-disk only).
Grounded in two read-only explorations: the **Bugsee Android SDK** canonical multi-process logic
(`com.bugsee.library` NDK crash store) and our current Node on-disk model. Android-canonical (design rule).
Build via the standard slice loop (test-first → mutator → multi-agent review → commit/push).

## 1. Problem & goal

The SDK now wants to run as **multiple concurrent aggregators** sharing one `dataDir`:
- **multi-thread** — several `worker_threads` in ONE process, each calling `launch()` (each worker has its
  own `globalThis`/carrier, so the per-process singleton does NOT collapse them);
- **multi-process** — several OS processes (a server cluster, a `:worker` process) pointed at one `dataDir`.

**Goal.** Each aggregator's capture/queue/incident data must (a) **coexist on disk without corruption**, and
(b) **upon an incident be picked up and delivered exactly once** — including incidents from an instance that
**died** (crash / OOM-kill / hard exit), recovered opportunistically by any surviving or later instance.

**Non-goals (this milestone).** In-memory **session sharing** (workers forwarding reports/breadcrumbs to the
main-thread client for ONE aggregated session) — a separate follow-up that overlaps the `@bugsee/webworker`
"forward to parent" design. Here each aggregator is its own session; only its *disk data* coexists + recovers.

## 2. What breaks today (confirmed)

Everything is keyed by `dataDir` + `generation = clock.wallNow()` at launch, with **no per-instance identity**
(`launch.ts:377`, `fs-chunk-storage.ts:30-34`, `report-marker-store.ts:18`, `bundle-store.ts:15`). Two
aggregators on one `dataDir`:
- **same-ms generation collision** → both append to the SAME chunk files **non-atomically** → torn JSON lines
  → silent capture loss (`fs-chunk-storage.ts:37`);
- **recovery sweep assumes every non-current generation is dead** → it would rebuild **and delete a live
  sibling's** generation (`capture-recovery.ts:110-118` — the critical defect);
- **shared `pending/` + `incidents/`** → both `recover()` the same bundle / pick up the same marker →
  double-send + cleanup races.

## 3. Android canonical (the reference)

- **Per-process subtree** `<root>/ndk/p<PID>-<monotonicHex>/` — PID + monotonic stamp = globally unique;
  each process writes only inside its own subtree (`BugseeDetectionCrashNdk.java:175-187`).
- **Liveness = exclusive OS `FileLock` on `.live`**, held for the process lifetime, auto-released on death;
  a peer detects an orphan when `tryLock()` SUCCEEDS (`:814-844`).
- **Opportunistic recovery** — ANY live process recovers ANY dead process's subtree (`:984-1014`).
- **Claim = exclusive `.proc.lock` + atomic rename `marker → marker.processing`**; backend dedups by
  `(uuid, timestamp)`; success → delete subtree, failure → keep for retry (`:1041-1124`).

The one piece that does NOT port: Java's `FileChannel.lock()` (an OS advisory lock auto-released on death) has
**no portable JS equivalent** without a native addon — which would violate our #1 rule (runtime-portable).
D2 replaces it.

## 4. Decision log

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Per-instance subtree, always.** `<dataDir>/<instanceId>/{capture,pending,incidents}` + `.live` + `owner.json`, with `instanceId = <pid>-<threadId>-<nonce>` (`threadId` from `node:worker_threads`, `0` on the main thread; `nonce` = short random hex per launch). Uniform for a single instance (just one subtree). | Eliminates generation-collision + interleaved-append corruption **by construction** — each aggregator owns its files outright. `threadId` separates worker_threads in one process; `nonce` separates relaunch / stop-relaunch and avoids PID-reuse path aliasing. |
| **D2** | **Liveness = Hybrid PID-probe + heartbeat.** A sibling is DEAD iff `pidGone(owner.pid)` **OR** `heartbeatStale(.live)`. **Two-tier thresholds:** reclaim **instantly** on `pidGone`; reclaim **patiently** (default ~120 s, configurable) on `alive-pid + stale-heartbeat`. `pidGone` = `process.kill(pid, 0)` throws `ESRCH`. `heartbeatStale` = `now − mtime(.live) > threshold`. | `kill(pid,0)` gives instant, hang-CORRECT reclaim of a dead PROCESS (a hung process is still a live pid → not reclaimed). Heartbeat covers what the probe can't: a dead **worker_thread** in a live process, and **PID reuse** (a recycled pid isn't touching OUR `.live`). The patient threshold protects the only ambiguous case (alive pid + stale beat). Fully portable, **zero native**. |
| **D3** | **Heartbeat carrier = the ANR watchdog worker thread.** Extend the existing watchdog worker (`event-loop-watchdog.ts` WORKER_SCRIPT, already a self-timed `setInterval`) to also touch `.live` (`fs.utimesSync`) each tick. Main-thread fallback (a plain interval) when `detectHangs:false`. | A worker-thread heartbeat **survives a main-thread hang** (the exact false-positive to avoid). detectHangs is default-ON (node-diagnostics), so the hang-proof path is the default. The residual (intra-process hung instance with detectHangs OFF) is bounded by the patient threshold and covered cross-process by `kill(pid,0)`. No second worker (the ANR worker's ~5–12 MB is already paid). |
| **D4** | **Opportunistic cross-instance recovery, reusing the existing pipeline.** On launch: scan sibling subtrees; for each **dead** one → claim → run the **existing** `recoverReports` (markers→bundles from its chunks) + `durableUploadPipeline.recover()` (its `pending/` queue) pointed at that subtree → `rm -rf`. Never touch a live sibling or self. | This is Android's "any live process recovers any dead one". The bulk is **existing code aimed at a sibling dir** — the new surface is only the scan + liveness + claim. An instance's own prior crashed run is just a dead sibling (same pid, different nonce) → recovered by the same path; the old "prior generations in my own dir" logic is subsumed. |
| **D5** | **Claim = atomic rename; backend `request.signatures` dedup = the backstop.** Claim a dead subtree with `rename(<sub>, <sub>.reclaiming-<myId>)` (POSIX-atomic, one winner; loser gets `ENOENT`). A claimer that dies mid-reclaim leaves a `.reclaiming-*` dir = just another dead subtree next launch. | No bulletproof lock needed → no native addon. A rare double-upload (two peers race) is deduped **server-side by report signatures** — parity with Android's `(uuid,timestamp)` dedup; the Option-A stance already in our capture-recovery plan ("a transient duplicate beats losing a crash"). |
| **D6** | **Scope = on-disk coexistence + recovery only.** In-memory session forwarding deferred. | Matches the stated precaution exactly; keeps the slice small and the disk-correctness independently shippable. |
| **D7** | **All three runtimes, spike-gated.** `node:worker_threads.threadId` + `process.kill(pid,0)`/`ESRCH` + the watchdog-worker `fs.utimes` touch verified on real Node, Bun, Deno (slice 0) — same de-risk discipline as the incoming-server native wraps. | Bun/Deno node-compat coverage of these specific APIs is the only real unknown; a 30-line spike removes it before we build. |
| **D8** | **No migration (unreleased).** Flat `<dataDir>/{capture,pending,incidents}` → `<dataDir>/<instanceId>/…` outright. | No external consumers. (An optional one-time "adopt pre-existing flat data as an orphan instance" sweep is a trivial later add if ever needed.) |
| **D9** | **Carrier singleton unchanged.** A 2nd launch in the SAME thread still returns the first client; worker_threads have separate carriers → each launches its own aggregator (intended). | The `nonce` also disambiguates a `stop()`+relaunch in one thread (a fresh subtree). |

## 5. Architecture

```
<dataDir>/<pid>-<threadId>-<nonce>/        # one aggregator (the "instance subtree")
    owner.json     { pid, threadId, startedAt, version, instanceId }
    .live          # mtime = heartbeat (touched from the watchdog thread; D3)
    capture/       # existing ChunkStorage, now rooted per-instance
    pending/       # existing BundleStore (durable queue)
    incidents/     # existing ReportMarkerStore
```

New components (all in `@bugsee/node`, pure/injectable where possible):
- **`instanceLayout`** — derive `instanceId` + the subtree paths; write `owner.json`.
- **`liveness`** — `readOwner(sub)`, `pidAlive(pid)` (`kill(pid,0)`; `EPERM`→alive, `ESRCH`→gone), and the
  **pure** predicate `isSiblingDead(owner, liveMtimeMs, nowMs, { staleMs, patientMs })`.
- **heartbeat** — extend the watchdog WORKER_SCRIPT to `fs.utimesSync(livePath,…)` per tick (livePath via
  `workerData`); main-thread fallback interval when the watchdog is absent.
- **`recoverInstances`** — scan siblings → for each dead one: claim (rename) → `recoverReports(...)` +
  `durable.recover(...)` over the claimed subtree → remove. Wraps/replaces the single-dir recovery call in
  `launch.ts`.
- **`launch.ts` wiring** — build `instanceId`; root the capture store / bundle store / marker store at
  `<dataDir>/<instanceId>/`; start the heartbeat; after `client.launch()` run `recoverInstances` (instead of
  the current "recover my own prior generations").

### Subtree state machine
```
LIVE (owner.json + fresh .live, pid alive)
  → ORPHANED (pid gone, or .live stale past threshold)        # detected by a peer at launch
  → CLAIMED  (renamed to .reclaiming-<peer>)                  # atomic; one winner
  → RECOVERED (markers rebuilt+enqueued, pending re-uploaded) # existing pipeline
  → REMOVED  (rm -rf)                                          # on success
A claimer crash between CLAIMED and REMOVED → the .reclaiming-* dir is itself ORPHANED next launch.
```

## 6. Slice plan (each: test-first → per-entity mutator → multi-agent review → commit/push)

0. **Spikes — DONE (2026-06-17).** Verified on real Node 24 / Bun 1.x / Deno 2.x (all ✓, zero native):
   `worker_threads.threadId` = `0` main / `1` worker; `process.kill(self,0)` → ALIVE, `process.kill(999999,0)`
   → **`ESRCH`**; and the worker keeps `fs.utimesSync`-touching `.live` (mtime advanced ~285 ms) **while the
   main thread was busy-blocked 300 ms** — the watchdog-thread heartbeat survives a main-thread hang on all
   three. The hybrid liveness mechanism is portable with no addon.
1. **Instance layout** — `instanceId` + subtree paths + `owner.json`; root all three stores at the subtree in
   `launch.ts`. (Single-instance still works, just nested one level; existing suites stay green.)
2. **Liveness primitives** — `readOwner` / `pidAlive` / pure `isSiblingDead` (two-tier thresholds). Heavy unit
   coverage incl. ESRCH/EPERM, stale vs fresh, the patient-vs-instant branches.
3. **Heartbeat** — watchdog-worker `.live` touch (+ main-thread fallback); assert mtime advances from the
   worker while the main thread is blocked.
4. **`recoverInstances`** — sibling scan + atomic-rename claim + delegate to existing `recoverReports` /
   `durable.recover` per dead subtree + remove; wire into `launch.ts`. Tests: dead sibling recovered once;
   live sibling untouched; claim race → single winner; claimer-crash dir re-reclaimed.
5. **Real-process e2e** (`@bugsee/instrumentation-tests`) — spawn concurrent aggregators (a 2nd process **and**
   a worker_thread) on one `dataDir`; one dies mid-incident; a later launch delivers exactly its incident,
   leaves live siblings’ data intact, no corruption, no double-send (signature dedup). Across node/bun/deno.
6. **Docs + memory** — fold into PROGRESS.md / CLAUDE.md; memory note.

## 7. Risks / open caveats
- **PID reuse window** — between a death and the heartbeat going stale, a recycled pid reads as "alive". Bounded
  by `patientMs`; never causes data loss (just delayed reclaim).
- **Cross-machine `dataDir`** (a shared network mount) — `kill(pid,0)` is meaningless across hosts and mtime is
  subject to clock skew. v1 assumes **same-machine**; cross-host is a documented limitation (heartbeat-only,
  skew-tolerant thresholds) if we ever pursue it.
- **`detectHangs:false` + intra-process hang** — the only path without a hang-proof heartbeat; bounded by
  `patientMs` and, for the duplicate it might cause, by signature dedup.
- **`EPERM` from `kill(pid,0)`** — a pid we may not signal still EXISTS → treat as **alive** (conservative).

## 8. Deferred
- In-memory session sharing / report forwarding (workers → main client, one session) — separate design.
- Cross-machine shared `dataDir` support.
- "Adopt pre-existing flat-layout data" migration sweep (only if a pre-release dataset ever needs it).
