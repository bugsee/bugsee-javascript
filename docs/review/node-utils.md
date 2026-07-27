# Adversarial review — @bugsee/node-utils

**Reviewed:** 2026-07-26 · **Scope:** packages/node-utils (impl 1400 LOC across 12 files, tests 2163 LOC across 11 files)
**Verdict:** The filesystem primitives are, on the whole, careful and well-tested — real temp dirs, real loopback
servers, real `worker_threads`, injected disk failures and `stat`-asserted `0600/0700` modes. There is **no test
theater** here. Deletion is safe: `rmSync(recursive, force)` provably does **not** follow symlinks out of the tree,
and every generation/chunk path is derived from zero-padded integers (no traversal). Auth-token hygiene is clean
(header-only, never in a URL, never in an error string). Two things do not hold up. First, the **Phase-2 ring
producer** (`capture-ring.ts`, reached via the opt-in `captureWriter: 'worker'`) has a reachable state where a
single legal record cannot be placed on an *empty* ring; the producer then walks `HEAD` over uninitialised/stale
ring bytes, and I measured `HEAD` jumping **~1.9 GiB past `TAIL`** — after which the record is lost and **every
subsequent capture entry is silently discarded with no error and no drop telemetry**. Second, the **default**
batched writer answers "back-pressure vs OOM" with **OOM**: on a persistently failing disk I measured 20,000
appends producing 19,998 failing `writev` syscalls, 19,998 `onError` invocations and an unbounded in-memory
segment buffer — the exact "elastic growth" that design decision D2 forbids. Beyond that: the prior passes' two
confirmed findings both land here and are re-verified with an empirical matrix (flush-on-exit runs on **no
signal at all**, not just SIGTERM), the ring writer deletes chunk directories before its worker has actually
released their fds, and a wedged worker freezes the host thread for the full flush timeout on every read while
losing the entire ring (contradicting the design doc's spike claim of "zero loss even with a hung worker").

---

## SEV1

### 1. `RingProducer.reserve` corrupts `HEAD` when a legal-but-large record cannot be placed on an *empty* ring — permanent, silent, total capture loss

- **Where:** `packages/node-utils/src/capture-ring.ts:100-153` (the `reserve` loop), specifically the guard at
  `:95-99` (`need > this.cap` is the **only** unplaceability check), the fit test at `:105-107`, and the
  drop-oldest branch at `:123-152` which reads `frameSizeAt(head)` (`:64-75`) with **no check that the ring is
  non-empty**.
- **Reached from:** `packages/node-utils/src/capture-ring-writer.ts:184` (`producer.reserve(dataStr.length * 3)`),
  which is wired only when `captureWriter: 'worker'` — `packages/node/src/launch.ts:492-498`
  (option declared at `packages/node/src/launch.ts:214`). The default (`'inline'`) path is unaffected.
- **What:** `reserve` rejects only frames larger than the whole ring. A frame that fits the ring but needs
  wrap-padding can still be unplaceable: with `pad = cap - (TAIL mod cap)` (`:105`), the fit test is
  `free >= pad + need` (`:107`). On an **empty** ring `free == cap`, so the frame is unplaceable whenever
  `toEnd < need` **and** `toEnd + need > cap` — algebraically, whenever `need > cap/2` and `TAIL mod cap < need`.
  The code's only response to "doesn't fit" is drop-oldest, but on an empty ring (`HEAD == TAIL`) there *is* no
  oldest frame: `:129-134` parses whatever bytes happen to sit at `phys(head)` — zeros on a fresh ring, **stale
  frame bytes after the first lap** — as a frame header and CAS-advances `HEAD` by that bogus length.
- **Why it matters:** `HEAD` overtakes `TAIL`. `RingConsumer.peek` (`:182-185`) then sees `head >= tail` and
  returns `null` — "empty" — forever, until `TAIL` travels the whole bogus gap. Capture stops completely, with
  **no throw, no `onError`, and a `dropped` counter that reports a single drop**.
- **Evidence (against the real repo source, not a copy):**
  ```
  ring EMPTY: true, physTail=19684, toEnd=45852, need=45875, cap=65536
  reserve/commit returned: true
  DROPPED went 0 -> 1  (phantom drops on an EMPTY ring: 1)
  HEAD 150756 -> 2021311844   TAIL 150756 -> 211905
  HEAD > TAIL (consumer sees "empty" forever)? true   gap = 2021099939 bytes
  frames the consumer can now drain: 0  (expected 1)
  500 further appends accepted=500; frames drainable afterwards: 0
  ```
  A randomised sweep (200 trials, variable-size stale frames, 27 landing in the vulnerable band) hit the bug in
  **27/27**: `HEAD` overtook `TAIL` in 27/27 and the record was never written in 27/27; average wedge gap
  **2,021,114,881 bytes on a 64 KiB ring**; 4,000 subsequent appends produced **zero** writes and **zero** errors.
  On a fresh (zeroed) ring the failure is milder — 128 phantom zero-length frames and 174 phantom drops — and with
  same-size stale frames I observed **287 already-consumed records re-written to the capture data file**
  (32,509 bytes of duplicate capture).
- **Trigger size:** `need = 8 + 3 × dataStr.length`. At the default `ringCapacity` of 4 MiB
  (`capture-ring-writer.ts:25`) that is any single capture entry longer than **699,050 JS characters** — a large
  `console.log` payload or an un-truncated network body; I found no per-entry size cap between the capture
  sources and `appendEntry` (`packages/core/src/file-chunk-backend.ts:84-91`). A smaller configured
  `ringCapacity` lowers the bar proportionally.
- **Aggravating:** with a corrupted `pathId`, `createSyncRingWorker`'s `pathForId`
  (`capture-ring-writer.ts:83-92`) indexes `fileTypes[...]` out of range and calls `join(..., undefined)`, which
  throws a `TypeError` inside `RingDrainer.drain`'s try (`capture-ring-drainer.ts:83-88`) — the frame is never
  consumed and `READING` stays pinned, so the producer's drop-oldest also bails (`capture-ring.ts:124-127`) and
  *every* later append is counted as dropped. The `worker_threads` worker instead concatenates `undefined` into
  the filename (`worker-ring-worker.ts:36`), creating a file literally named `undefined`.
- **Test gap that let it through:** the only unplaceability test is `need > cap`
  (`capture-ring.test.ts:71-74`); the churn/conservation test uses `newRing(64)` with 28-byte frames
  (`capture-ring.test.ts:161-162`), i.e. `need = cap/2` exactly — **the entire `cap/2 < need <= cap` band is
  untested**.

---

## SEV2

### 2. The **default** batched writer grows without bound on a failing disk — OOM, not back-pressure, and one failing syscall + one `onError` per captured entry

- **Where:** `packages/node-utils/src/batched-fs-chunk-storage.ts:118-133` (`flushPath` keeps the unwritten tail
  and recomputes `entry.bytes` at `:132`) and `:174-182` (`append` pushes into `entry.segments` with **no cap**
  and re-triggers `flushPath` on every subsequent append because `entry.bytes` stays ≥ `highWaterMark`).
- **What:** the retry-without-duplication design is correct, but there is no ceiling on `entry.segments` and no
  shed path. Once `writev` fails persistently (ENOSPC / EROFS / EIO / a disappeared `dataDir`), every captured
  entry appends to an ever-growing buffer *and* issues another doomed syscall *and* invokes `onError`.
- **Evidence (real source, injected persistent ENOSPC):**
  ```
  appends: 20000 x 425B = 8.1 MiB of capture
  writev attempts: 19998  (one failing syscall per append past the high-water mark)
  onError invocations: 19998
  heapUsed now: 12.2 MiB  -> buffered segments are NEVER dropped/capped
  ```
- **Why it matters:** this is the **default** node/bun/deno write path
  (`packages/node/src/launch.ts:490-501`). `docs/design/server-disk-capture-write-path.md:120` (D2) binds the SDK
  to *"**fixed** ring, **drop-oldest** under overload (**no elastic growth**)"* — the Phase-2 ring honours that;
  the shipped Phase-1 default does not. An SDK that OOMs the host on a full disk alters host behaviour, which the
  repo treats as a binding prohibition. The `onError` storm is a second-order hazard: `onError` is caller-supplied
  and a natural implementation logs, which re-enters capture.
- **Contrast:** `capture-ring.ts:123-128` sheds by design. The batched writer has no equivalent.

### 3. `removeChunk` deletes the chunk directory **before** the worker has released its fds — the invariant the code comments claim is not delivered

- **Where:** `packages/node-utils/src/capture-ring-writer.ts:216-226` — `worker.flushAndWait(...)` then
  `worker.closeChunk(c)` then `removeDir(chunkDir(g, c))`, with the comment at `:219` asserting *"…then release
  its fds before deleting (no resurrection)"*. But `closeChunk` on the production worker is
  `worker.postMessage({ close: chunk })` (`packages/node-utils/src/worker-ring-worker.ts:148`) — **asynchronous**;
  the worker only acts on it when its event loop turns (`worker-ring-worker.ts:73`).
- **What:** on POSIX the directory is unlinked while the worker still holds open fds into it (harmless for
  already-drained bytes, but the close is deferred and any in-flight write lands in an unlinked inode). On
  **Windows** `rmSync` of a directory containing an open file fails with `EPERM`/`EBUSY`, so `removeDir` throws,
  is routed to `onError` (`:224`) and **the chunk is never evicted** — unbounded disk growth under the
  `maxDataSize`/duration eviction loop.
- **Why the tests cannot see it:** `worker-ring-worker.test.ts:231` ("B3: maxDataSize-style eviction over the
  real off-thread worker") runs on POSIX, where the unlink succeeds regardless of the open fd.
- **Same asynchrony, benign:** `sealChunk` (`capture-ring-writer.ts:254-257`) — the fds are released eventually,
  so only the "bounds the open-fd count" timing claim is loose.

### 4. A wedged/dead ring worker freezes the host thread for the full flush timeout on **every** read and loses the entire ring — the documented "zero loss even with a hung worker" fallback does not exist

- **Where:** `packages/node-utils/src/worker-ring-worker.ts:130-144` (`flushAndWait` → `Atomics.wait` on the
  **main thread** until the deadline, then returns silently), called unconditionally by
  `capture-ring-writer.ts:206` (`read`), `:212` (`files`), `:229` (`chunks`), `:234` (`generations`), `:251`
  (`flushSync`), `:255` (`sealChunk`).
- **What:** core's snapshot calls `storage.files()` once per part and `storage.read()` once per file per part
  (`packages/core/src/file-chunk-backend.ts:111-137`), so a report assembled while the worker is wedged performs
  `parts × (1 + files)` blocking waits. Each returns *success-shaped* (`void`) on timeout, and `read()` then
  reads a short file — an incomplete snapshot with no error.
- **Evidence (real source, worker that never acks, `flushTimeoutMs: 3000`):**
  ```
  files() with a wedged worker: 3001 ms (blocking, synchronous)  -> []
  read()  with a wedged worker: 3001 ms  -> content = undefined
  100 buffered records; recovered by the reader: 0
  a snapshot over 10 parts x 4 files = 50 flushAndWait calls x 3000 ms = 150s of frozen host event loop
  ```
- **Design divergence:** `docs/design/server-disk-capture-write-path.md:146-148` records the spike result that
  justified this architecture — *"a deliberately-WEDGED worker (never acks) → the main thread reads the shared
  ring residual (`ring.subarray(head, tail)`) and writes it ITSELF → **zero loss on all 3 even with a hung
  worker**"*. There is no such residual write anywhere in the shipped code (`grep -rn "residual|subarray(head"`
  over `packages/node-utils/src` and `packages/node/src` returns only a test comment). `dispose()`
  (`capture-ring-writer.ts:259-261`) → `stop()` (`worker-ring-worker.ts:150-163`) waits 1 s and terminates; the
  ring contents are dropped.

### 5. `ensureDir`/`listFiles`/`readFileBytes` rethrow non-ENOENT errors into store constructors that sit **outside** launch's degradation guard

- **Where:** `packages/node-utils/src/fs-storage.ts:22-24` (`ensureDir` never catches), `:37-46`
  (`readFileBytes` swallows only `ENOENT`), `:49-58` (`listFiles` swallows only `ENOENT`). Call sites outside the
  guard: `packages/node/src/launch.ts:438` (`createNodeBundleStore`), `:499` (`createBatchedFsChunkStorage` →
  `ensure(root)` at `batched-fs-chunk-storage.ts:108`), `:511` (`createNodeReportMarkerStore`), `:519`
  (`createFileCaptureStore` → `createFileChunkBackend` → `storage.generations()` at
  `packages/core/src/file-chunk-backend.ts:40`). The launch canary's `try/catch` ends at `launch.ts:430`.
- **Evidence (measured):** `readdirSync` on a file throws `ENOTDIR`, `readFileSync` on a directory throws
  `EISDIR` — both **rethrown** by `fs-storage`. Reachable with a user-supplied `dataDir` (a documented option)
  that contains a numerically-named file where a generation directory is expected, with `EACCES` on a shared
  root, or if the disk fills in the window between the canary write (`launch.ts:424`) and `:499`.
- **Why it matters:** an observability SDK must never crash the host's startup; `launch.ts:421-423` states exactly
  this intent, but only `writeInstanceOwner` is inside the guard.
- **Not a finding, verified clean:** the insecure-shared-tmp hazard (CWE-377/CWE-59) *is* properly handled —
  `packages/node/src/data-location.ts:71-94` `lstat`-verifies both levels of the default root for
  is-a-directory / owner-uid / no group-or-other mode before any capture is written.

### 6. A suspended-but-alive instance has its subtree recovered and deleted after 120 s; two coordinators can claim the same subtree (adjacent package — node-utils supplies the deletion primitive)

- **Where:** `packages/node/src/liveness.ts:15` (`DEFAULT_PATIENT_MS = 120_000`) and `:58-71` (`isSiblingDead`
  returns true for an **alive** pid whose heartbeat is stale past the window);
  `packages/node/src/liveness-heartbeat.ts:10` (heartbeat every 10 s);
  `packages/node/src/recover-instances.ts:181` (the liveness check) → `:152` (`remove(sub)`, i.e.
  `fs-storage.ts:61-63`).
- **What:** any pause longer than 120 s that stops the 10 s heartbeat — laptop sleep, container freeze/`SIGSTOP`,
  a long stop-the-world, a debugger break — makes a **live, still-writing** instance look dead to a peer, which
  recovers its bundles and recursive-deletes its subtree. On POSIX the victim keeps appending into unlinked
  directories and loses everything silently.
- **TOCTOU:** there is no claim step (the atomic-rename claim is explicitly deferred —
  `recover-instances.ts:34`). The window between the liveness check at `:181` and `remove(sub)` at `:152` spans
  the entire recovery pass (bundle reads + async uploads), so two simultaneously-launching processes can both
  recover the same subtree → duplicate uploads; the loser's reads degrade to empty rather than throwing because
  `listFiles`/`readFileBytes` swallow `ENOENT`.
- **PID reuse is handled correctly** — see the race analysis below.

### 7. CONFIRMED (owned by `core-C-storage.md` SEV2 #2): the documented flush-on-exit guarantee covers **no** signal, not just SIGTERM

Re-verified empirically and widened — see the exit-path matrix below. The blast radius *in this package* is
`entry.segments` for every open data file (`batched-fs-chunk-storage.ts:118-133`), i.e. up to `highWaterMark`
(64 KiB, `:16`) per file plus everything appended since the last 1 s flush tick
(`packages/node/src/launch.ts:669-677`). `docs/design/server-disk-capture-write-path.md:24-26` still claims
*"ZERO loss across any catchable termination — uncaught exception, `SIGTERM`, …"*.

### 8. CONFIRMED (owned by `core-D-bundle-upload-recovery.md` SEV2 #2): the on-disk bundle queue has no retention bound

`packages/node-utils/src/bundle-store.ts:13-32` implements `put`/`list`/`read`/`remove` with **no age, count or
byte cap** and no quarantine: `list()` (`:20-24`) returns every `*.bundle` forever, so a permanently-rejected
bundle is re-read and re-uploaded on every launch. The node-specific aggravation: the TTL sweep only reclaims
**dead sibling** subtrees (`packages/node/src/sweep-instances.ts:59,68`, own instance excluded), so a
long-running process's own `<subtree>/pending/` is never pruned while it lives.

---

## SEV3

### 9. Unsanitised ids compose into a delete path — traversal is possible, and `remove` is recursive
- **Where:** `packages/node-utils/src/bundle-store.ts:15` (`pathFor`) + `:28-30` (`remove`);
  `packages/node-utils/src/report-marker-store.ts:18` + `:43-45`. Both feed `fs-storage.ts:61-63`
  (`rmSync(recursive: true, force: true)`).
- **Evidence:** `join(dir, '../victim' + '.bundle')` resolves outside `dir` and the delete succeeded in a
  throwaway tree. The comment at `bundle-store.ts:9` *assumes* filename-safe ids rather than enforcing them.
- **Reachability:** the default id factory is `${Date.now()}-${counter}`
  (`packages/core/src/durable-upload-pipeline.ts:89`) and is safe, but `idFactory` is an option (`:46`) and
  `ReportingRequestInit.id` is public (`packages/core/src/reporting.ts:74-75`, exported at
  `packages/core/src/index.ts:168`, spread through `packages/core/src/detection-provider-base.ts:51,57`), so a
  custom detection provider can supply an arbitrary id. A `basename`/charset assertion in `pathFor` closes it.

### 10. Windows: hard-coded `'/'` in the sync worker's directory derivation
- **Where:** `packages/node-utils/src/capture-ring-writer.ts:104` —
  `ensureDir(path.slice(0, path.lastIndexOf('/')))` over a path built by `node:path.join` (`:91`), which emits
  `\` separators on win32. `lastIndexOf('/')` returns `-1`, so `slice(0, -1)` creates a directory named after the
  filename minus its last character (e.g. `…\000000000000\lo`). The data file still lands correctly (the
  recursive `mkdir` creates the chunk dir on the way), but the junk directory then appears in `files()`
  (`:211-214`) and core's snapshot calls `storage.read(...,'lo')` → `readFileSync` on a directory → `EISDIR`
  rethrown by `fs-storage.ts:44` → **report assembly throws**. `join`/`sep` are already imported elsewhere in the
  package (`batched-fs-chunk-storage.ts:2`).

### 11. The `worker_threads` worker swallows every write and open failure with no telemetry
- **Where:** `packages/node-utils/src/worker-ring-worker.ts:66` — `catch (e) { return; }`. `openFor` (`:31-40`,
  including `mkdirSync`) is inside that try, so ENOSPC/EACCES/EROFS in the worker are invisible: it silently
  retries every 4 ms (`:74,82`) forever. The equivalent sync path routes to `onError`
  (`capture-ring-drainer.ts:85-87`). `args.onError` is wired only to the worker's `'error'` event (`:125`).

### 12. `TYPE_BASE` is duplicated between the drainer and the worker's inline eval, with nothing binding them
- **Where:** `packages/node-utils/src/capture-ring-drainer.ts:12` (`const TYPE_BASE = 256`) versus the literal
  `256` hard-coded twice in the worker source string (`worker-ring-worker.ts:34,36`). Mutation **M8**
  (`TYPE_BASE = 256 → 512`) **survived** the drainer's tests: `encodePathId`/`chunkOfPathId` round-trip
  symmetrically, so the tests pass while the worker would demux every frame to the wrong chunk/file.

### 13. `httpRequest`'s timeout is a socket *idle* timeout, not a request deadline
- **Where:** `packages/node-utils/src/http-request.ts:72-74`. `ClientRequest.setTimeout` fires on socket
  inactivity, so a server that dribbles one byte every 29 s keeps the promise pending indefinitely; core's
  uploader `await`s it. `http-request.test.ts:159` only covers a server that never responds at all.

### 14. `httpRequest`: no proxy support and no agent seam
- **Where:** `packages/node-utils/src/http-request.ts:51` passes no `agent`; `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
  are ignored. The file header (`:7-8`) says `node:http(s)` was chosen *"so proxy agents can be injected later"*,
  but `HttpRequestOptions` exposes no such hook — corporate-proxied deployments simply cannot upload.

### 15. `httpRequest`: no TLS enforcement — a mis-set endpoint sends credentials in cleartext
- **Where:** `packages/node-utils/src/http-request.ts:15-17` — `transportFor` silently selects plain `http` for
  anything that is not `https:`. A `baseUrl` of `http://…` therefore transmits `x-app-token`
  (`packages/core/src/bugsee-api.ts:41`) and `authorization: Bearer` (`:50`) unencrypted with no warning.

### 16. `httpRequest` does not follow redirects
- **Where:** `packages/node-utils/src/http-request.ts:41-80`. A 3xx resolves as a non-2xx status, which core maps
  to an upload failure (`packages/core/src/bugsee-api.ts:53-55`) — a collector-side redirect would make every
  upload fail permanently and, with the unbounded queue (finding 8), retry forever.

### 17. `numericNames` accepts non-decimal numeric spellings
- **Where:** `packages/node-utils/src/fs-chunk-storage.ts:22-26`, `batched-fs-chunk-storage.ts:22-25`,
  `capture-ring-writer.ts:31-34`. `Number('0x1f') === 31`, `Number('1e3') === 1000`, `Number(' 12') === 12`,
  `Number('12.0') === 12`. A stray directory so named is reported as a generation/chunk that then maps to a
  *different*, zero-padded path; `createFileChunkBackend`'s "clean other generations" pass
  (`packages/core/src/file-chunk-backend.ts:39-45`) would issue a delete for the padded sibling while never
  removing the stray. Contained (deletes stay inside the root) but it makes the comment at
  `fs-chunk-storage.ts:22` inaccurate. A `/^\d+$/` test is the cheap fix.

### 18. Mutation survivors and test gaps
Harness: `cp` backup → mutate → `pnpm --filter @bugsee/node-utils exec vitest run src/<file>.test.ts` → restore
from backup. Control mutation `FILE_MODE 0o600 → 0o644` was **CAUGHT**, so the harness is sound.
**13 CAUGHT / 7 SURVIVED** (2 of the survivors are equivalent mutants).

| id | mutation | result |
| --- | --- | --- |
| M0 control | `FILE_MODE 0o600 → 0o644` | CAUGHT |
| M1 | `entry.bytes >= highWaterMark` → `>` (`batched-fs-chunk-storage.ts:180`) | **SURVIVED** — the flush boundary is not pinned |
| M2 | `written >= want` → `written >= 0` (short-write handling, `:70`) | CAUGHT |
| M3 | `segments.slice(i)` → `slice(0)` (`:87`) | CAUGHT |
| M4 | `rmSync recursive:true → false` (`fs-storage.ts:62`) | CAUGHT |
| M5 | accept-encoding case-insensitivity (`http-request.ts:36`) | CAUGHT |
| M6 | `const within = prefix + sep` → `prefix` (`:151`) | SURVIVED — **equivalent mutant** (fixed-width zero-padded names cannot prefix one another) |
| M7 | `pad = toEnd < need` → `<=` (`capture-ring.ts:105`) | **SURVIVED** — exact-fit-at-ring-end is untested (adjacent to finding 1) |
| M8 | `TYPE_BASE 256 → 512` (`capture-ring-drainer.ts:12`) | **SURVIVED** — see finding 12 |
| M9 | `name.slice(0, -SUFFIX.length)` → `name` (`bundle-store.ts:23`) | CAUGHT |
| M10 | `entry.bytes = reduce(...)` → `0` (`batched-fs-chunk-storage.ts:132`) | **SURVIVED** — post-failure re-flush accounting untested |
| M11 | `need > this.cap` → `> this.cap + 8` (`capture-ring.ts:96`) | CAUGHT |
| M12 | `req.setTimeout(timeoutMs)` → `× 100` (`http-request.ts:72`) | CAUGHT |
| M13 | `IOV_MAX 1024 → 100000` (`batched-fs-chunk-storage.ts:17`) | **SURVIVED** — the split threshold is not pinned |
| M14 | `segments.push` → `unshift` (`:178`) | CAUGHT |
| M15 | drop the corrupt-marker purge (`report-marker-store.ts:37`) | CAUGHT |
| M16 | disable the READING drop-protection (`capture-ring.ts:125`) | CAUGHT |
| M17 | `consume()` cached size → re-read `frameSizeAt` (`:212`) | SURVIVED — **equivalent single-threaded**; the invariant only matters cross-thread and even the real-worker drop-storm test does not bind it |
| M18 | `encoding === 'gzip'` → `'GZIP'` (`http-request.ts:20`) | CAUGHT |
| M19 | drop the unknown-file-type fallback (`capture-ring-writer.ts:179`) | CAUGHT |

Additional gaps, none of which any test covers: (a) the `cap/2 < need <= cap` ring band (finding 1);
(b) a torn/truncated trailing record produced by a crash mid-`writev`; (c) sustained (not single-shot) write
failure — `batched-fs-chunk-storage.test.ts:208` tests one failure + retry, never the unbounded-growth regime;
(d) any non-POSIX path semantics (finding 10).

### 19. A regression in the no-progress guards would **hang** CI rather than fail it
- **Where:** `packages/node-utils/src/capture-ring-drainer.ts:46-49` and
  `batched-fs-chunk-storage.ts:74-79`. Removing the guard (`n <= 0` → `n < 0`) creates a **synchronous**
  infinite loop, which vitest's per-test timeout cannot preempt: my mutation run sat for >10 minutes before I
  killed it. The guards themselves are good defensive code; the tests that cover them
  (`capture-ring-drainer.test.ts:144`, `batched-fs-chunk-storage.test.ts:237`) can only ever hang, never fail.

---

## Exit-path durability matrix

Measured with a child process that installs `process.on('exit', …)` exactly as
`packages/node/src/launch.ts:765-775` does, plus the self-removing/re-raising signal listeners that
`packages/node/src/system-events.ts` installs.

| Termination | flush runs? | data lost | file:line |
| --- | --- | --- | --- |
| `SIGTERM` (SDK signal listener present) | **NO** — listener logs + re-raises; default disposition terminates without `'exit'` | whole unflushed `entry.segments` per open data file (≤64 KiB each) + everything since the last 1 s tick | `launch.ts:765-775`; `system-events.ts` (re-raise); `batched-fs-chunk-storage.ts:118-133` |
| `SIGTERM` (no listener) | **NO** | same | `launch.ts:772-775` |
| `SIGINT` | **NO** | same | `launch.ts:772-775` |
| `SIGHUP` | **NO** — no listener at all, default disposition | same | `launch.ts:772-775` |
| `SIGKILL` | **NO** (expected, uncatchable) | same | — |
| `process.exit()` | **YES** | none | `launch.ts:765-771` |
| uncaught exception | **YES** — twice: the explicit `flushSync()` then `'exit'` | none | `launch.ts:744-748` + `:765-771` |
| clean drain (`beforeExit` → `exit`) | **YES** | none | `launch.ts:765-771` |

`docs/design/server-disk-capture-write-path.md:24-26` promises zero loss for *every catchable* termination; the
delivered set is `{process.exit, uncaughtException, clean drain, stop()}`. **No signal is covered.**
`system-events.ts` already owns a re-raising SIGTERM/SIGINT handler, so a `flushSync()` there costs one line;
SIGHUP has no seam at all today.

---

## Deletion blast-radius audit

Every delete in the package funnels through one primitive, `remove` = `rmSync(path, {recursive: true, force: true})`
(`fs-storage.ts:61-63`).

| Call site | Path derived from | Can it escape? |
| --- | --- | --- |
| `fs-chunk-storage.ts:57` / `:69` | `join(root, pad(gen,13), pad(chunk,12))` — integers only | **No** |
| `batched-fs-chunk-storage.ts:212` / `:229` (via `removeDir`, `:107`) | same | **No** |
| `capture-ring-writer.ts:222` / `:244` (via `removeDir`, `:133`) | same | **No** |
| `bundle-store.ts:29` | `join(dir, id + '.bundle')`, `id` from the caller | **Yes** with a hostile id — finding 9 |
| `report-marker-store.ts:37` | `join(dir, name)`, `name` from `readdirSync` | **No** (readdir names cannot contain a separator) |
| `report-marker-store.ts:44` | `join(dir, marker.request.id + '.marker')` | **Yes** with a hostile id — finding 9 |
| `crashpad-session-marker-store.ts:44` / `:50` | fixed `crashpad-session.json` | **No** |
| *(adjacent)* `node/sweep-instances.ts:74`, `node/recover-instances.ts:152` | `join(dataDir, id)`, `id` from `readdirSync`, gated on a valid `owner.json` + a dead pid | **No** — but see finding 6 for *when* it fires |

**Symlinks — verified safe, measured, not assumed:**
- A symlink-to-directory *inside* a tree being recursively removed: the link is unlinked, the target directory
  and its contents survive.
- The removed path *itself* being a symlink to a directory: the link is unlinked, the target survives.
Node's `rm` uses `lstat` and never recurses through a symlink. The `*.map`-style escape found in the sibling
package has **no analogue here** — there is no glob-driven or recursive-scan-driven delete anywhere in
`node-utils`.

**TTL sweep vs a live instance:** cannot delete live data. `sweep-instances.ts:59` skips the own instance and
anything not matching `/^\d+-\d+-/`; `:67-70` requires a parseable `owner.json` (so a foreign directory whose
name merely matches the shape is never recursive-deleted) **and** a dead pid; `:71-72` requires age past the TTL
(7 days, `:23`) measured from the `.live` mtime, falling back to `owner.startedAt`.

---

## Multi-instance race analysis

- **PID reuse — handled.** `owner.json` alone does not disambiguate (it stores `pid` + `startedAt`,
  `liveness.ts:31-42`), but the composite verdict does: `isSiblingDead` (`liveness.ts:58-71`) treats an
  alive-pid-with-stale-heartbeat as dead, which is exactly the recycled-PID case, and an
  alive-pid-with-no-heartbeat as *arming* (kept). A recycled PID therefore cannot make orphaned data immortal for
  recovery. The **sweep**, however, gates on `pidAlive` alone (`sweep-instances.ts:68`), so a recycled PID does
  keep an abandoned subtree from ever being reaped — a disk leak, not a correctness problem.
- **`EPERM` handling is correct.** `pidAlive` (`liveness.ts:18-28`) maps `EPERM` to *alive*, so a
  same-PID process owned by another user is never treated as dead.
- **Clock skew — not a factor for the pid probe; real for the windows.** Both the 120 s patient window
  (`liveness.ts:15`) and the 7-day TTL (`sweep-instances.ts:23`) compare `now()` against a **file mtime**
  (`readLiveMtimeMs`, `liveness.ts:45-51`) or `owner.startedAt`. Instances on one host share a clock, so the
  practical exposure is a wall-clock jump (NTP step, VM restore) making a fresh heartbeat look 120 s stale.
- **Suspended/frozen process — NOT handled (finding 6).** Heartbeat period 10 s
  (`liveness-heartbeat.ts:10`) vs a 120 s patience budget gives only a **12-beat** margin. Laptop sleep, a
  container freeze, `SIGSTOP`, or a long stop-the-world exceeds it trivially, and the peer then recovers *and
  deletes* a live instance's subtree.
- **TOCTOU claim window — unbounded in practice.** No atomic-rename claim exists
  (`recover-instances.ts:34` documents the deferral). The window spans from the liveness check
  (`recover-instances.ts:181`) to `remove(sub)` (`:152`): every pending bundle is read, replayed through the
  upload pipeline, and markers are rebuilt from capture chunks first — seconds, not microseconds. Two processes
  launching together both pass the check and both recover, yielding duplicate uploads. The losing reader
  degrades quietly rather than crashing only because `listFiles`/`readFileBytes` swallow `ENOENT`
  (`fs-storage.ts:53,41`).
- **`worker_threads` sharing a PID — handled by construction.** The subtree name is
  `<pid>-<threadId>-<nonce>`, so threads never collide; the heartbeat is what distinguishes a dead thread inside
  a live process, which is precisely the case `isSiblingDead`'s stale-heartbeat branch exists for. The deferred
  per-thread heartbeat means a *non-heartbeating* worker-thread instance is indistinguishable from an arming one.

---

## Torn-record resilience

No framing, no length prefix, no checksum exists at this layer — `append(gen, chunk, file, data)` takes an opaque
string and the record delimiter is core's `\n` (`packages/core/src/file-chunk-backend.ts:88`). Torn records
**are** producible: a crash between two `writev` calls in `writeAll`
(`batched-fs-chunk-storage.ts:65-92`) or a short write followed by an error (`:127-131`) leaves a partial record
on disk while its tail stays buffered.

Measured behaviour with a real torn file:

```
file after a torn batch: "1000\t{\"a\":1}\n2000\t{\"b\""
   line "1000\t{\"a\":1}"  -> tab? true tsFinite? true => core snapshot() ACCEPTS
   line "2000\t{\"b\""     -> tab? true tsFinite? true => core snapshot() ACCEPTS (emits truncated JSON)
```

- **Truncation:** an **isolated skip, not a total failure** — the preceding records all survive; the reader
  (`file-chunk-backend.ts:122-134`) splits on `\n` and drops only lines lacking a tab or a finite timestamp.
- **But the torn tail is *not* skipped** when the tear falls inside the payload: the timestamp and tab are
  intact, so the line is accepted and a **truncated JSON string is emitted into the bundle** — the same class as
  the `profile` finding in `core-D`. Since the tear is always at end-of-file, a single "last line has no trailing
  newline → quarantine it" rule would close this.
- **Garbage bytes:** filtered iff they contain no tab or produce a non-finite timestamp; arbitrary binary that
  happens to contain `\t` after digits is accepted.
- **Zero-length file:** clean — `readFileBytes` returns an empty buffer, `content.split('\n')` yields `['']`, and
  the empty line is skipped (`file-chunk-backend.ts:123`). A missing file returns `undefined` → `''`.
- **Atomicity / durability:** there is **no** write-temp-then-rename and **no** `fsync`/`fdatasync` anywhere in
  the package (`writeFileSecure` = plain `writeFileSync`, `fs-storage.ts:27-29`; the bundle store writes in place,
  `bundle-store.ts:17-19`; the marker stores likewise). This *matches* the documented contract — D1
  (`docs/design/server-disk-capture-write-path.md:119`) explicitly relaxes durability to the page cache and
  rejects `fsync` — so it is not a defect, but "durable" in the code comments means "handed to the OS", and a
  power loss or a crash mid-`writeFileSecure` can leave a partially-written `owner.json`/marker/bundle. The
  marker readers do handle that (`report-marker-store.ts:31-38` and `crashpad-session-marker-store.ts:40-46`
  purge on parse failure); `bundle-store.read` does not validate, leaving that to core's `recover()`.

---

## Checked and found clean

- **Symlink escape on delete** — measured, both directions (symlink inside the tree, and the tree root itself
  being a symlink). `fs-storage.ts:61-63` cannot follow a link out.
- **Path traversal via generation/chunk/file names** — all zero-padded integers plus a closed `FileType` set.
- **Auth-token hygiene** — `x-app-token` and `authorization: Bearer` travel as headers only
  (`packages/core/src/bugsee-api.ts:40-41,50`); no token ever reaches a URL, and the only error string built in
  this package embeds the URL, not the headers (`http-request.ts:73`). Node's `ClientRequest` error objects do
  not carry request headers. Nothing in the package logs.
- **`X-Bugsee-Internal: 1`** — set on every control-plane call (`packages/core/src/bugsee-api.ts:40`) and honoured
  by the node outbound interceptor's self-isolation predicate
  (`packages/node/src/http-interceptor.ts:115-117`), so the SDK cannot capture its own uploads.
- **Socket lifetime / process exit** — measured: a completed `httpRequest` leaves nothing ref'd; the process
  exited in **0 ms**. Node's Agent unrefs free keep-alive sockets, so a CLI still exits promptly. The timeout
  path destroys the request explicitly (`http-request.ts:73`).
- **Promise settle-once** — `settled`/`fail` (`http-request.ts:42-49`) is correct across the
  timeout-during-body race; covered by `http-request.test.ts:177`.
- **Timers** — the package's only timer (`worker-ring-worker.ts:159-160`) is `unref`'d, as is the worker itself
  (`:126`); core's default `Scheduler` unrefs every interval (`packages/core/src/client.ts:94-103`), so neither
  the 1 s capture-flush timer nor the 10 s heartbeat can hold a CLI open.
- **File-handle discipline** — `closePath` (`batched-fs-chunk-storage.ts:135-147`) closes and drops the fd even
  when the flush or the close itself throws; `mainAppend` (`capture-ring-writer.ts:155-174`) closes in `finally`;
  `RingDrainer.#closeOne` (`capture-ring-drainer.ts:114-125`) deletes before closing so a throwing close cannot
  leak the map entry.
- **`writev` short-write handling** — `writeAll` (`batched-fs-chunk-storage.ts:65-92`) is correct, including the
  "a later throw leaves only the unwritten tail, so the retry never duplicates an already-written prefix"
  invariant; mutations M2/M3 both caught, and `batched-fs-chunk-storage.test.ts:141,183` test it against a real
  file.
- **UTF-8 reserve bound** — `MAX_UTF8_PER_CHAR = 3` (`capture-ring-writer.ts:27`) is *correct*, not a 4-byte bug:
  4-byte code points are surrogate **pairs** in a JS string, so 3 bytes per UTF-16 code unit is a true upper
  bound. Covered by `capture-ring-writer.test.ts:67`.
- **Runtime portability (Node family)** — verified on real interpreters, not assumed: `writevSync`,
  `node:worker_threads`, `SharedArrayBuffer`, main-thread `Atomics.wait`, and `new Worker(src, {eval: true,
  workerData})` all work on **node 24, bun and deno**. The `require`-or-`import` dual bootstrap
  (`worker-ring-worker.ts:84-86`) and the spawn-failure degrade to the sync worker (`:122-124`) are both sound.
- **Permissions** — `0600`/`0700` everywhere, asserted with real `statSync` in
  `fs-storage.test.ts:28-70`, `batched-fs-chunk-storage.test.ts:322`, `capture-ring-writer.test.ts:317`,
  `worker-ring-worker.test.ts:249`.
- **Insecure shared-tmp (CWE-377/CWE-59)** — properly defended in `packages/node/src/data-location.ts:71-94`
  before any capture is written to the predictable default root.
- **Test quality** — **not theater.** `node:fs` is never `vi.mock`ed; every storage test uses a real
  `mkdtempSync` tree and reads bytes back with `readFileSync`; `http-request.test.ts` runs a real loopback server
  per test; `worker-ring-worker.test.ts` spawns a real `worker_threads` worker (including a drop-storm and a
  worker→crash→plain-fs-reader recovery test at `:77,123`); disk failures are injected through explicit seams
  rather than mocked modules. 146 tests, all green, 472 ms; `tsc --noEmit` clean.
