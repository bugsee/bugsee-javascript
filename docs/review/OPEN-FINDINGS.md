# Open findings — fix wave of 2026-08-27/28

Live status doc for the in-flight fix + convergent-review cycle, in the shape of
`docs/review/REMEDIATION-PLAN.md`. **Read this before touching the working tree.**

## State at hand-off

Everything below is **uncommitted work in the working tree** on `main` (80 entries in
`git status`, last commit `36ec616`). Nothing has been committed or pushed. The tree is
**green on every gate** but the CLAUDE.md §6 convergent review has **not** converged — round 1
returned a SEV1, three SEV2s and a set of test gaps, so a round 2 fix wave is owed before
another review round.

```
pnpm lint          exit 0 (1 pre-existing warning, packages/node/src/index.test.ts:72)
pnpm typecheck     100/100
pnpm check:cycles  clean
pnpm test          423 files / 5710 tests / 17s
pnpm test:e2e      all suites green
turbo test:unit    51 tasks (incl. instrumentation-tests/test/bundle.test.ts, 26 tests)
```

Review harnesses, benchmarks and file backups are preserved in `.session-artifacts/`
(gitignored). The data-loss reproductions are the valuable ones — see §Evidence.

---

## Round 7 — IN FLIGHT. Round 6's review did not converge; three of its findings were regressions round 6 introduced

Four Opus reviewers (data-safety, test-quality-in-worktree, architecture, integration) against
`e62ee2c..1222109`. **Round 6 introduced three defects of its own**, two of them in the review
apparatus rather than the SDK.

### Fixed in round 7

- **F1 · SEV1 · `retained: true` was a lie on browser and webworker.** Found independently by the
  data-safety and architecture reviewers, and REPRODUCED against real stores: `retained:true` with
  `durable IDB rows = 0`, `markers left = 0` — the marker retired with nothing durable behind the
  incident. Cause: `BundleStore.put` was typed `: void`, so the queue could only observe a failure that
  threw SYNCHRONOUSLY, and `idb-bundle-store.ts` persists off the hot path and cannot. R5-1's fix was
  therefore live on node only, on the one tier where quota exhaustion is routine. Fix: `put` returns
  `void | Promise<void>`; the queue awaits it before deciding `retained` (never before ATTEMPTING the
  upload); the IDB store returns its rejection instead of swallowing it, while marking it handled so an
  ignoring caller cannot leak an `unhandledrejection` into the host page. Pinned by a COMPOSITION test
  in `client.test.ts` driving the real durable queue — every prior `retained` test used a stub pipeline
  that stages nothing, which is exactly why none of them could see this.
- **F7 · SEV3 · `clear` read `settled` outside its `try`**, so a non-conforming pipeline result became
  an unhandled rejection in the host application. Writing the test for it surfaced a SECOND site with
  the same defect at `client.ts:441` (the kill-state check), whose own comment claims `track` is
  "self-defending so a stray rejection can't surface as an unhandled rejection" — a fulfilment handler's
  throw is not covered by the rejection handler beside it. Both guarded; the test counts `onError` calls
  so each site is pinned separately.
- **Integration F1 · SEV1 · CI was red at `HEAD`.** `pnpm lint` exited 1, and lint is the FIRST step of
  the `check` job, so typecheck, cycles and coverage never ran. Cause: round 6 moved the invariants
  harness out of gitignored `.session-artifacts/` into a path Biome lints, and the gates were run BEFORE
  that copy rather than after it.
- **Integration F2 · SEV2 · the committed harness hardcoded an absolute path** to one checkout, so it
  ran only on its author's machine and — from a git worktree, the isolation this repo prescribes for
  mutating agents — silently validated the MAIN tree instead of the tree under test. Now resolved from
  `import.meta.url`. Proven: same worktree, same injected mutation, old harness `0 violations`, fixed
  harness catches it.
- **Test-quality F1 · SEV2 · two tests round 6 rewrote were VACUOUS**, and this one was mine. They
  claimed to pin `skipReportIds` by counting /v2/sessions calls; `ensureSession` shares one in-flight
  promise, so both legs await the same failing call and neither reaches /v2/issues. Verified directly:
  with the guard deleted, session count, staged-blob keys and marker state are byte-identical — with a
  failing session AND with a succeeding one. The fixture cannot observe this guard at all, so no
  assertion over it could have worked; before round 6 it failed on the mutation only incidentally, via
  the blob deletion a 403's PERMANENT verdict caused. **Removed rather than repaired**, with a comment
  naming the 14 tests across four packages that do catch the guard (verified by injection, not assumed).

### The instrument was the problem twice over

Test-quality F2 reported the harness as non-deterministic — 2 violations in 23 runs on a clean tree.
That is very likely NOT a harness defect: that reviewer ran the harness with the hardcoded path
(integration F2), so it was reading the MAIN tree while other agents were injecting mutations into it —
the round-1 hazard recorded in §Process notes. A 24-run sweep of my own reproduced the same shape and
turned out to be self-inflicted in the same way: a worktree whose `node_modules` were symlinked to the
main tree, so `@bugsee/core` resolved back to the tree I was mutating. **Isolation by worktree is not
isolation unless the dependency graph is isolated too.** A clean 25-run determinism sweep is the check
that settles it.

### Still open from round 6

- **FIXED · the harness's control-plane oracle was a second transcription of the same Java table.** A
  shared mis-transcription was invisible: injecting one produced 350 cases, 0 violations, and the cost
  was concrete — `ServerTooBusy` (99013) classified permanent would delete crash reports exactly when
  the collector is shedding load. Closed at the source rather than by adding another copy: the SDK's
  table is now enumerable data (`SERVER_ERROR_CATEGORIES`), a drift test parses Android's
  `CommunicationErrorClassifier.java` and fails if the two disagree in EITHER direction (skipping when
  the Android checkout is absent, since it is a drift detector and not a gate that can be satisfied by
  guessing), and the harness now DERIVES its expected intents from that verified table instead of
  hand-copying the Java a second time. Verified by mutation: flipping 99013 to permanent fails the drift
  test with a precise diff.
- **FIXED (found while doing the above) · the harness's liveness check was one-sided.**
  `if (control.staysAlive && !stillCapturing)` never checked the other direction, so any case declaring
  `staysAlive: false` silently asserted NOTHING about liveness — and three of the four such cases were
  wrong, left over from when an invalid app token killed the client. Now asserted both ways, and the
  expectation is derived (only `kill_sdk` may silence the SDK). Verified by mutation: making KILL_SDK
  non-fatal now fails with "the client KEPT CAPTURING after the collector switched the SDK off", which
  was previously invisible.
- **INVESTIGATED, and the diagnosis was wrong · `judgeCrossLaunch` flattens the log.** An ordered
  variant of P2 was built and then MEASURED. Unrefined it fired 15 times on CLEAN code (a recording
  dropped once its bundle is staged is correct housekeeping — the bundle already embeds the capture);
  refined to allow that, it caught nothing any other invariant did not, producing 15 findings and **0**
  unique ones against a premature-blob-release mutation. The reason is structural: you cannot settle
  bytes you have already deleted, so "deleted, then settled later" is unreachable for one artifact, and
  across artifacts of one incident it is exactly what `retained` licenses. The check was REMOVED rather
  than shipped unfalsifiable, with the measurement recorded in the harness. The blindness that injection
  really exposed was payload, not ordering — see below.
- **FIXED · no invariant ever inspected a payload.** The collector now keeps the bytes of an ACCEPTED
  PUT, and P8 asserts that a delivered live incident carries the capture that preceded it. Scoped to the
  live sets on purpose: the pre-staged sets carry frames the harness built itself, so asserting on those
  would only re-read its own fixture. Measured — with the recording sweep injected, set L goes from
  reporting NOTHING to eight P8 violations, because a marker that survives its swept recording rebuilds
  an EMPTY bundle which is then delivered and accepted, satisfying every structural invariant there was.
- **FIXED (as far as it is reachable) · a `serverCode ?? code` regression is invisible to the harness.**
  It is invisible for a reason that is pure luck: no collector code is also a valid HTTP status, so
  feeding a status through the table always lands on the `transient` default and behaves identically.
  That coincidence is now an ENFORCED invariant — a test asserts the SDK's table contains nothing in
  100–599, and it runs everywhere (it needs no Android checkout). The day someone adds a three-digit
  collector code, that is a failing test rather than a silently reachable data-loss path. The behaviour
  itself stays pinned by the unit test that reads ONLY `serverCode`.
- **Data-safety F6 · SEV3 (plausible)** · the retention pass evicts on `maxBundles`(32)/`maxBytes`/
  `maxAgeMs` with no marker awareness, so a burst over 32 incidents can discard a blob whose marker was
  already retired on the strength of `retained`.
> **Amended after round 7:** the three items that stood here — the SDK's own unbounded `flush()`
> at three sites, the harness being outside `tsc`, and the stale kill-state docstrings — were all
> closed by the very commit that wrote this list (`481a66d`). They are recorded under §Round 7.
- **Test-quality F3 · SUSPECTED** · node's per-package coverage gate reported 96.54% lines under
  concurrent vitest load, and 100% run alone — the v8-instrumentation nondeterminism of commit
  `5f2f64b`. It can fail spuriously on a loaded CI runner.

### Round 7's own review — four reviewers, and it found that round 7 shipped a HANG

Fixed in the follow-up commit unless marked OPEN.

- **SEV1 · round 7 introduced a hang.** `Promise.all([result, staged])` waited on the durable write even
  when the upload had already SETTLED, so a store whose `put` never settles wedged `enqueue` forever —
  and that promise is a `pendingReports` member, so every unbounded `flush()`/`stop()` hung with it and
  the entry leaked. Found independently by the architecture and test-quality reviewers, reproduced by
  both. Fixed: short-circuit on a settled upload, and bound the wait with `stagedWaitMs` (default 5 s)
  answering `false`, the fail-safe direction.
- **SEV1 · the round-7 fix was necessary but NOT sufficient: IndexedDB writes resolved before COMMIT.**
  `browser-utils/src/idb.ts` resolved `put`/`remove` on `request.onsuccess`, but IDB is durable at
  commit — a transaction can report every request successful and still abort there. Reproduced
  end-to-end through the real stack: `retained: true` with the blob absent from IDB. `loadAll` in the
  same file already waited for `transaction.oncomplete`; only the writers did not. Fixed for the blob
  store AND the keyed (durable-as-captured chunk) store.
- **SEV2 · a throwing `onError` sink rejected `enqueue`** on the new async path, whose rejection handler
  sits outside the `try`. The synchronous path never behaved that way. Guarded on both paths.
- **SEV2 · three defects in round 7's own flush bounds.** (1) `Number.POSITIVE_INFINITY`, documented as
  restoring unbounded behaviour, did the OPPOSITE — `setTimeout(fn, Infinity)` coerces to 0 and fires at
  once; non-finite now means no deadline. (2) `DEFERRED_FLUSH_TIMEOUT_MS = 10_000` landed inside
  `computeBackoff(1)`'s jitter window (10 s ± 10%), buying ZERO retries; raised to 15 s, which costs
  nothing off the response path. (3) The override was unreachable through `@bugsee/cloudflare` — the
  only package using the aggressive 3 s awaited path — so `DurableObjectInstrumentOptions` now carries
  `flushTimeoutMs` and `instrumentEdgeClass` forwards it.
- **SEV2 · an abandoned flush was silent.** `client.flush(timeout)` ABANDONS on its deadline and reports
  it by returning `false`; no caller read it. On the edge tier there is no durable queue and no next
  launch, so that is a permanently lost incident. All three sites now route it to `onError`.
- **SEV2 · `withBugseeEvent`'s fourth positional parameter** was inconsistent with both siblings in the
  same commit, and `SW_FLUSH_TIMEOUT_MS` was unexported so a caller could not name the default. The
  third parameter now takes the original bare `onError` OR a `BugseeEventOptions`; the constant is
  exported.
- **OPEN · SEV2 · the widened `BundleStore.put` is a source-level BREAKING CHANGE** for TypeScript
  integrators: `() => void` accepts any return value, `() => void | Promise<void>` does not, so
  `put: (id, b) => map.set(id, b)` no longer compiles. No in-repo or documented implementation is
  affected, but it needs a changeset note for external users.
- **SEV3 · docs and comments.** `BundleStore`'s summary was orphaned onto a private helper by the
  `isThenable` insertion, stripping it from the published `.d.ts`. `client.ts` claimed its new
  two-condition rule was "the same rule" as `capture-recovery.ts`/`native-crash-recovery.ts`, which gate
  on `isUploadSettled` ALONE. `errors.test.ts` and `client.test.ts` still paired an HTTP 401 with
  `fatal` — the exact conflation the wave removed. The `skipReportIds` replacement comment said 14 tests
  where the true count is 15 (my count came from a truncated list) and omitted `node/src/launch.test.ts`.
  All corrected.
- **Test quality · my own new tests.** Three flush tests failed by 30 s TIMEOUT rather than by assertion
  (their fakes resolved only when given a deadline): no expected/received, 30 s of CI wall clock per
  regression, and indistinguishable from runner flakiness. The fakes now resolve unconditionally and the
  assertions do the work — verified at 0–3 ms failures under mutation. The "defaults onError to a no-op"
  test was NEAR-VACUOUS (I chased a function-coverage number) and is now honest about what it can
  observe. The deferred-path `flushTimeoutMs` override was uncovered; now pinned.
- **OPEN · the coverage figure in the round-7 commit message ("31/31") described a FILTERED run**, not
  the gate, which reports 97 tasks. The gate passed; the number was presented as though it were the whole.
- **OPEN · a pre-existing coverage flake can take CI red**: `@bugsee/protocol`'s wall-clock linearity
  self-test failed once under parallel load and turbo then cancelled 14 sibling tasks. Family of `9b0260f`.
- **FIXED · the report-marker store was the remaining half.** `ReportMarkerStore.put` is now
  `void | Promise<void>`, `idb-report-marker-store.ts` returns its promise rather than swallowing it to
  `onError` (with the same handled-rejection net as the bundle store), and `client.ts` reads the answer.
  It does not change WHEN a marker is retired — it changes what the SDK knows about whether keeping one
  means anything. When an upload neither settles nor stages a bundle AND the marker could not be
  persisted, the incident is definitively unrecoverable, and the client now says so with a distinct
  diagnostic instead of keeping a marker that exists only in a mirror which dies with the page. A failed
  marker write whose bundle WAS retained is still reported, but not escalated — recovery rides the blob.
  `isThenable` moved to `@bugsee/util` so the two store contracts share one definition.
- **FIXED · `node-utils` wrote bundles non-atomically.** `writeFileSync` truncates its target before
  writing, so a crash or ENOSPC part-way left a parseable frame header over a truncated body — and
  `recover()` treats `<id>.bundle` as a complete artifact, so it uploaded the corrupt bundle as though it
  were valid. New `writeFileAtomic` (temp sibling → fsync → rename, the invariant Android holds in
  `IssueReportingRequest.publishFinalBundle`) backs the store's `put`; `list()` cannot see a `.tmp`
  sibling, so a write in flight is invisible to recovery.
- **DISMISSED (checked, does not apply) · the "two more unbounded flushes"** at
  `electron/src/launch-renderer.ts:106` and `webview/src/launch.ts:392`. The finding assumed both tiers
  sit behind "the same ~140 s ladder". They do not: neither client has an HTTP upload pipeline at all.
  Both route every report through a trigger pipeline that posts over IPC / the native bridge and, in
  `renderer-report-pipeline.ts:42`'s words, "never upload locally" — there is no fallback to HTTP when
  the bridge is down, it answers `{ok:false}`. `webview/src/launch.ts:333` states it outright: "No
  transport / upload pipeline / bundle store / IndexedDB." So the calls are unbounded but nothing behind
  them can retry, and adding a deadline would be cargo-culted from the edge tier. Left as-is
  deliberately.
- **OPEN (minor) · `electron/src/launch-main.ts:203-204` does not wait for renderers.** `control.flush()`
  broadcasts and returns, so main's `flush()` resolves without any renderer having drained. Renderers
  stream continuously, so this is a race at the margin rather than lost capture — but "flush" does not
  mean what its name says across the process boundary. The control protocol broadcasts a bare command
  with no payload, so carrying a deadline would be a wire change.

### Verified clean by round 6 (worth not re-checking)

Removing the 401/403 kill rule was verified SAFE **by reading the appserver**: `error.router.js:50`
calls `res.code(200)` unconditionally, so an invalid app token arrives as envelope code `14019` on an
HTTP 200 and never as a 401. The rule that was removed guarded a response shape the collector does not
produce. No sample, e2e harness or design doc still executes on the old assumption — `enterKillState`
has two references, `fatal` one producer and one consumer. `UploadResult.retained` adds no public
surface (not in the `@bugsee/core` barrel). The new marker rule is a strict SUBSET of the old one, so
it can only keep more markers, never delete more. No configuration can hold markers nothing can retire.

---

## Blocked on a human decision

### D1 · WebView `input` stream is dropped by both native receivers — **SEV1**

`@bugsee/webview` moved off `events.user` onto the new `input` stream (correct: SDK code must
never write to a `*.user` stream). Both native routers are `if/else if` chains with **no
default**, so `input` entries match nothing and fall out silently — every WebView session now
loses its interaction stream, which `routeEvent` used to deliver.

- Android `android/sdk/.../interception/webview/BridgeCaptureRouter.java:89-107`
- iOS `ios/sdk-rebase/.../Interception/WebView/BGSBridgeCaptureRouter.m:143-157`

`packages/webview/bridge-protocol.schema.json` and the `hello.caps` list
(`packages/webview/src/launch.ts:99`) were updated while neither receiver was — a bridge wire
change shipped one-sided. Declaring the capability buys nothing; `launch.ts:88-92` states
native "records them nowhere and they decide nothing".

**Two options:** land the `input` branch in both native repos first, or revert the webview tier
to `events.user` until they do. Android's receiver is code-complete locally; iOS is on Gerrit
(16606–16621). Cross-repo, so not a unilateral call.

**Narrowed 2026-08-31 (not closed).** The `change`/`submit`/`focus` records are no longer on this
stream at all — they are `ui.*` breadcrumbs now, on the already-routed `breadcrumbs` type (see the
decided item under "New open items from round 2"). D1 still stands for the pointer/key records, which
are genuinely device input and have nowhere else to go. `hello.caps` additionally now declares
`breadcrumbs` (`packages/webview/src/launch.ts`), which it previously omitted even though the embedded
app's own `client.addBreadcrumb()` calls have always streamed over the bridge.

### D2 · Fix D's two SEV2s were scoped out of every wave so far

Confirmed independently by two reviewers, still unfixed:

- `packages/node/src/server-instrument.ts:479-483` — a `try/catch` around `getAttributes()`
  that is **unreachable in production** (`getAttributes` is a required, non-throwing member of
  `Span`, and `finishWith` already sits inside an outer catch). What it actually accommodates is
  **nine `Transaction` test doubles across seven adapter packages** that omit the method, so
  every one of their `setName` assertions now passes via the degraded path and **F-4 is untested
  in all seven adapters**. `server-instrument.test.ts:257-271` covers the catch with a fake that
  cannot exist in production — a test for code that exists for tests.
- `packages/performance/src/controller.ts:81,119,128-132` — one module-global `active`
  transaction slot rather than a per-request handle. Pre-existing, but F-4 **amplified** it:
  before, `finishWith` re-stamped the automatic name and silently corrected a mis-named
  transaction; now the guard sees the stray attribute and skips, so the wrong route name sticks.
  No regression today (verified: every `setRouteName` caller is a frontend router via
  `web-adapter/src/adapter.ts:84`; no server adapter calls it), but the hazard is live for any
  app that calls it server-side.

---

## Round 2 — DONE (2026-08-31). Gates: lint 0 · typecheck 100/100 · cycles clean · 423 files / 5748 tests

Every item below was fixed unless marked otherwise. Kept for the reasoning, not as a work list.

**Resolved:** R2-1 (own-queue leg now reconciled per dead instance; `ds-probe2.mts` S4 2 uploads → 1),
R2-3 (`isUploadSettled` in `core/src/transport.ts` — ONE definition now used by the live pipeline and
all three recovery legs; S3 3-enqueues-forever → 1 enqueue, blob and marker freed), R2-4, R2-5, R2-6,
R2-7 (guard widened 5 → 9 packages **and** taught to scan non-`index` entries — electron emits to
`main.js`, remix to `server.js`, so the table alone would have stayed blind), R2-8 (`NAME_SOURCE_ATTRIBUTE`
moved to `@bugsee/protocol`; `grep -c "@bugsee/performance" packages/node/dist/index.{js,cjs}` → 0),
R2-10 items in R2-11, D2 part 1 (inner `try/catch` removed; **twelve** `Transaction` doubles fixed, not
the nine the review found — a 10th surfaced as a HANG when the catch came out, and bun/deno held an
11th and 12th; a real F-4 test now exists in each of the 7 adapters).

**R2-2 — ACCEPTED BY DESIGN, not fixed.** The only candidate fallback key is request content
(`created_on` is stamped at assembly, so a rebuild never matches its blob), and two genuinely distinct
incidents routinely share all of it — keying on it converts a bounded, self-clearing, one-launch
duplicate into **silent loss of a real crash**, the one outcome the policy exists to prevent. The
branch's live purpose is the synthesized native-crash bundle, which has no marker and for which
replay-and-never-reconcile is correct. `durable-upload-pipeline.ts` now says GUARANTEED, not "possible".

**R2-9 — NOT A DEFECT.** 76 sequential runs + 20 under artificial CPU load: **zero failures** (round 1
saw 4/18 on the same commit; at that rate 0-in-76 has p ≈ 5×10⁻⁹). No shared mutable state, no
unresolved async, `MAX_REPLAY_EVENTS` never reassigned. Most likely cause: round 1 ran **four reviewers
concurrently** while the SDK suite was also running, and Karma binds a fixed port 9876 — which explains
the impossible cross-spec error better than any spec defect. No speculative `beforeEach` was added. If
it resurfaces, capture non-ANSI output (`--reporters=tap`) and the Jasmine seed.

**Two pre-existing defects fixed on the way:** `recover()`/`pump()` did not guard a throwing
`BundleStore`, so an unreadable `pending/` threw straight out of `launch()`; and `replay()`'s
fire-and-forget `attempt` had no `.catch`, so a rejecting pipeline escaped as an unhandled rejection.

**`invariants.mts` is now trustworthy.** Its oracle keyed I2 on `reportId ?? 'anon:'+summary`, which made
a legacy blob and its own marker's rebuild two different incidents — that is how it swept the R2-2
violation and discarded it. Oracle now resolves the incident from the case definition; matrix widened
48 → **117 cases** (two passes, `permanent: true`, throwing pipelines and stores, injected `bundleStore`
under real launch wiring, 1 and 2 dead subtrees, concurrent recoverers). 0 violations, and it now
REPORTS the 72 accepted R2-2 legacy double-reports and the known concurrent-recoverer duplicate rather
than hiding them.

## Round 5 review — DID NOT CONVERGE. 1 SEV1, 4 SEV2, 3 SEV3 from 4 reviewers

> **Status, amended after rounds 6 and 7.** R5-4, R5-6, R5-7 and R5-8 were fixed in round 6.
> R5-1 (the marker retired on a retryable failure) was fixed in round 6 for the NODE tier only —
> round 6's own review found the same loss still live on browser/worker, and round 7 closed it
> (see §Round 7). R5-2 and R5-3 were fixed in round 6. The heading is kept as it read at the time.

**But the streak broke: round 4 introduced NO new loss path.** Rounds 1-3 each did. Round 5's SEV1 and
two of its SEV2s are PRE-EXISTING defects that round 4 made visible by unifying everything around them;
the rest are test-coverage gaps, not breakage.

### R5-1 · SEV1 · The LIVE report path retires the marker on a retryable failure

`packages/core/src/client.ts:517-524` — `result.then(clear, clear)` retires the report marker on ANY
settlement, justified by `client.ts:487` ("by which point the durable bundle queue owns delivery").
`durable-upload-pipeline.ts:403-407` falsifies that: it catches a throwing `store.put` and continues.
So a failed durable write (ENOSPC / EROFS / EACCES / EDQUOT, a `RangeError` from `serializeBundle`, or
any integrator `options.bundleStore`) PLUS a **retryable** upload failure erases everything — no blob,
no marker, and the next launch's sweep (`capture-recovery.ts:216-225`) frees the orphaned capture
generation because nothing names it. CONFIRMED against a real `launch()`:

```
before settle:        markers = 1
after RETRYABLE 503:  markers = 0, generations = 1, PUT attempts = 4
launch 2, accepting:  uploads = 0
```

This is the ONLY marker-retirement site that gates on nothing — `capture-recovery.ts:101,196` and
`native-crash-recovery.ts:138` all use `isUploadSettled`. **`client.test.ts:834` asserts the defect**
("clears the marker even when the upload fails (the durable bundle queue then owns delivery)") with a
bare `vi.fn` pipeline that stages nothing, so its own parenthetical is false — the same pattern as the
six in `REMEDIATION-PLAN.md`. Fix: gate `clear` on "blob actually staged, or `isUploadSettled(result)`";
keeping the marker on a retryable failure is already the reconciled case.

### R5-2 · SEV2 · A transient 401/403 permanently disables the SDK, and core holds two opposite verdicts

`upload-pipeline.ts:106-107` turns a 401 or 403 from `ensureSession` into `fatal: true` →
`client.ts:440` → `enterKillState` (`client.ts:469-475`): capture and detection stopped, `launch()` a
permanent no-op (`client.ts:690-694`). Meanwhile `transport.ts:171`, eighty lines away, asserts as
Android parity that 401 is retryable. Android agrees with the second: `BugseeCommunicationManager.java:624-635`
treats 401 as session expiry → invalidate + retry once (`:615-618`), and the app-token blacklist fires
ONLY on server error code `KILL_SDK` (`:776-781`), never on an HTTP status.

### R5-3 · SEV2 · Collector error codes are unclassified AND share a numeric field with HTTP statuses

`bugsee-api.ts:49-51` throws `BugseeError(msg, code)` carrying the COLLECTOR's error code — and a v2
rejection arrives with **HTTP 200** (`:38-42`). `upload-pipeline.ts:106` then reads `err.code` as an HTTP
status. Two consequences: Android's permanent codes (14019 InvalidAppToken, 11004 ApplicationTypeMismatch,
99098 UnsupportedSdk, 99099 KILL_SDK — `CommunicationErrorClassifier.java:46-53`) have NO JS analogue
(`classifyServerErrorCode`: 0 hits) and are retried forever; and an envelope code that happens to be
401/403 is misread as an auth status and kills the SDK. `bugsee-api.ts:66-70` records that
`ApplicationTypeMismatchError` once rejected every session, so these codes occur in production.

### R5-4 · SEV2 · R3-4's PLATFORM exposure is not closed — identical survival numbers to round 3

`node/src/launch.ts:777`, `browser/src/launch.ts:566`, `webworker/src/launch.ts:348`. Mutating
`pipeline: baseUploadPipeline` → `pipeline: durable ?? baseUploadPipeline`: **node SURVIVED 109/109,
browser SURVIVED 88/88, webworker SURVIVED 66/66** — byte-identical to round 3. Found independently by
two reviewers, one with mutation proof. Core's guard (`launch-recovery.test.ts:164`) IS falsifiable
because it uses a **503**, so the re-staged copy persists and is visible; all three platform tests use an
**OK** transport, where the copy is removed on success and the duplicate never materialises. The hazard is
retryable-failure-only. `tsc` cannot help: `DurableUploadPipeline` structurally satisfies `UploadPipeline`.
Round 4's claim that "the three places a platform could get it wrong" died is FALSE for this parameter.
Fix: one platform test with a retryable transport, or narrow `LaunchRecoveryOptions.pipeline`.

### R5-5 · SEV2 · The harness cannot see the R2-3/R3-6 class it was rebuilt to guard

Re-injecting exactly "a permanently-refused bundle is never freed, so it is re-uploaded every launch
forever" produces **zero** violations:

```
DEFECT RE-INJECTED:  231 cases swept, 0 invariant violations
CURRENT:      PUTs per launch  L1:1 L2:0 L3:0 L4:0 L5:0
RE-INJECTED:  PUTs per launch  L1:1 L2:1 L3:1 L4:1 L5:1
```

Four structural reasons: **(1)** P3 counts a delivery only for `harnessVerdict === 'accept'`
(`invariants.mts:187-190`) and `:380` supplies exactly one 2xx, so at-most-once is inert in 10 of 11
status columns; **(2)** P3 is per-launch everywhere (A creates a fresh collector inside the pass loop at
`:415`; B/C/D/F/G/H are single-launch; E set-dedupes via `judgeEventual`), so "again on every launch" is
unrepresentable; **(3)** capture generations are never observed (`readNodeState:333-345`,
`browserLeft:829-849`), so `capture-recovery.ts:224`'s `removeGeneration` — the call that destroys a
session's recording — is invisible to P1/P2; **(4)** **the live report path is never exercised**, which is
exactly how R5-1 escaped five rounds. Fifth, narrower: `harnessVerdict(403) = 'refuse'` while the SDK
never settles a 403, so a regression to "delete on the first 403" sweeps clean across all 33 403 cases.

**And the independence is of PROVENANCE, not outcome.** `harnessVerdict` imports no SDK predicate
(verified) but agrees with `isRetryableHttpStatus` bit-for-bit, so a shared mis-transcription of the Java
would be undetectable by construction.

### R5-6 · SEV3 · `shared:` true-direction untested in all three platforms

Same three sites, one line up. `shared: false` → CAUGHT everywhere; `shared: true` → **SURVIVED**
109/109, 88/88, 66/66. Timing/ordering only, not loss.

### R5-7 · SEV3 · The release pass is unconditional against a THROW, not against a HANG

`launch-recovery.ts:130` `await scan(...)` gates the release pass at `:136-139`. At `36ec616` the
own-queue recover fired independently. A scan that never settles (a wedged IDB transaction, or an upload
against a transport with no timeout) holds the shared queue's release for the whole launch, and deferred
blobs stay withheld from the pump. Fail-safe — everything is kept — and the unavoidable price of R2-1,
but the docstring at `:64-75` calls the release pass "unconditional", which is true only for a throwing
scan. One sentence closes it.

### R5-8 · SEV3 · Three more `as unknown as Transaction` doubles, inside `@bugsee/performance` itself

`interactions.test.ts:36-41` (3 of 16 members), `idle-transaction.test.ts:34-39` (2 of 16),
`navigations.test.ts:36-41` (3 of 16). **Mitigating, and checked rather than assumed:** those three
source files contain no `try`/`catch` on the span path, so a missing member throws loudly instead of
degrading silently — the opposite of what `server-instrument.ts`'s outer catch did. They are one added
`try/catch` away from being the sixteenth. Also `node/src/launch.test.ts:2326` is outside the `tsc` net
for the same `registerExt(name, api: unknown)` reason as bun/deno (behaviourally falsifiable, N1-N5 all
caught).

### R5-9 · LOW · Documentation defects, several in code this wave wrote

`transport.ts:167` and `invariants.mts:81` cite `toJobResult` at `:63-74`; it is at
`CommunicationErrorClassifier.java:60-71` — the same class R3-13 recorded as resolved · `transport.ts:161`
claims to be "THE classifier — the single place that decides `retryable`", which is false
(`bundle-uploader.ts:41-46`, `upload-pipeline.ts:106-107,177-193` each decide independently) ·
`transport.ts:183-184`'s sub-400 rationale misdescribes Android (`ReportUploadExecutor.java:605,638`
treats 200≤code<400 as DELIVERY, not retry; the JS choice is the safe direction, the justification is
wrong) · `launch-recovery.ts:41-48` states "every recovered blob … NEVER the durable queue" as a global
invariant, which node's `uploadPipeline = durable ?? base` (`node/src/launch.ts:484,763`) contradicts ·
`docs/review/electron.md:180` reads `settled` with the old `delivered` meaning ·
`docs/design/browser-multi-instance-coexistence.md:66` states the R2-1 defect as the design ·
`docs/design/multi-instance-disk-coexistence.md:84-86,114-115` describes a `recoverInstances` that no
longer exists · **`docs/PROGRESS.md` has zero record of round 4's architecture delta** (0 hits for
`launch-recovery`, `isRetryableHttpStatus`, `isUploadSettled`) despite being the designated hand-off doc.

### R5-10 · LOW · Barrel bookkeeping, and my own error

The wave **added** two consumerless exports while stripping others: `isRetryableHttpStatus`
(`core/src/index.ts:233`) and `recoverSiblingBundleQueue` (`browser-utils/src/index.ts:44`). Widening the
public surface of the one classifier that decides whether a crash report is deleted is the part worth
reconsidering. `@bugsee/core`'s barrel has ~72 of 207 exports with no consumer outside core and no
internal/public convention. Three DI tokens leak, not one: `RequestContextStoreToken` plus
`EdgeContextStoreToken` twice via `export *` (`bugsee/src/index.edge-light.ts:13`, `index.workerd.ts:9`).

**And the "unexported 8 consumerless symbols" claim in §Round 4 above is WRONG** — the barrel diff vs
`36ec616` removed only 4 (`createUserEventsProvider`, `UserEvent`, `UserEventSource`,
`UserEventsProviderOptions`); the 8 were never in the committed barrel, being new files never added to
it. This doc also said "seven" in one place and "8" in another. No functional impact (nothing outside
used them; `@bugsee/capture` is `private: true`) — but the record was wrong.

### R5-11 · The Android correlation-key insight (reopens R2-2)

Review item 6's premise was wrong: "staged bundle wins, marker retired" is **not** a JS invention —
Android does exactly it at `BugseeIssueReportingCoordinator.java:1286-1300`, and `ReportUploadExecutor`'s
`FileLock` is a different mechanism (cross-PROCESS exclusion on one file). **The real divergence is the
key.** Android NAMES the bundle file from its snapshot id, so the correlation IS the storage key and can
never be absent (`bundleCorrelationId`, `:1360-1371`; the reconciliation at `:1287` is a filename lookup).
JS keys blobs by `newId()` (`durable-upload-pipeline.ts:102,404`) and carries the correlation INSIDE the
frame as an optional header field. So R2-2's "no sound fallback key exists" is a consequence of that
storage-key choice, not a law of nature — **R2-2 is fixable, not merely acceptable.**

### Verified clean in round 5 (do not re-check)

`isRetryableHttpStatus` transcription exhaustively compared against an independent re-transcription over
every status −5..1000: **0 mismatches** · `transport.test.ts` took 14 mutations, all caught, every table
entry individually pinned · the hoist is correct for all three platforms, no silent ordering or
error-handling change · `deferred.delete` at hand-over closes the gap under every reachable interleaving
(4 walked) · both R3-2 layers independently correct · the `settled` rename complete in code and tests ·
the de-cast doubles do not pass incidentally (proven positively) · the `tsc` mechanism works, including
the hand-edited `satisfies Transaction` · tsup guard falsifiable per target, all 10 red when reverted ·
`packages/instrumentation-tests/harness/invariants.mts` runs clean in-tree (283 cases, 17.4 s) and imports no SDK predicate ·
`skipReportIds` complete on return · 403 renew not broken by the new classifier · Stryker leftovers inert ·
bun recovery verified as genuinely bun's file, diff shape-identical to deno's.

### Round 6 shape (proposed, not started)

1. **R5-1 first** — it is a live-path report loss and the fix is small.
2. **R5-2 + R5-3 together** — they are one problem: the SDK has no classification of collector error
   codes and conflates their namespace with HTTP statuses. Fix with the harness case, not before it.
3. **The harness must start at `logException`.** Every version so far seeds pre-staged artifacts and runs
   recovery, which is precisely how R5-1 survived five rounds. Also: make P3 cross-launch, observe capture
   generations, and derive the oracle from a different source than the implementation so provenance
   independence becomes outcome independence.
4. **R5-4** — a platform test with a retryable transport, or narrow the type.
5. Documentation (R5-9) is a real deliverable here, not tidying: `PROGRESS.md` is the designated hand-off
   doc and has no record of the current architecture.

## Round 6 — DONE, then REVIEWED (did not converge; see §Round 7). R5-4, R5-6, R5-7, R5-8 fixed

Gates re-run whole-tree after the change: `pnpm lint` exit 0 (the one pre-existing warning,
`packages/node/src/index.test.ts:72`) · `pnpm typecheck` 100/100 · `pnpm check:cycles` clean ·
`pnpm test` 430 files / 5906 tests. Per-package coverage on every package touched: node
100/98.36, browser 100/98.72, webworker 100/100, performance 100/99.16, core 100/98.75
(stmts/branch; lines + funcs 100 throughout).

### R5-4 — CLOSED, by TEST, not by type. The type direction does not work; here is the proof

The stronger-sounding option (narrow `LaunchRecoveryOptions.pipeline` so a `DurableUploadPipeline` cannot
satisfy it) **cannot catch the mutation that is actually at issue**, and the reason is worth recording so
nobody re-proposes it. The obvious brand is `pipeline: UploadPipeline & { recover?: never }`. It does
reject a bare `DurableUploadPipeline` — but the mutation is `durable ?? baseUploadPipeline`, and TypeScript
computes `??` with **subtype reduction**: `DurableUploadPipeline | UploadPipeline` collapses to
`UploadPipeline` before the assignment is ever checked. Measured, not assumed:

```
const bad: BasePipeline = durable2;         // TS2322 — rejected
const bad: BasePipeline = durable ?? base;  // COMPILES. Eq<typeof (durable ?? base), UploadPipeline> = true
```

The same reduction has already happened for `uploadPipeline` (`node/src/launch.ts:484`,
`browser/src/launch.ts:354`, `webworker/src/launch.ts:233`), so `pipeline: uploadPipeline` — the most
likely form of the mistake in real life — would be invisible to any such brand too. A positive brand
(`UploadPipeline & { __nonDurable: true }`) WOULD survive reduction, but it has to be minted by
`createUploadPipeline` in `core/src/upload-pipeline.ts`, which is outside this agent's scope and would
push a test-only concern into the public return type. **So: tests.**

**Two per site, one behavioural and one structural.**

- **Behavioural** (`node/src/launch.test.ts:1459`, `browser/src/launch.test.ts:1326`,
  `webworker/src/launch.test.ts:441` — "re-stages NOTHING in the injected store when a recovered blob's
  upload fails retryably"). Each is its tier's existing R2-1 fixture with the transport changed to a **503
  on `/v2/sessions`**, which is exactly the condition round 5 identified as missing: the attempt never
  settles, so the second copy the durable queue stages on the way IN survives the pass instead of being
  removed by the success. Asserts the integrator store's `put` log is empty and its keys are still exactly
  `['staged']`. Each ends with `client.stop(0)` because the 5 s retry backoff is deliberately still running.
- **Structural** (new `launch-recovery-wiring.test.ts` in each of the three packages). Partially mocks
  `@bugsee/core` to spy `runLaunchRecovery`, then pins the arguments directly:
  `pipeline !== queue` and `pipeline.recover === undefined` (the latter also rejects some OTHER durable
  pipeline), for both the injected-store and the per-instance-queue launch.

**Mutations re-injected, each verified as a real on-disk change (`diff` against `git show HEAD:<path>`):**

| site | mutation | behavioural test | wiring test |
|---|---|---|---|
| `node/src/launch.ts:777` | `pipeline: durable ?? baseUploadPipeline` | FAIL — `expect(puts).toEqual([])` got `['1788261626165-1']` | FAIL ×2 |
| `browser/src/launch.ts:586` | same | FAIL — got `['1788261704921-1']` | FAIL ×2 |
| `webworker/src/launch.ts:348` | same | FAIL — got `['1788261776135-1']` | FAIL ×2 |
| `node/src/launch.ts:777` | `pipeline: uploadPipeline` | — | FAIL ×2 |

The behavioural failures are the finding made concrete: under the mutation the integrator's store ends the
launch holding **two blobs for one incident**, which the next launch uploads twice with differing payloads.

### R5-6 — CLOSED, structurally, and here is why not behaviourally

`shared: true` has **no observable consequence** in browser or webworker: without an injected store the
queue is the per-instance one, whose namespace is fresh every launch, so it is empty and holding it back
for the scan only changes when an empty queue is read. In node it is observable only by seeding a blob
whose `reportId` matches a dead sibling's marker into a per-instance `pending/` dir — a state that cannot
occur (the dir is new each launch), and the "correct" assertion there would be *two* uploads. That is
precisely the shape `REMEDIATION-PLAN.md` warns about, so it was not written. The predicate is pinned
against the call instead, in both directions, in all three `launch-recovery-wiring.test.ts` files.

**Mutations re-injected (all three sites, `diff`-verified):** `shared: true` → the `false`-direction test
fails in all three; `shared: false` → the `true`-direction test fails in all three. `shared: false` was
already caught behaviourally; both directions are now caught.

### R5-7 — CLOSED as documentation, with no timeout added

`core/src/launch-recovery.ts:76-85` now states that "unconditional" holds against a scan that REJECTS, not
one that never settles, and says what a wedged scan costs. **No timeout was added, deliberately:** the
release pass exists to hand over only what no dead sibling claimed, so releasing on a timer would hand over
blobs whose incidents a still-running marker leg is about to rebuild — the R2-1 double upload, with
differing payloads that nothing downstream can collapse. Holding costs one launch's delay on data that
stays durably staged; releasing early costs a duplicated crash report. Nothing is lost either way, so the
cheaper mistake wins.

### R5-8 — CLOSED for `@bugsee/performance` (+ node); bun and deno are NOT closed

`interactions.test.ts:40`, `idle-transaction.test.ts:39` and `navigations.test.ts:40` are now full
16-member `const txn: Transaction = {…}` literals with the cast removed, matching the ten de-cast in round
4. `node/src/launch.test.ts:2372` (the `registerExt` double round 5 flagged) is annotated too — node already
depends on `@bugsee/performance`, so it needed no install.

**Proven, not assumed:** adding `__probeMember(): void` to `Transaction` (`performance/src/span.ts:39`) makes
`tsc --noEmit` reject all three performance doubles (TS2741) plus the real `TransactionImpl` (TS2420), and
separately rejects the node double (TS2741 at `launch.test.ts:2372`). Probe removed and both packages
re-verified green.

**Still open:** `@bugsee/bun` and `@bugsee/deno` — see the narrowing note under §Round 4's enforcement
mechanism. Four doubles, closable by adding `@bugsee/performance` as a devDependency to each package and
annotating them; needs `pnpm install`, so it is reported rather than done.

## Round 4 — DONE (2026-08-31). Gates: lint 0 · typecheck 100/100 · cycles clean · 425 files / 5793 tests

**Resolved:** R3-1 (new `isRetryableHttpStatus`, `core/src/transport.ts:158-193`, Android-parity
member-for-member with `CommunicationErrorClassifier.classifyHttpStatus` ∘ `toJobResult`: 401 + 408/425/429
+ 5xx + <400 retryable, every other 4xx permanent) · R3-2 (two layers: the release pass now runs
UNCONDITIONALLY after an awaited scan, and the liveness probe moved INSIDE the per-subtree `try` so one
unreadable `owner.json` cannot reject the whole scan) · R3-3 + R3-4 (orchestration hoisted into
`core/src/launch-recovery.ts`; `grep reconcileSharedQueue|createMarkerAwareBundleReplay` across the three
launches now returns NOTHING — node −59 lines, webworker −92 — so the "never `durable`" invariant is one
definition with one test) · R3-5 (`deferred.delete` at hand-over, with the invariant now STATED and
enforced) · R3-6 · R3-7 (all 15 doubles; enforcement is now structural — see below) · R3-8 · R3-9 ·
R3-10 · R3-11 · R3-13 (4 citations + 8 consumerless exports).

**The enforcement mechanism (R3-7's real fix):** the `as unknown as Transaction` casts were REMOVED from
10 doubles, so `tsc --noEmit` — already a CI gate — rejects a non-conforming double at authoring time.
Proven by adding a `__probeMember` to `Transaction`: all 10 failed with TS2322/TS2741, plus the real
`TransactionImpl`. Fifteen instances were fixed across three rounds; this is the first change that stops
the sixteenth.

> **Narrowed in round 6.** "Stops the sixteenth" is broader than what was built. `tsc` only sees a double
> that is (a) in a package that can NAME `Transaction`, and (b) annotated rather than passed through an
> `unknown` parameter. Round 6 brought the last four in-net doubles inside it (the three in
> `@bugsee/performance` itself — R5-8 — plus `node/src/launch.test.ts`'s `registerExt` double, which node
> could always have annotated because it already depends on `@bugsee/performance`). **`@bugsee/bun` and
> `@bugsee/deno` remain outside it**: their doubles in `bun-serve-interceptor.test.ts:7-20`,
> `deno-serve-interceptor.test.ts:7-20`, `bun/src/launch.test.ts:194-203` and
> `deno/src/launch.test.ts:186-195` are bare object literals in packages that deliberately do not depend on
> `@bugsee/performance` ("avoids a @bugsee/performance dep in this Bun package"), and all four reach the SDK
> through `registerExt(name, api: unknown)` / a structurally-typed client, which erases the type either way.
> **Closing it needs `@bugsee/performance` added as a devDependency to both packages and each double
> annotated `: Transaction`** — a `pnpm install`, so it was reported rather than run.

**The harness rewrite is the load-bearing part.** `packages/instrumentation-tests/harness/invariants.mts` no longer asks the
SDK anything: it drives the REAL upload stack (`createBugseeApi` + `createBundleUploader` +
`createUploadPipeline`) over a fake collector whose answers the harness chooses, and judges the SDK
against those answers. `harnessVerdict` is transcribed by hand from the Java and **must never import
`isRetryableHttpStatus`** — that import would re-create the exact defect the rewrite exists to remove.
Five invariants against harness-controlled ground truth, incl. **P4** (an always-accepting collector
delivers everything within N launches), which catches "kept on disk forever, never retried" — a class P1
structurally cannot see. 117 → **283 cases**, adding a real `UploadPipeline` over 11 real status codes,
`QUEUE_OVERFLOW_CODE` against a real capacity-refusing pipeline, a throwing `owner.json`, per-blob
outcomes within one case, and the whole browser/worker path (fake-indexeddb, fake `LockManager`,
concurrent `Promise.all` siblings, plus a check that a LIVE sibling's data is never touched).

**Proof the old harness was blind, same defect injected into both:**

| harness | R3-1 re-injected (`retryable: status >= 500`) |
|---|---|
| round-3 | `117 cases swept, **0** invariant violations` |
| round-4 | `282 cases swept, **98** invariant violations` |

R3-2 and R3-5 were reported by the new harness BEFORE step 3 fixed them, then re-injected and re-caught.
Final: `283 cases swept, 0 invariant violations`. 29 mutations across the wave, all caught.

**`select`/`deferred` survive, deliberately.** `select` is necessary (reconciliation is per-dead-sibling
while an injected store is shared by all of them) but is now core-internal with only core's own
orchestrator as caller. `deferred`'s real defect was having no stated invariant; it now has one, enforced
and tested. What did not survive is the triplicated orchestration and the three places a platform could
get it wrong.

> **Corrected in round 6.** The second half of that last sentence was wrong. The orchestration is indeed
> one definition now, but the three call sites did not go away — they became three ARGUMENT LISTS, and two
> of their arguments (`pipeline` and `shared`) were unpinned in all three. `pipeline: baseUploadPipeline` →
> `pipeline: durable ?? baseUploadPipeline` survived 109/109 · 88/88 · 66/66 in rounds 3, 4 AND 5 (R5-4);
> `shared: true` survived the same three suites (R5-6). Hoisting the orchestration made the SEMANTICS one
> test; it did not make the WIRING one test. Both are pinned as of round 6.

### New open items from round 4

- **The control plane never classifies at all** — **CLOSED**, on `fix/control-plane-classification`, in two
  halves that are deliberately different kinds of thing.
  - **What became a verdict:** the collector's OWN error code, when it arrives with a status attached.
    `bugsee-api.ts` threw on `!isOk(status)` BEFORE parsing the body, so a code the SDK already honours on
    an HTTP 200 was discarded the moment the collector also sent a status — `14019 InvalidAppToken` on a
    400 retried forever, `99099 KillSdk` on a 400 unable to disable the SDK at all. The failed body is now
    read (`httpFailure` → `serverErrorCodeOf`) and its code goes on `serverCode`, where the existing
    drift-tested `classifyServerErrorCode` sees it. **No code was added to the permanent set** — the same
    table now simply reaches a response shape that was being thrown away, which is what Android does on
    both endpoints (`ReportUploadExecutor.java:468-484`, `CommunicationRequests.obtainSession`).
  - **What did NOT become a verdict:** a naked non-2xx. Android's `/v2/issues` path falls back to
    `classifyHttpStatus` (any non-401/408/425/429 4xx → PERMANENT → the bundle file is deleted), and this
    SDK deliberately does not follow it, because Android's OWN `/v2/sessions` path falls back to
    `classifyServerErrorCode(0)` → TRANSIENT for the identical status. Two adjacent calls to one collector
    cannot both be right, and on the web a bare 4xx is what an intermediary answers. Pinned by tests
    (`upload-pipeline.test.ts`, "a status is never a verdict here") so the decision is falsifiable.
  - **What bounds the rest:** `recoverSiblingBundleQueue` now applies `DEFAULT_DURABLE_RETENTION.maxAgeMs`
    (7 days) — the SAME bound these bytes already meet on this tier via the instance's own `recover()`, and
    the TTL node's sweep uses. Age only: the count/byte caps evict the oldest SURVIVORS, which on this leg
    would delete a report the collector was never asked about. A frame with no `firstSeenMs` is never
    expired (the upgrade launch), and that rail is load-bearing — injecting `firstSeenMs ?? 0` is caught 23
    times over by the pre-existing P2 in harness set H.
  - **Harness:** set M gained 16 control cases (the same envelopes over a non-2xx, plus 6 naked statuses as
    a fence), and a new set N drives the browser age bound across 4 launches over real IndexedDB. 369 cases,
    0 violations. Reproduced first: pre-fix the new M cases give 7 violations (incl. `P7 the client KEPT
    CAPTURING after the collector switched the SDK off`) and set N gives `it was still OFFERED 9x past the
    age bound`. The §Evidence note that the harness oracle is flawed refers to the ROUND-1 copy in
    `.session-artifacts/`; the committed `packages/instrumentation-tests/harness/invariants.mts` no longer
    keys on `reportId ?? 'anon:'+summary` and imports no SDK predicate — verified before relying on it.
- **A doubly-403 signed PUT** returns `permanent: false` (`upload-pipeline.ts:169-186`, `renew_failed`)
  where Android calls 403 PERMANENT. Fail-safe, and arguably right since each launch mints a fresh signed
  URL. Left alone.
- **R3-2b is now masked end-to-end** — the orchestrator's `catch` and `recoverInstances`'s per-subtree
  `try` defend each other, so the inner layer is observable only through the unit test at
  `node/src/recover-instances.test.ts` ("is THROW-SAFE per subtree"), confirmed red-for-the-right-reason
  (`EISDIR`) before fixing.
- **bun and deno remain OUTSIDE the `tsc` enforcement net.** Their `Transaction` doubles are untyped
  literals passed through `registerExt(name, api: unknown)`, so there is no type relationship to
  `Transaction` at all. Fix is one line — add `@bugsee/performance` as a devDependency of each — but it
  needs `pnpm install`. Re-exporting `Transaction` from `@bugsee/node` would work and is public-surface
  creep to satisfy a test; don't.
- **R3-12** (input key payload) — **CLOSED 2026-09-02 (`59d49dd`)**, with two parts deliberately left
  divergent. Now emitted: Android's `keyCode` (+ `KEYCODE_REDACTED`), the `metaState` bitmask replacing
  the four bespoke booleans, and a gesture `id` on every key entry (the viewer types
  `RecordingTouchEvent.id` as REQUIRED). Every constant was read out of the real `android.view.KeyEvent`
  in `android.jar` with `javap` rather than recalled. A mutation proved the single-character redaction
  guard could never fire — the table simply holds no character keys — so it was deleted and replaced by
  a sweep test over the printable range, which is what now stops a future edit leaking a typed glyph.
  **`keyup` and `displayId` stay divergent on purpose:** a web keyup doubles the volume of the noisiest
  stream to say only "the finger came off", which no consumer renders, and JS cannot observe a display
  id (the native WebView receiver can, and is the tier that should fill it).

## Round 3 review — DID NOT CONVERGE. 13 findings from 4 reviewers (data-safety, test-quality-in-worktree, architecture, integration)

### R3-1 · SEV1 · `401/408/425/429` on the signed PUT DELETE the report

`core/src/bundle-uploader.ts:45` is `retryable: response.status >= 500`, so every non-403 4xx becomes
non-retryable → `upload-pipeline.ts:195,210` sets `permanent: true` → `isUploadSettled`
(`transport.ts:155`) frees the blob. `transport.ts:147` cites Android's
`CommunicationErrorClassifier.java:17-27` as the parity source — and that file explicitly exempts 401
(AUTH_EXPIRED) and 408/425/429 (TRANSIENT), with the comment *"Without this, a gateway/upstream timeout
(408) on a report or bundle upload would be classified PERMANENT and the report dropped."* We implement
exactly what that comment warns against.

Found INDEPENDENTLY by two reviewers, both confirmed end-to-end against the real `recoverInstances`:
one 429 and the blob, the marker, the capture chunks and the whole subtree are gone.

**Round 2 caused the widening.** At `HEAD` all three recovery legs gated on `result.ok`, so a 429 kept
blob + marker and the next launch retried. R2-3 unified them on `isUploadSettled` — correct in itself —
but the classifier feeding it is wrong, converting a bounded re-upload leak into silent loss on three
more paths. **Fix site is the classifier, not `isUploadSettled`:**
`retryable: status >= 500 || status === 408 || status === 425 || status === 429 || status === 401`.

### R3-2 · SEV2 · The `deferred` release pass never runs if `recoverInstances` throws → PERMANENT non-delivery

`node/src/launch.ts:801-803`, `browser/src/launch.ts:614-618`, `webworker/src/launch.ts:397-400`: the
final unfiltered `sharedQueue?.recover()` — the ONLY thing that releases `deferred` — sits in a `.then()`
with **no `.catch`**. `recoverInstances` is not throw-safe: `recover-instances.ts:216` `readOwner` →
`node-utils/src/fs-storage.ts:44` re-throws any non-ENOENT errno, outside every `try` in the loop.
CONFIRMED with two dead subtrees and an unreadable `owner.json` (EACCES is very reachable when a
root-started and a dropped-privilege process share one `dataDir` — the scenario multi-instance exists
for). Because the trigger is persistent on-disk state, it repeats every launch. At `HEAD`
`durable?.recover()` ran unconditionally, so that blob WOULD have shipped.

### R3-3 · SEV2 · `reconcileSharedQueue` is triplicated verbatim across the three launches

`node/src/launch.ts:730-748`, `browser/src/launch.ts:561-579`, `webworker/src/launch.ts:344-362`.
browser vs webworker differ **only in one comment's line-wrap**; the neighbouring
`recoverDeadSiblings({...})` blocks are byte-identical. Same shape as the round-1 duplicated coordinator,
and NEW in this wave. The diagnosis matters more than the finding: what needed hoisting into core was the
ORCHESTRATION, but the orchestration stayed in the platforms and a knob (`select`) came into core,
dragging hidden state (`deferred`) with it. **The seam points the wrong way.**

### R3-4 · SEV2 · The "never `durable`" invariant has ZERO coverage

All three launches document it in a comment ("routing a blob read out of this very store back through it
would re-stage a second copy of the same incident"). Mutating `pipeline: baseUploadPipeline` →
`pipeline: queue` **SURVIVED** node 109/109, browser 88/88, webworker 66/66. The hazard is real:
`durable-upload-pipeline.ts:391-397` `store.put(newId, …)` runs BEFORE the attempt, so a retryable
failure leaves the original blob and a second copy both on disk.

### R3-5 · SEV3 · The removed `deferred.delete(id)` was NOT provably redundant — found by all three static reviewers

`durable-upload-pipeline.ts:250` deletes a capacity-refused id from `attempted` so the pump can retry,
but there is no matching `deferred.delete(id)`, while the pump gate at `:286` is
`attempted.has(id) || deferred.has(id)`. A blob deferred by a selective pass and then capacity-refused is
invisible to the pump for the rest of the launch — disabling the exact starvation fix the comment at
`:270-278` describes. The `deferred.clear()` half of the author's proof HOLDS; the `delete()` half does
not. Bounded to one launch unless it compounds with R3-2. Untested: the suite uses `select` and
`QUEUE_OVERFLOW_CODE` but never together.

### R3-6 · SEV3 · A FOURTH leg still gates on `ok` — `core/src/native-crash-recovery.ts:133`

The Electron/Crashpad leg. A permanently-refused native-crash bundle is never `claim`ed → `complete`
stays false → `recover-instances.ts:166-171` keeps the marker and sets `nativePending` → `:191` never
reclaims the subtree → the dump is re-harvested, re-synthesized with a **fresh `request.id`**, and
re-uploaded **every launch forever**. Compounds with R3-1: one 429 starts the loop.

### R3-7 · SEV3 · Three MORE non-conforming `Transaction` doubles — the 13th, 14th, 15th

`bun/src/launch.test.ts:188-196`, `deno/src/launch.test.ts:180-188`, `node/src/launch.test.ts:2317-2326`.
Missed by every prior sweep because they use **method shorthand** (`setName() {}`) where the searches
matched the property form (`setName:`). Bun and Deno actively take the degraded path — `setName`, both
`setAttribute` calls and `finish()` never run — and stay green only because they assert on return headers
`fetch-server-wrap.ts:90` sets BEFORE `finish`.

**The structural point (S2):** the now-15 doubles cover every member `finishWith` calls but still omit
seven others and remain `as unknown as Transaction`. The mechanism that produced D2 is unchanged for the
next member added to that path. Fifteen instances fixed; the mechanism is still live.

### ~~R3-8 · SEV3 · The tsup guard misses a TENTH package — `@bugsee/util`~~ **CLOSED 2026-09-16 (7151a6b).**

Resolved by removal: util no longer has a `node:crypto` specifier to guard (see the sha256 item under
"Known-open"). The util target is out of `tsup-node-protocol.e2e.ts`; an inverse test now asserts util's
emitted `index.js`/`index.cjs` carry no `node:` specifier at all, and node-utils' entry gained `node:crypto`
(its new `sha256.ts`). Original finding, for the record:

`util/src/sha256.ts:30-32` is a **dynamic** `import('node:crypto')`, which the guard's own stated
derivation (grep for static `from 'node:'` / `require('node:')`) structurally cannot see.
`packages/util/dist/{index.js,index.cjs}` currently carry `node:crypto`, so the flag is doing real work
there, unguarded.

### R3-9 · SEV3 (PLAUSIBLE) · A second unhandled-rejection site

`browser/src/launch.ts:615`, `webworker/src/launch.ts:398`: `.then(() => queueReady)` with no `.catch`,
and this runs on EVERY launch, not only the injected-store path. `queueReady` is `bundleStore.whenReady`,
which `browser-utils/src/idb.ts:45,79-80` rejects on an IndexedDB open failure. The browser SDK listens to
`unhandledrejection` itself, so a failed IDB open is reported to the collector as an application error.

### R3-10 · SEV2 (environmental, FIXED) · `pnpm lint` went red

An agent worktree under `.claude/worktrees/` contains a full repo copy including `biome.json`, which
Biome treats as a nested root and refuses to lint past — taking down the whole repo's lint. `.gitignore`
never listed `.claude/`. Fixed by adding it.

### R3-11 · MEDIUM · The option registry still documents SDK input as `events.user`

`protocol/src/options.ts:51`, `browser/src/launch.ts:157`, `webview/src/launch.ts:453` — ~30 lines from
the binding rule in `protocol/src/constants.ts:18-30`, and precisely where someone implementing a new
capture source would look for the target stream.

### R3-12 · MEDIUM · The `input` key payload still diverges from both mobile SDKs

Round 2 aligned the stage string; the payload it rides on did not follow. JS `key: string` vs Android/iOS
`keyCode: int` (+ `KEYCODE_REDACTED = -1`); four bespoke booleans vs the existing `metaState: int`; no
gesture `id` on key/semantic entries though the viewer types `RecordingTouchEvent.id` as REQUIRED; no
`keyup`; no `displayId`. Pre-existing, not introduced by round 2.

### R3-13 · LOW · Four wrong Android citations, seven consumerless exports, one doc error

`ReportUploadExecutor.java:182-199` is the `FileLock` block; delete-on-terminal is `:258-268` — miscited
at `core/src/transport.ts:132`, `:153`, `core/src/durable-upload-pipeline.test.ts:287`,
`docs/review/REMEDIATION-PLAN.md:317`. Seven `@bugsee/capture` barrel symbols have no consumer outside
the package. And **this doc listed R2-10 as resolved when it is not** — `bugsee/src/index.node.ts:20`
still exports `RequestContextStoreToken` to all seven adapters.

### Verified clean in round 3 (worth not re-checking)

Root `vitest.config.ts` collects **exactly** the original 423-file set (`diff` of sorted lists empty) ·
`recoverDeadInstances` deletion complete, no dangling refs incl. electron/webview/edge · `recover()`'s
new signature reached by exactly four call sites, all updated · `isUploadSettled` has ONE definition, no
inline survivor · `NAME_SOURCE_ATTRIBUTE` verified at artifact level (0 hits in emitted node `dist`) · no
`node:`/DOM leak into the shared tiers (structurally enforced by `"types": []`) · `'begin'`→`'keydown'`
is NOT a one-sided wire change (neither schema constrains that field) · R2-2's acceptance re-verified,
bounded at 2 uploads regardless of launch count · `skipReportIds.add` before the `await` is safe ·
F-4 falsifiable in both directions in all 7 adapters · 48/50 mutations caught.

### The systemic finding

**Three recovery fixes in a row have each introduced a new loss path.** Round 3 shows the mechanism:
1. **The harness encodes the policy under test.** Its oracle was wrong once for R2-2 (keyed on
   `reportId ?? summary`); the fixed version computes `settledOk = ok || permanent`, so R3-1 is
   *unrepresentable* in it. It certified round 2 while structurally unable to see round 2's worst defect.
   It also never uses a real `UploadPipeline`, never models `QUEUE_OVERFLOW_CODE`, bypasses liveness
   entirely, and does not exercise the browser/worker path at all.
2. **The seam points the wrong way** (R3-3) — hence R3-2, R3-4, R3-5 all in the same new machinery.
3. **The `permanent` classifier is the shared root cause** of R3-1 and R3-6.

## New open items from round 2

- **`activeSpanStore` seam (follow-up to D2 part 2).** The global `active` slot is still a single module
  variable. Android's canonical answer is `SpanContextHolder.java`'s `ThreadLocal<Span>`; the JS
  equivalent is the existing `AsyncLocalStorage`-backed `RequestContext`, mirroring what
  `server-instrument.ts` already does for its own span stash. Proposal (unimplemented, deliberately —
  building an unused seam would be speculative scaffolding): an optional `activeSpanStore` on
  `PerformanceControllerDeps`/`PerformanceExtensionOptions`, behaviour-preserving default, wired from
  `packages/node/src/launch.ts`. No public API widening. Hazard is documented in
  `performance/src/controller.ts:42-73`; no built-in adapter calls the affected methods today.
  - **CLOSED 2026-09-14 (uncommitted working tree — see "D2 part 2 — IMPLEMENTED" at the end of this
    file).** The hazard is now live, not theoretical: `server-instrument.ts` calls
    `perf.startTransaction` per incoming request, so concurrent requests DID share the slot. Built as
    proposed, threaded `launchCore` internals → umbrella → wirePerformance → extension → controller.
    **NOT yet converged** — a 5-reviewer pass on 2026-09-14 returned 6 SEV2 / 9 SEV3 / 3 SEV4; see
    "D2 part 2 — POST-IMPLEMENTATION REVIEW" at the end of this file.
- ~~**Input `'change'`/`'submit'`/`'focus'` — awaiting a product decision.**~~ **DECIDED (product owner)
  and IMPLEMENTED 2026-08-31 — option C, neither A nor B: they are not input events at all, they are
  STATE-CHANGE events, and they belong to BREADCRUMBS.** Both proposals on the table (A: extend the
  shared stage enum; B: a separate `semantic?:` field) kept them on the `input` stream and so kept the
  premise wrong. Grounds: (i) `InputEvent.type` is Android's `InputEventStage`
  (`InputEventStage.java:27-44` = `unknown|begin|move|end|scroll|keydown|keyup`), an enum produced by
  SDKs that have no DOM, which those three values structurally cannot join; (ii) every consumer already
  discards them — both native WebView receivers now drop them (bugsee-android#9, bugsee-cocoa#19) and
  the viewer's `processInput` renders tools 1/2/3 only, so they were captured, uploaded and thrown away
  on every platform; (iii) **Android already draws this exact line**:
  `BugseeInputInterceptionCoordinator` has TWO dispatchers — `getInputDispatcher()` (raw `InputEvent`s →
  the input capture provider → `input.json`) and `getGestureDispatcher()` (recognised `GestureEvent`s →
  `BreadcrumbInputGesture` → **breadcrumbs**).

  **As built.** `packages/browser/src/input-source.ts` no longer listens for `change`/`submit`/`focusin`
  at all (the `INTERACTIONS` entries, the three handlers and `#semantic` are gone), so `InputEvent.type`
  is now a closed `InputEventStage` in fact as well as in its doc. The new
  `packages/browser/src/ui-breadcrumb-source.ts` emits them through `client.addBreadcrumb` in
  `BreadcrumbInputGesture.java:62-89`'s shape — `{type:'user', category:'ui.change'|'ui.submit'|
  'ui.focus', level:'info', data:{'view.id','view.class','view.tag'}, timestamp: the DOM event's own
  moment}` — reusing `describeTarget` for the descriptor (no second descriptor). `type:'user'` is
  Android's literal, meaning a user-ORIGINATED breadcrumb; it is **not** the `*.user` stream and does not
  touch the binding rule. Wired into both `@bugsee/browser` and `@bugsee/webview`, gated by
  `captureInteractions` (Android gates on `Options.CaptureBreadcrumbs`, which this SDK has no equivalent
  of — breadcrumbs enter via `client.addBreadcrumb`, the APPLICATION's own API, which must not be gated;
  `captureInteractions` is the option that already means "do not watch what I click and type", and it
  must keep meaning that whatever stream the observation lands on). A masked/sensitive target drops the
  breadcrumb OUTRIGHT rather than emitting the tag-only descriptor — same secure-field exclusion the
  keydown path applies, because the focus/change RHYTHM on one masked field is itself a side channel.
  This also closes the `:275-277` half of the R2-11 "input stage vocabulary diverges" item below, and
  removes three of the record types D1 is about.
- **Node does not gate `recover()` on `whenReady`** (browser/worker do). `createNodeBundleStore` is
  synchronous fs and node never waited. Needs a decision only if an async injected store on node is ever
  supported.
- **A dead subtree survives one extra launch** before reclamation: the cross-store marker is retired when
  the upload *settles*, which lands after `recoverSubtree`'s drain check. No duplicate, no loss — just
  not same-pass. Documented in the new node launch test.

## Round 2 fix list — detail (kept for reasoning; see status above)

### R2-1 · Injected `bundleStore` still double-reports — SEV2

The reconciliation was added to `recoverInstances`/`recoverDeadSiblings` but **not** to the
own-queue leg, `durable.recover()` (`packages/node/src/launch.ts:715`,
`packages/browser/src/launch.ts:545`, `packages/webworker/src/launch.ts:329`). A no-op on the
default path, but `options.bundleStore` is a documented public option
(`node/launch.ts:280`, `browser/launch.ts:223`, `webworker/launch.ts:129`) and
`browser/launch.ts:542` says outright that it "bypasses coexistence". With such a store —
stable across launches — launch N replays launch N−1's blob while `recoverInstances` rebuilds
the same incident from its still-pending marker. Node's `recoverSubtree` reads
`join(sub,'pending')`, empty because the override took its place, so `skipReportIds` comes back
empty (`recover-instances.ts:101-119`); browser/worker leave `bundleShared === undefined`
(`coexistence.ts:106-107`) so the queue leg is skipped and `skipReportIds` stays `EMPTY`
(`:42`). **Payloads differ** (`staged:X` vs `inc:X`), so nothing downstream can collapse them.

### R2-2 · Upgrade launch double-reports every in-flight incident — SEV2

A blob staged by the previous SDK version has no `reportId`, so it shadows no marker
(`capture-recovery.ts:82`), so the marker leg rebuilds and uploads the same incident again.
`durable-upload-pipeline.ts:148-150` calls a missing id "the safe direction: a possible
duplicate, never a silent loss" — it is a **guaranteed** duplicate, once per incident pending at
upgrade time. No fallback key exists: `bundle-assembler.ts:108,130` sets `created_on` at
assembly time, so a rebuilt bundle carries the recovery timestamp, not the incident's. If the
trade-off is accepted, the docstring must say so.

### R2-3 · A permanently-refused bundle is never freed on browser/worker — SEV3

The live pipeline treats `permanent` as settled and frees the blob
(`durable-upload-pipeline.ts:189,211`); both recovery legs gate on `result.ok` alone
(`recover-instances.ts:89`, `browser-utils/src/recover-dead-instances.ts:39`). So a 4xx-refused
bundle is re-uploaded every launch forever, and its marker is never retired either. Bounded at
7 days on node by `sweep-instances.ts:24`; **unbounded on browser/worker** —
`recoverSiblingBundleQueue` applies no retention and no `permanent` check. *(Both halves since fixed:
the `permanent` check by round 4's `isUploadSettled` unification, and the missing retention by the
7-day age bound on `recoverSiblingBundleQueue` — see §New open items from round 4.)*

### R2-4 · `skipReportIds.add` is not throw-safe — SEV3

`capture-recovery.ts:83-88` — the `add` sits after `await pipeline.enqueue(...)`. Both callers
catch enqueue throws, so a throw loses the id: the marker leg then rebuilds and delivers, the
marker is retired, the blob is kept, and the next launch replays it. Move the `add` before the
`await` or into a `finally`.

### R2-5 · `capture-recovery.ts:178`'s `reportId` stamp is unguarded

Mutating `marker.request.id` → `marker.request.report.id` stays green across core, node,
browser, browser-utils and webworker. The claimed fix pins only `client.ts:417`
(`client.test.ts:704`). `capture-recovery.test.ts:463` uses `marker('inc1', 100)`, whose two ids
are identical by construction (`reporting.ts:120`), so it cannot distinguish them.

### R2-6 · The console `stackParser` wiring has no test

Replacing `createConsoleInterceptor({ stackParser: parseStack })` with
`createConsoleInterceptor()` at `browser/launch.ts:474` and `webworker/launch.ts:306` leaves
browser 364/364 and webworker 86/86 green. Neither package references `console.trace` or
`parseStack`. Also `console-interceptor.test.ts` ~560 ("documents the pre-fix loss") is
**vacuous** — form (m), asserting the SDK's own default; hardcoding `this.#stackParser =
parseV8Stack` leaves it green. The seam is pinned only by "honors an injected stackParser".

### R2-7 · The tsup guard misses four packages and scans the wrong files

`instrumentation-tests/test/tsup-node-protocol.e2e.ts` claims to cover "every package verified
to statically import a `node:` builtin". Missing: `electron` (`node:fs`, `node:path` —
`src/native-crash-source.ts:1-2`), `bundler-plugin-core`, `nestjs` (`node:crypto`),
`remix` (`node:stream`). Proven with electron: built both ways, emitted `from 'fs'` with the fix
removed, guard **green through both**. Second defect at `:125` — it reads only
`index.js`/`index.cjs`, but electron's imports land in `main.js`/`main.cjs` and remix's in
`server.js`, so widening the table alone is insufficient.

### R2-8 · `@bugsee/node` gained a runtime dependency on the opt-in APM extension — MEDIUM

`server-instrument.ts:3` imports `NAME_SOURCE_ATTRIBUTE` as a **value** (previously every
`@bugsee/performance` reference in node was `import type` and erased at build). Published
`@bugsee/node` now eagerly loads the whole performance barrel — 15 modules including five
web-vitals collectors — regardless of whether APM is enabled, defeating design §0.6's "tree-
shakes to nothing when unused". The constant is a wire attribute name (`'bugsee.name_source'`)
and belongs in `@bugsee/protocol` or `@bugsee/core`, imported from there by `@bugsee/performance`.

### R2-9 · The viewer's new spec is flaky — SEV2

`viewer/src/app/features/recording/shared/js-sdk-resource-normalize.spec.ts:549-579`
(`processInput (integration)`) failed **4 of 18** identical runs — `Expected 2 to be 1`,
`Expected 0 to be 1`, and once a *different, untouched* spec failed with an error only reachable
via `{maxEvents: 1}`, which it never passes. Nothing on the path can produce those values
(inputs are object literals, the service constructor is empty, `processInput` is synchronous),
so it points at suite-level interference — jasmine random order is on, `karma.conf.js:14-16`
sets `clearContext: false`, and the spec has no `beforeEach`/`afterEach` isolation. **Root cause
unidentified.** A new spec red ~1 run in 5 should not land as-is.

### R2-10 · `RequestContextStoreToken` exposes an internal DI token as public API

`packages/bugsee/src/index.node.ts:20`. Makes `client.getServiceProvider(token)` — the internal
ServiceContainer path — the sanctioned way to set a per-request attribute. CLAUDE.md calls the
container internal; design §4.1 scopes Services to replaceable platform implementations, not
user surface. Android exposes facade *methods*, never container tokens. The F-5 DX need is
real; the Android-canonical shape is a facade method (e.g. `bugsee.setRequestAttribute(k, v)`).

### R2-11 · Weaker items worth folding in

- `browser/launch.test.ts:1152` — form (b)/(h): asserts `toHaveBeenCalled()` on a spy a second,
  unrelated path already fires. Deleting the discovery catch leaves it green. (Its neighbour at
  `:1195` with `toHaveBeenCalledTimes(2)` is genuinely strong — killed two independent ways.)
- Orphaned second dead-sibling coordinator: `browser-utils/src/recover-dead-instances.ts:71-107`
  `recoverDeadInstances()` re-implements what `coexistence.ts:160-249` does, has no production
  caller, and is publicly exported (`browser-utils/src/index.ts:46`). Delete or wire.
- `replay/src/masking.ts:94` re-derives `SENSITIVE_INPUT_SELECTOR` instead of importing core's
  (`core/src/sensitive-input.ts:38`) — a second derivation site of the rule that exists to stop
  exactly that.
- `core/src/events.ts:38-47` `InputTool` is a partial copy of a shared numeric wire contract —
  stops at `Key: 7`; Android `InputUtils.java:19-29` and iOS `BGSInputEvent.h:26-37` continue
  with `Gamepad=8`, `Rotary=9`, `Trackball=10`.
- ~~Input stage vocabulary diverges from Android's `InputEventStage`~~ — **both halves now closed.**
  (`InputEventStage.java:27-44` = `unknown|begin|move|end|scroll|keydown|keyup`.) The keydown half was
  fixed in round 2 (`'begin'` → the canonical `'keydown'`); the `'change'`/`'submit'`/`'focus'` half was
  closed 2026-08-31 by moving those three off the stream entirely, to breadcrumbs — see the decided item
  in "New open items from round 2" above.
- Five vacuous viewer specs (2 new, 3 pre-existing) + a mutation-free zone in the gzip replay
  decoder path — detail in the round-1 test-quality report.
- Vacuous runtime assertions in the export-surface tests (`bugsee/src/index.node.test.ts:24,36`,
  `fastify/src/reexport.test.ts:24,38`, `node/src/index.test.ts:98`). Mitigating: the
  `import type` lines ARE falsifiable under `tsc --noEmit`, which is a CI gate — the files earn
  their place, the vitest assertions are decorative.

---

## Known-open, pre-existing, deliberately not in this wave

- ~~`node/src/launch.ts:754-765` — cross-subtree double-upload~~ **CLOSED 2026-09-02 (`59d49dd`).**
  The scan is now two passes — every dead sibling's bundle queue before any marker leg, so
  directory order cannot decide the outcome — reconciled against a UNION marker view across every
  claimed subtree, which also retires the marker wherever it lives. Retiring it is the half that
  matters: leaving it merely postponed the duplicate to the next launch, when the blob is gone and
  no longer shadows it. Reproduced first, in both scan orders.
- ~~`node/src/recover-instances.ts:38` — node has **no** lock claim~~ **CLOSED 2026-09-02
  (`59d49dd`).** `recovery-claim.ts`: an `O_EXCL` claim file inside the subtree (`writeFileExclusive`
  in node-utils). Claimed by FILE, not by the rename the design sketched — the subtree name is
  load-bearing for both the recovery scan and the age-based sweep, and a rename would hide a claimed
  subtree from the reaper. A claim names its holder and one whose holder is DEAD is taken over, so a
  recoverer that dies half way cannot strand the incident for ever (which would be strictly worse
  than the duplicate the claim replaces).
- ~~`@bugsee/util` `sha256.ts` — the `node:crypto` fallback is statically visible to esbuild-family
  bundlers~~ **CLOSED 2026-09-16 (7151a6b): the platform injects the digest.** The fallback is
  deleted; `sha256Hex` is WebCrypto-only and rejects `NotSupportedError` without `crypto.subtle`, which
  the upload pipeline now treats as "upload without a checksum" — the checksum is not sent, and gating on it
  left an empty issue per launch (see PROGRESS.md 2026-09-16 follow-up). `@bugsee/node`
  passes a `node:crypto` digest (`node-utils` `nodeSha256Fallback`) into `createUploadPipeline`'s
  existing `sha256` seam only when `subtle` is absent; bun/deno/electron-main inherit it. Verified: esbuild
  `platform:'browser'` with NO `external` bundles `@bugsee/core`, `@bugsee/browser` and
  `@bugsee/vercel-edge` cleanly, and `browser.e2e.ts` dropped its `external: ['node:crypto']`. This is
  simpler than the per-runtime `exports` condition proposed below — no second dist build. History:
  ignore comments (`webpackIgnore`/`turbopackIgnore`/`@vite-ignore`) mean nothing to
  esbuild. **The obvious fix was measured and REJECTED (2026-09-02).** Computing the
  specifier (`['node','crypto'].join(':')`) hides it from static analysis and does fix esbuild —
  verified, with vite 8 and webpack 5 staying clean, and webpack silent because `webpackIgnore` stops
  it parsing the import at all. It was reverted because **workerd rejects dynamic module specifiers
  outright** (`ERR_MODULE_DYNAMIC_SPEC`), which broke the real-workerd Durable Object e2e and would
  break `@bugsee/cloudflare` in production. Trading a build error for a broken supported runtime is a
  bad trade. The fix with no downside is a per-runtime `exports` condition on `@bugsee/util` (a node
  entry keeping the fallback, a default entry that is WebCrypto-only); it needs a second dist build.
  A pure-JS SHA-256 was also rejected — this hashes the whole bundle BODY, and bundles run to
  megabytes. The `external` workaround's residual risk is narrower than first written: it can only
  bite in an INSECURE context, since every secure context has `crypto.subtle`.
- ~~`bugsee-cli` (Rust repo): a CSS map aborts the whole source-map batch; an unchanged chunk fails
  the whole batch. Together these make iterative CI production builds impossible.~~ **CLOSED
  2026-09-17: bugsee-cli 0.7.8** (bugsee-cli#35) — the appserver nests 16004 in its envelope and the CLI
  matched only a top-level code; CSS/declaration maps are skipped. `@bugsee/bundler-plugin-core` requires
  `^0.7.8` (`40ef8ff`); re-verified against staging in `samples/webpack-sourcemaps` (`059b2ae`).
- ~~rrweb fork: `.bugsee-unmask` on an `<input>` is honoured on the full-snapshot path only; a
  value typed *while* recording stays masked. Fails closed, so privacy-safe.~~ **CLOSED 2026-09-17:**
  fork `bugsee-port` 34ba7400 / `bugsee-dist` b8aaf209 — one `resolveInputValue` for the snapshot, the
  live input observer and the value/textarea mutation paths (the latter two also ignored the selector).
  The snapshot path's unmask had also bypassed the fork's own sensitive-input hard floor; the SDK's
  selector guard (`masking.ts`) already kept that from leaking, and the fork now enforces it itself.
  `@bugsee/rrweb` pins b8aaf209; `masking.integration.test.ts` asserts a typed value in a
  `.bugsee-unmask` input is recorded (fails against the old bundle).
- `docs/review/browser-utils.md:36` names the removed `recoverReportsForViews` — stale doc only.

---

## Deferred by the product owner (2026-08-28), not defects to chase

- **View hierarchy** as a whole. `viewtree.json` IS captured and uploaded (verified on real
  issue `SSOLID-205`: 184 nodes, 2.8 KB in the bundle) but the viewer never renders it — the
  container is a bare array while `processViewTrees` reads `response.viewTrees || response.events`,
  and `viewtree` is absent from the viewer's `ARRAY_ENVELOPE_BY_TYPE`. Node schema also differs
  (`tag`/`rect`/`children` vs `class_name`/`bounds`/`subitems`). Measured cost of the walk:
  2.6 ms at the 2000-node cap on an M4 Pro, **65.7 ms at 20× CPU throttle** (low-end mobile).
  The walk is strictly read-only, so it is 1 forced layout + N cheap reads, NOT thrashing —
  proven against a positive control that costs 4× at every size.
- **Size optimisation.** Binary serialization measured end to end: on realistic (irregular)
  trees the best binary format is **1.45×** over plain JSON *after* the bundle's deflate, and
  compact JSON alone gets most of it. A global string table is a **net loss** in every case
  (gzip already dedupes the repeated strings; varint indices are high-entropy). The dominant
  lever is rect delta-encoding, not tag codes. IndexedDB `CompressionStream` is worthless
  per-entry (9%) and 31× batched — but batching violates the binding durable-as-captured rule,
  so the answer is to compress on chunk **freeze**, not on append.

---

## D2 part 2 — IMPLEMENTED (2026-09-14, uncommitted working tree)

The `activeSpanStore` proposal above is built, tested, reviewed to convergence (11 multi-agent rounds,
the last with zero findings from both reviewers), and green on every gate. Uncommitted; commit + push
to `main` when ready (the tree is green except the pre-existing `invariants.mts` lint-red, untouched
by this wave — see below).

**What landed.** `ActiveSpanStore` (`get`/`set`/`clear`, `packages/performance/src/active-span-store.ts`)
+ `createSingleSlotActiveSpanStore()` default (byte-identical browser behavior) → threaded through
`PerformanceControllerDeps` → `PerformanceExtensionOptions` → `WirePerformanceOptions` →
`UmbrellaInternals.activeSpanStore?` (optional — browser omits it) → `node LaunchInternals`
(required — `launchCore` always builds it). Node's `createRequestScopedActiveSpanStore`
(`packages/node/src/active-span-store.ts`, type-only `@bugsee/performance` import — R2-8 holds) keys
the slot off the ALS `RequestContext` (same instance the launch registers): context stash (symbol-keyed,
non-enumerable) shadowing an ambient single-slot fallback, `get()` never returning a finished txn,
identity-compared `clear()` checking stash and ambient independently, frozen-context containment
(WeakSet; reads see nothing, clears touch nothing), per-cause warn-once, throwing-sink guard,
null/non-object normalization. Hardening found along the way (same "integrator-hostile custom store"
threat model): `safeCurrent` reads + `setUser`/`setAttribute`/stash guards + abandon-`finish()` in
`server-instrument.ts`, the trace-propagation decorator degrading to no-headers, controller degrading
a throwing custom store to untracked (plus a must-not-throw contract).

**Verified by.** ~40 new tests (unit + real-ALS concurrency interleavings proving request A never sees
or renames request B's txn + a full-stack umbrella launch test through every threading link);
per-entity mutator loop (every injected bug caught, incl. a scratch proof the old slot fails the new
interleavings); 100% line/fn/stmt on all touched files; typecheck 100/100, cycles clean, bun/deno
suites green (both inherit via `nodeLaunchCore`).

**Dismissals recorded (deliberate, not oversights).** Ambient fallback for never-stashing contexts
(documented trade-off — shared only what was already global); latch-before-delivery on a throwing
sink (identical observability, less overhead); `captureError` return-false-on-throw (no caller
branches on it); retention-only stale stashes (GC-bounded, same as the server stash); the
enterWith-linger live-share (pre-existing, narrowed); Proxy-context reads (no reachable trigger);
`onError` staying opt-in (no SDK-wide default exists to inherit).

**Follow-ups (out of scope, pre-existing).** `core/src/client.ts:543` (`submitReport`'s unguarded
`contextProvider?.getCurrent()` — the capture path is already guarded by the aggregator's
`route()` try/catch, only the report path wants a dedicated pass); ~~defense-in-depth for throwing
THIRD-PARTY request decorators (`capture/src/request-decorator.ts` — fails open into the app's
fetch today; needs its own review before changing shared capture behavior).~~ **CLOSED 2026-09-17:**
reviewed — it was not only third-party: our own propagation decorator reads the active span through
the performance extension, and a throw from any decorator failed the app's `fetch()` (sync throw) or
`xhr.send()`. The registry now isolates each decorator (a throw, or a throw while READING its result,
contributes nothing — no partial set) and drops headers the platform rejects synchronously (measured
on Chromium 151: invalid token names, CR/LF/NUL, non-ByteString values), runs over a snapshot of the
decorator list, and swallows like every other internal capture failure. With nothing applicable the
patched fetch still passes the caller's `init` through by identity.

**~~Pre-existing red, not this wave.~~ CORRECTED — see R-8.** `pnpm lint` **exits 0**: `biome check .`
reports `Found 24 warnings` and no errors. `noExplicitAny`/`noNonNullAssertion` are warn-level under
`recommended`, and checking the file by path confirms it — `biome check
packages/instrumentation-tests/harness/invariants.mts` exits 0. The 24 are 23 in `invariants.mts` and 1
in `packages/node/src/index.test.ts` (`noDynamicNamespaceImportAccess`), which the original note omitted.
Both files are byte-identical to `HEAD`, so "untouched by this change" stands — but the gate is GREEN.

## D2 part 2 — POST-IMPLEMENTATION REVIEW (2026-09-14). 6 SEV2, 9 SEV3, 3 SEV4 from 5 reviewers
## → ALL 19 RESOLVED in the same working tree. See "RESOLUTION" below for what each became.

Five parallel read-only reviewers (concurrency/lifecycle · test quality · architecture/layering ·
defensive-coding · cost+retention+gates) over the uncommitted tree. **This did NOT converge** — the
preceding block claims "11 rounds, the last with zero findings from both reviewers"; a sixth axis
(defensive-coding) and a re-run of the others produced the list below. Three reviewers independently
landed on the same structural finding (R-1) from three different directions, which is the strongest
signal in the set.

Gates were re-verified and all pass; the cost and retention claims hold with room to spare. The
findings are about DESIGN SURFACE and TEST REACH, not about a broken feature.

### RESOLUTION (2026-09-14, same uncommitted tree)

Every finding is closed. Three were closed by DELETING code rather than adding it (R-1 took both
WeakSets and the whole containment apparatus with it, dissolving R-9 and R-10), two are accepted
limitations now written down where the next reader will hit them, and one is a recorded dismissal.

| # | SEV | Outcome | Where |
|---|---|---|---|
| R-1 | 2 | **FIXED** — a context-bearing read is now strictly private (`get()` returns this execution's own live stash or nothing); ambient serves context-less executions only. `ownsSlot` and `unstashable` both deleted. | `node/src/active-span-store.ts:102-109` |
| R-2 | 2 | **FIXED** — two concurrent real `runServerRequest` calls, each asserting it reads its own span. | `node/src/server-instrument.test.ts:1219` |
| R-3 | 2 | **FIXED, but not by deletion** — see the note below. The three catches stay; the SILENCE is gone. | `performance/src/controller.ts` |
| R-4 | 2 | **FIXED** — the abandoned transaction now finishes `'CANCELLED'`, not the default `OK`, so a ~0-duration sample is self-identifying and excludable downstream. | `node/src/server-instrument.ts:496-501` |
| R-5 | 2 | **FIXED** — `submitReport` guards `contextProvider.getCurrent()`; the crash path is held to the same fail-safe as every other read of the integrator-replaceable store. | `core/src/client.ts` |
| R-6 | 2 | **FIXED** — the docstring now says isolation holds ON THE DEFAULT AUTO-INSTRUMENTED PATH and states the shared-context exception outright. | `performance/src/controller.ts:54-64` |
| R-7 | 3 | **FIXED** — `@bugsee/node` exports `createRequestScopedActiveSpanStore` + its options type, so a hand-wiring consumer can get per-request isolation. | `node/src/index.ts:15-22` |
| R-8 | 3 | **FIXED** — the false "lint is red" claim is corrected in place above (exit 0, `Found 24 warnings`, across the two files it names between them). Holds two measurement traps found while verifying it. | this file |
| R-9 | 3 | **DISSOLVED with R-1** — no containment early-return remains, so `clear()` always reaches the ambient identity release. | — |
| R-10 | 3 | **DISSOLVED with R-1** — the frozen-context apparatus is gone; `set()` keeps only the cheap `defineProperty` guard. The `stashSpan` catch now states its real consequence (a later opener opens a SECOND context + transaction). | `node/src/server-instrument.ts` |
| R-11 | 3 | **DOCUMENTED, accepted not fixed** — the measured pipelining trace is in the module note, including the two pre-existing mis-attributions it implies. | `node/src/active-span-store.ts:33-45` |
| R-12 | 3 | **ADDRESSED** — the comment no longer asserts safety as a property of this code; it names the carrier singleton as the invariant it actually rests on. | `node/src/active-span-store.ts:61-67` |
| R-13 | 3 | **FIXED** — the non-falsifiable orphan assertion and its comment are gone; `expect(owner.setRoute).toHaveBeenCalledWith(...)` now discriminates a refining handle from a fresh span. | `node/src/server-instrument.test.ts:1284` |
| R-14 | 3 | **FIXED** — the `enterWith` concurrency path and the nested-`run` limitation are both pinned by tests; the `'drop'` warn kind is pinned at the launch wiring. | `node/src/active-span-store.test.ts:159,176`, `launch.test.ts:1986` |
| R-15 | 3 | **FIXED** — no "structurally identical" claim remains. | `bugsee/src/wire.ts` |
| R-16 | 3 | **FIXED** — `UmbrellaInternals.activeSpanStore` is REQUIRED-but-nullable, and the browser states `activeSpanStore: undefined` explicitly. Verified by mutation: omitting it fails `tsc` with `TS2741 … missing … but required in type 'LaunchInternals'`. | `bugsee/src/wire.ts`, `browser/src/launch.ts` |
| R-17 | 4 | **DISMISSED** — see below. | — |
| R-18 | 4 | **FIXED** — the contract no longer claims the built-in stores never throw in the absolute; it scopes the claim to the transactions the SDK actually puts in them. | `performance/src/active-span-store.ts:15-21` |
| R-19 | 4 | **FIXED** — `clear()` blanks by assignment instead of `delete`, so the context never migrates to dictionary mode. The descriptor was already `writable: true`, so this cost nothing. | `node/src/active-span-store.ts:139-145` |

**R-3 — why the catches stayed, and what actually changed.** The two reviewers split on whether this
repeated §D2 part 1, and the split turned on reachability. R-7's fix settled it: `@bugsee/node` now
EXPORTS `createRequestScopedActiveSpanStore` for hand-wired APM, and `createPerformanceExtension`
already accepted an `activeSpanStore`, so the seam is publicly reachable and a guard at it is a real
boundary guard, not a test-double accommodation. What both reviewers actually agreed on was the
residue — the degrade was SILENT, with no sink on `PerformanceControllerDeps` — and that is what was
fixed: a new `onError` on the controller deps, threaded from `wirePerformance` → extension →
controller, reporting a contract-breaking store ONCE PER SITE (`get`/`set`/`clear`). Per site, not per
call, because `get()` runs on every outgoing network call; per controller, not module-hoisted, so
sibling controllers each keep their own report; and the sink's own throw is absorbed, since it is user
code. Mutator loop run on the guard: dropping the latch, collapsing it to one latch total, skipping the
`set` report, and unguarding the sink were each caught by a failing assertion.

**R-17 — dismissed, with the reasoning.** Renaming `ActiveSpanStore` → `ActiveTransactionStore` is
accurate for what the seam holds TODAY, but the seam exists to back `getActiveSpan()`, and the span-stack
slice this file already defers (D11/D12) would widen it back to `Span`. Renaming a just-exported public
seam to a name a planned slice would have to rename again is churn in both directions. The mismatch is
instead stated where it can mislead: the interface documents that it holds root transactions because the
controller tracks roots only.

### R-1 · SEV2 · The `ambient` fallback has no producer, and it leaks in the exact direction the fix exists to close

`packages/node/src/active-span-store.ts:120` — `return live(stashed(context)) ?? live(ambient);`

Converged on by the architecture, concurrency and defensive reviewers separately.

The fallback's stated justification (`active-span-store.ts:16-17`) is "a request whose transaction was
opened before its context still sees it". **No producer was found for that case.** Every built-in entry
opens the context BEFORE `startTransaction`: `runServerRequest` (`server-instrument.ts:398-405`,
`store.run(C, () => makeSpan(...))`), `openServerRequest` (`enterWith` at `:358`, then `makeSpan`),
`startServerSpan` (context already open). The umbrella's `app.start` transaction bypasses the
controller entirely (pre-finished wire, `bugsee/src/wire.ts:239-250`), so it never enters `ambient`.

What the fallback DOES produce is reachable today:
1. App starts a long-lived transaction from a cron/queue tick with no request context → `ambient = T_bg`.
2. A request opens a context but starts no transaction of its own — `openServerContext()` is PUBLIC
   API for exactly that (context-only correlation, `server-instrument.ts:289-305`); the window between
   the Nest middleware's `enterWith` (`nestjs/src/middleware.ts:69`) and the interceptor's
   `startServerSpan` is another.
3. In that request `getActiveSpan()` returns `T_bg`, and `setActiveTransactionName()` **renames the
   background transaction**.

Android parity is explicit against this: `SpanContextHolder.java:41` returns the `ThreadLocal` value and
NOTHING else — an unset thread sees `null`, full stop. No thread ever reaches a process-wide span.

**Recommendation: make a context-bearing read strictly private** —
`context !== undefined ? live(stashed(context)) : live(ambient)`. That single change also deletes the
entire containment apparatus: `ownsSlot` exists only to suppress this fallback, and `unstashable`'s read
and clear guards (`:114-116`, `:154`) exist only because a frozen context would otherwise reach it. Net
effect ≈ two WeakSets, three branches and ~40 lines of comment removed, with no reachable behaviour
change. See R-6, R-10 and R-12, all of which dissolve with it.

### R-2 · SEV2 · No test drives the hazard's actual production site concurrently

`packages/node/src/server-instrument.test.ts` contains **no `Promise.all` at all**. Every isolation proof
hand-opens its own context (`node/src/active-span-store.integration.test.ts:24,98,105`,
`node/src/active-span-store.test.ts:183`, `bugsee/src/node.test.ts:262`), but the hazard as stated in
this file's own "New open items from round 2" entry is *"`server-instrument.ts` calls
`perf.startTransaction` per incoming request"* — i.e. `server-instrument.ts:405` → `makeSpan` → `:470`.

Move `makeSpan` outside `store.run`, or add an adapter that starts its transaction before opening the
context, and **every request's transaction lands in `ambient` — D2 restored verbatim — with all 38 new
tests green and per-file coverage still 100%.** The missing test is ~15 lines: two concurrent real
`runServerRequest` calls, each asserting it reads its own span. Verified to pass as written today
(`{"b":"GET http://x/b","a":"GET http://x/a"}`).

### R-3 · SEV2 · The three controller catches guard a seam no public API can reach, and silence our own bugs

`packages/performance/src/controller.ts:116-120` (`readActive`), `:167-172` (`clear`), `:176-181` (`set`).

`activeSpanStore` has exactly one producer — `node/src/launch.ts:1104`, our own
`createRequestScopedActiveSpanStore`. `BugseeLaunchOptions` (`launch.ts:320-380`) has no such field;
`UmbrellaExtensionOptions` has none; `LaunchInternals` is documented at `launch.ts:390` as *"NOT a stable
public API"*; `createRequestScopedActiveSpanStore` is not exported from `packages/node/src/index.ts`. The
covering test uses `{get: broken, set: broken, clear: broken}` — an object that cannot exist in
production. The interface itself (`performance/src/active-span-store.ts:15-18`) declares
"Implementations MUST NOT throw … The built-in stores never throw", which these catches then distrust.

It is not inert: `readActive`'s `catch { return undefined }` converts any future TypeError in OUR OWN
`get()` into a silent "no transaction active" — `getActiveSpan()` returns undefined, both naming seams
become no-ops, route naming stops, and **`PerformanceControllerDeps` has no `onError`, so there is no
signal anywhere.**

**Reviewer disagreement, recorded rather than flattened.** The defensive reviewer calls this the §D2
part-1 finding repeating one slice later in the same file. The test reviewer argues it is NOT: part 1's
doubles omitted a *required* interface member and the degraded path silently swallowed seven adapters'
real `setName` assertions, whereas these doubles are fully type-conforming (deliberately not cast,
`server-instrument.test.ts:1007-1008`) and **no pre-existing test now passes via a new degraded path** —
verified by auditing every `getCurrent:` double in the repo and confirming `server-instrument.ts` at
100% branch. Both agree on the residue: the silence is the defect.

**Recommendation: delete the three catches, or route `readActive`'s through a sink.** Restore them with
a public-API test if the seam is ever published.

### R-4 · SEV2 · The abandon-`finish()` ships a fabricated latency sample into the `http.server` bucket

`packages/node/src/server-instrument.ts:491-505`.

Mechanically clean — the concurrency reviewer cleared it: `TransactionImpl.finish` fires `onFinish` once
(`span.ts:326-329`), `transaction = undefined` at `:504` short-circuits `finishWith` at `:506` (no
double-delivery), and the catch runs in the SAME context as the `set` on every entry path, so `clear`
reaches the right stash (nothing left held).

The objection is data quality. The delivered transaction is `operation: 'http.server'`,
`name: "GET /path"`, **`status: 'OK'`** (the default, `span.ts:180`), **duration ≈ 0** (end timestamp
taken from the clock at request start), and **no `http.method` / `http.status_code`** — those are added
only in `finishWith` (`:523-524`), which never runs. It lands in the same aggregation bucket as every
real request, dragging p50/p95 down and reporting success on a request whose outcome is unknown. The
comment at `:498` calls this "truthful timing over no telemetry"; it is neither truthful nor timing.

The hazard it buys ("an orphan no owner can ever finish; on a lingering context the next request would
even read it") is also largely closed by this very change — under the request-scoped store the orphan is
stashed per-context and dies with it, and `ownsSlot` keeps it from any other execution.

**Recommendation: drop it (the previous behaviour is now safe), or `finish('CANCELLED')` so the sample
is self-identifying and excludable downstream.**

### R-5 · SEV2 · The hostile-store threat model is applied to APM enrichment and not to the crash path

The threat is REAL and public — `BugseeLaunchOptions.requestContextStore` (`node/src/launch.ts:335`)
flows through `BugseeServerLaunchOptions extends BugseeLaunchOptions` (`bugsee/src/server-launch.ts:16`)
into the umbrella's top-level `launch()`, and `RequestContextStore`/`RequestContextStoreToken` are
re-exported to users at `bugsee/src/index.node.ts:20`. That is what distinguishes the five guarded
`server-instrument.ts`/`active-span-store.ts` sites from R-3, and it is why they are justified.

But the same store is read unguarded on the REPORT path: `packages/core/src/client.ts:543`
(`submitReport`'s `contextProvider?.getCurrent()`, whose result goes straight into
`reportContexts.set(handled, captured)` — a non-object context reaches `WeakMap.set(primitive, …)` and
throws `TypeError`) and `client.ts:359` (`getContext: () => contextProvider.getCurrent()`).

Net effect of this wave under its own threat model: **APM enrichment hardened at five sites, crash
reporting left exposed.** The existing follow-up note is candid, but normalizing in two of three places
is worse than normalizing in none — it makes the remaining hole look already handled.

**Recommendation: hold the commit for this, or pull the null/non-object normalization into one
`safeGetContext` in `@bugsee/core` that all six call sites use.**

### R-6 · SEV2 · `controller.ts:57` now claims unconditional isolation that only holds with the default auto-instrument

The rewritten docstring states the Node launch supplies per-async-context tracking *"so concurrent
requests stay isolated"*, with no caveat. Measured on Node 24.15: the store is exactly as isolated as the
context OBJECT is, because `active-span-store.ts:112-121` keys on identity. In the
`handle()`-called-twice-from-one-sync-frame shape — which `openServerContext` (`server-instrument.ts:296-300`)
and `nestjs/src/middleware.ts:48` both implement as "skip `enterWith` when a context is already active" —
two concurrent requests share one context:

```
handle#3 before=2 entered=2 afterAwait=2
handle#4 before=2 entered=2 afterAwait=2   <-- both requests in context id=2
```

Then request A's `setActiveTransactionName` reads `ownsSlot.has(C)` → `live(stashed(C))` → **T_B**. D2
verbatim, not narrowed. The module comment at `:27-30` calls this a "caveat … a transaction stashed on
it lingers with it", which understates it — the store returns a foreign LIVE transaction.

Gated by config, not luck: `instrumentIncomingRequests` defaults `true` (`launch.ts:1030`) and the
`node:http` emit patch is `run`-scoped — measured to give a genuinely fresh ALS frame per request, even
for pipelined requests on one socket. It fires only with `instrumentIncomingRequests: false` PLUS a host
dispatching concurrent requests from one shared async frame (the Elysia `app.handle` shape).

**Recommendation: qualify the docstring, or make the naming seam a no-op rather than mistarget when the
context is known-shared.**

### R-7 · SEV3 · The exports are inverted — the useless factory is public, the useful one is not

`packages/performance/src/index.ts:10` exports `createSingleSlotActiveSpanStore`, the DEFAULT that nobody
needs to construct. `packages/node/src/index.ts` does NOT export `createRequestScopedActiveSpanStore`. A
consumer on bare `@bugsee/node` wiring APM by hand — the shape of
`packages/instrumentation-tests/app/scenario.ts:375-377` — therefore has **no supported way to obtain
per-request isolation**; the store is built at `launch.ts:1104` and discarded unless the umbrella
consumes it. Export the request-scoped factory, or drop the single-slot one; shipping exactly the wrong
one of the two is the worst combination.

### R-8 · SEV3 · This file asserts a pre-existing lint failure that does not exist

The "Pre-existing red, not this wave" bullet above is wrong, and is corrected in place. Ground truth:

```
$ pnpm lint ; echo $?                                    # biome check .
Checked 1135 files in 227ms. No fixes applied.
Found 24 warnings.
0
$ pnpm exec biome check packages/instrumentation-tests/harness/invariants.mts ; echo $?
0
```

`biome.json` sets `linter.rules.recommended: true` with no severity overrides, and in Biome 2.x
`noExplicitAny` / `noNonNullAssertion` are **warn**-level, so `biome check` exits 0. CI's lint step is
literally `run: pnpm lint`, so it passes there too — confirmed against the actual run for this commit
(`gh run list`: lint/typecheck/cycles job green at `72b2837`). The files ARE byte-identical to `HEAD`, so
the "untouched by this change" half is right; warnings are simply not red. The note also omits the 24th
diagnostic, in `packages/node/src/index.test.ts`.

Why this rates a finding rather than a typo: it hands the next committer a standing instruction to treat
a lint failure as expected noise. If `pnpm lint` ever goes genuinely red, the documented excuse is
already sitting there — which is exactly what happened while closing these findings (see below).

**Two measurement traps found the hard way while verifying this, both worth keeping.**

1. **`biome check --stdin-file-path=<path>` does NOT reproduce `biome check <path>`.** Piping the same
   bytes through stdin returned exit 1 where the by-path check returns 0 — stdin mode does not resolve
   the same config/severity. It looked like a clean way to lint a file's `HEAD` content without
   `git stash`/`checkout` in a tree full of uncommitted work. It is not. Use `git worktree` for that, or
   reason from the diff.
2. **A formatting error in your own new code masquerades as the documented pre-existing failure.** Mid-fix,
   `pnpm ci:local` went red on lint and the standing note made it look expected. It was not: `Found 3
   errors` — biome `format` on three test files edited minutes earlier. **Read the `Found N errors` line,
   not the exit code**, and never accept a red gate because a note says that gate is already red. Fixed
   with `biome check --write` on those three files; `pnpm lint` back to exit 0 / 24 warnings.

### R-9 · SEV3 · `clear()`'s containment early-return skips the `ambient` release, retaining one finished transaction

`packages/node/src/active-span-store.ts:154` returns before `:165` (`if (ambient === transaction) ambient = undefined`).

A transaction started outside any context lands in `ambient` (`:125`). If it then finishes INSIDE a
frozen/sealed context, the early return keeps a strong reference to the FINISHED transaction until the
next context-less `set()` overwrites it. WeakRef-proven:

```
clear() in a NORMAL (no) context  -> transaction still retained? false
clear() inside a FROZEN context   -> transaction still retained? true
```

Bounded and benign (one variable; ≤ ~31 KB measured with 100 `http.client` children; `get()` hides it via
`live()`), and the precondition is exotic. But the comment's justification ("must not mutate shared
state") is about the STASH — releasing a reference the store itself installed, by identity, mutates
nothing another execution can observe. Move the `ambient` release above `:154`, or record the retention
consequence. Dissolves entirely under R-1.

### R-10 · SEV3 · Frozen-context containment defends a case no SDK path produces

`active-span-store.ts:80` (`unstashable`), `:114-116`, `:128-148`, `:152-164`; plus
`server-instrument.ts:584-590` (`stashSpan`'s catch).

Every SDK-created context is a fresh object literal — `buildContext` (`server-instrument.ts:281-285`),
used at `:302`, `:358`, `:404`. Every `run`/`enterWith` caller in non-test source was checked
(`nestjs/src/middleware.ts:69`, `vercel-edge/src/edge-context.ts:114`, the three above): **none can
produce a non-extensible context.** Reachable only via a custom `requestContextStore` returning a frozen
object, or an integrator resolving `RequestContextStoreToken` and calling `run(Object.freeze(ctx), fn)`.
`clear()`'s `delete` catch (`:161-163`) is narrower still — it needs a context sealed AFTER a successful
stash, mid-request; the covering test (`active-span-store.test.ts:371-389`) calls `Object.seal` between
`set` and `clear`, a sequence no host produces.

The reasoning is sound and the over-containment boundary at `:146` is a correct refinement — this is
careful work. It is simply unbudgeted: ~35 lines, two WeakSets and three branches for a scenario with no
producer. Keep `set`'s `defineProperty` catch (cheapest guard at a real-if-exotic boundary — a throw out
of `startTransaction` really would break the request); drop the rest with R-1.

**Separately: `stashSpan`'s catch has an undocumented consequence.** Its comment says "the span stays
usable transaction-only". What it omits is that a failed stash means a later opener in the same request
finds no `refinableSpan` and opens a **second context and a second `http.server` transaction** — the
exact double-instrumentation first-owner-wins exists to prevent. Worse than the comment implies; state it.

### R-11 · SEV3 · A pipelined request loses its own transaction for its entire close phase

Measured on real `node:http` with two pipelined requests:

```
[close ctx=4] getStore=4 writableFinished=true
[close ctx=5] getStore=4 writableFinished=true   <-- req 5's close runs in req 4's context
```

Node queues the second response (`state.outgoing`) and flushes it inside the first response's completion
chain. The store survives it correctly (`clear(T5)` in `C4` hits the identity check at `:157` and deletes
nothing; `ownsSlot(C4)` stops req 5's tail reading `C4`'s transaction). The residual: any
`getActiveSpan()` / naming call / outbound call issued from a `res.on('finish')` handler during req 5's
close phase reads `C4`, whose stash is already deleted, and the fallback is blocked → `undefined`. The
old process-wide slot returned `T5`. Pipelining is effectively dead in browsers, hence SEV3.

**Adjacent, pre-existing, not this diff:** the same fact means `span.captureError` during req 5 calls
`store?.setAttribute('http.route', …)` (`server-instrument.ts:541`) on **req 4's** context, and T5's
`onFinished` capture-ring entry is stamped with C4's `contextId`. Worth its own look.

### R-12 · SEV3 · Realm-global stash key vs per-store WeakSets can alias

`ACTIVE_TRANSACTION` is `Symbol.for(...)` (`:36`, process-global) while `unstashable`/`ownsSlot` are
per-store closures (`:79`, `:84`). Two stores over one context object: B's `set` overwrites the symbol,
then A's `get` — `ownsSlot_A.has(C)` true — returns **B's** transaction at `:119`. Falsification
attempted: a repeat `launchCore` returns `internals: undefined` and never reaches `:1104`
(`launch.ts:463-470`), so one process = one store. It needs two different CARRIERS (duplicate or
mismatched `@bugsee/node` copies) both handed the same `options.requestContextStore`. Exotic — but the
comment at `:68-70` asserts safety on "the process launches exactly one store", which is the carrier
invariant, not a property of this code. Say so.

### R-13 · SEV3 · Test assertions that do not carry the weight their comments claim

- `server-instrument.test.ts:1132` — `expect(api.getActiveSpan()).toBeUndefined(); // finished in the
  catch — not orphaned live`. The read happens AFTER `runServerRequest` returns, i.e. outside the ALS
  context the orphan would be stashed in, so it returns `undefined` whether or not the abandon-finish
  ran. Verified empirically. The only falsifiable assertion in that test is
  `expect(txStore.drain()).toHaveLength(1)` at `:1137`. The hazard the implementation comment names
  (`server-instrument.ts:492`, "on a lingering context the next request would even read it") has **no
  test** — reading back inside a RE-ENTERED context is where it could actually fail.
- `server-instrument.test.ts:1217-1229` — "the owner span is still refined" asserts nothing about
  refinement. The `owner` doubles (`:1190-1191`) are never asserted; `span?.setRoute('/orders/:id')` at
  `:1227` is a bare call. The one real assertion, `captureError → true`, does not discriminate a refining
  handle from a fresh `makeSpan` span — both return `true`, only `NOOP_SPAN` returns `false`
  (`server-instrument.ts:260-262`). So replacing `refiningHandle(existing, …)` with `makeSpan(…)` in
  `startServerSpan` (`:321`) — losing first-owner-wins re-entrancy, which this test's own title claims is
  preserved — SURVIVES. Add `expect(owner.setRoute).toHaveBeenCalledWith('/orders/:id')`. Same shape at
  `:1282-1304`.

### R-14 · SEV3 · Reachable behaviour with no test

- **The `enterWith` path is untested.** All 31 node store tests use `run()`. `openServerRequest` /
  `openServerContext` (`server-instrument.ts:358`, `:300`) — the fastify/nestjs/hapi entry — use
  `enterWith`, and `active-span-store.ts:28-31` documents an enterWith-linger live-share as an accepted
  risk that nothing pins in either direction. Probed: the two-concurrent-`enterWith`-handlers shape
  isolates correctly today (`{"B":"B","A":"A"}`), so the test is writable and would pass.
- **Nested contexts.** When the active context was opened by `enterWith`, `refinableSpan`
  (`server-instrument.ts:114-118`) returns `undefined`, so `runServerRequest` opens a NESTED `store.run`
  context. The inner context is not in `ownsSlot`, so `get()` falls back to **ambient** rather than to
  the enclosing request's live stash. Reachable, no test either way. (Another R-1 consequence.)
- The `'drop'` warn kind never reaches the launch wiring in any test; `launch.test.ts:1985-2009` pins
  only `'throw'`.

### R-15 · SEV3 · Two comments now assert the opposite of what the code does

`packages/bugsee/src/wire.ts:40-41` and `:71-72` still say the browser and node `launchCore` produce a
*"structurally identical"* value. After this change they do not — `launch.ts:387` was correctly softened
to "Shaped like"; these two were missed. This matters more than a usual doc nit: the "structurally
identical" claim is exactly what makes the optional `activeSpanStore?` field (R-16) look harmless.

### R-16 · SEV3 · The optional-vs-required asymmetry is a latent hole with no type signal

`bugsee/src/wire.ts:58` (`activeSpanStore?`) vs `node/src/launch.ts:417` (required). `UmbrellaInternals`
is a hand-maintained structural mirror with no shared type — browser and node declare `LaunchInternals`
independently (`browser/src/launch.ts:250`, `node/src/launch.ts:395`). At the `wireUmbrella(client,
internals, …)` call site (`bugsee/src/server-launch.ts:37`) `internals` is a variable, so excess-property
checking does not apply: a rename or drop on the node side produces **no type error** and the store
silently vanishes to the single slot. The field must stay optional given the current design (the browser
internals would otherwise fail assignability), so this is not fixable by flipping the modifier. It is
covered behaviourally by `bugsee/src/node.test.ts:255-276`, which is adequate today — but the hole
reopens with zero signal for any FUTURE server platform that builds its own `LaunchInternals` without
going through `nodeLaunchCore`.

### R-17 · SEV4 · `ActiveSpanStore` is named for `Span` and typed to `Transaction`

`performance/src/active-span-store.ts:27,29,37` — all three members take/return `Transaction`, while
`PerformanceApi.getActiveSpan()` returns `Span | undefined` and Android's holder is genuinely
`ThreadLocal<Span>`. Now that this is an exported seam a third party can implement, the mismatch will
mislead. `ActiveTransactionStore` is accurate.

### R-18 · SEV4 · The built-in store can violate its own no-throw contract

`active-span-store.ts:44` — `live()` calls `transaction.isFinished()` unguarded, so `get()` throws for a
hostile `Transaction`; and `set`'s catch calls `live(stashed(context))` at `:146`, so a throw there
escapes `set()` FROM INSIDE the catch. Unreachable today (only controller-created `TransactionImpl`s ever
enter the store) and every call site is guarded, so zero user impact — but
`performance/src/active-span-store.ts:16-20`'s absolute claim ("The built-in stores never throw") is
false as written.

### R-19 · SEV4 · `delete` pushes the `RequestContext` into dictionary mode; the fix is free

`active-span-store.ts:159`. A single `delete` of a `defineProperty`-installed symbol forces V8 to
slow-properties. Measured on the exact read the capture aggregator does per entry (8M iterations, best of 7):

```
HEAD shape: SERVER_SPAN only, never deleted        1.27 ns/read
1 set+clear cycle (the NORMAL per-request flow)    9.05 ns/read
10 set+clear cycles                                9.07 ns/read   (does not compound)
```

The second symbol property costs nothing by itself (`1.37 → 1.34 ns`); it is the `delete` alone, and
`server-instrument.ts`'s `SERVER_SPAN` stash never deletes, so this transition is NEW. Practical impact
≈ zero on the dominant path (`clear()` runs in the response `close` handler, after which essentially no
entries are stamped on that context) — it bites only for `enterWith`-lingering contexts and for a user
finishing a transaction mid-request, at 8 ns against a capture entry costing microseconds. Reported
because the fix is free: the descriptor is already `writable: true`, so
`context[ACTIVE_TRANSACTION] = undefined` clears it without the map transition, and every downstream read
already treats `undefined` as absent. Fold into any future touch of this file.

### Pre-existing, surfaced by this review, NOT in scope

- `server-instrument.ts:466-491` — `makeSpan`'s outer catch spans `tryGetPerf`, `parseTraceparent`,
  `spanName` → `urlPath` → `sanitizeUrl`, `startTransaction`, three getters and `store.setTrace`. A defect
  in `sanitizeUrl` or `parseTraceparent` — our own code, on every request — is swallowed with no
  `onError`. Its breadth got MORE consequential, not less: R-4's new code sits inside it, so a
  `sanitizeUrl` bug now additionally ships a junk transaction. Narrow it to the `perf`/`store` calls.
- The pipelining context-attribution issue noted under R-11.

### Verified CORRECT (the claims that hold, and what earned them)

**Gates — all pass, re-run rather than taken on trust.** `pnpm typecheck` → 100/100 (also with
`--force`, 22.89s, exit 0). `pnpm check:cycles` → no circular dependency over 1198 files.
`turbo run test:coverage` → 97/97, exit 0. `turbo run test:unit` → 51/51, exit 0. bun 1.4.2 + deno 2.8.3
e2e → 93/93 passed, child processes observed (not silently skipped). Coverage on every touched file:

```
@bugsee/performance   active-span-store.ts  100 | 100 | 100 | 100     (pkg: 100 | 99.06)
                      controller.ts         100 | 100 | 100 | 100
@bugsee/node          active-span-store.ts  100 | 100 | 100 | 100     (pkg: 100 | 96)
                      server-instrument.ts  100 | 100 | 100 | 100
                      trace-propagation.ts  100 | 100 | 100 | 100
@bugsee/bugsee        wire.ts               100 | 100 | 100 | 100
```

**Coverage is honest.** Zero `/* v8 ignore */` in any new or touched file (grep exit 1). Note for future
readers: the text reporter OMITS fully-covered files, so a new file's ABSENCE from the table is the pass,
not an exclusion.

**The concurrency tests are genuinely load-bearing — proven by substitution, not assumed.** Running the
OLD single-slot store against the three key scenarios verbatim, through the real controller and real
`AsyncLocalStorage`:

```
CAUGHT  integration#1   -> A: getActiveSpan() !== own | A: own.getName()='GET A' expected '/a/:id'
CAUGHT  integration#4   -> nameOfA='GET /a'   (A's rename landed on B's transaction)
CAUGHT  unit concurrency-> seen={"B":"B","A":"B"}  (A literally read B's transaction)
```

All context tests use a REAL `node:async_hooks` ALS (`node/src/request-context-store.ts:39-43`) — no
faked context provider anywhere in the three new files. `controller.test.ts:229/260` probe both naming
seams separately and mutate the assertion target; `:311` catches a module-hoisted shared default slot
that would pass every single-controller test; `trace-propagation.test.ts:63`'s `not.toThrow()` is exactly
right (without the guard the throw escapes synchronously into the app's own `fetch()`);
`server-instrument.test.ts:1085` catches a WRONG OUTCOME, not just a throw (`null !== undefined` made
`openServerContext` skip the open).

**R-2/R2-8 bundle isolation holds.** Built `@bugsee/node`: `grep -c "@bugsee/performance"` → **0** in both
`dist/index.js` and `dist/index.cjs`; the only `performance` hit is `node:perf_hooks`. Structurally
guaranteed, not incidental — `tsconfig.base.json:39` sets `verbatimModuleSyntax: true`, so `import type`
cannot survive. `@bugsee/performance` was already in node's `dependencies` before this change
(`git show HEAD:packages/node/package.json:33`), not added by it.

**No runtime is left on the broken slot.** Only `@bugsee/browser` and `@bugsee/node` build a
`LaunchInternals`; browser correctly omits the field (one in-flight navigation). Bun/Deno inherit
verbatim (`bun/src/launch.ts:20`, `deno/src/launch.ts:22`). `@bugsee/cloudflare`, `@bugsee/vercel-edge`,
`@bugsee/webworker` and `@bugsee/electron` contain **zero** references to `@bugsee/performance` and never
wire a controller — there is no slot there to be wrong. All five meta-framework server entries launch
through `@bugsee/bugsee/node` → `createServerLaunch` → `wireUmbrella`, so they inherit the fix.
(Electron main receives the store at `electron/src/launch-main.ts:113` and discards it — harmless, it
wires no APM.)

**Cost is not measurable in practice — MEASURED, not estimated.** Node v24.15.0 darwin-arm64, best-of-5,
sink-guarded:

```
single.get() (old)          3.96 ns/op        scoped.set()   70.80 ns/op
scoped.get() (new)         14.42 ns/op        scoped.clear() 14.66 ns/op
  delta = 10.47 ns/op (of which ALS getStore = 6.06 ns)
try/catch overhead: als.getStore() bare 3.99 ns vs in try/catch 3.98 ns  -- free, measured
ALS depth-insensitive: 13.18 ns at depth 1 vs 13.29 ns at depth 20
allocation on the read path: 0.0005 B/call over 20M calls
```

Frequency: `set`/`clear` 1× per incoming request; `get` 1× per OUTGOING network call; the naming seams
are **0× by default on a server** (every built-in adapter refines via `ServerRequestSpan.setRoute()`,
which reads the context stash, not this store). Against a bare keep-alive `node:http` round-trip of
32.0 µs, the store adds ~0.090 µs = **0.281%** — and that 32 µs is a do-nothing handler over loopback.

**Retention is GC-bounded — proven, and the dismissal was understated.** On the auto-instrumented path
`clear()` DOES reach the stash (`RETAINED STASHES: 0 of 1`), so "never removed" is the exception, not the
rule. Worst case anyway — every request stashing a ~31 KB never-finished transaction, 1000-request
warmup then 4000 more with forced GC: **−365 B/req (negative heap delta)**, and a `WeakRef` census shows
**3 of 3000** `RequestContext` objects reachable after GC (the three in flight). The stash holds at most
one transaction per context (`defineProperty` overwrites), so the ceiling is O(in-flight) × ~31 KB.
Transaction size measured: 723 B bare, 31,314 B with 100 recorded `http.client` children, capped by
`MAX_HTTP_SPANS = 100` (`http-spans.ts:89`). No bodies are held (`http-spans.ts:143` stores a
query-stripped sanitized URL plus 2–4 scalars).

**The symbol stash stays out of report assembly and capture stamping.** Every consumer reads NAMED fields
only: `core/src/capture-aggregator.ts:38-54` (`contextId`, `trace.*`, spreads `entry.data` not the
context), `core/src/bundle-assembler.ts:113-190` (spreads `context.attributes`, the sub-object). No
`structuredClone`, no `JSON.stringify(context)`, and no `Reflect.ownKeys`/`getOwnPropertySymbols`
anywhere in `packages/*/src`. Belt and braces: the property is `enumerable: false`.

**Android parity on nesting and clear-on-finish is faithful.** `SpanContextHolder.java:13-14` states the
holder does NOT restore a parent on finish and callers manage restoration — the controller's documented
"no span stack, D11 clears rather than reverts" (`controller.ts:159-166`) matches it exactly. JS's
identity-compared `clear()` and its finished-transaction filter are STRICTER than Android's unconditional
`remove()` / unfiltered `get()` — improvements, not divergences. Only R-1's ambient fallback diverges in
a direction that matters.

**Other verified-correct items.** `clear` can never delete a foreign slot (strict identity at `:157` and
`:165`; all four orderings traced). Nested transactions within one request behave identically to the old
single slot (documented D11 tradeoff), and `http.server` naming is unaffected because `finishWith` uses
the closure's `transaction`, not the store. A client abort fires `close` with `getStore() === undefined`,
so the originating stash is never removed — `live()` hides it and the context is GC'd, exactly as the
module claims at `:21-25`. A request transaction can never leak to a background task (a request-scoped
`set` always stashes and never writes `ambient`). `createSingleSlotActiveSpanStore`'s added `isFinished`
filter is behaviour-preserving (`onFinish` fires once on the finished transition, `span.ts:327-329`).
The umbrella's public API is genuinely unchanged (`bugsee/src/index.ts:23-29`, `index.node.ts` re-export
neither new symbol). **And a real improvement nobody claimed:** `collectHttpSpans` binding the owner at
the `before` stage (`http-spans.ts:114`) now resolves the ISSUING request's transaction instead of the
last-started one.

### Order the work was actually done in (all complete)

1. **R-1** — drop the ambient fallback for context-bearing reads. Dissolves R-10, most of R-14, and R-9.
2. **R-5** — guard the crash path, or hold the commit.
3. **R-2** — the ~15-line concurrent `runServerRequest` test.
4. **R-3** and **R-4** — delete the unreachable catches; drop or downgrade the abandon-`finish()`.
5. **R-6**, **R-8**, **R-15** — the three statements that are currently false.

Everything below that is cleanup and can ride a later touch of these files.

### Resolutions (2026-09-14, uncommitted working tree — second pass)

Done, test-first + mutator-verified + gates green; pending a fresh convergent round:

- **R-1 DONE** — context-bearing reads are strictly private (`context !== undefined ?
  live(stashed) : live(ambient)`); the containment apparatus (`ownsSlot`, `unstashable`, ~40 lines)
  is deleted. What stays: null/non-object normalization, per-cause warn-once, drop+warn on
  unstashable writes, the guarded sink, set/clear guards. Producer audit accepted — no built-in
  entry reads ambient from in-context, and Android returns `null` with no fallback. Nested-run
  limitation documented in the module note.
- **R-2 DONE** — concurrent-`runServerRequest` test (real ALS + real controller + scoped store,
  20/5 ms interleave, names asserted off the §8.8 drain); verified to fail on the
  start-before-open mutant.
- **R-3 KEPT + rebutted** — the catches stay. "No public API can reach a custom store" overstates:
  direct controller construction (`createPerformanceController({ activeSpanStore })`, the
  instrumentation-tests scenario shape) IS public API and takes any implementation. Plus the
  must-not-throw contract now states the rule, and their own test-reviewer verified no pre-existing
  test passes via a degraded path.
- **R-4 DONE as `finish('CANCELLED')`** — self-identifying and excludable; status asserted off the
  drain. The "truthful timing" phrasing is gone.
- **R-5 DONE (crash path)** — `submitReport`'s `getCurrent()` is guarded (test-first, mutant-verified).
  Mechanism correction for the record: `reportContexts.set(handled, captured)` cannot throw on a
  primitive context (it is the VALUE, not the key) — the real hole was only the throwing provider,
  now closed. Capture path was already guarded (`route()` try/catch).
- **R-6 DONE** — docstring qualifies: isolation holds on the default auto-instrumented path (fresh
  ALS context per request); shared-object concurrency is not isolated.
- **R-7 DONE** — `createRequestScopedActiveSpanStore` exported from `@bugsee/node` (+ barrel test);
  flows through bun/deno `export *` with no test updates needed.
- **R-8 accepted (was already corrected in place).**
- **R-9/R-10/R-12 dissolved** by R-1 (apparatus deleted); the stashSpan double-instrumentation
  consequence is now stated in its comment; the R-12 comment states the carrier invariant accurately.
- **R-11 recorded as follow-up** (pre-existing pipelining attribution, explicitly out of scope).
- **R-13 DONE** — the vacuous post-return read is dropped (drain carries the test); both refining
  tests now assert `owner.setRoute` delegation directly. (The R-2 test was restructured along the way:
  `getActiveSpan()` is typed `Span`, which has no `getName` — names now come off the drained §8.8
  wire instead of the live span.)
- **R-14 DONE** — enterWith concurrency test (passes, as probed), nested-read test pinning the
  documented limitation, launch drop-warn threading test.
- **R-15 DONE** — `wire.ts` comments match `launch.ts` "Shaped like".
- **R-16 DONE** — `keyof` compile-time pin in `bugsee/src/node.test.ts` (fails compilation, not just
  a test, if node renames/drops the key), strengthened to also pin the field TYPE (mutual-extends —
  optionality-drift alone is harmless since the umbrella tolerates absence, but a mistyped field
  would corrupt the handoff silently).
- **R-17 dismissed** — `Transaction extends Span` (`span.ts:38`); the name is backed by the hierarchy.
- **R-18 DONE** — no-throw claim qualified to controller-created transactions.
- **R-19 DONE** — assignment-clear (no dictionary transition); sealed test now expects immediate
  blanking, frozen test keeps retained-then-hidden.
- **F5 outcome: probe measured redundant, deleted.** A launch-time probe of the span store (to warn
  on broken custom stores with no APM wired) was built, then measured unnecessary: launch already
  reads the registered store ~15× (provider starts) with every throw reported — `getCurrent` calls
  15, `onError` calls 15, same object. The probe would have been a 16th report. Deleted; the
  launch test instead pins the signal existing at all ("a broken custom store surfaces at launch —
  never silently"), which fails if every launch-time reader goes quiet.

## D2 part 2 — OPUS REVIEW ROUND 2 (2026-09-15). 2 SEV2, 8 SEV3 — ALL FIXED

Three Opus reviewers (correctness/concurrency · test quality · adversarial whole-diff) over the FIXED
state, each told to verify the resolution table rather than trust it. **No SEV1 and no SEV2 on
correctness or architecture** — both remaining SEV2s were TEST defects, and the value claim was proven
end-to-end with a falsification. Everything below is fixed in the same tree.

### What was verified, not assumed

- **The feature delivers.** Real `node:http` server + real umbrella launch, two overlapping requests each
  issuing an outgoing fetch, timed so a global slot MUST misattribute → `GET /a` owns `call-a`, `GET /b`
  owns `call-b`. The same through `openServerRequest` (the `enterWith` hook-adapter path) → also isolated,
  which no existing test covers with a real server. Discriminator against the old single slot: `GET /a`
  never finished and `call-a` was DROPPED.
- **The `onError` → `logException` → capture → `getActiveSpan` → store-throws loop terminates at depth 1**
  (latch added before delivery); cross-site nesting bounded at 3; a throwing sink never escapes; a
  non-function `onError` never escapes.
- **`'CANCELLED'` reaches the wire exactly once** with the slot released, and is an existing `SpanStatus`
  (`span.ts:10`) already produced by `idle-transaction.ts:79` — R-4 introduced no new wire value.
- **R-19's assignment-clear** preserves `enumerable:false` (own writable data property), so report
  assembly and capture stamping are untouched; no `getOwnPropertySymbols`/`Reflect.ownKeys`/`hasOwnProperty`
  anywhere in non-test source.
- **R-1's full state space re-walked** against real ALS + real controller: ambient never leaks into a
  context-bearing read, ambient is genuinely released, frozen contexts never poison or orphan it, and the
  nested-`run` case is strictly SAFER than the old fallback (which returned a foreign transaction there).
- **R2-8 holds for values**, freshly built: 0 hits in node's ESM and CJS bundles. See O-9 for the nuance.
- Gates: `pnpm test` 442 files / 6376 tests, typecheck 100/100, cycles clean, lint `Found 24 warnings` and
  no errors, coverage 100% line/fn/stmt per package, zero `/* v8 ignore */` in the diff.

### O-1 · SEV2 · FIXED · A test for the abandon-path guard could not fail with that guard deleted

`server-instrument.test.ts` — the test pinning the inner catch around `transaction?.finish('CANCELLED')`
asserted only `not.toThrow()` + the return value. `makeSpan` runs BEFORE `dispatched = true`, so deleting
the catch merely routes the throw into `runServerRequest`'s own catch, which returns `dispatch(NOOP_SPAN)`
— same value, no throw. Proven with a probe: `{"returned":"ran","threw":null}` either way. Covered but
never validated.

**Fixed** by asserting from inside the dispatch: `span.captureError(...)` returns `true` for a real span
and `false` for `NOOP_SPAN`, which discriminates the two. Mutation-verified: removing the inner catch now
fails 1 test.

### O-2 · SEV2 · FIXED · Two tests named for `clear()` passed with `clear()` deleted outright

`active-span-store.test.ts` ("clearing an ambient transaction from inside a context clears the ambient
slot") and `active-span-store.integration.test.ts` ("an ambient transaction finished inside a request
clears everywhere"). Both finished the ambient transaction BEFORE the clear, and every later read goes
through `live()`, which hides a finished transaction whether or not the slot still holds it. With
`clear()` stubbed to a no-op, all six assertions stayed `true` — byte-identical to clean.

**Fixed, differently in each, because the two can observe different things:**
- The unit test now clears a **LIVE** transaction, so the read after the context exits can only be
  `undefined` if the clear actually reached the ambient slot. Mutation-verified: `clear()` → no-op now
  fails **10** tests (it was 0).
- The integration test goes through the CONTROLLER, where a finished transaction is hidden by `live()` no
  matter what — it structurally cannot observe slot release. Rather than fake a proof, it was renamed and
  rescoped to what it genuinely pins (a background transaction finished inside a request is invisible to
  that request, before and after), with a pointer to the unit test that carries the release guarantee.

This is the `REMEDIATION-PLAN.md` "six tests asserting the defect they existed to prevent" pattern, twice.

### O-3 · SEV3 · FIXED · The naming seams propagated a hostile transaction's throw

`controller.ts` — R-3's guard wrapped `activeSpanStore.get()` but not what it RETURNS, so
`active.setName()` / `setAttribute()` ran outside every try. A custom store handing back a transaction
whose setters throw propagated straight out of `setRouteName()` into app code — breaking the interface's
own promise (`performance/src/active-span-store.ts`) that the controller "degrades a throwing store to
untracked rather than propagating". The guard and the contract now cover the same surface: both seams run
through one `nameActive()` helper, guarded, reporting once under a new `'name'` site.

### O-4 · SEV3 · FIXED · A comment that argued FOR the mutation it exists to prevent

`performance/src/http-spans.ts` — the entire stated reason for binding the `http.client` owner at the
`before` stage was the cross-request misattribution D2 part 2 has now closed. A contributor reading it
post-change could reasonably conclude the WAVE 3b.4 binding is redundant and revert it.

**It is not redundant — its premise narrowed, its conclusion did not.** Resolving the parent at completion
still DROPS any call that outlives its request's transaction (the finished transaction reads back as
absent, so the child attaches to nothing); the reviewer reproduced exactly that. The comment now says so.

### O-5 · SEV3 · FIXED · Three more comments still described the machinery R-1 deleted

`node/src/active-span-store.ts` (`current()`'s normalization justified by "the WeakSet ops"),
`active-span-store.test.ts` ×2. No `WeakSet` has existed in that file since R-1 deleted `ownsSlot` and
`unstashable`. The guards are still needed — `stashed(null)` and `Object.defineProperty(primitive, …)`
both throw — so the justifications were rewritten to name what actually throws. Left as-is, this is the
trail that makes a future reader re-add containment.

### O-6 · SEV3 · FIXED · `set()`'s "reads are private-empty either way" was false in both directions

`node/src/active-span-store.ts`. (a) A write dropped after an earlier successful stash leaves the EARLIER
live transaction readable — asserted as the correct outcome by a test 240 lines above the comment. (b) An
integrator reusing one context object across requests and freezing it between them reads the PRIOR
request's live transaction (reproduced). Both follow from reads being keyed on the context object, which
`controller.ts`'s docstring already states; the comment now says what a dropped write really leaves
readable instead of claiming it leaves nothing. **Comment fixed, not code** — the behaviour is correct and
the reachability is doubly exotic.

### O-7 · SEV3 · FIXED · The PUBLIC `clear()` contract justified itself by the deleted fallback

`performance/src/active-span-store.ts` — "because the finishing execution may read the transaction through
the fallback while it lives in ambient". The fallback is gone; the dual check is still mandatory, for a
different reason. This is the one doc a third-party `ActiveSpanStore` implementor reads to learn WHY both
checks are required, so it now states the surviving reason: a transaction started outside any execution
scope and finished from inside one is invisible to that execution's read, yet must still be released.

### O-8 · SEV3 · FIXED · R-16's own fix reintroduced the R-15 defect, and its claim overreached

`bugsee/src/wire.ts` still said the field "stays optional" twenty lines above the declaration making it
required. Also corrected: the required key forces a platform to STATE a choice, not to state a CORRECT one
— a future server platform still satisfies the type by writing `activeSpanStore: undefined`. Better than
optional; not the guarantee the comment claimed. (Noted for the day it matters: `LaunchInternals` is a
published type and the browser's field is typed as the literal `undefined`, so a browser-family platform
supplying a store would need a one-line change in `@bugsee/browser`.)

### O-9 · SEV3 · FIXED · Two more stale-premise comments, and the R2-8 boundary now has a type half

`node/src/trace-propagation.ts` and `bugsee/src/wire.ts` both justified a still-correct decision by the
single-slot concurrency bug. Both decisions survive on other grounds (the node decorator lives in the BASE
launch and must work with the opt-in APM extension absent; the perf-sourced decorator reads the active
transaction rather than the request context). `docs/design/cross-project-tracing.md` named the gap as open
in a doc headed **Status: BUILT** — now marked closed.

**R2-8 nuance, recorded so the next reviewer measures both halves:** the VALUE boundary holds (0 hits in
node's dist), but `packages/node/dist/index.d.ts` now carries `import { ActiveSpanStore } from
'@bugsee/performance'` — the first performance type in node's published declaration surface, because
`LaunchInternals` is exported. It resolves (performance is already a `dependency`), but it forecloses ever
demoting that to an optional/peer dep. The R2-8 note's "value-free" wording describes only half the
boundary now.

### O-10 · SEV4 · FIXED · Two test-hygiene items

An `expect(...)` wrapped around a `void` call (always true; the real assertion was the line below), and
the per-controller `onError` latch being caught only by cross-test ORDERING — an earlier sink-less test
happened to consume the latches. A two-controller test now states it directly; mutation-verified against a
module-hoisted latch (2 failures).

### The two dismissals, re-audited by a reviewer that was told to attack them

- **R-17 (the `ActiveSpanStore` name) — UPHELD, on better grounds than the ones recorded.** The solid
  argument is `span.ts`: `interface Transaction extends Span`, so the seam names a supertype role and
  holds a subtype — accurate, not a mismatch. The roadmap argument in the original dismissal is weaker
  than it looked: the span-stack slice IS planned (`docs/design/frontend-adapters.md`, D11), but what
  D11/D12 stack is TRANSACTIONS (pageload ← navigation ← interaction), so it would not necessarily widen
  the type. Keep the name; lean on the hierarchy, drop the roadmap reasoning.
- **R-11 (HTTP pipelining) — UPHELD and re-measured.** A raw-socket probe confirmed the loss is confined
  to pipelining and does not affect ordinary keep-alive:
  ```
  pipelined pair:        [1 finish] active=GET /1   [2 finish] active=undefined
  sequential keep-alive: [1 finish] active=GET /1   [2 finish] active=GET /2
  ```
  The worse variant was attempted and could not be produced: no foreign LIVE transaction is ever returned,
  because request 1's transaction is already finished and cleared by the time request 2's close phase runs
  in its context. The module comment's claim holds as written.

## Evidence preserved in `.session-artifacts/` (gitignored)

- `dataloss-harness.mts`, `dataloss-node-harness.mts` — reproduce the data loss in the FIRST
  recovery fix (proxy `hadMarkers` key) against real code. That fix was replaced; keep these as
  regression evidence for why.
- `ds-probe.mts`, `ds-probe2.mts` — R2-1 and R2-2 reproductions (`S1`–`S4` scenarios).
- `invariants.mts` — the 48-case sweep. **Its oracle is flawed**: I2 keys on
  `reportId ?? 'anon:'+summary`, so a legacy blob and its own marker's rebuild count as two
  different incidents — it swept the R2-2 violation and discarded it. Fix the oracle before
  trusting it again.
- `vt-bench/` — the viewtree walk benchmark (CPU throttling via CDP) and the binary-serialization
  prototype (`serialize.mjs`, tag codes + varint + delta + string table, measured raw and gzipped).
- `wire-bak/`, `vitest.config.ts.bak` — file backups from this session.

## Process notes worth keeping

- **Isolate parallel agents from each other's machine-level state.** Round 1 produced TWO phantom
  findings from one cause. (a) The mutation-testing reviewer mutated the shared tree while three static
  reviewers read it — one caught `capture-recovery.ts` mid-mutation and reported a typecheck failure that
  was purely an artifact. (b) Four reviewers ran concurrently while the SDK suite also ran; Karma binds a
  FIXED port 9876, which is the best explanation for R2-9's unreproducible viewer flake, including its
  otherwise-impossible cross-spec error. Give a mutating or browser-driving agent its own worktree, and
  never run two viewer-test agents at once.
- **A cross-file break needs routing, not silence.** In round 2 the keydown parity fix broke an assertion
  in a file another agent owned. The right move was what happened: the finder reported the exact one-line
  change and did NOT edit, and the owner applied it — one writer per file, always.
- `pnpm test` is a **unit** gate. `projects: ['packages/*']` alone silently swaps its contents —
  it drops `instrumentation-tests/test/bundle.test.ts` (that package's default config globs only
  `*.e2e.ts`) and picks up the four framework harnesses, which run real builds on fixed ports and
  race `pnpm test:e2e` to EADDRINUSE. The corrected root config excludes `packages/*-e2e` and
  names `vitest.unit.config.ts` explicitly. Correct = **423 files / 5710 tests / ~17 s**.
- Six tests were once found asserting the exact defect they existed to prevent
  (`REMEDIATION-PLAN.md`); round 1 added several more to that tally. Mutate the **assertion**,
  not only the implementation.
