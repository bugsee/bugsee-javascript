# Scenarios — samples/angular-spa

Every scenario in `docs/samples/PLAN.md` §4, plus angular-spa's own (§5.6 "Beyond the catalog").
Verified against Bugsee staging app **`SANGULAR`** (`6a8ebe5bd58badbb348fbecd`).

Depth key (PLAN §4 "Verification depth"): **L** = local (no throw, app behaved) · **W** = wire (the
right request left the process, inspected via Playwright) · **B** = backend (confirmed via MCP
`list_issues`/`get_issue`).

Three full `pnpm verify` sweeps were run against staging during the ORIGINAL build (issue keys
`SANGULAR-1` through `SANGULAR-43`); `SANGULAR-1`..`SANGULAR-8` are from an early, since-superseded
partial run (see FINDINGS.md's note on the `ScenarioPanelComponent` stale-client bug that was fixed
mid-build).

**Re-derived after the round-4 fix pass** (`s6-console` gained a WIRE half + FINDINGS.md F-7; the four
`s11-replay-*` checks and `s11-replay-restore` rewritten from `newPageErrors() === 0` to bundle-level
assertions; `s9-manual-transaction` rewritten to assert the uploaded `POST /v2/performance/transactions`
body; `angular-router-navigation` repointed at the PARAMETERISED route; `src/app/bugsee.ts` gained
`performanceFlushIntervalMs: 5000` — the only OPTION change of that pass. An earlier revision called it
"the only app-source change of the pass", which was imprecise: `src/main.ts` was also rewritten mid-pass
(a `cp` restore after a mutator loop). Its content was verified byte-identical to the pre-mutation
original afterwards, so no residue reached the sweeps — the wording was wrong, not the code.)

**Round-5 fix pass** — five checks changed, all in the same direction (replace a claim with the wire
evidence for it): `s10-echo-headers` now fires three probes and actually exercises BOTH halves of
`tracePropagationTargets` (see S10 below — the previous single same-origin probe could not); `s3-log`,
`s3-event`, `s3-trace` and `s3-breadcrumb` became WIRE checks over `logs.json` / `events.user.json` /
`traces.user.json` / `breadcrumbs` instead of `isLaunched()` restatements; a new
`s7-no-content-type-wire` closes the `captureNetworkBodyWithoutType` claim on the uploaded bundle;
`s7-network`'s `xhr` conjunct stopped matching the bare substring `200` anywhere in a line that also
carries a 13-digit epoch timestamp. App-source changes this pass: `src/app/scenarios/scenario-api.ts`,
`scenario-panel.component.ts` + `.html` (the S10 control), `src/app/bugsee-transport.ts` (four more
bundle files parsed) and `server/api-server.mjs` (the cross-origin echo route + CORS preflight) — so the
chunk fingerprint rolled over again and this pass mints its own key range. Check count: **65** (was 64;
`s7-no-content-type-wire` is the addition).

**How the fingerprint actually rolls over — corrected (written in round 4; "this pass" below means the
ROUND-4 pass, and its "current key range" is `SANGULAR-129`..`146`, superseded by round 5's
`148`..`165`). The mechanism it describes still holds, and round 5 re-confirmed it: editing app sources
rolled `chunk-F2AALJJJ.js` → `chunk-5GO3YSEM.js`, while the dep-bundle query hash `?v=f8187970` stayed
put across the same edits.** An earlier revision of this paragraph claimed the
dev-server chunk hash "changes on every restart regardless of which file is edited, so every prior
citation is superseded by construction". That is FALSE, and both halves were measured this pass. A
dev-server restart with NO source edit keeps the hash: the first sweep of this pass ran against a
freshly started server and landed on the round-3 keys — `SANGULAR-106` gained a 7th event, `107`-`121`
a 4th, `123` reached 400, `124` a 4th, all still `chunk-Y2KIKQ5P.js`. Editing ONE app source file
(`src/app/bugsee.ts`) is what rolled the hash to `chunk-F2AALJJJ.js` and minted the current key range.
What DOES change on its own is Vite's dep-bundle query hash (`@bugsee_angular.js?v=…`), which is
independent of app source edits — it was `?v=091c57c2` in round 3 and `?v=f8187970` for this pass, and
it survived this pass's source edit unchanged. It affects exactly one row: `angular-error-in-httpclient`,
whose top frame lives in the dep bundle (`SANGULAR-125` now; `SANGULAR-122` in round 3).

**Round-6 fix pass** — four findings, all of them cases where a row claimed more than its evidence
carried:

1. **`.bugsee-show` did not opt an `<input>` out of masking, and the row said it did.** The markup
   carried the wrong class. `.bugsee-show` feeds rrweb's `unblockSelector` (media/canvas un-BLOCK);
   an input VALUE is un-masked by `.bugsee-unmask` via `unmaskInputSelector`
   (`packages/replay/src/masking.ts:544-548`). The round-6 reviewer read both fields back out of the real
   uploaded `replay.bin` and found them both masked. Fixed in
   `scenario-panel.component.html` (class + label) and in S11's row. **A SAMPLE defect, not an SDK one.**
2. **The "no rrweb decoder" blocker was false.** `replay.bin` is
   `gzipSync(strToU8(JSON.stringify(payloads)))` (`packages/replay/src/encoder.ts:14-16`) and
   `@bugsee/util` — already a dependency of this sample, already imported by `bugsee-transport.ts` —
   exports `gunzipSync`/`strFromU8`. A new `getReplayText(summary)` on the tee plus a new
   `s11-replay-masking-wire` check closes the masking-CONTENT gap with the positive control the wave was
   missing, asserting both directions off one uploaded stream.
3. **`s4-options`'s backend evidence was the SDK's own default.** `mechanism: 'programmatic'` is
   `client.ts:661`'s default and `severity: 'high'` is `defaultSeverity('error')`, so the issue was
   byte-identical to a control that passes NO options. Fixture changed to non-default values
   (`manual-dialog` / `blocker`) and a new `s4-options-wire` check reads them off the uploaded
   `request.json`. **The form-(m) sweep this triggered across every backend-evidence row found two more:**
   S12's `Mechanism: programmatic` clause (annotated — it is the default and is not evidence of recovery),
   and S5's unhandled-rejection row, whose Expected named a capture path the evidence never checked and
   which turns out to be the WRONG one (`Mechanism: uncaught` via Angular's `ErrorHandler`, not the
   browser's `unhandledrejection` listener — corrected, and not an SDK defect).
4. **`s6-console`'s circular conjunct survived a silent serializer regression.** It asserted the plain
   string argument, which the interceptor passes through untouched; it now asserts `"self":"[Circular]"`,
   the safe stringifier's own output (`packages/util/src/json-safe-stringify.ts:44-45`).

App-source changes this pass: `scenario-panel.component.html` (the S11 class + label),
`scenario-panel.component.ts` (the `logWithOptions` fixture), `src/app/bugsee-transport.ts`
(`getReplayText` + the `replayBlobs` side map) and `src/app/bugsee.ts` (exposing it on
`window.__bugseeTee`) — so the chunk fingerprint rolled over again (`chunk-A22UWO6W.js`) and this pass
mints its own key range. Check count: **67** (was 65; `s4-options-wire` and `s11-replay-masking-wire` are
the additions). Every new or changed assertion was falsified against the REAL code path — a source edit
plus a live re-probe, never a `page.evaluate` injection — and every mutation was rolled back and the
files verified byte-identical to their pre-mutation copies. See the probe table above
(`PROBE-R6B-1`/`PROBE-R6B-2`) for the artifacts those falsifications left on staging.

**Round-7 re-verification against a CHANGED SDK substrate** — the browser tier flipped session replay
to **ON BY DEFAULT** (`packages/browser/src/launch.ts:433`: `options.replay !== false && domDocument !==
undefined`; opt-out is `replay: false`), added a DOM-less self-skip in `@bugsee/replay`, and added a
`sendBeacon` interceptor to `@bugsee/capture`. The sample was clean-installed from freshly packed
tarballs and the substrate PROVEN before any result was trusted (the installed
`@bugsee/browser/dist/index.js` carries the new predicate; the installed `@bugsee/capture/dist/index.js`
carries the beacon interceptor) — a plain `pnpm install` silently reuses the old tarball, so the sweep
would otherwise have re-verified the previous substrate. What the flip did:

1. **It broke exactly one check, and broke it honestly.** `s11-replay-restore` asserted that relaunching
   with plain `FULL_LAUNCH_OPTIONS` (no `replay` key) produced a bundle with NO `replay.bin`. That was a
   sound negative control under opt-in replay and asserts the opposite of the SDK's behaviour under the
   default. Replaced by the pair `s11-replay-optout` (`replay: false` -> no `replay.bin`) and
   `s11-replay-default-on` (no `replay` key -> `replay.bin` present), which is two-directional in a way
   the single check no longer could be; the control it clicks was re-pointed and re-labelled, since its
   button said "Restore (replay off)" while turning nothing off.
2. **Four checks now pass for a WEAKER reason than their labels claimed.** The `s11-replay-*` relaunch
   group proves "a new client instance, and it is recording" via `replay.bin` presence — but `replay.bin`
   is now in every bundle this app uploads, including from a client launched with no `replay` key. So
   that conjunct no longer distinguishes "the option I passed was honoured" from "the option was ignored
   and the default recorded anyway". Kept (it still fails the day recording stops) with the label and the
   in-file comment rewritten to say exactly what it is worth, and the discriminating evidence moved to
   `s11-replay-optout`, the only configuration whose effect on the bundle is observable.
3. **A hole the flip did not cause, found in the same audit and fixed: FINDINGS.md F-9.** Every "the
   UPLOADED bundle carries X" check would have passed on a bundle whose presigned PUT was REFUSED — the
   tee parses bundles from the request body and recorded `status`, which no check read. Measured with a
   forced 403 (nine-file bundle, fully matchable, upload rejected). Closed by `uploadStored()` inside
   `waitForBundle` plus the run-wide `wire-upload-status` check.
4. **FINDINGS.md F-8 is now CONFIRMED, and the flip is what made it confirmable.** Round 6 recorded it
   UNCONFIRMED because the fixtures are typed BEFORE the replay relaunch, so no `source:5` incremental
   input event existed to examine. With replay recording from the primary launch, typing into only the
   `.bugsee-unmask` field produces exactly one such event, and it comes back masked
   (`{"source":5,"text":"*****************"}` for a 17-character value, absent from the whole stream)
   while the FULL-SNAPSHOT path in the same sweep reads it back verbatim. `samples/svelte-spa` confirmed
   the same behaviour independently in the same round. It lives in the rrweb fork
   (`github:bugsee/rrweb#bugsee-dist`), it fails CLOSED, and it is deliberately NOT asserted by any check
   — a check pinning it would fail the day the fork is fixed.
5. **New coverage for the new interceptor:** `s7-send-beacon` + `s7-sendbeacon-wire`. `navigator.
   sendBeacon` reaches `network.json` with `mechanism: 'sendBeacon'`, `method: 'POST'`, before/complete
   stages and the payload as `custom.body`. Falsified against the REAL path (not `page.evaluate`): an
   `addInitScript` that hands the app back the NATIVE `sendBeacon`, which the app's own control then
   calls, leaves the status line still reading "queued" and the bundle with ZERO network entries — which
   is precisely why the LOCAL half alone was never enough.

App-source changes this pass: `scenario-panel.component.ts` + `.html` (the S11 opt-out/baseline split,
the sendBeacon control, the S11 section description) and `src/app/bugsee-transport.ts` (the network
summary's `mechanism`/`method`/`type` — always on the wire, previously just not in the type — plus the
`status` contract note). Check count: **70** (was 67; `s11-replay-restore` became two checks, plus
`s7-sendbeacon-wire` and `wire-upload-status`).

The current, authoritative run is the **round-7** pass: **70/70** local/wire checks passing, **no
remaining FAIL** — issue keys `SANGULAR-188`..`SANGULAR-206` (`chunk-QVOST5XQ.js`), plus `SANGULAR-204`
for the dep-bundle `angular-error-in-httpclient` row (`@bugsee_angular.js?v=e769c771` — the clean
reinstall of the changed tarballs rolled the dep hash, so this round cites its own key rather than
round 6's `SANGULAR-125`). SEVEN sweeps ran on this fingerprint — the fix-verification run, three
confirmation runs, and the three final back-to-back runs below — and that is exactly what every key's
**7** events counts, with the storm key `SANGULAR-205` at **700** (= 7 x 100) and the S12 key
`SANGULAR-206` at **7**, i.e. +1 per run and never +2 (see FINDINGS.md F-4). The app's issue total reads
**206** and nothing in it has a `created_on` later than `SANGULAR-206`'s 10:29:00 UTC — so no key was
minted during any of the seven, which is the measurement rather than a between-sweep poll.
`SANGULAR-193` is this round's `s4-options` key and, as in round 6, is the only sweep-produced issue in
the app whose severity reads `Blocker` rather than `High`. `SANGULAR-187` (1 event, `?v=c318f732`) is NOT
part of the range: it is the pre-edit BASELINE sweep — the run made on the changed substrate with the
round-6 checks untouched, which is where the single `s11-replay-restore` FAIL that opened this round came
from.

THREE full sweeps were run back to back on 2026-08-27, starting 10:43:43, 10:46:33 and 10:49:19 UTC, all
three **70/70 with zero FAILs**. Measured, per run: storm quiet reached after 83.2s / 83.0s / 82.5s; 100
of 200 storm exceptions admitted each time; `flush() -> true` each time; and — new this round —
`wire-upload-status` reporting **128 presigned bundle PUTs observed, 0 refused** in every one of the
three, which is the number that makes every other wire check mean what it says. (The three confirmation
runs that preceded them, at 10:32:54 / 10:35:40 / 10:38:25 UTC, were also 70/70 with the same 128/0; only
comments and docs changed between those and the three above.)

The round-6 pass (superseded by the above, kept for its run history) was **67/67** — issue keys
`SANGULAR-168` + `SANGULAR-170`..`SANGULAR-186` (`chunk-A22UWO6W.js`), plus `SANGULAR-125` for the
dep-bundle row. Its own final three sweeps:

THREE full sweeps were run back to back on 2026-08-27, starting 09:16, 09:19 and 09:22 UTC, all three
**67/67 with zero FAILs** (storm quiet reached after 83.1s, 83.7s and 86.9s; 100 of 200 storm exceptions
admitted each time; `flush() -> true` each time). As in every previous round they added events to the
same keys rather than minting new ones (same chunk hash, no edits in between): the app's issue total
reads **186**, and no issue in the app has a `created_on` later than `SANGULAR-186`'s 05:48:03 UTC — i.e.
nothing was minted during any of the three, which is the measurement, rather than a between-sweep poll. Measured immediately after the third: every key in the range carries
**7** events, `SANGULAR-168` carries **8**, and the storm's `SANGULAR-185` carries **700** — exactly
7 x 100. Three of those seven are the sweeps recorded above. **The other four preceded them in this same
pass and are inferred from that arithmetic, not from a printed pass count**: the round-6 build was minted
at 05:45 UTC by the agent that was interrupted mid-round, and its runs' console output was not preserved.
All that is measurable about them is completeness — +1 event on every key of the range, uniformly. (The
extra event on `SANGULAR-168` is not a sweep either: it is the `PROBE-R6B-2` fixture probe at 05:44 UTC,
which created that key ~90s before the first sweep on this fingerprint reached the `s4-error` control.)
`SANGULAR-186` is the S12 key (`crashAndReload`), at 7 events, i.e. +1 per run and never +2 — see
FINDINGS.md F-4 for why this sample's 5 ms reload sits BELOW the duplicate window's lower edge.

**The round-4 inventory that used to stand here was stale, and understated the run history — corrected
with measured numbers.** It claimed the authoritative range was `SANGULAR-129`..`146`, that every key
carried "exactly 3 events", and that the total "stayed at 146 across all three". Measured on 2026-08-27
before this pass's sweeps: every `129`..`146` key stood at **8** events and the storm's `SANGULAR-145` at
**800**, and a key the doc never mentions exists — **`SANGULAR-147`** (`created_on`
`2026-08-26T21:46:59Z`, dep-bundle frame `@bugsee_angular.js?v=b6ff7c64`, 2 events, last updated
`21:50:30Z`), minted AFTER the documented final sweep at 21:26 and after the docs were written. The
arithmetic pins what happened: 3 documented + 2 further full sweeps at ~21:47 and ~21:50 UTC (the two
events on `147`) + the round-5 reviewer's 3 sweeps on 2026-08-27 at ~04:48-04:50 UTC = 8; the storm went
300 → 500 → 800 in the same steps. Those five runs all exercised the POST-round-4-edit `verify.mjs` and
each added exactly one sweep's worth of events to every key, which in fact CLOSES round 4's admitted
"only the reviewer re-ran it" gap — the reviewer reported their three as 64/64; the two at ~21:47/~21:50
were never recorded at all, so their printed pass counts are unknown and only their completeness (+1 on
every key) is measurable. `SANGULAR-147` also shows the dep-bundle query hash is NOT monotonic: it was
`?v=f8187970` in round 4, `?v=b6ff7c64` for those two runs, and back to `?v=f8187970` for the reviewer's
sweeps and this pass's (which is why the `angular-error-in-httpclient` row cites `SANGULAR-125` again,
now at 11 events, rather than `147`).
The round-3 authoritative run was `SANGULAR-106`..`SANGULAR-124` (`chunk-Y2KIKQ5P.js`); the round-2 one was
`SANGULAR-83`..`SANGULAR-101` (`chunk-QWUBZI54.js`). Rows below that a pass directly touched cite the
RE-VERIFIED key from that pass's run; the checks this round-4 pass touched (`s6-console`, `s9-manual-transaction`,
the `s11-replay-*` group, `angular-router-navigation`) are all LOCAL/WIRE checks whose evidence is the
sweep's own output rather than a backend key, so they cite none. Rows no pass has re-opened still cite their
original `SANGULAR-9`..`SANGULAR-43` key as the evidence that was true AT THE TIME it was captured — the
underlying control/assertion did not change, only the fingerprint has since rolled over. Those older keys
ARE still resolvable via MCP (spot-checked: `get_issue SANGULAR-9` returns normally). A fingerprint rollover
MINTS a new issue for the new `file:line`; it does not retire or delete the old one. Treat them as historical
in the sense that a NEW run will not add events to them — not as unreachable.

**Not every `SANGULAR-*` issue came from a sweep.** Reviewers falsifying individual checks injected code
through Playwright `page.evaluate`, and those injections reported real issues of their own. They are
identifiable by an `eval at evaluate (:NNN:NN), <anonymous>` frame instead of a `chunk-*.js` frame, and
they must NOT be counted as scenario evidence.

**An `eval at evaluate` frame no longer means "reviewer probe" by itself, though.** Since round 4 the
sweep ITSELF fires marker reports through `page.evaluate` (`window.__bugsee.logException(...)`) purely to
force a bundle it can then inspect — `S6:`/`S7:`/`S8:` markers in round 4, plus an `S3:` one added in
round 5. Those land in the same eval-frame issues (in this pass, `SANGULAR-62` and `SANGULAR-128` are the
two the markers group into, which is why their `events_count` climbs by several per sweep). They are
legitimate sweep traffic, not probes — and they are still not scenario evidence at BACKEND depth: the
evidence they exist to produce is the tee'd bundle the check reads, not the issue they create. The probe
table below covers the reviewer injections only:

| Key | Probe label | Message | What it was falsifying |
| --- | --- | --- | --- |
| `SANGULAR-82` | — / `PROBE-R6-D*` | `PROBE: s8 network entry` | round-2 review probe. **+2 events in round 6:** the round-6 reviewer's read-only probes re-used this fingerprint (`PROBE-R6-D1`..`D4`, see the row below), so its `events_count` is NOT a sweep counter — do not read the increment as scenario evidence |
| `SANGULAR-166` | `PROBE-R6-D1`..`D4` | round-6 reviewer read-only probes | round 6 — the reviewer's own falsification probes: reading `.bugsee-show`/`.bugsee-unmask` back out of the real uploaded `replay.bin` (which is what disproved the `.bugsee-show` opt-out row and produced the two `source:5` masked-value observations now in FINDINGS.md F-8), plus the `get_issue SANGULAR-148` vs `SANGULAR-153` comparison behind the round-6 `s4-options` correction. Read-only: they changed no sample source. Recorded here so the app's issue totals are not misread as sweep output |
| `SANGULAR-167` (now 10 events) | `PROBE-R7-1`..`PROBE-R7-4` | `F8 probe: incremental path …` / `F8 probe B …` / `403 probe …` / `beacon falsify …` | round 7, standalone Playwright scripts, NOT sweep output. `R7-1`/`R7-2` are the F-8 experiment the replay default flip made possible (type into the `.bugsee-unmask` field while the primary launch's recorder is live, decode the uploaded `replay.bin`, read the single `source:5` event — masked). `R7-3` forced `403` on every presigned `PUT **://*.amazonaws.com/**` through a Playwright route and proved the tee still parsed a matchable nine-file bundle from the rejected upload (FINDINGS.md F-9). `R7-4` restored the NATIVE `navigator.sendBeacon` via `addInitScript` before the app's own control called it, and the bundle came back with zero network entries — the falsification of `s7-sendbeacon-wire`, done on the REAL path rather than through `page.evaluate`. All four are read-only: no `packages/` file and no sample source was mutated for any of them. Their marker reports accumulate on this existing eval-frame key (`<anonymous>:1:45`) rather than minting their own — verified directly: `get_issue SANGULAR-167`'s latest event is `beacon falsify beacon-mtbdsf38` |
| `SANGULAR-167` (5 events) + `SANGULAR-169` | `PROBE-R6B-1` / `PROBE-R6B-2` | `PROBE-R6B-1: replay content decode …` / `PROBE-R6B-2: circular wire …` | round 6, THIS pass's own falsification probes, run through a standalone Playwright script rather than the sweep. `R6B-1` decoded the real uploaded `replay.bin` for the S11 pair (and was re-run twice under injected mutations: markup with `class="bugsee-unmask"` REMOVED, and `replayCanvasAll()` given `maskAllInputs: false` — both mutations rolled back, both flipped the corresponding half of `s11-replay-masking-wire` to FAIL). `R6B-2` read the uploaded `request.json` for `s4-options` and the uploaded `logs.json` line for the S6 circular fixture (re-run once with the fixture reverted to the SDK's default severity/mechanism and with `obj.self` made non-circular — again both flipped their checks to FAIL, and both were rolled back). Not sweep evidence. `SANGULAR-167` is where all five marker reports group (eval frame `<anonymous>:1:45`, so it accumulates rather than rolling over — same mechanic as `SANGULAR-62`/`128`); `SANGULAR-169` is the ONE issue the mutated build minted (`chunk-ZG2P2S3K.js`, severity `High` — the s4-options fixture reverted to the SDK's defaults), and it is the artifact that PROVES the mutation was live. Both mutations were rolled back and the restored files verified byte-identical to their pre-mutation copies |
| `SANGULAR-103` (type **crash**) | `PROBE-A` | `PROBE-A zone timer throw` | baseline — confirms a genuinely uncaught error DOES reach the harness, so `PROBE-B`'s silence means something |
| `SANGULAR-104` | `PROBE-B` | `PROBE-B console.log throws` | `s6-console` — proved the old `newPageErrors() === 0` condition stayed GREEN with `console.log` throwing, i.e. unfalsifiable (now fixed). Its stack runs through `_ScenarioPanelComponent.consoleCall`, so it is the real control path, not a synthetic one. **Re-examined in round 4** under the `SANGULAR-105` lesson (an injected replacement can test the injection realm instead of the code): this probe survives it, because it patched the GLOBAL `console`, which the app's own unmodified call site then invoked — the throw enters the app's real, zone-patched stack, and the conclusion it supports ("`pageErrors` stays empty") is corroborated independently by every sweep ending with `pageErrors.length === 0` |
| `SANGULAR-105` | `PROBE-F` | `Error at cmp.replayDefaults` | `s11-replay-*` — was read as proving those four ARE falsifiable, so they were left alone in round 3. **That reading was WRONG, and this issue is the proof of why** (round 4): the probe replaced the handler through `page.evaluate`, so what rejected was a natively-async function in PLAYWRIGHT's realm, which zone.js never patched — hence the escape to `pageerror`. Its own top frame says so: `at cmp.replayDefaults (eval at evaluate (:311:30), <anonymous>:8:44)`. Breaking the REAL path instead (making the `client.stop()` that `relaunch()` awaits throw, `src/app/bugsee.ts:158-160`) yields ZERO pageerrors — `BugseeErrorHandler` absorbs it. The four checks were rewritten in round 4 to assert on the uploaded bundle instead |
| `SANGULAR-126` / `SANGULAR-127` | `PROBE-R4-D3` | `PROBE-R4-D3: stop() throws inside the real relaunch()` | `s11-replay-*`, round 4 — the REAL-path counterpart to `SANGULAR-105`: `client.stop()` (which `relaunch()` awaits) was made to throw, so the failure originates INSIDE the app's own zone-patched promise chain. Result: the SDK reported it (`Mechanism: uncaught`, stack running through `relaunch` → `_ScenarioPanelComponent`) and Playwright saw ZERO pageerrors — which is what falsified the round-3 justification |

That is 6 probe issues in the app that no sweep produced from rounds 1-4, plus the round-6 additions in the two rows above (`SANGULAR-166`, the +2 on `SANGULAR-82`, and this pass's `PROBE-R6B-*` reports). Any statement below of the form "N issues
total" counts sweep-produced issues only unless it says otherwise.

**`SANGULAR-62` is NOT one of them, despite looking like one.** It also carries an
`eval at evaluate (:311:30)` frame, but its message is `S7: wire-level marker for the HttpClient network
entry` — it is verify.mjs's OWN marker, injected via `page.evaluate` by the sweep. Because its top frame
is the Playwright evaluate wrapper rather than a `chunk-*.js` line, its fingerprint does NOT roll over
when the chunk hash changes: it is a sweep-produced issue that ACCUMULATES across every run
(56 events as of the round-4 pass, +4 per sweep since round 4 added the `s6-console` marker to the three
it already carried) instead of minting a fresh key each time. Do not read its event count
as an anomaly, and do not delete it as a probe.

**`SANGULAR-128` is the same thing, one column over.** Round 4 added five more sweep markers (the four
`s11-replay-*` relaunch checks plus `s11-replay-restore`), and because they pass the message in as a
`page.evaluate` ARGUMENT the eval frame's column differs — `<anonymous>:2:42` instead of `SANGULAR-62`'s
`<anonymous>:2:40` — so they group into their own accumulating key (20 events as of the round-4 pass, +5 per sweep; message e.g.
`S11: wire marker for the restored baseline`). Also verify.mjs's own, also not a probe. **Round-7
update:** `s11-replay-restore` no longer exists (it became `s11-replay-optout` + `s11-replay-default-on`),
so this key now takes SIX markers per sweep rather than five, and one of the messages changed to
`S11: wire marker for the replay:false opt-out`. Measured at 157 events after this round's seven sweeps.

## S1 — Launch & lifecycle

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `/scenarios` → "isLaunched()" | `true` after `launchApp()` | L | `verify.mjs`: `s1-is-launched` |
| "Flush" (`s1-flush`) | `flush(5000)` resolves `true`, drains queue | L | `verify.mjs`: `s1-flush` — `flush() -> true`, with the precondition now ASSERTED rather than assumed: the check fails as inconclusive unless the preceding storm wait exited by genuine quiet (`quiet after 96884ms` and `85832ms` in the two round-3 sweeps; `82048ms` in round 2). **Correction:** earlier revisions of this row recorded a reproducible `flush(5000) -> false` FAIL here and attributed it to an SDK defect. That was wrong. The pre-flush wait was exiting by its 60-second TIMEOUT with ~20s of upload work still in flight — `false` was the correct answer. `waitForQuiet` now reports which exit it took and the budget is 180s; with quiet genuinely reached, `flush(5000)` returns `true`. See **FINDINGS.md F-6**, which is retracted and replaced by the real (opposite, and narrower) defect |
| "Call launch() again" (`s1-duplicate-launch`) | same client instance returned, not a 2nd launch | L | `verify.mjs`: `s1-duplicate-launch` → `same instance returned: true` |
| "Relaunch minimal" (`s1-relaunch-minimal`) | `launch(token, {})` — the CALLER's options are `{}`; every option that isn't `endpoint`/`appId`/`appVersion`/`appBuild`/`onError` is at its default. **Corrected**: earlier revisions of this row (and of `src/app/bugsee.ts`'s doc comment) claimed "every option at its default" — false, since `relaunch()` always injects those five ahead of the caller's options (a genuinely-default `endpoint` would resolve to Bugsee PRODUCTION, which PLAN §3 forbids for this sample) | L/W | `verify.mjs`: `s1-relaunch-minimal` — `isLaunched()` is `true` AND the relaunch produced a **different client instance** than the one live before it (the real positive signal). **Correction:** an earlier revision of this row claimed "every bugsee call issued by the relaunch succeeded" as the wire half — that was VACUOUS. A relaunch issues no Bugsee HTTP traffic of its own (nothing uploads until a report exists), so the observed slice is `[]` and `[].every(ok)` is `true`; the check collapsed to `isLaunched`. The new-instance assertion replaces it; the "no failed call" conjunct remains but the observed call count is now printed so a zero-call slice can't read as a passed assertion |
| "Stop" (`s1-stop`) | `stop(2000)` — a direct call to the boolean-returning API (`relaunch()` elsewhere calls `stop()` too, but discards the result) | L | `verify.mjs`: `s1-stop` — reads the real `ok`/`err` status class off `stop(2000) -> ${ok}` |
| "Relaunch full" (`s1-relaunch-full`) | every `BugseeLaunchOptions` field set (see `src/app/bugsee.ts` `FULL_LAUNCH_OPTIONS`) | L/B | every issue below arrives correctly on the client this produces; `verify.mjs`: `s1-relaunch-full` — `isLaunched()` is `true` AND the relaunch produced a different client instance. Same vacuity correction as the `s1-relaunch-minimal` row above applies here |

## S2 — Identity & attributes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| Settings → display name → "Save" | `setUserIdentifier` | L | `verify.mjs`: settings flow (see S2 section) |
| Settings → "Clear" | `clearUserIdentifier` / `getUserIdentifier() -> null` | L | `verify.mjs`: `s2-clear-user-id` — status text `... -> null` |
| Settings → attributes (string/number/boolean/string[]) | `setAttribute`/`getAttribute`/`clearAttribute`/`clearAllAttributes`/`getAllAttributes` | L | `verify.mjs`: `s2-attributes` — DOM dump shows all 4 types incl. `"tags":["alpha","beta","gamma"]`; `s2-clear-attribute` removes only `tags`; `s2-clear-all-attributes` → `{}` |
| — | attributes DO reach a report (unlike the documented gap in `react-spa`'s notes about the `/v2/issues` metadata call): `include_attributes: true` on `get_issue` shows `build`/`sample` attributes (set in `launchApp()`/`relaunch()`) | B | issue `SANGULAR-42` originally, `SANGULAR-101` in the round-2 run, **re-verified as `SANGULAR-124`** in the round-3 run: `# Attributes` section shows `build: dev`, `sample: angular-spa` |

## S3 — Manual telemetry

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `log()` at every `LogLevel` (error/warning/info/debug/verbose) | captured, each at its OWN level | **L/W** | `verify.mjs`: `s3-log` — **rewritten in round 5.** It used to read `isLaunched() && newPageErrors() === 0`, and since the `newPageErrors()` half is dead app-wide it restated a fact `s1-is-launched` already asserted. It now forces a report after the five clicks and asserts the UPLOADED bundle's `logs.json` carries all five messages, each with its own NUMERIC wire level (`error`=1 … `verbose`=5, `packages/protocol/src/levels.ts:23-29`) — so a mapping that collapsed every level to one value fails, which the old check could not see |
| `event()` with / without params | captured | **L/W** | `verify.mjs`: `s3-event` — same round-5 rewrite: the UPLOADED bundle's `events.user.json` must contain BOTH `expense_created` (with `category`/`source` params intact) and `scenario_panel_opened` (with NO `params` key). `client.event()` writes an `events.user` capture entry (`packages/core/src/client.ts:603-614`) which the assembler serializes to that file |
| `trace(name, value)` | captured | **L/W** | `verify.mjs`: `s3-trace` — same rewrite: the UPLOADED bundle's `traces.user.json` must carry `render.expenses_list` with its VALUE verbatim (`{ms: 12.4, rows: 5}`), not merely a name (`client.trace()` → a `traces.user` entry, `client.ts:616-624`) |
| `addBreadcrumb()` — every field | captured | **L/W** | `verify.mjs`: `s3-breadcrumb` — same rewrite: the UPLOADED bundle's `breadcrumbs` file must carry the breadcrumb with `type`/`category`/`level`/`data.control`/`data.screen` all intact (the redaction path is separately proven by `s8-breadcrumb-filter-wire`) |
| — | All four rows share ONE forced marker report (`S3: wire-level marker for log/event/trace/breadcrumb`) that drains the capture ring the four control groups just wrote into — four separate reports would cost four extra staging issues per sweep for no extra evidence. Independent re-verification via `get_issue --include_logs` is still not done (same documented gap as other web samples), but is now largely redundant: the bundle these checks read IS what was uploaded | — | — |

## S4 — Exceptions

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException(new Error)` (`s4-error`) | issue arrives | B | `SANGULAR-9` (`S4: logException(new Error(...))`) |
| non-Error throwables: string/object/null | each captured with a TYPE reflecting the throwable | B | `SANGULAR-10` (`Handled String`), `SANGULAR-11` (`Handled Object`), `SANGULAR-12` (`Handled Null`, message `null`) — the `Type:` line in the summary distinguishes them, a nice confirmation this isn't flattened to generic `Error` |
| nested `cause` chain (`s4-cause`) | full chain reported | B — **corrected, was overstated** | `SANGULAR-13` originally, **re-verified as `SANGULAR-87`** in the round-2 run: `## Reason/message` = `S4: top-level, chained via cause`, followed by **two** `Cause:` sections — but each `Cause:` section contains ONLY a stack trace, never a message. The fixture's own cause messages (`S4: middle` / `S4: root cause`, `scenario-panel.component.ts:167-168`) do not appear anywhere in the issue. So only the STACKS of the chain reach the backend, not the chain's messages — see FINDINGS.md F-5. This row previously claimed "the whole `Error#cause` chain reaches the backend," which overstates what was actually observed. |
| `LogExceptionOptions` (mechanism/severity/labels) (`s4-options`) | the options actually reach the wire: a NON-DEFAULT `severity` and `mechanism`, plus the labels | **W/B — round-6 correction, the previous evidence was the SDK's own default** | **The old form of this row proved nothing about two of the three fields it named.** It cited `Mechanism: programmatic` as evidence the option was honoured — and `packages/core/src/client.ts:661` defaults `mechanism` to exactly `'programmatic'`. The fixture also passed `severity: 'high'`, which is precisely `defaultSeverity('error')` (`packages/core/src/reporting.ts:96-97`). Proven, not inferred: `get_issue SANGULAR-148` (`s4-error`, which passes NO options at all) rendered `Trigger: error / Mechanism: programmatic` byte-identical to `SANGULAR-153` (`s4-options`), and both listed `severity: High`. Only `# Labels` discriminated, and `verify.mjs`'s `s4-options` check is merely "an issue call happened". **Fixed both ends.** The fixture (`scenario-panel.component.ts`'s `logWithOptions`) now passes `mechanism: 'manual-dialog'` and `severity: 'blocker'` — values nothing else in this sample emits and that the SDK would never produce on its own — and a new `s4-options-wire` check reads them straight off the UPLOADED `request.json` (`severity === 5`, i.e. blocker on the numeric wire scale `packages/protocol/src/levels.ts:15-21`, where the default would be `3`; `source.mechanism === 'manual-dialog'`; both labels). That file was already parsed by the tee (`bugsee-transport.ts:100-103`) and already carries `severity`/`source.mechanism` (`packages/protocol/src/wire.ts:108-118`) — the evidence had been collected and never read. Mutator-verified on the real path: reverting the fixture to the old defaults makes the uploaded `request.json` read `severity=3, mechanism=programmatic` and `s4-options-wire` FAIL, while the old `s4-options` check stays green (that mutated run is `SANGULAR-169`, on the throwaway `chunk-ZG2P2S3K.js` build — severity `High`; rolled back). **Backend confirmation this round: `SANGULAR-168`** — `list_issues` reports `severity: Blocker` (every other sweep-produced issue in this app is `High`), and `get_issue` shows `# Labels: scenario-panel, s4-options` with `# Report source` → `Trigger: error` / **`Mechanism: manual-dialog`**. Compare `SANGULAR-170`, the same round's `s4-error`: `High` / `Mechanism: programmatic`. The two issues are now DISTINGUISHABLE at backend depth, which is precisely what this row previously could not claim |
| same instance twice → dedupe (`s4-dedupe`) | 1 issue, not 2 | B | `SANGULAR-15` (`<instance_members_initializer>`, the class-field-initializer fixture — see below): `events_count` grows by exactly 1 per sweep run, never 2, across 3 runs |
| storm: 200 exceptions in ~1s (`s4-storm`) | rate-limited, not dropped, app stays responsive | L/B | `verify.mjs` reports the app stayed responsive (100 issue calls seen client-side in the authoritative round-3 run, exactly the rate limiter's 100-per-60s admission budget, well under 200); `SANGULAR-42` originally, `SANGULAR-100` in round 2, **re-verified as `SANGULAR-123`** in the round-3 run (**exactly 100** events per sweep under one deduped issue — 100 after the first round-3 sweep, 200 after the second) — accumulates ALL of them under ONE deduped issue rather than 200 separate issues — both the client-side rate limit and the backend-side dedup are doing real work here |

Note on the dedupe fixture: `sharedError` is a class-field initializer (`readonly sharedError = new
Error(...)`), so its stack trace's top frame is Angular's own synthetic `<instance_members_initializer>`
— harmless, just means this one issue's summary doesn't show a Bugsee Expenses method name the way every
other one does.

## S5 — Crashes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| Throw uncaught via `setTimeout` (`s5-uncaught`) | `window.onerror` captures it | B | `SANGULAR-16`/`33`: message `S5: uncaught exception outside any try/catch or Angular zone task`; stack shows `timer` → `_ZoneDelegate.invokeTask` (zone.js's patched timer, confirming this really is an UNCAUGHT throw, not routed through `ErrorHandler`). **Round-6 form-(m) sweep:** the stack frame IS the discriminating half and is genuinely non-default, so this row survives. Re-verified this round as `SANGULAR-176` (`chunk-A22UWO6W.js`): same message, same `timer` → `_ZoneDelegate.invokeTask` frames, and `# Report source` reads `Trigger: error` / `Mechanism: uncaught` — read, not assumed |
| Unhandled promise rejection (`s5-rejection`) | the rejection is captured — but **NOT by the browser's `unhandledrejection` listener in this app**; see the correction | B — **corrected by the round-6 form-(m) sweep** | `SANGULAR-17`/`34` originally, **re-verified as `SANGULAR-177`** this round: message `S5: unhandled promise rejection`. **The old Expected column named a capture path this row's evidence never checked, and when checked it is the WRONG one.** The evidence was only the fixture-unique message, which proves the throw arrived and nothing about HOW. `# Report source` on `SANGULAR-177` reads `Mechanism: uncaught`, not `unhandledrejection` — and the stack confirms why: it runs through `_ZoneDelegate.invokeTask` → `AsyncStackTaggingZoneSpec.onInvokeTask`, i.e. zone.js hands the rejection to Angular's `ErrorHandler` (this app registers `BugseeErrorHandler` app-wide, `app.config.ts:20`) before it can ever reach `window.onunhandledrejection`. `@bugsee/angular`'s error seam reports `uncaught` by default (`packages/angular/src/error.ts:16-19`, asserted in `error.test.ts:19-25`), so `uncaught` is the CORRECT mechanism for this path — the row's expectation was wrong, not the SDK. **Not an SDK defect.** What is consequently NOT verified anywhere in this sample: the browser-tier `unhandledrejection` interceptor itself, which an Angular app with an `ErrorHandler` registered never exercises. `browser-vanilla` is where that belongs |

## S6 — Console capture

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `console.log/info/warn/error/debug` | captured | L/W | `verify.mjs`: `s6-console`. Two halves. LOCAL, per method: the S6 status line is read after EACH click and must show that method's own text — `setStatus` runs AFTER the `console.*` call (`scenario-panel.component.ts:212-216`), so an interceptor that THROWS leaves the line stuck on the previous control's text. WIRE, added in round 4: a report is forced right after the S6 clicks and the tee'd copy of the UPLOADED `logs.json` must contain each of the five messages (`bugsee-transport.ts:72-76` → `bundle.logMessages`, the same path `s8-log-filter-wire` uses). The wire half is what catches SILENT misbehaviour — an interceptor that returns normally but captures nothing leaves every status line correct, which is exactly the shape of F-7 below. History: before round 3 the sole pass condition was `newPageErrors() === 0`, which cannot fail at all in this app (`BugseeErrorHandler`, `app.config.ts:20`, absorbs every throw, so `pageErrors` is empty for the WHOLE sweep) |
| `console.trace` | **NOT captured — SDK defect, see FINDINGS.md F-7** | L/W | This row previously asserted "captured", which was never true on any runtime: `DEFAULT_LEVELS` (`packages/capture/src/console-interceptor.ts:24-30`) has no `trace` key, `onActivate` (`:81-90`) patches only the keys it finds there, and every platform calls `createConsoleInterceptor()` with no arguments — so `console.trace` is never wrapped and never enters the SDK. Observable directly in `s6-console`'s detail line on every run: `trace:false` sits next to five `true`s FROM THE SAME `logs.json`. What IS verified here is the LOCAL half — the call itself completes normally (the app's own `console.trace` output is untouched, since nothing patches it). `trace` is deliberately NOT part of the check's pass condition, so the sweep will not start failing when the SDK is fixed |
| multi-arg call + circular object | captured without throwing | L/W | `verify.mjs`: `s6-console`'s circular conjuncts — the status line reads exactly `console.log(circular object)` after the click (which it only can if `console.log` returned normally from the circular payload), AND the uploaded `logs.json` line carries the SERIALIZER'S OWN output, `"self":"[Circular]"`. **Round-6 tightening — the previous form survived a real regression.** It asserted only `l.includes('S6: circular object')`, which is the plain STRING argument the interceptor passes through untouched; it says nothing about the OBJECT argument, and the object is the whole point of the fixture. Replacing `jsonSafeStringify` with `String(arg)` at `packages/capture/src/console-interceptor.ts:41` yields `S6: circular object [object Object]` — a genuine silent serializer regression — and the old conjunct stayed green. It now requires `"self":"[Circular]"`, the literal `jsonSafeStringify` emits for a back-reference (`packages/util/src/json-safe-stringify.ts:44-45`), so the wire half now actually proves the circular-safe serialization reached the bundle. (The old form did still catch a THROWING formatter, via the status-line conjunct; what it missed was a silent one.) Observed on all three round-6 sweeps: `"S6: circular object {\"name\":\"circular-fixture\",\"self\":\"[Circular]\"}"`. There is no separate `s6-circular` CHECK id; `s6-circular` is the control's `data-testid` |

## S7 — Network capture

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `fetch` GET/POST (JSON + text bodies) | captured | L/W | `verify.mjs`: `s7-get`/`s7-post-json`/`s7-post-text` — response bodies read correctly by the app (interceptors don't alter behavior) |
| 4xx / 5xx | captured | L/W | `verify.mjs`: `s7-4xx`/`s7-5xx` — correct status codes read back |
| connection failure | captured | L/W | `verify.mjs`: `s7-connfail` — a real connection-refused against `localhost:5398` (nothing listens there) |
| body over `maxNetworkBodySize` (2048, see `src/app/bugsee.ts`) | captured copy DROPPED (not truncated — see below), APP still reads the full body | **L/W** | `verify.mjs`: `s7-large-body` (app reads all 64KB client-side) **+ `s7-large-body-wire`** — a tee `HttpTransport` (`src/app/bugsee-transport.ts`, PLAN §6.6 item 2) forwards every SDK call to real staging verbatim while parsing a copy of each uploaded bundle. **Correction while building the wire check**: the actual behavior is not "truncated to the cap" as this row previously assumed — `packages/capture/src/network-body.ts`'s `boundedText` DROPS the body entirely once over the byte cap, tagging the entry `custom.no_body_reason: 'size_too_large'` with no `custom.body` at all. `s7-large-body-wire` confirms exactly that shape on the UPLOADED bundle's network entry, not a bounded partial string |
| response with no `Content-Type` | captured (body KEPT, because `captureNetworkBodyWithoutType: true`), app still reads it | **L/W** | `verify.mjs`: `s7-no-content-type` (the app read it back) **+ `s7-no-content-type-wire`** (round-5 addition). The local half alone did NOT earn the "captured" claim: it reads only the app's own status line, which is identical whether the option is on or off — interceptors must not alter app behaviour — exactly the gap `s7-large-body-wire` was added to close for the sibling row in this same scenario. The option's effect IS directly visible in the tee'd bundle: `gateNetworkBody` (`packages/protocol/src/sanitize.ts:485-487`) nulls the body and sets `custom.no_body_reason: 'no_content_type'` when the option is OFF and leaves `custom.body` intact when it is ON (`packages/capture/src/network-provider.ts:141-143` wires it from the launch option). `s7-no-content-type-wire` asserts the ON shape on the UPLOADED bundle's network entry. Falsified by flipping the option to `false` in `src/app/bugsee.ts` and re-probing: the entry came back `{"body":null,"no_body_reason":"no_content_type"}`. No SDK defect behind the gap — the wiring reads and behaves correctly |
| **XHR** (`s7-xhr`) | captured via the XHR interceptor | L/W | `verify.mjs`: `s7-xhr` — raw `XMLHttpRequest`, reads status + body correctly. **Round-5 tightening:** the conjunct was `s7Xhr?.includes('200')`, a bare substring search over the whole status line `XHR -> ${status} ${responseText}` — and the body is `{"ok":true,"now":<13-digit epoch ms>}`, so a NON-2xx status whose timestamp happened to contain `200` read as a pass (roughly 1% of runs). It now anchors the status to its position (`/^XHR -> 200 \{/`) and separately requires the body's own `"ok":true`. This was the weakest substring assertion left in the sweep |
| **SSE** (`EventSource`, `s7-sse`) | captured | L/W | `verify.mjs`: `s7-sse` — 5 `activity` events received correctly |
| **`navigator.sendBeacon`** (`s7-send-beacon`) | captured as a network entry with `mechanism: 'sendBeacon'`, `method: POST`, before/complete stages and the payload as `custom.body` | **W** | `verify.mjs`: `s7-sendbeacon-wire` (round 7 — the interceptor is new in the substrate). The control prints the tag it puts in the beacon's url AND body, and the check requires THAT tag in the uploaded entry, so no other request can satisfy it. The LOCAL half (`sendBeacon` returned `true`) is recorded separately and is deliberately not trusted on its own: the browser returns `true` for queueing the payload whether or not the SDK instruments the call at all. Falsified against the real path — an `addInitScript` restores the NATIVE `sendBeacon` before the app's own control calls it, and the bundle then contains ZERO network entries while the status line still reads "queued" |
| **HttpClient (XHR) — the sample's headline "beyond the catalog" proof** | the app's REAL CRUD (`core/expense.service.ts`, `provideHttpClient()` with no `withFetch()`) is captured via the SAME XHR interceptor as raw `XMLHttpRequest`, distinctly from `fetch` | **L (structural) + W (a genuine network-entry proof, closes the earlier gap) + B (a related but distinct fact)** | **Now closed at wire level.** An earlier revision of this row cited `SANGULAR-7` (original run; re-verified as `SANGULAR-79` after this fix pass's edits) at depth `B` as proof of the network-capture claim, but `SANGULAR-7` is an EXCEPTION report (Angular's `HttpErrorResponse` reaching the backend via the ERROR-HANDLER seam), not a NETWORK CAPTURE entry — `B` overstated what was actually verified. This pass built a tee `HttpTransport` (`src/app/bugsee-transport.ts`, PLAN §6.6 item 2, same pattern as `samples/fastify-api`/`samples/webpack-sourcemaps`) that forwards every SDK call to real staging verbatim while parsing a copy of each uploaded bundle. `verify.mjs`'s `app-httpclient-network-wire` triggers a report immediately after the app's real `/api/expenses` CRUD and confirms the UPLOADED bundle's `network.json` contains a matching entry — a genuine network-entry proof, `W` depth, not an inference from an unrelated exception report. The STRUCTURAL claim — `app.config.ts:16` uses `provideHttpClient()` with no `withFetch()`, and Angular's documented default HTTP backend is XHR (`@angular/common/fesm2022/http.mjs:2510`) — remains `L` depth (true by inspection). `SANGULAR-7`/`SANGULAR-79` still stands as separate `B`-depth evidence of the ERROR-HANDLER seam (an uncaught `HttpErrorResponse` reaching Bugsee), not of network capture. WebSocket isn't part of this control set but is exercised by the app's live activity feed, see `shared/activity-feed.component.ts` |
| WebSocket | captured | L/W | the app's own "Activity feed" (`shared/activity-feed.component.ts`) opens a real `WebSocket` to `/api/ws` on every `/expenses` visit — `verify.mjs`'s `app-expenses-list` check implicitly exercises this (connects successfully, no throw) |

## S8 — Filters & redaction

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `setNetworkEventFilter` (drop header / redact body field / veto) | applied before capture | **L/W** | `verify.mjs`: `s8-filters` reads the `filter-log` list the filter callback itself appends to and asserts the specific redaction (`droppedSecretHeader=true redactedSsn=true`) AND the veto (`VETOED ...veto-me...`) both actually fired — proves the callback ran, but not that the SDK applied its RETURN VALUE. **Closed at wire level:** `s8-network-filter-wire`/`s8-veto-network-wire` (via the tee `HttpTransport`, `src/app/bugsee-transport.ts`, PLAN §6.6 item 2) inspect the UPLOADED bundle's `network.json` directly — the secret header is absent, the SSN is redacted to `[REDACTED]`, and the vetoed request never appears in the bundle at all. **Correction:** `s8-network-filter-wire` originally selected its entry by `url.includes('/scenario/echo')`, which S7's `s7-post-json` control ALSO hits earlier in the same capture ring — `find()` returned S7's entry (`{"hello":"world","n":42}`), so the check asserted the absence of a header and an SSN that request never carried and could not fail. It now selects the `before` (request) stage POST whose body carries S8's own marker field, requires the header map to be present and non-empty (the old `headers === undefined ||` escape hatch was vacuous), and requires the `[REDACTED]` marker positively. `s8-veto-network-wire`/`s8-report-veto-wire` are absence checks and now assert their PRECONDITION (the non-vetoed sibling really is in the bundle) so they cannot pass on an empty bundle |
| `setLogEventFilter` | redacts a log message | **L/W** | `verify.mjs`: `s8-filters` — asserts a `log: redacted ...` line appeared in `filter-log`. **Closed at wire level:** `s8-log-filter-wire` confirms the UPLOADED bundle's `logs.json` carries the redacted message (`[REDACTED]`), not the raw `SECRET_TOKEN=abc123` |
| `setBreadcrumbFilter` | redacts breadcrumb data | **L/W** | `verify.mjs`: `s8-filters` — asserts a `breadcrumb: redacted data.secret` line appeared in `filter-log`. **Closed at wire level:** `s8-breadcrumb-filter-wire` confirms the UPLOADED bundle's breadcrumbs file has `data.secret` as `[REDACTED]`, not the raw `sk_live_xyz` |
| `setReportHandler` `before` (mutate) | mutates the report, e.g. adds a label | **B/W** | issue `SANGULAR-18`/`35` originally, **re-verified as `SANGULAR-72`** after this fix pass's edits: `# Labels` shows `MUTATE_ME, redacted-before` — the `redacted-before` label was added BY the filter, confirming the mutation reached the backend. `s8-report-mutate-wire` confirms the same directly on the UPLOADED bundle's `request.json` |
| `setReportHandler` `before` returning `null` (veto) | the report is DROPPED — must never arrive | **B/W** | no issue with label `VETO_REPORT` exists among any issue created across the original 3 sweep runs or the round-2/round-3 re-runs — confirmed absent. (That scan was a POINT-IN-TIME snapshot: the app held **124** issues in total when it was made, after the round-3 sweep, of which 4 were reviewer probes — see the probe table in this file's header. The total is now **165** and keeps growing with every sweep, so the number is a timestamp, not a live claim; the LIVE half of this row is the wire check, which re-proves the absence on every run.) `s8-report-veto-wire` confirms the same at wire level: no bundle with that report's summary was ever uploaded (not merely "no issue exists" — the report never even PUT a bundle) |

## S9 — Performance / APM

| Item | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| page-load transaction | automatic | L | not independently inspected (performance transactions aren't in the `get_issue` MCP surface, PLAN §6.6) |
| navigation transactions | `traceNavigations: true` | L | every SPA nav in `verify.mjs`'s app-smoke section |
| `http.client` spans for outbound calls | automatic | L | every `fetch`/XHR/HttpClient call in S7 |
| manual `client.ext('performance').startTransaction()` + child spans + every `SpanStatus` | 6 child spans (`OK`/`ERROR`/`TIMEOUT`/`CANCELLED`/`DEADLINE_EXCEEDED`/`UNKNOWN`), transaction finishes `OK` | **W** | `verify.mjs`: `s9-manual-transaction` — the uploaded `POST /v2/performance/transactions` body is intercepted and the transaction named `scenario.manual_transaction` must have `status: 'OK'` and exactly six child spans, one per `SpanStatus`. **Correction (round 4):** this row previously said the check "reads the real `ok`/`err` status class … not a hardcoded pass". It WAS effectively a hardcoded pass: `manualTransaction()` prints `${statuses.length} child spans` from a literal array (`scenario-panel.component.ts:405`) at `:412` and takes `setStatus`'s default `ok = true` (`:74`), so both halves are unconditional — nothing between `startTransaction()` and `setStatus` can change either short of throwing. The status line is kept only as a secondary conjunct |
| `setRouteName` (direct call) | renames the ACTIVE transaction | L | **Previously verified at zero depth** — the control was clicked and the check was a hardcoded pass regardless of outcome. Now: `verify.mjs`'s `s9-set-route-name` starts a transaction via `window.__bugsee` (a live `getClient()` accessor, see `main.ts`), clicks the control, then reads `getActiveSpan().getName()` back and asserts it is exactly `/manual/:demo` — a real page.evaluate proof, not an inference from "didn't throw" |
| `performanceSampleRate: 0` | `startTransaction().isSampled() === false` (`createRateSampler`, `@bugsee/performance`, guarantees `rate <= 0` is always unsampled) | L | **Previously skipped** ("would need a 2nd relaunch pair" — but the panel already had six relaunch controls). Now: a dedicated `s9-rate-zero` control relaunches with `performanceSampleRate: 0`, starts a transaction, and checks `isSampled()` directly, then restores `FULL_LAUNCH_OPTIONS` (rate 1) — `verify.mjs`: `s9-rate-zero` |

## S10 — Distributed tracing (outbound leg only)

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| Outbound `traceparent` — `propagateTrace` AND both halves of `tracePropagationTargets` (`s10-echo-headers`) | `propagateTrace: true` + `tracePropagationTargets: ['/api/']` (`FULL_LAUNCH_OPTIONS`): a matching request carries a W3C `traceparent`; a non-matching cross-origin request does not. The local API echoes back every header it received (`server/api-server.mjs`) so the outgoing header is observable without a second hop | **L/W** | `verify.mjs`: `s10-echo-headers`. **Round-5 correction — the previous form of this row was unfalsifiable for the option it named.** It fired ONE request, to the SAME-ORIGIN proxied `/api/scenario/echo-headers`, and claimed that verified `tracePropagationTargets`. It did not: `createTraceparentDecorator` (`packages/capture/src/traceparent.ts:136-142`) returns `true` for any same-origin url BEFORE the allowlist is consulted, so that check passed identically with `tracePropagationTargets` deleted or set to match nothing — only `propagateTrace` was genuinely falsified (the decorator is gated on it, `packages/bugsee/src/wire.ts:262`). The control now fires THREE probes and passes only if all three hold: (1) same-origin `/api/scenario/echo-headers` (proxied) carries a W3C `traceparent`; (2) CROSS-ORIGIN `http://localhost:5336/api/scenario/echo-headers` — the API server's own origin, matching `/api/` — carries one (the INCLUDE half); (3) cross-origin `http://localhost:5336/echo-headers-unmatched` — no `/api/` in the url — carries NONE (the EXCLUDE half). Both directions were mutator-verified against the real code path (a source edit to `FULL_LAUNCH_OPTIONS`, not a `page.evaluate` injection): `tracePropagationTargets: ['/no-such-prefix/']` -> probe 2 goes `(none)`, check FAILS; `['localhost']` -> probe 3 gains a traceparent, check FAILS; the same-origin probe stayed green through both, which is precisely the point. Supporting sample-side changes: a `/echo-headers-unmatched` route and CORS-preflight handling in `server/api-server.mjs` (`traceparent` is not a CORS-safelisted request header, so the cross-origin probes need an `OPTIONS` answer) |
| Two-hop join (this app's outbound request joining a Bugsee issue on the RECEIVING side) | N/A | N/A | angular-spa has no server counterpart of its own, and no other sample was confirmed reachable during this build (samples are built by separate, concurrent agents) — the outbound leg above is as far as this sample alone can verify. This is the ONLY part of S10 recorded N/A; PLAN §4 S10's "include/exclude" is covered by the row above as of round 5 |

## S11 — Session replay

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `replay: true` (defaults) | fail-closed masking (maskAllText/maskAllInputs/blockAllMedia) | **W (recording active; the DEFAULT input-masking half is now content-proven, see below)** | `verify.mjs`: `s11-replay-defaults`. **Round-7 caveat, applies to all four `s11-replay-*` relaunch rows:** `replay.bin` presence no longer shows the OPTION was honoured — replay is ON BY DEFAULT (`packages/browser/src/launch.ts:433`), so every bundle this app uploads carries one, including from a client launched with no `replay` key. The conjunct is kept as a recording-stopped detector and the discriminating evidence lives in `s11-replay-optout` below. **Round-6 note:** `s11-replay-masking-wire` (row below) runs against the client `s11-replay-canvas-all` launches, which sets only `canvas` and therefore leaves maskAllText/maskAllInputs at exactly these fail-closed defaults — so the claim that a default-configured recorder actually masks an input's value IS now proven on the uploaded stream. What is still unproven for this row is the rest of the default set (text nodes, media). **Round-4 correction, applies to all four `s11-replay-*` rows:** their only pass condition used to be `newPageErrors() === 0`, which cannot fail in this app — the round-3 evidence that it could (`SANGULAR-105`) was an artifact of injecting the replacement handler through `page.evaluate`; see the probe table above. Each now asserts that the relaunch produced a DIFFERENT client instance and that a report forced immediately after it arrives as an uploaded bundle containing `replay.bin`. **Round-6 correction to that sentence:** it used to end "The masking DEFAULTS themselves are still not verified (no rrweb decoder — same gap as the `replay.bin` row)". The decoder half of that excuse is gone (see the masking-CONTENT row below), and the input-masking default IS now verified; what remains unverified is only the text-node and media halves of the default set, for want of a fixture and an assertion — not for want of tooling |
| explicit masking (`maskTextSelector`/`blockSelector`/`ignoreSelector`/`blockAllCanvas`) | accepted; recorder active | **W (recording active; masking content NOT proven)** | `verify.mjs`: `s11-replay-masking` — same shape as the row above (new client instance + `replay.bin` in the bundle forced right after the relaunch). "Applied" is deliberately downgraded to "accepted": this relaunch's three selectors (`.secret-text`/`.secret-block`/`.secret-ignore`, `scenario-panel.component.ts:505-519`) are never asserted on the stream. **Round-6 correction:** the reason used to be given as "not checkable without an rrweb decoder", which is no longer true — `getReplayText()` decodes the stream and the masking-CONTENT row below reads values straight out of it. What is actually missing is a fixture: no element in this app carries any of those three classes, so there is nothing for a check to look for. That is a gap in the SAMPLE, not in the tooling, and it is smaller than it was — the same relaunch's `maskAllInputs`/`maskAllText` defaults are content-proven one row down |
| `.bugsee-unmask` opt-out on an `<input>` | the `#s11-shown` field opts out of INPUT masking | **W (was L, and the markup was WRONG)** | **Round-6 correction — this row recorded a verification that the sample's own uploaded artifact disproves.** It said `.bugsee-show` opt-out, depth `L`, evidence "present in the DOM". Markup presence was the whole of it, and the markup was carrying the WRONG CLASS: `.bugsee-show` feeds rrweb's `unblockSelector` (media/canvas un-BLOCK), while an input VALUE is un-masked by `.bugsee-unmask` via `unmaskInputSelector` — `packages/replay/src/masking.ts:544-548`, and `:60` records `.bugsee-show → unblockSelector` as ELEMENT ONLY. The decoded replay showed BOTH fields masked (27 and 19 asterisks matching the two typed values). Fixed in `scenario-panel.component.html`: the field now carries `class="bugsee-unmask"`, and it is verified at WIRE depth by `s11-replay-masking-wire` (row below), which reads the value back out of the real uploaded `replay.bin`. This was a SAMPLE defect, not an SDK one |
| canvas recording, fixed fps | `replay.canvas: { fps: 2 }` accepted; recorder active | **W (recording active; fps NOT proven)** | `verify.mjs`: `s11-replay-canvas-fixed` — new client instance + `replay.bin` in the bundle forced right after the relaunch |
| canvas recording, `fps: 'all'` | `replay.canvas: { fps: 'all' }` accepted; recorder active | **W (recording active; per-draw fidelity NOT proven)** | `verify.mjs`: `s11-replay-canvas-all` — new client instance + `replay.bin` in the bundle forced right after the relaunch. This is also the configuration left in force for `s11-replay-file-wire` and `s11-replay-masking-wire` below |
| replay produces an uploaded file | `replay.bin` present in the uploaded bundle — under `replay: { canvas: { fps: 'all' } }`, the configuration the last S11 relaunch leaves in force. **Round-7:** "while replay is active" used to carry weight here; it no longer distinguishes anything, since replay is active in every bundle this app uploads (the default). The row is now a file-presence regression detector, and the option-honoured claim belongs to `s11-replay-optout` (an earlier revision of this row and of the check's own label said `replay: true`, which is not what is running at that point) | **W (file presence)** | `verify.mjs`: `s11-replay-file-wire` — the tee `HttpTransport` (`src/app/bugsee-transport.ts`, PLAN §6.6 item 2) confirms the UPLOADED bundle's file list includes `replay.bin`. File presence only; the CONTENT proof is the next row. **Round-6 correction:** this row used to end "this pass has no rrweb decoder to demux it … that remains an open gap". That justification was FALSE — see the next row |
| **opt out** (`s11-replay-off` → `relaunch({...FULL_LAUNCH_OPTIONS, replay: false})`) | replay does NOT record: the next uploaded bundle carries no `replay.bin` | **W** | `verify.mjs`: `s11-replay-optout` (round 7). **This row replaces "restore the baseline … replay stops", which the default flip invalidated** — that row clicked the same control when it relaunched with plain `FULL_LAUNCH_OPTIONS` and asserted `replay.bin` was ABSENT, which is now the opposite of the SDK's behaviour (`packages/browser/src/launch.ts:433`); the check FAILED on the first round-7 sweep, before anything was changed. `replay: false` is the only value whose effect on the uploaded bundle is observable, so this is the ONLY check in the S11 group that proves the option path is read at all — the four relaunch rows above cannot, since the default produces `replay.bin` for them regardless. The bundle's own arrival is the precondition: absence only means "replay is off" if a bundle arrived |
| **the default itself** (`s11-replay-baseline` → `relaunch(FULL_LAUNCH_OPTIONS)`, NO `replay` key) | replay records ANYWAY — the uploaded bundle carries `replay.bin` | **W** | `verify.mjs`: `s11-replay-default-on` (round 7) — the positive twin of the row above, and the check that pins the default. Ordered last in the S11 group so the rest of the sweep (S4 storm, S1 flush, S12) runs against the app's real configuration |
| masking CONTENT (the positive control PLAN §4 S11 asks for) | the default-masked `#s11-masked` field's typed value is ABSENT from the replay stream, and the `.bugsee-unmask` opted-out `#s11-shown` field's typed value IS present | **W** | `verify.mjs`: `s11-replay-masking-wire` — **the gap five rounds justified as "no rrweb decoder exists in this sample's tooling", closed in round 6 by observing that no decoder was ever needed.** `replay.bin` is literally `gzipSync(strToU8(JSON.stringify(payloads)))` (`packages/replay/src/encoder.ts:14-16`); `@bugsee/util` exports `gunzipSync`/`strFromU8` (`packages/util/src/index.ts:24`) and this sample already depends on and imports it. `bugsee-transport.ts`'s new `getReplayText(summary)` inflates the stream of the named bundle on demand (kept OUT of `getCapturedBundles()`, which `verify.mjs` polls every 150 ms across the CDP boundary). The check asserts BOTH directions off one stream — neither half is worth anything alone, since "absent" also holds when nothing was captured and "present" also holds when masking is off — plus a whole-stream substring scan so a leak through ANY event fails it. Values are read off the full snapshot's nodes by `attributes.id` (`id`/`class` are in the structural-attribute allowlist, `masking.ts:123-186`, so they survive attribute masking). Falsified in BOTH directions against the real code path, not `page.evaluate`: removing `class="bugsee-unmask"` from the markup → `#s11-shown` comes back `***********************` and the value is absent from the whole stream (positive half FAILS); adding `maskAllInputs: false` to `replayCanvasAll()`'s options → `#s11-masked` comes back `S11SECRET…MASKED` (negative half FAILS). Both mutations were rolled back |
| — | Still not verified: whether the replay stream spans a NAVIGATION (no check attempted — time-boxed out in round 4 and not revisited). The masking-content gap this row used to describe is CLOSED by `s11-replay-masking-wire` above. `.bugsee-unmask` lifts masking on the FULL SNAPSHOT but NOT on the INCREMENTAL (`source:5`) input event — **FINDINGS.md F-8, CONFIRMED in round 7** (and only confirmable then: the replay default flip means a recorder is live from the primary launch, so incremental input events exist throughout the sweep — the experiment round 6 could not run took two minutes). Confirmed independently by `samples/svelte-spa` in the same round. It lives in the rrweb fork (`github:bugsee/rrweb#bugsee-dist`), not in `packages/replay`'s masking config, and it FAILS CLOSED (more masking than asked for, never a leak) — so it is a note, not a defect report, and no check asserts it: a check pinning the masked outcome would fail the day the fork is fixed. `verify.mjs` types both fixture values BEFORE the replay relaunches so `s11-replay-masking-wire` reads the full-snapshot path, and says so at the fill site | — | — |

## S12 — Persistence & recovery

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException` then immediate hard-reload (`s12-crash-and-reload`) | `persist`/`recover` (both on in `FULL_LAUNCH_OPTIONS`) re-upload the exception from IndexedDB on the next launch | B (isolated) / **unreliable in the full sweep** | Isolated, single-shot test (fresh client, no preceding load): issue `SANGULAR-43` — message `S12: persist+recover across a hard reload`, correctly recovered and uploaded (`# Report source`: `Trigger: error`, `Mechanism: programmatic`). **BUT**: across THREE full `pnpm verify` sweep runs with the OLD 60-second post-storm wait (which expired with uploads still in flight), it produced **zero** matching issues, 0/3. **Round-2 update:** with the wait raised so the storm's upload backlog actually drains first (quiet reached after 82s), the same control inside the same full sweep recovered correctly — issue `SANGULAR-101`, `events_count` 1 → 2 across the two completed round-2 runs. **Round-3 update:** `SANGULAR-101` reached `events_count` 4 (+1 per sweep, never +2 — no duplicate), and the round-3 sweep, on its new fingerprint, recovered again as `SANGULAR-124` — `events_count` 1 → **2** across the two back-to-back round-3 sweeps (again +1 per sweep, never +2), message `S12: persist+recover across a hard reload`, `Trigger: error`, `Mechanism: programmatic`, attributes intact (quiet reached after 96.9s and 85.8s). **Round-4 update:** `SANGULAR-124` reached `events_count` **4** (the round-4 reviewer's reproduction sweep and this pass's first sweep, both pre-edit and so sharing that fingerprint, +1 each), and the three final round-4 sweeps recovered again on the new fingerprint as `SANGULAR-146` — `events_count` 1 → **3**, +1 per sweep, never +2 (quiet reached after 86.0s, 81.9s and 83.4s). That is **11/11** at the raised budget against 0/3 at the old one. **Round-5 update:** `SANGULAR-146` (the round-4 fingerprint) went on to **8** events — five further recoveries from the two undocumented sweeps + the reviewer's three, see this file's corrected inventory — and this pass's three sweeps recovered again on the new fingerprint as `SANGULAR-165`, `events_count` 1 → **3**, +1 per sweep, never +2 (quiet reached after 82.2s, 82.9s and 86.0s). Running total at the raised budget: **19/19** (11 documented + 5 + 3). Still observations, not a reliability claim — the loss condition was not deliberately re-provoked. **Round-6 update:** the round-6 fingerprint recovered again as `SANGULAR-186`, at **7** events — +1 per run, never +2 — of which **3** are this session's three sweeps (09:16/09:19/09:22 UTC, quiet after 83.1s/83.7s/86.9s) and 4 are the interrupted agent's earlier runs on the same build, inferred from the uniform +1 across the whole key range rather than from printed output (see this file's header). Running total at the raised budget: **26/26** (19 + 7). Four of the 26 are inferred from event arithmetic rather than read off a recorded run — as were five of the earlier 19, see the corrected inventory above. **Round-6 form-(m) sweep:** this row's repeated `Trigger: error`, `Mechanism: programmatic` clause is NOT evidence of recovery and should not be read as any — `programmatic` is what `client.ts:661` emits when no `LogExceptionOptions` are passed, which is exactly this control's case (`crashAndReload` calls `logException(err)` bare), so the pair would look identical on a report that never crossed a reload. What actually discriminates here is arrival AFTER the reload plus `events_count` growing by exactly +1 per sweep and never +2; the trigger/mechanism clause is descriptive only, and is kept because it confirms the recovered report is not re-classified on the way back out. Note also, from round 5, WHY there is never a +2 here: the control reloads 5 ms after `logException`, below the duplicate window's LOWER edge, so only the `recoverReports` leg can fire. See **FINDINGS.md F-4**, which is narrowed and corrected accordingly |
| bundle queued while offline | N/A — not attempted (would need to simulate offline mid-upload, out of scope for this pass) | N/A | — |
| two-tab coexistence | N/A — not attempted | N/A | — |

## S13 — OpenTelemetry

| — | — | — | — |
| --- | --- | --- | --- |
| N/A | `@bugsee/opentelemetry` is wired on-by-default via the `@bugsee/bugsee` umbrella `launch()` (confirmed by code read, same as the other web samples), but neither `otelExportUrl` (produce) nor `onOtelSpanProcessor` (consume) was exercised — no local OTel collector was stood up for this sample. `browser-vanilla`/`node-service` are the PLAN-designated OTel-focused samples. |

## S14 — Platform specifics

N/A — no angular-spa-specific platform item beyond what's in the catalog and the Angular-specific
section below.

## Angular-specific (§5.6 "Beyond the catalog")

| Item | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `BugseeErrorHandler` registered as Angular's `ErrorHandler` (`{ provide: ErrorHandler, useClass: BugseeErrorHandler }`, `app.config.ts`) | catches every uncaught error app-wide, delegates to Angular's own default (`console.error`) afterward | L/B | every `Handled Error`/`Handled HttpErrorResponse`/etc. issue in this table arrived THROUGH this registration — it's the app's only registered error handler |
| `createAngularErrorHandler(...)` called directly | builds a standalone handler, reports + delegates | B | `verify.mjs`: `angular-create-handler` → issue `SANGULAR-19`/`36` (`Angular: createAngularErrorHandler called directly`) |
| `reportAngularError(error, options)` called directly | reports without going through a handler wrapper | B | `verify.mjs`: `angular-report-direct` → issue `SANGULAR-20`/`37` (`Angular: reportAngularError called directly`) |
| **`ngOriginalError` unwrap path** | `new BugseeErrorHandler().handleError({ ngOriginalError: realError, message: '...' })` reports the INNER error, not the wrapper | B | issue `SANGULAR-22`/`38`: message is `Angular: real error inside an ngOriginalError wrapper` (the REAL error's message) — NOT `a generic Angular wrapper message` (the wrapper's own message) — confirms the unwrap works |
| error thrown in a **component** (`ThrowingWidgetComponent.ngOnInit`) | caught during Angular's own lifecycle-hook dispatch, reported, app continues | B | issue `SANGULAR-4`/`21`/`39`: message `ThrowingWidgetComponent (scenario-panel): thrown from ngOnInit`; stack shows `callHookInternal` → `refreshView` (Angular's internal CD machinery) |
| error thrown in a **service** (`ThrowingService.throwSynchronously`) | a plain synchronous throw from a service method, caught the same way | B | issue `SANGULAR-5`/`23`/`40`: message `ThrowingService: synchronous throw from a service method` |
| error thrown inside an **RxJS pipeline** (`map` operator, no error callback) | the pipeline's synchronous re-throw (source `of(1)` emits synchronously) is caught | B | issue `SANGULAR-6`/`24`/`41`: message `ThrowingService: thrown inside an RxJS pipeline (map operator)` |
| error thrown inside an **HttpClient call** (5xx, no error callback) | HttpClient's own `HttpErrorResponse` is caught | B | issue `SANGULAR-7` originally, **re-verified as `SANGULAR-79`** (see S7 above) — this is the SAME control that proves the HttpClient/XHR capture path |
| `createBugseeRenderTracker` | brackets `ngOnInit`→`ngAfterViewInit` with a `ui.render` 'mount' span | L | wired live in `expenses-list.component.ts`; exercised on every `/expenses` visit (`verify.mjs`'s `app-expenses-list`); span content isn't independently visible via MCP (same documented performance-transaction gap as S9) |
| `routePatternFromSnapshot` (direct call, synthetic snapshot) | walks `routeConfig.path`/`firstChild` into `/approvals/:id` | L | `verify.mjs`: `angular-route-pattern` → `"/approvals/:id"` |
| `setRouteNameFromRouter` (direct call, synthetic router) | refines the active transaction | L | `verify.mjs`: `angular-set-route-from-router` |
| `setRouteNameFromRouter` wired to the REAL router (`main.ts`, every `NavigationEnd`) | names every real navigation, including the lazy `/approvals/:id` route and a **guard redirect** | L | `verify.mjs`: `angular-router-navigation` — a REAL in-app router navigation (clicking an expense ROW, so the JS realm survives) followed by reading `getActiveSpan().getName()` back: it must be the matched route PATTERN `/expenses/:id` while the concrete URL is `/expenses/<uuid>`. **Correction (round 4):** the round-3 version navigated to the STATIC `/expenses` and expected the name `/expenses` — still unfalsifiable, because the browser tier already names every navigation transaction `location.pathname` in phase 1 (`packages/browser/src/navigation-source.ts:109-119`, `:144-148` → `packages/performance/src/navigations.ts:58`), and for a static route the raw pathname IS the pattern; with the whole naming seam neutralised (`setRouteName`, `packages/web-adapter/src/adapter.ts:84-91`, and the `setActiveTransactionName` it forwards to, `packages/performance/src/controller.ts:123`) it still passed. The parameterised route (`app.routes.ts:13-16`) is the discriminating fixture: seam intact → `/expenses/:id`, seam neutralised → the raw UUID. **Falsified by breaking the REAL path** (not by a `page.evaluate` injection — see the `SANGULAR-105` lesson in the probe table): with `main.ts:26`'s `setRouteNameFromRouter(router)` replaced by a no-op in the actual source, the check read `/expenses/0ebb97ec-…` and FAILED; restoring the line byte-for-byte made it read `/expenses/:id` and pass again. **Earlier correction (round 3):** the pre-round-3 version asserted only `page.url().includes('/expenses')` right after telling Playwright to navigate there — it tested Playwright, and passed identically with `main.ts`'s `NavigationEnd` subscription deleted. Also exercised by `app-guard-redirect` (navigating to `/approvals` while not a manager redirects to `/expenses?denied=approvals` — the COMPLETED navigation, `/expenses`, is what gets named) and `app-manager-access` (a real `/approvals` → lazy chunk load → route match); transaction NAMES aren't independently visible via MCP (S9 gap) |
| Angular Router **lazy-loaded feature** (`/approvals`, `loadChildren`) | its own chunk, fetched only on first visit | L/W | `pnpm build` output lists `approvals-routes` and `approval(s)-*-component` as separate lazy chunks (not in the initial bundle); `verify.mjs`: `app-manager-access` confirms the route loads and renders |
| Angular Router **guard** (`managerGuard`, `CanActivateFn`) | redirects a non-manager away from `/approvals` | L/W | `verify.mjs`: `app-guard-redirect` |
| reactive form validation (field-level + a cross-field custom validator) | required/min/max + `maxAmountWithoutNoteValidator` | L | `verify.mjs`: `app-form-validation` (empty-title error shown); the cross-field validator (`amount > 10000` needs a note) is present in the form but not independently clicked through in `verify.mjs` — exercised manually during development |
| file attachment (`FileReader` → base64) | reads a receipt client-side, later downloadable from the expense detail page | L | `verify.mjs`: `app-file-attachment` + `app-attachment-download` |
| `HttpClient` (XHR) network capture, distinct from `fetch` | see S7 above | B/W | issue `SANGULAR-7`/`SANGULAR-79` (ERROR-HANDLER seam) + `app-httpclient-network-wire` (the actual network entry, wire-level) |
