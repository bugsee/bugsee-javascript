# Adjudication — does `registerReplay` drop caller masking options?

**Adjudicated:** 2026-07-26
**Verdict:** Both correct in different scopes
**One-line ruling:** `registerReplay` does **not** drop any caller masking option — every option reaches rrweb intact on the only production path (Review 2's measurement is correct and independently reproduced) — but Review 1's actual finding was never a production claim: it is a *test-strength* claim that a mutation at `packages/replay/src/register.ts:48` is undetectable, and that claim is correct and reproduces exactly, in fact more broadly than Review 1 reported (it survives **every** suite in the repo, including the RP6 e2e).

## Executive correction to the framing

The "direct contradiction" is largely an artifact of paraphrase, plus one genuine error by Review 2.

1. **Review 1 never claimed production drops options.** Its finding (`replay.md:156-160`) is filed under the `## SEV3` heading (`replay.md:154`) and reads: *"Test theater: `registerReplay` ignoring ALL caller masking options **survives the full suite**"*, with the body *"**Mutating** `register.ts:48` from `resolveReplayMaskingOptions(options)` to `resolveReplayMaskingOptions({})` … **SURVIVED**: 33/33 still passed."* That is a statement about test coverage, not about shipped behavior. **There is no false SEV1 in the review record** — the finding was correctly ranked SEV3 by its author.
2. **Review 2's measurement is right, but its rebuttal is invalid.** Its verdict claims *"a control mutation that drops the caller's options is caught by the existing suite"*. Its control mutation M1 (`browser.md:89`) is at `packages/browser/src/launch.ts:465` — a **different file, different package, different suite** from `register.ts:48`. `launch.test.ts:51` mocks `@bugsee/replay` outright, so the browser suite is *structurally incapable* of executing `register.ts:48`. M1 cannot refute Review 1's mutation.
3. **Review 2 contradicts itself.** Its own caveat (`browser.md:110`) states: *"no test in the repo exercises this chain. `launch.test.ts:51` mocks `@bugsee/replay`; `replay`'s own tests inject a fake `record`. Each side is verified against a mock of the other — exactly the seam shape that let the … option-drop hide."* That **is** Review 1's finding, conceded verbatim two paragraphs after being declared "DISPROVEN".

Neither review is wrong about what it measured. Only Review 2's *rebuttal sentence* must be withdrawn.

## Options data-flow trace

Traced from `launch(token, { replay: {…} })` in `@bugsee/browser` to the rrweb `record()` call.

| hop | file:line | options intact? | notes |
|---|---|---|---|
| 1. user entry | `packages/browser/src/launch.ts` (`launch` → `launchCore`) | yes | `options.replay` carried unmodified |
| 2. enablement gate | `packages/browser/src/launch.ts:386` | yes | `replay !== undefined && replay !== false`; no option mutation |
| 3. normalize `true` → `{}` | `packages/browser/src/launch.ts:450-451` | yes | `typeof options.replay === 'object' ? options.replay : {}` — `true` becomes `{}`, so `replay:true` and `replay:{}` are provably the same input downstream |
| 4. canvas destructure | `packages/browser/src/launch.ts:452` | yes | `const { canvas: canvasOption, ...replayMasking }` — strips **only** `canvas`. `blockAllCanvas` is a distinct key and is **not** stripped |
| 5. lazy import | `packages/browser/src/launch.ts:454` | yes | `import('@bugsee/replay')`; failures routed to `onError` at `:469` |
| 6. canvas resolve | `packages/browser/src/launch.ts:459-463` | yes | `createCanvasRecordConfig` (opt-in only) |
| 7. call site | `packages/browser/src/launch.ts:464-467` | yes | `{ ...replayMasking, ...(canvas !== undefined ? { canvas } : {}) }` — full spread, nothing dropped |
| 8. entry signature | `packages/replay/src/register.ts:41-45` | yes | `options: RegisterReplayOptions = {}` |
| 9. **the disputed line** | `packages/replay/src/register.ts:48` | **yes** | `masking: resolveReplayMaskingOptions(options)` — the caller's object is passed **straight through**. No defaulting, shadowing, or filtering |
| 10. cadence + canvas | `packages/replay/src/register.ts:49-52` | yes | `checkoutEveryNms` / `canvas` forwarded via conditional spread |
| 11. resolver | `packages/replay/src/masking.ts:97-127` | yes | `??` defaults only fill *absent* keys (`:100-103`); `joinSelectors` **appends** caller selectors to Bugsee's floor (`:115,119,124,126`) |
| 12. recorder ctor | `packages/replay/src/recorder.ts:58-64` | yes | stores `options.masking` |
| 13. rrweb invocation | `packages/replay/src/recorder.ts:67-81` | yes | `this.#record({ ...this.#masking, ...this.#canvas, checkoutEveryNms, recordCrossOriginIframes:false, emit })` |
| 14. record seam | `packages/replay/src/register.ts:47` | yes | `options.record ?? rrwebRecord` — real rrweb by default |

**Zero drop points.** The single surface asymmetry is that `unmaskTextSelector`/`unblockSelector` exist on `ReplayMaskingOptions` (`masking.ts:69-71`) but are not exposed by browser's `ReplayLaunchOptions` — an unreachable-option gap (Review 2's SEV3 #9), **not** a drop of anything the user can actually set.

## Every `registerReplay` caller

Repo-wide `grep -rn 'registerReplay' packages --include='*.ts' --include='*.tsx'` (excluding `dist/`, `coverage/`).

| caller | file:line | options survive? | used by real consumers? |
|---|---|---|---|
| `@bugsee/browser` launch (**sole production caller**) | `packages/browser/src/launch.ts:464` | **yes — measured, all options** | **yes.** Every browser customer. Also every **Electron renderer**, which routes through `@bugsee/browser`'s `launchCore` (`packages/electron/src/launch-renderer.ts:10`) |
| `@bugsee/replay` own unit tests | `packages/replay/src/register.test.ts:30,43,56,64,77,96` | yes (injected fake `record`) | no — test only |
| `@bugsee/replay-canvas` integration test | `packages/replay-canvas/src/integration.test.ts:5` | yes | no — test only |
| `@bugsee/browser` launch tests | `packages/browser/src/launch.test.ts:50-51` | n/a — `vi.mock`'d test double; the real function never runs | no — test double |
| `@bugsee/electron` | — | n/a | **zero** references to `@bugsee/replay`/`registerReplay` in `packages/electron/src` |
| `@bugsee/webview` | — | n/a | **zero** references |
| `@bugsee/webworker` | — | n/a | **zero** references |
| any other adapter | — | n/a | none. Only `browser`, `replay`, `replay-canvas`, `instrumentation-tests` even depend on `@bugsee/replay` |

There is exactly **one** production path, and its options survive. `registerReplay` is exported from `packages/replay/src/index.ts`, but `@bugsee/replay` is `"private": true` and is not an independently-installed customer surface.

## Empirical results

**Method:** a temporary jsdom probe in `packages/browser/src/` booted the **real** `launch()` with `@bugsee/replay` **unmocked** — real `registerReplay`, real `resolveReplayMaskingOptions`, real `ReplayCaptureProvider.onStart` — and captured the literal object handed to `record()`. rrweb was replaced **only** at its documented seam (`register.ts:47`, `options.record ?? rrwebRecord`), injected through the same `...replayMasking` spread the masking options themselves ride, so no hop is bypassed. Probe deleted; `git status --short packages/` verified empty.

| input | observed rrweb config (key fields) | masking effective? |
|---|---|---|
| `replay: true` | `maskAllText:true, maskAllInputs:true, maskInputOptions:{password:true}, maskAttributeFn:function, maskTextSelector:".bugsee-mask,[data-bugsee-mask]", blockSelector:".bugsee-block,[data-bugsee-block],img,svg,image,video,audio,object,picture,embed,map,source,iframe", ignoreSelector:".bugsee-ignore,[data-bugsee-ignore]", checkoutEveryNms:60000, recordCrossOriginIframes:false` | **yes — full fail-closed floor** |
| `replay: {}` | **byte-identical to `replay: true`** | **yes** |
| `replay: { maskAllText: false }` | `maskAllText:`**`false`**, `maskAttributeFn:`**`undefined`**; `maskAllInputs:true`, `maskInputOptions:{password:true}` retained; selectors unchanged | **yes — caller override honoured, password floor holds** |
| `replay: { maskAllInputs:false, blockAllMedia:false }` | `maskAllInputs:`**`false`**, `blockSelector:`**`".bugsee-block,[data-bugsee-block]"`** (media list removed); `maskAllText:true`, `maskInputOptions:{password:true}` retained | **yes — both overrides honoured** |
| `replay: { maskAllText:false, maskAllInputs:false, blockAllMedia:false, blockAllCanvas:true, maskTextSelector:'.my-secret', blockSelector:'.my-ad', ignoreSelector:'.my-ignore', checkoutEveryNms:7777 }` | `maskAllText:false, maskAllInputs:false, maskAttributeFn:undefined, maskTextSelector:".bugsee-mask,[data-bugsee-mask],`**`.my-secret`**`", blockSelector:".bugsee-block,[data-bugsee-block],`**`canvas`**`,`**`.my-ad`**`", ignoreSelector:".bugsee-ignore,[data-bugsee-ignore],`**`.my-ignore`**`", checkoutEveryNms:`**`7777`** | **yes — all 8 options present and correct** |

**Result: 0 of 8 caller-settable masking options are lost. Review 2's measurement is fully reproduced.**

### Mutation battery (the actual dispute)

Each mutation applied from a `cp` backup and restored from that backup (never `git checkout`).

| # | mutation | site | replay suite | browser suite | replay-canvas | RP6 e2e |
|---|---|---|---|---|---|---|
| baseline | none | — | 33/33 pass | 208/208 pass | 12/12 pass | 1/1 pass |
| **A** (Review 1's) | `resolveReplayMaskingOptions(options)` → `resolveReplayMaskingOptions({})` | `packages/replay/src/register.ts:48` | **SURVIVED 33/33** | **SURVIVED 208/208** | **SURVIVED 12/12** | **SURVIVED 1/1** |
| **B** (Review 2's M1) | drop `...replayMasking` from the call | `packages/browser/src/launch.ts:465` | n/a (other package) | **CAUGHT — 2 failed** (`launch.test.ts` "forwarding the options" + "forwards blockAllCanvas") | n/a | n/a |

Mutation A reproduces Review 1's `33/33` exactly. Mutation B reproduces Review 2's `M1 → 2 failed` exactly. **They are different mutations at different sites guarded by different suites — both reviews' measurements are true, and they never actually touched each other's claim.**

**Root cause of A's survival**, confirmed at source: `packages/replay/src/register.test.ts:54-60` is the *only* test that passes a masking override through `registerReplay`, and it asserts solely
`expect(rec.getOptions()?.maskTextSelector).not.toBe('*')` and `.toContain('.bugsee-mask')` — **both of which are also true under pure defaults**. It never asserts `maskAllText === false` in the config rrweb received. Review 1's diagnosis is precisely correct.

**New evidence beyond both reviews:** the RP6 e2e (`packages/instrumentation-tests/test/replay.e2e.ts:79`) launches with `replay: true`, which `launch.ts:451` maps to `{}` — so `resolveReplayMaskingOptions(options)` and `resolveReplayMaskingOptions({})` are *provably identical* on that path. The repo's only behavioural replay test is structurally incapable of catching mutation A. **No suite anywhere in the monorepo detects it.**

## What each review got right and wrong

- **Review 1 (`replay.md`)**: **Correct, and correctly ranked.** The mutation, the `33/33` result, the root-cause diagnosis (`register.test.ts:54-60` assertions hold under defaults), and the SEV3 (test-strength) classification all reproduce exactly. It never claimed production drops options — the body (`replay.md:159`) says "**Mutating** `register.ts:48`…". My evidence *strengthens* it: the mutation also survives the browser suite, replay-canvas, and the RP6 e2e. The only fair criticism is rhetorical: the verdict-line compression *"`registerReplay` silently discarding all caller masking options survives as a mutation"* (`replay.md:5`) is accurate but easy to mis-quote as a production defect — which is exactly what happened.
- **Review 2 (`browser.md`)**: **Measurement correct; rebuttal wrong.** The masking survival trace and every measured config value reproduce exactly — that work is sound and valuable. But three errors: (a) it rebutted a mutation at `packages/replay/src/register.ts:48` using a control mutation (M1) at `packages/browser/src/launch.ts:465`, in a suite that mocks `@bugsee/replay` at `launch.test.ts:51` and therefore cannot execute the disputed line; (b) it declared the prior finding "does not hold on this branch" while its own caveat (`browser.md:110`) concedes the identical gap; (c) "the (now absent) option-drop" implies a real defect was fixed — no such defect ever existed in the code, only in the paraphrase. **The sentence "the '`registerReplay` drops options' claim is DISPROVEN" must be withdrawn**; what Review 2 actually disproved is the *mis-paraphrase*, and that is worth recording.

## Corrected severity

**Production behavior: no defect. SEV = none.** No masking option is dropped, defaulted-over, or shadowed anywhere between `launch()` and rrweb, on any path, for any caller. No privacy exposure exists from this mechanism. Any remediation ticket framed as "customers are silently unmasked" should be closed as not-reproducible.

**Test coverage: real defect, `SEV3` (as originally filed by Review 1) — but the highest-priority item in that tier.** Recorded correctly it reads:

> **SEV3 — Cross-package mock-on-both-sides blind spot: a total masking-config bypass at `packages/replay/src/register.ts:48` is undetectable by every test in the monorepo.**
> `@bugsee/browser`'s suite mocks `@bugsee/replay` (`launch.test.ts:51`) and asserts only what it *passes in*; `@bugsee/replay`'s suite injects a fake `record` and asserts only what the *pure resolver returns* (`register.test.ts:54-60`, whose two assertions hold under defaults). The one behavioural test, the RP6 e2e, runs `replay: true` → `{}`, on which the mutation is a no-op by construction. Verified: changing `resolveReplayMaskingOptions(options)` to `resolveReplayMaskingOptions({})` leaves replay 33/33, browser 208/208, replay-canvas 12/12 and the RP6 e2e 1/1 all green. The seam is privacy-critical, so a future regression here ships silently.
> **Fix:** one integration test that boots the real `launch({ replay: { maskAllText: false, blockAllMedia: false, maskTextSelector: '.x' } })` against a real `@bugsee/replay` with rrweb stubbed at the `record` seam, asserting the *received* config contains `maskAllText: false` and `.x`. (The probe in this adjudication is a working template.) Extend `register.test.ts:54-60` to assert `maskAllText === false` rather than only selector `toContain`.

Kept at SEV3 to stay consistent with this repo's review taxonomy, where SEV1/SEV2 denote live defects and SEV3 denotes test-strength findings (cf. `replay.md` SEV3 #2 and #3, which are the same class and the same root cause).

## Repository hygiene

All mutations applied from `cp` backups and restored from those backups. The temporary probe (`packages/browser/src/zz-adjudication-probe.test.ts`) was deleted. `git -C /Users/alexeykarimov/Projects/Bugsee/javascript status --short packages/` returns **empty**, verified after each mutation and at completion. No source file was modified. No network requests were made.
