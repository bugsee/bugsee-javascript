# Scenarios — samples/solid-spa

Every scenario in `docs/samples/PLAN.md` §4, plus solid-spa's own (§5.5 "Beyond the catalog"). Verified
against Bugsee staging app **`SSOLID`** (`6a8ebe56a5966a45c7e9544f`), using `pnpm verify`
(`scripts/verify.mjs`, a stock-Chromium Playwright sweep with no request patching — the wire-contract +
CORS defects that once blocked every browser sample are fixed, see `samples/FINDINGS.md` F-X6/F-X10)
plus manual `mcp__bugsee-staging__get_issue` reads afterward.

**Two of the sweep's checks now talk to staging themselves** (`s8-report-veto-backend`,
`s8-report-mutate-backend`) and need `BUGSEE_MCP_URL` set in the gitignored `.env` — see `.env.example`.
Without it they FAIL rather than skip, deliberately: the claim they carry ("the vetoed report created no
issue") is unverifiable without asking the backend, and pretending otherwise is precisely the gap that
let `SSOLID-82` sit undetected.

Depth key (PLAN §4 "Verification depth"): **L** = local (no throw, app behaved) · **W** = wire (the
right request left the process, inspected via Playwright) · **B** = backend (confirmed via MCP
`list_issues`/`get_issue`).

**Two rules about this table's own evidence column, both learned in round 4 and both swept across every
row here, not just the row where each was found:**

1. **A string the SAMPLE'S OWN callback wrote into the SAMPLE'S OWN DOM is `L`, however specific it
   reads.** The in-app `filter-log` list is written by `ScenarioPage.tsx`'s filter callbacks immediately
   *before* they return, so it proves the callback ran and took a branch — never that the SDK honoured
   the return value, and never that anything left the process. Several S8 rows were labelled `L/W` on
   `filterLogText` alone; they are corrected below, and the missing evidence (PLAN §6.6's prescribed
   fallback — read the SDK's own uploaded bundle) is now actually collected by
   `s8-network-bundle-wire` / `s8-sanitizer-disabled-bundle-wire`.
2. **A backend field that renders identically whether or not the app set it is not evidence that the app
   set it.** `Mechanism: programmatic` is the SDK's DEFAULT (`packages/core/src/client.ts:661`:
   `mechanism: exceptionOptions?.mechanism ?? 'programmatic'`), so it renders the same on a control that
   passes it explicitly and on one that passes no options at all. `severity` is the same: `list_issues`
   reports `severity: "High"` for every S4 control alike. Rows that cited either as B-depth evidence are
   corrected below to cite only the discriminating half (labels, message, stack, `Type`). A mechanism
   value that is NOT the default — `uncaught`, `unhandledrejection` — *is* discriminating and is kept.

**Issue keys are re-minted by BOTH source edits and plain dev-server restarts — they are traceability
pointers, not stable identifiers.** In `pnpm dev` the module URL in every stack frame carries vite's
`?t=<cache-buster>` query, and that URL is part of the stack signature the backend groups on. Two
different things move it, and an earlier version of this note described only the first:

1. **An HMR edit** re-mints keys for the edited module — editing `ScenarioPage.tsx` makes the same
   control produce a NEW key, while controls whose throw site lives in another file keep theirs.
2. **A plain dev-server RESTART re-mints in the other direction:** a freshly-started dev server serves
   modules with *no* `?t=` at all until something is HMR-edited, so a module that carried a `?t=` value
   frozen at some past edit reverts to the un-busted URL — a different signature again. This is why keys
   frozen at one `?t=` value (this sample's `SSOLID-57`…`SSOLID-69` all carried `?t=1787759996030`, frozen since
   16:12Z) stop matching later runs even with no edit in between, while controls that were never
   HMR-edited (`SSOLID-7`/`-9`/`-40`/`-47`) keep updating across runs.

So a key cited here identifies **an incident**, not a permanent row: the incidents and their described
content are what this file asserts, and the keys are the pointer that was live at the time of writing.
Every key below was re-derived against staging in this pass's closing sweep. A key from an older note
(`SSOLID-39`, `SSOLID-52`, `SSOLID-57…69`, …) is the identical incident under an earlier signature, not
a different one; if a cited key does not resolve, re-run `pnpm verify` and read the current keys off
`list_issues` rather than treating the row as wrong.

**Every check in `scripts/verify.mjs` asserts on real, observed evidence** (a DOM status line, a
page-error count, an actual network call) — none is a hardcoded `true`. Exactly ONE check is a
disclosed, deliberate exception rather than silently weak: `s1-flush-post-storm` accepts either boolean
outcome (post-storm drain timing is nondeterministic by design — see S1 below) and is labelled "WEAK"
in its own description; nothing else short-circuits like that. Four further rules this sweep now
encodes, every one of them learned from a check that was green while blind: (1) never assert on a string
the app prints UNCONDITIONALLY (derive the status, or assert on the wire — `s1-relaunch-after-stop`,
`s9-manual-transaction`); (2) never pre-filter the evidence down to the subset a passing run produces and
then assert a property of that subset (`solid-route-name-wire`); (3) **a number that is computed and
printed is not asserted** — `s8-filters` computed the issue-call count this file cited as the report
veto's entire wire evidence, printed it in the check's detail, and never read it in the boolean, so a
broken veto would have uploaded the report and the sweep would still have printed a full pass (fixed this
pass; the same check's single `VETOED` substring test, which either of two different log lines satisfied
alone, is now split into `network: VETOED` and `report: VETOED`); (4) **a negative assertion needs a
positive control for the MECHANISM under test, not just for the plumbing** — `solid-route-name-wire`
asserted "no navigation transaction is route-named" while proving only that navigation transactions
arrived, which stays true with the integration deleted (fixed in round 3). **Round 4 added three more,
each swept across EVERY check rather than only the row where it was found:** (5) **a check that claims
"X never happened" must ask the system that would HOLD X** — the S8 report-veto row claimed "no issue
created" while only ever counting browser requests, and a contradicting issue (`SSOLID-82`) sat on
staging for three review rounds; `s8-report-veto-backend` now queries staging itself, with the mutate
report from the same block as its positive control. (6) **a `waitFor…` helper without `sinceTs` reads
the EARLIEST match in the whole run, not this click's** — every `waitForPerfTransactions` call now pins
it, not just the ones whose name looks ambiguous today (`solid-set-route-name-matches` asserted on
`/issues/:id`, which the live router wiring also emits). (7) **evidence written by the sample's OWN
callback into the sample's OWN DOM is LOCAL evidence, however specific it reads** — every S8 network row
rested on it, and PLAN §6.6's prescribed fallback (read the SDK's own uploaded bundle) is now actually
used, by `s8-network-bundle-wire` and `s8-sanitizer-disabled-bundle-wire`. See `FINDINGS.md` for the
sample-side bugs this discipline caught while building this sample (a Solid-specific stale-closure bug,
an `<A>`-outside-Router-context bug, and a verify-script race that read a status line before its click
handler's own async continuation had finished — F-3/F-4/F-5), all fixed here, and for what this pass
found by going past "no throw" to the actual wire: **two SDK defects** (finding A — a broken
route-naming refinement that can mislabel an unrelated transaction; finding B — a crash recovered
across a reload that is uploaded TWICE, deterministically) plus finding C, re-graded to a
documentation gap (installing a network filter disables the default PII sanitizer — real, confirmed at
wire level, but the deliberate Android XOR rule, already triaged as such in `docs/review/capture.md`).
Current result: **67/67**, reproduced THREE times back-to-back on the exact final files against real staging (round 5). The previous pass ran 61/61 four times. A fifth, earlier sweep ran at 60/60 before `s8-sanitizer-disabled-bundle-wire` was added. Round 5 took the count from 61 to 67 — see `README.md` for the six added, the one replaced and the one re-pointed, all consequences of session replay becoming ON BY DEFAULT plus the new `sendBeacon` interceptor. Before that, the count moved from 56 because round 4 added five checks: `s8-report-controls-guarded`, `s8-network-bundle-wire`, `s8-sanitizer-disabled-bundle-wire`, `s8-report-veto-backend` and `s8-report-mutate-backend`. **`solid-route-name-wire` was deliberately NOT split into two** — round 4 raised the option; the two legs are one conjoined claim and either alone is vacuous (the negative leg passes with `<RouteNameSync/>` deleted, the positive leg passes on an SDK where the refinement works), so splitting would manufacture two green-while-meaningless checks to report a number one higher. The previously-stated reason for keeping it whole ("keep the count comparable") was documentation cosmetics and is withdrawn.

## S1 — Launch & lifecycle

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `/scenarios` → "isLaunched()" | `true` after `launchApp()` | L | `verify.mjs`: `s1-is-launched` |
| "Flush" (`s1-flush`) under normal load | `flush(5000)` resolves `true` | L | `verify.mjs`: `s1-flush-clean` — DOM status reads `flush() -> true`. **Was labelled `L/W`; corrected.** The only evidence is the app's own status line reporting the boolean `flush()` resolved with — a real derived value, not a fixed banner, so the check is sound, but nothing here inspects a request. No wire-level "the queue actually drained" assertion is made |
| "Flush" right after the S4 storm | **WEAK CHECK, disclosed as such** — accepts EITHER boolean outcome. 200 exceptions deliberately exceed the capture rate limiter's budget (`samples/FINDINGS.md` F-X19: ~100/60s), so a 5s flush legitimately may or may not drain in time; this check can only prove the call resolves without hanging/throwing, not "drained" vs "didn't" | L | `verify.mjs`: `s1-flush-post-storm` — description says WEAK explicitly; do not read this as a real drain confirmation |
| "Call launch() again" (`s1-duplicate-launch`) | same client instance returned, not a 2nd launch | L | `verify.mjs`: `s1-duplicate-launch` → `same instance returned: true` |
| "Relaunch minimal" (`s1-relaunch-minimal`) | relaunch with `MINIMAL_LAUNCH_OPTIONS` (`{}`) — every option this sample CAN leave at its default, no throw. **Not literally `launch(token, {})` at the wire:** `relaunch()` (`src/bugsee.ts`) always merges `endpoint`, `appId`, `appVersion`, `appBuild`, `onError` (+ `carrier`) underneath it, so those five are never default here. `endpoint` is the load-bearing one — a launch without it would post to PRODUCTION, which `docs/samples/PLAN.md` §3 forbids. Everything else (`sdkVersion`, `captureNetwork`, `persist`, `performanceMonitoring`, the replay options, …) really is default. **"The replay options at their default" changed meaning this round: replay is now ON by default, so this minimal launch RECORDS** (see S11) | L | `verify.mjs`: `s1-relaunch-minimal` (asserts `newPageErrors() === 0`). **This row previously also claimed the control "demonstrates default `sdkVersion` 0.0.0 being rejected server-side" — that claim is REMOVED as unsupported:** in every run the check's own detail printed `[]`, i.e. NO bugsee call was observed in that window at all, so nothing here demonstrates a rejection in either direction. (`sdkVersion` IS left at its default by this control; what staging does with it is simply not measured by this sample — `FULL_LAUNCH_OPTIONS` pins `sdkVersion: '1.0.0'` and `src/bugsee.ts` records why) |
| "Relaunch full" (`s1-relaunch-full`) | every `BugseeLaunchOptions` field set (see `src/bugsee.ts` `FULL_LAUNCH_OPTIONS`), no throw | L/B | `verify.mjs`: `s1-relaunch-full`; every S4-S12 issue below arrived correctly on the client this relaunch produced |
| "Stop" (`s1-stop`) — standalone `stop(timeout)`, not just incidental inside `relaunch()` | resolves `true`; `isLaunched()` reads `true` immediately before and `false` immediately after (a FRESH read, not the frozen `is-launched` span — Solid only evaluates that once at mount, see `FINDINGS.md` F-3) | L | `verify.mjs`: `s1-stop` — asserts the exact before/after values, not just "no throw" |
| "Relaunch (restore)" (`s1-relaunch-after-stop`) | `relaunch()` RESTORES a working client after `stop()` — `isLaunched()` reads `false` immediately before and `true` immediately after (fresh reads, the same derived form `s1-stop` uses) | L | `verify.mjs`: `s1-relaunch-after-stop` — asserts `isLaunched() before=false after=true`. **Previously this check matched a fixed `relaunched after stop()` banner the handler printed unconditionally, so it could only go red if `relaunch()` THREW** — it never checked the restoration it claimed to verify. Fixed this pass (control + check) |

## S2 — Identity & attributes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| Settings → display name → "Save" | `setUserIdentifier` | L | manual DOM check (status line confirms the set value) |
| Settings → "Clear" | `clearUserIdentifier` / `getUserIdentifier() -> null` | L | manual check (control present, not scripted in `verify.mjs`) |
| Settings → attributes (string/number/boolean/string[]) | `setAttribute`/`getAttribute`/`clearAttribute`/`clearAllAttributes`/`getAllAttributes` — **all five now actually clicked** (previously `scenarios.md` claimed all five on one row while only `setAttribute`/`getAllAttributes` were ever exercised by `verify.mjs` — an overclaim, now fixed) | L | `verify.mjs`: `s2-attributes` (set, all 4 value types incl. `"tags":["alpha","beta","gamma"]`), `s2-clear-attribute` (removes just `seats`, confirmed via the `getAttribute`-fed dump), `s2-clear-all-attributes` (dump reads back exactly `{}`) |
| "Set attribute BEFORE + AFTER a triggering event" (Settings, `attrs-before-after-event`) | PLAN §4 S2: an attribute set before AND after a `logException` call, both orderings against the live client | L/W/B | `verify.mjs`: `s2-attrs-before-after-event` — a real `/v2/issues` call is observed between the two `setAttribute` calls, and the final status line confirms `demoPhase` reads `"set-after-event"` post-event (waits for the status text explicitly rather than reading it immediately after the wire evidence — see `FINDINGS.md` F-5 for why that distinction matters); the triggering exception itself arrived as `SSOLID-40`, message `S2: attribute set BEFORE and AFTER this triggering event` |
| — | attributes DO reach the backend and DO render over MCP: `get_issue("SSOLID-40", include_attributes: true)` returns `# Attributes` → `demoPhase: set-before-event` for the very report the row above triggers | B | re-verified this pass. **This row previously claimed a "documented MCP-surface gap (PLAN §6.6)" — that claim was FALSE and has been deleted.** It rested on `SSOLID-36` showing no `# Attributes` section; `SSOLID-36` is the S8 report-handler issue (`S8: report handler should mutate this`, labels `MUTATE_ME, redacted-before`), an incident on which no attributes were ever set, so its empty section proved nothing. `SSOLID-40`, cited one row above, renders its attributes correctly |

## S3 — Manual telemetry

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `log()` × 5 levels (error/warning/info/debug/verbose) | one log line per level, no throw | L | `verify.mjs`: `s3-log` |
| `event()` with/without params | `issue_created`/`scenario_panel_opened`, no throw | L | `verify.mjs`: `s3-event` |
| `trace(name, value)` | trace entry, no throw | L | `verify.mjs`: `s3-trace` |
| `addBreadcrumb()` — every field | type/category/message/level/data, no throw | L | `verify.mjs`: `s3-breadcrumb` |
| — | **These are L-only because the BACKEND/MCP does not surface captured logs at all — not because MCP "has no per-call surface without a triggering report."** That earlier framing was a misattribution and is corrected here. This is the cross-sample finding `samples/FINDINGS.md` F-X4 ("Captured logs never reach the issue"), and this pass CLOSES F-X4's stated open next step ("unzip an uploaded bundle and check whether the log file is present and populated — that splits it cleanly into 'the SDK did not send it' vs 'the backend did not surface it'"). Both halves are measured on this sample: (a) the uploaded bundle DOES carry them — an S3 bundle PUT intercepted from a session with real `console.*` + `log()` + `addBreadcrumb()` activity is an 11-entry zip containing `logs.json` (816 B uncompressed / 219 B stored), `breadcrumbs` (208 B / 157 B) and `network.json` (1081 B / 425 B), all populated, alongside `request.json`, `manifest.json`, `apptoken`, `traces.system.json`, `events.system.json`, `events.user.json`, `viewtree.json` and `crash.json` (byte sizes are per-session and vary run to run; presence and non-emptiness are the point); (b) MCP still shows nothing — `get_issue("SSOLID-76", include_logs: { entries: "all" })`, on an issue from that same sweep, returns **no `# Logs` section at all**. Verdict: **the SDK sends them; the backend/MCP does not surface them.** The S8 log/breadcrumb-redaction checks below independently confirm the same primitives fire and are filtered correctly | L (SDK side confirmed at bundle level; B blocked by F-X4) | `verify.mjs`: `s3-log`/`s3-breadcrumb` + see S8; `samples/FINDINGS.md` F-X4 |

## S4 — Exceptions

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException(new Error)` | issue, correct message + stack | B | `SSOLID-72`: message `S4: logException(new Error(...))` |
| non-Error: string/object/null | 3 separate issues, all reported (not dropped) | B | `SSOLID-73` (`Handled String`, message `S4: a bare string throwable`), `SSOLID-71` (`Handled Object`, message `{"code":"E_SAMPLE","detail":"plain object throwable"}`), `SSOLID-74` (`Handled Null`, message `null`) — all three carry real exception data (the historical F-X9 "non-Error produces no crash payload" defect is fixed) |
| nested `cause` chain | `Cause:` chain in the report | B | `SSOLID-70`: message `S4: top-level, chained via cause` |
| `LogExceptionOptions` (mechanism/severity/labels) | the **labels** the call passed are present on the backend. **`mechanism` and `severity` are NOT verified by this sample** — see the evidence cell | B (labels only) | `SSOLID-75`: labels `scenario-panel, s4-options`. **The earlier form of this row also cited `Mechanism: programmatic` as evidence — withdrawn, per depth-key rule 2:** `programmatic` is the SDK's default (`packages/core/src/client.ts:661`), the control happens to pass that same value (`ScenarioPage.tsx`'s `s4-options`, `mechanism: 'programmatic'`), and `SSOLID-72` — the plain `logException(new Error)` control that passes NO options at all — renders the identical `Mechanism: programmatic`. So that field distinguishes nothing. `severity: 'high'` is equally non-discriminating: `list_issues` reports `severity: "High"` for `SSOLID-71`/`-72`/`-73`/`-74`/`-75` alike. Only the labels are real evidence, and they are conclusive (no other control sets them). Verifying the mechanism/severity pass-through would need a control passing a NON-default mechanism; none exists here |
| same instance twice (dedupe) | 1 issue call, not 2 (tightened from `<= 1`, which passed at 0 — see `FINDINGS.md` item 3) | W/B | `verify.mjs`: `s4-dedupe` → `1 issue calls`, asserted `=== 1`; `SSOLID-47` is the single issue this produces (message `shared instance — logException twice must dedupe`) |
| storm: 200 in ~1s | rate-limited (few requests), app stays responsive | W/B | `verify.mjs`: `s4-storm` — the delivered count is **not pinned to a range and must not be**: directly observed values on this sample are `7`, `71`, `72` and `75` across five separate sweeps (a peer review session minutes apart measured 75 then 7; this pass's three closing sweeps measured 71, 75 and 72), plus one run whose contribution was only inferrable (≈`85`, from the backing issue's `events_count` moving 163 → 173); round 4's five sweeps measured `76`, `74`, `79`, `77` and `74`. Round 4's run of `74, 79, 77, 74` finally produced a repeat (74 twice, non-consecutively) — which changes nothing: the check asserts only `>0 and <200`. The variance is NOT just "how much of the rate limiter's ~100/60s budget earlier scenarios already spent" — that would only explain differences *within* a sweep, and these are separate browser sessions minutes apart, so the limiter's own window state, upload settle timing and dedupe grouping all move it too. The check therefore asserts only `>0 and <200` (something got through, and it was rate-limited), which is the whole of what this scenario claims. `SSOLID-81` (message `S4 storm #9`) accumulates every run's storm into ONE issue by stack signature — `events_count` read **1297** right after round 4's fourth closing sweep, confirming the storm's 200 distinct-message exceptions group into ONE issue rather than 200. See the re-derived key table at the end of this file. This check runs LAST in the sweep (after S12, not before — see `FINDINGS.md` finding B) so nothing after it still needs the rate limiter's budget |
| — | cross-session dedup on an identical error | B | confirmed across repeated sweeps: `SSOLID-47` (the dedupe control) accumulates exactly ONE event per sweep despite two `logException` calls on the same instance each time (measured directly: `events_count` moved 10 → 11 → 12 across round 3's three sweeps and **18 → 23** across round 4's five — one event per sweep for two calls, every time, on eleven consecutive sweeps), and `SSOLID-81` (the storm) accumulates every run's whole storm into that single issue (`events_count: 1297` at the last reading). Both counts are cumulative across every sweep this app has ever seen, so read them as "one issue, many events", not as a per-run figure |

## S5 — Crashes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| uncaught exception (`window.onerror`) | `Type: Crash`, `Trigger: crash`, `Mechanism: uncaught` | B | `SSOLID-76`: `Type: Crash`, message `S5: uncaught exception outside any try/catch or ErrorBoundary` |
| unhandled promise rejection | reported, but classified `Type: Handled error` / `Trigger: error` / `Mechanism: unhandledrejection` — **not** `Type: Crash` | B | `SSOLID-77`: message `S5: unhandled promise rejection`. This CLASSIFICATION asymmetry is BY DESIGN (`packages/browser/src/launch.ts:495` and `detection-providers.ts:15-16` explicitly comment "window error → crash, unhandledrejection → error"), and PLAN §4's S5 row grouping "window.onerror and unhandledrejection" under one "Crashes" scenario reads as if both classify the same way when they don't — worth a doc note. **But see `FINDINGS.md` F-2 (rewritten this pass): the SAME `SSOLID-77` report's uploaded `crash.json` carries `handled: false` while the dashboard displays "Handled error"** — a genuine internal contradiction inside one report, not just a catalog-wording ambiguity. `FINDINGS.md`'s original F-2 stopped at "by design, undocumented"; that framing was too shallow. |
| `exitOnUncaught`/`unhandledRejections` modes | N/A — Node-only options, not in `BugseeLaunchOptions` (browser) | N/A | browser has no process-exit window; see `@bugsee/node`'s `node-service` sample instead |

## S6 — Console capture

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `console.log/info/warn/error/debug/trace` | one log line each, no throw | L | `verify.mjs`: `s6-console` |
| multi-arg call, object, circular object | captured without throwing | L | `verify.mjs`: `s6-console` (includes the circular-reference `console.log` call; asserts zero NEW page errors across the whole block) |
| — | app-behaviour check ("interceptors don't alter app behaviour") | L | every `console.*` call in the app continued to print to the real console throughout the sweep — capture is additive |

## S7 — Network capture

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| fetch GET / POST JSON / POST text | captured, body readable by the app | L (+W for the POST JSON) | `verify.mjs`: `s7-network` — asserts the app's OWN status line shows the ACTUAL response body it read (`GET /scenario/get -> {"ok":true,...}`, `POST JSON -> {"received":{"hello":"world","n":42}}`), proving the interceptor didn't alter the response. The `W` applies to the POST JSON case only, and comes from a DIFFERENT check: `s7-network-wire` intercepts the outgoing `POST /scenario/echo` and asserts the request body that actually left the process is byte-for-byte the JSON the app passed. The GET and POST-text cases are `L` |
| 4xx / 5xx | captured with status | L | `verify.mjs`: `s7-network` — status lines assert `404`/`500` literally. **Was `L/W`; corrected** — the evidence is the app's own status line (which does prove the app read the real status, i.e. the interceptor did not alter it), not an inspected request |
| connection failure | app catches it, no crash | L | exercised in the control panel (`s7-connfail`); not independently asserted beyond "no throw" |
| body over `maxNetworkBodySize` (2048, set in `FULL_LAUNCH_OPTIONS`) | the APP still reads the FULL body. **The "captured copy is truncated" half is NOT verified** | L | `verify.mjs`: `s7-network` — asserts the status line reports the full `65536 bytes` read client-side, which is the binding "interceptors must not alter app behaviour" half. Nothing here inspects the captured copy's size, so the truncation itself is asserted only by the SDK's own unit tests, not by this sample |
| response with no `Content-Type` | the call is made and does not throw. **The "captured via `captureNetworkBodyWithoutType: true`" half is NOT verified** | L | `verify.mjs`: the `s7-no-content-type` click is inside `s7-network`'s `newPageErrors() === 0` window, so a throw would go red — but nothing inspects the captured entry, so the option's effect is asserted only by the SDK's own unit tests (R4-7 class: the Expected column overstated what the evidence covers) |
| XHR | the call is made and does not throw. **The "captured" half is NOT verified** | L | `verify.mjs`: the `s7-xhr` click is inside `s7-network`'s `newPageErrors() === 0` window. XHR really is a different interceptor code path from fetch, which makes the missing capture assertion worth naming rather than implying (R4-7 class). The uploaded bundle's `network.json` is now readable by this sweep (`s8-network-bundle-wire`), so asserting an XHR entry in it is the obvious next upgrade — not done this pass |
| WebSocket | real bidirectional traffic exists in the app. **"Captured" is NOT verified — nor is it asserted by any check** | N/A | `ActivityFeed.tsx` opens a real WebSocket to the local API and the app works, which is genuine but is not a check: no `verify.mjs` assertion mentions it, so a WebSocket-capture regression would not turn this sweep red (R4-7 class — the row previously read `L` on "the app uses this for real") |
| SSE (`EventSource`) | captured | L | `verify.mjs`: `s7-network` — asserts the status line shows `SSE event #5`, i.e. all 5 real server-sent events were read |
| `navigator.sendBeacon` — string payload | the beacon is queued by the UA, leaves the process, and is CAPTURED with its body | L + W | `verify.mjs`: `s7-send-beacon` (the UA's own return value + the outgoing request, matched on Chromium's `ping` resource type — a beacon's payload is not exposed to CDP at all, measured) and `s7-send-beacon-bundle-wire` (the entry is in `network.json` inside an ACCEPTED bundle, tagged `mechanism:"sendBeacon"`, carrying the marker in its body). **Added this round:** `@bugsee/capture` gained a dedicated `sendBeacon` interceptor and this sample called `navigator.sendBeacon` nowhere, so that transport had ZERO coverage while S7 claimed to sweep the network umbrella |
| `navigator.sendBeacon` — Blob payload | queued and captured, but with **no body** and a stated reason | L + W | same two checks. The bundle row asserts the Blob marker is ABSENT from `network.json` and that the entry carries `no_body_reason:"cant_read_data"`. Deliberate, not a defect: a Blob is readable only asynchronously and the interceptor refuses to block on it (`packages/capture/src/send-beacon-interceptor.ts`:28-29, 170-171) — the same "interceptors must not alter app behaviour" rule that shaped the bounded-read fetch body path. It does still lift the Blob's `type` into the captured Content-Type |
| — | network entries are **not** visible via `get_issue` (documented MCP-surface gap, PLAN §6.6) — all of the above is L/W only, never B | — | — |

## S8 — Filters & redaction

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `setNetworkEventFilter` — drop a header + redact a body field | the filter fires, header/field redacted in the CAPTURED copy — and the redaction survives into what actually leaves the process | L/W | `verify.mjs`: `s8-filters` asserts the in-app filter log literally contains `droppedSecretHeader=true` and `redactedSsn=true` (that half is `L`: the sample's own callback wrote it). The `W` is new this pass and is `s8-network-bundle-wire`, which unzips `network.json` OUT of the bundle the S8 mutate report actually uploaded and asserts the SSN (`123-45-6789`) and the secret header value (`sk_live_should_not_leave_device`) are both ABSENT from it while the request they came from IS present and carries the filter's own `[REDACTED]` marker — so the absence means redaction, not a capture gap. **Note:** the filter fires MULTIPLE times per logical request (once per `NetworkStage` — `before`/`complete`/etc., each with different `custom.headers`/`custom.body` populated) — undocumented for filter authors, see `FINDINGS.md` F-1 |
| `setNetworkEventFilter` — veto (URL-keyed rule) | request dropped from capture entirely | L/W | `verify.mjs`: `s8-filters` asserts the in-app filter log contains `network: VETOED` specifically (previously an ambiguous bare `VETOED` substring that the S8 REPORT veto's own log line satisfied equally, so either veto could vanish with this still green). That line is written by the sample's own filter callback immediately BEFORE it returns `null`, so on its own it proves only that the callback ran and took the veto branch — `L`, per depth-key rule 1. **The missing half is now collected:** `s8-network-bundle-wire` unzips `network.json` out of the real uploaded bundle and asserts `veto-me` appears NOWHERE in it, with `veto-body-target` (F-1's leaking `complete` stage-entry from the same block, same filter) asserted PRESENT as the positive control — so the absence is a veto the SDK honoured, not network capture being off. Network capture still has no MCP surface (`samples/FINDINGS.md` F-X4 / PLAN §6.6), so there is no `B` for this row; the bundle IS the wire |
| `setNetworkEventFilter` — veto a request keyed on its REQUEST BODY | **FINDINGS.md F-1 (re-graded major): the veto is per-`NetworkStage`-ENTRY, not per-REQUEST** — the `before` stage-entry (which carries the request body) IS vetoed, but the SAME request's `complete` stage-entry (which carries the RESPONSE body/headers, and has no request-body field to match) leaks through un-vetoed | L/W | `verify.mjs`: `s8-veto-per-entry-hole` — asserts the in-app filter log contains BOTH `VETOED(request-body-rule)` AND `leaked-despite-veto-intent(request-body-rule)` for the SAME url. That is `L` on its own (the sample's own callback wrote both lines); the `W` is `s8-network-bundle-wire`, which finds `veto-body-target` PRESENT in the uploaded `network.json` while `veto-me` — vetoed on every stage-entry — is absent from the same file. The leak is therefore visible in what actually left the process, not only in the sample's log |
| `setNetworkEventFilter` installed at all | **FINDINGS.md finding C (re-graded this pass to a DOCS gap): installing ANY network filter disables the built-in PII sanitizer** — a `token=` query parameter (in the default sanitizer's own denylist) reaches the filter's view of the URL completely unredacted, even though the filter's own logic never touches URLs. Real and confirmed at wire level, but this is the deliberate **Android XOR rule** (`packages/capture/src/network-provider.ts:137-139` names it in the same function; `docs/PROGRESS.md` records it as intentional; `docs/review/capture.md:216` already triaged it as "the deliberate Android rule, not a defect — but it is worth an explicit line in the public docs"). What is open is that public-docs line | L/W | `verify.mjs`: `s8-sanitizer-disabled` (`L` — the sample's own callback wrote that line, so it proves only that the URL reached the CALLBACK unredacted) **plus, new this pass, `s8-sanitizer-disabled-bundle-wire` (`W`)**, which finds `token=SUPER_SECRET_TOKEN_VALUE` verbatim inside the `network.json` of the real uploaded bundle — so the sanitizer genuinely did not run at any later point in the pipeline either |
| `setLogEventFilter` | secret redacted from the log line | L | in-app filter log: `log: redacted "leaking SECRET_TOKEN=abc123 in a log line"` |
| `setBreadcrumbFilter` | secret redacted from breadcrumb data | L | in-app filter log: `breadcrumb: redacted data.secret` |
| `setReportHandler` `before` — mutate | report proceeds, label ADDED | B | `SSOLID-78`: message `S8: report handler should mutate this`, `# Labels` → `MUTATE_ME, redacted-before` — the mutation is directly visible on the backend (stronger than react-spa's WIRE-only verification of the same case). **This is no longer a manual read:** `verify.mjs`'s `s8-report-mutate-backend` queries staging over MCP at the end of every sweep and asserts the issue carries BOTH `MUTATE_ME` (what the app passed) and `redacted-before` (what the handler ADDED) — the added label is the discriminating half, and it is the term that would go red if `before` stopped being applied |
| `setReportHandler` `before` — veto | **no issue created** | W/B | Three independent terms, and the `B` one is new this pass (round-4 finding R4-1). **W:** `verify.mjs`'s `s8-filters` ASSERTS `filterCalls.length === 1` — exactly 1 `/v2/issues` call for the whole 8-action sequence, which is the mutate case, so the veto click produced ZERO wire calls. (That number was computed and printed in the check's detail but never read by the assertion until round 3, so a broken veto would have uploaded the report and the sweep would still have printed a full pass; the count is now a required term, and `report: VETOED` is asserted as its own substring alongside it.) **B:** `s8-report-veto-backend` polls staging over MCP after the sweep, over EVERY issue whose `updated_on` falls at or after the moment the S8 block opened, and asserts none of them carries the vetoed message — with the mutate report from the same block required to be FOUND by the same query as the positive control (without it, "the message is absent" passes equally when the endpoint is unreachable or the window is mis-computed). **Guard:** `s8-report-controls-guarded` asserts the control itself is `disabled` until filters are installed. **Why all three:** for three review rounds this row was `W` alone and claimed "no issue created" while never once asking staging — and staging had `SSOLID-82` (`6a8f5dcbd58badbb34924a7a`, 2026-08-26T21:42:34Z, `events_count: 1`), labels `VETO_REPORT`, message `S8: report handler should VETO this — must never arrive`. See `FINDINGS.md` F-6 for what that issue actually was (a sample-side gap, NOT an SDK defect — a vetoed report structurally cannot upload) |

## S9 — Performance / APM

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| page-load transaction | automatic (`performanceMonitoring: true` default via the umbrella) — **but NOT verified by this sample at any depth** | N/A | **This row previously read `L` / "every page navigation exercises this", which asserted coverage the sample does not have (round-4 finding R4-7).** A pageload transaction is STARTED on every load, but `packages/performance/src/page-load.ts:149-156` calls `transaction.finish()` only from inside `onHidden` — the visibilitychange/pagehide path — so it never finishes, and therefore never reaches the wire, during a Playwright sweep that simply navigates. Measured: an isolated probe recorded ZERO transactions in 6 s after a hard `page.goto`, and no `operation: "pageload"` body appears in any sweep's intercepted `POST /v2/performance/transactions`. **This is by design, not an SDK defect** (a pageload's own web vitals are not final until the page is hidden). Verifying it would need a check that closes/hides the page and then reads the transaction, which this sweep does not do |
| navigation transactions | `traceNavigations: true` | W | **Was `L` / "every SPA nav in `verify.mjs`" — the same unbacked-coverage shape as the page-load row above (R4-7), except here the evidence does exist and simply was not cited.** `solid-route-name-wire` intercepts `POST /v2/performance/transactions` and prints the real uploaded navigation transactions for a single `<A>` click: `[{"name":"/issues/issue-2","source":"url"},{"name":"/issues/issue-2","source":"url"}]`, `operation: 'navigation'`. The check requires `liveNavTxs.length > 0`, so "navigation transactions reach the wire" is an asserted term, not an assumption |
| `http.client` spans for outbound calls | automatic — **NOT verified by this sample at any depth** | N/A | **Was `L` / "every `fetch`/XHR call in S7", which asserted coverage the sample does not have (the R4-7 class).** Nothing in `verify.mjs` inspects an `http.client` span: the S7 checks assert on the app's own status lines and on the outgoing `/api/scenario/echo` request, never on an uploaded transaction's child spans. The only child spans this sweep ever reads at wire level are the six the S9 manual-transaction control creates itself. Verifying this would mean settling perf-transaction traffic around an S7 click and asserting an `http.client` span for that URL — not done |
| manual `client.ext('performance').startTransaction()` + child spans + every `SpanStatus` | 6 child spans, transaction finishes `OK` | W | `verify.mjs`: `s9-manual-transaction` — WIRE-confirmed: intercepts `POST /v2/performance/transactions` and asserts the UPLOADED transaction has `status: "OK"` and carries exactly 6 child spans whose statuses are `OK, ERROR, TIMEOUT, CANCELLED, DEADLINE_EXCEEDED, UNKNOWN`. **Previously this matched the handler's `finished OK` status line, which `ScenarioPage.tsx` prints unconditionally** — the same wire evidence the `s9-sample-rate-zero` positive control already relied on was available here and is now used |
| `setRouteName` (direct call) | renames the active transaction | W | `verify.mjs`: `s9-set-route-name` — WIRE-confirmed: intercepts `POST /v2/performance/transactions` and asserts the uploaded transaction is actually named `/manual/:demo` with `bugsee.name_source:"route"`, not just an unconditional status-line claim |
| `performanceSampleRate` 0 and 1 | a transaction created under `sampleRate:0` never reaches the wire; the SAME primitive DOES reach the wire once restored to `sampleRate:1` (previously undisclosed as unexercised — now implemented via a 2nd relaunch pair) | W | `verify.mjs`: `s9-sample-rate-zero` — positive control: 0 matches while rate=0, 1 match after restore, same transaction name, timestamp-scoped to this click specifically |

## S10 — Distributed tracing

| — | — | — | — |
| --- | --- | --- | --- |
| N/A | solid-spa has no server counterpart of its own, and no cross-sample two-hop trace was attempted (wave-2 samples are built by separate, concurrent agents). `propagateTrace`/`tracePropagationTargets` are set in `FULL_LAUNCH_OPTIONS`; the local API server has an `/api/scenario/echo-headers` endpoint that would let a `traceparent` header be confirmed locally, but no two-hop join was attempted. |

## S11 — Session replay

**Rewritten this round.** Session replay is now **ON BY DEFAULT** in `@bugsee/browser`
(`options.replay !== false && domDocument !== undefined`, `packages/browser/src/launch.ts`); `replay: false`
is the opt-out and a DOM-less host self-skips silently (`packages/replay/src/register.ts`). Three things in
this section were invalidated by that flip and are corrected below:

1. every row here was `L` ("no throw") on the argument that replay CONTENT has no MCP surface. That argument
   was never the whole story: `replay.bin` is `gzipSync(strToU8(JSON.stringify(payloads)))`
   (`packages/replay/src/encoder.ts`) — `zlib.gunzipSync` plus a string search is the entire tool needed, no
   rrweb decoder. The masking rows are now **W** on the decoded stream;
2. the old `s11-replay-bundle-wire` row — "relaunch with explicit masking, then find `replay.bin` in the
   bundle" — **passed for the wrong reason** after the flip. `replay.bin` now rides *every* bundle this
   sample uploads (it is visible in `s8-network-bundle-wire`'s own entry listing), so finding it after
   clicking a replay control proved nothing about the control. It is replaced by a matched pair,
   `s11-replay-default-on` / `s11-replay-optout-wire`;
3. this sample's own "Restore (replay off)" control **was a lie**: it called `relaunch(FULL_LAUNCH_OPTIONS)`,
   which names no `replay` key, so post-flip it left replay ON while the button and status line said off.
   Fixed — `s11-replay-off` now really passes `replay: false`, and `s11-replay-restore` does the baseline
   restore.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| **no `replay` key at all** (`FULL_LAUNCH_OPTIONS`) | replay records anyway — this IS the flip | W | `verify.mjs`: `s11-replay-default-on` — `replay.bin` is in the zip CENTRAL DIRECTORY of a bundle the collector ACCEPTED (2xx), not a raw-byte substring of whatever was sent. Red on the pre-flip SDK |
| `replay: false` | the opt-out really opts out | W | `verify.mjs`: `s11-replay-optout-wire` — no `replay.bin` in the accepted bundle, with `crash.json` in the same bundle as the positive control so "absent" cannot mean "nothing was uploaded". This is what stops the row above being a tautology. Falsified in this pass: making the control pass `replay: true` turns it red |
| `replay: true` (defaults) | relaunching with `replay: true` does not throw. **The fail-closed masking defaults themselves are NOT verified here** | L | `verify.mjs`: `s11-replay-defaults` asserts `newPageErrors() === 0`. "maskAllText/maskAllInputs/blockAllMedia are on by default" still rests on the SDK's own unit tests (R4-7 class); what IS verified here is the explicitly-configured masking, two rows down |
| explicit masking (`maskTextSelector`/`blockSelector`/`ignoreSelector`/`blockAllCanvas`) | the options are accepted, and the masked input's value really is absent from the recording | L + W | `verify.mjs`: `s11-replay-masking` (no throw) and `s11-replay-masking-content` — decodes `replay.bin` and asserts the un-marked input's value is absent on BOTH paths (the value present when the recorder took its full snapshot, and a value typed afterwards during recording), with a structural control that the stream really serialized this page's `<input>` nodes. Falsified in this pass: flipping the control to `maskAllInputs: false` turns it red |
| masking OFF | the positive control | W | `verify.mjs`: `s11-replay-masking-off-control` — with `maskAllText`/`maskAllInputs` off the same probe DOES appear verbatim in the decoded stream. Without this the absence rows could be green on a needle that could never have matched (a peer sample shipped exactly that bug) |
| `.bugsee-unmask` opt-out on an input | **the mark works on the full-snapshot path only** — a value TYPED DURING recording stays masked | W | `verify.mjs`: `s11-unmask-mark-typed-value`. **Two corrections here.** (a) This sample previously marked the field `.bugsee-show` and claimed it opted out; it never did — `.bugsee-show` feeds rrweb's `unblockSelector` (un-blocks MEDIA), and the input opt-out is `.bugsee-unmask` (`packages/replay/src/masking.ts`). Two peer samples had the identical defect. (b) With the right mark, the behaviour splits by path — see FINDINGS.md **finding D** |
| canvas recording, fixed fps | `replay.canvas: { fps: 2 }`, no throw | L | `verify.mjs`: `s11-replay-canvas-fixed` |
| canvas recording, `fps: 'all'` | every draw call, no throw | L | `verify.mjs`: `s11-replay-canvas-all` |
| — | replay CONTENT is still not visible via `get_issue`, so nothing here reaches **B** depth — but "L only, no MCP surface" is no longer the right description of this section: the wire IS the surface. No replay-spanning-a-navigation check was attempted (time-boxed out). | — | — |

## S12 — Persistence & recovery

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException` then hard-reload 250ms later (`s12-crash-and-reload`) | `persist`/`recover` (both on in `FULL_LAUNCH_OPTIONS`) re-upload the exception from IndexedDB on the next launch. Expected exactly once; **observed exactly twice, every time** (`FINDINGS.md` finding B) | W/B | `SSOLID-80`: message `S12: persist+recover across a hard reload` — confirmed arriving AFTER the page fully reloaded and relaunched. The control's reload delay is now **250ms**, not the original 5ms: at 5ms the bundle has not yet reached the durable queue (`packages/core/src/durable-upload-pipeline.test.ts:111` pins `['put','enqueue']` — persist, THEN upload), so only the marker survives and recovery can only ever produce 1 — the one timing that cannot exercise the real path. `verify.mjs`'s `s12-persist-recover` counts the actual `/v2/issues` calls the reload produces and asserts `=== 2`; 1 would mean finding B has been fixed, 0 that recovery is broken. **This check runs BEFORE the S4 storm, not after** (`FINDINGS.md` finding B's second leg: the storm exceeds the capture rate limiter's ~100/60s budget, and running S12 right after it starved recovery of budget entirely — an isolated run once saw ZERO `/v2/issues` calls for this exact click when ordered that way) |
| duplicate recovery upload | **FINDINGS.md finding B (major): a single incident IS recovered via TWO independent paths** (`recoverSiblingBundleQueue` re-uploading the durably-queued bundle + core `recoverReports` rebuilding it from the still-open marker, both inside one `coexistence.recoverDeadSiblings` call with no de-duplication) and delivered twice — **deterministically, not as a race** | W/B | `SSOLID-80` (raised as `SSOLID-68` before the signature re-mint — same incident) moves by exactly **+2 per click** of the S12 control: `events_count: 2` immediately after the first single click, `4` after the next sweep's single click, 10 → 12 → 14 across round 3's three closing sweeps, and **26 → 36** across round 4's five (+2 each, never +1 and never +3). Never anything but +2. Two `/v2/issues` POSTs + two S3 bundle PUTs ~1.4s apart, with DIFFERENT contents — 8 entries incl. `[request.json, crash.json, viewtree.json]` (the pre-crash durable bundle) vs 7 entries incl. `[request.json, crash.json]` and no `viewtree.json` (the marker rebuild); the entry lists are abbreviated to the three that distinguish the legs, the counts and byte sizes are exact. Reproduced at every reload delay tried INSIDE the vulnerable window (5/5 when first raised, 12/12 across six delays in re-review, 3/3 in round 3's closing sweeps, and 5/5 in round 4's). The window has BOTH edges: below ~40ms the bundle has not reached the durable queue (the sample's ORIGINAL 5ms reload, always 1), and above the incident's own upload settle time (~3.5s here — `POST /v2/issues` at +1835ms, bundle PUT settled at +3486ms) the marker is already cleared, also 1. `verify.mjs`'s `s12-persist-recover` now asserts `=== 2`. **Structural caveat, disclosed:** the step immediately before S12 (`arm-global`) ends with a report interrupted mid-upload by a `page.goto` — the same "terminated before settle" shape S12 exploits — so its own recovery could in principle land inside S12's counting window and hold `=== 2` green against a FIXED SDK. `verify.mjs` drains bugsee traffic to quiet after that relaunch before opening S12's window, and prints the drained count in the check's detail. **Read that number correctly (round-4 finding R4-4 — the earlier wording here was wrong).** The drained count is **4 on every run**, not 0; `verify.mjs`'s own comment at the check says so outright, so a reader told to "watch for a deviation from 0" would see 4 every single time and learn nothing. Those 4 are exactly what the drain exists to remove — `arm-global`'s own report plus what the following relaunch recovered from it — and their being non-zero is the evidence that the hazard is REAL, not that something went wrong. **What actually catches contamination is `recoveryCalls.length === 2`**: a contaminant that escaped the drain and landed inside S12's window pushes that to 3 and turns the check red, and a drain that never went quiet fails safe on its own timeout. The drain mechanism itself is sound and was independently re-verified: `waitForQuiet({quietMs: 2500})` closes and `sinceCheckpoint()` runs BEFORE the S12 click, so it cannot swallow S12's own uploads |
| bundle queued while offline | N/A — not attempted (out of scope for this pass) | N/A | — |
| two-tab coexistence | N/A — not attempted; a shipped browser-tier feature (`samples/FINDINGS.md`/PLAN §4 S12 names it explicitly) that this single-tab Playwright sweep does not exercise | N/A | — |

## S13 — OpenTelemetry

| — | — | — | — |
| --- | --- | --- | --- |
| N/A | `@bugsee/opentelemetry` is wired on-by-default via the `@bugsee/bugsee` umbrella `launch()` (confirmed by code read — `@bugsee/solid` re-exports the same `launch`), but neither `otelExportUrl` (produce) nor `onOtelSpanProcessor` (consume) was exercised — no local OTel collector was stood up for this sample. `browser-vanilla`/`node-service` are the PLAN-designated OTel-focused samples. |

## S14 — Platform specifics

N/A — no solid-spa-specific platform item beyond what's in the catalog above.

## Solid-specific (§5.5 "Beyond the catalog")

| Item | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `solidErrorHandler` in a LOCAL `<ErrorBoundary>` (`GuardedThrowingWidget`) | catches, reports, custom fallback renders | L | `verify.mjs`: `solid-error-boundary-guarded` — `guarded-widget-fallback` renders |
| `solidErrorHandler` in the APP-LEVEL `<ErrorBoundary>` wrapping `<AppRouter>` (`main.tsx`) — unguarded throw | catches, reports, `ErrorFallback` renders | L/B | `verify.mjs`: `solid-error-boundary-global`; `SSOLID-7`: message `ThrowingWidget(global): deliberate render-phase throw for ErrorBoundary`, `Mechanism: uncaught` — confirmed on the backend, with the stack trace showing the throw happening inside the `<Show>` reactive computation, caught by the boundary |
| `reportSolidError` (direct call) | issue reported | B | `SSOLID-79`: message `Solid: reportSolidError called directly` — the message is the discriminating evidence (no other control produces it). **The earlier form of this row also cited `Mechanism: programmatic`; withdrawn per depth-key rule 2** — that is the SDK's default, so it renders identically for a control that sets nothing, and says nothing about `reportSolidError` |
| `routePatternFromSolidMatches` (direct, synthetic matches) | `/issues/:id/comments` — the DEEPEST match alone, since `@solidjs/router`'s `route.pattern` is already the full cumulative path (unlike react-router's per-segment `route.path`) — confirmed by reading `@solidjs/router`'s `createRoutes()`/`joinPaths` source | L | `verify.mjs`: `solid-route-pattern` — exact string match asserted |
| `setRouteNameFromSolidMatches` (direct call, synthetic matches) | renames the active transaction | W | `verify.mjs`: `solid-set-route-name-matches` — WIRE-confirmed: the uploaded transaction is actually named `/issues/:id` with `bugsee.name_source:"route"`. This is the DIRECT-call primitive with NO `@solidjs/router` timing race — it works correctly. Contrast with the next row. **Round-4 fix (R4-2):** this check's `waitForPerfTransactions` call carried no `sinceTs`, so it asserted on the EARLIEST `/issues/:id` transaction of the whole run. That name is not unique to this control — the LIVE `RouteNameSync` wiring emits it too (two real `<A>` clicks inside the 1 s idle window produce `{"name":"/issues/:id","op":"navigation","src":"route"}`, and the app-smoke block at the top of the sweep does exactly that). Benign while finding A is open, but the day it is fixed this check would have read app-smoke's navigation instead of this click and passed regardless of whether `setRouteNameFromSolidMatches` works. Its two nearest siblings already pinned `sinceTs`; this one now does too |
| `setRouteNameFromSolidMatches` wired globally via `useCurrentMatches()` + `createEffect` (`RootLayout.tsx`'s `RouteNameSync`) — the LIVE router wiring | **`scenarios.md` previously (incorrectly) claimed this refines "active transaction named by route PATTERN, not URL, on every navigation." That claim was never actually checked against an uploaded transaction and is FALSE — see `FINDINGS.md` finding A (major).** A real `@solidjs/router` `<A>` click navigation stays named by the concrete URL, `bugsee.name_source: "url"`, every time; two rapid navigations can additionally mislabel an EARLIER transaction with a LATER route's pattern (measured-vs-labelled mismatch) | W | `verify.mjs`: `solid-route-name-wire` — clicks a real `<A>` navigation to `/issues/issue-2`, waits for transaction traffic to SETTLE, then asserts that **no** `operation: 'navigation'` transaction the click produced carries `bugsee.name_source: 'route'`. Observed: `[{"name":"/issues/issue-2","source":"url"},{"name":"/issues/issue-2","source":"url"}]` — two navigation transactions (each `<A>` click fires two `currententrychange` events: a 0ms phantom that is immediately superseded, and the live one), neither refined. **The earlier form of this check was blind:** it pre-filtered to `name === '/issues/issue-2'` and then asserted `.every(source === 'url')` over that subset, and it stopped at the FIRST matching POST, which held only the phantom — a fix that deferred `setRouteName` onto the real navigation transaction would have left the phantom url-named and the check would still have PASSED. Verified by mutating this sample's own `RouteNameSync` to defer the call by one tick (simulating the fix): the uploaded transactions became `[{"/issues/issue-2","url"},{"/issues/:id","route"}]`, on which the OLD check PASSES and the NEW one correctly FAILS. **A second positive control was added this pass, because the check was still unfalsifiable in the direction that matters most:** "nav transactions reached the wire, one is named for issue-2, none is route-named" is ALL still true of an app that never wired the integration — deleting `<RouteNameSync/>` from `RootLayout.tsx:32` would have left this green and finding A's regression pin silently vacuous. The check now also runs the two-click misattribution probe from `FINDINGS.md` finding A (click into an issue, click its Comments tab ~400ms later, inside the 1s idle window) and REQUIRES a `bugsee.name_source: "route"` transaction to appear there — the only available positive evidence that `RouteNameSync`'s effect exists, fires, and reaches `setRouteName`. Deleting `<RouteNameSync/>` now turns this check RED. See `FINDINGS.md` finding A. |
| an error inside a `createResource` (fetcher rejects fetching a nonexistent issue) | reading the resource re-throws synchronously; caught by a local `<ErrorBoundary>` + `reportSolidError` | B | `verify.mjs`: `solid-resource-error` (`resource-error-fallback` renders AND an issue call is observed); `SSOLID-9`: message `404 no such issue: does-not-exist-404`, stack resolves to `src/api/client.ts:14` (the `req()` helper) — message and stack are both discriminating. **`Mechanism: programmatic` was also cited here and is withdrawn per depth-key rule 2** (it is the SDK default) |
| `@solidjs/router` NESTED routes (`/issues/:id` parent, `/` + `/comments` children via `props.children`) | both tabs render at their own URL; a hard (full-page) navigation straight to the nested URL resolves correctly | L | `verify.mjs`: `app-issue-detail`, `app-add-comment`, `app-nested-route-hard-nav`, `app-overview-tab` |

## Re-derived issue keys (closing sweep of this pass)

Every key cited above was re-read from staging after this pass's last source edit and dev-server
restart, via `list_issues` on the whole app (2 pages, 82 issues) plus `get_issue` where a message or
label was cited. `events_count` is CUMULATIVE across every sweep
this app has ever run — it is not a per-run figure; the values below were read immediately after
round 4's FOURTH and final closing sweep (2026-08-27T05:45Z). They are a point-in-time reading and will move on the next run — read them as "one issue, many events", never as a per-run figure.

Two of the per-sweep deltas are themselves evidence, and were measured, not assumed:
`SSOLID-80` (S12) moved **+2 on every sweep** for ONE click of the S12 control — `FINDINGS.md` finding
B's duplicate upload — while `SSOLID-47` (the dedupe control) moved **+1 on every sweep** despite the
control calling `logException` TWICE on the same instance each time, which is the dedupe working.
Round 4 ran FIVE sweeps against these two (one grounding sweep plus four closing ones) and both deltas
held exactly: `SSOLID-80` went **26 → 36** (+10 over five sweeps, never +1 and never +3) and `SSOLID-47`
went **18 → 23** (+5 over five). Across rounds 3 and 4 together that is now +2 on eleven consecutive
sweeps for `SSOLID-80` and +1 on eleven for `SSOLID-47`.

**Round-4 note on re-minting, because this pass is a counter-example to the rule above.** This pass DID
edit `ScenarioPage.tsx` (adding `disabled={!filtersInstalled()}` to the two S8 report controls) and yet
**not one of the 16 keys re-minted** — every row below is the same key round 3 recorded. The reason is
worth knowing before assuming an edit always re-mints: `solid-js` compiles an attribute binding like
`disabled={…}` into an `_$effect(…)` block emitted at the END of the component, and it adds no new
element, so `_el$N` numbering and every inline click handler's transpiled line/column — which is what
the stack signature is built from — are untouched. An edit re-mints only if it moves the throw site's
own transpiled position. (The dev server was also restarted for this pass, so modules still serve with
no `?t=`, as the note below describes.)

| Control / scenario | Current key | Previous key | Message the issue carries | `events_count` |
| --- | --- | --- | --- | --- |
| S4 `logException(new Error)` | `SSOLID-72` | `SSOLID-57` | `S4: logException(new Error(...))` | 18 |
| S4 `logException(string)` | `SSOLID-73` | `SSOLID-58` | `S4: a bare string throwable` | 17 |
| S4 `logException(object)` | `SSOLID-71` | `SSOLID-59` | `{"code":"E_SAMPLE","detail":"plain object throwable"}` | 17 |
| S4 `logException(null)` | `SSOLID-74` | `SSOLID-60` | `null` | 17 |
| S4 chained `cause` | `SSOLID-70` | `SSOLID-61` | `S4: top-level, chained via cause` | 17 |
| S4 `LogExceptionOptions` | `SSOLID-75` | `SSOLID-62` | `S4: with LogExceptionOptions` (labels `scenario-panel, s4-options`) | 17 |
| S4 dedupe (same instance twice) | `SSOLID-47` | `SSOLID-63` | `shared instance — logException twice must dedupe` | 23 |
| S4 storm (200 in ~1s) | `SSOLID-81` | `SSOLID-69` | `S4 storm #9` | 1297 |
| S5 uncaught (`window.onerror`) | `SSOLID-76` | `SSOLID-64` | `S5: uncaught exception outside any try/catch or ErrorBoundary` (`Type: Crash`) | 17 |
| S5 unhandled rejection | `SSOLID-77` | `SSOLID-65` | `S5: unhandled promise rejection` (`Type: Handled error`) | 17 |
| S8 report handler — mutate | `SSOLID-78` | `SSOLID-66` | `S8: report handler should mutate this` (labels `MUTATE_ME, redacted-before`) | 19 |
| S12 persist + recover | `SSOLID-80` | `SSOLID-68` | `S12: persist+recover across a hard reload` | 36 |
| Solid `reportSolidError` (direct) | `SSOLID-79` | `SSOLID-67` | `Solid: reportSolidError called directly` | 38 |
| S2 attribute before + after event | `SSOLID-40` | — (unchanged) | `S2: attribute set BEFORE and AFTER this triggering event` | 28 |
| Solid app-level `<ErrorBoundary>` | `SSOLID-7` | — (unchanged) | `ThrowingWidget(global): deliberate render-phase throw for ErrorBoundary` | 147 |
| Solid `createResource` rejection | `SSOLID-9` | — (unchanged) | `404 no such issue: does-not-exist-404` | 65 |
| **S8 report handler — VETO (this issue must NOT gain events)** | `SSOLID-82` — the counter-example, not a scenario key | — (never had one) | `S8: report handler should VETO this — must never arrive` | **1, and `updated_on` still 2026-08-26T21:42:37Z after all five of round 4's sweeps** |

The last row is not a scenario key — it is the round-4 counter-example (`FINDINGS.md` F-6). `SSOLID-82`
was raised by an UNGUARDED click of the veto control with no report handler installed; it is real,
correctly-uploaded data whose label merely reads alarmingly. Its `updated_on` has not moved since
2026-08-26T21:42:37Z and its `events_count` is still **1** across all five of this pass's sweeps, which
is the standing evidence that the veto itself works. `verify.mjs`'s `s8-report-veto-backend` now asserts
exactly that absence on every run, and the control is guarded so the click cannot be made again.

**None of the 16 currently carries a `?t=` cache-buster** — every frame is either a bare
`http://localhost:5307/src/…` URL or carries a vite *dep* hash (`?v=…`), which is a different thing.
That is the second re-minting direction the note at the top of this file describes: the dev server was
restarted for this sweep, so modules serve un-busted and each control's signature reverts to its
pre-HMR-edit form. Controls that already had a pre-edit issue rejoin it (`SSOLID-7`, `-9`, `-40`, `-47`,
some of them minted hours earlier and still accumulating events), which is why those four keys did not
move while the `SSOLID-57`…`SSOLID-69` cluster — frozen at `?t=1787759996030`, the moment of the edit
that minted it — receives nothing further. Note also what did NOT re-mint, in two different rounds and
for two different reasons: round 3's source edits touched only COMMENTS in `ScenarioPage.tsx`, and
comments are stripped before the module is served; round 4 changed real JSX (`disabled={…}` on the two
S8 report controls), which compiles to a trailing `_$effect(…)` and adds no element, so it moved no
click handler's transpiled position either. The rule that actually governs re-minting is narrower than
"any edit": **the signature moves only when the THROW SITE's own transpiled line/column moves.**
