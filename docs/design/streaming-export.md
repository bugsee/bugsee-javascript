# Streaming report export

Status: **Approved by the owner (2026-10-31); decisions Q1–Q5 accepted as proposed (section 7).** Nothing here is implemented yet. Follows the BGSVIEWER-12 store work
(`docs/PROGRESS.md`, 2026-10-31) and is the vehicle for its two unfinished halves: the export clamp and trim.

## 1. Why

Today a report is assembled entirely in memory:

```
store.snapshot().drainAll()  ->  Map<FileType, StoredEntry[]>      (all serialized records, every type)
  -> reify each record into a CaptureDataEntry                     (second copy: parsed objects)
  -> JSON.stringify per type / encodeReplay (JSON + gzipSync)      (third copy: strings, then bytes)
  -> zipSync                                                       (fourth copy: the archive)
  -> Bundle.body: Uint8Array  -> BundleStore.put / serializeBundle (fifth copy: header + body concatenated)
  -> putBundle(url, Uint8Array)
```

(`core/src/client.ts:1026` `collectCapture`, `bundle-assembler.ts:196` `assembleBundle`, `bundle-writer.ts` `zipSync`,
`durable-upload-pipeline.ts:176` `serializeBundle`, `upload-pipeline.ts:179` `sha256(bundle.body)`.)

With the byte cap at 10 MB that was tolerable. The owner wants a larger cap (20 MB in memory, 30 MB durable proposed), and
a report is built at the worst moment: a crash, an out-of-memory-adjacent error, a page being hidden. Peak heap at
export is a multiple of the window, not the window. **Export must not hold the window in memory.** The mobile SDKs
already work this way, which is the reference (section 3).

Two correctness items ride on the same change, because both need a place where records flow past one at a time:

1. **Time bounds.** `manifest.time.start` is the earliest entry timestamp (`bundle-assembler.ts:163-167`) and the viewer
   anchors replay on `events[0].timestamp`. Since BGSVIEWER-12 the store deliberately keeps a replay base that is older
   than the window, so the earliest entry can now be up to one checkout cadence (30 s by default) before the window.
   The report's timeline would stretch by that much. The spec defines `time.start` as the *snapshot start*
   (`specs/sdk/reporting/bundle/manifest.md`), i.e. the window start, not the earliest record.
2. **Leading orphans.** The store's anchor is per part, so a kept part can begin with incrementals of the previous base
   (up to ~1 s), and after a lone-base drop the open part holds incrementals until a fresh base arrives. The Replayer
   applies orphan incrementals to the wrong DOM (proved on rrweb 2.2.0 for BGSVIEWER-12). Export must trim records that
   precede the first base, per record.

Goal: **every record of the reporting window is exported, bounded memory, a correct timeline, no orphan replay.**

## 2. Non-goals

* Changing the bundle layout or any wire name. A streamed bundle must be byte-for-byte *readable* by the same worker and
  viewer (member names, `request.json`, `manifest.json` shape, `replay.bin` = gzip of a JSON event array).
  Member *order* inside the zip is not part of the contract (section 4.5).
* Streaming the upload of *incoming* data, the dialog flow, or the notify pipeline.
* A second export format. Android's temp-directory step has a JS analogue only where the platform has a disk.
* Changing the store's retention rules again. Retention keeps a superset; export decides what leaves.

## 3. Reference: the Android export

(`android/sdk/library/.../capture/CaptureExporter.java`, `CaptureExportProcessorDefault.java`,
`shared/compression/ZipArchive.java`.)

* One `CaptureExporter` **per export**, closed in a `finally`; exports are serialized by an `ExportLane`, with
  cancellation checks at stage boundaries ("before internal logs", "before postProcess").
* The caller passes a **`timeRange` (`long[2]`)**, derived from the snapshot's part index. It is not computed from the
  records. `timeRange[0] < timeRange[1]` is the "is there any data" test.
* **One pass over the snapshot's parts**; each entry goes to a per-type incremental JSON serializer
  (`mJsonSerializers`, `beginArray` ... `endArray`) that writes straight to a file in an output directory. Custom
  processors (video) mux incrementally and flush in `postProcess()`.
* **Then** `ZipArchive.zip()` streams each output file into a `ZipOutputStream` with an 8-ish KB buffer, and the upload
  reads the zip file. Nothing but a buffer is ever in memory.

The JS port keeps the shape (plan, single demultiplexing pass, incremental per-type encoders, a zip stage, upload from
the artifact) and replaces "directory of files" with whatever the platform can hold cheaply (section 4.4).

## 4. Design

### 4.1 Pipeline

```
snapshot.stream()                           oldest-to-newest across parts, one StoredEntry at a time
  -> plan.accepts(record)                   window trim (non-replay) — section 4.3
  -> demux by FileType                      one incremental encoder per type, created on first record
       JSON types : '[' , record , ',' ...  records are already serialized; spliced verbatim (see 4.2)
       replay     : orphan trim -> timestamp clamp -> '[' event ',' ... -> gzip stream
  -> fflate Zip (one ZipDeflate member per type) -> BundleSink
```

`ReportSnapshotSource`s (view tree, video) and the crash/attachment/request members are small and keep producing
in-memory members; they are added to the same zip.

**fflate behaviour verified** (fflate 0.8.3, probe in the session scratchpad): a `Zip` accepts pushes to *several members
in interleaved order*. Output for a member that is not yet at the head is **compressed and buffered**, not raw: pushing
5 MB of a repetitive payload into the second member while the first was open buffered 4,982 bytes, all emitted when the
first member was finalized. So single-pass demux needs **no temp files and no custom zip writer**; peak memory is
the *compressed* size of the members waiting behind the head, roughly an order of magnitude below the window. (S0 measures
this on a real window, not a repetitive string.)

### 4.2 Records are already serialized

A `StoredEntry.serialized` is `JSON.stringify({timestamp, data})`. Today export parses every record (`reify`) and then
stringifies the `data` again. Streaming splices instead: for a plain-JSON type the member is
`[` + `data` text of record 1 + `,` + ... + `]`. Extracting `data` from the serialized envelope without a parse is
fragile, so S2 first changes the **store frame** (not the wire) to keep the payload separable, or parses once and
re-stringifies `data` per record (one record's worth of garbage at a time, which is already bounded memory). Decision
in section 7, Q2; the second option is the default because it needs no store change.

Per-type shape wrappers (`performance` -> `{transactions:[...]}`, `input`/`video.aux` -> `{version, events:[...]}`,
`profile` -> the single object) become **prefix/suffix strings** around the incremental array, moved out of
`serializeFileData` into one table so the buffered and streaming paths cannot drift.

### 4.3 Time plan

The plan is computed **once, before the pass**, from the snapshot, not from the records:

```
plan.end   = trigger moment (clock.wallNow(), as today)
plan.start = max(plan.end - window, store epoch)      store epoch = first part start since launch/clear
```

* New optional `CaptureSnapshot.timeRange(): { start: number; end: number } | undefined`, computed by the store at
  `snapshot()` time from its own window and part index (Android's `timeRange`). `undefined` (a backend that cannot say)
  falls back to today's rule, earliest entry.
* `manifest.time = { start: plan.start, end: plan.end }`. This is the report start the viewer shows.
* **Replay clamp.** Replay events older than `plan.start` (the retained base and the incrementals up to the window
  start) are exported with `timestamp = plan.start`, in order. Applying them at one instant reproduces the page state at
  the window start, and `events[0].timestamp == manifest.time.start`, so the player timeline equals the report timeline.
  Their relative order is preserved by position; rrweb orders by array position within equal timestamps.
* **Non-replay trim.** Records of every other type with `timestamp < plan.start` are dropped. The store keeps up to one
  extra second (`PART_DURATION_MS` slack); the configured window is the contract. See Q3 for the alternative (keep and
  move `start` down to the earliest kept record).
* The clamp and trim apply to **exported bytes only**. The store and the durable copy are not rewritten.

### 4.4 Orphan trim (replay)

A small state machine in the replay stream encoder: drop events until the first FullSnapshot (type 2) *preceded by its
Meta* (type 4), then pass everything. If a Meta is the last thing before the base, it is kept; a Meta with no following
FullSnapshot is dropped with the orphans. If **no base exists at all**, the member is omitted (not written empty) and
`onError` is told; the manifest does not list it. This is per record, so it also covers the in-part case the store
cannot (see "Known limits" in the BGSVIEWER-12 entry of `docs/PROGRESS.md`).

The encoder lives in `@bugsee/replay` behind a core contract:

```ts
interface FileStreamEncoder {            // registered per FileType, like fileEncoders today
  begin(plan: ExportPlan): StreamEncoderSession;
}
interface StreamEncoderSession {
  write(entry: StoredEntry): Uint8Array[] | void;   // zero or more output chunks
  end(): Uint8Array[];                              // trailer; [] and a flag if the member is empty
  readonly empty: boolean;                          // true => omit the member and its manifest entry
}
```

`fileEncoders` (buffered, `(payloads) => Uint8Array`) stays for third-party/extension encoders and as the fallback for
types with no stream encoder. A type goes down the streaming path iff a `FileStreamEncoder` is registered or it is one
of the built-in JSON types.

### 4.5 The artifact and the sink

The zip output is a stream of chunks; where they go is a platform decision, exactly as Android chose files:

```ts
interface BundleBody {                    // replaces `Uint8Array` in Bundle.body
  readonly size: number;                  // Content-Length for the signed PUT
  stream(): AsyncIterable<Uint8Array>;    // RESTARTABLE: a retry re-reads from the start
  bytes(): Promise<Uint8Array>;           // convenience; materializes (tests, small bundles, hashing)
  dispose(): void | Promise<void>;        // delete the temp file / drop the blob
}
interface BundleSink { open(fileName: string): BundleSinkWriter }
interface BundleSinkWriter { write(chunk: Uint8Array): void | Promise<void>; finish(): Promise<BundleBody>; abort(): void }
```

| Runtime | Sink | Body |
| --- | --- | --- |
| browser, web/service worker, Deno, Bun | `Blob` parts (the engine spills big Blobs to disk) | `Blob` (`stream()` = `blob.stream()`) |
| Node, Electron main | temp file under the data dir (`<dataDir>/export/<id>.zip`), or the durable queue file directly | file (`fs.createReadStream`) |
| edge (Workers, Vercel) | in-memory chunks (no disk; the window is small there) | chunk array |

The memory sink is also the default for tests and any platform that does not inject one, so behaviour degrades to
"today, minus the intermediate copies".

* **Order of members.** `request.json`, `apptoken`, then data members as they complete, `manifest.json` **last**: its
  `files` list is only known after the pass (empty types and the omitted replay are not listed), while `time` comes from
  the plan. The backend reads with Python `zipfile` through the central directory (`worker/utils/ziputils.py`), which is
  order-independent and handles data descriptors. S5 verifies against the real worker test (`test_javascript_report_e2e`)
  and the viewer's unzip. If any consumer is found that needs the manifest first, fall back to a two-pass plan
  (types known from the part index) at the cost of a cheap pre-scan.
* **Checksum.** `sha256Hex` is WebCrypto one-shot and nothing sends it today (`bundle-uploader.ts:29-37`), but
  `upload-pipeline.ts:179` still computes it over the body. The streaming path computes it from `body.stream()` with an
  incremental hash where the platform has one (`node:crypto`), and **omits** it elsewhere (it is already best-effort and
  absent-tolerant). No behaviour change on the wire.

### 4.6 Consumers of `Bundle.body`

| Consumer | Change |
| --- | --- |
| `UploadPipeline.runOperation` | `contentLength = body.size`; `putBundle(url, body)`; checksum via stream or omitted; `dispose()` after success or terminal failure |
| `BundleUploader.putBundle` + `HttpRequest` (node `http`, browser `fetch`, webworker) | accept `Uint8Array | BundleBody`. node: pipe `body.stream()` with `Content-Length`; browser: pass the `Blob` as the fetch body. A retry calls `stream()` again |
| `BundleStore` / `serializeBundle` | durable frame `[4B hdr len][hdr JSON][zip]` unchanged on disk. `put(id, body)` writes header then pipes the body (node: file append; IndexedDB: `Blob([hdr, body])`, with an `ArrayBuffer` fallback where a runtime cannot store Blobs); `read(id)` becomes `open(id): Promise<IdentifiedBundle \| undefined>` returning a lazy body. Old frames stay readable |
| capture recovery / native-crash recovery (`capture-recovery.ts:187`, `native-crash-recovery.ts:132`) | their assembly goes through the same streaming assembler; a recovered store is the snapshot |
| `client.ts` `collectCapture`, `frozenCaptures` (report dialog) | the frozen capture becomes the **snapshot handle** plus the already-gathered `reportSnapshots` entries, not a drained Map. Holding a snapshot open pins its parts (existing contract: `unpin()`, `release()`); the dialog path must release on cancel |
| report filters (`filters.report`, `before/after`) | operate on the `Report`/`request`, not on records, so unchanged. Anything that today mutates `capturedByType` after drain is inventoried in S1 before any code moves |

The compatibility rule: `Bundle.body` is `Uint8Array | BundleBody` for one release of the internal API and every
consumer goes through one `asBody()` normalizer, so third-party `Transport` injections keep working.

### 4.7 Failure and cancellation

* A throwing record encoder skips that record and reports (as `createCaptureExporter` does for a torn record today). A
  failing sink aborts the export, calls `abort()` (deletes the partial artifact), and falls back to **no data** rather
  than no report: the request/manifest/crash members still ship, matching "a missing snapshot must never block delivery".
* One export in flight per store, as Android's `ExportLane` (the trigger pipeline already serializes assembly,
  `trigger-pipeline.ts`); a bootloop-style preemption is not a JS concept.
* The snapshot is released in a `finally`; `unpin()` when the read is abandoned (existing contract).

## 5. Slices (each test-first, mutator loop, coverage gate, convergent review)

| Slice | Content | Gate |
| --- | --- | --- |
| **S0** | **DONE 2026-10-31.** Baseline bench: a realistic window (the BGSVIEWER-12 replay events + logs/network), live-heap need and wall time of today's export vs a streaming prototype; results in section 8 | numbers in this doc |
| **S1** | Inventory every reader/writer of `Bundle.body`, `capturedByType` mutation and `BundleStore`; add `BundleBody` + memory sink + `asBody()`; `Bundle.body: Uint8Array \| BundleBody`; no behaviour change | contract + type tests |
| **S2** | Streaming assembler for the **built-in JSON types** + manifest/request/attachments, behind the same `assembleBundle` outcome (byte-equivalent after unzip, asserted against the buffered assembler on fixtures) | equivalence tests |
| **S3** | `CaptureSnapshot.timeRange()` from the chunk store; plan; manifest `time` from the plan; non-replay trim | store + assembler tests, mutants on the bounds |
| **S4** | Replay `FileStreamEncoder` in `@bugsee/replay`: gzip stream, orphan trim, timestamp clamp, empty-member omission | encoder tests incl. real rrweb Replayer probe on the BGSVIEWER-12 data |
| **S5** | Sinks (Blob, node temp file) + transports + `BundleStore` streaming `put/open` + durable pipeline + recovery paths; worker/viewer compatibility check against the real worker test and viewer unzip | cross-package integration + e2e |
| **S6** | Default byte cap (20 MB memory / 30 MB durable, owner to confirm), `PROGRESS.md`, remove the buffered path where no longer reachable | gates |

Each slice ends with a multi-agent review round to zero new real findings (CLAUDE.md, implementation standards §7).

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| A consumer reads `manifest.json` first | S5 check; fallback to a pre-scan plan (4.5) |
| Browser: `Blob` in IndexedDB unsupported or buggy (old Safari, private mode) | `ArrayBuffer` fallback chosen at runtime; the durable queue already tolerates a failed `put` (rejects, report retained by marker) |
| Restartable body for retry on a one-shot stream | contract says `stream()` is restartable; file and Blob are; the memory body holds chunks |
| Equal-timestamp ordering after the replay clamp | clamp preserves array order; a test with a real Replayer proves state at `start` equals the unclamped replay at the same point |
| fflate buffering grows for a type that is far from the head | bounded by compressed size; S0 measures; worst case equals today's zip size |
| The streaming path and the buffered `fileEncoders` path diverge | one shape table (4.2); equivalence tests in S2 stay as a permanent regression |
| Electron renderer streams capture to main (`streaming-capture-store`) | export happens in main from the main store; unchanged. Main-side retention limits are listed in PROGRESS.md |

## 7. Decisions (owner, 2026-10-31: all accepted as proposed)

* **Q1. `Bundle.body` shape.** `Uint8Array | BundleBody` transitional union (proposed) vs. a hard switch to `BundleBody`.
  The union costs one normalizer and protects injected transports.
* **Q2. Record encoding.** Parse each record once and re-stringify `data` (proposed, no store change) vs. change the
  store frame so the payload is spliced verbatim (fastest, touches every backend and recovery).
* **Q3. Pre-window non-replay records.** Drop them so `start` is exactly the window start (proposed) vs. keep the
  ≤1 s of slack and lower `start` to the earliest kept record.
* **Q4. Node sink.** Temp file in the data dir (proposed; survives a crash for recovery and doubles as the durable queue
  file) vs. memory chunks. Requires a `dataDir`; without one, memory.
* **Q5. Default cap.** 20 MB in memory / 30 MB durable (proposed), decided after S5 measurements, not before.

## 8. S0 results (2026-10-31)

Method: a throwaway bench (not committed; esbuild-bundled, node 24, in the session scratchpad). Window: the 496 real
rrweb events of BGSVIEWER-12 (8.8 MB as JSON) + 20,000 synthetic log records + 3,000 synthetic network records (~20 MB of
serialized records in a `createMemoryCaptureStore`). Two exports of the same store: **buffered** (today: `drain()` ->
`assembleBundle` with `encodeReplay`) and a **streaming prototype** (`snapshot.stream()` -> per-type `ZipDeflate` members,
parse-once/re-stringify `data` per Q2, interleaved in store order).

* **Peak RSS growth is the wrong metric** (66 MB streaming vs 62 MB buffered): V8 does not collect the transient garbage
  until it has to, so RSS records garbage, not what must be live.
* **Live need** (smallest `--max-old-space-size` at which the export completes, setup phase confirmed done):
  buffered **~70 MB**; streaming completes at **the floor of the setup itself (~44 MB)**, i.e. it adds nothing
  measurable on top of the 20 MB the window already occupies. So buffered export needs **at least ~26 MB (> 1.3x the
  window) of extra live heap**, which the streaming path does not. The bound for streaming is below the bench's
  resolution; a finer figure needs a durable backend (the store itself then is not in the heap), which is S5's job.
* **Output and time:** 3.97 MB (buffered) vs 4.07 MB (streaming; the replay member is deflated JSON instead of the
  gzip-then-deflate of `replay.bin`, so this is not yet a like-for-like size), 461-470 ms vs 450-476 ms. Streaming costs
  no wall time here.
* **fflate interleaved members** behave as in section 4.1 on real data: the run above pushed three members in time order
  with no temp files and a correct archive.

Consequences for the design: the memory win is real (it is the whole export working set), and it is largest where it
matters, on the durable backends, where today's export is the **only** place the window is ever fully in the heap.
No change to the plan; S2 keeps an equivalence test against the buffered assembler and a `replay.bin` byte-format check.
