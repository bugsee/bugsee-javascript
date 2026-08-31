# Findings — samples/svelte-spa

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-1 · `persist`+`recover` uploads ONE incident TWICE across a hard reload (duplicate issue events)

- **Severity:** major
- **Cross-cutting:** this is an `@bugsee/core`/`@bugsee/browser` defect, not specific to Svelte — it
  should also reproduce in `browser-vanilla`/`react-spa`/`vue-spa`'s own S12 checks (see "why this was
  missed elsewhere" below). Belongs in `samples/FINDINGS.md` once triaged; recorded here first since
  this sample found it.
- **Package:** `@bugsee/core` (`packages/core/src/client.ts:476-516`, `submitReport`) and
  `@bugsee/browser-utils`/`@bugsee/core` (`packages/browser-utils/src/recover-dead-instances.ts:14-46`
  + `packages/core/src/capture-recovery.ts:41-104`, both invoked from
  `packages/browser-utils/src/coexistence.ts:181,188` inside `coexistence.recoverDeadSiblings(...)`,
  which `packages/browser/src/launch.ts:516-534` calls at launch — see the corrected root cause below;
  an earlier draft of this finding misattributed leg 1 to `durable.recover()`
  (`packages/browser/src/launch.ts:504-508`), which is a no-op here).
- **Scenario:** S12 — persist a report, kill the tab mid-upload, confirm the next launch recovers it.
- **Expected:** one real incident (`logException` called once) recovers as one delivered report.
- **Observed:** it recovers as **two** separate `/v2/issues` POSTs + two separate S3 bundle PUTs, from
  a single `logException()` call followed once by `location.reload()` — confirmed by a single
  `page.click` producing exactly 2 `apidev.bugsee.com/v2/issues` responses and 2
  `bugsee-upload-west2.s3.amazonaws.com` PUTs, with only ONE navigation event in between (no double
  click, no extra reload).
- **RATE — corrected. The DEFECT is deterministic; only its OBSERVABILITY is load-dependent.** Earlier
  revisions of this finding (and of `README.md`/`scenarios.md`) stated that `SSVELTE-111`'s
  `events_count` grows by "exactly **+2** per click / per sweep run", and `verify.mjs` pinned
  `s12Bundles.length === 2` on that wording as an unconditional invariant of the sweep. That wording
  conflated two different claims. **The +2 is a real property of the incident:** one click produces two
  uploads, every time, on an isolated click — and `solid-spa` independently confirmed the same from the
  same seam, measuring `SSOLID-80` at **10 → 12 → 14** across three consecutive sweeps (exactly +2
  each) with a `+1` dedupe control alongside it, so this is not a Svelte-only or a sampling artifact.
  What is NOT invariant is what a SWEEP can WITNESS, because the S4 storm immediately preceding this
  control can still be draining when the recovery fires: five consecutive re-review sweeps delivered
  **1, 2, 0 and 2** bundles across the four runs that reached this control
  (`SSVELTE-111.events_count` moved 4 → 9, which is exactly 1+2+0+2) — legs landing outside the 12s
  poll window, or not at all, while the wire was busy. Both legs still fired; the observer had stopped
  looking.
  ELEVEN sweeps on the fixed (derived-budget) settle each delivered exactly **2** observable bundles on a
  CLEAR channel (seven when the fix landed, four more on the round-3 resume, every one reporting
  `channel CLEAR (bound: exactly 2)`). `SSVELTE-111.events_count` read **23** partway through that
  sequence, **33** after the tenth and **35** after the eleventh — that last pair straddles a single
  sweep and moves by exactly **+2**, the clearest direct confirmation of the rate: one click, two
  delivered reports, measured end to end on a clear channel. Neither figure reconciles to a per-run rate by arithmetic,
  and that is the point: `events_count` only ACCUMULATES, and a leg that arrives after the observer has
  stopped looking still lands. Treat the key as evidence the incident keeps recovering, never as a rate —
  the per-click rate is established by the isolated probe below, not by this counter.
  The re-review's `+0` run was reproduced on demand by shrinking the sweep's storm-settle budget back to
  roughly its old size (34s): with the storm still draining, the recovery delivered **0** bundles inside
  the 12s observation window. Nothing about the SDK changed between that run and a 2-bundle one — only
  whether the observer was still looking.
  So the correction is to the ASSERTION, not to the defect: `verify.mjs`'s bound is now conditional on
  the storm having settled (`=== 2` on a clear channel, `1-2` on a contended one) rather than flat, and
  neither this file nor `README.md` quotes a per-click rate without saying which regime it holds in.
  See `scenarios.md`'s S4 storm row for the settle budget that makes the clear-channel regime
  reproducible.
- **Root cause (read from source, not just observed; corrected from an earlier draft of this finding
  — see below):** `submitReport` in `packages/core/src/client.ts` persists a `ReportMarker` **before**
  assembly (line ~496) but only clears it once the WHOLE `triggerPipeline.report()` promise **settles**
  — i.e. once the network upload itself completes (`result.then(clear, clear)`, lines ~506-516). The
  comment directly above this code says the marker should be safe to hold only until "the durable
  bundle queue owns delivery" — but the durable queue takes ownership as soon as the bundle is written
  to disk/IDB (synchronous, near-instant), which happens **long before** the network upload settles.
  Between those two points, BOTH a live report marker AND a durably-queued bundle describe the same
  incident.

  A crash or reload inside that window (which for any real-world crash is exactly when recovery
  matters) then makes BOTH legs of `coexistence.recoverDeadSiblings(...)` fire for the SAME incident —
  and both legs run from the SAME call site, `packages/browser/src/launch.ts:516-534`:
  `createCoexistence` mints a fresh `instanceId` per launch and prefixes self's own bundle/marker
  stores with it (`packages/browser-utils/src/coexistence.ts:82,95-98`), so self has nothing to recover
  from — the crashed run is just a DEAD SIBLING to the new launch, and `durable.recover()`
  (`packages/browser/src/launch.ts:504-508`) is correctly a no-op over that fresh, empty prefix (its
  own adjacent comment says exactly this: "a no-op over its fresh prefix for the persist path"). ALL
  the actual recovery work happens per dead sibling, under that sibling's Web Lock, inside
  `coexistence.recoverDeadSiblings`'s `Promise.all` loop
  (`packages/browser-utils/src/coexistence.ts:174-192`):
  1. **`recoverSiblingBundleQueue`** (`packages/browser-utils/src/recover-dead-instances.ts:14-46`,
     invoked at `coexistence.ts:181`) — re-uploads whatever the dead sibling's durable bundle queue
     already had fully assembled and enqueued.
  2. **core `recoverReports`** (`packages/core/src/capture-recovery.ts:41-104`, invoked via the
     `recoverReportsForViews` callback at `coexistence.ts:188`, wired from
     `packages/browser/src/launch.ts:516-534`) — reconstructs a **fresh** bundle from the dead
     sibling's marker + its preserved capture chunks, and uploads that too.

  Neither leg knows about the other's delivery, so one incident that had both a queued bundle AND a
  live marker at crash time (the window described above) is delivered twice. Confirmed the second
  upload is not a byte-identical retry: the two uploaded bundles are genuinely different artifacts, not
  a retry of the same one — measured 4384 bytes and 2540 bytes across the two S3 PUTs in an isolated
  probe (two distinct S3 objects, the marker-rebuilt bundle necessarily smaller since it only carries
  the preserved capture chunks, not whatever else had accumulated in the durably-queued one). The two
  `/v2/issues` envelopes differ only in `created_on` (see F-2 below for why), so the backend joins them
  into one issue with `events_count` +2 rather than surfacing two issues. A path-isolation probe
  confirms both legs fire independently: deleting only the bundle-queue DB before reload left exactly 1
  upload (2341 bytes — the marker-rebuild leg alone); deleting only the marker DB left exactly 1 upload
  (4203 bytes — the durable-queue leg alone); with both present (baseline), 2 uploads. `solid-spa` and
  `webpack-sourcemaps` independently reproduced this same defect from the persist+recover side;
  `angular-spa` hit the same seam from the LOSS side (a marker `put` lost instead of the matching
  `remove`).
- **Reproduce:**
  1. `pnpm dev`, open http://localhost:5304/#/scenarios.
  2. Click "logException then hard-reload" (`s12-crash-and-reload`) exactly once.
  3. Watch network traffic (or `list_issues`/`get_issue` on `SSVELTE`) for at least 5-8 seconds after
     the reload — recovery takes a few seconds end-to-end, so a short observation window (this sample's
     own `scripts/verify.mjs` originally waited only 3s and saw NOTHING at all — not evidence of
     absence, just evidence the window was too short; fixed to 8s+quiet-wait, see the script).
  4. Two `/v2/issues` calls and two S3 PUTs appear from the one click.
- **Why this may have been missed elsewhere:** `react-spa`/`vue-spa`/`browser-vanilla`'s own S12
  checks record that "the recovered report is one of the `S*` issues... not individually re-`get_issue`'d
  per run" — none of them checked `events_count` after a SINGLE isolated click, so a duplicate would be
  invisible in their evidence (it looks identical to "the report arrived," just with an inflated count
  that nobody compared against 1).
- **Evidence:** issue `SSVELTE-111` (`events_count` +2 per ISOLATED click — see the RATE correction
  above for why a sweep run is not the same thing; it read `4` after two sweep runs, `9` after the
  re-review's five, `23` re-derived partway through the sweeps of the fixed build, then `33` and `35`
  bracketing the round-3 resume's last sweep — +2 across one run); a follow-up isolated probe
  (single click → `framenavigated` fired once → 2×`/v2/issues` + 2×S3-PUT, timestamps 1.8s/3.3s/3.6s/3.8s
  after the click, well inside one recovery pass, no second click or reload involved).

### F-2 · A marker-recovered report is timestamped at RECOVERY, not at the incident

- **Severity:** major
- **Cross-cutting:** `@bugsee/core` defect (`created_on` assembly + the `ReportMarker` shape), not
  Svelte-specific — applies to every platform that uses `recoverReports`. Found while investigating F-1
  above (the marker-rebuild leg's bundle is the one this affects).
- **Package:** `@bugsee/core` — `packages/core/src/bundle-assembler.ts:108,130` (`assembleBundle` sets
  `request.json`'s `created_on` from `context.clock.wallNow()`, evaluated at ASSEMBLY time, with no
  distinction between a live report and a recovered one) and
  `packages/core/src/report-marker-store.ts:11-20` (the `ReportMarker` shape — `generation`, `request`,
  `attributes`, `userIdentifier` — has no incident-time timestamp field at all).
- **Scenario:** S12 — the marker-rebuild recovery leg (see F-1's leg 2, `recoverReports`,
  `packages/core/src/capture-recovery.ts:41-104`).
- **Expected:** the recovered report's `created_on` reflects when the ORIGINAL incident happened (the
  marker store's own doc comment says it exists precisely so "the recovered report carries the state as
  it was", i.e. incident-time state, not next-launch state).
- **Observed:** `created_on` is stamped at whatever moment `assembleBundle` runs during recovery — i.e.
  the NEXT LAUNCH's time, not the incident's time. In the case capture recovery exists to handle (the
  process died before the bundle reached the durable queue, so the marker-rebuild leg is the ONLY
  delivery for that incident), every recovered crash is timestamped with the relaunch time, not when it
  actually happened.
- **Root cause (read from source):** `assembleBundle(request, capturedByType, context)` in
  `bundle-assembler.ts` computes `const now = context.clock.wallNow()` unconditionally and writes
  `created_on: new Date(now).toISOString()` into `request.json` (lines 108/130) — there is no branch for
  "this request came from a recovered marker, use ITS incident time instead." `ReportMarker` (the thing
  that's supposed to let recovery "carry the state as it was") snapshots `generation`, `request`,
  `attributes`, and `userIdentifier` — but never an incident timestamp — so even if `assembleBundle`
  wanted to prefer the original time, the marker doesn't carry one to prefer.
- **Reproduce:** a hard-kill probe (kill the process/tab before the bundle reaches the durable queue,
  so only the marker survives) — measured incident time `11:22:00.545Z`; the queued-bundle leg (F-1 leg
  1, when it also exists) uploads ~19ms later, correctly close to the incident; the marker-rebuild leg
  (F-1 leg 2) uploads **18,451ms** later, and that later time is exactly what lands in `created_on`.
- **Evidence:** the two code facts above, confirmed by direct read of both files; the timing gap
  measured via the hard-kill probe.

### F-3 · `console.trace` is not captured at all

- **Severity:** minor
- **Cross-cutting:** yes — `@bugsee/capture`, nothing Svelte-specific.
- **Package:** `@bugsee/capture` (`packages/capture/src/console-interceptor.ts:24-30`).
- **What happens:** `DEFAULT_LEVELS` maps exactly five console methods — `log`/`info` → `info`,
  `debug` → `debug`, `warn` → `warning`, `error` → `error`. `console.trace` is absent, so a
  `console.trace(...)` call produces no captured log entry. (Browsers render `console.trace` at warn
  level with a stack, so a reasonable mapping would be `warning`.)
- **Evidence:** the source above, plus `verify.mjs`'s `s6-console-wire`, which asserts EXPLICITLY that
  the uploaded bundle's `logs.json` carries the other five and does **not** carry a
  `S6: console.trace ...` line. Asserting six would just fail on this known gap; asserting "some
  console line arrived" would hide it. Measured absent on every sweep.
- **NOTE:** this entry existed only as a dangling reference (`scenarios.md` and `verify.mjs` both cite
  "FINDINGS.md F-3" while the file had no F-3) until round 4; the behaviour was already verified, only
  the record was missing.

### F-4 · `.bugsee-unmask` does not un-mask a value TYPED during recording — the mark is snapshot-path only

- **Severity:** minor (documentation/behaviour mismatch; it fails CLOSED, so there is no privacy risk —
  the mark under-delivers rather than over-shares)
- **Cross-cutting:** yes — `@bugsee/replay` + the rrweb fork; nothing Svelte-specific.
- **Package:** `@bugsee/replay` (`packages/replay/src/masking.ts:546`, `unmaskInputSelector:
  BUGSEE_UNMASK_INPUT`) and the fork bundle `@bugsee/rrweb` (`dist/index.js:5044`).
- **What happens:** `resolveReplayMaskingOptions` passes `unmaskInputSelector` to rrweb, and the
  SERIALIZER honours it — a value already in the field when recording starts is recorded raw. rrweb's
  LIVE INPUT OBSERVER, however, is never handed that option at all: its parameter list is
  `{ inputCb, doc, mirror, blockClass, blockSelector, ignoreClass, ignoreSelector, maskInputOptions,
  maskInputFn, sampling, userTriggeredOnInput }`, and it masks purely off `maskInputOptions`
  (`(m[tag] || m[type]) && (value = mask(...))`). So with `maskAllInputs: true`, a value the user TYPES
  into a `.bugsee-unmask` field is masked regardless of the mark.
- **Evidence:** measured on a real uploaded bundle. The `.bugsee-unmask` field was filled with the
  24-character `S11-UNMASKED-INPUT-VALUE`; the decoded `replay.bin` contains no such string and does
  contain exactly one `"text":"************************"` (24 asterisks). The same recording carries
  `"source":5` events, so the observer was live.
- **Independently CONFIRMED by `angular-spa`**, which settled the incremental-path question decisively:
  typing into only a `.bugsee-unmask` field produced exactly ONE `source:5` event,
  `{"source":5,"text":"*****************"}` for a 17-character value, absent from the whole decoded
  stream — while the full-snapshot path read that same field back verbatim in the same sweep. So the
  split really is snapshot-honours / incremental-ignores, and it lives in the rrweb fork
  (`github:bugsee/rrweb#bugsee-dist`), NOT in `packages/replay`.
- **How `verify.mjs` treats it — CORRECTED this round.** An earlier version asserted the measured
  behaviour as fact: the raw value ABSENT and the 24-star run PRESENT. That was a defensible choice
  against the alternative it was compared with (asserting the documented intent, i.e. a permanently-red
  check), but both options were wrong, because both PIN one outcome of an open defect. The day the fork
  honours the mark on the incremental path, a check titled "replay masking VERIFIED IN THE RECORDING"
  would go red and read as "masking broke" — the opposite of what happened. `angular-spa` reached the
  same conclusion from the other direction and deliberately declined to add such a check at all.
  `s11-replay-masking-wire` now requires the field's input event to be present **in either form** (the
  24-star run OR the raw value) and asserts nothing about which. That keeps it as the positive control
  that makes the password / `ignoreSelector` absences attributable, without turning this finding into a
  fixture. The raw value is also no longer asserted absent: that field is deliberately opted OUT of
  masking, so its value appearing would be the documented intent, not a leak.
- **Related, and already fixed in the sample:** the drawer's second field previously carried
  `.bugsee-show` under a comment claiming it "opts out". `.bugsee-show` maps to rrweb's
  `unblockSelector` (media/canvas un-blocking) and does nothing whatsoever for an input value, so the
  field was masked exactly like its neighbour and the sample's own documentation was wrong. It now
  carries `.bugsee-unmask`, which is the correct mark — subject to this finding.

## Resolved
