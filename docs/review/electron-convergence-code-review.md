# Adversarial code review — Electron renderer incident convergence (R0–R5)

**Target:** `git diff 87405ab..HEAD` (commits `9aa1983`, `ac92246`, `86a3f7b`, `4bc3045`)
**Spec:** `docs/design/electron-renderer-incident-convergence.md` (as revised in `87405ab`) + `docs/review/electron-convergence-design-review.md`
**Method:** full read of every changed file; suites + typecheck re-run; per-package coverage re-run; five mutations applied (each verified applied by grep before trusting the result) and rolled back from `cp` backups. Tree verified clean at the end apart from this report.

## Verdict

**NOT SHIP-READY. The feature is inert at the join.** R1, R2 and R5 are real and well-pinned by their unit tests. R3 — the half that makes an incident exist at all — was never wired: `launch-main` passes no `onReport`, nothing anywhere submits a forwarded incident to the main client, and R4's handler is dead code imported only by its own test. The acceptance test (R0) is theatre — proven by mutation: with the entire R2 wiring reverted (the original SEV1 #2 behaviour restored), R0 still passes 4/4. On top of that, the per-package coverage gate is **red** on `@bugsee/electron` (new code in this diff), so the commits shipped with a failing CI gate.

## Is SEV1 #2 actually fixed?

**Half. The observable failure changed shape and arguably got worse.**

- (a) *Renderer uploads nothing* — **TRUE.** `launchRenderer` injects a forwarding pipeline (`packages/electron/src/launch-renderer.ts:83-93`); core routes **every** report path through it — `logException` (`packages/core/src/client.ts:620`) and detection submits (`packages/core/src/client.ts:641-646`) both funnel into the single `submitReport` choke point whose only pipeline call is `triggerPipeline?.report(handled)` (`packages/core/src/client.ts:474`). With the injected pipeline, the default assemble+upload is never even constructed (`packages/core/src/client.ts:342-343`). Mutation-verified (M-B, M-C, M-E all caught by unit tests).
- (b) *The incident reaches main* — **FALSE.** It reaches the main **receiver**, which routes it to `options.onReport?.(...)` (`packages/electron/src/main-receiver.ts:71`) — and `launch-main` never passes `onReport` (`packages/electron/src/launch-main.ts:101`: `createElectronMainReceiver({ ipcMain, store })`). The optional-call no-ops. The incident is silently discarded.

**Net effect of the five commits:** before, a renderer crash produced an empty bundle under a foreign session id — wrong, but *visible*. Now it produces **nothing anywhere**: no upload from the renderer, no report on main, and the renderer's `logException` even resolves `{ok:true}` (`packages/electron/src/renderer-report-pipeline.ts:63`) telling the app delivery succeeded. The headline promise still fails at exactly the moment that matters, now silently.

## Is the feature WIRED end-to-end?

**No.**

- `grep -rn onReport packages/electron/src/` — production hits are only the receiver's declaration/call (`main-receiver.ts:41,71`); every other hit is a test. No file constructs a `ReportingRequest` from a `DecodedReport`; neither the design's `client.submitReport(request)` nor the synthetic `DetectionProvider` (§4.3 said "Pick one in R3") exists. Design §4.3 — validate into a `ReportingRequest`, detection-style submit, per-renderer rate limit — is **entirely unimplemented**.
- `renderer-gone.ts` is imported by nothing but `renderer-gone.test.ts`. `LaunchMainOptions` (`packages/electron/src/launch-main.ts:39-51`) has no seam to receive `render-process-gone` events (no `app`/`webContents` argument), nothing supplies the handler's `marker()`, `submit`, or `source`, and it is not even exported for manual wiring. §4.5's windowId+time-bound dedup is also unimplemented.

This is precisely the Wave 0.1 trap named in the brief: green slices, fix not wired.

## Per-slice audit

### R0 — `packages/electron/src/renderer-convergence.e2e.test.ts`
**Theatre.** The design (§5, R0 row) and the test's own header (lines 9–16) demand three non-vacuity properties; the body delivers none:
1. *"pin the real `launchCore`"* — the test imports only `main-receiver`, `protocol`, `renderer-capture-store` (lines 17–21). No `launchRenderer`, no browser client, no trigger pipeline. Incidents are hand-posted over the wire (`postIncident`, lines 121–123). The stale comment at line 75 — "R2 will route this through the renderer's report pipeline. Until then nothing forwards it" — was never updated after R2 landed.
2. *"observe BOTH transports — nothing uploaded from the renderer"* — there is no upload transport in the test at all; "nothing uploaded" is vacuously true.
3. *"assert crash.json's shape and that there is exactly one"* — no bundle is ever assembled; the store-has-no-crash-entries check (lines 91–96) is a weak proxy.

The `onReport` stand-in (lines 53–58, self-labelled "Stand-in for what R3 wires") is exactly the hole the product has: production wires no `onReport`, and the test supplies its own, so the inert join is invisible. **Mutation M-E (remove `triggerPipeline` from `launchRenderer`'s launch options — i.e. restore the original defect): R0 passes 4/4.** Only `launch-renderer.test.ts`'s own unit tests fail. An acceptance test the acceptance-defect passes is not an acceptance test.

### Protocol — `packages/electron/src/protocol.ts`
The dedicated `report` kind (lines 127–190) is the right call and the design-review-forced change is present: reports bypass the capture store (`main-receiver.ts:68-74`), so no second `crash.json` and no rolling-window pollution — mutation M-A confirmed the tests pin the routing. But:
- **No unit tests**: `protocol.test.ts` has zero diff. `decodeReport`'s reject branches — malformed JSON (line 167), non-object `source`/`report` (line 174), non-finite/string `ts` (line 178) — are uncovered (coverage: `protocol.ts` 94.73% lines, exactly 167,174,178). These are the untrusted-input validation paths.
- **Validation is shallow** vs. design §4.3: "plain object" checks only (line 173) — no `ReportingRequest`-shape validation, no size/depth caps, `__proto__`/`constructor` own-keys pass through undisturbed.

### R5 — listener containment (`main-receiver.ts:60-88`)
**Real and correctly ordered before R3.** The whole listener body is inside try/catch; store throws, `onEntry`/`onReport` throws and decode throws all route to `onError`. Both new containment tests are genuine (they assert the error was captured *and* nothing escaped).

### R3 — `onReport` seam (`main-receiver.ts:41,66-74`)
The seam itself is correct (routes without `store.add`, passes `windowId`, mutation-pinned). **But R3 was "wire the join in launch-main" and no wiring exists** — see above. `DecodedReport.timestamp` is validated then consumed by nothing.

### R1 — `packages/browser/src/launch.ts:193-204,411`
**Correct and complete.** Additive option, threaded conditionally into `createClient` (line 411, mutation M-B caught by the new test). All three report paths go through it (choke point analysis above). Injection does not break the rest of the browser SDK:
- `flush()`/`stop()` still await forwarded reports — `track()` wraps the injected pipeline's promise (`client.ts:474`, `:392-393`).
- Report markers: put before / cleared after the pipeline settles regardless of which pipeline (`client.ts:462-485`); in the Electron renderer no marker store even exists, because `durableCapture` requires `options.captureStore === undefined` (`launch.ts:312`) and the renderer overrides `captureStore`.
- Durable queue/recovery: nothing enqueues, recover over an empty namespace is a no-op; the second new test pins the default path intact.

### R2 — `renderer-report-pipeline.ts` + `launch-renderer.ts`
Forwarding, never-upload, mechanism preservation, honest `{ok:false}` on no-bridge and on post-throw: all present and mutation-pinned (M-C). Caller-supplied `triggerPipeline` override is neutralized by spread order (`launch-renderer.ts:88-93`, test pins it). Two problems:
- **The handshake gate drops deliverable incidents** — see SEV2-1.
- **Open question 5 was "Decide before R2" and was not decided**: renderer `reportSnapshots` (viewtree — `captureViewHierarchy` default *true* — and D8 video) are never taken nor forwarded; the forwarded payload is `{source, report}` only (`renderer-report-pipeline.ts:58`). Renderer incidents will permanently lack the renderer's DOM viewtree once the join exists.

### R4 — `renderer-gone.ts`
Reason gating, claim-before-submit ordering (M-D caught), fallback semantics, containment, unref'd sleep: all correct **as a unit**. Poll budget accounting is exact at defaults — 21 harvests / precisely 2000 ms of sleep, no off-by-one (simulated); `Promise`-returning and throwing/rejecting harvests handled. But the unit is **unwired** (SEV1-2), the design-mandated dedup against R3 is absent, and the dump selection is unsafe (SEV1-4).

## SEV1

1. **R3 join not wired — renderer incidents are silently destroyed end-to-end.** `packages/electron/src/launch-main.ts:101` (no `onReport`); `packages/electron/src/main-receiver.ts:71` (optional-call no-op); no submit path exists anywhere (`grep onReport` / no `submitReport`-equivalent in the electron package). Failure scenario: any renderer uncaught error → forwarded → decoded → dropped; no issue on any session; app told `{ok:true}`.
2. **R4 not wired — dead code.** `packages/electron/src/renderer-gone.ts` imported only by its test; `launch-main.ts:39-51` offers no `render-process-gone` seam; `marker`/`submit`/`source` supplied by nothing; not exported. A renderer OOM/native crash produces no incident (and its §4.5 dedup obligation is unimplemented).
3. **R0 acceptance test proves nothing it claims.** `packages/electron/src/renderer-convergence.e2e.test.ts:17-21,53-58,75,91-96,121-123` vs. design §5 R0 row. Mutation-proven: full revert of the R2 wiring (the exact original defect) leaves it green.
4. **`dumps[0]` can claim — and destroy — the wrong crash's evidence.** `packages/electron/src/renderer-gone.ts:114-116` takes the first of ALL completed dumps; harvest has no per-crash/per-process/per-run filtering (`packages/electron/src/native-crash-source.ts:11-14,65-75` — "v1 SCOPE: harvest ALL completed dumps") and claim deletes (`native-crash-source.ts:79-84`). Concrete scenarios: (a) an earlier fallback deliberately leaves a dump unclaimed (`renderer-gone.ts:150-153` + test `renderer-gone.test.ts:127-131`) → the *next* renderer crash finds the stale dump on poll #1, attaches it to the wrong incident and deletes it — the earlier crash's evidence is gone and the new crash's real dump becomes a duplicate incident via next-launch recovery; (b) two concurrent `render-process-gone` → both harvest before either claims, both pick the same `dumps[0]`; the double-claim doesn't even throw (`native-crash-source.ts:81-83` is exists-guarded) so two incidents carry one renderer's dump; (c) GPU/utility-process dumps and unrecovered prior-run dumps live in the same `completed/` dir and are equally claimable. Latent only because R4 is unwired (SEV1-2).

## SEV2

1. **Pre-handshake incidents are dropped — deterministically for the most valuable class.** `packages/electron/src/renderer-report-pipeline.ts:49-52` + `packages/electron/src/launch-renderer.ts:85` (`canDeliver: () => handshaken`). The `session` reply needs two IPC hops, so a synchronous crash in the first task(s) after `launchRenderer` **always** precedes it → dropped, not buffered. Worse: `hello` is sent exactly once (`launch-renderer.ts:113`, no retry; plain `ipcRenderer.send`, `preload-bridge.ts:64-66`) — a renderer launched before `launchMain`'s `control.start()` never handshakes, so **every** incident from it is dropped forever while its capture streams up happily. The gate's stated rationale (`launch-renderer.ts:77-78`, "no main session to attribute an incident to") is false: the wire report carries no session id (`protocol.ts:148-149`) and main attributes to its own session; the receiver accepts reports regardless of handshake. Buffer-until-handshake (or gating on bridge-presence only) loses nothing. The design required only honest `{ok:false}` when the bridge is absent (§6.6), not dropping deliverable incidents.
2. **Design-mandated validation + per-renderer rate limit missing** (design §4.3; design review SEV2-6). No rate limit exists on the report path anywhere in the diff; `decodeReport` is plain-object-only (`protocol.ts:169-175`); no size caps. A looping/compromised renderer floods main at full IPC speed.
3. **Hot-path regression: every streamed capture entry is now JSON-parsed twice.** `main-receiver.ts:68` calls `isReport(raw)` — a full `JSON.parse` of the entire message including the payload (`protocol.ts:184-190`) — before `decodeStreamEntry` parses it again (`protocol.ts:85`). This defeats the codec's own stated hot-path constraint (`protocol.ts:4-5,34` — splice to avoid re-walking the payload). A cheap `raw.startsWith('{"k":"report"')` (encoder-controlled key order, `protocol.ts:149`) would restore single-parse for entries.
4. **Coverage gate RED on `@bugsee/electron` — introduced by this diff.** `pnpm --filter @bugsee/electron run test:coverage`: lines 98.83% (<100), functions 97.82% (<100) → **ERROR**. Uncovered: `protocol.ts:167,174,178` (new `decodeReport` reject branches — no protocol.test.ts additions at all) and `renderer-gone.ts:104-105,107` (branch 86.36% < 90 — the option defaults and the `onError` default are never exercised). CI's per-package coverage job fails this branch; the commits' implicit "gates pass" claim is false.
5. **Open question 5 ("Decide before R2") undecided and silently resolved to "lose the snapshots".** Renderer viewtree/pixel-video `reportSnapshots` are assembly-time features of the pipeline the renderer no longer runs; nothing pulls or forwards them (`renderer-report-pipeline.ts:58` forwards `{source, report}` only). Design: `docs/design/electron-renderer-incident-convergence.md` §6.5.

## SEV3

1. **`dumpPollMs: 0` (or negative) → infinite poll loop.** `renderer-gone.ts:118-122`: `waited` never reaches `deadline`; simulated 10⁶ iterations without termination. No lower clamp on the option (`:105`).
2. **Poll budget ignores harvest cost, and each poll eagerly reads every dump's full bytes.** `renderer-gone.ts:114` + `native-crash-source.ts:72-74` (`HarvestedDump.data` read for ALL dumps on every one of up to 21 polls); wall time can exceed `dumpWaitMs` by 21× the directory read cost.
3. **Binary report content does not survive the wire.** `encodeReport` (`protocol.ts:148-150`) `JSON.stringify`s the report — a `Uint8Array` attachment becomes a bloated `{"0":n,…}` object that nothing reconstructs; `ReportingRequest.id` is also dropped (dedup/idempotency key lost). Latent until R3 is wired.
4. **`DecodedReport.timestamp` is decoded and validated (`protocol.ts:176-179`) but consumed by nothing.**

## Test-quality assessment

Mutations run (each verified applied via grep before reading results; all rolled back from `cp` backups):

| Mutation | What it broke | Caught? |
|---|---|---|
| M-A: remove `onReport` routing (`main-receiver.ts:71`) | report join seam | **Yes** — 5 targeted failures (3 receiver + 2 R0) |
| M-B: remove `triggerPipeline` threading (`browser/launch.ts:411`) | R1 seam | **Yes** — the new seam test fails |
| M-C: bypass `canDeliver` (`renderer-report-pipeline.ts:49`) | gate semantics | **Yes** — 2 targeted failures |
| M-D: submit before claim (`renderer-gone.ts:158-163`) | claim ordering | **Yes** — the ordering test fails |
| M-E: remove R2 wiring from `launchRenderer` (restores SEV1 #2) | the whole feature | **Unit tests only** — `launch-renderer.test.ts` ×3; **R0 passes 4/4** |

Unit-level pinning is genuinely strong (the launch-renderer spread-order test, the receiver containment tests, and the renderer-gone ordering/fallback tests all kill their mutants). The failures are structural: R0 tests a hand-driven wire instead of the product (SEV1-3), no test exists that would fail on the unwired R3/R4 (the trap the brief named — nothing pins `launch-main` passing `onReport`, because it doesn't), and the new protocol functions have no direct tests (their reject branches are provably unexecuted per coverage). The commit-message claim of green gates is false for coverage (SEV2-4); typecheck and the plain suites are, this time, genuinely green (155/155 electron, 63/63 browser launch, `tsc --noEmit` exit 0 on both).

## Checked and found clean

- **R1 covers every report path**: single choke point `submitReport` (`core/client.ts:454-486`); `logException` → `:620`; detection submit → `:641-646`; sole pipeline call `:474`. No second path assembles or uploads.
- **Injecting the pipeline breaks nothing else in the browser SDK**: `track()` keeps `flush()`/`stop()` awaiting forwarded reports; markers put/cleared around whichever pipeline; renderer config has no marker store or durable queue by construction (`browser/launch.ts:312`); empty-queue `flush()` fine (pinned by the new fallback test).
- **The design-review-forced protocol change is present**: dedicated `report` kind; incidents bypass the capture store; no duplicate `crash.json`; no rolling-window pollution (`main-receiver.ts:68-74`, mutation-pinned).
- **R5 containment is real and ordered before R3** (`main-receiver.ts:56-88`; both throw-tests assert capture *and* non-escape).
- **Caller cannot restore local upload**: spread order `launch-renderer.ts:88-93`, test-pinned.
- **Honest failure semantics**: `{ok:false}` on no-bridge and on post-throw (`renderer-report-pipeline.ts:49-62`), per design review.
- **Claim-before-submit ordering correct** and test-pinned; claim-throw still submits with the dump.
- **Poll accounting has no off-by-one at sane values**: exactly ⌈waitMs/pollMs⌉+1 harvests and waitMs total sleep (simulated: 21 harvests / 2000 ms at defaults); `Promise`-returning, throwing, and rejecting harvests all fall back to a dump-less submit without losing the incident.
- **`encodeStreamEntry` hot path untouched**; entry validation (`t` closed set, numeric checks) unchanged.
- **Typecheck clean** on `@bugsee/electron` and `@bugsee/browser` (commit `ac92246`'s claim verified true this time).
- **Prototype pollution via `JSON.parse` is not directly exploitable**: parse creates own `__proto__` data properties, and no current consumer merges the decoded halves into live objects (kept as a validation note under SEV2-2 for when R3 wires).
