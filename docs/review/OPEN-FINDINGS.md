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
`.session-artifacts/invariants.mts` runs clean in-tree (283 cases, 17.4 s) and imports no SDK predicate ·
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

**The harness rewrite is the load-bearing part.** `.session-artifacts/invariants.mts` no longer asks the
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

### New open items from round 4

- **The control plane never classifies at all** — asymmetry with the data plane. `bugsee-api.ts:82-84`
  (`/v2/issues`) and `:107-109` (`/v2/sessions`) throw for every non-2xx and `upload-pipeline.ts:97-125`
  defaults `permanent` to false, so a `400` from `/v2/issues` is retried forever. Fails SAFE (data kept),
  bounded on node by the 7-day retention, **unbounded on browser/worker** (`recover-dead-instances.ts`
  applies none). Deliberately NOT fixed: widening a deletion path unilaterally is what produced a new loss
  path in each of the last three rounds. Needs a decision, and should land WITH its harness case.
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
- **R3-12** (input key payload: `key: string` vs `keyCode: int`, four booleans vs `metaState`, no gesture
  `id`/`keyup`/`displayId`) — still open, still pre-existing.

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

### R3-8 · SEV3 · The tsup guard misses a TENTH package — `@bugsee/util`

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
- **Input `'change'`/`'submit'`/`'focus'` — awaiting a product decision.** They are not in Android's
  `InputEventStage` and never can be (no DOM at that layer). Recommendation is **B: a separate
  `semantic?:` field**, leaving `type` a closed, native-producible enum — additive, no cross-repo wire
  change, and it follows the file's own SDK-ahead-of-contract precedent for `button`/`key`/`target`.
  Option A (extend the shared enum) would touch `bridge-protocol.schema.json` and both native receivers —
  the same one-sided wire change that produced D1.
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
`recoverSiblingBundleQueue` applies no retention and no `permanent` check.

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
- Input stage vocabulary diverges from Android's `InputEventStage`
  (`InputEventStage.java:27-44` = `unknown|begin|move|end|scroll|keydown|keyup`):
  `browser/src/input-source.ts:265` emits `'begin'` for a **keydown** where a canonical
  `"keydown"` exists; `:275-277` emits `'change'`/`'submit'`/`'focus'`, absent from the enum.
- Five vacuous viewer specs (2 new, 3 pre-existing) + a mutation-free zone in the gzip replay
  decoder path — detail in the round-1 test-quality report.
- Vacuous runtime assertions in the export-surface tests (`bugsee/src/index.node.test.ts:24,36`,
  `fastify/src/reexport.test.ts:24,38`, `node/src/index.test.ts:98`). Mitigating: the
  `import type` lines ARE falsifiable under `tsc --noEmit`, which is a CI gate — the files earn
  their place, the vitest assertions are decorative.

---

## Known-open, pre-existing, deliberately not in this wave

- `node/src/launch.ts:754-765` — cross-subtree double-upload: a recovered bundle is re-staged
  into the live instance's `pending/`; if that upload fails, the dead sibling keeps its marker
  while the recoverer holds a blob with the same id in a different subtree. Confirmed. Severity
  reduced by the fact that the two uploads are **byte-identical** re-serializations (a collector
  dedup candidate, unlike R2-1/R2-2). The new per-blob `reportId` is the missing ingredient;
  closing it means threading an id set across the whole `recoverInstances` loop.
- `node/src/recover-instances.ts:38` — node has **no** lock claim ("atomic-rename claim land in
  slice 4"), so two simultaneous node launches both recover the same dead subtree. Browser is
  serialized by `web-lock-liveness.ts:63` `ifAvailable: true`.
- `@bugsee/util` `sha256.ts:31` — the `node:crypto` fallback is statically visible to
  esbuild-family bundlers; ignore comments (`webpackIgnore`/`turbopackIgnore`/`@vite-ignore`)
  mean nothing to esbuild. The documented `externalDependencies` workaround converts a build
  error into a **silent runtime error** on the upload path (`core/src/upload-pipeline.ts:77,137`
  calls `sha256Hex`), scoped to insecure contexts where `crypto.subtle` is absent.
- `bugsee-cli` (Rust repo): a CSS map aborts the whole source-map batch; an unchanged chunk fails
  the whole batch. Together these make iterative CI production builds impossible.
- rrweb fork: `.bugsee-unmask` on an `<input>` is honoured on the full-snapshot path only; a
  value typed *while* recording stays masked. Fails closed, so privacy-safe.
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
