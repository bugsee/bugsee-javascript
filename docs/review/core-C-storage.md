# Adversarial review — @bugsee/core, Pass C (capture stores / chunk backends / ring)

**Reviewed:** 2026-07-26 · **Scope:** `packages/core/src/` —
`chunk-capture-store.ts` (115/73 test), `chunk-storage.ts` (107/86), `chunk-backend.ts` (62/**no test**),
`file-chunk-backend.ts` (152/184), `memory-chunk-backend.ts` (92/106), `file-capture-store.ts` (44/303),
`memory-capture-store.ts` (25/215), `streaming-capture-store.ts` (101/100), `ring-buffer.ts` (69/134),
`dedup.ts` (31/59), `report-marker-store.ts` (37/8). Read-for-context (not reviewed): `capture-snapshot.ts`,
`capture-exporter.ts`, `capture-recovery.ts`, `client.ts`, `capture-aggregator.ts`,
`node-utils/batched-fs-chunk-storage.ts`, `node/launch.ts`, `browser-utils/idb-chunk-backend.ts`.

**Verdict:** The binding **durable-as-captured** rule holds exactly where it must. `chunk-capture-store.ts`
keeps *only* `{ref,start,end,byteSize,count}` per part in RAM (`chunk-capture-store.ts:25-31,43`) and calls
`backend.appendEntry` synchronously on every `add` (`:74-81`); `file-chunk-backend.appendEntry` issues
`storage.append` on every entry with no buffering (`file-chunk-backend.ts:84-91`). All buffering lives
*below* core in `node-utils/batched-fs-chunk-storage.ts` — the correct (server) tier, and the reader flushes
before every read (`batched-fs-chunk-storage.ts:198-203`), so the incident/report path is never short. I
found **no SEV1**: no path buffers entries in RAM before the durable write, no eviction can delete a chunk a
reader holds (both core backends read eagerly at `snapshot()`; the async IDB backend uses an explicit
pin/deferred-delete), and corruption is isolated per *record*, never per session. The test suite is
genuinely strong — of 33 targeted mutations only 4 survived, and all 4 are unobservable-today contract or
assertion gaps rather than live bugs. What is wrong is narrower: the file backend's `stream()` is **not
chronological** (empirically proven; it violates `CaptureSnapshot.stream()`'s documented contract and
diverges from the memory backend), and the design doc's "zero loss on **SIGTERM**" durability guarantee is
**not delivered** by the node wiring (empirically proven that `process.on('exit')` does not run on a
default-disposition SIGTERM). `chunk-backend.ts` having no test file is defensible — it is 100% type-only,
zero executable statements. `report-marker-store.ts`'s "8 test lines for 37 impl" is a **false premise**:
the file is an interface + one `serviceToken` call; the real markers live (and are well tested) in
`node-utils`/`browser-utils`.

## SEV1

None.

## SEV2

### 1. The file-backed `stream()` is NOT chronological — it violates the documented `CaptureSnapshot` contract and diverges from the memory backend

- **Where:** `packages/core/src/file-chunk-backend.ts:111-139` (specifically the nested loop at `:115-116`),
  against the contract at `packages/core/src/contracts.ts:124`
  (`/** Stream the snapshot's records one-by-one (oldest-to-newest across parts). */`).
- **What:** `snapshot()` iterates *parts*, then *files within a part*, emitting every record of one file
  before touching the next. Records are therefore grouped **by FileType**, not ordered by time, within each
  part. `memory-chunk-backend.ts:69-80` iterates the part's flat append-ordered list and *is* chronological.
  Two implementations of the same interface return different orderings for the same input.
- **Why it matters:** `stream()` is exported public API (`CaptureExporter.stream()`, `contracts.ts:153`;
  `capture-exporter.ts:31-52`). Any consumer that trusts the documented ordering silently gets correct
  results on the memory/edge tier and **wrong-ordered** results on the node/disk tier — the tier where the
  bug is hardest to reproduce. The bound on severity: `grep` shows **no production consumer of
  `exporter.stream()` in the monorepo today** (only tests); bundle assembly goes through
  `drainAll()`/`capture-drain.ts:14`, which regroups by type and is therefore unaffected. So this is a
  latent trap, not a live defect.
- **Evidence (empirical, run against the real source via `tsx`):** same three records
  (`log@10000, network@10001, log@10002`) added to each store, then read via `snapshot().stream()`:
  ```
  MEMORY stream(): ["log@10000","network@10001","log@10002"]  chronological=true
  FILE   stream(): ["log@10000","log@10002","network@10001"]  chronological=false
  ```
  No test asserts `stream()` ordering for the file store — `file-capture-store.test.ts` has no analogue of
  `memory-capture-store.test.ts:44-55` ("stream yields records one-by-one, chronologically across parts"),
  which is exactly the assertion that would have caught this.

### 2. The documented "zero loss on SIGTERM" durability guarantee is not delivered (node tier)

- **Where:** `docs/design/server-disk-capture-write-path.md:24-27` (the binding contract) vs
  `packages/node/src/launch.ts:762-774` (only a `'exit'` hook is installed) and
  `packages/node/src/system-events.ts:85-92` (the SDK's SIGTERM listener removes itself and **re-raises**).
  *Outside this pass's file scope (node tier, not `packages/core/src`) — reported here because the mandate
  asks whether the code's actual durability behavior matches the doc.*
- **What:** The doc states: *"Capture is durable with **ZERO loss across any catchable termination** —
  uncaught exception, `SIGTERM`, `beforeExit`, explicit `stop()` — via a synchronous flush on that seam."*
  The build log in the same doc (`:206-208`) then records the opposite decision: *"`flushSync()` on node's
  `'exit'` hook … **NOT a SIGTERM handler** (that would swallow the signal)."* Node's `'exit'` event does
  **not** fire when the process is terminated by a default-disposition signal, and the system-events source
  deliberately re-raises SIGTERM after de-registering — which also terminates by default disposition. No
  `flushSync()` runs on either path.
- **Why it matters:** SIGTERM is the standard container/orchestrator shutdown (`docker stop`, k8s pod
  termination). On every such shutdown the batched writer's unflushed buffer (bounded by
  `CAPTURE_FLUSH_MS = 1000`, `packages/node/src/launch.ts:107`, and by the per-tick `sealChunk` flush) is
  discarded. Impact is bounded: an *incident* already forces a flush (every `read()` flushes first,
  `batched-fs-chunk-storage.ts:200`), so a report assembled before the signal is complete; what is lost is
  up to ~1 s of the rolling buffer, which only matters for a report recovered on a later launch.
- **Evidence (empirical):** a plain node process with `process.on('exit', …)` writing a proof file, sent
  `kill -TERM`: the proof file was **never created** → the exit hook did not run. Either the doc's §2
  contract should be narrowed to "uncaughtException / clean exit / `stop()`", or a SIGTERM seam that flushes
  and re-raises is needed.

## SEV3

### 3. `file-chunk-backend.snapshot()` silently ignores `FrozenPart.count` — a documented contract field, untested in both directions

- **Where:** `packages/core/src/file-chunk-backend.ts:115` (`for (const { ref } of parts)` — `count` is
  destructured away) vs the contract at `packages/core/src/chunk-backend.ts:30-34`
  (*"Records to include, oldest-first — the part's entry count at snapshot time (open-part boundary)"*).
- **What:** The other two implementations honor it (`memory-chunk-backend.ts:74`,
  `browser-utils/idb-chunk-backend.ts:215`). It is currently unobservable in the file backend because the
  read is eager **and** synchronous — nothing can be appended between `chunk-capture-store.ts:104` building
  the `FrozenPart[]` and `:105` reading it. It is also *not* load-bearing for recovery, which explicitly
  passes `count: Number.MAX_SAFE_INTEGER` (`capture-recovery.ts:64`).
- **Evidence:** mutation **M19** — rewriting `snapshot()` to *honor* `count` — **survived the entire
  683-test core suite**. Neither behavior is pinned, so a future async/lazy file backend could silently
  break isolation with no test failing.

### 4. Test theater: the "skipping meta" assertion does not exercise the meta-skip branch

- **Where:** `packages/core/src/file-chunk-backend.ts:117-119` (the `if (file === META_FILE) continue;`
  guard); test `file-chunk-backend.test.ts:113-126` ("snapshot reads each frozen part data file
  (skipping meta), oldest-first"; `:125` comment "meta excluded").
- **What:** Deleting the guard entirely changes nothing, because the meta JSON contains no tab and is
  therefore dropped by the torn-line guard at `:126-129` instead. The test's stated purpose is not
  validated by its assertion. The line is covered (v8 branch coverage is satisfied) but its *outcome* is
  not asserted — coverage without verification.
- **Evidence:** mutation **M12** (`if (file === META_FILE)` → `if (false)`) **survived**.

### 5. `FrozenPart.count`'s exact value is not pinned by any core test

- **Where:** `packages/core/src/chunk-capture-store.ts:104`
  (`parts.map((part) => ({ ref: part.ref, count: part.count }))`).
- **What:** Off-by-one in the snapshot boundary is invisible to core tests because both core backends clamp
  (`memory-chunk-backend.ts:74`: `i < count && i < records.length`) or ignore it. For the **async** IDB
  backend, `count` is the real isolation boundary — `count + 1` would leak one post-snapshot entry into a
  frozen view.
- **Evidence:** mutation **M6** (`count: part.count + 1`) **survived**.

### 6. `memory-chunk-backend.removeGeneration` prefix matching is not pinned

- **Where:** `packages/core/src/memory-chunk-backend.ts:56-66` (`k.startsWith(prefix)` on keys of the form
  `` `${gen}/${number}` ``).
- **What:** The implementation is **correct**; the tests do not distinguish it from a substring match.
  Weakening it to `includes` would make `removeGeneration(0)` also delete generation `10`'s parts
  (`"10/5".includes("0/")` is true). Unreachable today only because `createMemoryCaptureStore`
  (`memory-capture-store.ts:24`) never passes a generation, so the memory backend always runs at generation
  `0` with exactly one generation present.
- **Evidence:** mutation **M22** (`startsWith` → `includes`) **survived**.

### 7. `maxDataSizeBytes` accounts different quantities on different backends

- **Where:** `packages/core/src/file-chunk-backend.ts:90` (`utf8ByteLength(encoded)` — includes the
  `<timestamp>\t…\n` frame) vs `packages/core/src/memory-chunk-backend.ts:40`
  (`utf8ByteLength(record.serialized)` — payload only).
- **What:** The same record is accounted as **36 bytes** by the file backend and **29 bytes** by the memory
  backend (measured). The file backend's number matches bytes-actually-written exactly (good); the memory
  backend's under-counts the frame and, far more, the real RAM cost of the retained `StoredEntry` objects.
  A user setting `maxDataSize` gets a materially different retention budget on edge/lambda than on
  node/disk, with no documentation of the difference (`memory-capture-store.ts:15-18` describes it only as
  "the total UTF-8 size of stored records", which is self-consistent but tier-specific).
- **Evidence:** empirical — `bytes actually written = 36 vs serialized-only = 29` for one `log` record.

### 8. Byte-cap accounting drifts on a write failure — phantom bytes evict real data

- **Where:** `packages/core/src/file-chunk-backend.ts:89-90` (returns the frame size unconditionally, even
  when `storage.append` silently dropped the entry) → `chunk-capture-store.ts:76-80`.
- **What:** `batched-fs-chunk-storage.ts:168-173` deliberately swallows an `ensureDir`/`open` failure
  (`onError(error); return;`) so a broken disk never throws into capture — correct — but the backend still
  reports the full byte size, so `totalBytes` grows for data that was never written. Under a *partial*
  disk failure (some appends land, some do not) the byte cap then evicts older parts that **do** hold data,
  losing more capture than `maxDataSize` requires.
- **Evidence:** empirical — a `ChunkStorage` whose `append` is a no-op still drove byte-cap eviction of
  parts 0 and 1 (`chunks left = [2]`) with zero bytes ever stored.

### 9. `openStarts` is never purged on `removeGeneration` / `clear()`

- **Where:** `packages/core/src/file-chunk-backend.ts:107-109` (`removeGeneration` touches only `storage`),
  reached from `chunk-capture-store.ts:109` (`clear()`).
- **What:** `openStarts` (`file-chunk-backend.ts:60`) is purged only by `closePart` (`:95`) and `removePart`
  (`:103`). A `clear()` while a part is open leaves that part's entry behind forever; `nextNumber` is never
  reset (`chunk-capture-store.ts:47,50-51`), so the stale key is never reused and there is no correctness
  impact — just one leaked `Map` entry per `clear()`.

### 10. `createStreamingCaptureStore` dereferences ambient `performance` eagerly and unguarded

- **Where:** `packages/core/src/streaming-capture-store.ts:43-46,65-66`.
- **What:** `const timeOrigin = opts.timeOrigin ?? ambientPerformance().timeOrigin;` runs at **construction**
  with no guard. On a runtime without `globalThis.performance` this throws a `TypeError` out of store
  creation (i.e. out of `launch()`); if `performance` exists but lacks `timeOrigin`, every streamed entry
  carries `timeOrigin: undefined` and the receiver's time-base mapping is silently wrong. Compare
  `clock.ts:26-31` in the same package, which explicitly probes `typeof perf.now === 'function' &&
  typeof perf.timeOrigin === 'number'` and falls back. Not currently reachable (webview/electron-renderer
  both have a full `performance`), and the test at `streaming-capture-store.test.ts:91-99` only asserts
  "does not throw" under node, where both exist.

### 11. `dedup.ts` reads the tag outside the try that guards writing it

- **Where:** `packages/core/src/dedup.ts:18` (`if (obj[ALREADY_CAUGHT])`) vs the guarded write at `:20-29`.
- **What:** The function's documented stance is "safer to re-capture than to silently drop" and it wraps
  `defineProperty` in `try/catch` for exactly that reason — but the **read** is unguarded, so a thrown value
  that is a `Proxy` with a throwing `get` trap propagates out of `checkOrSetAlreadyCaught` into
  `client.ts:587`, i.e. into the error-handling path. Exotic, but the asymmetry is unintentional-looking.

### 12. `createRingBuffer` has zero consumers

- **Where:** `packages/core/src/ring-buffer.ts` (69 lines) + `ring-buffer.test.ts` (134 lines), exported at
  `packages/core/src/index.ts:181`.
- **What:** A repo-wide grep finds **no** use of `createRingBuffer`/`RingBuffer` anywhere outside its own
  file, its own test, and the index re-export. Design §7.7's per-file-type ring was superseded by the
  part-based `ChunkCaptureStore`. The code itself is correct and well tested (5/5 targeted mutations caught,
  including the head-advance and capacity-validation edges) — it is simply dead public surface, and the
  documented no-slot-nulling retention note (`ring-buffer.ts:5-6`) is moot as a result.

## Durability contract audit

| Store / backend | durable on `add`? | window of loss (SIGKILL / power / tab close) | matches binding rule? | file:line |
|---|---|---|---|---|
| `chunk-capture-store` (the shared store) | n/a — holds **metadata only** (`{ref,start,end,byteSize,count}`), zero entry payloads in RAM; writes through on every `add` | none of its own | **YES — this is the rule, implemented exactly** | `chunk-capture-store.ts:25-31,43,74-81` |
| `memory-chunk-backend` / `createMemoryCaptureStore` | No — RAM only, by design (ephemeral edge/lambda tier) | **everything** on any termination | N/A (ephemeral tier; rule is scoped to durable backends). Used as the fallback when no dataDir/IDB exists: `client.ts:291`, `node/launch.ts:524`, `browser/launch.ts:372`, `vercel-edge/launch.ts:172` | `memory-chunk-backend.ts:38-41` |
| `file-chunk-backend` over a **sync** `ChunkStorage` (`node-utils/fs-chunk-storage`) | **Yes** — one `append` syscall per entry, before `add` returns | ~0 for process death; only an un-fsynced page-cache tail on power loss | **YES (strict)** | `file-chunk-backend.ts:84-91` |
| `file-chunk-backend` over `createBatchedFsChunkStorage` (**the node default**) | **No** — buffered into `entry.segments`, flushed at 64 KiB high-water, at `sealChunk` (every tick = every ~1 s), on the 1 s flush timer, on `uncaughtException`, and on `'exit'` | ≤ ~1 s of the *currently open* part (a tick's `closePart`→`sealChunk` flushes the whole sealed part). **Not flushed on SIGTERM** — see SEV2 #2 | **Relaxed — and correctly tiered.** Matches `docs/design/server-disk-capture-write-path.md:24-27` except for the SIGTERM clause | `batched-fs-chunk-storage.ts:160-183,235-249`; `node/launch.ts:669-677,742-748,765-774` |
| **Report/incident read path** over the batched storage | n/a | **none** — `read()` calls `flushPath()` before reading, so a snapshot always sees everything captured so far | **YES** | `batched-fs-chunk-storage.ts:198-203` ← `file-chunk-backend.ts:121` |
| `idb-chunk-backend` (browser/webworker) | Sync-issue / async-complete via an internal queue; snapshot reads are pinned against concurrent delete | one queued write | Out of this pass's scope; the *relaxation is NOT applied here* — the browser/crash path uses the pinned IDB backend, not the batched writer | `browser-utils/idb-chunk-backend.ts:215-253` |
| `streaming-capture-store` | n/a — no local buffer at all; each entry is encoded and `post`ed immediately | whatever the *receiver* has not yet persisted; entries added **while paused are dropped outright** (documented) | Consistent with its design (receiver owns the ring + bundler) | `streaming-capture-store.ts:73-90` |

**Where the strict rule vs the relaxation applies:** strict everywhere in `packages/core` (the store layer
never buffers) and on any sync `ChunkStorage`; relaxed **only** inside `node-utils`'s batched/worker writers,
i.e. node/bun/deno/electron-main. I found **no case of the relaxation leaking into the browser or crash
path** — the browser tier uses IDB, and the crash/report path force-flushes.

## Crash-corruption resilience

Corruption is isolated at **record** granularity, never chunk or session granularity. Verified by
construction and by mutation:

- **Truncated / torn trailing frame** (the exact state a SIGKILL leaves): `file-chunk-backend.ts:126-133`
  skips a line with no tab separator and a line whose timestamp is non-finite; both guards are asserted by
  `file-chunk-backend.test.ts:128-137`, and removing either is caught (mutations M14, M15).
- **Garbage / foreign line mid-file:** skipped identically; the surrounding good records are still returned
  (`file-capture-store.test.ts:85-93`).
- **Corrupt or missing `meta` file:** `readMeta` (`file-chunk-backend.ts:63-74`) catches the `JSON.parse`
  throw and returns a derived default `{start:0, end:undefined, byteSize:0}` rather than propagating —
  asserted at `file-chunk-backend.test.ts:82-102`; making it rethrow is caught (mutation M18). One nit: a
  corrupt meta yields `end: undefined`, i.e. "still open", which is indistinguishable from a genuinely open
  part; harmless today because recovery reads the whole part regardless (`capture-recovery.ts:64`).
- **Empty / unreadable data file:** `storage.read(...) ?? ''` (`file-chunk-backend.ts:121`) yields no
  records rather than throwing; explicitly tested with a storage that lists a file but reads `undefined`
  (`file-capture-store.test.ts:250-263`).
- **Un-deserializable record surviving the frame check:** caught one level up in
  `capture-exporter.ts:38-45` / `:62-66` — skip + `onError`, `continue` — so **one bad record never aborts
  the export of the rest**. This is the key "one bad byte must not lose the whole session" property, and it
  holds on both the live-export and the recovery path.
- **Stale/untracked chunk in the same generation:** ignored by `snapshot()` because it iterates the store's
  tracked parts, not the directory (`file-capture-store.test.ts:77-83`).

The one residual sharp edge is the frame itself (`file-chunk-backend.ts:88`): `<timestamp>\t<serialized>\n`
assumes `serialized` contains no literal tab or newline. That holds for every producer today — the only
`serialize()` implementation is `capture-data-entry.ts:16-18`, `JSON.stringify`, which escapes both — and an
embedded tab is explicitly handled (split on the **first** tab, `:126`, tested at
`file-chunk-backend.test.ts:139-146`). A future subclass overriding `serialize()` with a multi-line format
would silently tear records; nothing enforces the invariant.

## `report-marker-store.ts` deep-dive

**The premise in the brief is wrong, and the code says so plainly.** `report-marker-store.ts` is **37 lines
of which ~26 are comments/JSDoc, 10 are two type declarations, and exactly ONE is executable**:
`export const ReportMarkerStoreToken = serviceToken<ReportMarkerStore>('reportMarkerStore');` (`:37`). There
is no marker I/O, no durability logic, no cleanup, and no collision handling in core — by design: core owns
the contract, the platform owns the medium (stated at `:23-26,36`).

**What the 8 test lines assert, exactly:** `report-marker-store.test.ts:5-7` — one `it`, one expectation:
`ReportMarkerStoreToken.name === 'reportMarkerStore'`. That is the token's identity, and it is the *only*
runtime behavior the file has. Coverage-wise the file is fully covered by that single assertion.

**What is therefore untested *in core* (and is untestable there):** everything about marker durability. The
`ReportMarker`/`ReportMarkerStore` shapes are also **not** referenced by any `*.test-d.ts`
(`contracts.test-d.ts` covers `CaptureStore` but not the marker types), so the `serviceToken<ReportMarkerStore>`
generic binding is unasserted — a one-line type test would close that.

**The crash-recovery path itself is implemented and tested elsewhere**, and I verified it rather than
assuming: `node-utils/report-marker-store.ts` (47 impl / 103 test) and `browser-utils/idb-report-marker-store.ts`
(67 / 204). Reviewing those is out of this pass's scope, but three properties are worth handing forward
because they are the crash-recovery critical path:

1. **`put` is not atomic.** `node-utils/report-marker-store.ts:20-22` calls `writeFileSecure`, which is a
   bare `writeFileSync` (`node-utils/fs-storage.ts:27-29`) — `O_CREAT|O_TRUNC` then write. A process death
   between the truncate and the write leaves a **0-byte marker**. Narrow (single small write to a local FS),
   but the marker exists precisely for "the process died right after detection".
2. **An unparseable marker is purged, not quarantined.** `node-utils/report-marker-store.ts:29-39`:
   `JSON.parse` throws → `onError(error)` → `remove(path)`. Combined with (1), a torn marker means the
   incident is **permanently lost** and the generation it protected becomes eligible for
   `backend.removeGeneration` (`capture-recovery.ts:102`), taking the crashed session's capture with it. The
   trade-off is deliberate (it prevents an unparseable marker repeating forever — see the doc's
   `server-disk-capture-write-path.md:262` note), but a tmp-write + `rename` in `put` would remove the
   window entirely.
3. **`put` can throw; the contract does not say so.** `report-marker-store.ts:29` documents only "Persist
   (or replace) the marker" — unlike `CaptureStore.add`, which explicitly says "must never block or throw"
   (`contracts.ts:106,113`). The node impl **does** throw on a disk error (no try/catch at
   `node-utils/report-marker-store.ts:20-22`). The sole in-repo caller happens to guard it
   (`client.ts:455-465`), so nothing breaks — but the contract should state the requirement rather than
   relying on every caller to guess it.

**Collision between instances:** not a core concern and correctly handled outside it — node points the
marker store at a per-instance `incidentsDir` under the instance subtree (`node/launch.ts:509-511`), and
markers are keyed by `request.id`, so two aggregators cannot collide.

## `chunk-backend.ts` adjudication

**Genuinely type-only — the absent test file is correct, not a gap.** The whole file is `import type` plus
four `export interface` declarations (`PartRef` `:13-16`, `PartMeta` `:19-27`, `FrozenPart` `:30-34`,
`ChunkBackend` `:36-62`). It emits **zero executable statements**, so it contributes 0/0 to the v8 coverage
report and cannot move the gate in either direction. No `/* v8 ignore */` is needed and none is present.

**Coverage-gate evidence (measured, not assumed):** `pnpm --filter @bugsee/core exec vitest run --coverage`
→ `Statements 100% (1176/1176) · Branches 99.67% (605/607) · Functions 100% (315/315) · Lines 100%
(1130/1130)`, 683 tests across 46 files, threshold satisfied. The only file the reporter lists as below
100% branch is `client.ts` (98.4%, lines 432/637) — a Pass A concern, not this one. `chunk-backend.ts` does
not appear in the report at all, consistent with having no emitted code.

Its *semantics* are exercised indirectly and thoroughly through three implementations
(`memory-chunk-backend.test.ts`, `file-chunk-backend.test.ts`, `browser-utils/idb-chunk-backend.test.ts`).
The one real weakness is documentary rather than structural: the interface is the **only** specification of
`FrozenPart.count`, and one of its two core implementations ignores it with no test pinning either
behavior — see SEV3 #3.

## For later passes

- **Pass D (recovery / bundle):** `capture-recovery.ts:102` deletes a whole generation after processing its
  markers; combined with the marker-purge behavior in `node-utils/report-marker-store.ts:29-39`, a torn
  marker discards the incident **and** frees the capture that backed it. Worth confirming the ordering is
  intentional and that `keepGenerations` (`node/recover-instances.ts:116`) covers every case where a marker
  is dropped rather than consumed.
- **Pass D:** `capture-recovery.ts:62-65` passes `count: Number.MAX_SAFE_INTEGER` for every part, so it does
  not depend on SEV3 #3 — but if the file backend is ever "fixed" to honor `count`, this is the call site
  that must stay unbounded. Please keep the two changes together.
- **node tier (no pass owns it):** SEV2 #2 (SIGTERM). Either narrow
  `docs/design/server-disk-capture-write-path.md:24-27` or add a flush-and-re-raise SIGTERM seam.
  `packages/node/src/system-events.ts:85-92` already owns a re-raising SIGTERM handler, so the seam exists.
- **node tier:** `batched-fs-chunk-storage.ts:168-173` swallowing an append failure while
  `file-chunk-backend.ts:90` still reports the bytes is the mechanism behind SEV3 #8; the clean fix is for
  `ChunkStorage.append` to report whether it accepted the bytes.

## Checked and found clean

- **The binding durable-as-captured rule.** `chunk-capture-store.ts` holds no entry payloads — only
  `IndexedPart` metadata (`:25-31`) — and appends through on every `add` (`:74-81`). This is the single most
  important property in this pass and it is implemented exactly as specified.
- **Runtime portability.** None of the 11 in-scope files imports `node:*` or touches DOM. The only ambient
  global reached is `performance`, via a `globalThis as unknown as {…}` cast
  (`streaming-capture-store.ts:43-46`) — the sanctioned pattern. All real I/O arrives through injected
  `ChunkStorage`/`ChunkBackend`.
- **Ring semantics at the boundaries.** Byte cap uses a strict `>` (`chunk-capture-store.ts:64`) so
  `total == cap` does not evict; the window cut uses a strict `<` (`:93`) so a part ending exactly on the
  cutting edge is kept — both asserted (`memory-capture-store.test.ts:70-77`,
  `file-capture-store.test.ts:108-114`) and both mutation-caught (M1, M4).
- **Oversized single entry / single oversized part.** Kept as a soft bound via the `parts.length > 1` guard
  (`chunk-capture-store.ts:64`); no infinite loop is possible because the guard terminates the `while`.
  Tested (`memory-capture-store.test.ts:150-154`, `file-capture-store.test.ts:184-188`), mutation-caught (M2).
  Multi-part eviction in a single `add` is also tested (`:156-167`, `:190-201`).
- **`parts` can never be empty**, so `currentPart()` (`chunk-capture-store.ts:56`) can never return
  `undefined`: `openNewPart` always pushes, the tick loop stops at the freshly-opened part (its `end` is
  `undefined`, `:92`), the byte-cap loop keeps ≥1, and `clear()` re-opens immediately (`:110-112`).
- **Byte-total bookkeeping across both eviction paths.** Time-eviction and byte-eviction both subtract
  (`:96`, `:66`) and `clear()` zeroes (`:111`); the no-double-count-drift case is explicitly tested on both
  stores (`memory-capture-store.test.ts:169-181`, `file-capture-store.test.ts:203-216`) and every mutation
  in this area was caught (M5, M8, M9).
- **Snapshot isolation under concurrent add/evict.** Both core backends materialize eagerly at `snapshot()`
  — the memory backend copies record refs (immutable, so eviction cannot disturb them,
  `memory-chunk-backend.ts:8-10`, tested at `memory-chunk-backend.test.ts:41-62`), the file backend reads
  the bytes (`file-chunk-backend.ts:112-138`). A part evicted after `snapshot()` cannot tear a reader. The
  async IDB backend uses an explicit pin + deferred-delete for the same guarantee
  (`browser-utils/idb-chunk-backend.ts:223-243`).
- **No missing `await` / dangling promise in the write path.** Every in-scope write path is synchronous
  end-to-end; nothing returns a promise that is dropped. `listParts`/`listGenerations` are the only
  possibly-async members and are used solely by recovery, which awaits them (`capture-recovery.ts:61`).
- **Capture never alters app behavior.** `store.add` failures cannot escape into the interceptor: the
  aggregator wraps `serialize + store.add` in `try/catch → onError` (`capture-aggregator.ts:57-63`), and the
  tick is likewise guarded (`client.ts:647-652`).
- **`PART_DURATION_MS` (1000, `chunk-capture-store.ts:13`) is decoupled from the configurable
  `tickIntervalMs` (`client.ts:325`)**, but the mismatch can only ever *over*-retain, never evict in-window
  data: a part is cut only once its `end` is already older than `now - maxRecordingTime - 1000`, at which
  point every record it holds is outside the window.
- **`chunk-storage.ts` in-memory medium** mirrors the directory semantics faithfully — `append` accumulates,
  `write` replaces, absent generation/chunk/file all return the empty result, `removeChunk` is
  chunk-scoped. Both mutations here (M27 append→overwrite, M28 chunk-delete→generation-delete) were caught
  by four different test files, including `capture-recovery.test.ts`, which shows the fake is exercised
  through the real serialization path rather than mocked around.
- **`ring-buffer.ts`** — capacity `0`/`1`, wrap-around ordering, `drain` atomicity, non-destructive
  `toArray`, destructured-method safety, and a validation test that deliberately pins *our* `RangeError`
  message so that `new Array(1.5)`'s incidental throw cannot mask a dropped check
  (`ring-buffer.test.ts:122-133`). All 4 targeted mutations caught.
- **`dedup.ts`** — instance tagging, non-object/null/undefined values, frozen objects, and the
  non-enumerable-so-it-does-not-survive-a-spread property are all asserted; all 3 mutations caught,
  including the enumerability flip (`dedup.test.ts:50-58`).
- **`streaming-capture-store.ts`** — pause-drops, seq monotonicity, injected seq, redaction provenance, and
  the empty-snapshot contract are all asserted; both mutations caught.
- **Mutation harness integrity.** A control run on the unmutated tree passed before any mutation, every
  mutation was applied to a `cp` backup and restored from it (never `git checkout`), and
  `git status --short packages/` is **empty** with all seven touched files byte-identical to their backups.
