# Scenarios — samples/fastify-api

Every scenario from `docs/samples/PLAN.md` §4 (the shared catalog) and §5.14-5.20 (the
framework-backend extras), plus fastify-specific hook/plugin surfaces, the route that triggers it,
what should appear in Bugsee, and its verification status. Trigger any of them by hand
(`http://127.0.0.1:5404/scenarios/...`) or the whole sweep at once with `pnpm verify`.

Verification depths (PLAN §4): **Local** (the SDK behaved, no throw) · **Wire** (the right thing left
the process — asserted via this sample's tee transport, `src/bugsee-transport.ts`, which forwards
every SDK network call to the real staging endpoint and also records a parsed summary locally) ·
**Backend** (confirmed via the Bugsee staging MCP tools, `list_issues`/`get_issue`, against app
`SFASTIFY`).

This sample was built AFTER `samples/express-api` found (and `@bugsee/core` fixed) the wire-contract
defects that once blocked every JS report from reaching staging — see `samples/FINDINGS.md`
F-X2/F-X6/F-X10/F-X17. It never carried those workarounds. The 2026-08-27 sweep (sixth fix round,
re-run and validated end-to-end against real staging five times over) passes the FULL gate — whose
size is stated in exactly one place, the gate-count home at the end of this paragraph — and
every scenario below that can reach the backend has a
cited `SFASTIFY-N` issue. (An earlier 2026-08-23 review of a smaller 119-check gate found 103 of those
checks asserted only an HTTP status code, with just 16 asserting real SDK behaviour — several
status-only checks structurally could not fail even if the underlying feature regressed (two of them
hid a real defect in wave 1). A follow-up round brought the gate to 143 checks (40 evidence-asserting);
a second Opus re-review then found three of those 40 were still falsifiable — negative-only assertions
with no positive control, or half-asserted claims (S8.log-redaction had no positive control; S2's
"attribute set AFTER" check omitted the absence half; S5's two process-level crash rows asserted only a
hardcoded status code, never the actual report `type`) — closed by 4 additional checks (1 positive
control + 1 negative-half assertion + 2 report-`type` assertions), producing a 148-check gate — which
this file then mis-stated as **147**, an off-by-one a third re-review caught by counting the gate's own
output. That round also found evidence the sample PRODUCED and no check READ, two instances of which
this file was meanwhile citing AS evidence: the S4 dedupe row cited the route's `{r1:{ok:true},
r2:{ok:false}}` response and the S8 network-filter row cited `filterInvoked: true`, while `pnpm verify`
asserted only HTTP 200 on both; separately the three crash-child checks read only the child's exit
code, never the stdout `runChild` already returns, so a child that died BEFORE `launch()` would have
read green. Closed by 2 added checks (the dedupe `UploadResult` pair; the filter-invoked flag) and by
strengthening the 3 crash-child checks in place to require the post-`launch()` ready line and each
mode's own still-alive line alongside the exit code. The VALIDATION re-run of that 150-check gate then
caught what adding those checks had done: the new dedupe check inherited `S4.dedupe`'s flat 10s
client-side budget, the route aborted at it again — with the SDK provably correct, since the same
scenario's independent "exactly ONE bundle" wire check passed — and a client-side budget that used to
cost one status row was now failing a gate check. Closed by giving that route a budget derived from the
work it requests (the S1.flush rule, F-X19) and by recording every route's MEASURED wall-clock `ms`, so
the next such decision is made from data; see the S4 dedupe row. A FOURTH re-review, which independently
reproduced that 150/150 gate, found the same "evidence produced but never read" class in four more
places — three of them rows this file was again citing as verified: the adapter-alone route-naming
check asserted FASTIFY's own `req.routeOptions.url` (a value `@bugsee/fastify` only reads, so the check
was invariant under every Bugsee route-naming regression) while discarding the SDK's own transaction
name, leaving that path with no route-naming verification at any depth; `S1.flush`'s returned boolean
was unread; and `S7.4xx`/`S7.5xx` asserted only the app's own hardcoded 200, never the third party's
404/500. It also found the `DEDUPE_TIMEOUT_MS` justification factually wrong in both directions and
measured the sensitivity that budget was costing. Closed by 5 added checks (the SDK's own
`transactionNames`, with `routePattern` demoted to a labelled precondition; a `flush()` invariant that a
`false` answer means the bound was actually spent; an upper bound on `S4.dedupe`'s measured `ms`; the
two third-party statuses) plus a corrected budget justification, a corrected `Result.ms` doc comment,
and a corrected stale-bundle scoping enumeration in `verify.ts`. A FIFTH re-review then added five
more checks (bringing the gate to 161), and a SIXTH — which reproduced 161/161 across three sweeps and
found **zero falsifiability defects among all 161**, the first round to find none — reported five
documentation-level defects instead, four of which are about numbers kept in more than one place. Its
one substantive gap was a defect-class sweep that had stopped at the rows the previous reviewer named:
`S7.fetch-get`/`fetch-post-json`/`fetch-post-text` still asserted the app's own hardcoded 200 while
this file claimed the third party's response was read, and the cross-cutting `api.stats` aggregation
and file-store "survives a restart" rows claimed outcomes nothing performed or asserted. Round 6 closed
those (the three third-party statuses plus the two parsed JSON bodies, all five `api.stats`
aggregates, and a genuine restart: a series written into `data/db.json` BEFORE the server process
exists, plus the on-disk write-through of what the run ingested) and closed the S1.flush `true`-branch
residual entirely inside `scripts/verify.ts`, whose stated blocker ("it would need a route change")
did not hold.

A SEVENTH review ran three sweeps, found **zero falsifiability defects among round 6's eight new
checks** — it verified each one, plus the seeded-restart check, the `Result.ms` invariant and every
other class sweep — and reported seven findings, one of them a genuine **REGRESSION round 6 had
introduced**. Round 6's restart seed made `writeFileSync(data/db.json)` the FIRST writer of that path,
ahead of the `MetricsStore.save()` (`src/store.ts:48`) that used to create the directory as a side
effect of the first ingest. `data/` is a gitignored run artefact, so on a fresh clone it does not
exist, and the seed threw `ENOENT` before the server was ever spawned: **`pnpm verify` could not run at
all on a clean checkout.** Before round 6 the harness had been ACCIDENTALLY safe — nothing had ever
depended on the seed's ordering because there had been no seed. The fix is one `mkdirSync`, and it was
verified the only way that counts: by deleting `data/` and running the whole sweep, not by reasoning
about it. The belief that produced the regression was written down in `README.md`, which claimed
`data/db.json` was "gitignored via the parent `.gitignore` pattern but tracked here as evidence" — all
three clauses false, and the third backwards (`express-api` ignores its `data/`). This sample now
ignores `data/` the same way and the README says so.

The other six findings were closed as follows. `S2.clear-attributes` was a negative pair with no
positive control anywhere in the gate — a `getAttribute()` stubbed to `undefined` and a
`getAllAttributes()` stubbed to `{}` satisfied both — while the positive readings the route already
returned were being discarded; they are now asserted. PLAN §4 S2's `clearUserIdentifier` was neither
exercised nor recorded N/A, and is now genuinely exercised, via a route appended BELOW the file's last
reporting site so that no fingerprint moved (see the escape hatch documented under the fingerprinting
note). The pagination half of the "Pagination + per-metric aggregation" row was claim-without-assertion
— round 6 had closed only the aggregation half of that same row — and is now asserted at three points
including both of `parsePagination`'s clamp arms. Two more duplicated-number homes were collapsed: the
S4.dedupe budget record (whose row had said "this row deliberately does NOT restate that record" for
two rounds while restating it) and a copy of the gate count that had settled into `scripts/verify.ts`.
And the F-R6-5 flush check gained a measured note on its own sampling skew.

==> **THE GATE-COUNT HOME. These three numbers appear ONCE in this sample — here.** As of the seventh
fix round the gate is **180 checks**, passing **180/180** on each of THREE sweeps against real staging.
The FIRST of those three was run with `data/` DELETED beforehand — that is what proves the round's
`ENOENT` regression fix, and no sweep that inherits a `data/` from a previous run can prove it. Every
edit made after the third sweep was comment or prose, never executed code, and `list_issues(SFASTIFY)`
was re-checked after the third sweep and still reported 58: **73 assert on evidence** — bundle/report content, network/log/breadcrumb payloads,
response-body fields, `UploadResult`s, transaction names, measured durations, child stdout, context
ids, trace-id formats, report `type`, third-party statuses, store aggregates, on-disk persistence —
and **107 assert an HTTP status code**. Anything elsewhere that needs the size of the gate points here
instead of repeating it. **Re-derive all three from the sweep's OWN output, never by counting rows in
this file:** `pnpm verify`'s last line prints `N/N local checks passed`, and after a run
`node -e "const r=require('./data/verify-run.json').results,w=r.filter(x=>x.id.startsWith('wire:')).length;console.log('total',r.length,'evidence',w,'status',r.length-w)"`
splits the two classes. That is the discipline every previous round skipped: round 4 updated its five
new rows and left this paragraph saying 156 while the gate was 161, and the round before it said 147
while the gate was 148. Both were caught by counting the gate's own output, which is why that is the
instruction rather than a suggestion.)

**A lesson for the next author, learned the hard way in this fix round:** Bugsee fingerprints an
issue on `file:line` (plus its message/type). Every `logException`/throw call site in
`src/routes/scenarios.ts` mints its OWN issue at the line it currently sits on. Editing this file for
ANY reason — fixing a bug, adding a scenario, even just reordering routes — shifts every later line
number, and the next `pnpm verify` run mints a FRESH issue at each shifted line instead of reusing the
old one. Concretely: a prior edit to `scenarios.ts` shifted its lines, and the sweep afterward reported
51 `SFASTIFY` issues (`SFASTIFY-1` through `SFASTIFY-51`), not the 27 this file used to cite — 23 of
those 27 keys had gone stale (pointing at pre-edit line numbers that no longer produce anything), while
only `SFASTIFY-1` (fingerprinted on Fastify's own internal `context.js`, never edited here) and
`SFASTIFY-27` (fingerprinted on `scripts/crash-child.ts`, a separate untouched file) still held.
**Whenever `src/routes/scenarios.ts` (or any script with its own `logException`/throw call sites) is
edited, every `SFASTIFY-N` key cited anywhere in this repo (`FINDINGS.md`, this file, `README.md`) must
be re-derived** — via `list_issues(SFASTIFY)` + `get_issue` matched against the file:line and
`Reason/message` marker of the CURRENT code — before trusting any citation, and total-issue-count
claims ("N issues", "the full SFASTIFY list") must be updated too, since the stale duplicates never go
away. (The hazard has now demonstrated itself THREE times, live. Second time: documenting
`scripts/adapter-alone-child.ts` + `scripts/sample-rate-child.ts`'s control-linkage — see below —
added a comment ABOVE `sample-rate-child.ts`'s one `logException` call, which shifted that call from
line 54 to line 68 and minted `SFASTIFY-52`, leaving `SFASTIFY-51` stale. Third time: the previous fix
round added ~6 lines to `src/routes/scenarios.ts`, shifting four later call sites and re-minting four
issues at the new fingerprints — `SFASTIFY-46`→**`-55`** (`:418`→`:424`, s8-network-filter),
`-47`→**`-56`** (`:518`→`:524`, s14-custom-handler-throw), `-48`→**`-57`** (`:530`→`:536`,
status/5xx-thrown), `-49`→**`-58`** (`:482`→`:488`, concurrency) — plus a further comment above
`sample-rate-child.ts`'s call shifted it `:68`→`:70`, minting `-53` over `-52`. Every key cited in this
repo was re-derived against `list_issues` AFTER the last source edit of that round, which is the only
ordering that produces a citation worth trusting. ==> **THE ISSUE-COUNT HOME. This number appears ONCE
in this sample — here.** `list_issues(SFASTIFY)` reports a total of **58** issues (highest key
`SFASTIFY-58`), re-confirmed before AND after every sweep of the sixth and seventh fix rounds. (How
many sweeps each round ran is not restated here — that belongs to the gate-count home above.) Round 6
edited no fingerprint-sensitive file at all (only `scripts/verify.ts` and the docs). Round 7 DID edit
`src/routes/scenarios.ts`, appending the `/s2/user-identifier` route strictly BELOW the file's last
reporting site, and the total still did not move — which is the empirical confirmation of the escape
hatch described below, not merely an argument for it. It includes every stale pre-shift duplicate, which never goes away. It had six homes before the sixth fix round (this note plus the
report-veto and 4xx-not-reported rows below, two places in `FINDINGS.md`, and `README.md`'s coverage
summary) — all six happened to be correct at the time, which is precisely when to collapse them, since
the next `scenarios.ts` edit invalidates all six at once and the ones nobody remembers to update become
the citations that lie. Everywhere else now points here. `SFASTIFY-54` is not a scenario at all — it is an `EADDRINUSE` crash at
`Server.setupListenHandle`, minted mid-validation when a `pkill`'d server had not released port 5404
before the "fresh" one tried to bind. Confirm `lsof -nP -iTCP:<port> -sTCP:LISTEN` is empty AND that
the listener you then measure is the process you just started; `lsof -ti :<port>` is the wrong syntax
and silently reports nothing.)

**Which files are fingerprint-sensitive, and the reason that actually holds (2026-08-27).** Only a call
site whose throw/`logException` REACHES the reporter mints an issue, so only those files shift keys when
edited. In this sample that is: `src/routes/scenarios.ts` (27 reporting sites — the recommended grep returns 32
lines; FOUR are comments, `:170`, `:212` and the two in the appended `clearUserIdentifier` note at
`:555`/`:557`, and of the 28 code hits `:29` is the `client()` helper's own guard, which can only fire
when there is no client to report with and therefore mints nothing. This arithmetic was off by one for
several rounds — "29 lines" never reconciled with "27 sites" because `:29` was silently dropped without
being named), `scripts/crash-child.ts:31` **and `:43`**,
`scripts/sample-rate-child.ts:70`, and `src/bugsee.ts:27` (a launch-time guard that aborts before the
client exists, so in practice it mints nothing). `crash-child.ts:43` — `void Promise.reject(new
Error(...))`, the unhandled-rejection scenarios' source — was MISSING from this enumeration until the
sixth fix round, and missing for a reason worth naming: the grep this file recommended could not see
it (fixed below). Empirically it mints nothing today — no `crash-child.ts:43` key exists among the 58,
because both rejection modes exit before the upload lands ('warn' at its own 1000 ms timer, 'none' on
Node's default crash) — but that is an accident of timing, not a property of the call site, so it is
listed as fingerprint-sensitive rather than as safe. Everything else is safe to edit freely —
`scripts/verify.ts` (the harness runs out-of-process from the app and reports nothing),
`src/plugins/metrics.ts`, `src/store.ts`, `src/auth.ts`, `src/third-party.ts`, and the docs.
`src/bugsee-transport.ts` is on the safe list too, but NOT for the reason given in an earlier round —
"it has no throw sites" is simply false: `:257` throws the normalized timeout error. It is safe because
that throw is consumed by the SDK's own upload pipeline (`packages/core/src/upload-pipeline.ts`), which
turns it into a retry/`{ok:false}` decision; it never travels back out as a `logException`, so it never
fingerprints an issue. Verify the claim, don't infer it — and use a grep that can actually SEE every
site: `grep -nE 'logException|throw |Promise\.reject|reject\(' <file>`, then ask whether each hit can
reach the reporter. The narrower `grep -n 'logException\|throw '` this file recommended for five rounds
misses `Promise.reject(new Error(...))` entirely, which is exactly how `scripts/crash-child.ts:43`
stayed out of the enumeration above while the conclusion drawn from that grep was still being reported
as verified. An unhandled rejection reaches the reporter by a path with no `throw` keyword in it, so
any recipe that keys on the keyword under-reports; treat the grep as a candidate list, never as the
answer.

**The escape hatch, discovered in the seventh fix round and worth knowing before you accept an N/A.**
The LAST reporting site in `src/routes/scenarios.ts` is `:538` (`throw err` in `/status/5xx-thrown`).
Everything below it — the `_debug` surface and the `/s2/user-identifier` route appended there — never
reaches the reporter, so **a new route added strictly BELOW `:538` shifts no line that mints anything
and changes no `SFASTIFY` key.** That is how PLAN §4 S2's `clearUserIdentifier` gap was closed with a
real exercised route instead of an N/A, on a round whose brief was to leave the issue total at 58; the
total was confirmed unchanged afterwards. The cost is that the route sits far from its siblings, which
is why it carries a comment saying so. Anyone tidying it back into the S2 block pays a fresh set of
keys for the cosmetic win.

## S1 — Launch & lifecycle

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| S1 status | `GET /scenarios/s1/status` | `isLaunched()` true | **Local** — verified: `pnpm verify` asserts `isLaunched === true` on the response body. For four rounds it asserted only the route's hardcoded 200 while this row claimed the boolean — `isLaunched()` regressing to `false` would have read green (`grep -n isLaunched scripts/verify.ts` returned nothing). Same class as the `flush()` boolean / `r1`/`r2` / `filterInvoked` / `transactionNames` fixes, and the odd one out in its own table, since the sibling relaunch row already read `sameInstance` off the body. `waitForHealth()` now reads the same field off `/health` too, so an unlaunched client fails at startup where it can be diagnosed, not ten checks later |
| S1 flush | `POST /scenarios/s1/flush` | `flush(timeout)` resolves, and a `false` answer means the bound was actually spent | **Local** — verified. Returns `true` at low load (isolated re-run); `false` for the full sweep's ~100-bundle backlog within the 15s budget requested — the bundles all drained anyway (the tee's bundle count went stable during the post-flush drain wait, and the downstream `concurrency isolation: 50/50 bundles arrived` check reads that settled list), same throughput profile `samples/express-api` documented, not a new finding. As of this fix round `pnpm verify` READS the boolean instead of asserting only the hardcoded 200 (a `flush()` regressed to a no-op returning `false` in 0 ms would previously have left the gate green). What it asserts is deliberately NOT `flushed === true`: the flush is placed LAST on purpose, after S4.storm and the 50-way concurrency batch, so it meets a real backlog — `false` against the 15000 ms bound is the honest, every-sweep-on-record outcome of `drainPending` (`packages/core/src/client.ts:440-447`) racing the drain against `sleep(timeout)`, and moving the flush somewhere quiet to make `true` assertable would stop exercising the case that matters (does the SDK honour its bound under load?). **The measured `flushMs` values live in ONE place — the observation record inside this check's own comment in `scripts/verify.ts`, which carries an explicit append instruction.** This row used to restate them and drifted: it said "three-times-reproduced" while `scripts/verify.ts` said "two independent sweeps" in one comment and quoted a differing pair in another — all three describing the SAME two runs — and the round-6 review's own three sweeps then measured values outside every one of those retellings, two of them fractionally BELOW the bound (absorbed by design by the check's 500 ms slack). No number from that record is repeated here: read it where it lives, and append to it there, rather than paraphrasing it into a fourth home. The asserted invariant is the one a no-op violates: `flushed === true`, OR `flushed === false` AND the flush spent the full bound. **That duration is now the flush's OWN measured time** (`flushMs`, timed by the route around the `await client().flush(...)` call) rather than `pnpm verify`'s wall clock for the whole HTTP round trip. The round trip is only an UPPER bound on the flush, so a no-op returning `false` in 0 ms satisfied the old form whenever >= 14.5 s of delay landed anywhere else in the request — and this check runs deliberately at peak load, right after the storm and the 50-way concurrency batch, which is exactly when such delay is available. Guarding a no-op flush is the entire reason the check exists, so it reads the right quantity now. **Residual — CLOSED in the sixth fix round, and the stated blocker was wrong:** the `true` branch used to be accepted unconditionally with nothing guarding it — an early note here and in `scripts/verify.ts` claimed "the post-flush polling loop independently proves the bundles do all arrive", which is false (that loop asserts nothing, and the `50/50 bundles arrived` check runs after the drain wait and would pass whether or not `flush()` was ever called), and the replacement excuse — "closing it needs the ROUTE to report the pending-bundle count, which this round does not touch" — did not hold: `scripts/verify.ts` is fingerprint-SAFE by this file's own table above, and the tee already publishes that count over `/scenarios/_debug/bundles`. `pnpm verify` now samples the bundle count immediately after the flush returns and again once the drain loop has settled, and asserts the implication `flushed === true` ⇒ the settled count did not grow — a `true` that skipped the drain leaves the ~100-bundle backlog for the drain loop, which shows up as growth. Every full sweep on record still returns `false`, so this guard is written to be correct rather than to be exercised, and that is stated rather than hidden |
| S1 relaunch no-op | `POST /scenarios/s1/relaunch-noop` | a second `launch()` on the SAME carrier returns the SAME client instance | **Local** — verified: `pnpm verify` asserts `sameInstance === true` on the response body (not just the HTTP status) |
| minimum options | `scripts/crash-child.ts` / `scripts/adapter-alone-child.ts` launches | launches with a small option set | **Local** — verified (both child processes boot and report) |
| every option set | `src/bugsee.ts` launch (the main app) | every relevant `BugseeLaunchOptions` field set | **Local** — verified (server boots; see `src/bugsee.ts` — captureLogs/Network/(Body)/propagateTrace/tracePropagationTargets/traceResponse/detectCrashes/detectHangs+thresholds/profiling/maxRecordingTime/maxDataSize/capturedDataStore/captureWriter/recover/exitOnUncaught/unhandledRejections/instrumentIncomingRequests/performanceMonitoring+SampleRate+FlushIntervalMs/onError/transport) |

## S2 — Identity & attributes

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| S2 identity+attributes | `POST /scenarios/s2/identity-attributes` | `setUserIdentifier`; every `AttributeValue` type (string/number/boolean/string[]) set BEFORE the first `logException`, one more set AFTER, before a second `logException` | **Backend + Wire** — `SFASTIFY-5` (before) shows `str_attr/num_attr/bool_attr/arr_attr` via `get_issue(include_attributes:true)`; `SFASTIFY-4` (after) additionally shows `after_attr`, absent from `SFASTIFY-5`. `pnpm verify`'s own wireCheck gate independently asserts BOTH halves of this claim on the raw bundles: `after_attr` present on the after-bundle AND (added in this fix round) `after_attr` ABSENT from the before-bundle — the negative half is what actually distinguishes "attributes snapshot at submit time" from "attributes snapshot at upload time" (the bug commit `f17baa8` fixed); asserting only the positive half could not have caught that regression. **As of the seventh fix round the four readings this route ALREADY returned are read too** — `beforeSnapshot`, `afterSnapshot`, `getAttribute_num_attr` and `userIdentifier` were produced by the route and thrown away by the sweep. They are the POSITIVE CONTROL the S2 clear-attributes row below needs: that row is a negative pair, and the wire checks above read `manifest.attrs` (what the SDK put in the bundle), a DIFFERENT path from what the getters answer in-process, so nothing in the gate asserted either getter returning a value. Now asserted: `getAllAttributes()` returns all four types with their exact values and exactly four keys before the first event, gains `after_attr` (and only that) in the second snapshot, `getAttribute('num_attr')` returns `42`, and `getUserIdentifier()` returns the launch-time identity |
| S2 clear attributes | `POST /scenarios/s2/clear-attributes` | `clearAttribute`/`clearAllAttributes` | **Local** — verified: `pnpm verify` asserts `afterClearOne === null` and `afterClearAll` is an empty object on the response body. **These two are a NEGATIVE PAIR and were unpaired for six rounds:** a `getAttribute()` regressed to always return `undefined` and a `getAllAttributes()` regressed to always return `{}` satisfy BOTH. The positive control now lives on the row above (added in the seventh fix round) and this row is only sound read together with it — the same pairing discipline `scripts/verify.ts` states for the S1.flush residual ("the negative check alone would pass vacuously"). (The route sends `afterClearOne` as `null` on the wire — `getAttribute()` itself still returns `undefined`, but `JSON.stringify` silently DROPS an `undefined`-valued key, which made the claim unverifiable over HTTP; fixed by substituting `null` at the response boundary only) |
| S2 user identifier (clear) | `POST /scenarios/s2/user-identifier` | `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier` — PLAN §4 S2's third call, which was neither exercised nor recorded N/A before the seventh fix round | **Local** — verified as a full transition rather than a single reading: `initial` is the launch-time identity, `afterSet` the temporary one, `afterClear` `null`, `restored` the launch-time identity again. A getter stubbed to always return `null` passes the clear half and fails `afterSet`; a `clearUserIdentifier()` regressed to a no-op fails the clear half. The route RESTORES the identity before replying — it is process-global, so leaving it cleared would strip the user off every later report in the sweep, and `restored` is what asserts it did. **The route sits at the very BOTTOM of `src/routes/scenarios.ts`, below the last throw, on purpose** — see the fingerprinting note above: inserting it beside its S2 siblings would have shifted every later `logException`/throw line and re-minted the whole `SFASTIFY` set. It changed no fingerprint and minted nothing; the issue total was unchanged across this round's sweeps. (`browser-vanilla` and `react-spa` already covered this call; `express-api` and `node-service` still share the gap this closes) |

## S3 — Manual telemetry

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| S3 telemetry | `POST /scenarios/s3/telemetry` | `log()` at every `LogLevel`; `event()` with/without params; `trace()`; `addBreadcrumb()` with every field; a trailing `logException` to attach them | **Backend + Wire** — `SFASTIFY-28` confirms the report arrived; `pnpm verify`'s own wireCheck gate (not just a manual re-run) asserts the bundle's `logs.json` carries all 5 log lines, one per `LogLevel`. `get_issue(include_logs)` itself shows NO `# Logs` section on this or any issue in this sweep — reproduces the cross-cutting `samples/FINDINGS.md` F-X4 gap; see `FINDINGS.md` here for the corroborating evidence this sample adds |

## S4 — Exceptions

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| error instance | `POST /scenarios/s4/error-instance` | `logException(new Error)` | **Backend** — verified, `SFASTIFY-31` |
| non-Error | `POST /scenarios/s4/non-error` | a string, an object, and `null` all accepted without throwing | **Backend** — verified: `SFASTIFY-29` (`Type: Handled String`), `SFASTIFY-30` (`Handled Object`), `SFASTIFY-32` (`Handled Null`) — all three typed correctly on the backend |
| cause chain | `POST /scenarios/s4/cause` | nested `cause` | **Backend** — verified, `SFASTIFY-34`: a `Cause:` section with its own stack trace is present |
| options | `POST /scenarios/s4/options` | `mechanism`/`severity`/`labels` | **Backend** — verified, `SFASTIFY-33`, `severity: Critical` (matches the `severity:'critical'` option passed) |
| dedupe | `POST /scenarios/s4/dedupe` | the SAME `Error` instance logged twice produces exactly ONE upload | **Backend + Wire** — verified. Local response `{r1:{ok:true,…}, r2:{ok:false}}` proves the SDK's own dedup check (`checkOrSetAlreadyCaught` in `packages/core/src/client.ts` returns `{ok:false}` for a re-capture of the same thrown object) — and as of this fix round `pnpm verify` ASSERTS that pair rather than merely citing it; the wire check confirms exactly 1 bundle for the 2 calls (the same claim from the other end — together they separate "deduped" from "the second upload silently failed"); `SFASTIFY-35` exists with `events_count` matching one event per sweep run (not two). **Budget history (this route now carries its OWN client-side budget):** it awaits two full `logException()` round trips to real staging, so it asks the SDK for TIMED work — the F-X19 shape, where a client-side budget shorter than the requested work reads a correctly-working SDK as a failure. It was nevertheless left on the flat `DEFAULT_HIT_TIMEOUT_MS` (10s) for two rounds, on the reasoning that a single observation was too thin to tune on. That reasoning was falsified twice over: the abort REPRODUCED on the 2026-08-26 validation run (again with the same scenario's wire check — "exactly ONE bundle" — passing, i.e. the SDK deduplicated correctly and only the client budget was exceeded), and the blast radius had meanwhile changed, because the `r1`/`r2` evidence check added in the previous round meant the flat budget now failed a GATE check rather than one status row. The budget is therefore derived from what the route REQUESTS, exactly as `S1.flush`'s is: `2 x 30s + 5s` (`DEDUPE_TIMEOUT_MS`). **The arithmetic was right; the justification printed alongside it for two rounds — "two uploads, each bounded by the tee transport's own 30s" — was wrong in both directions and has been restated in the code.** It is ONE report on the wire, not two (the second `logException` short-circuits in `checkOrSetAlreadyCaught`, `packages/core/src/client.ts:636-638`, and returns before `submitReport` at `:674` — exactly what the `r1`/`r2` check asserts). But one report is AT LEAST two 30s-bounded transport calls, not one: the issue create (`packages/core/src/bugsee-api.ts:81-85`) and the signed bundle PUT (`packages/core/src/bundle-uploader.ts:21-36`), each retried up to 3x with backoff INSIDE the same awaited promise (`packages/core/src/upload-pipeline.ts:35,96,155`). So `2 x 30s + 5s` is a floor on the serial worst case, not a ceiling. **The sensitivity that a budget this loose gives up is now bought back explicitly:** every healthy observation sat far below the abort budget, so a multi-fold regression would have passed in silence, and `pnpm verify` therefore ASSERTS an upper bound on the recorded `ms`. **That ceiling was first fitted at "~2x observed" from three consecutive runs, and the very next independent run — the 2026-08-27 round-4 re-review — escaped the cited range**, leaving under 2x of margin on a provably-correct SDK, i.e. one more slower run away from turning a healthy sweep red (the F-X19 shape this route has already hit twice). It was refitted and is treated explicitly as a TRIPWIRE that must be re-fitted as observations accumulate. **The ceiling's current value AND the running record of observations have exactly ONE home — the check's own comment in `scripts/verify.ts`** — and that record must be appended to, never trimmed. **This row deliberately does NOT restate that record — and the last TWO rounds each said exactly that sentence while still restating it.** Round 5's copy listed six observations under a "2.23x swing, 2.1x the current worst" gloss that later sweeps had already invalidated. Round 6 deleted the gloss, wrote "this row deliberately does NOT restate that record", and left four observations and both ceiling fits sitting in the very same sentence. Every number of that class is now actually gone from this row. They happened to be ACCURATE at the moment they were finally removed, which by this file's own argument about the issue-count home is precisely when to collapse a duplicate: a second copy is never dangerous while it is right, it is dangerous because the round that changes the value updates one home and forgets the other. The reasoning behind the number is what belongs here, and it does not go stale: the ceiling must clear the SPREAD of healthy runs, not any single run's cost, which is exactly what a fit derived from three consecutive samples got wrong. That is deliberately a DIAGNOSIS rather than a shorter abort: the request still runs to 65s and completes, so a slowdown is reported as "it worked, far slower than it should" instead of an opaque abort with no body. This does not blind the sweep to a real hang — an upload that never returns still trips the transport's 30s bound — and `pnpm verify` now records each route's MEASURED wall-clock cost (`ms`, in `data/verify-run.json` and the results table, on aborted requests too), so the next budget decision is made from data rather than from a guess. That measurement immediately paid: with the new budget the route completed instead of aborting, and its recorded `ms` showed it genuinely needs more than the flat 10s it had been given — the abort was the harness under-budgeting a correct SDK, exactly as the wire check implied. A `status: -1` with an abort message in the results table is a budget abort, not a dedupe failure. See the check's own comment in `scripts/verify.ts` |
| storm (200) | `POST /scenarios/s4/storm` | 200 rapid `logException` calls; app stays responsive, no crash | **Backend** — verified: responsiveness is now MEASURED, not asserted — the route times a `setImmediate` round trip taken immediately after the storm loop (if the loop had blocked the event loop this would take far longer than a few ms) and `pnpm verify` asserts `stillResponsive === true` (`responsivenessMs` printed in the check label) on that real measurement; `SFASTIFY-50` (`events_count` growing across every sweep run, never all 200 — see the check's own note) shows the SDK's own 100-per-60s capture rate limiter admitting a bounded subset rather than dropping the whole burst silently or crashing — same throughput profile as `samples/express-api`'s finding, not new |

## S5 — Crashes

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| route throw | `GET /scenarios/s5/route-throw` | sync throw in a handler → `onError` reports it, mechanism `http-error` | **Backend** — verified, `SFASTIFY-36` |
| hook throw (preHandler, before the route) | `GET /scenarios/s5/hook-throw` | a `preHandler` hook throws BEFORE the route handler below it runs | **Backend** — verified, `SFASTIFY-37` (`Object.preHandler`, the route's own `{unreachable:true}` body never sent) |
| async handler throw | `GET /scenarios/s5/async-throw` | Fastify awaits an async handler and forwards a rejection to `onError` automatically | **Backend** — verified, `SFASTIFY-38` |
| async **plugin** throw | `GET /scenarios/nested/s5/async-plugin-throw` | an async route registered inside a NESTED, separately-encapsulated plugin still reports correctly | **Backend** — verified, `SFASTIFY-39` |
| timeout throw (outside request context) | `POST /scenarios/s5/timeout-throw` | a `setTimeout` throw becomes a process-level `uncaughtException`, caught by `detectCrashes`, NOT by Fastify's `onError` | **Backend + Wire** — verified. `SFASTIFY-42`, `type: "crash"` (not `"error"` — confirms the crash path, not the http-error path). `pnpm verify`'s own wireCheck gate now asserts this directly on the uploaded bundle's `request.json` `type` field too, not just the hardcoded 202 the route always returns regardless of whether anything was ever reported — a regression where `detectCrashes` stopped hooking `uncaughtException` would still return 202 here and previously left this check green |
| unhandled promise rejection | `POST /scenarios/s5/unhandled-rejection` | a fire-and-forget `Promise.reject` → `unhandledRejections: 'warn'` captures + keeps the process alive | **Backend + Wire** — verified. `SFASTIFY-40`, `type: "error"` (not crash — `'warn'` mode), 202 response, server stays up for the rest of the sweep. `pnpm verify`'s own wireCheck gate now asserts `type === "error"` on the uploaded bundle directly, same discipline as the row above |
| `exitOnUncaught: true` | `scripts/crash-child.ts uncaught-exit` (disposable process) | process exits non-zero after flushing the crash report | **Backend** — verified. `SFASTIFY-27`, `type: "crash"`; `pnpm verify` asserts the non-zero exit code AND (added this fix round) that the child printed its post-`launch()` `crash-child ready mode=uncaught-exit marker=<run marker>` line first — without that, a child that died BEFORE `launch()` ever ran (bad token, missing `.env`, import error) also exits non-zero and read green |
| `exitOnUncaught: false` | `scripts/crash-child.ts uncaught-no-exit` | process reports the exception then stays alive | **Local** — verified (self-exits at its OWN bounding timer, code 7, proving it did NOT exit on its own from the exception). `pnpm verify` now requires all three signals together: the post-`launch()` ready line, the `still alive after uncaught exception` line, and exit code 7 |
| `unhandledRejections: 'warn'` | `scripts/crash-child.ts rejection-warn` | captures + prints, stays alive (vs `'preserve'`'s default exit) | **Local** — verified (process survives past where an exit would have happened, self-exits at code 42 on its own timer). `pnpm verify` now requires the post-`launch()` ready line and the `still alive after warn-mode rejection` line alongside exit code 42 |
| `unhandledRejections: 'none'` | `scripts/crash-child.ts rejection-none` (available, not wired into `pnpm verify`'s summary table) | no listener installed, Node's own default applies | **Local only** — script supports the mode; not asserted in the automated table (mirrors `express-api`'s same choice) |

## S6 — Console capture

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| console | `POST /scenarios/s6/console` | `log/info/warn/error/debug/trace`, a multi-arg call, an object, and a circular object | **Backend + Wire** — `SFASTIFY-41` confirms delivery; `pnpm verify`'s own wireCheck gate asserts the bundle's `logs.json` contains all 6 entries plus the circular-object line with no crash from the circular reference. `get_issue` itself shows no `# Logs` section (same F-X4 gap as S3) |

## S7 — Network capture

All outbound calls go to the in-process, deliberately NOT-Bugsee-instrumented "third-party" mock
service (`src/third-party.ts`, port 5405) so the interceptor's effect is isolated. Network entries are
never exposed via MCP (PLAN §6.6) — every row below is Local (app behavior unaffected) + Wire
(`network.json` presence in the bundle), never Backend.

Both Wire checks here read network entries out of bundles NARROWED TO THIS RUN first (a bundle is this
run's iff its own summary or `http.url` carries the run marker). Added in the third fix round: the
third-party URLs these entries carry (`thirdPartyUrl('/large')`, `/echo-headers`) contain no run
marker and cannot be given one — `isThirdPartyPath` compares `new URL(raw).pathname` — so with
`recover: true` + on-disk capture, a PRIOR run's recovered bundle contributed its own `/large` entry to
the same array. The bundle, not the URL, is the anchor that scopes them.

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| fetch GET | `GET /scenarios/s7/fetch-get` | 200 from the third party, its JSON body read correctly by the app | **Local** — verified: as of the sixth fix round `scripts/verify.ts` asserts the route body's `thirdPartyStatus === 200` AND the parsed `thirdPartyBody.ok === true`, not the app's own hardcoded 200. For six rounds it asserted only that hardcoded 200 while this row claimed "body read correctly by the app" — `/ok` regressing to a 4xx, or the fetch never reaching the third party, would have read green (`grep thirdPartyBody scripts/verify.ts` returned nothing). Same class as the 4xx/5xx/connection-failure/large-body/no-content-type fixes, which this row was left out of because the previous round's sweep stopped at the rows the reviewer had named |
| fetch POST JSON | `POST /scenarios/s7/fetch-post-json` | the JSON body is POSTed, the third party answers 200, the app parses its JSON reply | **Local** — verified: `scripts/verify.ts` asserts `thirdPartyStatus === 200` and `thirdPartyBody.ok === true`. **Claim downgraded, deliberately:** this row used to say "JSON body round-trips", which this sample cannot support — `src/third-party.ts`'s `/ok` (`:51-54`) IGNORES the request body and answers `{ok:true, receivedAt}` to every method, so nothing the app can observe proves the POSTed body arrived. Making the stronger claim assertable would mean echoing the body from `/ok` *and* widening the route's `reply.send` in the fingerprint-sensitive `src/routes/scenarios.ts`; the claim was cut to fit the evidence instead |
| fetch POST text | `POST /scenarios/s7/fetch-post-text` | the text body is POSTed, the third party answers 200 | **Local** — verified: `scripts/verify.ts` asserts `thirdPartyStatus === 200`. Same downgrade as the row above ("text body round-trips" was unsupportable for the same reason), and one step weaker still: this route returns only the status, no `thirdPartyBody`, so the status is the whole of the available evidence |
| 4xx | `GET /scenarios/s7/4xx` | 404 from the third party, app reads it fine | **Local** — verified: as of this fix round `scripts/verify.ts` asserts the route body's `thirdPartyStatus === 404` and `ok === false`, not just the app's own hardcoded 200. Honest residual: `src/third-party.ts`'s catch-all also answers 404, so DELETING `/not-found` is indistinguishable from it working; a 4xx silently becoming a 2xx, or the fetch never reaching the third party, is caught |
| 5xx | `GET /scenarios/s7/5xx` | 500 from the third party, app reads it fine | **Local** — verified: `scripts/verify.ts` asserts `thirdPartyStatus === 500` and `ok === false` on the response body (previously only the app's own 200 was asserted, so `/boom` regressing — or being deleted and falling through the catch-all 404 — read green). No catch-all ambiguity here: the catch-all's 404 is not a 500 |
| connection failure | `GET /scenarios/s7/connection-failure` | `fetch` to `127.0.0.1:1` rejects; the app's own try/catch still works | **Local** — verified: `scripts/verify.ts` asserts `failed: true` and a non-empty `error` message on the response body (not just the HTTP status) |
| body over `maxNetworkBodySize` | `GET /scenarios/s7/large-body` | a 20000-byte response (limit configured at 4096) still reads correctly in the app | **Local + Wire** — verified: `scripts/verify.ts` asserts `bodyLength === 20000` on the response body (full body reached the app), AND asserts the CAPTURED copy in `network.json` carries `no_body_reason: "size_too_large"` (the capture-only truncation, proven separately from the app-visible body) |
| no Content-Type | `GET /scenarios/s7/no-content-type` | response with no `content-type` header still reads correctly | **Local** — verified: `scripts/verify.ts` asserts `contentType === null` and the exact response text, not just a 200 |
| XHR / WebSocket / SSE | N/A | not present in Node / not exercised | **XHR/SSE: N/A** — Node has no `XMLHttpRequest`/`EventSource`; `@bugsee/capture`'s interceptors self-skip when the global is absent. **WebSocket: not exercised this run, a DELIBERATE CHOICE, not a runtime limitation** — Node ≥22 (this run: Node 24) DOES have a global `WebSocket`, and `@bugsee/capture`'s `createWebSocketInterceptor` (wired in by `packages/node/src/launch.ts` via `installNetworkCapture`) activates against it; a metrics-ingest API simply has no WebSocket use case to hang the scenario off. `browser-vanilla`'s chat feature is the designated WS deep-dive |

**Real-app network exercise (not a scenario id, but genuine):** `POST /api/v1/metrics` with a `value`
above `ALERT_THRESHOLD` makes a REAL outbound call to the alert webhook — verified: `pnpm verify` now
ASSERTS `alerted === true` and that `traceparentSeen` matches the W3C `00-<32 hex>-<16 hex>-<2 hex>`
form on the response body. Until this fix round it asserted only the route's hardcoded 201 while this
line cited both values (neither string occurred in `scripts/verify.ts`), and a 201 is returned whether
or not the webhook call happened at all. The trace-propagation mechanism itself was covered elsewhere
(`traceparentReceivedByThirdParty`, S10) — it was THIS line's own cited evidence that nothing read.

## S8 — Filters & redaction

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| log redaction | `POST /scenarios/s8/log-redaction` | `setLogEventFilter` replaces `SECRET_LOG_VALUE` before upload | **Backend + Wire** — `SFASTIFY-44` confirms delivery; wire check confirms zero uploaded `logs.json` anywhere in the run contains the raw secret string. That negative check alone would pass vacuously if the filter regressed to DROPPING the log entry entirely (the filter contract permits veto) or if this bundle never uploaded at all, so `pnpm verify` also runs a POSITIVE control (added in this fix round): the redacted form itself (`s8-contains-[redacted]-<marker>`) IS present in this scenario's `logs.json`, proving the filter transformed the entry rather than dropping it or never delivering it |
| breadcrumb drop | `POST /scenarios/s8/breadcrumb-drop` | `setBreadcrumbFilter` drops a `category:'secret'` breadcrumb, keeps others | **Backend + Wire** — `SFASTIFY-43` confirms delivery; `pnpm verify`'s own wireCheck gate asserts (a) THIS run's `kept` breadcrumb survives in its bundle, and (b) no `secret`-category breadcrumb appears in ANY bundle from the run. It does NOT assert the bundle's `breadcrumbs` array has length 1 — breadcrumbs are a ROLLING trail (like network, not reset per report), so this bundle can legitimately also carry earlier scenarios' own breadcrumbs from the same recording window; an exact-length assertion was tried and found to be a false positive/negative depending on sweep timing, not a real signal of the filter working (see the check's own comment in `scripts/verify.ts`) |
| report mutate | `POST /scenarios/s8/report-mutate` | `setReportHandler({before})` appends a label | **Backend** — verified, `SFASTIFY-45`: `get_issue` shows `# Labels` → `mutated-by-report-handler` (MCP now surfaces labels — `samples/FINDINGS.md` F-X17) |
| report veto | `POST /scenarios/s8/report-veto` | `setReportHandler({before})` returning `null` drops the report — it must NEVER reach the backend | **Backend** — verified (absence): no issue anywhere in `SFASTIFY`'s full issue list (its size, and why it includes stale duplicates, live in the issue-count home in the fingerprinting note above) has a summary/message containing `VETO_ME`, across the full sweep |
| network filter | `POST /scenarios/s8/network-filter` | `setNetworkEventFilter` strips a custom header from the CAPTURED entry | **Backend + Wire** — `SFASTIFY-55` confirms the trailing `logException` delivered; `filterInvoked: true` locally — and as of this fix round that flag is ASSERTED by `pnpm verify` rather than merely cited, which is what rules out the alternative every other check here is consistent with (a filter registered but never CALLED, the secret header simply never having been sent). The header-strip itself IS now independently wire-verified: the route makes a second, unfiltered control call to the same endpoint, and `pnpm verify` asserts the FILTERED call's captured `custom.headers` has `x-secret-header` stripped (only `traceparent`/`tracestate` survive) while the control call's `content-type` passes through unmodified — proving the strip was scoped to the one filtered request, not a global redaction. Each of the two same-URL calls carries its own `x-call-id` header (the filter never touches it) and the wire check SELECTS by that, not by array position: "no `x-secret-header`, `traceparent` present" is equally true of the CONTROL entry, so a positional check would have read green whichever entry it landed on. A global negative (`x-secret-header` appears in NO captured network entry of ANY uploaded bundle) backs it up |

## S9 — Performance / APM

Performance transactions are never exposed via MCP (`list_issues`'s `type` filter is `bug`/`error`/`crash`
only). Every row is Local + Wire only, via `/scenarios/_debug/transactions`.

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| `http.server` transaction (auto) | any request | one transaction per request, `op: "http.server"` | **Wire** — verified, present for every request in `/scenarios/_debug/transactions` |
| manual span + every `SpanStatus` | `POST /scenarios/s9/manual-span` | `startTransaction`/`startChildSpan` with `OK`/`ERROR`/`TIMEOUT`/`CANCELLED`/`DEADLINE_EXCEEDED`/`UNKNOWN` | **Local** — verified: `pnpm verify` asserts `transactionName === "scenario.manual.<marker>"` and `traceId` matches the W3C 32-hex-char trace id format, not just a 200 |
| `setRouteName` | `POST /scenarios/s9/route-name` | active transaction renamed | **Local — verified the call doesn't throw (200 OK), but the rename has NO OBSERVABLE EFFECT.** New finding (SDK-side, not fixed here — see `FINDINGS.md`): `packages/node/src/server-instrument.ts`'s `finishWith()` unconditionally calls `transaction.setName(spanName(info, route))` when the request finishes, which clobbers whatever `setRouteName()` set during the request; separately, `packages/performance/src/controller.ts`'s `active` transaction slot is a single process-global, not per-request. Previously recorded here as "Local — verified" with no caveat, which overstated what actually happened |
| **route naming: nested plugin prefixes** | `GET /scenarios/route-naming/deep/:id/items/:itemId` (2 levels: `/scenarios` + `/route-naming` + `/deep`) | `http.route`/the transaction name is the FULL merged Fastify pattern | **Wire** — verified: `/scenarios/route-naming/deep/:id/items/:itemId` recorded IN FULL. Fastify resolves plugin-prefix merging at ROUTE REGISTRATION time (unlike Express's `req.route.path`, which only knows its own router's local pattern — `samples/express-api`'s F-4) — no equivalent regression here |
| **route naming: nested plugin prefixes (real app)** | `GET /api/v1/metrics/admin/series/:name/summary` (2 levels: `/api/v1/metrics` + `/admin`) | the `http.server` transaction name is the FULL merged pattern | **Wire** — verified: `pnpm verify` asserts `t.name === 'GET /api/v1/metrics/admin/series/:name/summary'` (exact equality), plus the one-level `GET /api/v1/metrics/:name/stats` at the same discipline. **This row previously cited `GET /api/v1/metrics/admin/health` and its check could not fail** — that route has NO path parameters, and when `routeOf` returns undefined the SDK falls back to `${method} ${urlPath(info.url)}` (`packages/node/src/server-instrument.ts:148-154`), which strips only the query; for a static route the fallback is BYTE-IDENTICAL to the pattern, so the check read green even if route naming were completely broken. (This run's own third-party mock — plain `node:http`, the pure fallback path — shows the shape: `GET /not-found`, `GET /boom`, `GET /large`, `POST /alert`.) **General rule: a route-naming check on a STATIC route cannot discriminate; only a parameterized route can.** A parameterized admin route was added to `src/plugins/metrics.ts` for this assertion — that file has no `logException`/throw sites, so it shifts no issue fingerprint. A peer sample (angular-spa) hit the identical defect with a static `/expenses` and fixed it the same way |
| **first-owner-wins**: `instrumentIncomingRequests:true` (node:http patch) + `setupFastify` on the SAME client must NOT double-report | `GET /scenarios/s14/single-hit` (hit exactly once) | exactly ONE `http.server` transaction recorded for this route, not two | **Wire** — verified: exactly 1 |
| **adapter alone**: `instrumentIncomingRequests:false`, `setupFastify` only, node:http patch never installed | `scripts/adapter-alone-child.ts` (disposable process — see below) | exactly ONE context + ONE `http.server` transaction, named by the FULL Fastify pattern | **Wire** — verified: `httpServerTransactionCount: 1`, `transactionNames: ["GET /nested/items/:id/sub/:subId"]`, AND `contextIdCount: 1`. **`transactionNames` is now ASSERTED, which it was not for three rounds.** The route-naming check here used to read `routePattern` — the child's copy of `req.routeOptions.url`, which is FASTIFY's own property: `@bugsee/fastify` only ever READS it (`var routeOf = (req) => req.routeOptions?.url;`) and never writes it, so that value stays the merged pattern whether the SDK names its transaction correctly, names it by concrete URL, or does not name it at all — i.e. the check was invariant under every Bugsee route-naming regression, while the SDK's real answer was printed by the child and dropped on the floor, and cited in this very row as the evidence. It is now asserted by equality against `GET /nested/items/:id/sub/:subId` (`packages/node/src/server-instrument.ts:153` builds the name as `${method} ${route || urlPath(url)}`, so the concrete-URL fallback is exactly the shape a regression produces and fails the equality). `routePattern` is kept as a labelled PRECONDITION on the sample's own route registration, not as SDK evidence. This closes the same class of defect the previous round closed for `r1`/`r2` and `filterInvoked`; until now the adapter-alone path had no route-naming verification at any depth. The script also resolves `RequestContextStoreToken` and records every DISTINCT `RequestContext.contextId` observed inside the route handler, so the "exactly one context" half of this contract (previously promised in the script's own comment but never printed or asserted) is now real evidence. The COUNT is now read after a grace window, not at first sighting: the child used to break its poll loop the instant one `http.server` transaction appeared and report that snapshot, so a second (leaked) transaction arriving in a LATER performance batch (`performanceFlushIntervalMs: 500`) was invisible and "exactly one" rested on both would-be owners finishing inside one batch. It now waits 800 ms past the first sighting — more than one flush interval — and RE-COLLECTS before printing, the same treatment `scripts/sample-rate-child.ts:81-83` already gave its absence claim. Run as a SEPARATE PROCESS deliberately — see `FINDINGS.md`/the script's own comment for why an in-process secondary client cannot isolate this (the node:http patch is installed on the shared `http.Server.prototype`, process-wide) |
| `performanceSampleRate` 0 / 1 | rate 1: the main app (`src/bugsee.ts`, all S9 rows above); rate 0: `scripts/sample-rate-child.ts` (disposable child process, port 5408) | rate 1 keeps every transaction (used throughout this sweep for maximum signal); rate 0 must suppress EVERY transaction, `http.server` included | **Wire** — verified for BOTH: rate 1 is proven throughout every other S9/route-naming row above; rate 0's child process fires 5 real requests plus a control `logException` and `pnpm verify` asserts the control's bundle arrived (the pipeline is genuinely alive) AND `httpServerTransactionCount === 0` (packages/performance/src/controller.ts's `onFinish` only calls `store.add`/`onFinished` when `finished.isSampled()` is true) |

## S10 — Distributed tracing

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| outbound `traceparent` | `GET /scenarios/s10/outbound-trace` | a `traceparent` header reaches the third-party service | **Local** — verified: `pnpm verify` asserts `traceparentReceivedByThirdParty` matches the W3C traceparent format (`00-<32 hex>-<16 hex>-<2 hex>`), not just that the field is present |
| `tracePropagationTargets` include/exclude | include: `GET /scenarios/s10/outbound-trace` (+ the alerting webhook call); exclude: the `127.0.0.1:1` call `GET /scenarios/s7/connection-failure` makes | only allow-listed targets receive the header | **Local + Wire** — verified BOTH halves. Include: the third party echoes back a well-formed `traceparent` (asserted twice — S10 above and the alerting line in S7), and the captured `/echo-headers` entry carries the header. Exclude: `pnpm verify` asserts that this run's captured network entry for `127.0.0.1:1/unreachable` carries NO `traceparent`/`tracestate` key, with a non-vacuity assertion first (the entry exists, with its request headers captured). **The exclude half had NO coverage at any depth for four rounds, and could not have had any:** the option was `['127.0.0.1:5405', /127\.0\.0\.1/]`, and the catch-all regex matched EVERY outbound target this sample calls — including `127.0.0.1:1` — so every captured outbound entry carried a `traceparent` and no negative observation was possible, while this row read "verified". The regex is dropped (`src/bugsee.ts:71` lists exactly one target); the already-existing connection-failure call is now a genuine non-listed target differing from the listed one ONLY in being absent from the list |
| inbound `traceparent` continuation / joined `trace_id` across two issues | — | — | **N/A** — needs a SECOND Bugsee-instrumented service; `node-service` is the designated cross-service partner per PLAN §5.13/§5.14-20, not available as a stable target within this build |
| `traceResponse` | configured (`serverTiming`/`traceresponse`/`exposeTraceresponse` all on) | BE→FE return headers on instrumented responses | **Local** — configured; not independently asserted on a response (no browser consumer in this sample) |

## S11 — Session replay

**N/A — browser-only.** This is a server sample; `@bugsee/replay` is not applicable. `browser-vanilla`
is the designated sample.

## S12 — Persistence & recovery

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| info | `GET /scenarios/s12/info` | reports the configured `capturedDataStore`/`dataDir` | **Local — weaker than it looks, downgraded.** `src/routes/scenarios.ts`'s `/s12/info` handler returns `capturedDataStore: 'disk'` as a HARDCODED LITERAL, not read from the launched client — there is no public getter on `Bugsee`/`BugseeClient` that exposes the resolved capture-store configuration back to app code (checked `packages/core/src/client.ts` and `packages/node/src/launch.ts`; none exists). `pnpm verify` asserts only a 200 here. The route's literal happens to match `src/bugsee.ts`'s own `capturedDataStore: 'disk'` launch option, but that is this SAME APP echoing its own config back, not the SDK confirming it took effect — if `@bugsee/node` silently ignored the option (e.g. always wrote to memory regardless of config), this check would still pass. Reading the real resolved value would require a new SDK-side introspection seam (not proposed here, since `packages/` is out of scope for this fix round) |
| capture before a hard kill still arrives next start | manual (`kill -9` the server mid-capture, restart) | recovered bundle uploads on the next launch | **Not exercised this run** — `node-service` is the designated deep-dive sample for disk recovery (PLAN §5.13); given the time budget this sample prioritized the fastify-specific hook/plugin surface instead |
| offline → reconnect / multi-instance coexistence | not simulated | — | **N/A this run** — same reasoning as `express-api`; `node-service` is the designated sample |

## S13 — OpenTelemetry

**N/A for this sample.** `@bugsee/fastify` does not wire OTel by default (`otelExportUrl`/
`onOtelSpanProcessor` not configured here). `browser-vanilla` and `node-service` are the designated
OTel-deep-dive samples.

## S14 — Platform specifics / §5.14-20 framework-backend extras

| Id | Route | Expected | Status |
| --- | --- | --- | --- |
| `setupFastify` (one-call form) | the main app (`src/server.ts`) | installs `onRequest`/`onError`/`onResponse`/`onRequestAbort` hooks, cascading to every child plugin | **Backend** — verified (every backend-verified scenario above went through this path) |
| separate middleware/error-handler halves used by hand | — | — | **N/A** — `@bugsee/fastify` exposes only the combined `setupFastify` (hook-based, unlike Express's separate `requestHandler`/`errorHandler`) — there is no separate surface to exercise by hand. Confirmed by reading `packages/fastify/src/hooks.ts`'s exports (only `setupFastify`) |
| `shouldReport` customisation | — | — | **N/A / finding** — `@bugsee/fastify` exposes no such option at all, the sole outlier among all seven backend adapters (express/koa/hapi/hono/elysia/nestjs all have it); see `FINDINGS.md` F-3 |
| `instrumentIncomingRequests: false` — adapter alone, exactly one context + one transaction | `scripts/adapter-alone-child.ts` | see S9 above | **Wire** — verified, see S9 |
| a throw in a route handler / a hook / an async handler / an async plugin / a `setTimeout` (outside request context) | see S5 above | — | see S5 |
| a 4xx that must NOT be reported | `GET /scenarios/status/4xx` | returned via `reply.status(400)`, never thrown → never reaches `onError` | **Backend + Wire** — verified (absence): no issue in the full `SFASTIFY` list (its size lives in the issue-count home in the fingerprinting note above) matches this route's content, AND `pnpm verify` asserts the REPORTING directly (not just the hardcoded 400 status the route returns): ZERO uploaded bundles carry `attrs['http.route'] === '/scenarios/status/4xx'`. A check that only asserted the HTTP status could never fail even if this route started being reported unconditionally — the wire check closes that gap |
| a 5xx that MUST be reported | `GET /scenarios/status/5xx-thrown` | thrown → `onError` reports it | **Backend + Wire** — verified, `SFASTIFY-57`; `pnpm verify` additionally asserts exactly ONE uploaded bundle carries `attrs['http.route'] === '/scenarios/status/5xx-thrown'` (the reporting itself, not just the 500 status) |
| **Fastify-specific: a genuine SCHEMA VALIDATION 4xx (never thrown by app code)** | `POST /api/v1/metrics` with a body missing `value` | Fastify's own Ajv validation raises `FST_ERR_VALIDATION` (400) — does it get reported the same as a thrown error? | **Backend + Wire — FINDING.** `SFASTIFY-1` exists: `## Reason/message: body must have required property 'value'`, `Mechanism: http-error`, `http.route: /api/v1/metrics`. It IS reported, unconditionally, exactly like a real 5xx — see `FINDINGS.md` F-1. `pnpm verify`'s own wireCheck gate now asserts a bundle exists for this scenario (previously only a `console.log` line, outside the 119/119 gate) — the check is written to assert TODAY's behaviour, so it will FAIL the day `@bugsee/fastify` gains a `shouldReport` seam that filters this case out, which is exactly the regression signal this class of check needs |
| **Fastify-specific: `setErrorHandler` interaction with `onError`** | `GET /scenarios/s14/custom-handler/throw` (a nested plugin with its own `fastify.setErrorHandler` rewriting the response to `200 {handledByCustomErrorHandler:true}`) | does Bugsee still report the underlying error even though the HTTP response looks successful? | **Backend + Wire — FINDING.** Route returns `200` with the custom body (confirmed), AND `SFASTIFY-56` exists for the same throw — `onError` fired independently of `setErrorHandler`. See `FINDINGS.md` F-3 (this case is folded into F-3 as its illustration — it shares F-3's root cause, not a separate defect; formerly filed as F-2). `pnpm verify`'s own wireCheck gate now asserts a bundle exists for this scenario too, same "flips to FAIL once shouldReport exists" discipline as the row above |
| per-request context correlation under concurrency (50 overlapping requests, each with a distinct attribute) | `GET /scenarios/concurrency/hit?idx=N` × 50 | every bundle carries its OWN `scenario.req_index`, no cross-contamination | **Wire — fully verified at full scale.** 50/50 bundles uploaded, each with `attrs['scenario.req_index']` matching its own `idx`, and 50 DISTINCT `context_id`s (0 collisions). On the backend all 50 fingerprint-merge into ONE issue (`SFASTIFY-58`, same throw file:line) — a grouping characteristic, not a context-isolation defect (isolation is proven per-bundle on the wire, independent of backend grouping) |
| outbound calls to `node-service` → joined trace | — | — | **N/A this run** — see S10 above |
| framework-specific error surfaces (Nest/hapi/Koa/Express/Elysia/Hono) | — | — | **N/A** — those are the OTHER backend samples' job |

## Cross-cutting / not in the catalog

| What | Where | Status |
| --- | --- | --- |
| Bearer-auth hook, plugin-scoped | `requireBearerAuth` (`src/auth.ts`), installed only inside the metrics plugin | **Local** — verified: 401 (no token), 403 (wrong token), 200/201 (correct token); `/scenarios/*` and `/health` are UNAFFECTED (sibling registration, not nested under the metrics plugin) |
| A SECOND, stricter hook nested inside the first (`x-admin-key`) | `buildAdminPlugin` (`src/plugins/metrics.ts`) | **Local** — verified: both the parent's bearer-auth AND the admin plugin's own key check must pass (403 with a valid bearer but no admin key; 200 with both) |
| Schema-validated ingestion | `POST /api/v1/metrics` (`ingestSchema`) | **Local** — verified: valid body → 201; invalid body → 400 with Ajv's message |
| Pagination + per-metric aggregation | `GET /api/v1/metrics`, `GET /api/v1/metrics/:name/stats` | **Local** — verified, BOTH halves, but not in the same round. **Aggregation** (sixth fix round): `pnpm verify` asserts ALL FIVE aggregates against a series it knows exactly (this run ingests 42 then 99 under `latency.<marker>`, and nothing else writes that name): `count === 2`, `sum === 141`, `avg === 70.5`, `min === 42`, `max === 99`. Until then the row asserted the hardcoded 200 only while claiming "count/sum/avg/min/max correct for a known series" — `avg` regressing to `sum`, or `count` to the whole store's length, would have read green. **Pagination** (seventh fix round): that round-6 fix left the word "Pagination" in this row's own title unbacked — the list request carried no `page`/`pageSize` at all, so the `{items,page,pageSize,total,totalPages}` envelope (`src/plugins/metrics.ts:75-80`, `src/store.ts:69-79`) was produced and read by nothing and `parsePagination`'s clamping (`:37-41`) was never exercised with a non-default value. The counter-argument — at "Local" depth the 200 arguably suffices — is exactly the reasoning round 6 rejected for the aggregation half of this same row, so it is rejected here too. Now asserted on the same known series: the default page returns the whole envelope (`total === 2`, `page === 1`, `pageSize === 20`, `totalPages === 1`, items `[42, 99]` in order); `page=2&pageSize=1` returns `totalPages === 2` and the SECOND point (`99`) — the item's own value is what discriminates, since a `list()` that ignored `page` and always returned the first slice reads green on `total`/`totalPages` alone; and `page=0&pageSize=99999` exercises both clamp arms at once (`pageSize` to the 100 ceiling, `page` back to 1) |
| File-backed JSON store | `src/store.ts` | **Local** — verified, and as of the sixth fix round actually EXERCISED: nothing previously performed or asserted a restart, the claim rested on `src/store.ts`'s own header comment. `pnpm verify` now (a) writes a 2-point `restart.<marker>` series straight into `data/db.json` BEFORE the server process is spawned and asserts the freshly started server serves its `count/sum/min/max` back through the real HTTP API — the store hydrates that file in its constructor, so serving it is proof it came off disk — and (b) reads `data/db.json` off the filesystem at the end and asserts both of the run's API-ingested events (42, 99) are in it. (a) is "a new process reads what an older one left", (b) is "this process writes through"; together they are what "survives a restart" means. Both live in `scripts/verify.ts`, which is fingerprint-safe |
| Real outbound alert webhook call as a side effect of genuine app behaviour | ingest with `value > 90` → `POST http://127.0.0.1:5405/alert` | **Local** — verified (real network call, real response used in the API's own JSON body) |
