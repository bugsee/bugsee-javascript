# Scenarios — samples/webpack-sourcemaps

Every scenario in `docs/samples/PLAN.md` §4, plus this sample's own (§5.7 "Beyond the catalog" — the
webpack/source-map deep dive, items a–g). Verified against Bugsee staging app **`SWEBPACK`**
(`6a8ebe68a5966a45c7e9545c`).

Depth key (PLAN §4 "Verification depth"): **L** = local (no throw, app behaved) · **W** = wire (the
right request left the process, inspected via Playwright) · **B** = backend (confirmed via MCP
`list_issues`/`get_issue`).

## The source-map deep dive (§5.7 a–g) — the point of this sample

| Item | Control | Expected | Depth | Evidence |
| --- | --- | --- | --- | --- |
| (a) plugin options in full | `pnpm build*` variants (see README "Plugin options in full" table) | every `BugseePluginOptions` field observably changes behavior | L/W | `appToken`/`appVersion`/`appBuild`/`endpoint` forwarded to `bugsee-cli` (seen in its own stderr); `dryRun`/`disabled`/`deleteMaps`/`failOnError`/`onError` each independently verified — see README |
| (b) production build, `hidden-source-map` | `pnpm build` | a real `.map` on disk, no `sourceMappingURL` comment in the shipped bundle | L | confirmed: `dist/assets/main.<hash>.js` has no `//# sourceMappingURL=` comment; `dist/assets/main.<hash>.js.map` exists until deleted post-upload |
| (c) debug-ID injection | `pnpm build` | `//# debugId=<uuid>` comment + `_bugseeDebugIds` stub in the shipped bundle | L | **Re-derived against the shipped `dist/` (fix round 3, R3-5 — this row previously cited `e0c76509-3d6a-50ea-a949-e69f39d0a7ec`, a debug-id from a build that is no longer on disk, contradicting `README.md`'s own corrected value and making the documented reproduction not reproduce):** **re-derived AGAIN in the substrate-flip re-verification** (the replay-on-by-default flip changes the SDK bytes, so the previously quoted ids cannot exist on any build of the new substrate — see the note under row (e)): `grep -o "//# debugId=[0-9a-f-]*" dist/assets/main.*.js` → `//# debugId=7b429082-e493-591e-9587-9313da7d32dd` on `main.746af8f7.js` (build 5; the two lazy chunks carry `b3855d0c-802e-5ac7-8257-b2977448aaa2` on `37.30a16f57.chunk.js` — UNCHANGED across the flip, which is exactly why F-2 still fires on it — and `77ea89b3-9d5a-55d8-8a7b-bcbc022b1dcd` on `7.893cbe10.chunk.js`, the replay/rrweb chunk, whose id DID change with the substrate — one debug-id per chunk, not one per build). The pre-flip ids this cell used to quote were `f2cf373c-efcc-5fa0-9d48-6bba9dfd06c4` / `b3855d0c-…` / `fae8ae6a-212d-5673-aeb2-4a53549b65c9`; `_bugseeDebugIds` present (that string is ALSO present in `@bugsee/browser`'s own runtime code that READS it — see `FINDINGS.md` for why that alone isn't proof of injection; the `debugId` comment is the real signal). A debug-id is content-derived, so it changes with the bytes: re-derive it from `dist/` rather than quoting this cell after any rebuild. |
| (d) the upload step against staging | `pnpm build` | `bugsee-cli debug-files upload` succeeds; server confirms | W | `bugsee-cli`'s own stderr reports `uploaded debug_id=<id>` per uploaded map. **Corrected (fix round 3, R3-5):** this cell previously quoted `e0c76509-…`, which no chunk in the shipped `dist/` carries any more. **Re-run end to end in the substrate-flip re-verification, and this time the stderr evidence IS first-hand for the two chunks that matter:** `pnpm build` (build 5) uploaded `7.893cbe10.chunk.js.map` (`uploaded debug_id=77ea89b3-9d5a-55d8-8a7b-bcbc022b1dcd`) and then `main.746af8f7.js.map` (`uploaded debug_id=7b429082-e493-591e-9587-9313da7d32dd`) — both genuinely new bytes on the new substrate — before reaching the UNCHANGED `37.30a16f57.chunk.js.map` and aborting the batch with `DuplicateSymbolsFoundError`, exit 30, webpack exit 2. F-2 therefore still reproduces exactly as documented, and the ordering happened to be the favourable one this time (main uploaded before the abort), which the README's callout warns is not something the sample can rely on. The durable, re-derivable evidence that the map for the CURRENTLY shipped main chunk (`7b429082-e493-591e-9587-9313da7d32dd`, re-derived above) really is on the server is server-side, not stderr-side: issue `SWEBPACK-30` — thrown from exactly this `dist/` — reports `symbolication_status: "ready"` and resolves to original `.ts` sources (row (e)). **See `FINDINGS.md` F-1/F-2** for two real defects found while getting a fully clean run, and `README.md`'s "Production build" callout for why this build's own upload call is not reliably reachable (F-2's vendor-chunk abort) and how the counter-reset technique reproduces the already-uploaded bytes. |
| (e) **throw from the minified bundle; backend resolves original sources + line** | `pnpm preview` + `pnpm verify:sourcemaps` (clicks `s4-error` on the PRODUCTION build) | issue's stack reads the original `.ts` file + line, not a minified location | **B** | **issue `SWEBPACK-30`** (re-verified fix round 2 — supersedes `SWEBPACK-1`, whose stack cited the pre-drift line `:306`; see the S4 row below for the dev-mode-vs-production distinction) — `get_issue`: `Reason/message: S4: logException(new Error(...))`; `Stack trace: HTMLButtonElement.<anonymous> () (webpack://@bugsee-samples/webpack-sourcemaps/./src/scenarios.ts:375) [UserFrame]` — line 375 is the CURRENT `new Error(...)` call site (re-derived against the file as it stands after this round's edits); `symbolication_status: "ready"` in `list_issues`. **THE deliverable, fully verified, still true after every fix in this round.** **Re-verified end to end on the REPLAY-ON-BY-DEFAULT substrate (2026-08-27):** a fresh `pnpm build` (counter 5, main hash `746af8f7`, debug-id `7b429082-e493-591e-9587-9313da7d32dd`) + `pnpm preview` + `pnpm verify:sourcemaps` produced a new event on this SAME issue key — `get_issue SWEBPACK-30` now reports `app.build: "5"`, `symbolication_status: "ready"`, and the identical `.../src/scenarios.ts:375` `[UserFrame]` stack. So the flip changed the shipped bytes (every chunk hash moved) without disturbing the symbolication pipeline or the issue's grouping fingerprint. |
| (f) upload misconfigured (bad token) fails loudly | `pnpm build:bad-token-loud` | the whole build FAILS (non-zero exit), does not silently ship unsymbolicated | L | real exit code **2**; `BugseeCliError: ... failed (exit 21)`, CLI stderr: `app token rejected by server (ApplicationNotFoundError)`. Contrasted with `pnpm build:bad-token-soft` (`failOnError:false`, the library default): exit 0, `onError` fires, `.map`s survive (not deleted) — see README's option table |
| (g) CLI killed by a signal fails the build (regression guard) | `pnpm build:signal-kill` | the whole build FAILS; the historical `code ?? 0` defect does not resurface | L | real exit code **2**; `BugseeCliError: ... failed (exit -1)`, `code: -1`, `stderr: 'bugsee-cli was terminated by signal SIGKILL'` — `SIGNAL_EXIT_CODE` (`packages/bundler-plugin-core/src/run-cli.ts`) confirmed still mapping a signalled child to non-zero |

## S1 — Launch & lifecycle

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `/#/scenarios` → "isLaunched()" | `true` after `launchApp()` | L | `verify.mjs` initial state check |
| "Flush" (`s1-flush`) | `flush(5000)` resolves `true` | L | `verify.mjs`: `s1-flush` → `flush -> true` |
| "Call launch() again" (`s1-duplicate-launch`) | same client instance returned, not a 2nd launch | L | `verify.mjs`: `same instance returned: true` |
| "Relaunch minimal" (`s1-relaunch-minimal`) | `relaunch(MINIMAL_LAUNCH_OPTIONS)` — the caller passes NO options, so everything the sample does not itself pin stays at its SDK default. **Corrected (fix round 4, R4-6):** this row used to say `launch(token, {})` — "every option at its default" — which is not what runs: `relaunch()` (`src/bugsee.ts`) always spreads `endpoint`, `appId`, `appVersion`, `appBuild`, `onError` before the caller's options and `doLaunch` adds `carrier`, so SIX options are set. `endpoint` is mandatory here — a bare `launch(token, {})` would post to PRODUCTION, which PLAN §3 forbids | L | `verify.mjs`: `s1-relaunch-minimal` → `isLaunched: true`. **Strengthened (fix round 3):** the check matched the bare word `relaunched`, a hard-coded literal in the status template — it printed whenever `relaunch()` merely resolved. It now matches the interpolated `isLaunched: …`, read from the real `getClient()?.isLaunched()`. (Strengthened by construction — unlike `s3-event-wire`/`s9-set-route-name`/`s8-log-filter`, this one was not separately probe-proven: producing a `relaunch()` that resolves with a client that is NOT launched would have needed an invasive mutation of `relaunch` itself.) |
| "Relaunch full" (`s1-relaunch-full`) | `FULL_LAUNCH_OPTIONS` (`src/bugsee.ts`): every non-injectable field of `BugseeLaunchOptions` (`packages/browser/src/launch.ts`) **and** of the umbrella's `UmbrellaExtensionOptions` (`packages/bugsee/src/wire.ts`), with seven documented exclusions in three groups | L | `verify.mjs`: `s1-relaunch-full` → `isLaunched: true` (same strengthening as the row above). **Corrected (fix round 3, R3-6):** this row previously claimed "every `BugseeLaunchOptions` field set", which was false — `FULL_LAUNCH_OPTIONS` omitted `sdkVersion`, `replay`, `performanceFlushIntervalMs`, `pageName` and `tracePropagationOrigin`. The last three are now set; `sdkVersion` (would make every staging issue report a version the SDK is not — it feeds `user-agent: BugseeJS/<v>`, `packages/core/src/bugsee-api.ts:72`), `replay` and **all five** public OTel options (S13 N/A here) are deliberately left unset, each with its rationale in the `FULL_LAUNCH_OPTIONS` doc comment. **Re-corrected (substrate-flip re-verification):** the `replay` half of that sentence used to read "(S11 N/A here)", which is no longer true — session replay is now ON BY DEFAULT (`packages/browser/src/launch.ts`: `options.replay !== false && domDocument !== undefined`), so this sample records a session and ships `replay.bin` in every bundle regardless. `replay` is still left unset, but now precisely SO THAT the on-by-default behaviour is what gets observed (setting `replay: true` would make `s11-replay-file` unable to detect a default that flipped back) — see the rewritten S11 section below, which is no longer N/A. **Re-corrected (fix round 4, R4-5):** the exclusion list said "three" and named `otelExportUrl`/`otelHeaders`; the umbrella actually exposes FIVE OTel options — `otelExportUrl` (`packages/bugsee/src/wire.ts:109`), `otelExportHeaders` (`:111`), `otelExportResource` (`:113`), `otelConsume` (`:119`), `onOtelSpanProcessor` (`:121`) — and `otelHeaders` is not a field at all. `tracePropagationOrigin` (`wire.ts:102`), previously cited as part of that exclusion, IS set. The injectable test seams (`window`/`document`/`clock`/`scheduler`/`captureStore`/`triggerPipeline`/`systemProbe`/`systemMetricsSampler`/`bundleStore`/`locks`/`indexedDB`) are out of scope by design — this sample runs against the real browser runtime; `transport` is the one exception (the verification tee) |
| "stop(timeout) directly" (`s1-stop`) | `stop(2000)` resolves `true`; `isLaunched()` is `false` immediately after (§4 S1 requires `stop` exercised directly, not only indirectly inside `relaunch`) | L | `verify.mjs`: `s1-stop` → `stop(2000) -> true; isLaunched() after stop -> false`, then relaunches back to `FULL_LAUNCH_OPTIONS` for the rest of the sweep |

## S2 — Identity & attributes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `s2-set-user` | `setUserIdentifier` | L | `getUserIdentifier()` reflects the new value in-app |
| `s2-clear-user` | `clearUserIdentifier` / `getUserIdentifier() -> null` | L | confirmed `null` after clearing |
| `s2-attributes` | every `AttributeValue` type (string/number/boolean/string[]) | L | `getAllAttributes()` dump shows all 4, incl. `"list_attr":["alpha","beta","gamma"]` |
| `s2-get-clear-attribute` (new) | `getAttribute` reflects a set value; `clearAttribute` (singular) removes just that one key, not the whole set | L | `verify.mjs`: `s2-get-clear-attribute` → `getAttribute before clearAttribute: "present"; after: undefined` |
| `s2-clear-attributes` | `clearAllAttributes()` → `{}` | L | confirmed `{}` |
| `s2-attr-before-after` (new) | an attribute set BEFORE a report and a second attribute set AFTER it — two separate reports, each carrying only the attributes that existed at ITS trigger time (§4 S2: "attributes set before AND after the triggering event") | **W** | `verify.mjs`: `s2-attr-before-after` — 2 separate issue-create calls observed (chained: the 2nd fires only once the 1st's full upload round trip resolves). **Added (fix round 3):** the call COUNT alone never inspected attribute contents, so the "only the attributes that existed at ITS trigger time" half of this claim was unverified. New check `s2-attr-before-after-wire` reads the attribute snapshot out of each report's actually-uploaded `manifest.json` (the report-level `attrs` lives there, not in `request.json` — `ManifestJson.attrs`, `packages/protocol/src/wire.ts:150,154`, written by `packages/core/src/bundle-assembler.ts:188-196`; **corrected in fix round 6, R6-3** — the previous `wire.ts:141` citation pointed at `ManifestFileEntry`, the per-FILE inventory entry whose own optional `attrs` is at `:146`, which is not what the tee reads) and asserts report 1 carries `before_report_attr: "set-before"` and **no** `after_report_attr`, while report 2 carries both. A regression that snapshotted attributes at assembly time instead of submit time would fail it. **Corrected (fix round 5, R5-2):** that last sentence was FALSE as the control was then written. `after_report_attr` was set inside report 1's own `.then`, and that promise resolves only after report 1's FULL assemble+upload round trip — so the attribute existed at no point in report 1's lifecycle, and the "no `after_report_attr` on report 1" leg was green under submit-time, assembly-time and upload-time snapshotting alike. The other three legs were falsifiable; that one was not. `src/scenarios.ts:310` now sets the second attribute **synchronously**, immediately after firing report 1 and before it settles (edited line-neutrally — the transpiled module is byte-identical outside the handler and both `new Error` sites stay at `webpack-internal:///./src/scenarios.ts:283:28` / `:289:32`, so neither `SWEBPACK-19` nor `SWEBPACK-15` was re-minted). `logException` → `submitReport` is synchronous (`packages/core/src/client.ts:674`) and `submitReport` snapshots identity in that same turn (`const identity = liveIdentity()`, `client.ts:492`), so report 1 still carries only `before_report_attr` — but an assembly-time or upload-time regression would now pick the second attribute up and the leg goes red. **Falsifiability MEASURED, not argued:** an isolated probe timed the tee and read every manifest — report 1's bundle is assembled and uploaded **+3084 ms after the click** that set `after_report_attr` synchronously, and its `attrs` is `{build, sample, before_report_attr}`; report 2's (+3917 ms) and every later report's (e.g. `s8-report-mutate`'s) is `{build, sample, before_report_attr, after_report_attr}`. So the key really is live in the client's attribute store for the whole ~3 s during which report 1 is assembled and sent, and its absence from report 1's manifest is a property of WHEN the snapshot is taken — which is exactly what the leg now tests, and what it could not test before |
| — | the identity set at `launchApp()` time (`sample-user@bugsee.dev`) is queryable server-side | **B** | `list_issues(SWEBPACK, reporter_email: "sample-user@bugsee.dev")` returns `SWEBPACK-1` (created via a run that never touched the S2 controls, so its identity is unambiguous) |

## S3 — Manual telemetry

**Backend depth is BLOCKED for every row below** by the known `# Logs` MCP-surface gap
(`samples/FINDINGS.md`, browser-vanilla F-6, corroborated by `samples/fastify-api/FINDINGS.md:118`):
`get_issue(include_logs)` never renders a `# Logs` section on any issue in this sample's sweep, so none
of `log()`/`event()`/`trace()`/`addBreadcrumb()` can be confirmed to have reached a report **via MCP**.
**Corrected (fix round 2, F-C):** that gap blocks BACKEND verification only — it says nothing about
WIRE. `src/bugsee-transport.ts`'s tee parses the REAL uploaded bundle (the same mechanism S8's `-wire`
checks use), so S3 is verified at Local **and Wire** depth — not merely "client present: true" — via
the same `mutateBundle` the S8 wire checks already capture (the `s8-report-mutate` upload fires well
after every S3 control in the sweep, and nothing relaunches the client in between, so it carries all of
S3's real output). Backend depth remains blocked pending the SDK-side `# Logs` fix.

**Re-corrected (fix round 3, R3-1):** the round-2 wording above also claimed "the manifest's file list
alone proves `trace()`/`event()` produced their `traces.user.json`/`events.user.json` entries". That is
**false for `events.user.json`**: `captureInteractions: true` (`src/bugsee.ts`) makes the browser input
source map EVERY DOM click to an `events.user` entry (`packages/browser/src/input-source.ts:5-12`), and
this sweep clicks ~50 buttons — so that file is in the manifest whether or not `client.event()` ever
ran. **Reproduced by probe** (a run that clicks five unrelated controls and then forces a report, never
touching `s3-event`/`s3-trace`): the uploaded bundle still carried `events.user.json`, holding
`["focus","click","focus","click", …]` — 16 interaction entries and not one `event()` name — so the old
file-presence check returned `true`; `traces.user.json` was correctly ABSENT (which is why the sibling
`trace()` file-list check WAS falsifiable). Both `-wire` checks now parse the file and assert the
**real names and values** the S3 controls sent, which no interaction entry can satisfy: against that
same probe bundle the new `event()` assertion returns `false`.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `log()` × 5 levels | one log line per level | **L + W** | L: `verify.mjs`: `s3-log` — status line reports `client present: true` (not just a static `true`). **W:** `s3-log-wire` — the UPLOADED bundle's `logs.json` carries all 5 messages (`S3: error level` … `S3: verbose level`) |
| `event()` with/without params | `note_created`/`scenario_panel_opened` | **L + W** | L: `verify.mjs`: `s3-event` — `client present: true`. **W (re-corrected, R3-1):** `s3-event-wire` parses the UPLOADED bundle's `events.user.json` and asserts BOTH events by name — `scenario_panel_opened` with **no** `params` key, and `note_created` with `params: {via: "scenario-panel", count: 3}`. (Previously a manifest file-presence check, which could not fail — see the note above.) **Re-corrected again (fix round 4, R4-1 audit):** the `note_created` half selected the entry with `find(name === 'note_created')`, but `src/notes-app.ts:109` emits that same event name (`{via: 'new-button'}`) from the app-CRUD smoke that runs earlier in the sweep — the same positional-selection defect as `s8-network-filter-wire`. It now requires that SOME `note_created` entry carry both params, which the notes-app event cannot. |
| `trace(name, value)` | trace entry | **L + W** | L: `verify.mjs`: `s3-trace` — `client present: true`. **W (strengthened, R3-1):** `s3-trace-wire` parses the UPLOADED bundle's `traces.user.json` and asserts the real entry — `name: "render_ms"`, `value: 12.5` — not merely that the file is in the manifest |
| `addBreadcrumb()` — every field | type/category/message/level/data | **L + W** | L: `verify.mjs`: `s3-breadcrumb` — `client present: true`. **W:** `s3-breadcrumb-wire` — the UPLOADED bundle's `breadcrumbs` file carries the entry with `message: "S3: every field set"` and `data: {field: "value", n: 1}` |

## S4 — Exceptions

**Reading the keys below (noted in fix round 3, not a change to any claim).** The `SWEBPACK-3`…`-8`
keys cited in the non-`Error` rows are **frozen historical evidence**: each was current when its cited
`get_issue` content was read, and that content is what the row asserts. They are no longer the LIVE
dev-mode group for their control — earlier line-shifting edits to `src/scenarios.ts` re-minted those
fingerprints (the caveat in the first row below), so today's sweeps land on later keys for the same
controls. That is the documented dev-mode behavior, not a regression, and the frozen evidence stands.
Only the source-map deep dive's `SWEBPACK-30` (production, `hidden-source-map` + real symbolication) is
re-derived every round — it is the one that matters for this sample's deliverable.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException(new Error)` | issue, correct message + stack | **B** | `SWEBPACK-30` (prod, re-verified fix round 2 — supersedes `SWEBPACK-1`) — `get_issue`: message `S4: logException(new Error(...))`, stack resolves to the EXACT original `.ts` line (`src/scenarios.ts:375`, the CURRENT call site) via the source-map pipeline (the sample's actual deliverable — see the source-map deep dive table above). `SWEBPACK-2` (dev, frozen — not re-derived this round since dev-mode grouping is line-offset-sensitive and this exact historical frame is only being cited for the caveat below, not re-asserted as current) — message correct, but its stack frame (`webpack-internal:///./src/scenarios.ts:288:28`) was NOT the `new Error(...)` call site even at the time it was captured (that line was `:306` in the file version behind that evidence) — **corrected claim**: this was previously described as "correct stack location", which is wrong. Dev-mode frames report the position inside webpack's per-module wrapper under `webpack-internal://` (a fixed offset from the original source, not a resolved source-map position — there is no source-map resolution step in the dev-server path at all, unlike the production `hidden-source-map` pipeline). This is not an SDK bug; it is simply a different (unresolved) code path, and the dev-mode location should not have been described as "correct". **Corollary (fix round 2):** this offset-sensitivity means every `src/scenarios.ts` edit re-mints EVERY dev-mode issue's grouping fingerprint — an expected, recurring consequence of this sample's file structure (dev mode never resolves through the source map to a stable original line), not a new defect each time a fix pass touches the file. **Round-3 addendum:** it re-mints only on a LINE-SHIFTING edit. Fix round 3's two `src/scenarios.ts` changes were deliberately kept line-neutral (single-line replacements, both above the `s4-error` call site), so every key cited in this document survived the round unchanged — `list_issues(SWEBPACK)` still returns exactly 35 issues after three full sweeps, with no new key minted, and `SWEBPACK-30` still resolves to `src/scenarios.ts:375`, which is still the `new Error(...)` call site in the current file. Worth doing on purpose whenever a fix pass edits this file. |
| non-Error: string/object/null | 3 separate issues, all reported (not dropped) | **B** | `SWEBPACK-3` (`Handled String`), `SWEBPACK-4` (`Handled Object`), `SWEBPACK-5` (`Handled Null`) — confirmed via `list_issues` types |
| nested `cause` chain | a `Cause:` section in the report | **B** | `SWEBPACK-6` — `get_issue`: `Reason/message: S4: wrapped with cause`, followed by a `Cause:` section with the root error's own stack |
| `LogExceptionOptions` (mechanism/severity/labels) | labels + severity present | **B** | `SWEBPACK-7` — `get_issue`: `Labels: scenario-panel, s4-options`, `severity: "High"` in `list_issues` (matches the `severity: 'high'` passed) |
| same instance twice (dedupe) | 1 issue, not 2 | **B** | `SWEBPACK-8` — `get_issue`: message `shared instance — logException twice must dedupe`, single issue across repeated runs (`events_count` growing, not a new issue per click) |
| storm: 200 in ~1s | **hard-capped, not paced** (see `FINDINGS.md`'s corrected methodology note): the rate limiter (`packages/core/src/rate-limiter.ts`) admits at most 100 per rolling 60s and REFUSES the rest synchronously; app stays responsive; NOT all 200 land as separate reports | **W + B** | Wire: `s4-storm` relaunches to a clean rate-limit window, fires its own 200 calls, then awaits every one of the 200 tracked promises settling (`Promise.all`, no fixed sleep) and counts `r.ok === true` — this is MEASURED delivery, not the previous `200 - refused` arithmetic identity (which could not distinguish "delivered" from "admitted but silently dropped", and which a 2500ms-then-close sweep was too short to observe: the 100 admitted uploads take up to ~90s to drain through the bounded-concurrency queue). Settles `refused=100 delivered=100` every run (`scripts/verify.mjs`). Backend: `SWEBPACK-35` (superseding the frozen `SWEBPACK-9`/`SWEBPACK-24` — every edit to `src/scenarios.ts` re-mints the dev-mode `webpack-internal://` line offset this issue groups by; see the dev-mode caveat on the row above) — one issue (all 200 calls share one stack location), `events_count` **exactly 100** for the isolated run behind this evidence (bracketed: created empty, ended at 100 once the sweep's own wait confirmed the drain was complete) |

## S5 — Crashes

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| uncaught exception (`window.onerror`) | `Type: Crash`, `Trigger: crash`, `Mechanism: uncaught` | **B** | `SWEBPACK-31` (superseding the frozen `SWEBPACK-10`/`SWEBPACK-20` — see the dev-mode line-offset caveat under S4) — `get_issue`: exactly this; message `S5: uncaught exception outside any try/catch` |
| unhandled promise rejection | `Mechanism: unhandledrejection` | **B** | `SWEBPACK-32` (superseding the frozen `SWEBPACK-12`/`SWEBPACK-21`) — `get_issue`: `Trigger: error`, `Mechanism: unhandledrejection`, message `S5: unhandled promise rejection` |
| — | app survives the uncaught throw (page stays responsive, later controls still clickable) | L | `verify.mjs`'s `s5-uncaught-app-alive` check. **Corrected**: this previously asserted `pageErrors.length >= 1` — INVERTED, since that is true whether or not the app then survives (it only proves the throw happened at all; a page that died right after would satisfy it identically). Now proves responsiveness directly: immediately after the throw, `verify.mjs` performs a fresh real click (`s1-duplicate-launch`) and reads its freshly-updated status back, which only succeeds if the page is still interactive |
| `exitOnUncaught`/`unhandledRejections` modes | N/A — Node-only options, not in browser `BugseeLaunchOptions` | N/A | see `@bugsee/node`'s `node-service` sample instead |

## S6 — Console capture

**Backend depth is BLOCKED here** by the same `# Logs` MCP-surface gap as S3 above (console capture
feeds the same log stream) — whether a `console.*` call actually reaches a report's logs can't be
confirmed via `get_issue` today. **Wire depth is NOT blocked**, and until fix round 5 this section
wrongly behaved as though it were.

**Corrected (fix round 5, R5-1) — and the correction found a real SDK defect.** The first row below
carried the depth label `L/W` while the ONLY evidence it cited was `verify.mjs`'s `s6-console`:
Playwright's own console listener, which is purely **Local**. The prose here even said so (it "says
nothing about whether the entry survives into an uploaded bundle") while the table claimed `W` — a
straight internal contradiction. This is precisely the defect fix round 4's R4-2 split out of the six
S7 rows; R4-2 fixed S7 and left S6 — itself a CAPTURE scenario — untouched, and **that gap is what hid
a known SDK defect for four rounds**: `console.trace` is never captured at all. The evidence needed was
already in the same uploaded bundle the round-4 S7 wire rows read.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `console.log` / `.info` / `.warn` / `.error` / `.debug` | one log line each in the UPLOADED bundle, at the right level, AND still printed for real | **L + W** | L: `verify.mjs`: `s6-console` — Playwright's own console listener sees the real `S6:`-prefixed lines (interceptor is additive, doesn't replace). **W (new in round 5):** `s6-console-wire` — the uploaded `logs.json` carries all five with `source: "console"` and their mapped numeric levels (`packages/protocol/src/levels.ts:7-13`): `{"level":3,"message":"S6: console.log {\"a\":1}"}` (the object argument is stringified INTO the message, not dropped), `info` → 3, `warn` → **2**, `error` → **1**, `debug` → **4**. Asserting the level, not just the message, is what pins `DEFAULT_LEVELS`' mapping (`packages/capture/src/console-interceptor.ts:24-30`) — a message-only check cannot tell a correct mapping from one that filed everything as `info` |
| `console.trace` | **NOT captured — SDK defect.** The other five methods are captured; `console.trace` reaches no uploaded bundle on any runtime | **W** | `s6-console-trace-wire` — MEASURED absent from a real uploaded `logs.json` (five entries, not six). Root cause: `DEFAULT_LEVELS` (`packages/capture/src/console-interceptor.ts:24-30`) has no `trace` key, `:86` (`Object.entries(this.#levels)`) patches only the keys it holds, and `packages/browser/src/launch.ts:441` calls `createConsoleInterceptor()` with no override. Already filed by a peer sample — `samples/angular-spa/FINDINGS.md:429` (F-7, major) — and recorded in this sample's `FINDINGS.md` "Recurring" section as an independent reproduction. NB: that check DOCUMENTS the defect, so it goes RED the day the SDK is fixed; that is the signal to update this row |
| circular object | `console.log(circular)` does not throw | L | `verify.mjs`: `s6-circular` → `threw: false` |

## S7 — Network capture

**Corrected (fix round 4, R4-2).** Six rows in this table used to claim "captured" on the strength of a
check that read only the scenario panel's OWN status line — text the app's own `fetch`/`XMLHttpRequest`
produced. Every one of them stays green with `captureNetwork: false`; none of them was evidence of
capture. The evidence was already available: the bundle the tee records for `s8-report-mutate` is
uploaded after all of S7 and its `network.json` carries every one of these requests. Each row below now
splits the two claims — **L** for what the app itself observed, **W** for what the SDK actually
uploaded — and the W half was MEASURED off a real uploaded `network.json` before being asserted.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| fetch GET / POST JSON | app reads the real response unaltered; the request AND the echoed response body are captured | **L + W** | L: `verify.mjs`: `s7-get`/`s7-post-json` — status line shows the ACTUAL response body (`{"received":{"hello":"world","n":42}}`). **W (new in round 4):** `s7-post-json-wire` — the uploaded `network.json` carries the `before` entry with request body `{"hello":"world","n":42}` and the `complete`/`override` entry with response body `{"received":{"hello":"world","n":42}}` |
| 4xx / 5xx | app reads the real status; the request is captured WITH that status and the error body | **L + W** | L: `verify.mjs`: `s7-4xx`/`s7-5xx` → 404/500 from the app's own `fetch` (these two rows no longer claim capture — see the note above). **W (new in round 4):** `s7-4xx-wire`/`s7-5xx-wire` — the uploaded `network.json`'s initial (non-`override`) `complete` entry carries `status: 404` / `status: 500`, and the `override` amendment carries the real error body (`{"error":"not_found","message":"S7: deliberate 404"}` / `{"error":"internal","message":"S7: deliberate 500"}`) |
| connection failure | app catches it, no crash | L | `verify.mjs`: `s7-connfail` — real `fetch` to a closed port, caught |
| body over `maxNetworkBodySize` (2048) | the CAPTURED copy has its body DROPPED (never truncated to 2048 bytes); app reads the FULL body unaffected | **L + W** | L: `verify.mjs`: `s7-large-body` — 65536 chars read client-side, unaffected. **Re-corrected (fix round 2, F-E)**: the PREVIOUS correction here said this fetch "never becomes part of" an uploaded bundle and that truncation was unobservable at any depth — both false. Measured: `s7-large-body` then `s8-report-mutate` DOES upload a bundle whose `network.json` carries `/api/scenario/large-body` (three entries sharing one request id — `before`, the initial `complete`, and the body-read `complete` override amendment); the override entry reads `{"url":"/api/scenario/large-body","type":"complete","override":true,"custom":{"headers":{…},"no_body_reason":"size_too_large"}}` — no `body` field at all. And there is no truncation to begin with: `packages/capture/src/fetch-interceptor.ts`'s `readBoundedBody` (:159-188) DROPS an over-cap body entirely rather than cutting it to the cap. **W:** `s7-large-body-wire` asserts exactly this shape on the real uploaded bundle. |
| no `Content-Type` | body captured anyway, via `captureNetworkBodyWithoutType: true` | **L + W** | L: `verify.mjs`: `s7-no-content-type` — the app reads the body. **Corrected (fix round 5, R5-3):** this L check matched the substring `no Content-Type`, which is a hard-coded literal in the handler's OWN status template (`GET (no Content-Type) -> "…"`, `src/scenarios.ts:533`) — it printed whether or not a body came back, so it could only ever support "the handler ran without throwing", never "the app reads the body". It now matches `{"ok":true` out of the real response body (server-produced, and inside the template's 40-char slice). Class (a) of the round-3 literal-in-the-template audit; mitigated meanwhile by `s7-post-json`/`s7-large-body`, which do assert real body content. **W (new in round 4):** `s7-no-content-type-wire` — the uploaded entry's captured RESPONSE headers really do contain no `content-type` (asserted case-insensitively) and the body `{"ok":true,"note":"no Content-Type header on purpose"}` is present regardless — which is the option doing its job |
| XHR | captured on a different code path from fetch | **L + W** | L: `verify.mjs`: `s7-xhr` — the app's own `XMLHttpRequest` sees a 200. **W (new in round 4):** `s7-xhr-wire` — the uploaded entry carries `mechanism: 'xhr'` (`packages/capture/src/xhr-interceptor.ts:216`), status 200 and the response body. Selecting by `mechanism` is load-bearing: `s7-get` fetches the SAME `/api/scenario/text` url, so a url-only selector would be satisfied by the FETCH interceptor's entry and prove nothing about the XHR path |
| WebSocket | captured; real bidirectional traffic (presence channel) | **L + W** | **W (new in round 4):** `s7-ws-wire` — the uploaded `network.json` carries `mechanism: 'ws'` entries for `ws://localhost:5321/api/presence` covering the lifecycle (`before`, `open`) AND both directions (`message`/`direction: 'out'` for this client's `scenario-ping`, `message`/`direction: 'in'` for the server's welcome frame). L: `verify.mjs`: `s7-ws` — real message received. **Strengthened**: previously only asserted the status line was non-empty (any stray text would have passed); now asserts the EXACT expected protocol content — the server's `{"type":"welcome","message":"connected to presence channel"}` frame (this client's own `scenario-ping` is only ever broadcast to OTHER clients, so the one message it receives back really is that welcome frame) |
| SSE (`EventSource`) | captured | **L + W** | L: `verify.mjs`: `s7-sse` — 5 real server-sent events read by the app. **W (new in round 4):** `s7-sse-wire` — the uploaded `network.json` carries `mechanism: 'sse'` entries for `/api/scenario/sse`: `open`, at least 5 `message`/`direction: 'in'`, and `close` |
| `navigator.sendBeacon` | **NOT EXERCISED — scope note added in the substrate-flip re-verification** | — | `@bugsee/capture` gained a `sendBeacon` interceptor, wired into `installNetworkCapture`, since this sample was last verified. It is inert here: nothing in `src/`, `server/` or `scripts/` calls `navigator.sendBeacon` (verified by grep), so no `mechanism: 'sendBeacon'` entry can appear in any bundle this sample uploads, and no row above changed meaning because of it. Recorded rather than left silent so the next reader does not mistake the absence for a capture failure. Adding a control for it would mean editing `src/scenarios.ts`, which this pass deliberately did not touch (every edit there re-mints the dev-mode issue fingerprints this document cites — see the S4 caveat) |
| — | network entries are **not** visible via `get_issue` (documented MCP-surface gap, PLAN §6.6) — none of the above reaches Backend depth; Wire depth (the tee'd copy of the real uploaded bundle) is as deep as this scenario can be verified | — | — |

## S8 — Filters & redaction

**Strengthened in this fix pass**: every row below previously only asserted that the scenario panel's
OWN filter callback ran and logged what it saw (`s8-filter-log`) — real evidence that the callback
fired, but NONE of it proved the SDK actually **applied** the filter's return value to what got
uploaded. A mutation that discarded every filter's return value (shipping the UNREDACTED data anyway)
would have left all four rows below green. Per PLAN §6.6, `src/bugsee-transport.ts` now tees every SDK
network call to real staging while recording a parsed copy of each UPLOADED bundle in the page
(`window.__bugseeTee`); `scripts/verify.mjs` asserts on THAT — the actual bundle contents — for each row
below, in addition to the original in-app filter-log check (kept, since it's still real evidence the
callback ran). The `-wire` checks are new; the un-suffixed ones are the original in-app-log checks.

`setLogEventFilter`'s Backend depth remains blocked by the same `# Logs` MCP-surface gap noted under S3
— `get_issue` cannot confirm the redacted log line reached a report — but Wire depth now covers it via
the tee (the log DOES appear, redacted, in the actually-uploaded `logs.json`).

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `setNetworkEventFilter` — drop header + redact body field | filter fires, redacts the CAPTURED copy | **L + W** | L: `verify.mjs`: `s8-network-filter` — in-app filter log: `droppedSecretHeader=true redactedSsn=true`. **W — REWRITTEN (fix round 4, R4-1), it was broken in BOTH legs:** (1) it selected the entry with `network.find(url.includes('/api/scenario/echo'))`, which returns the FIRST match — and `s7-post-json` POSTs to that same url EARLIER in the sweep, so the check was reading S7's entry (`{type:'before', headerKeys:['Content-Type','traceparent','tracestate'], body:'{"hello":"world","n":42}'}`), never S8's. Proven by probe: with `s8-install` NEVER clicked, `s8-report-mutate-wire`/`s8-veto-network-wire`/`s8-log-filter-wire`/`s8-breadcrumb-filter-wire` all went red and `s8-network-filter-wire` stayed **green**, while S8's real entry still carried `x-secret-token`. (2) Even on the right entry, `!body.includes('123-45-6789')` could not fail: `ssn` is in the SDK's own default denylist (`packages/protocol/src/sensitive.ts:62`, `REDACTED = '<redacted>'` at `:6`), so the digits are scrubbed with no app filter at all — measured `{"ssn":"<redacted>"}`. **Now:** the check selects S8's own entry (the `before` stage of the echo POST whose body carries the `ssn` key — S7's body has no such key) and asserts values only the APP filter can produce: `Content-Type` still present, `x-secret-token` gone, body exactly `{"ssn":"[REDACTED]"}`. That discriminator is sound by the Android XOR rule (`packages/capture/src/network-provider.ts:137-139`) — a user network filter SUPERSEDES the built-in sanitizer, so `[REDACTED]` appears only when the app filter ran and `<redacted>` only when it did not; and `x-secret-token` is not in `SENSITIVE_HEADERS` (an exact-match list), so the SDK never drops it by itself. Both halves confirmed red in the no-filters probe |
| `setNetworkEventFilter` — veto | request dropped from capture entirely | **L + W** | L: in-app filter log: `network: VETOED …/scenario/text?veto-me=1` (the L check is anchored on the `network: VETOED` prefix as of round 3 — a bare `/VETOED/` would also be satisfied by the report handler's own `report: VETOED …` line). **W (new):** `s8-veto-network-wire` — the vetoed URL never appears in `network.json` in the UPLOADED bundle at all (not just edited — absent) |
| `setLogEventFilter` | secret redacted from the log line | **L + W** (Backend blocked — see note above) | L: in-app filter log: `log: redacted "leaking SECRET_TOKEN=abc123…"`. **Corrected (fix round 3, R3-3):** the L check matched a bare `/redacted/` against the WHOLE rolling `s8-filter-log` element, which by then already held the network filter's `redactedSsn=…` line from the `s8-network` click two controls earlier — so it passed with the log filter never firing. **Reproduced by probe:** install the filters, click `s8-network` only, never click `s8-log` — the element reads `network: /api/scenario/echo — droppedSecretHeader=true redactedSsn=true`, on which the old `/redacted/` returns `true` and the new `/log: redacted/` returns `false`. Now anchored on its own line prefix, `/log: redacted/`. **W (new in round 2):** `s8-log-filter-wire` — the UPLOADED bundle's `logs.json` carries the redacted message (`[REDACTED]`), never the raw `abc123` token (this is what kept R3-3 minor: the wire check always covered the real behavior) |
| `setBreadcrumbFilter` | secret redacted from breadcrumb data | **L + W** | L: in-app filter log: `breadcrumb: redacted data.secret` (also anchored on its line prefix in round 3, for the same rolling-log reason as the row above). **W (new):** `s8-breadcrumb-filter-wire` — the UPLOADED bundle's `breadcrumbs` file has `data.secret === '[REDACTED]'`, never the raw `shh` value |
| `setReportHandler` `before` — mutate | report proceeds, label ADDED | **B + W** | B: `SWEBPACK-33` (superseding the frozen `SWEBPACK-11`/`SWEBPACK-27` — see the dev-mode line-offset caveat under S4: every `src/scenarios.ts` edit re-mints the fingerprint this issue groups by, since dev mode never resolves through the source map to a stable original line) — `get_issue`: `Labels: MUTATE_ME, redacted-before` — directly visible (unlike react-spa's equivalent, Wire-only). **W (new):** `s8-report-mutate-wire` — the UPLOADED bundle's `request.json.labels` carries both labels directly |
| `setReportHandler` `before` — veto | **no issue created** | **B + W** | B: searched `list_issues(SWEBPACK)` across every sweep run for any issue with message `S8: report handler should VETO this` — **never found**. **W (new):** `s8-report-veto-wire` — no bundle-upload matching that summary is EVER recorded by the tee either, across every run |

## S9 — Performance / APM

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| manual `client.ext('performance').startTransaction()` + child spans + every `SpanStatus` | 6 child spans (`OK`/`ERROR`/`TIMEOUT`/`CANCELLED`/`DEADLINE_EXCEEDED`/`UNKNOWN`), transaction finishes `OK`, no throw | L | `verify.mjs`: `s9-manual-transaction` → `finished with 6 child spans`. **Corrected (fix round 2, F-D)**: every SDK call in this handler was optional-chained with the status text a HARD-CODED literal (`${statuses.length} child spans`) — if `ext('performance')` had returned `undefined`, every call would have silently no-op'd and the status would still have read "finished with 6 child spans". The handler now counts only children the SDK actually created AND finished with the requested status (`child.isFinished() && child.getStatus() === status`), and folds `perf`/`txn` presence + `txn.isFinished()` into `ok` — this control can now actually fail |
| `setRouteName` (direct call) | renames the active transaction | L | `verify.mjs`: `s9-set-route-name` → `perf present: true`. **Corrected (fix round 2, F-D)**: same shape as above (a hard-coded status regardless of whether `ext('performance')` resolved), PLUS a latent bug — `getClient()?.ext('performance').setRouteName(...)` was missing the `?.` before `setRouteName`, which would have THROWN (uncaught) rather than degraded, had `ext` ever returned `undefined`. Now optional-chained throughout and `ok` reflects `perf !== undefined`. **Re-corrected (fix round 3, R3-2):** round 2's fix was INCOMPLETE — the added `perf !== undefined` evidence went only into `setStatus`'s THIRD argument, which sets a CSS class (`src/scenarios.ts:19-24`), while `verify.mjs`'s `statusText` reads `textContent` only. The check still matched `/scenarios/manual`, a hard-coded literal in the status template, and nothing in the handler can throw (every call optional-chained) — so it still could not go red: with `ext('performance')` returning `undefined` the status would read `(perf present: false)` and the check would have PASSED. **Proven by mutation** (injected, measured, rolled back): forcing `perf` to `undefined` in the handler made the status read `setRouteName("/scenarios/manual") (perf present: false)` — the old check returned `true` on it, the new `/perf present: true/` returns `false`. It now matches `/perf present: true/`, which is interpolated from the real value. (Its sibling `s9-manual-transaction` was already sound — `6 child spans` is counted from `finishedChildren`, `src/scenarios.ts:619-622`.) |
| `performanceSampleRate: 0` (new) | relaunch with sampling disabled; client still launches and works | L | `verify.mjs`: `s9-sample-rate-0` → `isLaunched: true` after relaunch |
| `performanceSampleRate: 1` (new, restore) | relaunch with sampling back on | L | `verify.mjs`: `s9-sample-rate-1` → `isLaunched: true` after relaunch. (§4 S9 requires BOTH 0 and 1 exercised — previously only `1` existed, in `FULL_LAUNCH_OPTIONS`) |
| page-load / navigation / `http.client` spans | on-by-default via the umbrella | **N/A — unverified** | **Corrected claim**: this row previously asserted these spans are "present on every page load", but no check in this sample actually produces or inspects them — `@bugsee/performance`'s automatic instrumentation is wired on-by-default via the umbrella by CODE READ (`packages/bugsee/src/launch.ts`), not by an observation in this sample. Performance transactions aren't visible via `get_issue`, and this sample's wire tee doesn't parse `/v2/performance/transactions` payloads (unlike `samples/fastify-api`'s tee, which does). Downgraded from an asserted claim to "wired by construction, not independently observed here." |

## S10 — Distributed tracing

N/A — no natural second-hop Bugsee-instrumented service in this sample's scope (the local API,
`server/api-server.mjs`, is a plain unattributed fixture server, not a Bugsee sample of its own).
`propagateTrace`/`tracePropagationTargets` are set in `FULL_LAUNCH_OPTIONS` but no two-hop join was
attempted — matches `samples/react-spa`'s own documented reasoning for the same gap.

## S11 — Session replay

**NO LONGER N/A — rewritten in the substrate-flip re-verification.** This section used to read: "out
of scope by design (PLAN §5.7's packages under test are `@bugsee/webpack-plugin` /
`@bugsee/bundler-plugin-core`, not `@bugsee/replay`)". That rationale rested entirely on replay being
opt-in and this sample not opting in. Session replay is now **ON BY DEFAULT**
(`packages/browser/src/launch.ts`: `const replayEnabled = options.replay !== false && domDocument !==
undefined`), so the sample records a session and uploads `replay.bin` in **every** bundle whether or
not it is "in scope". Keeping the N/A would have meant this sample ships a recording of a real page —
including whatever a user typed — on every single report and asserts nothing whatsoever about it. The
scope argument survives only in the narrow form now stated at the end of this section.

Verification needs **no rrweb decoder**: `replay.bin` is exactly
`gzipSync(strToU8(JSON.stringify(payloads)))` (`packages/replay/src/encoder.ts:14-16`), so the tee
(`src/bugsee-transport.ts`'s `getReplayDigest`) recovers the ordered `eventWithTime[]` with
`@bugsee/util`'s `gunzipSync` + `JSON.parse` — a dependency this sample already had.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| replay is on WITHOUT the sample opting in (`s11-replay-file`) | the uploaded bundle's file list contains `replay.bin`, with `replay` never set in `FULL_LAUNCH_OPTIONS` | **W** | `verify.mjs`: `s11-replay-file`. Falsifiability MEASURED, not argued — with `replay: false` temporarily added to `FULL_LAUNCH_OPTIONS` (isolated probe, rolled back and md5-verified), `replay.bin` disappeared from the file list and this row went RED |
| the stream is playable, not merely present (`s11-replay-stream`) | it gunzips + `JSON.parse`s to a real rrweb stream: a Meta event (type 4), a FullSnapshot (2) AND incremental snapshots (3), every event timestamped | **W** | `verify.mjs`: `s11-replay-stream`. MEASURED off a real uploaded bundle before being asserted: 34 events, types `[2,3,4]`, 8 490 B gzipped → 78 688 B JSON, all timestamped. Requiring all three types is what separates a playable session from a file that merely exists — Meta-only has no DOM, and a FullSnapshot with no incrementals is a screenshot |
| fail-closed masking (`s11-replay-masking`) | neither of the two values TYPED into the notes app during the run appears anywhere in the decoded stream, while the DOM around them was recorded | **W** | `verify.mjs`: `s11-replay-masking`. `maskAllText`/`maskAllInputs` default TRUE (`ReplayLaunchOptions`), and the sample sets neither. The positive control (`note-title`, the `data-testid` of the very input the value was typed into, must be PRESENT) is what stops the two absences being vacuous. Falsifiability MEASURED: with `replay: { maskAllText: false, maskAllInputs: false }` temporarily set, both typed values appeared in the stream and this row went RED. This also exercises the typed-DURING-recording path — the note is deleted before the report fires, so the values survive only as incremental input events; that is the path on which a peer sample found `.bugsee-unmask` cannot re-open masking. It fails CLOSED, which is what is asserted here |

Two things this section deliberately does NOT do, and why:

- It does not drive `ReplayLaunchOptions`' own sub-fields (`maskAllText`, `blockAllMedia`,
  `blockAllCanvas`, `maskTextSelector`, `blockSelector`, `ignoreSelector`, `checkoutEveryNms`,
  `canvas`). THIS is what remains of the old scope argument: `browser-vanilla` and `react-spa` cover
  the option surface. What is verified here is the behaviour this sample cannot avoid — the
  on-by-default recording, its decodability, and its fail-closed defaults.
- It does not check the recording in the dashboard's player (**B** depth). The rrweb player is not
  reachable through the MCP surface this sample verifies backend claims with.

**Production-build consequence, newly true and worth stating:** because replay lazy-loads
(`@bugsee/browser` `import()`s `@bugsee/replay`), the production bundle now actually FETCHES the
185 KB `assets/7.<hash>.chunk.js` at runtime — a chunk that webpack has always emitted but which
nothing loaded before the flip. Verified on the real `pnpm build` output served by `pnpm preview`
(HTTP 200, `text/javascript`, no page errors, bundle PUT accepted). This matters here because
`scripts/serve-dist.mjs` falls back to `index.html` for any path it cannot find, so a mis-served lazy
chunk would surface as a runtime `SyntaxError` rather than a 404.

## S12 — Persistence & recovery

**Corrected 2026-08-26.** The control previously AWAITED `logException()` before reloading — since
that promise resolves only after the full assemble→enqueue→upload round trip completes
(`packages/core/src/client.ts` `submitReport`), the report had already been fully delivered in the
ORIGINAL session by the time the reload fired. That proved a normal report round-trips through
`flush`-before-navigate, which is real but is NOT §4 S12 ("data captured before a hard termination
still arrives on the NEXT start") — recovery had nothing to do. `SWEBPACK-13` (the old evidence,
message `S12: persist+recover across a hard reload`) is downgraded accordingly: it demonstrates a
normal report round-trip, not persist+recover.

The control now fires `logException()` WITHOUT awaiting it and reloads ~100ms later — before the
original upload can complete — so it is genuinely `recover:true` on the NEXT launch that delivers the
report. This is verified at **wire depth** (`scripts/verify.mjs`'s `waitForBundle` against
`window.__bugseeTee`, whose in-page state is wiped by the reload, so any bundle it records after that
point can only be the recovery-triggered re-upload, never the original interrupted attempt) AND at
**backend depth** via MCP.

| Control | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| `logException` (fire-and-forget) then reload ~100ms later (`s12-crash-and-reload`) | the report interrupted by the reload is delivered by the NEXT launch's recovery, not the original attempt | **W + B** | Wire: `scripts/verify.mjs` finds a bundle-upload PUT matching the report's summary recorded by the tee AFTER the reload (fresh page state), across every run. Backend: `SWEBPACK-34` (re-verified fix round 2 — supersedes `SWEBPACK-22`/`SWEBPACK-13`, each superseded in turn by a `src/scenarios.ts` edit shifting the dev-mode grouping fingerprint; see the S4 row's corollary above) carries the message `S12: persist+recover across a hard reload`. |
| — | **SDK defect found (see `FINDINGS.md` F-3):** the recovered report is delivered TWICE, not once — `events_count` increased by exactly 2 for the isolated run behind `SWEBPACK-34` too (0 → 2), never by 1. Real persist+recover works (the data is not lost), but it is currently duplicated — still reproduces after this round's fixes, which did not touch S12. **Root-caused in fix round 3** to `coexistence.recoverDeadSiblings` running two independent, un-deduped recovery legs over the same dead sibling (`packages/browser/src/launch.ts:516-538`; **corrected in fix round 5, R5-4** — the earlier `:511-534` citation started on a COMMENT line, exactly the defect R4-4 fixed in `FINDINGS.md`, leaving the two docs disagreeing; `FINDINGS.md`'s `:516-538` was the correct one), and the duplicate is now MEASURED on the wire (two separately-assembled bundles with different file sets, 768 ms apart) rather than inferred — see F-3. | **B + W** | `list_issues(SWEBPACK)` before/after single `pnpm verify` runs: `SWEBPACK-34` `events_count` 8 → 10 → 12 → 14 across three consecutive runs, +2 every time. Wire: the tee's full bundle list after the reload — see F-3 for the full measurement. |
| bundle queued while offline / two-tab coexistence | N/A — not attempted (out of scope for this pass, matches react-spa) | N/A | — |

## S13 — OpenTelemetry

N/A — `@bugsee/opentelemetry` is wired on-by-default via the `@bugsee/bugsee` umbrella `launch()`
(confirmed by code read, `packages/bugsee/src/launch.ts` → `wireUmbrella`), but no local OTel collector
was stood up for this pass — matches `browser-vanilla`/`node-service`'s designation as the
OTel-focused samples.

## S14 — Platform specifics

N/A — no webpack-sourcemaps-specific platform item beyond the source-map deep dive above (which IS
this sample's whole reason to exist, covered in its own table).

## App smoke (real functionality, not just the Scenario panel)

| Check | Expected | Depth | Evidence |
| --- | --- | --- | --- |
| App loads with a seeded note | real content on first load | L | `verify.mjs`: `app-loads` |
| Create a note | appears in the sidebar list | L | `verify.mjs`: `app-new-note` — asserts the sidebar DELTA (`count after === count before + 1`). **Corrected (fix round 6, R6-4):** was `count >= 3` against `src/storage.ts`'s 2-note seed, which reads as "at least 3 notes exist" and a changed seed satisfies with no note ever created |
| Live markdown preview | `**markdown**` → `<strong>markdown</strong>` | L | `verify.mjs`: `app-markdown-preview` — the `<strong>` is produced by `src/markdown.ts` from text this check itself typed, so it is not an app literal |
| "Suggest a prompt" | fetches from the local API, appends the API's own prompt to the body | L | `verify.mjs`: `app-suggest-prompt` — **rewritten (fix round 6, R6-4).** It asserted `body.includes('>')`, but the `> ` prefix is hard-coded in the app (`src/notes-app.ts:180`, `` `\n\n> ${data.prompt}` ``), so a `{}` response rendered `> undefined` and the row stayed green while this Expected claimed a real API fetch. The check now reads the actual `GET /api/prompt` response off the wire (`page.waitForResponse`) and requires the note body to END with exactly `\n\n> <that server-chosen prompt>` — a missing, empty or malformed response goes red |
| "Backup all notes" | POSTs the note set, local API echoes a count | L | `verify.mjs`: `app-backup` → `backed up N notes` where **N is asserted to equal the number of notes actually posted**. **Rewritten (fix round 6, R6-4):** it asserted only `/backed up/`, itself a hard-coded literal (`src/notes-app.ts:201`); the server-echoed `count` (`server/api-server.mjs:63-67`) that this Expected names was never checked, so an `{ok:true}` reply with no `count` rendered `backed up undefined notes` and passed |
| Delete a note | removed from the list, editor shows empty state | L | `verify.mjs`: `app-delete-note` — asserts BOTH halves (fix round 6, R6-4): the sidebar count drops by exactly 1, and the empty-state text renders. `Select a note` is an app literal but a *conditional* one — `renderEditor` emits it only on the empty branch — so it is real evidence for the second half; the first half had none until now |

## Full sweep result

`pnpm verify` (dev server, `pnpm dev` running): **80/80 passed** (76 → 80 in the substrate-flip
re-verification, which added the three `s11-*` replay rows and `wire-uploads-accepted`; 76 in rounds
5 and 6, 74 in round 4).

**Substrate-flip re-verification runs (2026-08-27)** — three end-to-end sweeps against real staging
after the edits below. The dev server was proven to be serving the CHANGED substrate *and* this pass's
own edits before any of them ran: the served `assets/main.js` contains
`options.replay !== false && domDocument !== void 0` (the new on-by-default gate), `sendBeacon` (the
new `@bugsee/capture` interceptor) and `JSON.stringify(needle).slice(1, -1)` (this pass's last edit to
`src/bugsee-transport.ts`). `node_modules` had to be removed and reinstalled to get there — a plain
`pnpm install` after `scripts/pack-local.mjs` silently kept the OLD tarballs, and the previously
installed `@bugsee/browser` still read `options.replay !== void 0 && options.replay !== false`.

| Run | Result | Wall clock | Notes |
| --- | --- | --- | --- |
| baseline (before any edit) | **76/76** | 2:05 | the pre-existing sweep, run FIRST against the changed substrate: nothing broke |
| 1 | **80/80** | 2:06 | 102 S3 PUTs, 0 rejected; 120 API calls, 0 not ok; replay stream 50 events / 9 213 B gz |
| 2 | **80/80** | 2:02 | 102 / 0; 120 / 0; 50 events / 9 225 B gz |
| 3 | **80/80** | 2:04 | 102 / 0; 120 / 0; 50 events / 9 233 B gz |

No check failed in any run, no check was flaky, and `node scripts/verify.mjs` exited 0 all three times;
`scripts/verify.mjs`'s md5 was identical before and after the block. **Issue count moved 35 → 36, and
the sweeps are not what moved it.** The new key, `SWEBPACK-36`, was minted by a one-off probe this pass
ran against a `pnpm build:dry-run` output (a production bundle whose maps are deliberately never
uploaded) to check that the production runtime path still works now that replay actually fetches its
lazy chunk. It is therefore an UNSYMBOLICATED issue —
`Handled Error at at HTMLButtonElement.<anonymous> (http://localhost:5322/assets/main.788a48b5.js:1:184731)`
— and it groups separately precisely because a minified stack cannot join the symbolicated group. It is
recorded here rather than quietly ignored; a reader comparing against the round-5/6 "held at exactly 35"
statements should expect 36 and this explanation. `SWEBPACK-30` itself was re-verified on a real
`pnpm build` (see the deep-dive table) and gained an event rather than a new key, and none of the three
sweeps minted anything.

**Round 6 runs** (four end-to-end sweeps against real staging, after the R6-1..R6-4 edits; the served
bundle was proven current first by decoding the dev server's `eval-source-map` `sourcesContent` for
`src/bugsee-transport.ts` and finding this round's edit in it):

| Run | Result | Notes |
| --- | --- | --- |
| 1 | **76/76** | final check LOGIC; comments added afterwards |
| 2 | **76/76** | final `scripts/verify.mjs` |
| 3 | **76/76** | final `scripts/verify.mjs` |
| 4 | **76/76** | confirmation; `scripts/verify.mjs` md5 asserted identical before and after the run |

No check failed in any of the four and `node scripts/verify.mjs` exited 0 each time.
`list_issues(SWEBPACK)` was **35 before and 35 after** the block, with `SWEBPACK-30` still at
`src/scenarios.ts:375` and the two S2 sites still `SWEBPACK-19`/`:283:28` and `SWEBPACK-15`/`:289:32`
(each +1 events per run, on the pre-existing key) — no key re-minted. Round 6 did **not** touch `src/scenarios.ts` at all (only `scripts/verify.mjs`, docs,
and one comment in `src/bugsee-transport.ts`). Independent evidence that the rewritten
`app-suggest-prompt` really reads the server: runs 1 and 3 printed *different* server-chosen prompts
(`"Write down the last drea…"` vs `"What is the smallest dec…"`), which a hard-coded literal cannot do.

**Round 5 runs (retained):** a peer sample was found to be only ~60% green when re-run five times after
reporting 100% from a single run, so that round's sweep was run **six times end to end** against real
staging (three were required) and EVERY result is recorded, not just the best one:

| Run | Result | Wall clock |
| --- | --- | --- |
| 1 | **76/76** | 2:04 |
| 2 | **76/76** | 2:03 |
| 3 | **76/76** | 2:07 |
| 4 | **76/76** | — |
| 5 | **76/76** | — |
| 6 (post-edit confirmation, docs/comments only since run 5) | **76/76** | — |

No check failed in any run and no check was flaky; `node scripts/verify.mjs` exited 0 all six times.
`list_issues(SWEBPACK)` held at exactly **35** issues across the run block, with
`SWEBPACK-30`/`src/scenarios.ts:375` intact. Round 5 DID edit `src/scenarios.ts` (R5-2, one handler at
`:306-311`), so fingerprint stability was verified directly rather than assumed, twice over:
**statically**, by diffing the transpiled `webpack-internal:///./src/scenarios.ts` module served by
webpack-dev-server before and after the edit — **630 lines both times, byte-identical outside that one
handler**, with both S2 `new Error` sites still at `:283:28` and `:289:32`; and **on the backend**,
where `SWEBPACK-19` (`:283:28`, report 1) and `SWEBPACK-15` (`:289:32`, report 2) each moved
`events_count` 22 → 27 across the first five runs — **+1 per run each, on the pre-existing keys**, with no
new key minted. Round 4 (67 → 74) added the seven `s7-*-wire` capture checks and changed no line of
`src/scenarios.ts` at all. **Corrected (fix round 2, F-H):** this previously said "61/61" and "five new
`s8-*-wire` checks" while a few lines below it separately (and correctly) counted "6" — an internal
contradiction; there were always 6 `s8-*-wire` checks (`s8-report-mutate-wire`,
`s8-network-filter-wire`, `s8-veto-network-wire`, `s8-log-filter-wire`, `s8-breadcrumb-filter-wire`,
`s8-report-veto-wire`), never 5. This round added 5 more wire checks (`s3-log-wire`,
`s3-breadcrumb-wire`, `s3-trace-wire`, `s3-event-wire`, F-C; `s7-large-body-wire`, F-E) plus the
storm's own re-measurement (F-B) and the S9 evidence fixes (F-D), bringing the total from 61 to 66.
Fix round 3 added one more (`s2-attr-before-after-wire`, 66 → 67) and — more importantly — went through
EVERY check in `scripts/verify.mjs` hunting one specific hazard: **a check that asserts on a substring
which is a hard-coded literal in the status template, rather than on a value derived from what the SDK
actually did**. Four such checks were found and fixed (`s3-event-wire`, `s9-set-route-name`,
`s8-log-filter`, and both `s1-relaunch-*`); each is documented in its own row above. Three of the four
were then PROVEN falsifiable by an actual probe/mutation run (old check green, new check red on the same
observation — see their rows); the `s1-relaunch-*` pair is strengthened by construction only. Two more
checks were tightened defensively for the same reason without having been demonstrably broken:
`s8-veto-network` (`/VETOED/` → `/network: VETOED/`, since the report handler also logs a `report:
VETOED …` line) and `s8-breadcrumb-filter` (anchored on its `breadcrumb:` prefix). The audit question
for every remaining check was "what would have to break for this to go red?", and each surviving check
now answers it with a value the SDK produced (a status line interpolating a real return value, a real
protocol response, a real network-call count, or bytes read out of an uploaded bundle).

**Corrected (fix round 4).** That last sentence was not yet true when it was written: `s8-network-filter-wire`
survived all three rounds while reading the WRONG network entry AND asserting something the SDK
guarantees on its own (R4-1 above). Round 4 fixed it, and — because the root cause was **positional
selection** (`Array#find` returning an earlier control's entry rather than this control's) — swept every
`find(...)` over `bundle.network` and the other rolling arrays for the same shape. `/api/scenario/echo`
was the one collision (`s7-post-json` vs `s8-network`; a peer sample, angular-spa, grew the identical
defect independently on the identical url), and `/api/scenario/text` collides three ways (`s7-get`,
`s7-xhr`, `s8-veto-network`'s `?veto-me=1`), so the checks touching it discriminate on `mechanism`
and/or the query string. The remaining selectors were re-checked and are unique by construction — the
audit is recorded inline in `scripts/verify.mjs`. **The audit found one more real instance:**
`s3-event-wire` selected `userEvents.find(name === 'note_created')`, and `src/notes-app.ts:109` ALSO
emits `note_created` (with `{via:'new-button'}`) from the app-CRUD smoke that runs long before S3 — the
check passed only because `s1-stop`/`s1-relaunch-*` happen to reset the capture store in between, an
accident of sweep order rather than a property of the check. It now requires that one of the
`note_created` entries carry BOTH params `s3-event` sent, which the notes-app event never can. Round 4
also split the six S7 rows that claimed "captured" while asserting only app-side status text (R4-2),
taking the run from 67 to 74 checks.

**Corrected (fix round 5).** R4-2 swept the S7 rows for "claims capture, asserts app-side text" and
stopped there — it left **S6**, itself a capture scenario, with a `L/W` depth label backed by nothing
but Playwright's own console listener. That single missing check is what hid a real, already-filed SDK
defect (`console.trace` is never captured — see the S6 section and `FINDINGS.md`'s Recurring entry) for
four rounds: nothing in the sweep ever looked at what console capture actually uploaded. Round 5 added
`s6-console-wire` and `s6-console-trace-wire` (74 → 76), fixed the second of the two literal-in-the-
template survivors of the round-3 audit (`s7-no-content-type`, R5-3), and replaced an **eleventh**
unfalsifiable check form — `s2-attr-before-after-wire`'s "only" leg, whose own stated rationale was
wrong (R5-2, detail in the S2 row above).

**Corrected again (fix round 6, R6-4) — and the round-5 lesson repeated itself one more time.** R5-3
fixed the app-literal class in `s7-no-content-type` and stopped at that scenario, exactly as R4-2 had
stopped at S7. The block it never reached was the **app-smoke CRUD block at the top of the sweep**, and
two rows there were still in the class: `app-suggest-prompt` asserted `.includes('>')` (the `> ` prefix
is hard-coded at `src/notes-app.ts:180`) while claiming a local-API fetch, and `app-backup` asserted
`/backed up/` (hard-coded at `src/notes-app.ts:201`) while claiming the API "echoes a count" that was
never read. Both were **measured green on a degraded API** in an isolated `page.route` probe — body tail
`"\n\n> undefined"`, indicator `"backed up undefined notes"` — and both now go red there. Round 6 then
did the sweep the previous three rounds each deferred: **all 76 checks were classified** by where the
asserted value originates (wire / staging traffic / local API / interpolated SDK return / conditional app
literal), and the audit is written out in full at the top of `scripts/verify.mjs`. Result: no check
outside the app-smoke block is still in the class; `app-new-note` and `app-delete-note` were tightened
in the same pass (a sidebar DELTA in place of a `>= 3` threshold, and the previously unasserted "removed
from the list" half). Round 6's other three fixes were documentation accuracy, not check strength:
the F-3 mis-explanation of angular-spa's +1 (R6-1), three wrong `angular-spa/FINDINGS.md` line
citations (R6-2), and the `wire.ts:141` `attrs` citation that pointed at `ManifestFileEntry` instead of
`ManifestJson` (R6-3).

See `FINDINGS.md` for:
- the one methodology bug found and fixed in `scripts/verify.mjs` itself in the ORIGINAL build pass
  (S4-storm stragglers contaminating a later assertion — not an SDK defect);
- the corrected S4-storm understanding (hard cap, not pacing) from an earlier fix pass, and the
  measured-not-derived delivery count from THIS pass (F-B);
- **F-3**, a new SDK defect found while implementing S12 for real: persist+recover delivers one
  incident TWICE.

Of the 80 checks, **all 80 are Local/Wire** — `scripts/verify.mjs` makes zero MCP calls; it is a
Playwright script driving the real app against real staging over HTTP, nothing more. **Corrected (fix
round 2, F-H):** this previously said "4 assert Backend content via MCP", which overstated what the
automated sweep proves — the Backend (`get_issue`/`list_issues`) evidence cited throughout this
document (the `SWEBPACK-*` issue keys) comes from separate, hand-run MCP calls made while writing this
document, not from anything `pnpm verify` itself asserts on. 24 of the 80 checks assert on the actual
bytes of an UPLOADED bundle via the wire tee (`src/bugsee-transport.ts`) rather than merely the
scenario panel's own filter-callback log — the 6 `s8-*-wire`, the 4 `s3-*-wire`, round 3's
`s2-attr-before-after-wire`, the 8 `s7-*-wire` (`s7-large-body-wire` plus round 4's
`s7-post-json-wire`, `s7-4xx-wire`, `s7-5xx-wire`, `s7-xhr-wire`, `s7-no-content-type-wire`,
`s7-ws-wire`, `s7-sse-wire`), round 5's 2 `s6-console*-wire`, and the substrate-flip pass's
3 `s11-*` rows (`s11-replay-file` reads the uploaded manifest's file list; `s11-replay-stream` and
`s11-replay-masking` read the decoded bytes of the uploaded `replay.bin` itself); a 25th,
`s12-crash-and-reload`, asserts on the EXISTENCE of a tee-recorded bundle after the reload rather than
on its bytes.

**All of them were strengthened in the substrate-flip pass.** `waitForBundle` now considers only
bundles whose S3 PUT was ACCEPTED (2xx). Until then `CapturedCall.status` was recorded by the tee and
read by ZERO checks, so every "the UPLOADED bundle carries X" row actually asserted "the bundle the
SDK SENT carried X" — measured: with the presigned PUT forced to 500 in an isolated probe, the tee
still parsed the bundle and every one of these rows would have stayed green. The identical hole
existed on the API side (`bugseeCalls[].ok` computed and never read); `isAcceptedIssueCall` closes it
for the 11 rows that claim a report was FILED, and `wire-uploads-accepted` reports the aggregate. The remainder assert Local evidence from the real running app
(client presence, actual protocol responses, real click-driven state changes) rather than a fixed
`true` or a bare non-empty status string.
