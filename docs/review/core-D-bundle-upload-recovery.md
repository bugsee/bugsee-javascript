# Adversarial review — @bugsee/core, Pass D (bundle / upload / reporting / recovery)

**Reviewed:** 2026-07-26 · **Scope:** `packages/core/src/` —
`bundle-assembler.ts` (197/465 test), `bundle-writer.ts` (28/63), `bundle-uploader.ts` (39/97),
`upload-pipeline.ts` (207/414), `durable-upload-pipeline.ts` (151/247), `trigger-pipeline.ts` (77/143),
`reporting.ts` (129/114), `crash.ts` (137/111), `capture-recovery.ts` (108/400),
`native-crash-recovery.ts` (149/329), `rate-limiter.ts` (47/108), `transport.ts` (131/**no runtime test**),
`stack.ts` (95/176), `debug-id.ts` (68/96), `operation-dispatcher.ts` (21/55).
Read-for-context (not reviewed): `client.ts`, `capture-drain.ts`, `bugsee-api.ts`, `report-marker-store.ts`,
`node-utils/bundle-store.ts`, `browser-utils/idb-bundle-store.ts`, `node/launch.ts`,
`electron/native-crash-source.ts`, `bugsee-cli/src/inject/mod.rs` (the debug-ID producer).

**Verdict:** The brief's prior is **correct on every structural point**, and the single highest-risk property
in this scope — **delete-after-confirm ordering** — is right in all three durable paths and is genuinely,
comprehensively tested. I ran **68 targeted mutations**; **64 were killed**, including all 11 ordering
mutations (upload-then-delete on the live queue, on capture recovery, and on native-dump claiming) and all
21 bundle-assembly/upload mutations. These tests are **not theater**: they assert PUT header sets, the
byte-for-byte `.dmp` attachment, the `{transactions:[…]}` vs bare-array vs bare-object envelopes, backoff
delays, attempt counts, and manifest/zip cross-consistency. `transport.ts` having no runtime test is
**defensible** — it is 131 lines of which exactly **two** are executable. The real defects are elsewhere,
and three are serious. First, a **corrupt `profile` record — the exact artifact a SIGKILL leaves — makes the
recovered bundle declare `profile.json` in `manifest.json` while the archive contains only a directory entry
`profile.json/`**: a declared-but-missing file, proven empirically, in a code path whose own comment asserts
the invariant it violates. Second, the durable bundle queue has **no retention bound of any kind** — no
attempt counter, no size cap, no per-bundle TTL — so a bundle the collector permanently rejects is
re-uploaded on **every** launch forever, and every `queue_overflow`-dropped bundle is nonetheless persisted
(proven: 10 enqueues at `bufferSize:2` → 8 drops → **10 files still on disk**). Third, nothing in the wire
contract carries an **idempotency key**, so all three at-least-once paths plus the `createIssue` retry
produce genuine duplicate incidents. On the brief's protocol question: the assembler is confirmed to be the
single choke point through which all three assembly paths flow, and it performs **exactly zero** per-entry
wire transformation — `logs.json` ships `"level":"error"` and `network.json` ships `type:"message"` +
`direction`, verbatim, proven by unzipping a real bundle.

## SEV1

### 1. A single corrupt `profile` record makes the manifest declare a file the archive does not contain

- **Where:** `packages/core/src/bundle-assembler.ts:92-97` (`serializeFileData`), `:150-158`
  (`files.push` / `typedFiles.push`), `packages/core/src/bundle-writer.ts:25`.
- **What:** For `type === 'profile'`, `serializeFileData` returns `payloads[0]`. When the group is **empty**
  that is `undefined`, and `JSON.stringify(undefined)` returns **`undefined`** at runtime — while TypeScript
  types `JSON.stringify` as returning `string`, so `tsc` cannot see it. `bundle-writer.ts:25`
  (`typeof file.data === 'string' ? strToU8(file.data) : file.data`) therefore hands `undefined` straight to
  `zipSync`, which emits a **directory entry `profile.json/`**. Meanwhile `bundle-assembler.ts:151` has
  already pushed `{filename: 'profile.json', type: 'profile'}` into the manifest.
  The comment at `bundle-assembler.ts:93-96` states the invariant explicitly — *"the assembler only iterates
  file types that have ≥1 entry … so payloads[0] is always present here"* — **and that invariant is false on
  the recovery path.**
- **Why it matters:** `capture-drain.ts:16-32` builds the group by deserializing records one at a time,
  skipping any that throw, then unconditionally `out.set(type, entries)` at `:31` — so if **every** record of
  a type is un-deserializable, an **empty group is emitted**. Its own comment at `:24-27` names this exact
  case: *"A torn trailing frame — the exact artifact a crash/SIGKILL leaves"*, and states the intent to
  *"NEVER let one bad record poison the whole generation's recovery"*. The poisoning it prevents at the
  record level it re-introduces at the **bundle** level: the bundle ships with a manifest that lies. This
  reaches production through `capture-recovery.ts:67` and `native-crash-recovery.ts:108` — i.e. **the crash
  bundles**, the SDK's core value proposition. Node persists capture to disk by default, and node
  diagnostics emits `profile` entries, so the (opt-in profiling + SIGKILL) combination is a real
  configuration, not a contrivance. A manifest that declares an absent file is precisely the condition the
  brief flags as able to fail ingestion for the whole bundle.
- **Evidence (empirical, real modules via `tsx`, no source modified):**
  ```
  F1  drainReified over 2 un-deserializable `profile` records
      -> 2 failures routed to onError; resulting groups: profile=[0 entries]     (empty group IS produced)
  F3  drainReified over { log: 1 good record, profile: 1 torn record } -> assembleBundle
      ZIP MEMBERS      : ["request.json","manifest.json","apptoken","logs.json","profile.json/"]
      MANIFEST declares: [{"filename":"logs.json",...},{"filename":"profile.json","type":"profile"}]
      DECLARED-BUT-ABSENT FROM THE ZIP: ["profile.json"]
      typeof JSON.stringify(undefined) at runtime = undefined   (TS types it as `string`)
  ```
  Cross-check — only `profile` is affected: an empty `log` group yields `"[]"` and an empty `performance`
  group yields `{"transactions":[]}`, both well-formed.

### 2. The durable bundle queue has no retention bound — a permanently-rejected bundle is retried forever, and overflow-dropped bundles are persisted anyway

- **Where:** `packages/core/src/durable-upload-pipeline.ts:110-123` (`enqueue` persists at `:113`
  unconditionally, removes at `:118-120` only on `result.ok`), `:125-141` (`recover()`),
  `packages/core/src/upload-pipeline.ts:180-183` (overflow returns `{ok:false}`),
  `packages/node-utils/src/bundle-store.ts:13-32`, `packages/browser-utils/src/idb-bundle-store.ts:38-56`.
- **What:** Three compounding gaps, none of which has any counterpart in the code:
  1. **No attempt counter.** Neither `BundleStore` (`durable-upload-pipeline.ts:21-30`) nor the serialized
     frame header (`:54-61`, which carries only `{request, fileName}`) records a delivery-attempt count or a
     first-seen timestamp. `recover()` re-enqueues every listed id with no notion of how many times it has
     already failed.
  2. **A non-retryable rejection is indistinguishable from a transient one at this layer.** A 400/413 maps
     to `retryable:false` (`bundle-uploader.ts:36`), `upload-pipeline.ts:167-169` breaks out, `:171-174`
     returns `{ok:false}` — and `durable-upload-pipeline.ts:118` therefore **keeps** the file. Next launch,
     `recover()` re-uploads it, gets the same 400, keeps it again. Forever.
  3. **Overflow-dropped bundles are still written to disk.** `enqueue` calls `store.put` at `:113`
     *before* delegating, so a bundle the inner pipeline rejects synchronously with `queue_overflow` is
     nonetheless persisted and retained.
- **Why it matters:** Disk growth is unbounded **on the customer's production server**, and it is not
  covered by the existing hygiene. `packages/node/src/sweep-instances.ts:6-10,47-72` reaps only subtrees
  *"whose owning process is dead AND whose newest activity is older than the TTL"* (`:23`, 7 days) — a
  long-lived Node server's own live subtree is never swept, so its `pendingDir`
  (`packages/node/src/instance-layout.ts:70`, `launch.ts:436-438`) accumulates without limit. The rate
  limiter admits 100 reports/minute by default (`rate-limiter.ts:21-22`), and `maxDataSize` is MB-scale
  (`node/launch.ts:119`), so a crash-storm writes on the order of GB/hour that nothing will ever remove.
  Independently, the permanent-retry loop is a self-DoS: the SDK re-uploads a bundle the collector has
  already refused on every single launch, indefinitely.
- **Evidence (empirical, probe P1 — real `createUploadPipeline` + `createDurableUploadPipeline`):**
  ```
  enqueued 10 bundles, bufferSize=2, all uploads hang
  outcomes: 8 x drop:queue_overflow
  DURABLE FILES LEFT ON DISK: 10  (bytes: 10750)
  ```
  Every dropped bundle is on disk and will be re-enqueued at next launch. Confirmed by reading both
  `BundleStore` implementations that neither prunes, caps, nor ages anything: `bundle-store.ts` is
  `put`/`list`/`read`/`remove` over one file per id with no sweep; `idb-bundle-store.ts` is an unbounded
  in-memory `Map` mirror over IndexedDB.

### 3. Nothing on the wire carries an idempotency key, so all four at-least-once windows produce genuine duplicate incidents

- **Where:** `packages/protocol/src/wire.ts:55-80` (`RequestJson` — no report/incident id field),
  `packages/core/src/bundle-assembler.ts:119-138` (`requestJson` literal — `report.id` exists at
  `reporting.ts:48` but is never emitted), `packages/core/src/upload-pipeline.ts:75-100`,
  `durable-upload-pipeline.ts:117-121`, `capture-recovery.ts:76-79`, `native-crash-recovery.ts:132-135`.
- **What:** `createReportingRequest` mints a stable `id` (`reporting.ts:112,128`) and the recovery layer keys
  its markers by it (`capture-recovery.ts:78` → `markers.remove(marker.request.id)`), but the assembler never
  puts it into `request.json`. `POST /v2/issues` (`bugsee-api.ts:48-55`) is therefore an unconditionally
  issue-creating call with no client-supplied dedup token. Four distinct duplication windows follow:
  1. **`createIssue` retry (not a crash window — ordinary operation).** `upload-pipeline.ts:76-99` retries
     the `ensureSession`+`createIssue` unit on **any** non-fatal failure. A network timeout *after* the
     server committed the issue is indistinguishable from one before it, so the retry at `:97` creates a
     **second** issue. This needs no process death at all — just a slow network.
  2. **Durable queue.** `durable-upload-pipeline.ts:117-120` uploads, then removes. Death between the two
     leaves the file; `recover()` re-uploads an already-delivered bundle.
  3. **Capture recovery.** `capture-recovery.ts:76-79` — same shape, marker removed after the upload.
  4. **Native-crash recovery.** `native-crash-recovery.ts:132-135` — same shape, `.dmp` claimed after the
     upload.
- **Why it matters:** Windows 2–4 are the *correct* trade (see the delivery-semantics section — losing an
  incident is worse than duplicating one), but with no idempotency key the duplicate is unrecoverable
  downstream: the customer sees the same crash twice, with two issue ids and two recordings. Window 1 is not
  a trade at all — it is a plain non-idempotent POST retry.
- **Evidence:** Read `RequestJson` in full (`wire.ts:55-80`) — the fields are
  `type, summary, description?, labels?, severity, email?, signatures?, source, created_on, environment,
  context_id?, trace_id?, span_id?`. No id. Read `assembleBundle`'s `requestJson` construction
  (`bundle-assembler.ts:119-138`) — `report.id` is never referenced. `grep -n 'report.id\|request.id'
  packages/core/src/bundle-assembler.ts` → no hits.
  **Caveat, stated honestly:** whether the collector deduplicates server-side is outside this repo and I did
  not verify it. What is verified is that the SDK supplies nothing it *could* deduplicate on.

## SEV2

### 4. Any duplicate filename aborts the entire bundle — one collision loses the whole report, with no isolation

- **Where:** `packages/core/src/bundle-writer.ts:19-24` (both guards `throw`),
  reached from `bundle-assembler.ts:189-194`; the colliding pushes are at `:151` (captured types), `:165`
  (`crash.json`) and `:173` (attachments).
- **What:** `writeBundleZip` throws on a duplicate name and on `__proto__`. `assembleBundle` is not
  defensive about it, so the throw propagates and destroys the *entire* bundle — there is no
  drop-the-offending-file-and-continue path. Three distinct collision classes exist:
  - a report attachment whose name collides with a **root** file (`request.json` / `manifest.json` /
    `apptoken`), or is `__proto__`;
  - a report attachment whose name collides with a **captured** file (`logs.json`);
  - a captured `crash`-typed entry plus a `report.crash`, both resolving to `crash.json`.
- **Why it matters:** The failure mode is total rather than partial. The throw is caught at
  `trigger-pipeline.ts:37-45` (live path) and by the per-marker/per-dump `catch` in
  `capture-recovery.ts:82-84` / `native-crash-recovery.ts:138-140` — so it does not crash the host, but the
  incident is silently lost. In the native-crash path the marker is then kept and the dump left unclaimed
  (`complete: false` at `:148`), so the same deterministic failure repeats on **every** launch — the poison
  case #2 describes, with the evidence never delivered.
- **Evidence (empirical, probes P3/P4):**
  ```
  attachment "manifest.json" -> THREW: Bundle has a duplicate file name: manifest.json   <-- report LOST
  attachment "request.json"  -> THREW: Bundle has a duplicate file name: request.json    <-- report LOST
  attachment "apptoken"      -> THREW: Bundle has a duplicate file name: apptoken        <-- report LOST
  attachment "__proto__"     -> THREW: Bundle file name "__proto__" is not allowed       <-- report LOST
  attachment "logs.json" + captured logs -> THREW: duplicate file name: logs.json        <-- report LOST
  captured `crash` entry + report.crash  -> THREW: duplicate file name: crash.json       <-- report LOST
  ```
- **Reachability, stated precisely:** I verified that **no provider anywhere emits a `crash`-typed capture
  entry today** (`grep -rn "'crash'" packages/*/src/*.ts` → only assembler/recovery/detection-base
  producers of `source.type`), so the `crash.json` collision is latent — but `packages/node/src/launch.ts:111`
  (`CAPTURE_FILE_TYPES = [...Object.keys(DEFAULT_FILENAMES), 'attachment']`) **does** accept `crash` as a
  persisted capture type, so the door is open. The attachment collisions are reachable through
  `createReportingRequest({attachments})`, which is exported from the core index; the only in-repo producer
  today is `native-crash-recovery.ts:123` using Crashpad UUID `.dmp` names, which do not collide. Ranked
  SEV2 rather than SEV1 on that reachability basis; the *guard design* (hard throw, no isolation) is the
  finding.

### 5. A throwing `onOutcome` escapes as an unhandled rejection and can terminate the host process

- **Where:** `packages/core/src/upload-pipeline.ts:186-188`
  (`void operation.finally(() => { inFlight.delete(operation); })`), with the throw sites at `:67`, `:145`,
  `:181`, `:204`.
- **What:** `fail()` (`:62-69`) and the success path (`:145`) call `onOutcome?.(…)` from inside
  `runOperation`, **outside** any `try`. A throwing observer therefore rejects `operation`. `enqueue` returns
  that promise (handled by the caller) **but also** creates a second, derived promise via
  `operation.finally(…)` and discards it with `void` — and `.finally()` propagates the rejection. That second
  promise has no handler.
- **Why it matters:** Node's default `--unhandled-rejections=throw` turns an unhandled rejection into a
  fatal `uncaughtException`. An SDK observer bug would take down the customer's process — a direct violation
  of the binding *"interceptors must not alter app behavior"* rule and of §15.1 (`launch()`/the capture path
  must never throw out). Every other callback seam in this scope is guarded (`onError` in
  `durable-upload-pipeline.ts:92-98`, `capture-recovery.ts:82-88`, `native-crash-recovery.ts:138-146`;
  `onObserverError` in `operation-dispatcher.ts:12`); `onOutcome` is the one that is not.
- **Evidence (empirical, probe P2):**
  ```
  enqueue() REJECTED with: observer blew up   <- escapes to the caller
  unhandledRejection events captured: ["observer blew up"]
  => `void operation.finally()` creates a SECOND, unhandled rejection
  ```
- **Bounded by:** `grep -rn 'onOutcome' packages --include='*.ts'` returns hits **only inside
  `upload-pipeline.ts`** — no platform wires it today, so this is latent. It is nonetheless a documented
  public option on the exported `createUploadPipeline`.

### 6. `recover()` is unpaced: a backlog larger than `bufferSize` is discarded for the whole launch

- **Where:** `packages/core/src/durable-upload-pipeline.ts:125-141` (`recover()` loops over `store.list()`
  calling `replay` → `pipeline.enqueue` synchronously), against
  `packages/core/src/upload-pipeline.ts:180-183` (`bufferSize`, default 4 at `:54`).
- **What:** `recover()` enqueues every pending bundle in one synchronous loop. The first `bufferSize` go
  in flight; every one after that hits the overflow branch immediately and returns `{ok:false}`. There is no
  queue, no pacing, and no re-attempt later in the same session — the excess simply waits for the *next*
  launch, where the same thing happens again.
- **Why it matters:** Drain rate is `bufferSize` bundles **per launch**, not per session. A backlog of 50
  needs ~13 launches. For a browser tab or a short-lived function this can mean a backlog that never drains,
  which is the mechanism that turns finding #2's unbounded accumulation into a permanent condition. It also
  burns a `queue_overflow` outcome per skipped bundle, corrupting drop accounting.
- **Evidence (empirical, probe E1):**
  ```
  backlog on disk before recover(): 20
  PUTs actually attempted        : 4
  queue_overflow drops           : 16
  bundles STILL on disk after    : 16
  ```

### 7. Both recovery paths pass `count: Number.MAX_SAFE_INTEGER` and **no test pins it** — a survived mutation

- **Where:** `packages/core/src/capture-recovery.ts:62-65` and
  `packages/core/src/native-crash-recovery.ts:104-107`.
- **What:** Both build `FrozenPart[]` with `count: Number.MAX_SAFE_INTEGER` and the comment
  *"recover the whole part"*. Changing **either** to `count: 1` leaves the entire 683-test `@bugsee/core`
  suite green.
- **Why it matters:** This closes the lead Pass C handed to Pass D verbatim (*"if the file backend is ever
  'fixed' to honor `count`, this is the call site that must stay unbounded — please keep the two changes
  together"*). The value is load-bearing **by contract** but inert **by implementation** (Pass C SEV3 #3:
  the backends ignore `count`), and nothing anywhere records the coupling as an executable assertion. The
  day a backend starts honouring `count`, every recovered crash bundle silently truncates to one record per
  part — total capture loss on exactly the reports that matter most — and CI stays green.
- **Evidence (mutation, whole-suite):**
  ```
  [M65] capture-recovery.ts      count: MAX_SAFE_INTEGER -> 1   SURVIVED | Tests 683 passed (683)
  [M66] native-crash-recovery.ts count: MAX_SAFE_INTEGER -> 1   SURVIVED | Tests 683 passed (683)
  ```

## SEV3

### 8. The `recover()` race test asserts the absence of an upload but not the absence of a destructive delete

- **Where:** test `packages/core/src/durable-upload-pipeline.test.ts:165-173`, guard
  `packages/core/src/durable-upload-pipeline.ts:128-130`.
- **What:** Deleting the `if (bytes === undefined) continue;` guard leaves the whole suite green. With the
  guard gone, `deserializeBundle(undefined)` throws, is caught at `:134-137`, and the handler calls
  `onError(error)` **and `removeSafe(id)`** — i.e. the id a racing sibling is mid-write on gets **deleted**.
  The test only asserts `expect(enqueue).not.toHaveBeenCalled()`, which holds in both worlds. It should also
  assert `store.remove` and `onError` were not called.
- **Evidence:** `[M64] SURVIVED | Tests 683 passed (683)`. (The line *is* covered — hence the 100 % gate —
  which makes this a pure assertion-strength gap, not a coverage gap.)

### 9. No scheme validation on either the configured API origin or the server-supplied signed-PUT endpoint

- **Where:** `packages/core/src/bugsee-api.ts:29,48,65` (`baseUrl` interpolated verbatim),
  `packages/core/src/upload-pipeline.ts:124,135,155` (`endpoint` taken from the `createIssue` /
  `renewUpload` response and PUT to without inspection), `packages/core/src/bundle-uploader.ts:21`.
- **What:** The default is `https://api.bugsee.com` (`packages/node/src/launch.ts:102`), but a caller-set
  `endpoint: 'http://…'` is accepted silently, sending the app token (`x-app-token`, `bugsee-api.ts:41`) and
  the full capture bundle in cleartext. Separately, the signed-PUT URL is whatever the control plane
  returns; the SDK PUTs the entire bundle to it with no scheme or host check.
- **Why it matters:** Low severity because the control plane is HTTPS by default (so the response is
  authenticated in the normal configuration) and a plain-HTTP endpoint is a legitimate proxy/self-host
  scenario — but an explicit `https:`-unless-opted-out check is cheap and is the kind of guarantee an SDK is
  expected to make about a credential it holds.

### 10. Multiple `attachment`-typed capture entries collapse into one file literally named `attachment`

- **Where:** `packages/core/src/bundle-assembler.ts:79-81` (`fileNameForType` returns the bare string
  `'attachment'`), `:150-158`.
- **What:** Every capture entry of type `attachment` is grouped into a single manifest entry and a single
  zip member named `attachment` — no extension, no per-entry identity. `packages/node/src/launch.ts:111`
  explicitly admits `'attachment'` as a persisted capture type.
- **Evidence:** probe P4(b) — two `attachment`-typed entries produce one collapsed member. Not reachable
  today (no provider emits the type), so this is a latent design wart rather than a live defect; noted
  because the allowlist invites it.

### 11. `CrashFrame` omits `hidden`, which this repo's own crash.json example specifies

- **Where:** `packages/core/src/crash.ts:12-17` (`CrashFrame`), `:68-90` (`toCrashFrame`), against
  `docs/design/javascript-application-type.md:199-202` which shows
  `{ "trace": …, "user": true, "hidden": false, "data": {…}, "debug_id": … }`.
- **What:** `user` is emitted (hardcoded `true` at `crash.ts:82`, which matches the doc's example value);
  `hidden` is neither declared nor emitted. Also worth noting that `user: true` is unconditional — every
  frame is a "user" frame, so `node_modules`/SDK frames are indistinguishable from application frames, which
  is the distinction the flag exists to draw on Android.

## Upload delivery-semantics audit

**Semantics: at-least-once, and correctly so.** The exact ordering, verified line by line:

| Path | Persist / mark | Upload | Release | Verdict |
|---|---|---|---|---|
| Live durable queue | `durable-upload-pipeline.ts:113` `store.put` | `:117` `pipeline.enqueue` | `:118-120` `removeSafe` **iff `result.ok`** | upload-then-delete ✅ |
| Capture recovery | marker written earlier by `client.ts:457-462` | `capture-recovery.ts:76` | `:77-79` `markers.remove` **iff `result.ok`** | upload-then-delete ✅ |
| Native-crash recovery | `CrashpadSessionMarker` persisted at launch | `native-crash-recovery.ts:132` | `:133-135` `source.claim` **iff `result.ok`**; `:148` `complete: delivered === harvested` | upload-then-claim ✅ |

There is **no dequeue-then-upload anywhere** — the classic loss ordering the brief asks about is absent, and
`durable-upload-pipeline.ts:113`'s durable write genuinely precedes the first upload attempt. All eleven
mutations that inverted or removed one of these guards were killed by a named, targeted assertion (M1–M10 +
control C1), e.g. `[M8] claim-before-confirm → 3 failures, first "leaves an undelivered dump unclaimed and
reports incomplete (marker kept for retry)"`.

**Loss windows:** essentially none in core. The only loss paths are (a) `store.put` throwing, which is
swallowed by design at `durable-upload-pipeline.ts:114-116` so the upload still proceeds — the documented
best-effort trade; and (b) an `assembleBundle` throw, which loses the report (SEV2 #4).

**Duplicate windows:** four, enumerated in SEV1 #3. Windows 2–4 are inherent to at-least-once and are the
right trade; window 1 (`createIssue` retry after a committed-but-un-acked POST) is not. None is mitigable
downstream because no idempotency key is on the wire.

**Head-of-line blocking:** none in the strict sense — `recover()` iterates independently and a corrupt frame
is purged (`:132-138`, mutation M4 killed). But a bundle that *parses* and is *permanently rejected* is never
quarantined (SEV1 #2), which is head-of-line blocking across launches rather than within one.

**Multi-instance concurrent upload:** safe. Each node instance owns a private subtree
(`node/instance-layout.ts:70` → `<root>/pending`), each browser instance a private IndexedDB key prefix
(`browser-utils/coexistence.ts:82-99`), and dead-sibling recovery is taken under that sibling's Web Lock, so
two live peers cannot recover the same bundle.

**Shutdown:** in-flight uploads are awaited, not abandoned — `upload-pipeline.ts:192-201` snapshots
`inFlight` and `Promise.allSettled`s it; `client.ts:656-668` routes both `stop()` and `flush()` through it.
Uploads enqueued *after* the `flush()` call are not awaited (a snapshot, `:196`), which is defensible. I
probed the `Promise.race` timer for a leak and found **none** — it self-clears within `timeout`
(probe E2: `flush(300) resolved false after 303ms; active Timeout handles: 0`). Not a finding.

## Recovery idempotency + crash-during-recovery analysis

**Delete-vs-upload ordering: correct in all three paths** (table above). There is no
"recovery deletes the evidence then dies" window: every destructive step is strictly after a confirmed
`result.ok`.

**Idempotency of a second run.** Re-running `recoverReports` after a *successful* pass is a no-op: markers
are gone (`:78`) and the generation is swept (`:96-103`), so `byGeneration` is empty. Re-running after a
*failed* pass reproduces the same work, which is the intended retry. The sweep is correctly gated on a
**re-read** of the marker store (`:94` calls `markers.list()` a second time, not the stale `:50` snapshot),
so a marker left behind by a failed delivery keeps its generation alive — mutation M6 (removing the
`stillPending` + `keepGenerations` guards) was killed by three tests including *"does NOT sweep a generation
listed in keepGenerations (a still-pending native crash retry)"*. This closes Pass C's hand-off question:
**the ordering is intentional and `keepGenerations` does cover the marker-dropped-rather-than-consumed case.**

**Crash during recovery.** Dying mid-pass is safe-but-duplicating, never destructive:
- before the upload → marker/dump intact, retried next launch, no loss;
- after the upload, before `markers.remove` / `source.claim` → **duplicate** on the next launch (SEV1 #3);
- mid-sweep → `removeGeneration` is per-generation (`:102`), so a partial sweep just leaves more to sweep.

**Stale / foreign markers.** A marker for the *current* generation is skipped (`:51-53`, mutation M7 killed
by *"never recovers the CURRENT generation"*). A marker whose generation has no surviving chunks still
assembles — `listParts` returns `[]`, `drainAll` yields nothing, and the incident is delivered with an empty
recording rather than being dropped. That is the right call. Foreign-app markers cannot appear: node
namespaces by app token (`node/data-location.ts:9`) and browser by per-token database
(`browser-utils/coexistence.ts:92`).

**Minidump → session stitching.** Correct for the shipped v1 scope, with one documented limitation I
confirmed rather than assumed. `native-crash-recovery.ts:94` harvests via the seam and `:104-108` drains
**that marker's** generation, so dumps are stitched to the crashed session's own capture. `minidumpFile` is
set per dump from `dump.name` (`:115`), and mutating it to a constant is killed (M67). The four cases:
- **zero dumps** → `:97-99` returns `complete: true` immediately, marker clearable, generation freed. ✅
- **multiple dumps** → `:110-141` assembles one bundle per dump over a single shared drain (`:108`), each
  claimed independently; a per-dump failure is isolated (`:138-140`) and only that dump is retried. ✅
- **dump with no session** → cannot arise here; harvesting is driven *from* a marker.
- **session with no dump** → the zero-dump case above. ✅
- **Limitation (pre-existing, documented, not a new finding):**
  `packages/electron/src/native-crash-source.ts:11-14` states the v1 seam harvests **all** completed dumps
  and attributes them to the marker's session, deferring per-dump annotation matching (OQ-5). So with two
  concurrently-dead siblings sharing one app-global Crashpad directory, dumps can be attributed to the wrong
  session. This is disclosed in the source and bounded by claim-once; I flag it only because the brief asks
  about mis-stitching explicitly.

## Protocol-conversion siting

**Answer: yes — `bundle-assembler.ts` is where those conversions belong, and it currently performs none.**

- **It is the single choke point.** All three assembly paths call the same function: live
  (`client.ts:367`), capture recovery (`capture-recovery.ts:71`), native-crash synthesis
  (`native-crash-recovery.ts:127`). Nothing else writes a bundle file.
- **It already owns per-`FileType` wire shaping.** `serializeFileData` (`bundle-assembler.ts:88-99`) is
  precisely a per-type wire transform — it is where `performance` gets its `{transactions:[…]}` envelope and
  `profile` its bare-object form. A per-type *entry* transform is the same seam one level down.
- **It applies exactly zero entry-level transformation today.** `bundle-assembler.ts:152` is
  `const payloads = entries.map((entry) => entry.data)` — the captured payload verbatim — and `:157`
  JSON-stringifies it. Entries are therefore transformed **exactly once, with the identity function**: there
  is no double-transformation hazard, and no zero-transformation *bug* in the sense of a dropped second pass
  — the pass simply does not exist.
- **Empirically confirmed on a real bundle (probe P5, unzipped):**
  ```
  zip members : request.json, manifest.json, apptoken, logs.json, network.json
  logs.json    -> [{"timestamp":1,"level":"error","source":"logger","message":"boom"}]
  network.json -> [{"timestamp":2,"type":"message","direction":"out","body":"hi"}]
  ```
  `logs.json` ships the **string** `"error"` where `viewer/.../log-levels.constant.ts` expects `1`
  (protocol SEV1 #1), and `network.json` ships the invented `type:"message"` + `direction` pair instead of
  Android's `type:"websocket"` + `event:"send"` (protocol SEV1 #2).

**Recommendation:** site both fixes here, as a `Partial<Record<FileType, (payload) => unknown>>` applied at
`bundle-assembler.ts:152`, rather than at the interceptors. Fixing at the interceptor
(`capture/src/console-interceptor.ts:98`) leaves the two recovery paths replaying whatever a *previous*
SDK version already persisted to disk; fixing at the assembler normalises live and recovered capture
identically, and keeps the change in one file. **Not counted as a Pass-D finding** — the defect is already
recorded in `docs/review/protocol.md`; this section answers only the siting question.

## transport.ts adjudication

**Verdict: genuinely a type/contract module. The absence of a runtime test file is correct, and the 100 %
gate is satisfied honestly, not gamed.**

Of 131 lines, **exactly two are executable** — `transport.ts:129` and `:131`:
```ts
export const TransportToken = serviceToken<HttpTransport>('transport');
export const UploadPipelineToken = serviceToken<UploadPipeline>('uploadPipeline');
```
Everything else is `interface` / `type` / comments: `HttpTransport`, `HttpRequestOptions`, `HttpResponse`,
`IssueCreateResult`, `PutResult`, `BugseeApi`, `PutBundleOptions`, `BundleUploader`, `Bundle`,
`OutcomeCategory`, `DropReason`, `UploadHint`, `UploadResult`, `UploadPipeline` — all erased at compile time.
The two `serviceToken` calls execute on any import of the module, and `packages/core/src/index.ts` re-exports
them, so every one of the 46 test files transitively runs both statements.

- **Coverage evidence:** `pnpm --filter @bugsee/core exec vitest run --coverage` →
  `All files | 100 % Stmts | 99.67 % Branch | 100 % Funcs | 100 % Lines`, with no per-file exclusion for
  `transport.ts` in `packages/core/vitest.config.ts` (`include: ['src/**/*.ts']`, exclude only `*.test.ts` /
  `*.test-d.ts` / `*.d.ts`). It passes the real gate on its own merits.
- **`/* v8 ignore */` audit:** `grep -rn 'v8 ignore'` across all fifteen Pass-D files → **zero hits**. No
  suppressed lines anywhere in this scope, so the justification requirement is vacuously met.
- **The contracts are not untested** — they are checked by `transport.test-d.ts` (85 lines), which builds
  conforming `BugseeApi` / `BundleUploader` / `Bundle` / `PutResult` values and uses `@ts-expect-error`
  negatives to pin required members and the `PutResult` discriminator; and their *behaviour* is exercised by
  the implementations in scope (`bugsee-api.test.ts`, `bundle-uploader.test.ts` 97 lines,
  `upload-pipeline.test.ts` 414 lines).

This mirrors Pass C's `chunk-backend.ts` adjudication. The brief's "131 impl, no test" framing counts type
declarations as implementation.

## Checked and found clean

- **Delete-vs-upload ordering — the single most important property in this scope — is correct and
  comprehensively tested.** 11/11 ordering mutations killed, each by a test whose *name* states the
  invariant (*"keeps the durable copy when the upload fails (for later recovery)"*, *"leaves an undelivered
  dump unclaimed and reports incomplete (marker kept for retry)"*, *"keeps the marker AND the chunks when
  delivery fails"*).
- **Bundle assembly: 12/12 mutations killed.** Manifest/zip cross-consistency is pinned in both directions —
  removing the manifest push (M11) and removing the zip write while keeping the manifest entry (M12/M13)
  both fail. Envelope shapes (`{transactions:[…]}` M18, bare cpuprofile M19), `severityToWire` (M15), the
  binary-encoder branch (M17), time bounds (M14), email precedence (M16), request-context attribute merge
  (M61), and the attachment manifest `type` (M58) are all pinned.
- **Upload pipeline: 7/7 mutations killed** — non-retryable `break` (M22), single-renew bound (M23), fatal
  app-token fast-fail (M24, M28), `bufferSize` boundary (M25), `invalidateSession`-before-retry (M26), and
  the backoff sleep (M27, which asserts the *delay values*, not merely that a retry happened).
- **`bundle-uploader.ts`: 3/3 killed**, including a test that asserts the exact §8.3 header set **and** the
  absence of `Authorization`/`Content-Type` — real payload assertions, not "was called".
- **Retry/backoff is bounded and delegates jitter correctly.** `maxRetries` default 3 (`:55`) bounds both
  phases; `computeDelay` defaults to `util.computeBackoff` (`:58`) and M27 proves the default is exercised.
- **`stack.ts` + `debug-id.ts` producer/consumer contract verified end-to-end against the real producer.**
  `bugsee-cli/src/inject/mod.rs:48-58` emits
  `e._bugseeDebugIds[(new e.Error).stack] = "<uuid>"` from an IIFE appended to the bundle, so the top `at`
  frame of the registered stack **is** that bundle's own file — exactly what `buildDebugIdMap`
  (`debug-id.ts:31-36`) keys on. Both sides route through the same `parseStack`, so `scrubFramePath`
  (`stack.ts:21-29`) is applied symmetrically to the registration key and the crash frame and they match.
  **No producer/consumer mismatch.** 4/4 debug-id mutations and 4/4 stack mutations killed, including
  top-frame-index (M36) and the `indexOf`-vs-`lastIndexOf` split whose rationale is commented at
  `stack.ts:52-54` (M32).
- **`crash.ts` cause-chain handling is correct and well guarded** — 6/6 killed, including separate tests for
  the **cycle** guard and the depth cap (M39/M40 distinguish them, so the two conditions are pinned
  independently).
- **`rate-limiter.ts`: 5/5 killed**, incl. the half-open window boundary (M52), the limit boundary (M53),
  option validation (M55), and — notably — that it uses the **monotonic** clock (M54 killed): a wall-clock
  step cannot widen or collapse the window, as the header comment claims.
- **Error-storm bounds are layered and real.** Rate limiter 100/min (`rate-limiter.ts:21-22`) → trigger
  serialization + `maxQueueDepth` 2 (`trigger-pipeline.ts:28,64-71`, M49/M50 killed) → upload `bufferSize` 4
  (`upload-pipeline.ts:54`, M25 killed). No unbounded in-memory growth: `queue` is depth-capped and
  `inFlight` is size-capped. The unbounded resource is **disk**, not memory (SEV1 #2).
- **Dedup keying is correct.** `checkOrSetAlreadyCaught` (`client.ts:587`) keys on the **thrown object
  identity**, so two distinct crashes are never collapsed and a re-capture of the same instance is. It runs
  *before* the rate limiter (`:587` then `:591`), which is the right order — a re-throw of an already-seen
  error must not consume storm budget.
- **Auth-token handling is clean.** The app token travels in the `x-app-token` **header**
  (`bugsee-api.ts:41`), never a query string; the access token only in `authorization`
  (`bugsee-api.ts:50`). Neither appears in any `BugseeError` message (`'invalid app token'`,
  `'issue create failed (status N)'`, `'no active session'` — all token-free), and there is no logger in this
  scope at all. The token is written into the bundle as the `apptoken` member (`bundle-assembler.ts:192`) by
  design (§8.4).
- **The `X-Bugsee-Internal` self-capture sentinel genuinely closes the recursion loop.** `bugsee-api.ts:40`
  sets it on every control-plane call; the browser/webworker/vercel-edge tiers wrap the transport so *all*
  SDK traffic carries it (`browser/src/launch.ts:246-253`, `webworker/src/launch.ts:151-155`,
  `vercel-edge/src/launch.ts:121-125`); and both capture interceptors skip on it case-insensitively
  (`capture/src/fetch-interceptor.ts:190-192`, `capture/src/xhr-interceptor.ts:66`). The signed PUT carries
  no sentinel but also no `Authorization`, and it is issued through the same wrapped transport.
- **PII in error paths:** `BugseeError` messages in this scope are static strings plus a numeric status; no
  user data, URL, or body is interpolated. `describeError` (`client.ts:119-132`) puts stack text into
  `request.json.description`, which is the intended payload, not a leak.
- **Runtime portability holds.** No `node:*` or unconditional DOM import in any of the fifteen files;
  `upload-pipeline.ts:44-50` reaches `setTimeout` only through a `globalThis as unknown as {…}` cast, and all
  I/O is via injected `BundleStore` / `ChunkBackend` / `NativeCrashSource` / `HttpTransport` / `UploadPipeline`
  ports.
- **Durable frame encoding is correct and pinned** — little-endian header length (M62 killed) and
  `byteOffset`-aware `DataView` construction (M63 killed by a dedicated *"deserializes from a frame embedded
  at a non-zero byteOffset (subarray view)"* test). A corrupt frame is purged rather than wedging recovery
  (M4 killed).
- **`operation-dispatcher.ts`: 2/2 killed** — unsubscribe identity and observer-error isolation.
- **`reporting.ts` defaults are pinned** — type derivation (M45), severity derivation (M46), explicit-id
  passthrough (M47). The two `reporting.ts` survivors at file scope (`attachments`, `crash` passthrough)
  are killed by `bundle-assembler` / `native-crash-recovery` integration tests when run against the whole
  package (M48b, M47b), so they are cross-file-covered rather than uncovered — a legitimate, if
  indirect, pin.

---

**Mutation tally:** 68 run, **64 killed**, 4 survived (M64 → SEV3 #8; M65/M66 → SEV2 #7; M48 file-scope,
killed at package scope as M48b). One control mutation (C1) confirmed the harness kills what it should.
Every mutation was applied to a `cp` backup and restored from it; `git status --short packages/` was
**empty** after every batch and at the end of the review.
