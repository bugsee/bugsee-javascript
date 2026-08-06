# Adversarial review — @bugsee/replay-canvas

**Reviewed:** 2026-07-26 · **Scope:** packages/replay-canvas (impl 68 LOC across 2 files, tests 125 LOC across 2 files), plus the seams it depends on in `@bugsee/replay` and `@bugsee/browser`

**Verdict:** The package itself is exactly what it claims to be — a pure, dependency-free options builder with genuine 100%/100% coverage, a real allowlist output shape, clamps that fail closed on every scalar I threw at them, and 7/7 injected mutations caught. **The top question — "is the config silently dropped like `registerReplay`'s masking options?" — is answered NO, definitively and empirically:** dropping the canvas config at `register.ts:52` or `recorder.ts:70` is caught by both suites, and the built browser bundle really does carry the lazy `import('@bugsee/replay-canvas')`. Everything this package emits reaches the real rrweb `record()`. **The failures are all one layer out, in what the emitted config causes rrweb to do**, and they are severe because the payload is pixels. Driving the REAL fork bundle against a REAL DOM with per-canvas `toDataURL` markers, I proved three pixel-level defects: (1) the fork's `CanvasManager` is never given `unblockSelector`, so `.bugsee-show` **cannot** un-block a canvas for the canvas recorder — O2's entire "record ONLY opted-in canvases" mode is non-functional, degrading to roughly one frame per 60 s checkout instead of the configured fps; (2) `.bugsee-ignore` and `.bugsee-mask`, which the design doc names as canvas protections, protect **nothing** — a canvas in either subtree ships its full pixels under default settings; (3) one typo in the public `replay.blockSelector` both leaks **every** canvas's pixels (including explicitly `.bugsee-block`-marked ones) **and** makes the host application's own `canvas.getContext()` throw. Separately, the opt-in gate is a not-equal check rather than a truthiness check, so `canvas: null` silently kills all of session replay while `canvas: 0` / `canvas: ''` silently switch pixel capture **on**. The package's own tests are strong; the test *theater* is one layer out — a mutation that makes `blockAllCanvas` block nothing survives the entire suite, because the assertion compares the block selector against the very constant it is testing.

All findings below were verified by running code against the real `@bugsee/rrweb-record` fork bundle, not by reading. Working tree confirmed unmodified at completion (`git status --short packages/` empty).

## SEV1

### 1. `.bugsee-show` cannot un-block a canvas for the canvas RECORDER — O2's "record ONLY opted-in canvases" mode does not work

- **Where:** `packages/replay/src/masking.ts:20-22` and `:119-125` (the claim); `packages/browser/src/launch.ts:101-103` (the same claim in the public option doc); `docs/design/replay-canvas.md:151-157` (the design decision). Root cause is in the fork bundle: `packages/rrweb/node_modules/@bugsee/rrweb-record/record.js` @179488.
- **What:** `blockAllCanvas` works by adding `'canvas'` to the composed `blockSelector`, and the design states that `.bugsee-show` / `[data-bugsee-show]` (populated into `unblockSelector` at `masking.ts:119`) opts individual canvases back in. The fork has **two different `isBlocked` implementations**:
  - `yo(e, t, r, a = null)` (@10016) — the *snapshot serializer's*, which **does** honor `unblockSelector`: `if (a && e.matches(a)) return !1`.
  - `se(e, t, r, a)` (@131521) — the *record path's*, whose 4th parameter is `checkAncestors`, **not** `unblockSelector`. It ends `return !!(r && (s.matches(r) || a && s.closest(r) !== null))`. There is no un-block concept on this path at all.

  The `CanvasManager` is constructed with only the block half:
  ```js
  _r = new jr({recordCanvas:A, mutationCb:Z, win:window, blockClass:s, blockSelector:u, mirror:he,
               sampling:x.canvas, dataURLOptions:O});
  ```
  and its constructor destructures `{sampling, win, blockClass, blockSelector, recordCanvas, dataURLOptions}` — **no `unblockSelector`**. This is not a scoping accident: the very next statement passes `unblockSelector:f` into the DOM observer's `bypassOptions`, so the value was in scope and was simply not given to the canvas manager. Both canvas observers then gate on `se(...)`: the fps observer via `r.document.querySelectorAll("canvas").forEach(h=>{ se(h,a,s,!0) || p.push(h) })`, and the `'all'` observer via `se(this.canvas, r, a, !0)` inside the patched context methods.
- **Why it matters:** `blockAllCanvas: true` is documented as the *strict, extra-safe* mode — "blocks every `<canvas>` except those opted in via `.bugsee-show`" (`docs/design/replay-canvas.md:151-152`), "record ONLY opted-in canvases" (`masking.ts:20-22`). A developer turns it on precisely because they have one safe canvas (a chart) among sensitive ones (a signature pad), enables `canvas: { fps: 30 }`, and believes their chart is being captured at 30 fps. It is not being captured by the canvas recorder at all. It fails *closed* — no pixel leak — but the feature the user opted into silently does nothing, which is exactly the failure mode that ships unnoticed.
- **Evidence (empirical, real fork + real DOM):** driving the real `se` and `yo` with the real `resolveReplayMaskingOptions({ blockAllCanvas: true })` output:
  ```
  blockSelector  : .bugsee-block,[data-bugsee-block],img,…,iframe,canvas
  unblockSelector: .bugsee-show,[data-bugsee-show]
  id                 RECORD-path blocked?   SNAPSHOT-path blocked?
  plain              true                   true
  optedin (.bugsee-show)      true          false     << record path ignores the opt-in
  optedin-attr ([data-bugsee-show]) true    false     << same
  ancestor-optedin   true                   true
  ```
  And end-to-end through the real `record()` with per-canvas `toDataURL` markers, `blockAllCanvas: true` + `canvas: true`: `PIXELS IN STREAM -> shown`. The opted-in canvas appears **only** via the full-snapshot serializer (which uses `yo`), i.e. once per `checkoutEveryNms` — default **60 000 ms** (`packages/replay/src/recorder.ts:62`). Net effect: an opted-in canvas is captured at ~1 frame/60 s regardless of the `fps` the user configured.
- **Note:** the reachable per-canvas control that *does* work on both paths is `.bugsee-block` (verified blocked on both paths, element and ancestor).

### 2. `.bugsee-ignore` and `.bugsee-mask` do NOT protect a canvas — a signature pad marked with either ships its full pixels under DEFAULT settings

- **Where:** `docs/design/replay-canvas.md:149-150` makes the claim; `packages/replay/src/masking.ts:126` (`ignoreSelector`) and `:115` (`maskTextSelector`) are the mappings that do not deliver it.
- **What:** The design doc's acceptance criterion states: *"Per-canvas block honored: a `<canvas>` inside any `.bugsee-block` / `.bugsee-ignore` / masked subtree is blocked by rrweb (placeholder, no pixels) — reuses the existing block selectors, no new API."* Only the first of the three is true. In the fork, `ignoreSelector`/`ignoreClass` are consumed by exactly one function — `Na({inputCb, doc, mirror, blockClass, blockSelector, ignoreClass, ignoreSelector, maskInputOptions, …})` @148558, the **input-event observer**. They are never passed to the serializer and never to the `CanvasManager`. `maskTextSelector` likewise drives only text masking. Neither has any bearing on whether a canvas's `rr_dataURL` is produced.
- **Why it matters:** `.bugsee-mask` and `.bugsee-ignore` are two of the three Bugsee-namespaced privacy conventions advertised in `masking.ts:7-8`. A developer protecting a signature pad or an ID-photo cropper will reach for whichever convention they remember; two of the three silently do nothing for canvas. Canvas content is raw pixels — there is no partial protection and no downstream redaction that can recover from this. This needs no misconfiguration: it happens under fully default masking the moment `canvas` is enabled.
- **Evidence (empirical, real `record()` + real DOM, per-canvas `toDataURL` markers, `replay: { canvas: true }`, otherwise all defaults):**
  ```
  PIXELS IN STREAM -> plain, ignored, in-masked, shown
  protected        -> blocked, anc-blocked
  ```
  where `ignored` = `<canvas class="bugsee-ignore">` and `in-masked` = `<canvas>` inside `<div class="bugsee-mask">`. Only `.bugsee-block` (element `blocked`, ancestor `anc-blocked`) protects.

### 3. One typo in `replay.blockSelector` leaks EVERY canvas's pixels — including `.bugsee-block`-marked ones — and throws a DOMException into the host app's own `canvas.getContext()`

- **Where:** `packages/replay/src/masking.ts:120-125` (`joinSelectors` concatenates the caller's `blockSelector` unvalidated); reachable through the public, typed option `packages/browser/src/launch.ts:107` (`blockSelector?: string`).
- **What:** Two distinct consequences, both canvas-specific amplifications of the fail-open already recorded as `docs/review/replay.md` SEV1-3:
  1. **Snapshot fails open globally.** The snapshot-path `yo` wraps everything in `try{…}catch{}` and returns `false` (= not blocked). One malformed fragment makes `e.matches(joined)` throw for *every* element, so the entire block set evaporates — `blockAllMedia`, `blockAllCanvas`, and explicit `.bugsee-block` marks all stop working at once, and every canvas's `rr_dataURL` is serialized.
  2. **The record path THROWS into application code.** The record-path `se` (@131521) puts only the `blockClass` check inside its `try{…}catch{}`; the final `return !!(r && (s.matches(r) || a && s.closest(r) !== null))` is **outside** it. So `se` throws rather than returning false. `se` is called from inside the patch the canvas manager installs on `HTMLCanvasElement.prototype.getContext` (`Di` @167813, installed in **both** fps and `'all'` modes) and from inside every patched `CanvasRenderingContext2D` method (`Ba` @167173). The throw happens *before* `f.apply(this, …)`/`o.apply(this, d)`, so the original method never runs.
- **Why it matters:** This violates the repo's binding principle that interceptors must not alter application behaviour, and it does so loudly: `canvas.getContext('2d')` throwing breaks Chart.js, Three.js, PDF.js, signature pads, and games outright. Simultaneously the developer's images, iframes and canvases are all being captured. The trigger is an ordinary typo (`'div['`, an unclosed `:has(`, a stray bracket) in a documented option; nothing throws at config time, nothing is logged, and `record()` itself returns normally.
- **Evidence (empirical, real fork + real DOM):**
  ```
  === replay:{canvas:true, blockSelector:"div["} — MALFORMED selector
     PIXELS IN STREAM -> plain, blocked, anc-blocked, ignored, in-masked, shown
     protected        -> (none)          << even .bugsee-block canvases leak
  ```
  and, separately, installing the real `Di` patch with the same selector:
  ```
  === MALFORMED user blockSelector: 'div[' ===
  app getContext BEFORE  : returned normally
  app getContext AFTER   : THREW DOMException: '.bugsee-block,[data-bugsee-block],img,svg,image,video,audio…
  ```
  Controls (default masking; `blockAllCanvas: true` with a valid selector) both show `returned normally` before and after. Note the throw is selector-parser dependent — `':has('` was tolerated by jsdom's nwsapi and did not throw; `'div['` did. Real browsers are stricter than nwsapi, so the reachable set is at least as large in production.

## SEV2

### 4. Enabling canvas can make `record()` throw at provider start — silently losing ALL session replay, not just canvas

- **Where:** `packages/replay/src/recorder.ts:67-81` (`onStart` calls `#record(...)` unguarded); `packages/replay/src/register.ts:54-57`; `packages/core/src/capture-coordinator.ts:40-45,52-62` (`addProvider` → `startProvider` → `provider.start()`, no per-provider try/catch); `packages/browser/src/launch.ts:464-469`.
- **What:** With a numeric `fps` (the default, 2), rrweb's `initCanvasFPSObserver` constructs an encoding Worker via `za` (@171966) **eagerly at observer init**, before any canvas is examined. `za`'s `catch` handler itself does `new Worker("data:text/javascript;…")` with no further guard, so if Worker construction fails the error escapes `za` → escapes the `CanvasManager` constructor → escapes `record()` → escapes `ReplayCaptureProvider.onStart()`. Because the browser registers replay *after* `client.launch()`, `addProvider` starts the provider inline (`capture-coordinator.ts:59-61`) with no guard, so the throw unwinds out of `registerReplay` **before** `fileEncoders.replay = encodeReplay` at `register.ts:57`. It is finally swallowed by `.catch((error) => options.onError?.(error))` at `launch.ts:469`.
- **Why it matters:** The result is total, silent loss of session replay — no recorder started and no `replay.bin` encoder registered — reported only through the *optional* `onError` callback. The user enabled an add-on and lost the base feature. Reachable whenever Worker construction fails: proven in jsdom/test-harness environments, and by inspection of `za`'s unguarded fallback under any CSP that forbids `blob:`/`data:` workers (`worker-src 'self'`) — common in exactly the enterprise apps most likely to care about canvas privacy.
- **Evidence (empirical):** real `record()` through the real recorder provider, `replay: { canvas: true }`:
  ```
  === B. replay:{canvas:true} — add-on ON, default masking
     events=0 THREW:Worker is not defined
  ```
  The same run with `canvas` absent yields `events=2` and no throw. A second instance of the same class: `fps: 'all'` takes `initCanvasMutationObserver`, which dereferences `win.CanvasRenderingContext2D.prototype` unguarded (`Ba` @167173) — `THREW:Cannot read properties of undefined (reading 'prototype')` in the same environment.

### 5. The opt-in gate is a not-equal check, not a truthiness check — `canvas: null` kills all replay, `canvas: 0` / `canvas: ''` silently turn pixel capture ON

- **Where:** `packages/browser/src/launch.ts:453` (`const canvasEnabled = canvasOption !== undefined && canvasOption !== false;`) and `:461` (`typeof canvasOption === 'object' ? canvasOption : {}`).
- **What:** Two failures from one line. `typeof null === 'object'`, so `replay: { canvas: null }` passes the gate *and* is forwarded verbatim to `createCanvasRecordConfig(null)`; the `options = {}` default parameter only fires for `undefined`, so `options.fps` throws `TypeError: Cannot read properties of null (reading 'fps')`, which unwinds exactly as in finding 4 — before `fileEncoders.replay` is set — killing all of session replay. Conversely, every falsy value that is not `false`/`undefined` (`0`, `''`, `NaN`) passes the gate and enables canvas capture at the default 2 fps.
- **Why it matters:** `canvas: userWantsCanvas ? { fps: 5 } : null` and `canvas: Number(env.CANVAS_FPS)` are both natural authoring patterns. The first silently disables the developer's entire session replay; the second silently enables the SDK's highest-risk capture. For a feature whose headline property is "opt-in, off by default", the gate should be truthiness.
- **Evidence (empirical, replicating `launch.ts:453,461` exactly):**
  ```
  replay.canvas = undefined    add-on NOT loaded (opt-out)
  replay.canvas = false        add-on NOT loaded (opt-out)
  replay.canvas = null         THREW TypeError: Cannot read properties of null (reading 'fps')
  replay.canvas = 0            ENABLED -> {"canvas":2}
  replay.canvas = ""           ENABLED -> {"canvas":2}
  ```

### 6. Prototype pollution flips the opt-in default ON and escalates to maximum fidelity

- **Where:** `packages/browser/src/launch.ts:450-452` (destructuring `canvas` off a possibly-`{}` object) and `packages/replay-canvas/src/canvas-config.ts:54,57,59-60` (reading `options.fps`/`options.quality`/`options.imageType` off a caller object).
- **What:** Destructuring and property reads consult the prototype chain. With `Object.prototype.canvas = true` set by a page-side pollution vulnerability, a plain `replay: true` (which normalises to `replayOptions = {}` at `launch.ts:450-451`) yields `canvasOption === true` → `canvasEnabled === true` → canvas pixel capture starts, though the developer never wrote `canvas`. Independently, `Object.prototype.fps = 'all'` / `quality = 1` / `imageType` turn the cheap default config into the most expensive one.
- **Why it matters:** Same precondition class as `docs/review/replay.md` SEV2-11 (pollution disabling masking), but the direction is worse: there it removes a protection, here it *switches on* the SDK's highest-risk capture in a session that never asked for it. The fix is the same shape as the guard that finding needs — read options off a null-prototype copy, or use `Object.hasOwn` for the gate.
- **Evidence (empirical):**
  ```
  === AFTER Object.prototype.canvas = true ===
  replay: true    {"canvasOption":true,"canvasEnabled":true,…}
  CONCLUSION: canvas pixel capture enabled without the developer ever setting `canvas`? -> YES (opt-in gate defeated)

  AFTER pollution: default cfg  {"recordCanvas":true,"sampling":{"canvas":"all"},
                                 "dataURLOptions":{"type":"image/jpeg","quality":1}}
  ```

### 7. The designed canvas dimension cap was never built and cannot be built through options — snapshots are taken at full canvas resolution

- **Where:** `docs/design/replay-canvas.md:232` (D5: *"Cheap defaults (2 fps / q0.6 / webp / **1280px cap**), all overridable"*) and `:266` (RPC2: *"Options resolver (fps/quality/type/**dimension** defaults + clamps)"*) versus `packages/replay-canvas/src/canvas-config.ts:54-63`, which emits exactly three keys and nothing dimensional.
- **What:** There is no dimension clamp in the implementation, and `grep` finds **zero** occurrences of `maxCanvasSize` in the fork bundle (`@bugsee/rrweb-record/record.js`) and zero occurrences of `1280`/`maxCanvasSize`/`dimension` anywhere in `packages/replay-canvas/src`, `packages/replay/src`, or `packages/browser/src/launch.ts`. rrweb 2.1.0 has no such option, so a pure options-builder cannot implement it — the decision is unimplementable as designed and was silently dropped.
- **Why it matters:** The design's performance budget (§4) was justified assuming this cap. Without it, a 4096×4096 canvas is snapshotted at full resolution at the configured fps. The browser's default `maxDataSize` is **10 MB** (`packages/browser/src/launch.ts:79`), so a few seconds of a large canvas can consume the entire session budget and evict every other capture stream. The ring bound holds (see below) — this is not unbounded growth — but the *composition* of the session is destroyed, and the design's stated defence does not exist.

### 8. `fps: 'all'` has no guard and amplifies the known FullSnapshot-eviction hazard; the ring is bounded in BYTES, which holds

- **Where:** `packages/replay-canvas/src/canvas-config.ts:46-48` (`resolveSamplingCanvas` passes `'all'` straight through, no warning, no interaction with any budget); `packages/replay/src/recorder.ts:62` (`checkoutEveryNms` default 60 000 ms, independent of `maxDataSize`).
- **What:** The ring bound itself is sound and I verified it: `packages/core/src/chunk-capture-store.ts:58-68` evicts whole oldest **closed** parts while `totalBytes > maxDataSizeBytes`, with `byteSize` accumulated per append at `:76-79` — a real byte cap, not a frame count. So `fps: 'all'` cannot blow memory. What it does is dominate the byte budget: rrweb's `'all'` mode patches every `CanvasRenderingContext2D.prototype` method and, per non-blocked draw call, schedules `setTimeout(() => { … }, 0)` plus argument serialization on the main thread (`Ba` @167173). A 60 fps game issuing hundreds of draws per frame produces tens of thousands of serialized mutations per second. Because eviction drops the oldest closed parts and `checkoutEveryNms` is decoupled from `maxDataSize`, the FullSnapshot is evicted long before the incident — the hazard already recorded as `docs/review/replay.md` SEV2-12, of which canvas `'all'` is by far the highest-byte-rate trigger in the SDK.
- **Why it matters:** `fps: 'all'` is offered as a plain option value with a doc comment reading "full fidelity for animation/WebGL, heavier" (`canvas-config.ts:11`). There is no clamp, no budget interaction, no warning, and no test covering the resource behaviour. `fps: 60` is clamped; `fps: 'all'` — strictly more expensive than 60 — is not bounded at all.
- **Positive finding worth recording:** the fps path is *not* a main-thread `toDataURL` hazard — the fps observer uses `createImageBitmap` + an off-main-thread Worker for encoding (@173782 ff.). The main-thread `toDataURL` cost is confined to the full-snapshot serializer, once per checkout.

## SEV3

### 1. Test theater: a mutation that makes `blockAllCanvas` block NOTHING survives the entire suite

- **Where:** `packages/replay/src/masking.test.ts:48-52`.
- **What:** Mutating `packages/replay/src/masking.ts:22` from `export const CANVAS_SELECTOR = 'canvas'` to `'canvasx'` — i.e. `blockAllCanvas: true` now matches no element in any document — **SURVIVED**: 33/33 replay tests passed, and 12/12 replay-canvas tests passed. The assertion is `expect(m.blockSelector).toContain(CANVAS_SELECTOR)`, which compares the output against the very constant under test; it is tautological and cannot fail for any value. The negative test at `:55-58` uses the string literal `'canvas'` and so is unaffected. This is the mandate's designated priority mutation, and it survived.
- **Contrast:** every other blocking/opt-in mutation was caught — `blockAllCanvas` never blocking (`masking.ts:123` → `undefined`), its default flipped `false`→`true` (`:103`), the browser gate forced on (`launch.ts:453`), user canvas options ignored (`:461`), the config not forwarded (`:466`), the config dropped in `registerReplay` (`register.ts:52`) and in the recorder (`recorder.ts:70`). Fix is one character: assert against the literal `'canvas'`.

### 2. No test anywhere exercises the real rrweb canvas path — every canvas assertion stops at the produced object or a fake `record`

- **Where:** `packages/replay-canvas/src/canvas-config.test.ts` (all 9 tests assert the builder's return value); `packages/replay-canvas/src/integration.test.ts:16-19,36-39,51-54` (a `vi.fn()` stand-in for `record`).
- **What:** The integration test is genuinely better than object-equality theater — it asserts the arguments the recorder hands to `record()`, which is why the drop mutations were caught. But no test in the repo asserts what rrweb *does* with the canvas config. Every finding in this review's SEV1 tier lives in that gap, and — importantly — **every one of them was reproducible in jsdom**. The deferred real-browser Playwright canvas e2e (`docs/design/replay-canvas.md` acceptance notes) was not required to find any of them; a jsdom test driving the real fork bundle with a stubbed `toDataURL` marker would have caught all three.

### 3. `README.md` is still a stub for a shipped, privacy-critical feature

- **Where:** `packages/replay-canvas/README.md` — full contents: *"Canvas-replay add-on (opt-in) — **Status:** stub."*
- **What:** The package is built, wired, and reviewed, yet its README declares it unimplemented and contains no privacy guidance. Given findings 1 and 2, users have no correct documentation of which per-canvas controls actually work (`.bugsee-block` yes; `.bugsee-ignore`, `.bugsee-mask`, `.bugsee-show`-for-recording no).

### 4. Text masking does not extend to canvas pixels, and this is stated nowhere user-facing

- **Where:** conceptual, but the misleading claim is at `docs/design/replay-canvas.md:231` (D4, *"Fail-closed privacy … Consistent with `blockAllMedia`/`maskAllText`"*).
- **What:** `maskAllText: true` is the fail-closed default and masks DOM text nodes. Text drawn into a canvas via `fillText` — chart axis labels with customer names, a canvas-rendered PDF, a signature — is pixel data and is captured verbatim. Enabling `canvas` therefore punches a hole through the SDK's headline masking default that no masking option can close; only `.bugsee-block` can. Calling this "consistent with `maskAllText`" inverts the actual relationship.

### 5. `.bugsee-block` walks ancestors but `.bugsee-show` does not — an undocumented asymmetry

- **Where:** `se` @131521 (`s.closest(r)` when `checkAncestors`) and the serializer tree-walk at @19291 (`G = G && !T.needBlock`, children not recursed) versus `yo` @10016 (`a && e.matches(a)`, element-level only).
- **What:** Blocking is inherited by descendants; un-blocking is not. `<div class="bugsee-show"><canvas></canvas></div>` silently does nothing, while `<div class="bugsee-block"><canvas></canvas></div>` correctly protects. Verified empirically (`ancestor-optedin` blocked on both paths). Developers will reasonably expect the mirror of a mechanism to behave like a mirror. On the plus side, this makes accidental triggering of `.bugsee-show` very unlikely — it must be on the canvas element itself.

### 6. `@bugsee/replay` is a types-only import declared in `dependencies`

- **Where:** `packages/replay-canvas/package.json:26-28` versus `packages/replay-canvas/src/canvas-config.ts:6` (`import type { CanvasRecordConfig }`).
- **What:** The sole reference to `@bugsee/replay` is type-only and fully erased — the built `dist/index.js` contains zero imports. Declaring it in `dependencies` rather than `peerDependencies`/`devDependencies` adds it to the install graph (and transitively `@bugsee/rrweb` + the ~56 KB fork bundle) for consumers. No bundle cost, since nothing is imported; install-graph hygiene only.

### 7. Spread order places the canvas config after masking

- **Where:** `packages/replay/src/recorder.ts:68-70` (`...this.#masking, ...this.#canvas,`).
- **What:** The canvas config structurally outranks the privacy config in the object passed to `record()`. This is safe **today** only because `createCanvasRecordConfig` is an allowlist that can emit exactly three non-masking keys (verified: hostile input carrying `maskAllText:false`, `blockAllMedia:false`, `recordCrossOriginIframes:true`, `emit` produced `["recordCanvas","sampling","dataURLOptions"]` and nothing else). Any future widening of `CanvasRecordConfig`, or an untyped JS caller reaching the exported `registerReplay` directly, silently gains the ability to overwrite masking. Spreading masking *last* would make the invariant structural instead of incidental.

## Does the config reach rrweb?

**Yes — every key, verified empirically and at the built-bundle level.** This is the one thing the package gets unambiguously right, and the `registerReplay`-drops-masking defect has no analogue here.

| key emitted by `createCanvasRecordConfig` | path | reaches real `record()`? | evidence |
|---|---|---|---|
| `recordCanvas: true` | `canvas-config.ts:56` → `launch.ts:460` → `register.ts:52` → `recorder.ts:70` (`...this.#canvas`) | **yes** | `integration.test.ts:27`; mutation "drop `...this.#canvas`" CAUGHT in both suites; consumed by the fork at the serializer branch `w==="canvas"&&n` and by the `CanvasManager` gate `f && …` |
| `sampling: { canvas: 'all' \| number }` | same | **yes** | `integration.test.ts:28,46`; fork destructures `sampling:r="all"` and branches `r==="all"` → mutation observer, `typeof r=="number"` → fps observer |
| `dataURLOptions: { type, quality }` | same | **yes** | `integration.test.ts:29`; fork passes it to `initCanvasFPSObserver(..., {dataURLOptions:m})` and to the serializer's `e.toDataURL(c.type, c.quality)` |

Mutation evidence that the seam is live, not decorative:

| mutation | replay suite | replay-canvas suite |
|---|---|---|
| `register.ts:52` — `registerReplay` discards `options.canvas` | CAUGHT | CAUGHT |
| `recorder.ts:70` — drop `...this.#canvas` before `record()` | CAUGHT | CAUGHT |
| `launch.ts:466` — canvas never forwarded to `registerReplay` | CAUGHT (browser) | — |
| `launch.ts:461` — user canvas options ignored, always defaults | CAUGHT (browser) | — |

Unlike masking, `registerReplay` forwards `canvas` explicitly and conditionally (`register.ts:52`), and the recorder spreads it into the real `record()` call (`recorder.ts:70`). The `@bugsee/replay` masking-drop defect is a *separate* line (`register.ts:48`) and does not affect canvas.

## Opt-in / blocking audit

Rows measured end-to-end against the **real** fork `record()` over a real DOM with per-canvas `toDataURL` markers (fixture: a plain canvas, `.bugsee-block`, a canvas inside `.bugsee-block`, `.bugsee-ignore`, a canvas inside `.bugsee-mask`, and `.bugsee-show`).

| path | canvas recorded by default? | `blockAllCanvas` honored? | inherited masking preserved? | file:line |
|---|---|---|---|---|
| `replay: true` | **no** — add-on not loaded, zero pixels, no `recordCanvas` key emitted | n/a (nothing to block) | yes | `launch.ts:451,453`; `integration.test.ts:58` |
| `replay: {}` | **no** — identical to above | n/a | yes | `launch.ts:453`; `launch.test.ts:1132-1139` |
| `replay: { canvas: true }` | yes (intended) — but pixels captured from `plain`, `.bugsee-ignore`, `.bugsee-mask` subtree, `.bugsee-show`; only `.bugsee-block` protects | n/a (off) | **text masking does not extend to pixels** (SEV3-4); blocking partially (SEV1-2) | `launch.ts:459-463`; `masking.ts:126`,`:115` |
| `replay: { canvas: {...} }` | yes (intended); options clamped, hostile keys dropped | n/a (off) | same as above | `canvas-config.ts:54-63` |
| `replay: { canvas: true, blockAllCanvas: true }` | blocks all canvases including opted-in ones on the **record** path; opted-in canvas surfaces only via the 60 s full snapshot | **partially — SEV1-1** | yes for blocking, no for text | `masking.ts:103,123`; fork @179488 |
| `replay: { canvas: true, blockSelector: 'div[' }` | **ALL canvases leak, incl. `.bugsee-block`; app `getContext()` throws** | **defeated — SEV1-3** | **no** | `masking.ts:120-125`; `launch.ts:107` |
| `replay: { canvas: null }` | replay entirely dead (TypeError before the encoder registers) | n/a | n/a | `launch.ts:453,461` |
| `replay: { canvas: 0 }` / `''` | **yes — silently enabled** | n/a | n/a | `launch.ts:453` |
| `replay: true` + `Object.prototype.canvas = true` | **yes — opt-in defeated** | n/a | n/a | `launch.ts:450-452` |

`blockAllCanvas` default is **OFF**, correctly (`masking.ts:103`, `?? false`); both the "never blocks" and "default flipped" mutations were caught. `.bugsee-show` cannot be triggered accidentally — it is element-level `matches` on both paths, with no ancestor walk (SEV3-5).

## Malformed-option handling

**The builder itself fails CLOSED on every scalar input** — this is the package's strongest property, and all 7 clamp/default mutations were caught.

```
fps: NaN         -> 2      fps: -10  -> 1     fps: 0   -> 1
fps: Infinity    -> 2      fps: 1e9  -> 60    fps: 0.4 -> 1
fps: 'ALL'       -> 2      (wrong case does NOT reach full-fidelity mode)
fps: '30'        -> 2      (string does NOT reach 30)
quality: 5       -> 1      quality: -1 -> 0   quality: NaN/Infinity -> 0.6
imageType: 'image/exe' -> 'image/webp'   (allowlist, not passthrough)
```

`resolveImageType` (`canvas-config.ts:40-42`) is a true allowlist — only the literal `'image/jpeg'` diverts from the webp default. `resolveFps`/`resolveQuality` guard with `Number.isFinite` before clamping, so no `NaN` can reach `sampling.canvas`. Hostile extra keys are structurally impossible to smuggle: the return is a fresh three-key object literal, so `{ maskAllText: false, blockAllMedia: false, recordCrossOriginIframes: true, emit }` produced exactly `["recordCanvas","sampling","dataURLOptions"]`. **Canvas options cannot weaken parent masking.**

Two fail-open exceptions, both outside the scalar clamps:

- **`null`** — `createCanvasRecordConfig(null)` throws (default parameters fire only on `undefined`), and `launch.ts:461` routes `null` straight in because `typeof null === 'object'`. Fails *loud but silent*: kills all replay via `onError` (SEV2-5).
- **Prototype pollution** — inherited `fps`/`quality`/`imageType` are read as if caller-supplied, escalating 2 fps/webp/0.6 to `'all'`/jpeg/1.0; inherited `canvas` flips the opt-in gate itself (SEV2-6).

`quality: 5 → 1` clamps *upward* to maximum quality. That matches the documented `[0,1]` contract, but note the safe direction for an out-of-range quality would be the 0.6 default rather than the ceiling.

## Behavior-when-absent verification

**Verified identical, at source and in the built artifacts.**

- **No config key emitted.** `register.ts:52` spreads `canvas` only when `options.canvas !== undefined`; `recorder.ts:70` spreads `undefined` (a no-op). Asserted by `integration.test.ts:49-59` (`recordArgs?.recordCanvas` is `undefined`) and confirmed end-to-end: `replay: true` with no add-on yields `PIXELS IN STREAM -> (none)` while still producing its 2 baseline events.
- **No import pulled in.** The built `packages/browser/dist/index.js` and `index.cjs` each contain exactly **one** occurrence of `replay-canvas`, inside a dynamic import gated on `canvasEnabled`:
  ```js
  const canvas = canvasEnabled ? (await import('@bugsee/replay-canvas')).createCanvasRecordConfig(
    typeof canvasOption === "object" ? canvasOption : {}) : void 0
  ```
  There is **no** static top-level import of `@bugsee/replay*` in either artifact.
- **Lazy import lives in `@bugsee/browser`, not `registerReplay`.** Confirmed at `packages/browser/src/launch.ts:460`. `packages/replay/src/` mentions `replay-canvas` only in three comments (`recorder.ts:17,37`, `register.ts:33`) — no value or type import — so `@bugsee/replay` has no dependency on this package.
- **No cycles.** `pnpm check:cycles` → `✔ No circular dependency found!` (920 files).
- **No rrweb / no DOM dependency — claim holds.** The only non-test import in the package is `import type { CanvasRecordConfig } from '@bugsee/replay'` (`canvas-config.ts:6`), fully erased: `dist/index.js` is five plain functions and one `export`, with zero import statements. No `document`, `window`, `globalThis`, or rrweb reference anywhere in the implementation. `vitest.config.ts` runs `environment: 'node'`, which the package genuinely permits. `pnpm --filter @bugsee/replay-canvas exec tsc --noEmit` passes.
- **Coverage** is a real 100% statements / 100% branches / 100% functions / 100% lines (12/12, 13/13, 5/5, 12/12) — not a threshold artifact.

## What remains unverified

- **Real rendered-pixel fidelity.** jsdom has no raster backend, so `toDataURL` was stubbed with a per-canvas marker. This proves *which canvases rrweb serializes pixels for* and *whether the config reaches the encoder* — which is what every finding here turns on — but not the actual webp/jpeg encoding, the quality/byte relationship, or that the dashboard player renders the result. The design doc's deferred real-browser Playwright canvas e2e remains the only way to close that.
- **The fps observer's steady-state loop.** All end-to-end results above are from the initial full snapshot; the `requestAnimationFrame` sampling loop, the `createImageBitmap` → Worker → `mutationCb` round trip, and the resulting byte rate were not executed (they need a real canvas and a real Worker). Consequently the *quantitative* cost of `fps: 'all'` versus `fps: 60` (SEV2-8) is reasoned from the fork's code path (one `setTimeout` + argument serialization per draw call), not measured.
- **WebGL specifics.** `preserveDrawingBuffer` force-setting (`Di` @167813, 4th arg `true` in fps mode only) and WebGL draw-call capture were not exercised — jsdom has no WebGL. Worth noting the fork forces `preserveDrawingBuffer: true` on every non-blocked WebGL context created while canvas replay is on, which is a real, permanent, app-visible GPU-memory/performance change; it is applied only to non-blocked canvases, and only in numeric-fps mode.
- **CSP-blocked Worker construction** (SEV2-4) is established by code inspection of `za`'s unguarded `catch` fallback plus the empirical "Worker is not defined" throw, not by a real browser under a real CSP header.
- **Selector-parser variance** (SEV1-3): `'div['` throws under jsdom's nwsapi, `':has('` does not. Real browsers are stricter, so the production trigger set is at least as large — but the exact set was not enumerated in a real browser.

## Checked and found clean

- **The config reaches rrweb, key by key** — the highest-priority question; no silent drop, proven by mutation in both suites and by the built bundles.
- **Opt-in default is genuinely off** on `replay: true` and `replay: {}` — no canvas key emitted, add-on never imported, zero pixels captured end-to-end.
- **`blockAllCanvas` defaults to OFF** (`masking.ts:103`) and its "never blocks" / "default flipped" mutations are both caught.
- **Canvas options cannot weaken parent masking** — the builder is a three-key allowlist by construction; hostile keys (`maskAllText`, `blockAllMedia`, `recordCrossOriginIframes`, `emit`) are structurally dropped.
- **Every scalar clamp fails closed**, including the wrong-case `'ALL'` and string `'30'` cases that could have reached full-fidelity mode.
- **`.bugsee-block` works correctly on both paths**, element-level and ancestrally — the serializer's tree walk (`G = G && !T.needBlock` @19291) never recurses into a blocked node's children, so a canvas inside a `.bugsee-block` subtree is never even visited. (My initial element-level `yo` probe suggested otherwise; the tree walk is the real mechanism. Re-checked and dismissed.)
- **The fps path is not a main-thread `toDataURL` hazard** — encoding runs off-thread via `createImageBitmap` + Worker; main-thread `toDataURL` is confined to the once-per-checkout full snapshot.
- **The capture ring is bounded in BYTES, not frames** (`chunk-capture-store.ts:58-68,76-79`) — `fps: 'all'` cannot blow memory, only the byte budget's composition.
- **No import cycle**; the lazy import is real and lives in `@bugsee/browser`; `@bugsee/replay` has no dependency on this package.
- **Pure options-builder claim holds** — no rrweb import, no DOM, node test environment, `dist/index.js` has zero imports.
- **Coverage is real** 100%/100%/100%/100%, and 7/7 builder mutations plus 7 of 8 seam/gate mutations were caught (the eighth is SEV3-1).
- **Working tree unmodified at completion** — `git status --short packages/` empty; every mutated file restored from a `cp` backup, and the two temporary probe test files removed.
