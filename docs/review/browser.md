# Adversarial review — @bugsee/browser

**Reviewed:** 2026-07-26 · **Scope:** `packages/browser` (impl 1884 LOC across 13 files, tests 3162 LOC across 12 files; 208 tests, all green; `tsc --noEmit` clean)
**Method:** full source read of the package + the seams it calls into (`@bugsee/replay`, `@bugsee/browser-utils`, `@bugsee/core`), plus **empirical probes** — three temporary jsdom test files that booted the real `launchCore` and were deleted afterwards (`git status --short packages/` verified EMPTY) — and a **20-mutation battery** (`cp` backup → patch → `vitest run` → restore from backup).

**Verdict:** The single highest-value question in the brief — *do the masking options a user sets on `launch({replay:{…}})` survive into the real rrweb `record()` config?* — is answered **YES, all of them, on every construction path**. I traced it dynamically (real `@bugsee/replay`, real `resolveReplayMaskingOptions`, real recorder, rrweb replaced only at its documented `record` seam) and captured the literal config object; the fail-closed floor (`maskAllText`/`maskAllInputs`/`blockAllMedia`/`maskInputOptions.password`) is applied for `replay: true`, `replay: {}`, and partial objects alike, and a control mutation that drops the caller's options is caught by the existing suite. **The prior finding "`registerReplay` discards every caller masking option" does not hold for the code on this branch — I am contradicting it deliberately, with the measured config below.** Host-page safety is likewise better than expected in most places: the SDK never assigns `window.onerror`, never calls `preventDefault`/`stopPropagation`, patches exactly one namespaced global (`__BUGSEE__`), removes every listener on `stop()`, restores `console`/`fetch` on `stop()`, and an error storm of 25 uncaught errors produced 3 HTTP requests total. What is genuinely broken is narrower and sharper: **the two providers wired into the host's error channel are the only unguarded listeners in the entire package, and five distinct thrown values escape them** — losing the customer's real crash and re-entering our own handler with the SDK's `TypeError`; and **there is no page-lifecycle flush at any layer**, so a mobile user whose backgrounded tab is killed loses the whole session and, at default settings, the crash they just hit. Two smaller `launch()` inputs (`replay: null`, a DOM-less runtime) throw out of a function the design guarantees never throws.

## SEV1

### 1. Five thrown-value shapes escape the SDK's `error`/`unhandledrejection` listeners into the host page's error channel — the real crash is lost and the SDK's own `TypeError` is reported in its place

- **Where:** `packages/browser/src/detection-providers.ts:38` (`String(value)`), `:29` (`value.message`), `:31` (`parseStack(value.stack)` → `packages/browser/src/stack.ts:34`), `:93` and `:113` (`this.handleReportingRequest(...)`). No guard exists upstream either: `packages/core/src/detection-provider-base.ts:44-46` and `packages/core/src/detection-coordinator.ts:34-39` both call straight through.
- **What:** `onDetected` runs entirely unguarded inside a DOM event listener. Measured, against the real providers in jsdom:

  | input | escapes as |
  |---|---|
  | `Promise.reject(Object.create(null))` | `TypeError: Cannot convert object to primitive value` (`:38`) |
  | rejection reason with a throwing `toString()` | `Error: hostile toString` (`:38`) |
  | `Error` whose `.stack` is not a string | `TypeError: stack.split is not a function` (`stack.ts:34`) |
  | `Error` with a throwing `message` getter | `Error: hostile message` (`:29`) |
  | a throwing report sink (the core pipeline) | `Error: pipeline boom` (`:93`) |

- **Why it matters:** per spec, an exception thrown inside an `error` listener is itself *reported*, which fires a fresh `error` event at `window` — **our own listener then runs again on the SDK's `TypeError` and reports that as the customer's crash, while the real crash is silently dropped.** For `unhandledrejection` the report is simply lost and an SDK-internal error is injected into the host's console and into any `window.onerror`/`error` listener the host registered (commonly forwarded to the app's own analytics). That is the binding rule — "interceptors must not alter app behavior" — violated at exactly the seam where it matters most. Note that `Object.create(null)` rejections are not exotic: they come out of `JSON.parse`-style pipelines, `Object.create(null)` config objects, and several popular libraries' error bags.
- **Evidence of intent elsewhere:** every other listener in this package is explicitly wrapped with an "observe-only / must never disrupt the application" try/catch — `input-source.ts:206-215`, `interaction-source.ts:67-74`, `navigation-source.ts:145-152`, `viewtree.ts:97-101`, `component-name.ts:25-27`, `meta-trace.ts:34-38`. The two detection providers are the sole exception, and they are the ones attached to the host's error path.
- **Blast radius:** `@bugsee/webworker` imports exactly these two providers (`packages/webworker/src/launch.ts:1-5`), so the same hole exists in Web and Service Workers; Electron renderers and the WebView bridge inherit it through `launchCore`.

### 2. Nothing is flushed on page hide — a backgrounded mobile tab that is killed loses the whole session, and at default settings the crash that was already detected

- **Where:** `packages/browser/src/launch.ts:435-437` (the only `pagehide` consumer), `packages/browser/src/system-events.ts:39-44,70,74`, `packages/browser-utils/src/fetch-transport.ts:26`.
- **What:** `pagehide` and `visibilitychange` are hooked, but only to *emit a capture entry* (`process_exiting` / `process_background`). Nothing calls `client.flush()`, nothing drains the upload pipeline, nothing forces the IndexedDB writes. Measured: launch in jsdom → `dispatchEvent(new Event('pagehide'))` + `visibilitychange` → **transport calls: `[]`**. `beforeunload`, `freeze`, `resume` and `unload` are not hooked anywhere in the repo. There is no `sendBeacon` and no `keepalive` anywhere: `fetch-transport.ts:26` builds `{ method, headers, signal }` only, so any in-flight upload is cancelled by the browser at unload — the ~64 KB keepalive budget is not even in play because keepalive is never requested.
- **Why it matters — exactly what a mobile user loses:**
  - **Default config (`persist` unset → false):** capture lives in `createMemoryCaptureStore` (`launch.ts:372`) and the bundle queue is in-memory (`launch.ts:299-322` builds neither when `persist` is false). Tab killed ⇒ the entire rolling buffer **and** any assembled-but-unsent bundle are gone. A crash detected 200 ms before the user swipes the tab away is never delivered.
  - **In-flight upload, any config:** cancelled at unload (no `keepalive`).
  - **`persist: true`:** the durable chunk store and bundle queue are written as-captured and recovered on the next launch, so this case mostly survives — but only for writes that already landed; there is no flush to force the tail, and the design comment at `launch.ts:73` ("the browser flushes via the pipeline / pagehide") describes a flush that does not exist.
- **Downstream confirmation:** the prior `@bugsee/browser-utils` review found the documented `pagehide` flush missing there. It is missing **here too** — this package is where page-lifecycle wiring would live, and it only produces a breadcrumb. There is no `pagehide` flush at *any* layer of the browser SDK.
- **Aggravating detail:** the marker itself is gated — with `captureSystemEvents: false` even the `process_exiting` entry disappears (`packages/capture/src/system-events-provider.ts:26`).

## SEV2

### 3. `launch()` throws a `ReferenceError` in any DOM-less runtime

- **Where:** `packages/browser/src/launch.ts:259` — `const win = options.window ?? window;` (bare identifier, not `globalThis.window`).
- **What / Evidence:** measured — `delete globalThis.window`, then `launchCore('tok', { transport, systemProbe })` → `ReferenceError: window is not defined`, thrown synchronously out of `launch()`.
- **Why it matters:** SSR/prerender passes of the meta-framework adapters, DOM-less unit-test environments, and any worker-family reuse hit this as a hard boot failure rather than a graceful no-op. It also contradicts the kernel's own guarantee — `packages/core/src/capture-coordinator.ts:10-11`: *"The Client wraps start() to honor the 'launch never throws' guarantee (§15.1)"*. Every other global read in this package guards properly (`system-events.ts:90-92`, `viewtree.ts:80`, `meta-trace.ts:31`, `navigation-source.ts:205-219`, `interaction-source.ts:132`, `input-source.ts:234`); `launch.ts:259` is the lone unguarded one. `@bugsee/webworker` escapes it only because it re-implements the composition rather than calling `launchCore`.
- **Why CI cannot see it:** `packages/browser/vitest.config.ts:8` sets `environment: 'node'`, and `launch.test.ts:281` only stubs a *present* global `window` — the absent-global branch is never exercised.

### 4. `launch({ replay: null })` throws out of `launch()`

- **Where:** `packages/browser/src/launch.ts:386` (`replayEnabled = options.replay !== undefined && options.replay !== false` admits `null`) → `:451` (`typeof null === 'object'` selects the object branch) → `:452` destructure.
- **What / Evidence:** measured — `TypeError: Cannot destructure property 'canvas' of 'replayOptions' as it is null.`
- **Why it matters:** `null` is what a JSON/remote/YAML-driven config or an untyped JS caller produces for "not set". TypeScript rejects it at the type level, but `launch()` is a public runtime entry point for plain-JS consumers, and this is a synchronous throw during app boot. Same "launch never throws" violation as #3, one line apart from a guard that already exists.

### 5. Every captured interaction and every viewtree node carries an uncapped `class` string (and an uncapped derived `selector`)

- **Where:** `packages/browser/src/input-source.ts:97-98` (`desc.class = attr(el, 'class')`), `:102` (`buildSelector` concatenates *every* class), `packages/browser/src/viewtree.ts:70`. Contrast `:49` — text **is** capped (`MAX_TEXT = 64`).
- **What / Evidence:** measured on a 40-class element (an ordinary Tailwind/utility-CSS component): `class` **989 chars**, `selector` **995 chars** ≈ 2 KB for a single click event. A 2000-node viewtree of such a page is several hundred KB per report; my synthetic 2000-node snapshot already serialized to **115 KB** with near-empty class lists.
- **Why it matters:** this is per-event and per-report payload paid on the end user's mobile data and on the collector, for a field that is purely structural. It is bounded by `maxDataSize` (10 MB) only in the sense that it evicts *other* capture sooner. Class names also occasionally carry semi-identifying content (`user-plan-enterprise`, generated ids), so the cap is a privacy hygiene item too, not only a size one.

### 6. `client.startBlackout()` is unreachable from the browser SDK — consumer-side confirmation of the already-filed replay finding

- **Where:** `packages/browser/src/launch.ts:464` — `m.registerReplay(client, fileEncoders, {…});` as a bare statement, discarding the returned `ReplayRecorder`.
- **What:** that return value is the *only* handle on `startBlackout`/`stopBlackout` (`packages/replay/src/register.ts:39`, `packages/replay/src/recorder.ts:89-95`), and `@bugsee/core`'s client exposes no blackout method (repo-wide grep: `startBlackout` appears only in `packages/replay`, the design docs, and `docs/review/replay.md`). `docs/design/sdk-design.md:401` specifies it as public API and `:45`/`:1409` name it the replacement for the removed consent API.
- **Status:** already reported as `docs/review/replay.md` §5 — recorded here only to pin the consumer-side `file:line`, per the brief's blast-radius instruction. Not counted as a new finding.

## SEV3

1. **`@bugsee/integration-shims` is a declared runtime dependency that is never imported** — `packages/browser/package.json:30`; zero `import` of it anywhere under `packages/browser/src`. Confirms the prior. It ships to every browser consumer for nothing.
2. **Shadow DOM is invisible to the viewtree** — `packages/browser/src/viewtree.ts:106` walks `el.children` only; `shadowRoot` is never consulted. Measured: content inside an open shadow root does **not** appear in the snapshot. A web-component-based app gets a near-empty view hierarchy. (Not a leak — a fidelity gap. Same-origin `<iframe>` content is likewise absent, which is the correct privacy default but undocumented in `ViewNode`.)
3. **An invalid mask selector silently voids the entire viewtree** — `packages/browser/src/viewtree.ts:98-101` catches the root's `SyntaxError` from `Element.closest`, so `walk` returns `undefined`, `createViewtreeSnapshotSource` emits no entry, and `onError` is never called. Measured: `createDomSnapshot({ maskSelector: '[[bad' })()` → `undefined`, no throw, no signal. Structurally the same failure mode as the confirmed replay `blockSelector`-typo finding, one severity lower because `launch()` hardcodes the selector (see #4) — it is reachable only through the exported `createDomSnapshot`/`describeTarget` that the webview/electron/web-adapter tiers consume.
4. **No launch option configures the input/viewtree mask selector at all** — `launch.ts:381` and `:441` never pass `maskSelector`, so browser customers are locked to `[data-bugsee-hidden]` (`viewtree.ts:84`, `input-source.ts:235`) while `replay` exposes three selector knobs. An asymmetric privacy surface.
5. **`options.document` is not forwarded to the system-events source** — `launch.ts:436` passes `{ window: win }` only, so `visibilitychange` binds to the ambient global `document` (`system-events.ts:91`) even when the caller injected one. Inconsistent with `:375-376` and `:441`, which do honour it.
6. **`hardware.device_id` is always `null` in the browser** — `launch.ts:327-337` never supplies `deviceId` and nothing persists one (`environment.ts:84` defaults to `null`). Android's canonical envelope carries a persisted UUID.
7. **`describeTarget` is a public export that throws on an invalid `maskSelector`** — `packages/browser/src/input-source.ts:90`; measured `SyntaxError: ',[bad' is not a valid selector`. All three in-package callers guard, so the contract is "callers must guard" — but that is not stated on the exported function.
8. **Replay lazy-import failure is silent by default** — `launch.ts:469` routes to `options.onError?.(error)`, and `onError` defaults to undefined. A CSP that blocks the dynamic chunk yields no replay and no signal at all.
9. **`ReplayLaunchOptions` omits `unmaskTextSelector`/`unblockSelector`** which `registerReplay` supports (`packages/replay/src/masking.ts:69-71`). Privacy-conservative, but an undocumented surface asymmetry.
10. **`navigation-source` restores `history.pushState`/`replaceState` by unconditional assignment** — `packages/browser/src/navigation-source.ts:195-196`. If another library wrapped `pushState` *after* us, our `onDeactivate` silently removes their wrapper. Bounded: only in the Navigation-API-absent fallback path, and only on `stop()`.

### Test strength — surviving mutations

The harness works: 16 of 20 mutations were caught (control list below). Four survived.

| # | mutation | file:line | result |
|---|---|---|---|
| M10 | `replayEnabled = options.replay !== undefined` — i.e. **`replay: false` now ENABLES session replay** | `launch.ts:386` | **survived** — 61/61 launch tests pass. `grep` confirms no test anywhere passes `replay: false`; the "off" test (`launch.test.ts:1099`) only covers `undefined`. A privacy-relevant *explicit opt-out* with zero coverage. |
| M18 | delete `setCarrierClient(undefined, carrier)` from `stop()` | `launch.ts:523` | **survived** — 61/61 pass. The documented contract at `launch.ts:517-518` ("stop() clears the process Carrier slot so a later launch() starts fresh") is untested; a regression makes the SDK permanently un-relaunchable and silently returns the dead client. |
| M9 | emit the navigation **before** calling the app's original `pushState` | `navigation-source.ts:171-174` | **survived** — 12/12 navigation tests pass. This is the ordering guarantee the whole "never block the app's nav" claim rests on, and the mutation additionally reports the *stale* `location.pathname`. |
| M6 | rename `COMPONENT_ATTRIBUTE` to `data-bugsee-componentX` | `component-name.ts:10` | **survived in its own suite** (`component-name.test.ts`: 6/6 pass) because the tests assert via the exported constant. The full package suite does catch it (3 failures, from literal strings in sibling tests) — but incidentally, and nothing anywhere binds it to the two build plugins' hardcoded copies. |

Caught (control mutations, proving the harness detects real regressions): M1 drop caller replay options → 2 failed; M2 `onStop` skips `removeEventListener` → 3 failed; M3 remove the password mask floor → 3 failed; M4 remove the viewtree node budget → 1 failed; M5 remove the depth bound → 1 failed; M7 listeners no longer `capture`/`passive` → 1 failed; M8 drop `x-bugsee-internal` → 2 failed; M11 masked subtree no longer collapses → 1 failed; M12 drop the `masked` flag → 1 failed; M13 stop skipping `script`/`style` → 1 failed; M14 capture typed characters → 2 failed; M15 read form-control/contenteditable text → 2 failed; M16 never build `crash.json` → 3 failed; M17 drop the unhandled-rejection provider → 1 failed.

## Masking option survival trace

**Method:** real `@bugsee/browser` `launchCore` → real dynamic `import('@bugsee/replay')` → real `registerReplay` → real `resolveReplayMaskingOptions` → real `ReplayCaptureProvider.onStart` → rrweb replaced **only** at its documented `record` seam (`packages/replay/src/register.ts:47`), and the literal config object captured. The intermediate hop is `launch.ts:452` (`const { canvas: canvasOption, ...replayMasking }`) → `:464-467` (spread into `registerReplay`).

| user option | reaches rrweb? | where it is lost | file:line |
|---|---|---|---|
| `maskAllText` | **yes** — `true` by default, `false` when set | — | `launch.ts:464` → `replay/src/register.ts:48` → `masking.ts:100,113` |
| `maskAllInputs` | **yes** — `true` by default | — | `masking.ts:101,106` |
| `blockAllMedia` | **yes** — `true` by default; `false` removes the media list from `blockSelector` | — | `masking.ts:102,120-125` |
| `blockAllCanvas` | **yes** — `false` by default; `true` adds `canvas` | — | `masking.ts:103,123`; not stripped by the `canvas` destructure at `launch.ts:452` |
| `maskTextSelector` | **yes** — appended to `.bugsee-mask,[data-bugsee-mask]` | — | `masking.ts:115` |
| `blockSelector` | **yes** — appended to the block list | — | `masking.ts:124` |
| `ignoreSelector` | **yes** — appended to `.bugsee-ignore,…` | — | `masking.ts:126` |
| `checkoutEveryNms` | **yes** — 60000 default, caller value honoured | — | `register.ts:49-51` → `recorder.ts:62,71` |
| `canvas.{fps,quality,imageType}` | **yes** — via `createCanvasRecordConfig` | — | `launch.ts:459-463` → `recorder.ts:70` |
| password floor (`maskInputOptions.password`) | **yes** — hard-set `true` regardless of `maskAllInputs` | — | `masking.ts:108` |
| `unmaskTextSelector` / `unblockSelector` | n/a — **not exposed** by `ReplayLaunchOptions` | not reachable from `launch()` (SEV3 #9) | `launch.ts:94-120` vs `masking.ts:69-71` |

**Measured `record()` config for `launch({ replay: true })`** (the fail-closed floor, verbatim):

```
maskAllText: true, maskAllInputs: true, maskInputOptions: {password:true}, maskAttributeFn: <fn>,
maskTextSelector:   ".bugsee-mask,[data-bugsee-mask]"
unmaskTextSelector: ".bugsee-unmask,[data-bugsee-unmask]"
unmaskInputSelector:".bugsee-unmask,[data-bugsee-unmask]"
unblockSelector:    ".bugsee-show,[data-bugsee-show]"
blockSelector:      ".bugsee-block,[data-bugsee-block],img,svg,image,video,audio,object,picture,embed,map,source,iframe"
ignoreSelector:     ".bugsee-ignore,[data-bugsee-ignore]"
checkoutEveryNms: 60000, recordCrossOriginIframes: false
```

`replay: {}` produced the identical config. `replay: { maskTextSelector:'.secret', blockSelector:'.ad', ignoreSelector:'.ig', checkoutEveryNms:5000 }` produced `".bugsee-mask,[data-bugsee-mask],.secret"` / `"…,iframe,.ad"` / `"…,.ig"` / `5000`. `replay: { maskAllText:false, blockAllMedia:false, blockAllCanvas:true }` produced `maskAllText:false`, `maskAttributeFn: undefined`, `blockSelector: ".bugsee-block,[data-bugsee-block],canvas"`. `replay: { canvas:{fps:'all',quality:0.9,imageType:'image/jpeg'} }` produced `recordCanvas:true, sampling:{canvas:'all'}, dataURLOptions:{type:'image/jpeg',quality:0.9}`.

**Conclusion: no hole. Zero masking options are lost between `launch()` and rrweb.** The prior claim that `registerReplay` discards caller masking options is contradicted by the code (`register.ts:48` passes `options` straight into `resolveReplayMaskingOptions`) and by measurement. The *replay-internal* SEV1s (the `.bugsee-unmask` password bypass, the 11-entry attribute denylist, the `blockSelector`-typo fail-open) are all still live and all still reachable from this package — but they are defects of `@bugsee/replay`'s own semantics, not of the plumbing here.

**Caveat that keeps this from being airtight:** no test *in the repo* exercises this chain. `launch.test.ts:51` mocks `@bugsee/replay`; `replay`'s own tests inject a fake `record`. Each side is verified against a mock of the other — exactly the seam shape that let the (now absent) option-drop hide. My probe supplied the missing link manually and has been deleted; a permanent integration test is the obvious follow-up.

## Global-handler chaining audit

No `window.onerror =` / `window.onunhandledrejection =` assignment exists anywhere in `packages/browser` (verified by grep). Everything is `addEventListener`, so the host's own handlers are structurally unaffected — they cannot be preempted, and "return `true` to suppress default logging" is not something an `addEventListener` listener can do, so the browser's default console reporting is preserved.

| handler | previous chained? | return value honored? | removed on `stop()`? | file:line |
|---|---|---|---|---|
| `window` `error` → crash | **n/a — additive** (`addEventListener`, no `onerror` assignment); host handler unaffected | **n/a** — never calls `preventDefault()`/`stopPropagation()`, so default logging stands | **yes** — measured 1 → 0 | `detection-providers.ts:73,77-78` |
| `window` `unhandledrejection` → error | **n/a — additive**; host handler unaffected | **n/a** — never calls `event.preventDefault()`, so the host's unhandled-rejection warning still fires | **yes** — measured 1 → 0 | `detection-providers.ts:73,77-78` |
| `pagehide` / `online` / `offline` / `orientationchange` | additive | n/a | **yes** — measured pagehide 1 → 0 | `system-events.ts:70-73,78-81` |
| `document` `visibilitychange` | additive | n/a | yes | `system-events.ts:74,82` |
| `click`/`keydown`/`change`/`submit`/`focusin` | additive, **capture-phase + passive**, never `preventDefault`/`stopPropagation` | n/a | yes | `input-source.ts:130-131,217-227` |
| `history.pushState`/`replaceState` (Navigation-API fallback only) | **yes** — original called FIRST, its return value returned | **yes** | restored on deactivate, but by *unconditional* assignment (SEV3 #10) | `navigation-source.ts:167-180,190-199` |
| `console.*`, `fetch`/`XHR`/`WS`/`SSE` (carrier-shared interceptors) | wrap-and-delegate | n/a | **yes — identity restored**, measured `console.log === original` and `fetch === original` after `stop()` | `launch.ts:419-427` + `@bugsee/core` carrier |

**The one real defect is not chaining but containment:** the two error-path listeners can throw (SEV1 #1), and a throw inside an `error` listener re-enters the SDK's own handler.

## Page-lifecycle flush matrix

| event | hooked? | what is flushed | what is lost | file:line |
|---|---|---|---|---|
| `pagehide` | yes (capture only) | **nothing** — emits a `process_exiting` capture entry; measured 0 transport calls | default config: the entire in-memory rolling buffer + any assembled bundle; any config: the in-flight upload (no `keepalive`) | `system-events.ts:39-44,70`; `fetch-transport.ts:26` |
| `visibilitychange` | yes (capture only) | **nothing** — emits `process_background`/`process_foreground` | same as above; backgrounding is the last chance on mobile | `system-events.ts:45-48,74` |
| `beforeunload` | **no** | — | — | not present anywhere in the repo |
| `freeze` / `resume` (Page Lifecycle API) | **no** | — | bfcache-frozen tabs that are discarded | not present |
| `unload` | **no** | — | — | not present |
| `sendBeacon` | **never used** | — | the only unload-safe transport is unavailable | grep: 0 hits repo-wide |
| `fetch keepalive` | **never set** | — | in-flight uploads are cancelled at unload; the ~64 KB keepalive cap is moot because keepalive is never requested | `fetch-transport.ts:26` |

**Definitive answer for a mobile user whose tab is backgrounded and killed:** at default settings (`persist` unset), **everything** — the rolling capture buffer, any bundle assembled but not yet uploaded, and any upload in flight. With `persist: true`, capture chunks and queued bundles that already reached IndexedDB survive and are recovered on the next launch (`launch.ts:483-515`), but nothing forces the pending tail, and a report never assembled is never assembled.

## Component-attribute contract check

Byte-for-byte identical on all four sides:

| side | value | file:line |
|---|---|---|
| **consumer (this package)** | `'data-bugsee-component'` | `packages/browser/src/component-name.ts:10`; read via `closest('[data-bugsee-component]')` + `getAttribute(...)` at `:22-23` |
| Babel/React plugin | `'data-bugsee-component'` (hardcoded) | `packages/babel-plugin-component-annotate/src/index.ts:11`, emitted as a JSX string-literal attribute at `:93` |
| Svelte preprocessor | `'data-bugsee-component'` (hardcoded, with a "MUST equal `COMPONENT_ATTRIBUTE`" comment at `:10`) | `packages/svelte-plugin-component-annotate/src/annotate.ts:12` |
| Vue mixin | imports `COMPONENT_ATTRIBUTE` from `@bugsee/browser` — drift impossible | `packages/vue/src/component-annotate.ts:1,43-44` |

**Value format:** all three emitters write a bare component-name string; the reader accepts any non-empty string (`component-name.ts:24`) and normalises `''`/`null` to `undefined`, so there is no format coupling to break. **Gap:** the two hardcoded copies are guarded only by a comment — mutation M6 shows `component-name.test.ts` cannot detect a rename, and no test in any package asserts the three literals agree.

## What jsdom cannot verify

The premise needs correcting first: **this package's suite does not run in jsdom at all.** `packages/browser/vitest.config.ts:8` sets `environment: 'node'` — all 208 tests execute DOM-less against injected fakes. So the list below is not "what jsdom can't do", it is "what the suite never attempts"; my probes had to opt into jsdom explicitly with `// @vitest-environment jsdom`.

- **Absent-global behaviour.** No test runs without a `window`, which is why the `ReferenceError` at `launch.ts:259` is invisible to CI.
- **Real event semantics.** Real `ErrorEvent`/`PromiseRejectionEvent` shapes, the spec's listener-throw → re-report loop (the mechanism behind SEV1 #1), resource-load `error` events, and the cross-origin `"Script error."` path with a genuinely opaque stack.
- **Real layout cost.** `getBoundingClientRect` in jsdom is a zero-returning stub, so the true main-thread cost of a 2000-node report-time walk — forced style/layout flush on a real engine — is unmeasured. My jsdom probe recorded 199 ms for a ~5000-element document, which bounds the traversal but says nothing about real reflow.
- **Real rendering / real replay.** No test anywhere drives launch → real rrweb (see the caveat under the masking trace). Canvas replay remains unverifiable without a real browser, as previously noted.
- **Real IndexedDB.** `fake-indexeddb` has no quota, no eviction, no `QuotaExceededError`, and no cross-tab reality; the confirmed browser-utils back-pressure and torn-record findings cannot surface here.
- **Real Web Locks.** Injected `LockManagerLike` stubs only — dead-sibling recovery under genuine tab contention is untested.
- **Real page lifecycle.** No bfcache, no freeze/discard, no tab kill — the flush gap (SEV1 #2) is structurally undetectable by this suite.
- **Real CSP.** The dynamic `import('@bugsee/replay')` chunk-load failure is only simulated by a throwing mock; a real `script-src` denial is untested.
- **Shadow DOM / same-origin iframes / very large real DOMs**, and any interaction with a host page's own IndexedDB databases or global names.

## Checked and found clean

- **Masking survival, end to end** — every option reaches rrweb; fail-closed defaults apply on `replay: true`, `replay: {}`, and partial objects (measured; table above).
- **No handler hijacking** — zero `window.onerror`/`onunhandledrejection` assignments; `addEventListener` throughout; no `preventDefault`/`stopPropagation` on `error`, `unhandledrejection`, or any input event. The host's default logging and its own handlers are untouched.
- **Full listener teardown on `stop()`** — measured `error` 1→0, `unhandledrejection` 1→0, `pagehide` 1→0.
- **Global patches reverted on `stop()`** — measured `console.log` and `globalThis.fetch` identity restored to the pre-launch originals (subscriber-presence deactivation via the carrier-shared interceptors).
- **Exactly one host global, namespaced and prototype-safe** — `__BUGSEE__`, a null-prototype registry keyed by SDK version (`packages/core/src/carrier.ts:28,49-52`). IndexedDB databases are app-token-hashed and per-instance prefixed; Web Lock names are app-token scoped. No collision surface with a host page's own IDB or locks.
- **No error-storm self-DoS** — 25 uncaught errors dispatched in a tight loop produced **3 HTTP requests total** (session + issue + one upload). Core's trigger pipeline serializes assembly and drops beyond a queue depth of 2 (`packages/core/src/trigger-pipeline.ts:28,65`), so the DOM walk and bundle assembly cannot pile up. (Detection reports bypass the `logException` rate limiter at `client.ts:591`, but the serialization bound makes that moot for burst safety.)
- **SDK self-isolation** — every SDK request, including one made through a caller-supplied `transport`, is stamped `x-bugsee-internal` (`launch.ts:248-254,285`), so network capture never records the SDK's own traffic. Mutation-caught.
- **Cross-origin `"Script error."` degrades correctly** — falls back to `event.message` plus a synthetic path-scrubbed frame from `filename:lineno:colno`, and emits no bogus `crash.json` when `event.error` is absent (`detection-providers.ts:47-60,92`). Resource-load `error` events do not bubble, and the listener is not capture-phase (`:73`), so a broken `<img>` never fabricates a crash report.
- **Viewtree privacy** — `[data-bugsee-hidden]` subtrees collapse to `{tag, masked}`; password values, `<textarea>` content and `contenteditable` text are never read; `script`/`style`/`noscript`/`template` are skipped. Measured against a real DOM containing all four; all four mutation-caught.
- **Viewtree bounds enforced** — measured exactly 2000 nodes on a ~5000-element document; depth capped at 32; per-node throw isolation verified with a hostile `getBoundingClientRect` (no throw escaped; a detached root snapshots fine). Both bounds mutation-caught.
- **Input capture is observe-only** — capture-phase + passive, never `preventDefault`/`stopPropagation`; plain typed characters, IME composition and AltGr-produced glyphs are never captured; the password/mask floor holds. All mutation-caught.
- **`componentNameFromElement`** matches all three emitters byte-for-byte and is fully throw-guarded (`component-name.ts:25-27`).
- **Runtime portability of module-scope code** — every module-level global read is a `globalThis` cast or a `typeof … !== 'undefined'` guard (`navigation-source.ts:205`, `interaction-source.ts:132`, `meta-trace.ts:26`, `system-events.ts:90-92`, `input-source.ts:234`, `viewtree.ts:80`, `environment.ts:33-45` — reads are inside arrow functions). Importing `@bugsee/browser` in a worker is safe; only `launch.ts:259` (SEV2 #3) is not.
- **Option gating** — every capture provider carries the right `controllingOption` (`captureLogs`/`captureNetwork`/`captureSystemTraces`/`captureSystemEvents`/`captureInteractions`), and `captureViewHierarchy` gates `reportSnapshots` at `launch.ts:379-382`.
- **`stack.ts`** correctly dispatches V8 vs SpiderMonkey/JSC dialects; `meta-trace.ts` and `environment.ts` are pure and fully guarded.
- **Repository hygiene** — after all probing and 20 mutations, `git status --short packages/` is empty, the full suite is 208/208 green, and `tsc --noEmit` is clean.
