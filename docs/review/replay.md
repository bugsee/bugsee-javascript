# Adversarial review — @bugsee/replay

**Reviewed:** 2026-07-26 · **Scope:** packages/replay (impl 328 LOC across 5 files, tests 419 LOC across 4 files)

**Verdict:** The plumbing is genuinely good — the lazy `import()` is real and verified in the built bundles, the rrweb runtime-export hazard flagged by the `@bugsee/rrweb` pass does **not** reach this package (every rrweb type is `import type`; the only value import is `record`, which the fork's dist does export), the recorder/encoder/register seams are clean, the canvas seam is behaviour-preserving when absent, coverage is a real 100%/100%, and 21 of 25 injected mutations were caught. The **privacy layer is where this package fails**, and it fails in the direction that matters. I ran the REAL fork bundle against a REAL (jsdom) DOM with the REAL `resolveReplayMaskingOptions` output and empirically demonstrated four masking holes, three of which need no misconfiguration or need only ordinary configuration: (1) the module's headline "password inputs are ALWAYS masked — never unmaskable" guarantee is **false** — `.bugsee-unmask` on an input hands rrweb the raw value, credit-card numbers included; (2) attribute masking is a fixed 11-entry **denylist**, so with pure defaults `data-user-email="victim@example.com"` ships in the clear; (3) a single typo in the user's `blockSelector` **silently disables all blocking**, un-blocking every image and iframe, with no error raised anywhere. The root cause is structural: every masking test asserts the **resolver's return value** — a pure function's output — and not one unit test asserts what rrweb actually **does** with that config. The one test that does (the RP6 e2e in `instrumentation-tests`) covers only the happy path. That gap is exactly why `registerReplay` silently discarding **all** caller masking options survives as a mutation. Separately: `startBlackout`/`stopBlackout` is dead code with no production caller in the entire repo, and recovered crash reports ship a `replay.bin` that is raw JSON rather than gzip.

All findings below were verified by running code, not by reading. Working tree confirmed unmodified at completion.

## SEV1

### 1. `.bugsee-unmask` on an input defeats the "password is ALWAYS masked" hard floor — raw passwords and card numbers are serialized

- **Where:** `packages/replay/src/masking.ts:118` (`unmaskInputSelector: joinSelectors(BUGSEE_UNMASK, options.unmaskTextSelector)`), contradicting the guarantee asserted at `packages/replay/src/masking.ts:5-6`, `:59`, and `:107`.
- **What:** `masking.ts` populates rrweb's `unmaskInputSelector` with `.bugsee-unmask,[data-bugsee-unmask]` plus the caller's `unmaskTextSelector`. In the fork's `record.js`, `serializeElementNode` (minified `xo`) resolves an input's value as:

  ```js
  v.value = i && e.matches(i) ? g : ut({element:e, type:ct(e), tagName:w, value:g, maskInputOptions:m, maskInputFn:o})
  ```

  where `i` is `unmaskInputSelector` and `ut` is `maskInputValue`. The unmask selector is checked **first and short-circuits the entire masking call**, so the `type==="password"` rule inside `shouldMaskInput` (minified `eo`, which does `... || u==="password" || ...` unconditionally) is never reached. `maskInputOptions: { password: true }` — the thing the code and its test point at as the hard floor — is simply not consulted on this path.
- **Why it matters:** The file's own header states the invariant in absolute terms: *"Password inputs are ALWAYS masked (a hard floor — never unmaskable even if `maskAllInputs` is turned off)"* (`masking.ts:5-6`), repeated at `:107`. `docs/design/replay.md:29` and `:60` (decision D3) make the same absolute claim. It is false. `.bugsee-unmask` is the SDK's **own documented opt-out**, offered to developers to un-mask text (`masking.ts:116`) — and because line 118 reuses the identical selector for inputs, a developer cannot un-mask an input's *label text* without also un-masking its *value*. There is no separate input-unmask option to reach for.
- **Evidence (empirical, real fork + real DOM):** driving the real `record()` with the real `resolveReplayMaskingOptions()` output and **default options**:

  | scenario | result |
  |---|---|
  | `<input type="password" value="…">` (control) | masked ✅ |
  | `<input type="password" class="bugsee-unmask" value="…">` | **raw password in the event stream** |
  | `<input type="password" data-bugsee-unmask value="…">` | **raw password in the event stream** |
  | `<input type="text" autocomplete="cc-number" class="bugsee-unmask" value="4111111111111111">` | **raw card number in the event stream** |
  | show/hide-password toggle (`type` flipped `text`→`password`) on a `.bugsee-unmask` input | **raw password in the event stream** |
  | ancestor `<div class="bugsee-unmask">` wrapping a password input | masked (the check is element-level `e.matches`, not ancestor-walking) |

  Also reachable through the caller option: `unmaskTextSelector: '*'` un-masks **everything including passwords** (verified). Note `ReplayLaunchOptions` in `packages/browser/src/launch.ts:94-120` does not *declare* `unmaskTextSelector`, but `launch.ts:452,465` spreads `options.replay` through verbatim, so an untyped JS caller reaches it at runtime.
- **Test theater:** `packages/replay/src/masking.test.ts:28-32` is titled *"ALWAYS masks password inputs, even when maskAllInputs is turned off (hard floor)"* and asserts `expect(m.maskInputOptions).toEqual({ password: true })` — a property of the resolver's return value. It cannot observe that rrweb short-circuits past `maskInputOptions` entirely. No test in the package exercises the real rrweb input path.

### 2. Attribute masking is a fixed 11-entry DENYLIST — `data-*` PII, `<meta content>`, and URL-embedded PII ship in the clear under DEFAULT settings

- **Where:** `packages/replay/src/masking.ts:32-49` (`MASKED_ATTRIBUTES` + `maskAttribute`), reached via `masking.ts:111`.
- **What:** `maskAttribute` masks a value only if its name is one of eleven hard-coded strings (`title`, `alt`, `placeholder`, `label`, `value`, `aria-label`, `aria-description`, `aria-placeholder`, `aria-valuetext`, `aria-roledescription`, `data-tooltip`). **Every other attribute passes through verbatim**, including all `data-*` attributes. The function is even labelled *"Fail-closed attribute masker"* (`masking.ts:46`), and the module header calls itself *"the fail-closed masking config"* (`masking.ts:1`) — but a denylist over an open namespace is fail-**open** by construction.
- **Why it matters:** `data-*` attributes carrying user identity are ubiquitous in real applications (React/Angular/Vue component props, analytics tagging, feature flags): `data-user-email`, `data-customer-name`, `data-account-id`. Under the fail-closed default (`maskAllText: true`, no user configuration at all) rrweb serializes every one of them into the full snapshot. This is the highest-reach hole in the package — it needs no opt-out, no misconfiguration, and no unusual markup.
- **Evidence (empirical, default options):**

  ```
  <div data-user-email="victim@example.com" data-customer-name="Jane Doe" data-account-balance="12345.67">
    data-user-email     leaked : true
    data-customer-name  leaked : true
    data-account-balance leaked: true
  <meta content="ACCOUNT-SECRET-META">     leaked : true
  <a href="/orders/user/victim@example.com"> leaked : true
  title / alt / placeholder (allow-listed)  leaked : false   ← the 11 that ARE covered work
  ```
- **Related, same line:** `masking.ts:29-31` says *"URL/style attributes (src/href/srcset/style) are handled by rrweb before `maskAttributeFn` runs"*. "Handled" is misleading — rrweb **absolutizes** those URLs (`Wi` → `ke(e,a)`), it does not mask them. PII in a URL path or query string (a well-known leak vector) is recorded verbatim, as the `href` row above shows.
- **Untested:** mutations `M8` (remove `'value'` from the set) and `M9` (remove `'aria-description'`) both **SURVIVED** the full suite — the set's membership is asserted only for `placeholder`/`title`/`aria-label` (`masking.test.ts:105-107`).

### 3. An invalid user `blockSelector` silently disables ALL blocking — every image and iframe becomes recorded, with no error

- **Where:** `packages/replay/src/masking.ts:120-125` (`joinSelectors(BUGSEE_BLOCK, MEDIA_SELECTOR, …, options.blockSelector)`).
- **What:** `joinSelectors` concatenates the caller's `blockSelector` into **one** comma-joined selector string alongside `.bugsee-block` and the whole `MEDIA_SELECTOR`. There is no validation. In the fork, `isBlocked` (minified `yo`) is:

  ```js
  function yo(e,t,r,a=null){ try{ if(a&&e.matches(a))return!1; … if(r)return e.matches(r) }catch{} return!1 }
  ```

  An invalid fragment makes `e.matches(joinedSelector)` throw `SyntaxError` for **every** element; the bare `catch{}` swallows it and returns `false` = *not blocked*. One malformed user fragment therefore poisons the entire block set — `blockAllMedia` **and** the `.bugsee-block` opt-in both stop working, page-wide.
- **Why it matters:** This is fail-open triggered by an ordinary developer typo (`'div['`, an unclosed `:has(`, a stray bracket). Nothing surfaces: `record()` does not throw, no `onError` fires, no warning is logged. The developer sees replay working and has no signal that every image, video, and iframe on the page is now being captured. The SDK's stated posture is that blocking is the privacy floor for media.
- **Evidence (empirical):**
  ```
  default masking                       → <img src="…/secret-photo.png"> BLOCKED   (true)
  + blockSelector: 'div['               → <img src="…/secret-photo.png"> NOT blocked (false)   << FAIL-OPEN
  joined selector: ".bugsee-block,[data-bugsee-block],img,svg,image,video,audio,object,picture,embed,map,source,iframe,div["
  record() threw?  no
  ```
  Contrast with text masking, which **is** fail-closed on the same input class: an invalid `maskTextSelector` leaves text masked, because `needsMask` (minified `qi`) ends its catch with `return !!maskAllText` (verified: `11 INVALID maskTextSelector → masked (fail-closed)`). The asymmetry is in rrweb, but neither the SDK's config layer nor its tests defend against it.

## SEV2

### 4. `autocomplete="cc-*"` and `type="tel"` are NOT hard-masked when `maskAllInputs: false` — a raw card number reaches the live event stream

- **Where:** `packages/replay/src/masking.ts:12` (claims the fork adds *"sensitive-input (`cc-*`/`tel`) hardening"*) and `masking.ts:106-108`; design claim at `docs/design/replay.md:60` (*"password + `autocomplete=cc-*`/`type=tel` hard-masked"*) and `:79-80` (*"detectable sensitive inputs hard-masked, never unmaskable"*).
- **What:** With `maskAllInputs: false` the resolver passes `maskInputOptions: { password: true }` only. The fork's **live input observer** (minified `Na`) gates masking on `maskInputOptions` alone:

  ```js
  (m[b.toLowerCase()] || m[x]) && (g = ut({element:v, maskInputOptions:m, tagName:b, type:x, value:g, …}))
  ```

  It never consults the unconditional `password`/sensitive-`autocomplete` rules that `shouldMaskInput` applies on the snapshot path. So `type="text" autocomplete="cc-number"` fails the gate (`m['input']` and `m['text']` are both undefined) and the typed value is emitted raw. `type="tel"` fails on **both** the snapshot and live paths.
- **Why it matters:** The design and source both state this as an absolute ("always", "never unmaskable", "hard-masked"). A developer who takes `maskAllInputs: false` at face value — reassured that the sensitive floor still holds — gets full PANs in the replay stream. PCI-relevant. Bounded to an explicit opt-out, hence SEV2 rather than SEV1.
- **Evidence (empirical, `maskAllInputs: false`):**
  ```
  <input type="tel" value="555-867-5309">                       snapshot : LEAK
  <input type="tel">  typed live                                live    : LEAK
  <input type="text" autocomplete="cc-number">  typed live      live    : LEAK
        emitted event: {"type":3,"data":{"source":5,"text":"4111111111111111","isChecked":false,"id":6}}
  <input type="text" autocomplete="cc-number" value="…">        snapshot: masked ✅
  <input type="password">  typed live                           live    : masked ✅  (maskInputOptions.password carries it)
  <input type="text" autocomplete="cc-name" value="Jane Q Cardholder">  LEAK
  ```
- **Also:** the sensitive set in the fork is eight literal tokens (`current-password`, `new-password`, `cc-number`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `one-time-code`), **not** a `cc-*` prefix match. `cc-name`, `cc-type`, `cc-given-name`, `cc-family-name` are not covered, so "`autocomplete=cc-*` always masked" is over-broad even where the mechanism does fire.

### 5. `startBlackout` / `stopBlackout` is dead code — no caller anywhere in the repo, and the designed public blackout API does not exist

- **Where:** `packages/replay/src/recorder.ts:44-46,76,89-95`; returned but discarded at `packages/browser/src/launch.ts:464`.
- **What:** `registerReplay` returns the recorder specifically *"so the caller can wire `client.startBlackout` → its blackout controls"* (`register.ts:5-6,39`). The only production caller, `browser/src/launch.ts:464`, calls `m.registerReplay(client, fileEncoders, {…})` as a bare statement and **throws the return value away**. A repo-wide grep for `startBlackout|stopBlackout|blackout` outside `packages/replay` and the design docs returns **zero** hits — `@bugsee/core`'s client has no blackout method at all.
- **Why it matters:** `docs/design/sdk-design.md:401-403` specifies `startBlackout()`/`endBlackout()`/`isBlackout()` as public API, `:1409` names blackout as the SDK's mechanism for gating visual capture (explicitly, as the replacement for the removed consent API), and `docs/design/replay-canvas.md:158,231` leans on "blackout still applies" as a privacy argument for the canvas add-on. None of it is reachable. Any customer told to use blackout to hide a sensitive screen gets a full recording of it.
- **Secondary effect:** `recorder.test.ts:84-102` ("DROPS events while blacked out") passes and gives the appearance of a working privacy control that cannot be triggered in production.

### 6. Recovered crash reports ship a `replay.bin` that is raw JSON, not gzip — the player cannot read it

- **Where:** `packages/browser/src/launch.ts:508` (`context: () => ({ appToken, environment: getEnvironment(), clock })`) → `packages/core/src/capture-recovery.ts:45,71` → `packages/core/src/bundle-assembler.ts:155-158`.
- **What:** `registerReplay` installs its encoder into the **live client's** `fileEncoders` map (`register.ts:57`). The dead-sibling recovery path builds a *separate* `BundleAssemblyContext` that omits `fileEncoders` entirely. Recovered capture chunks contain `replay` entries (replay rides the ordinary capture stream by design — `recorder.ts:2-4`), so at `bundle-assembler.ts:155-157` `encoder` is `undefined` and the file falls through to `JSON.stringify(serializeFileData('replay', payloads))`. The manifest still declares `{ filename: 'replay.bin', type: 'replay' }`.
- **Why it matters:** The bundle is internally consistent (the file is present, unlike the Pass-D class of defect), but its **content** is wrong: `replay.bin` is a JSON array where the consumer does `ungzip → JSON.parse` (`encoder.ts:2`). Silent corruption on precisely the highest-value path — the report recovered after a crash or tab kill, which is the whole reason durable capture exists. `packages/webworker/src/launch.ts:339` has the identical shape (harmless there today only because webworker never registers replay).
- **Note:** the live path is race-free — `register.ts:54` and `:57` are synchronous with no await between them, so a provider can never emit before its encoder is registered. The defect is confined to recovery.

### 7. Shadow DOM is recorded, not excluded — contradicting the stated privacy exclusion

- **Where:** `packages/replay/src/masking.ts` (no shadow-DOM handling exists anywhere in the package); claim at `docs/design/replay.md:29` (*"iframes + shadow DOM excluded by default"*), repeated at `:60` (D3) and `:86`.
- **What:** Nothing in the resolved config touches shadow roots, and rrweb 2.1's `ShadowDomManager` traverses them by default. Verified empirically both for a shadow root attached **before** `record()` starts and one attached **after**: `isShadowHost` appears in the stream in both cases, i.e. the shadow subtree is serialized.
- **Why it matters:** Text inside is masked (verified: no cleartext, mask runs present), so this is not a raw leak — but a customer who reads the design doc and places PII inside a shadow root believing it is *excluded* is relying on a guarantee the code never implements. Structure, attributes (see SEV1-2), and element geometry are all captured.

### 8. `blockAllMedia: false` silently starts recording same-origin iframe DOM, though the code asserts iframes are never recorded

- **Where:** `packages/replay/src/masking.ts:16-18` (*"Includes `iframe` — iframes are never recorded (§27#10)"*) and `packages/replay/src/recorder.ts:72-74` (*"Cross-origin iframes are never recorded (privacy); same-origin iframes are blocked via the masking blockSelector (fail-closed, RP1)"*).
- **What:** `iframe` is inside `MEDIA_SELECTOR`, which is added to `blockSelector` **only when `blockAllMedia` is true** (`masking.ts:120-125`). Setting `blockAllMedia: false` — a documented option whose stated purpose is media, not frames — removes iframes from the block set. `recordCrossOriginIframes: false` does not help: it governs *cross-origin* frames only; same-origin iframe subtrees are recorded by rrweb's `IframeManager` regardless.
- **Why it matters:** Both comments state the exclusion as unconditional. There is no `blockIframes` control, so a developer who wants images visible in replay cannot keep iframes excluded. Third-party same-origin iframes (payment widgets, embedded admin panels) become part of the recording.
- **Evidence (empirical):** default → iframe emitted as a `rr_width`/`rr_height` placeholder ✅. `blockAllMedia: false` → iframe serialized with **no placeholder**, subtree recorded (text inside masked by `maskAllText`, so no cleartext today — the exposure is structure + attributes + any content the attribute denylist misses).

### 9. `maskAllText` is a fork-only option — repointing the "swappable" `@bugsee/rrweb` at upstream rrweb silently unmasks every text node

- **Where:** `packages/replay/src/masking.ts:113` (`maskAllText`) and the stale note at `masking.ts:10-13`.
- **What:** `@bugsee/rrweb` exists explicitly so that *"swapping the source touches ONLY this file"* (`packages/rrweb/src/index.ts:5-6`). But `maskAllText` does not exist in upstream `rrweb@2.1.0`'s `recordOptions` (confirmed in the `@bugsee/rrweb` review pass: none of the five augmented options appear in `rrweb@2.1.0/dist/rrweb.d.ts:220-252`). Upstream would **ignore** the property, and `maskTextSelector` is only `.bugsee-mask,[data-bugsee-mask]` — so every text node on the page would be recorded in the clear, with no error and no type failure at the seam.
- **Why it matters:** A fail-open failure mode gated on a dependency swap that the architecture actively invites. The blast radius is total (all page text). Nothing catches it: every unit test asserts the resolver's return value, so all 33 would still pass; the only test that exercises real rrweb is the RP6 e2e in a different package.
- **Compounding:** `masking.ts:10-13` still claims *"upstream rrweb 2.1 has no `maskAllText` boolean (we emulate it with `maskTextSelector: '*'`) … this config stays fail-closed on upstream in the meantime."* The code does **not** do that emulation — verified: the resolved `maskTextSelector` is `.bugsee-mask,[data-bugsee-mask]`. A maintainer reading the comment would conclude upstream is safe. It is not.

### 10. An invalid `unmaskTextSelector` throws an uncaught `SyntaxError` into the host page and aborts the snapshot

- **Where:** `packages/replay/src/masking.ts:117-118` (no validation) → the fork's `xo`, where `e.matches(i)` is **not** inside a try/catch (unlike `yo` and `qi`).
- **What:** With `unmaskTextSelector: 'div['`, the DOM throws `SyntaxError: … is not a valid selector` from inside `serializeElementNode`. It propagates up through `Pe`→`So`→`xo` and surfaces as an **uncaught exception in the window**.
- **Why it matters:** Two host-behaviour violations. (a) The full snapshot is aborted, so replay produces an unusable stream while appearing to run. (b) The exception reaches the page's error handling — which, in a Bugsee-instrumented page, means `createWindowErrorProvider` (`packages/browser/src/launch.ts:473`) captures the SDK's own config error as a **crash report attributed to the host app**. Design goal *"a recorder bug never breaks the host page"* (`docs/design/replay.md:81`) is not met for this input class.
- **Evidence:** jsdom reported `Uncaught [SyntaxError: '.bugsee-unmask,[data-bugsee-unmask],div,' is not a valid selector]` with the stack through `record.js` `xo`→`So`→`Pe`. Masking itself stayed fail-closed (no leak), and `record()` did not throw synchronously — the escape is asynchronous.

### 11. Prototype pollution on `Object.prototype` disables masking

- **Where:** `packages/replay/src/masking.ts:98-103` — `options.maskAllText ?? true` etc., with a `{}` default.
- **What:** `??` only guards `null`/`undefined` and property lookup walks the prototype chain. With `Object.prototype.maskAllText = false` set by any pollution gadget on the page, `resolveReplayMaskingOptions()` — called with **no arguments** — returns `maskAllText: false`, and `Object.prototype.blockAllMedia = false` removes `MEDIA_SELECTOR` from the block set.
- **Why it matters:** Prototype pollution is a mainstream client-side vulnerability class. Any polluted page silently downgrades Bugsee from fail-closed to fail-open, with the SDK reporting nothing. For a module whose header declares privacy *"THE risk surface"*, hardening is cheap: `Object.hasOwn(options, 'maskAllText') ? … : true`, or `options !== null && typeof options === 'object'` + own-property reads.
- **Evidence:** `Object.prototype.maskAllText = false; resolveReplayMaskingOptions({})` → `maskAllText=false`, `blockSelector` no longer contains `img`. Related, same line: `??` also passes falsy non-booleans straight through — `maskAllText: 0` yields `0` and `maskAllInputs: ''` yields `''`, both of which rrweb reads as *off*. No normalization or validation exists.

### 12. `checkoutEveryNms` is decoupled from `maxRecordingTime`/`maxDataSize`, so ring eviction can drop the FullSnapshot and produce an unplayable `replay.bin`

- **Where:** `packages/replay/src/recorder.ts:62` (`options.checkoutEveryNms ?? 60_000`); design intent at `docs/design/replay.md:61` (D4: *"full-snapshot `checkoutEveryNms` ≈ maxRecordingTime"*).
- **What:** The design couples the snapshot cadence to the ring window. The implementation hard-codes 60 000 ms and never reads `maxRecordingTime` or `maxDataSize`. `packages/browser/src/launch.ts` passes neither into `registerReplay` (`launch.ts:464-467` forwards only the masking subset + `checkoutEveryNms` + `canvas`). The defaults happen to match (browser `maxRecordingTime` = 60 s), so the coupling holds **by coincidence only**.
- **Why it matters:** rrweb streams are not independently sliceable — without a FullSnapshot at the head, incremental mutations cannot be replayed. Set `maxRecordingTime: 30` and the 60 s-spaced snapshots are evicted from the 30 s window roughly half the time, yielding a `replay.bin` the player cannot render. The byte cap (`maxDataSizeBytes`, `packages/core/src/memory-capture-store.ts:15-18`, browser default 10 MB) evicts oldest-closed-parts-first, which can drop the snapshot the same way on a mutation-heavy page. On an idle page rrweb's checkout fires on the next mutation *after* the interval, so it may not fire at all and the window can end up with no snapshot. Nothing detects, warns about, or tests any of this. (The ring **is** correctly bounded in bytes as well as time — that part of the brief's concern is clean; the defect is snapshot-integrity, not unbounded growth.)

## SEV3

### 1. Test theater: `registerReplay` ignoring ALL caller masking options survives the full suite

- **Where:** `packages/replay/src/register.test.ts:54-61` ("forwards masking option overrides").
- **What:** Mutating `register.ts:48` from `resolveReplayMaskingOptions(options)` to `resolveReplayMaskingOptions({})` — i.e. every caller-supplied masking option silently discarded — **SURVIVED**: 33/33 still passed. The test asserts only `maskTextSelector` `.not.toBe('*')` and `.toContain('.bugsee-mask')`, both of which hold under defaults too. It never asserts `maskAllText === false` in the config rrweb actually received.
- **Why it matters:** `registerReplay` is the sole production entry point. This is the exact mutation that would ship "masking options are ignored" to production undetected.

### 2. `toContain`-only assertions on the un-mask / un-block selectors let wildcard-widening pass

- **Where:** `packages/replay/src/masking.test.ts:14-16,24-25`.
- **What:** Three mutations appending `'*'` to `unmaskInputSelector` (M5), `unmaskTextSelector` (M6), and `unblockSelector` (M7) all **SURVIVED**. Each is a total privacy defeat — `unmaskInputSelector: '…,*'` un-masks every input value on the page, `unblockSelector: '…,*'` un-blocks every image and iframe — and `toContain('.bugsee-unmask')` / `toContain('.bugsee-show')` remain true. Given SEV1-1, these are the highest-value selectors in the package and the weakest assertions. `ignoreSelector` is the one selector asserted with `toBe` (`masking.test.ts:70`); the pattern should extend to the rest.

### 3. No unit test asserts what rrweb DOES with the config — only what the resolver returns

- **Where:** all of `packages/replay/src/masking.test.ts`; `recorder.test.ts:38-52` and `register.test.ts:40-52` assert the config object handed to a **fake** `record`.
- **What:** The recorder/register tests do correctly assert the config passed to `record()` (not merely that it was called) — that part is done right, and it caught 21 of 25 mutations. But every masking assertion terminates at the resolver's return value. The behavioural gap is what let SEV1-1 (unmask short-circuits `maskInputOptions`), SEV2-4 (live observer ignores the sensitive floor) and SEV1-3 (invalid selector → global fail-open) all ship. The RP6 e2e (`packages/instrumentation-tests/test/replay.e2e.ts`) is the only behavioural check and covers exactly one happy path (`replay: true`, default masking, one secret). Every scenario in this review runs in jsdom — a real-browser harness is not required to catch any of them.

### 4. The ≤15 KB errors-only budget is never gated

- **Where:** claimed at `packages/browser/src/launch.ts:447`, `packages/replay/src/index.ts:1-2`, `docs/design/replay.md:26,48,105`.
- **What:** `size-limit` and `@size-limit/preset-small-lib` are root devDependencies (`package.json:33,40`) but there is **no** `size-limit` config key, no `.size-limit*` file in the repo, no `size` script, and no reference in `turbo.json` or `.github/workflows/ci.yml`. The budget that justifies the entire lazy-load architecture is aspirational. (The lazy-load itself is verified correct — see below.)

### 5. `replay` on DOM-less runtimes is silently ignored, not "ignored with a warn"

- **Where:** `docs/design/sdk-design.md:372` and `:1207` both specify *"the `replay` option is ignored with a one-time `debug.warn`"*.
- **What:** `packages/node/src/launch.ts` and `packages/webworker/src/launch.ts` contain no reference to `replay` at all — the option is dropped with no diagnostic. A JS caller passing `replay: true` to the Node or Worker SDK gets silence. (Import safety itself is clean — see below.)

### 6. README is stale and names Sentry as the fork source

- **Where:** `packages/replay/README.md`.
- **What:** Reads *"rrweb-based recorder (vendored Sentry fork) — external rrweb dep added when implemented"* and *"**Status:** stub."* for a package that is fully built (RP0–RP6, plus the canvas seam). The dependency is the **Bugsee** fork (`packages/rrweb/package.json:27`), not a Sentry one — and `CLAUDE.md` binds that Sentry is a design reference only, never a source.

### 7. `.bugsee-show` overrides an explicit `.bugsee-block` on the same element

- **Where:** `packages/replay/src/masking.ts:119-125`; the fork's `yo` checks `unblockSelector` **before** `blockClass`/`blockSelector` and returns early.
- **What:** An element carrying both `.bugsee-block` and `.bugsee-show` is **not** blocked. This is the correct precedence for the O2 `blockAllCanvas` design (`.bugsee-show` opts a canvas back in), but it means an explicit per-element block instruction loses to an un-block, which is the fail-open direction and is documented nowhere. Worth one line of comment at `masking.ts:116`.

### 8. `maskAttributeFn` throws on non-string values

- **Where:** `packages/replay/src/masking.ts:48` — `'*'.repeat(value.length)`.
- **What:** `maskAttribute('placeholder', undefined)` and `(…, null)` throw `TypeError: Cannot read properties of undefined (reading 'length')`; `(…, 12345)` returns `''`, silently dropping the value. Unreachable through rrweb today (`Wi` short-circuits on a falsy value and DOM attribute values are always strings), but `maskAttributeFn` is part of the exported `ResolvedReplayMasking` public surface. `String(value)` would close it.

### 9. The recorder sets no `controllingOption`

- **Where:** `packages/replay/src/recorder.ts:50` (only `name = 'replay'`); design at `docs/design/replay.md:122` specifies *"`controllingOption` = the replay option"*.
- **What:** Harmless today because `browser/src/launch.ts:449` registers the provider only when replay is enabled, so the coordinator gate is redundant. Flagged as a design/implementation delta, since any future caller that registers unconditionally would get an ungated recorder.

## Masking fail-closed audit

| guarantee | enforced where (file:line) | overridable by user? | test asserts the real rrweb config? |
|---|---|---|---|
| `maskAllText` default `true` | `masking.ts:100,113` | yes — `maskAllText:false` (intended); **also via `Object.prototype` pollution** (SEV2-11) and falsy non-booleans; **fork-only option — upstream rrweb ignores it** (SEV2-9) | ✗ resolver output only (`masking.test.ts:8`); rrweb config asserted against a **fake** `record` (`recorder.test.ts:48`); real rrweb only in the RP6 e2e happy path |
| `maskAllInputs` default `true` | `masking.ts:101,106` | yes (intended); + prototype pollution | ✗ resolver + fake `record` (`masking.test.ts:7`, `recorder.test.ts:47`) |
| `blockAllMedia` default `true` | `masking.ts:102,120-125` | yes (intended); + prototype pollution; **+ silently defeated page-wide by an invalid `blockSelector`** (SEV1-3) | ✗ `toContain(MEDIA_SELECTOR)` on the resolver (`masking.test.ts:9`) |
| password ALWAYS masked | `masking.ts:108` (`maskInputOptions:{password:true}`) + fork `eo`'s unconditional `u==="password"` | **YES — broken.** `.bugsee-unmask`/`[data-bugsee-unmask]` on the input, or `unmaskTextSelector`, short-circuits both (SEV1-1) | ✗ **theater** — `masking.test.ts:31` asserts `maskInputOptions` equals a constant; rrweb never consults it on the unmask path |
| `autocomplete` cc-* ALWAYS masked | fork `eo` sensitive set (8 literal tokens) — **nothing in this package** | **YES — broken.** Not applied by the live input observer when `maskAllInputs:false` (SEV2-4); `cc-name`/`cc-type`/etc. never covered; `.bugsee-unmask` bypasses it | ✗ **no test at all** in the package |
| `type=tel` hard-masked (`masking.ts:12`, design D3) | **nowhere** | **YES — broken.** Unmasked on both paths when `maskAllInputs:false` (SEV2-4) | ✗ no test |
| iframe excluded | `masking.ts:18` (inside `MEDIA_SELECTOR`) + `recorder.ts:74` (`recordCrossOriginIframes:false`) | **YES** — `blockAllMedia:false` un-blocks same-origin iframes despite the unconditional claim (SEV2-8) | ✗ `masking.test.ts:61-64` asserts the string contains `iframe` |
| shadow DOM excluded (design `replay.md:29,60`) | **nowhere — not implemented** | n/a — shadow roots are always recorded (masked) (SEV2-7) | ✗ no test |
| attribute values masked | `masking.ts:32-49` — **11-entry denylist** | **n/a — fail-open by construction.** `data-*`, `meta content`, URL PII in the clear at defaults (SEV1-2) | ✗ 3 of 11 members asserted; M8/M9 removals **survived** |

## Lazy-load verification

**Genuinely dynamic — verified in the built artifacts, not just the source.** `packages/browser/dist/index.js` and `index.cjs` both contain `import('@bugsee/replay').then(async (m) => {` and no static `import … from '@bugsee/replay'` (grep for `^import .*@bugsee/replay` → zero hits in the ESM bundle). `@bugsee/replay-canvas` is separately dynamic and nested inside the replay `.then`, so a replay-without-canvas user never loads it. The barrel (`packages/replay/src/index.ts`) statically re-exports `register.ts`, which statically imports `@bugsee/rrweb` (`register.ts:8`) — correct, since the whole barrel is behind the dynamic boundary. `@bugsee/replay-canvas` reaches back with `import type { CanvasRecordConfig } from '@bugsee/replay'` (`canvas-config.ts:6`), fully erased under `verbatimModuleSyntax`, so there is no cycle and no static pull-in.

**Rejection path is handled.** `browser/src/launch.ts:454-469` chains `.catch((error) => options.onError?.(error))` after the `.then`, so a chunk 404 / CSP block / offline failure — and any throw inside `registerReplay` itself — is caught. No unhandled rejection escapes to the page. Degradation is quiet: `fileEncoders.replay` is never set, no provider is installed, and the SDK continues without replay. Two notes: `onError` defaults to `undefined`, so the failure is **completely silent** by default; and if the import resolves after `client.stop()`, `capture-coordinator.ts:74-80` has already set `session = null`, so `addProvider` registers without starting — no post-stop recording. That race is clean.

**Size budget is NOT gated** — see SEV3-4. `size-limit` is installed but unconfigured and unreferenced by any script, `turbo.json`, or CI. The ≤15 KB claim is unverified.

## rrweb runtime-export check

**Clean — the `@bugsee/rrweb` SEV2 does not reach this package.** Every rrweb import here is type-only and fully erased: `masking.ts:14` (`import type { recordOptions }`), `recorder.ts:10` (`import type { eventWithTime, listenerHandler, recordOptions }`). The single **value** import is `register.ts:8` — `import { record as rrwebRecord } from '@bugsee/rrweb'` — and `record` is genuinely exported by `dist/index.js` (the fork bundle's sole export). `EventType`, the enum the prior pass proved is declared in `dist/index.d.ts` but absent from `dist/index.js`, is **not imported anywhere in this package** (grep confirms). Verified empirically: importing `packages/replay/src/index.ts` in bare Node with `typeof document === 'undefined'` loaded successfully, exported all six public symbols, and `encodeReplay([])` / `resolveReplayMaskingOptions()` both executed correctly. No SEV1 crash on the replay path.

## Checked and found clean

- **Recorder seam.** `recorder.ts:67-81` spreads the full masking object into `record()`, forces `recordCrossOriginIframes: false`, and routes `emit` → `this.capture('replay', event.timestamp, event)`. `onStop` calls the stop handler and nulls it (`recorder.ts:84-87`), so rrweb's observers are disconnected on stop. Mutations R1–R5 (drop the masking spread, flip `recordCrossOriginIframes`, no-op the blackout guard, change the checkout default, skip the stop handler) were **all caught**.
- **Canvas seam is behaviour-preserving when absent.** `recorder.ts:70` spreads `...this.#canvas` and `register.ts:52` omits the key entirely when `undefined`. `recorder.test.ts:138-151` asserts `recordCanvas`/`sampling`/`dataURLOptions` are all **absent** by default, and `register.test.ts:94-100` covers the register level. Mutation R6 (emit `recordCanvas: true` when no canvas config was supplied) was caught. A user without `@bugsee/replay-canvas` installed pays nothing: no import, no config key, no rrweb behaviour change. `blockAllCanvas` correctly defaults to `false` and adds only `canvas` to the block set (M11 caught).
- **Encoder.** `encodeReplay` is a pure `gzipSync(strToU8(JSON.stringify(payloads)))`. Round-trip, gzip magic bytes, compression ratio, and the empty-stream case are all asserted (`encoder.test.ts`). Mutation E1 (skip gzip) caught. Registered into the shared map synchronously before any event can flow (`register.ts:54,57`); G2 (drop the registration) caught.
- **Manifest / zip parity.** `bundle-assembler.ts:150-158` pushes the manifest entry and the zip entry inside the **same** loop iteration, over a map seeded only with non-empty groups — so `replay.bin` can never be declared without being written. The Pass-D defect class does not exist here. (The *content* defect in recovery is SEV2-6, a different problem.)
- **Ring bounding is in bytes, not just count.** `packages/core/src/memory-capture-store.ts:12-18` enforces both `maxRecordingTimeMs` and `maxDataSizeBytes` (browser default 10 MB), evicting oldest closed parts. A single huge DOM mutation is bounded. The unbounded-growth concern in the brief is unfounded; the real ring defect is snapshot integrity (SEV2-12).
- **Wrong-incident attachment.** Not reproducible. Replay entries flow through the standard capture store and are drained per report by the shared exporter, so every report gets the same correctly time-bounded window — the intended rolling-buffer semantics. Recovered reports read that dead sibling's own prefixed views under its Web Lock.
- **Post-stop / double-registration races.** `capture-coordinator.ts:74-80` nulls `session` on stop, so a late `addProvider` never starts. `addProvider` throws on a duplicate provider name, and that throw would land in the launch `.catch`. Neither is reachable in the browser flow.
- **DOM-less import safety.** Importing the package in bare Node (no `document`, no `window`) does not throw — verified by execution. The fork's only top-level DOM touch is feature-guarded and try/caught (confirmed in the `@bugsee/rrweb` pass). Replay is correctly *not* a no-op shim.
- **Text masking is fail-closed on malformed selectors.** An invalid `maskTextSelector` leaves text masked, because `needsMask` ends its catch with `return !!maskAllText`. Ancestor precedence works as documented — a nearer `.bugsee-unmask` wins over a farther mask marker (the fork's `qi` compares ancestor distances). `joinSelectors` correctly drops empty fragments with no dangling or doubled commas (`masking.test.ts:85-95`).
- **`.bugsee-show` does not accidentally un-mask text or inputs.** It is wired to `unblockSelector` only (`masking.ts:119`); un-masking is a separate selector. The one precedence quirk is SEV3-7.
- **Malformed masking config does not fail open into an unmasked recording.** An options object whose getter throws propagates out of `resolveReplayMaskingOptions` → caught by the launch `.catch` → replay never starts. Fail-closed. (The genuine fail-open paths are SEV1-2, SEV1-3, and SEV2-11, which are structural rather than exception-driven.)
- **Gates pass.** `pnpm --filter @bugsee/replay exec vitest run` → 33/33. `pnpm --filter @bugsee/replay exec tsc --noEmit` → exit 0. Coverage: **100% statements (36/36), 100% branches (30/30), 100% functions (13/13), 100% lines (35/35)** — real coverage, not the vacuous `0/0` seen in `@bugsee/rrweb`.
- **Mutation harness validated.** 25 mutations injected across all four source files, each applied from a `cp` backup and restored from that backup (never `git checkout`). Control run: 33/33 green. **21 caught, 4 survived** (M5, M6, M7, M8/M9, G1 — reported in SEV3-1/2 and SEV1-2). Every caught mutation failed a *targeted* assertion, not a collection error.
- **Working tree untouched.** `git status --short packages/` → empty, verified mid-review and again at completion. All probes and mutation scripts live in the scratchpad.
