# Server-tier disk capture: default-on, non-blocking batched writes — DESIGN

**Status:** DESIGN — approach + all forks accepted (durability contract relaxed for servers; never stall the
host; `capturedDataStore` option; **zero-copy/zero-alloc shared-ring** write path). Not yet built. Touches a
BINDING rule ([[persistent-capture-durable-as-captured]]) and the capture hot path → warrants a multi-agent
design review + a benchmark before implementation. Scope: `@bugsee/node` (+ bun/deno, which reuse it);
browser unchanged.

## 1. Problem

File-backed capture (`dataDir` set) today does a **synchronous `appendFileSync` per captured entry on the
host's event loop** (`fs-chunk-storage.ts` ← `file-chunk-backend.ts:appendEntry` ← `chunk-capture-store.add`),
**reopening the file every append** (open+write+close = 3 syscalls/entry), and **double-encodes** each entry
(`JSON.stringify({ t, s: serialized })` re-wraps an already-complete, already-timestamped JSON string). On a
high-throughput backend — where capture volume tracks request volume — this blocks the event loop with
syscalls on the hot path. And disk is **opt-in** (in-memory by default), which is backwards for a server.

Goals: **(a) default to disk on the server runtimes**, and **(b) get the per-entry write off the event loop,
zero-copy and without perturbing the host app.**

## 2. The durability contract (binding-rule change — D1)

The current rule is strict: *`add()` returns ⟹ the byte is on disk, surviving even an instantaneous
`SIGKILL`* — which forces sync-per-entry. The new, **server-tier-scoped** rule:

> Capture is durable with **ZERO loss across any *catchable* termination** — uncaught exception, `SIGTERM`,
> `beforeExit`, explicit `stop()` — via a synchronous flush on that seam. An **un-catchable** termination
> (`SIGKILL`, the OOM-killer delivering no runnable signal, power loss) loses **at most the last flush window**
> (a bounded, sub-second slice set by the flush interval `M`).

Catchable crashes — the common, *reportable* ones, which we already intercept for flush-then-exit — stay
zero-loss. Only a hard kill with no chance to run JS gives up a tiny tail. Tier-scoped: Android/strict
semantics untouched; this relaxation is node/bun/deno only.

## 3. Architecture — a shared, fixed, reused ring drained by a dedicated I/O worker

The write path is a **single fixed `SharedArrayBuffer` ring, allocated once and recycled** — chosen because it
is the only design that is BOTH zero-copy AND zero-allocation: a Transferable `ArrayBuffer` is zero-copy for
the handoff but DETACHES, forcing a fresh allocation per batch (GC churn); a shared ring is encoded *in place*
and reused.

```
 HOST (main) thread                              SHARED RING (one SAB)                 I/O WORKER thread
 ─────────────────                       ───────────────────────────────────         ────────────────────
 capture entry
   store.add(entry)
     • metadata (chunk #, byte             header: [readIdx][writeIdx]                 loop:
       accounting, maxDataSize             [dropped][shutdown/quiesce]                  1. read frames readIdx→writeIdx
       window) — stays MAIN/sync           data: <frames>                               2. group by destination file
     • encode the frame IN PLACE at        frame = [ts:8][len:4][type][payload]  ──▶    3. writevSync(fd_file, [iovecs])
       writeIdx via TextEncoder.encodeInto   (payload bytes encodeInto'd directly         (zero-copy: iovecs are
       (one encode; no string/byte alloc)     into the shared ring — no copy)              ring subarrays; held-open fds)
     • bump writeIdx (Atomics)                                                           4. advance readIdx; Atomics.notify
   returns immediately (NEVER stalls)                                                    5. else Atomics.wait(writeIdx)

 crash/exit seam (uncaughtException / SIGTERM / beforeExit / stop):
   set `shutdown` → notify → wait(quiesce, budget); worker does a final flush + sets quiesce.
   FALLBACK if the worker is wedged: the main thread drains the SHARED residual itself (sync writev) — it can,
   because the ring is shared (a worker-private heap buffer could not be reached).
```

- **Zero-copy / zero-alloc steady state.** Each entry is `encodeInto`'d once, directly into the ring at the
  write index; the worker `writevSync`s straight out of the ring; the region is recycled. No intermediate
  strings/buffers, no per-batch allocation, and the old double-encode is gone.
- **`writev` coalescing (minimize `write()`).** On a flush the worker groups drained frames **by destination
  file** and issues one vectored write per file — the iovecs are subarrays of the ring (zero-copy) — instead
  of one `write()` per entry. (`writev` caps at `IOV_MAX` ≈ 1024 segments/call → split a giant flush.)
- **Flush trigger.** A high-water mark on the ring **or** `M` ms elapsed, whichever first. `M` also bounds the
  hard-kill tail (§2).
- **Two properties this regains** (vs a main-private buffer + transfer): the worker keeps writing **during a
  host hang** (the data already lives in shared memory — no main-thread handoff needed), and the **crash flush
  is robust** (shared ⟹ the main thread can drain the residual if the worker is wedged).
- **What moves vs stays.** Only the **per-entry append** uses the ring/worker. Chunk lifecycle + `meta` writes
  (~1/s, open/close part) stay **synchronous on the main thread** — keeps `maxDataSize`/window accounting
  authoritative. Recovery reads stay main-thread + off the hot path. The worker is a dumb "drain → group →
  writev" executor.

## 4. Backpressure — never the host; shed our own load (D2)

The host's `add` is **always non-blocking** — we never apply backpressure to the customer's process
(perturbing it is unacceptable and, under load, could make things worse). The ring is **fixed size** (no
elastic growth — that would mean allocations, which D7 forbids); under sustained overload it is **drop-oldest**
(advance the read index over the oldest unwritten frames — consistent with the rolling-window / `maxDataSize`
contract; capture is a ring anyway). A `dropped` counter is surfaced as a diagnostic so loss is visible.
Normal + bursty load drops nothing; dropping happens only when the disk genuinely can't keep up, where
shedding *our* capture is correct and stalling the host is never.

## 5. Oversized entries — their own write (D10)

A fixed ring cannot hold an entry larger than itself, and a large-ish entry would evict a pile of small ones
(drop-oldest) just to fit. So a **size threshold** (e.g. > a fraction of the ring): an entry above it
**bypasses the ring** and goes on a one-off path — handed to the worker on its own and `write()`n alone. This
is the *one* place an allocation is accepted: it's rare by definition, proportional to a payload already held,
and batching it would gain nothing (it's already one big write).

## 6. Crash-flush (zero-loss for catchable terminations — D5)

On the crash/exit seam (we already intercept `uncaughtException` for flush-then-exit; add `SIGTERM` /
`beforeExit` / `stop()`): the main thread sets the SAB `shutdown` flag, `Atomics.notify`s the worker, and
`Atomics.wait`s on `quiesce` up to the **shutdown budget** (default 3 s). The worker — checking the flag
between batches (≤ `M` ms apart) — does a final synchronous flush of the ring residual + any oversized in-flight
write, then sets `quiesce`. **If the worker is wedged** (hung disk) and doesn't quiesce within the budget, the
main thread **drains the shared ring residual itself** (sync `writev`) and exits — possible only because the
ring is shared. Either way the catchable-crash window is closed to zero; `M` bounds the un-catchable tail.

## 7. Default-to-disk semantics (D3)

- **New launch option `capturedDataStore: 'memory' | 'disk'`** — default **`'disk'`** on node/bun/deno;
  `'memory'` opts out to the current in-memory path (no disk, no ring, no worker). Browser ignores it (IDB).
- **Default location:** when `'disk'` and no `dataDir`, default to `os.tmpdir()/bugsee/…` with the per-instance
  subtree (`<pid>-<threadId>-<nonce>/`) from [[multi-instance-disk-coexistence]] layered under — disk-by-default
  + multi-instance coexistence compose for free. An explicit `dataDir` overrides the location.
- **Cleanup:** the multi-instance recovery sweep already reclaims *dead-instance* subtrees on launch;
  default-on-disk adds an **age-based (TTL) sweep** of orphaned data from runs that crashed and never
  relaunched, so `tmp` doesn't accumulate.

## 8. Decision log

| # | Decision | Rationale |
|---|---|---|
| **D1** | Relax durability to **catchable=zero-loss / hard-kill=bounded-tail**, server-tier only | Real target is process-crash (page cache + crash-flush), not power-loss (fsync); strict-even-SIGKILL forced sync-per-entry |
| **D2** | **Never** backpressure the host; **fixed** ring, **drop-oldest** under overload (no elastic growth) | Perturbing the customer process is unacceptable; growth = allocations (forbidden by D7); capture is a rolling window so drop-oldest is in-contract |
| **D3** | `capturedDataStore: 'memory'\|'disk'`, default `'disk'` on servers; default path under `os.tmpdir()` | Durable capture out of the box; composes with the per-instance subtree |
| **D4** | Per-entry append → ring/worker; chunk lifecycle + `meta` + recovery stay main-thread (sync, infrequent) | Keeps `maxDataSize`/window authoritative; meta is ~1/s; recovery is off the hot path |
| **D5** | Crash-flush = worker final-flush on `shutdown` signal; main drains the **shared** residual as fallback | Shared ring ⟹ main can take over if the worker is wedged; closes the catchable-crash window robustly |
| **D6** | **Dedicated** I/O worker (not the ANR watchdog reused) | fs writes must not add jitter to hang detection |
| **D7** | **Shared, fixed, reused SAB ring** — encode **in place**; NOT Transferable handoff | Only design that is zero-copy AND zero-alloc; transfer detaches → realloc per batch → GC |
| **D8** | **`writevSync` per file** to coalesce; flush on high-water OR `M` ms; held-open fds | One vectored syscall per file per flush (not per entry), zero-copy from ring subarrays; `M` bounds the tail |
| **D9** | **Encode-in-place compact frame** `[ts][len][type][payload]`; drop the `{t,s}` double-wrap + ts duplication | Smaller + faster + zero-escape; on-disk chunk format changes from NDJSON-of-`{t,s}` → framed records; recovery reader updated (NDJSON-of-`serialized` is the simpler text alternative — lock in slice 1) |
| **D10** | **Oversized entry → one-off write**, bypassing the ring (the one allowed allocation) | Can't fit / would evict the ring; rare; batching it gains nothing |
| **D11** | Accept eventual consistency between `meta` (main, sync) and the data file (worker, async) | Recovery reads data files defensively; the soft drift is tolerable |

## 9. Portability & spikes
`worker_threads` + `SharedArrayBuffer`/`Atomics` are proven on node/bun/deno (ANR watchdog +
[[multi-instance-disk-coexistence]] heartbeat). New spikes before building: (a) `writevSync` from **SAB-backed
views** + held-open fds on a worker, on bun/deno; (b) `TextEncoder.encodeInto` directly into a SAB subarray
(behavior + throughput) on all 3; (c) the `shutdown`/`quiesce` handshake + the main-thread shared-residual
fallback completing within the budget; (d) the variable-length ring with wraparound (a frame spanning the wrap
→ two iovecs).

### 9.1 Spike results — DONE (2026-06-17, node 24 / bun 1.3 / deno 2.8; `/tmp/cap-phase2-spikes/`) — ALL GREEN
- **(a) SAB-view `writevSync`** — `writevSync(fd, [sab.subarray(...), …])` writes the SAB-backed iovec and
  round-trips byte-exact on **node + bun + deno**. ✓
- **(b) `encodeInto` into a SAB subarray** — `new TextEncoder().encodeInto(frame, sab.subarray(off))` reports
  the full `read` + correct utf8 `written` (é/ö = 2 B) and the SAB is reused in place (same buffer identity
  after `fill`) on all 3. ✓ Zero-copy encode-in-place is viable.
- **(c) shutdown/quiesce handshake + main-thread fallback** — a worker drains the shared ring via `writevSync`
  to a held fd; on a `SHUTDOWN` Atomics flag it flushes the residual + acks (`Atomics.store`+`notify`). Clean
  shutdown loses nothing; a deliberately-WEDGED worker (never acks) → the main thread reads the shared ring
  residual (`ring.subarray(head, tail)`) and writes it ITSELF → **zero loss on all 3 even with a hung worker**. ✓
- **`Atomics.wait` on the MAIN thread** is permitted (returns `timed-out`) on **node + bun + deno** — usable
  for the efficient blocking shutdown wait (no busy-poll). ✓
- **⚠ Cross-runtime nuance (actionable):** `worker.terminate()` does NOT resolve for a wedged/idle worker on
  **bun** (`terminate-timeout`), while node/deno resolve it. → The shutdown path must **bound `terminate()`**
  (`Promise.race` with a timeout) or fire-and-forget it; never block shutdown on it. Does NOT affect zero-loss
  (the shared-residual drain runs BEFORE terminate). (d) wraparound was not spiked separately — linear-region
  iovecs are proven; the wrap is a two-iovec slice of the same proven primitive, deferred to the build.

- **⚠⚠ DECISIVE (spike D): cross-thread fd sharing FAILS on deno.** main-thread `openSync` → worker
  `writevSync(fd)` round-trips on **node + bun** (worker_threads share the process fd table) but THROWS
  `EBADF "Bad file descriptor"` on **deno** (its workers do NOT share the fd table). → The clean "main owns the
  fd + seal/close + read; worker is a dumb drain" model is NOT portable. The **WORKER must own ALL data-file
  fd lifecycle** (open/writev/close), which spike C already proved works on all 3 — but it means a real
  main↔worker **control protocol** (register-path→id, seal-chunk, remove-chunk, flush-and-ack for the
  incident-time snapshot read) rather than shared fds. This ≈doubles the worker's coordination complexity vs.
  the design's assumption.

**Verdict: the Phase-2 primitives are viable on all three runtimes**, BUT spike D materially raises the
off-thread-worker cost: the worker must own every data-file fd + a control protocol (deno can't share fds).
The shared-ring + drop-oldest + encode-in-place value (D2/D7 — never stall the host, zero-alloc) is achievable
on the MAIN thread with NONE of that complexity; only moving the write() syscall off-thread (D6) incurs it.
Constraints surfaced: bounded-`terminate()` (bun) + worker-owns-fds (deno).

## 10. Benchmark — DONE (2026-06-17, node 24, Apple SSD; `/tmp/cap-write-bench/`)

Event-loop delay (`perf_hooks.monitorEventLoopDelay`) under capture writes, ~300 B entries:

| | fast SSD (page cache) | adverse (write BLOCKS on I/O — fsync proxy) |
|---|---|---|
| **sync `appendFileSync`/`writeSync` per entry** | p99 ~1 ms, **max ~7 ms** @20k/s; ~135k syscalls/s | **4882–7046 ms** freezes; can't keep up (450–595/s) |
| **batched `writevSync`** (held fd, HWM 64 KB) | p99 ~1 ms, max ~5.6 ms; **~330× fewer syscalls** (410 vs 135k) | **p99 1–5 ms, max 7–10 ms**, keeps full throughput |

**Findings.** (1) Per-entry sync is harmless on a *fast local* SSD but produces **multi-second event-loop
freezes the moment a write blocks on I/O** (slow/contended/network FS, writeback pressure) — and you can't
assume the customer's disk is fast. (2) **Batching is the high-leverage fix**: held-fd + `writev` coalescing
turns the *catastrophic* case (5 s freeze, can't keep up) into a **~10 ms max at full throughput** — a ~700×
tail improvement, **no worker**, low complexity. (3) The off-thread worker is therefore **insurance**, not a
throughput necessity: it removes the residual ~10 ms tail under adverse I/O + adds hang-resilience. (Caveat:
`fsync` over-states our page-cache path, but is a valid proxy for a blocking write; node-only — confirm the
OS-driven cliff on bun/deno.)

**Conclusion → two phases** (the benchmark justifies phasing: Phase 1 alone removes ~99% of the danger).

## 11. Slice plan — TWO PHASES

**Phase 1 — batched main-thread writes (high value, low risk; captures the dramatic majority of the win) — DONE (2026-06-17):**
1. ✅ **Batched file writer** in node-utils (`batched-fs-chunk-storage.ts`, `b477b52`) — held-open fds per
   chunk file + per-path buffer + `writevSync` coalescing on a 64 KB high-water mark; `flushSync()` for the
   crash seam; `sealChunk`/`dispose` flush+close fds on chunk close. Oversized single entry → its own flush.
   IOV_MAX-capped vectored writes.
2. ✅ **Encode-in-place frame (D9)** (`file-chunk-backend.ts`, `803b96a`) — dropped the `JSON.stringify({t,s})`
   double-wrap + ts duplication for the flat `<timestamp>\t<serialized>\n` frame (NDJSON-of-`serialized`, the
   text alternative; locked). Snapshot reader splits on the first tab + skips torn/foreign lines.
3. ✅ **`capturedDataStore` default-to-disk (D3)** (`data-location.ts` + `sweep-instances.ts` + `launch.ts`,
   `5bc58b5`) — `capturedDataStore: 'memory'|'disk'` (default `'disk'`); default root `os.tmpdir()/bugsee`;
   age-based (7-day) TTL hygiene sweep of abandoned sibling subtrees, run before recovery. Re-baselined the
   in-memory-default tests.
4. ✅ **Flush-on-exit wiring** (`launch.ts`, `b5972d1`) — `flushSync()` on node's `'exit'` hook (the last
   synchronous chance), plus the existing uncaughtException + stop()/dispose() flushes. NOT a SIGTERM handler
   (that would swallow the signal — [[interceptors-must-not-alter-app-behavior]]); `'exit'` is non-intrusive.
5. ✅ **e2e validation** (`instrumentation-tests`) — the full real-process battery (node/bun/deno) now runs on
   disk-by-default and passes; a new **disk-recovery** scenario proves the headline claim end-to-end: an
   incident that crashed BEFORE its bundle assembled is rebuilt next launch from the marker + the durable
   capture chunks, carrying the pre-crash breadcrumb. **Host-lag:** validated by the §10 benchmark (batched
   `writev` keeps p99 1–5 ms / max 7–10 ms even under fsync-proxied blocking I/O), NOT a CI assertion — a
   wall-clock lag gate is machine/CI-timing-dependent and would flake; the benchmark is the durable basis.
6. ✅ **Docs + memory** (this section + PROGRESS.md + [[server-disk-capture-write-path]] memory).

**Phase 2 — off-thread worker + shared ring (insurance) — BUILT + reviewed-to-convergence (2026-06-18, opt-in via `captureWriter: 'worker'`):**
7. ✅ **Spikes (§9.1)** — SAB-view `writev` + `encodeInto`-into-SAB + the worker drain/handshake + the
   main-thread fallback all GREEN on node/bun/deno; surfaced the bun-`terminate()` + **deno-can't-share-fds**
   constraints → the worker OWNS all data-file fds (path-derived `pathId`, no register channel).
8. ✅ **The write path** (six slices in `@bugsee/node-utils`): `capture-ring.ts` (the shared SAB byte-ring —
   zero-copy reserve/commit/peek/consume, wrap-pad, **drop-oldest with a lock-free Dekker read-cursor**);
   `capture-ring-drainer.ts` (the worker-side drain→fds + pathId codec); `capture-ring-writer.ts` (the drop-in
   `ChunkStorage` + `createSyncRingWorker` default/fallback); `worker-ring-worker.ts` (the off-thread
   worker_threads `RingWorker` — inline eval string mirroring the tested consumer + the `Atomics` flush-ack /
   bounded-shutdown handshake); wired into `launch.ts` (`captureWriter: 'worker'`, opt-in). Oversized records +
   foreign-gen/unknown-type → a main-thread fallback. Meta/read/seal/remove stay main-thread (D4) with
   flush-and-ack first (so no resurrection/reorder).
9. ⏳ **Adverse-I/O e2e** (deferred) — the off-thread path is validated by a real-worker drop-storm integration
   test (real worker_threads + real Atomics + real fs, byte-integrity under heavy concurrent drops) + the
   spikes on all 3 runtimes; a real-PROCESS adverse-I/O + cross-runtime `'worker'` e2e scenario is the
   remaining incremental confidence.
10. ✅ **Docs + memory** (this section + [[server-disk-capture-write-path]]).

**Convergent review (3 rounds, 2026-06-18) — CONVERGED.** Round 1 found a CRITICAL two-thread ring race
(C1/C2: `READING` protection published after the HEAD observation → torn read / backward HEAD) + ordering /
lifecycle / test gaps. The C1/C2 fix (claim-then-verify + `compareExchange` HEAD advances + cached consume
size) was found INCOMPLETE in round 2 — a residual **store-buffer (Dekker) race** survived (the producer set
HEAD but never re-checked READING). Round 3 verified the **symmetric Dekker completion** (producer re-checks
READING after its drop-CAS; both sides set-flag-then-check-other) **fully CLOSES the race** — proven rigorous
against the JS `Atomics` seq-cst model: in every total order at least one side detects the conflict (consumer
VERIFY sees advanced HEAD → retries, or producer post-check sees READING → backs off with a bounded, counted
spurious drop). All ordering/lifecycle/test findings fixed (removeChunk/oversized flush-first; unref'd
terminate timer; multi-byte-utf8 append test; the drop-storm integration test). The concurrency-only branches
are `v8 ignore`-annotated; the off-thread worker is INSURANCE — the Phase-1 batched writer remains the default
live path.

## 11b. Phase 2 detail — off-thread worker + shared ring (NOT STARTED; the Phase-1 batched writer is the live path)
(each: spike/benchmark as needed → test-first → mutator → multi-agent review → commit)
0. **Spikes + benchmark** (§9/§10) — de-risk SAB-view `writev` + the handshake; pick the knobs from data;
   decide (3) vs (4); lock the on-disk frame format (D9). NOTE — the frame format is already locked by
   Phase-1 slice 2 (D9, the `<timestamp>\t<serialized>\n` NDJSON frame); Phase 2 keeps it.
1. **`CaptureRingWriter`** (node) — main-side API (`append(path, ts, type, bytes)`, `flushSync`, `stop`) +
   the shared ring (encode-in-place, drop-oldest, `dropped`) + the dedicated worker (drain → group →
   `writevSync`, held-open fds) + the oversized side-channel.
2. **Wire into the fs chunk path** — `file-chunk-backend.appendEntry` routes through the writer; the frame
   format (D9); meta/lifecycle stay sync; recovery reader updated to the new frame.
3. **Crash-flush** — the `shutdown`/`quiesce` handshake + shared-residual fallback on the
   uncaught/SIGTERM/beforeExit/stop seam, integrated with flush-then-exit.
4. **`capturedDataStore` default-on-disk** + default `os.tmpdir()` path + the TTL cleanup sweep; re-baseline
   tests that assumed the in-memory default.
5. **Real-process e2e** — high-rate capture in a real node/bun/deno process: no host event-loop-lag
   regression (within a budget), a `kill -9` mid-stream loses ≤ the window, a catchable crash loses nothing.
6. **Docs + memory.**

## 11c. Phase-1 review hardening (2026-06-17, commits 302e1f5…3cac369) — CONVERGED over 4 rounds
The multi-agent convergent review of Phase 1 ran **4 rounds** (round 1: real defects → R1-R3; round 2: LOW →
R4 + the R5 test-hermeticity flake; round 3: impl declared converged, test gaps → R6; round 4: CONVERGED,
one non-blocking edge → R7). Every real finding was fixed test-first + mutator-verified. The fixes:
- **Batched-writer robustness (R1):** honor `writevSync`'s short-write contract (loop, don't truncate);
  a throwing flush no longer leaks the fd (flush never throws → routes to onError + keeps the buffer for
  retry; `flushSync` stays per-file resilient). Injectable `onError`/`writev`/`close` seams.
- **Test gaps (R2):** an embedded-tab payload round-trip (locks the first-tab split) + a stale-`.live`
  dead-pid reclaim (locks the heartbeat-freshness branch).
- **Default-on-disk safety (R3):** (a) **graceful degradation** — any fs failure setting up the data root
  (contended/read-only/full tmp) is caught and the launch DEGRADES to in-memory; an SDK must never crash the
  host. (b) **Per-app-token root** restored (`os.tmpdir()/bugsee/<hash>`, sdk-design §12.5) so two apps
  sharing a host never recover/sweep each other's data through the wrong token (a synchronous dependency-free
  `hashAppToken`, NOT `node:crypto`, so launch's source still typechecks inside the framework adapters).
  (c) The hygiene sweep now requires a valid `owner.json` marker before a recursive delete — a foreign
  instance-shaped dir (e.g. `2024-01-02`) is never reaped.
- **Test hermeticity (R5):** the framework-adapter + node-umbrella integration tests now pin
  `capturedDataStore: 'memory'` — under disk-default they were racing on the shared per-app-token root across
  parallel vitest workers (intermittent full-suite failure). They test context/error capture, not storage.
- **Buffer-consume-in-place (R7):** `writeAll` consumes the writer buffer in place, so a partial-write-then-
  throw leaves only the unwritten tail buffered — the retry never duplicates an already-written prefix into
  the append-mode file (closes the one edge the final round flagged).
- **Test strength (R2/R4/R6):** embedded-tab frame round-trip; stale-`.live` reclaim; hashAppToken golden
  vector + both-passes pin; sweep TTL-discrimination at the launch level; degradation proves a WORKING
  in-memory store; writev no-progress guard + the partial-then-throw no-dup proof.

**Deferred (defense-in-depth, not blocking):** explicit `uid`-gating of the sibling recovery/sweep on a
shared multi-USER `/tmp` (the `0700`/`0600` modes already make cross-user read/delete fail-with-EACCES and
the graceful-degradation absorbs the create-EACCES, so this is hardening, not a live hole); a verify-root-
ownership check against a pre-created hostile tmp root.

## 12. Risks / deferred
- **Disk permanently slower than capture** → sustained drop-oldest (by design; surfaced via `dropped`). The
  alternative (stall the host) is explicitly rejected. (Phase-1 main-thread writer: an unwritable disk keeps
  the buffer in RAM + routes to onError; bounded in practice by the store's part rotation — the Phase-2 ring
  adds true drop-oldest.)
- **Worker RSS** (~5–12 MB) added to every server process by default — acceptable; revisit if it matters.
- **SAB-view `writev` correctness** — the main thread must not overwrite a region the worker is mid-write on
  (drop-oldest must not evict into the in-flight read region) — handled by the read-index ownership; a spike
  target (§9a/d).
- **Deferred:** an `fsync`/power-loss-durable opt-in mode; browser/IndexedDB write path (already async);
  reusing one worker for ANR+I/O (rejected, D6); a per-chunk path→id registry to shrink ring frames.
