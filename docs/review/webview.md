# Adversarial review — @bugsee/webview

**Reviewed:** 2026-07-27 · **Scope:** packages/webview (impl 1448 LOC across 12 files, tests 2190 LOC across 11 files + 321 LOC of e2e in `packages/instrumentation-tests/test/webview-{conformance,bundle}.e2e.ts`)

**Verdict:** The engineering here is genuinely good — the mutation campaign (13 mutations, §Test quality) was caught 13/13 by the unit suite, the slice-7 conformance harness is a real contract test rather than theater, the IIFE is provably self-contained, and the Android receiver I read (read-only, separate repo) is defensively written and does **not** reproduce the Electron `path.join` defect. The problems are all at the trust boundary, and they cluster on one unexamined assumption: **the WebView page is treated as trusted.** Both bridge globals (`window.BugseeBridge`, `window.__bugsee_bridge`) are unauthenticated, page-reachable, and — critically — the JS→native sink is **re-resolved on every post**, so any script that loads after the SDK becomes a complete tap on the capture stream (console logs, network URLs, request/response bodies), all of which cross the boundary **un-redacted by default**. Separately, the D10 obscuring path is **fail-open in three distinct ways**: `hello` declares the `obscuring` capability (which is what makes native drop its own legacy masking script) *before* obscuring is proven to work, there is no try/catch anywhere in the obscuring path, and the synchronous native rect-pull propagates exceptions into `evaluateJavascript` — so a single DOM error at frame-capture time yields *no* mask on a page where native has already stood down. On the contract side, three declared protocol features (`accept` version negotiation, `config.enabledTypes`, `config.session`) are **parsed and then silently dropped**, and the shipped schema's `secureArea` definition is orphaned — I proved by mutation that renaming a rect field passes the conformance harness while the native side reads it by name. Prior-verification note: my brief's prior was accurate on architecture and slices 1–7; it was **wrong** to expect the Electron wire-`type`→path defect to have a native analogue here (see §Checked and found clean).

## SEV1

### 1. Obscuring fails OPEN when rect computation throws — at exactly the moment native captures a frame
- **Where:** `packages/webview/src/obscuring-channel.ts:83` → `packages/webview/src/obscuring-composer.ts:183-187` → `packages/webview/src/obscuring-source.ts:52-70`; exposed at `packages/webview/src/launch.ts:342`
- **What:** `__bugsee_bridge.snapshot()` is the synchronous pull native performs at frame-capture time to learn which rects to mask. The whole chain — `JSON.stringify(composer.snapshot())` → `source.snapshot()` → `collectSecureAreas()` → `document.querySelectorAll()` + `element.getBoundingClientRect()` — has **no try/catch at any level**. `grep -n 'try' packages/webview/src/obscuring-*.ts` returns nothing.
- **Why it matters:** Declaring the `obscuring` capability is precisely what tells native to suppress its legacy masking script (D10, `docs/design/webview-bridge.md:67`). So when this throws, there is no second line of defence: native gets an exception instead of rects and renders the frame **unmasked**, with password / `cc-*` / `.bugsee-hide` content in it. The correct failure mode for a masking system is to obscure *more* (e.g. return the last known rect set, or a full-viewport rect); this returns *nothing*.
- **Evidence:** Probe E against the real SDK — a healthy pull returns `[{"type":"text","top":5,"left":6,"bottom":7,"right":8}]`; after `document.querySelectorAll` starts throwing, the same call yields `Error: DOM error at frame-capture time` **thrown out of `snapshot()`** rather than a rect list. A page script can trigger this deliberately in one line (`document.querySelectorAll = () => { throw 0 }`), and a benign DOM/extension error triggers it accidentally.

### 2. `hello` declares the `obscuring` capability before obscuring is proven to work, and the protocol has no way to retract it
- **Where:** `packages/webview/src/launch.ts:335` (cap computed from *construction* success only), `:347` (hello posted), `:351` (`obscuring?.start()` — the first call that actually touches the DOM)
- **What:** `caps` is `obscuring !== undefined ? [...CAPABILITIES, 'obscuring'] : [...]`. `createObscuringChannel` (`:325`) only builds objects; it never reads the DOM. The first DOM read is `composer.start()` → `source.snapshot()`, which runs at `:351` — **four statements after the hello was already posted**. If it throws, `launch()` propagates the exception and no `secure` message is ever sent.
- **Why it matters:** Native has been told "the advanced SDK masks sensitive pixels itself → drop the legacy masking script", and then receives zero rects for the lifetime of the session. There is no `caps`-retraction message in the protocol (`packages/webview/src/protocol.ts:18-25` — kinds are hello/entry/batch/report/secure/control/bye), so this state is unrecoverable without a page reload. Compounding it, the abort happens *after* `client.launch()` (`:349`) and *after* `global.__bugsee_bridge` is installed (`:340`), but *before* `setCarrierClient(publicClient, carrier)` (`:368`) — so the singleton guard at `:153` is never armed and a subsequent `launch()` installs a **second** client (double console patch, double capture).
- **Evidence:** Probe D — `launch-threw: "Error: page hostile / DOM error"`, `hello-was-sent: true`, `hello-declared-obscuring: true`, `secure-messages-sent: 0`, `control-global-installed: "object"`, `capture-still-running: true`.

### 3. The JS→native sink is re-resolved on every post — any later-loading script becomes a full capture tap
- **Where:** `packages/webview/src/host-bridge.ts:37-40` (`resolve()` reads `global.BugseeBridge` fresh per call), `:54-68` (`post` calls `resolve()` every time)
- **What:** The reference to the native `@JavascriptInterface` object is deliberately **not** captured at launch ("Re-resolve on every post: native may register the interface after the script starts"). There is no identity check and no memo of the first-seen object. A third-party script (ad tag, analytics, chat widget, anything the customer embeds) that assigns `window.BugseeBridge = { post: s => { exfil(s); orig(s) } }` after the SDK boots receives **100% of subsequent capture**, and the SDK keeps working so nothing looks wrong.
- **Why it matters:** By design, JS-side redaction is **off unless the integrator configures a filter** — `packages/webview/src/launch.ts:105-107`: "By default the FilterStore is empty, content streams un-redacted (`red:false`) and native applies its canonical filters". Combined with `captureNetworkBodies` defaulting to `true` at 20 KB (`launch.ts:86-89`, `:274-276`), the intercepted stream carries full request URLs (query-string credentials — the known `@bugsee/capture` issue) and request/response bodies for the entire host app. This is a data-exfiltration primitive with the SDK as the collector.
- **Evidence:** Probe 3 — an attacker shim installed *after* `launch()` reported `attacker-intercepted-count: 1`, `attacker-saw-secret: true` for a plain `console.log('secret-token-abc123')`, while `sdk-still-works: true`. Mitigation is partly native's (a transferred `WebMessageChannel` `MessagePort` is not a page global and cannot be swapped post-handshake — the design already lists it as a fallback at `docs/design/webview-bridge.md:202`); the JS-side half is to resolve once and pin.

### 4. `__bugsee_bridge` is an unauthenticated, replaceable page global → capture suppression and spoofed secure rects
- **Where:** `packages/webview/src/launch.ts:340-343` (plain assignment; `Object.freeze` protects the *object*, not the *binding*), `packages/webview/src/host-bridge-control.ts:35-49`, `packages/webview/src/protocol.ts:272-287`
- **What (a) — capture suppression:** `parseControl` authenticates nothing. Any script in the page can call `__bugsee_bridge.control('{"b":1,"k":"control","command":"pause"}')` to silently stop the capture stream, or `"stop"` to tear the SDK down permanently. Nothing is logged, no `onError` fires, and native is not told that the pause was not its own.
- **What (b) — obscuring spoof:** `Object.getOwnPropertyDescriptor(global,'__bugsee_bridge')` is `{writable:true, configurable:true}`. A page script replaces the whole binding with `{control(){}, snapshot(){return '[]'}}`; native's frame-capture pull then returns an empty rect list while the real secure areas exist. Same privacy outcome as SEV1-1, reached deliberately. `Object.defineProperty(global, '__bugsee_bridge', {value: …, writable:false, configurable:false})` would close the binding half.
- **Evidence:** Probe A — `capture-before-pause: 1`, `capture-after-hostile-pause: 0`; then a page-issued `stop` produced `bye-posted: 1`, `control-global-after-hostile-stop: undefined`, `capture-after-hostile-stop: 0`. Probe B — `real-snapshot: [{"type":"text","top":5,…}]` vs `spoofed-snapshot: []`. No test in the package exercises any of this: `grep -n -i 'freeze\|frozen\|overwrit\|hostile\|malicious' packages/webview/src/*.test.ts` returns **nothing**.

## SEV2

### 5. A page script can forge arbitrary wire messages UP to native, bypassing the D5 report gate
- **Where:** `packages/webview/src/host-bridge.ts:21` (`BugseeBridge` is read off the page global), `packages/webview/src/webview-report-pipeline.ts:59-61` (the D5 gate lives only in JS)
- **What:** `window.BugseeBridge.post(json)` is callable by any script. The D5 `reportTrigger` gate (default off, `launch.ts:189`) is a JS-side policy check, not a channel property, so a page script simply posts its own `{"k":"report",…}` and opens native bug reports at will. It can equally inject fabricated `entry` messages, poisoning the customer's incident timeline, and choose any `s` (seq) to disturb ordering/dedup.
- **Evidence:** Probe C, with the gate **off** — `forged-kind-reached-native: "report"`, `forged-t-reached-native: "../../../etc/passwd"`, `forged-seq: 999999`. The hostile `t` is harmless against today's Android receiver (see §Checked and found clean) but is exactly the field the native team must never grow a path/index use for.

### 6. Protocol version negotiation is specified but not implemented on either side
- **Where:** `packages/webview/src/protocol.ts:137-138` (`accept?: number` declared) — **no reader exists**: `grep -rn '\baccept\b' packages/webview/src/` matches only the type declaration and a test fixture (`protocol.test.ts:252`). `packages/webview/src/protocol.ts:283` accepts *any* numeric `b`. On the native side, `…/android/sdk/library/src/main/java/com/bugsee/library/interception/webview/BridgeMessageParser.java:35-37` accepts any `version > 0` and then parses it with v1 field expectations.
- **What:** `docs/design/webview-bridge.md:162` requires "native accepts the highest protocol version it speaks ≤ JS's … a JS newer than native degrades to the accepted version." Neither degradation nor rejection exists. Old-native/new-JS and new-native/old-JS both silently mis-parse instead of degrading.
- **Evidence:** Probe H — a control message claiming `b:9999, accept:9999` was applied in full (`v9999-control-applied-reportTrigger: true`) while the SDK kept emitting `b:1`.

### 7. `config.enabledTypes` is accepted by the type and the schema but never applied
- **Where:** `packages/webview/src/protocol.ts:126-127` ("The capture FileTypes native wants (others are suppressed)"); `packages/webview/bridge-protocol.schema.json:131`. `grep -rn 'enabledTypes' packages/webview/src/` matches **only** the declaration and `protocol.test.ts:254` — `host-bridge-control.ts:40-48` applies `session` and `config.reportTrigger` and nothing else.
- **Why it matters:** `docs/design/webview-bridge.md:191` lists `enabledTypes` as a first-class control, and it is the mechanism by which native suppresses double-capture when legacy also loads (D10 step 4, `:194`) and by which a privacy- or quota-constrained host turns off e.g. `network`. Native believes it can suppress a stream; JS keeps sending it. The schema tells the Android team this works.

### 8. The native session id is stored and then dropped
- **Where:** `packages/webview/src/host-bridge-control.ts:12-13`, `:40-41` (`config.session = msg.session`). `grep -rn 'config\.session' packages/webview/src/` shows **no consumer**; `launch.ts:226` reads only `control.config.reportTrigger`.
- **Why it matters:** `hello` mints a JS-side session (`launch.ts:347`, `randomId()`), the protocol comment says native's id is "The native session id to tag entries with" (`protocol.ts:139`), and `setSession` is a documented control (`docs/design/webview-bridge.md:233`, for session rotation). No entry is ever tagged, so after a native session rotation JS-streamed entries carry no way to attribute them to the new session.

### 9. The shipped schema does not validate the `secure` payload — proven by mutation
- **Where:** `packages/webview/bridge-protocol.schema.json:94` (`"p": {"type":"array","items":{"type":"object"}}`) vs the orphaned `:141-153` `secureArea` definition — `grep -c secureArea` returns **1** (its own definition; no `$ref` points at it).
- **Why it matters:** `bridge-protocol.schema.json` is the cross-language artifact the Android team builds against, and the native side reads the rects by name (`…/BridgeSecureMessage.java:10`: "`{type,top,left,bottom,right}` in DOCUMENT-ABSOLUTE coordinates"). A JS-side rename or type change of a rect field is a silent cross-repo break that the machine-checkable contract does not catch.
- **Evidence:** Mutation **M3** renamed `bottom`→`btm` at `packages/webview/src/obscuring-source.ts:61`. Unit tests failed (18) — but the **conformance harness passed**. Same for **M9** (dropping the document-absolute scroll offset at `obscuring-composer.ts:180`): unit caught it, conformance passed.

### 10. Schema `fileType` enum has drifted from `@bugsee/protocol`
- **Where:** `packages/webview/bridge-protocol.schema.json:17-33` omits `video`, which is a member of the union at `packages/protocol/src/constants.ts:20`.
- **Why it matters:** `EntryMessage.t` is typed `FileType` (`packages/webview/src/protocol.ts:51`), so the TS emitter permits a value the shipped schema rejects. Not live today (nothing emits `video` from a WebView), but it demonstrates the enum is hand-maintained with nothing keeping it in lockstep — the exact drift the schema exists to prevent. A type-level test asserting `FileType ⊆ schema.enum` would pin it.

### 11. No throttling and no size bound on obscuring recompute → bridge flood and forced-layout jank
- **Where:** `packages/webview/src/obscuring-source.ts:23-24`, `:115-125` (listeners attached for `scroll`/`resize`/`orientationchange`/`load` + document `focus`/`blur`, each calling `recompute` directly), `:91` (`recompute` = full `querySelectorAll` + `getBoundingClientRect` per element = forced synchronous layout), `packages/webview/src/obscuring-composer.ts:164-165` (every accepted bubble immediately `emit()`s), `packages/webview/src/obscuring-channel.ts:56-68` (every emit is a `bridge.post`).
- **Why it matters:** On Android each post is a synchronous JNI hop through `@JavascriptInterface`. A scroll gesture fires at display refresh rate; each event does a whole-document query, a forced reflow, a `JSON.stringify`, and a JNI call. A child iframe (potentially third-party under the D9 default-all allowlist, `docs/design/webview-bridge.md:66`) can drive this without limit. There is also no cap on the number of rects in a bubble, so one message can be arbitrarily large. This also brushes the repo's own "interceptors must not alter app behavior" principle.
- **Evidence:** Probe 6 — 50 bubbles produced **50** `secure` posts; a bubble of 5000 rects produced a single **280,092-byte** message; 30 synthetic scroll events produced **30** posts. rAF/microtask coalescing plus a rect-count cap would fix both.

### 12. JS-side redaction is off by default; the safety argument leans entirely on native re-redacting
- **Where:** `packages/webview/src/launch.ts:105-107` and `packages/webview/src/redaction-provenance.ts:4-16`
- **What:** The `red` provenance flag is correctly implemented and correctly *not* trusted (native re-redacts unconditionally, so a wrong `red` is not a privacy hazard — I verified `forEntry`/`forReport` return true iff the corresponding filter is configured, `redaction-provenance.ts:41-47`, and the mapping covers `log`/`network`/`breadcrumbs`). The risk is upstream of the flag: with no filter configured, **everything crosses the WebView boundary in the clear** and the design accepts that because native scrubs it afterwards.
- **Why it matters, stated explicitly as the mandate asks:** the boundary is not a private channel (SEV1-3, SEV2-5). "Native will re-redact" protects the *stored bundle*; it does nothing for anyone tapping the wire inside the page. Given `@bugsee/capture` ships query-string credentials and form-urlencoded bodies un-redacted, the un-redacted default is what turns SEV1-3 from "leaks console logs" into "leaks credentials". At minimum the network default deserves a JS-side floor (URL query scrubbing) rather than deferring 100% of redaction across the boundary.

### 13. No error containment around obscuring start/stop or the control command path
- **Where:** `packages/webview/src/launch.ts:351-352` (`obscuring?.start()` / `childComposer?.start()` unguarded), `:360-361` (`obscuring?.stop()` inside the public `stop()`), `packages/webview/src/host-bridge-control.ts:46-48` (`opts?.onCommand?.(msg.command)` unguarded)
- **What:** `host-bridge-control.ts:19` and `:35` document `control(raw)` as "Defensive — never throws", and that holds for parsing — but not for dispatch. A `stop` command whose teardown path throws propagates the exception straight out of `control()` into native's `evaluateJavascript`.
- **Evidence:** Probe F — with a document whose `removeEventListener` throws, `control('{"b":1,"k":"control","command":"stop"}')` produced `Error: removeEventListener hostile` escaping `control()`. A try/catch around the `onCommand` dispatch routing to `onError` would restore the documented contract.

## SEV3

14. **`batch` is fully specified, schema'd, exported, and never emitted.** `packages/webview/src/protocol.ts:225-228` and `:252`; `grep -rn batchMessage packages/webview/src/*.ts` shows only the definition and the re-export at `index.ts:47`. The capture store posts one entry per crossing (`host-bridge-capture-store.ts:32-43`), and `launch.ts:196-197` calls batching future work. The native team has already implemented the receiving half (`BridgeMessageParser.java:52`, `:136-156`) for a code path the SDK never exercises — and the conformance harness never emits a `batch`, so that branch of the contract is untested end-to-end.

15. **`bye` is documented as a pagehide signal but only fires on explicit `stop()`.** `packages/webview/src/protocol.ts:118` says "teardown signal (pagehide / stop)"; the only emitter is `launch.ts:362` inside `publicClient.stop()`. There is no `pagehide`/`visibilitychange` hook. Data loss is low because the store streams every entry synchronously as captured, but on WebView destruction or navigation native never receives a teardown marker. (The `pagehide` *event* does stream up as an `events.system` entry via `createBrowserSystemEventsSource`, `launch.ts:284-293` — so native can infer it, but not from `bye`.)

16. **Sub-pixel under-coverage in rect composition.** `packages/webview/src/obscuring-composer.ts:135` (`Math.floor(r.left)`, `Math.floor(r.top)` for iframe offsets), `:145` and `:180` (`Math.floor(scrollX/scrollY)`). Flooring a positive offset shifts the mask up-and-left by up to 1px, and rects are never inflated, so up to ~1 CSS px along the bottom/right edge of a secure element can render unmasked. For a masking system the rounding should be outward (floor top/left, ceil bottom/right).

17. **The `secure` payload carries no scale metadata.** `packages/webview/src/protocol.ts:83-92` — rects are CSS-pixel, document-absolute, with no `devicePixelRatio`, page zoom, or visual-viewport offset. Native must derive the mapping to rendered pixels itself; under pinch-zoom that mapping is not derivable from the message alone. Worth an explicit line in the contract even if native does own it.

18. **The send buffer evicts silently.** `packages/webview/src/host-bridge.ts:56-61` — once 256 messages accumulate while the native bridge is unattached, the oldest are dropped with no `onError` and no marker to native, so a slow native attach silently truncates the head of the session.

19. **`encode()` splices `p` with zero validation.** `packages/webview/src/protocol.ts:263-267` builds the envelope by string concatenation. Probe 7: a payload of `''`, `'undefined'`, or `'not json'` yields syntactically **invalid JSON** (`…,"p":}`), which native's single `JSON.parse` rejects wholesale. The invariant holds today — every payload comes from `CaptureDataEntry.serialize()` = `JSON.stringify({timestamp, data})` (`packages/core/src/capture-data-entry.ts:16-18`), which always yields an object — but nothing in this package asserts it at the boundary, and the failure mode is a silently dropped message rather than a loud error.

20. **`.bugsee-show` is a page-reachable privacy off-switch.** `packages/webview/src/obscuring-source.ts:15-16` — `input[type=password]:not(.bugsee-show)`. Probe G: adding the class to a password input takes its rect from `[{"type":"text",…}]` to `[]`. This is deliberate legacy parity (documented at `:13-14` and `docs/design/webview-bridge.md:318`), so it is not a defect on its own; it is listed because the D10 amplification is new — under legacy, native masked independently, whereas now the opt-out is the *only* thing standing between a password field and the recorded frame. Same family as the `@bugsee/replay` `.bugsee-unmask` finding.

21. **The IIFE global is neither frozen nor non-configurable.** Verified by building the real entry: `BugseeWebView` lands as `{writable:true, configurable:true}`, `Object.isFrozen === false`. Practically unexploitable (the native bootstrap calls `BugseeWebView.launch(appToken,…)` in the same document-start script, before page scripts run), but the app token is passed through this global and hardening it is free.

## Schema ↔ implementation conformance

Verified field-by-field against `packages/webview/src/protocol.ts` and re-checked against the Android parser.

| message type | schema says | code sends | agree? | file:line (both) |
|---|---|---|---|---|
| `hello` | req `b,k,sdk,caps,session`; `session` minLength 1; addl:false | exactly those 5 | ✅ | schema:35-47 / protocol.ts:148-154 |
| `entry` | req `b,k,t,s,ts,mono,o,red,p`; opt `tr`; `p` object; addl:false | exactly those; `tr` conditionally spread | ✅ | schema:48-65 / protocol.ts:157-179 |
| `entry.t` | enum of 15 FileTypes | typed `FileType` (16 members) | ❌ **`video` missing from schema** | schema:17-33 / packages/protocol/src/constants.ts:20 |
| `entry.p` | `{"type":"object"}` — inner shape unvalidated | `StoredEntry.serialized` = `JSON.stringify({timestamp,data})` | ⚠️ holds, unasserted | schema:61 / packages/core/src/capture-data-entry.ts:16-18 |
| `report` | same as entry, `k:"report"` | identical builder | ✅ | schema:66-83 / protocol.ts:182-204 |
| `report.t` | any fileType | always `'crash'` | ✅ (schema wider than impl) | schema:72 / webview-report-pipeline.ts:48 |
| `secure` | req `b,k,s,ts,mono,o,p`; addl:false | exactly those | ✅ | schema:84-98 / protocol.ts:207-223 |
| `secure.p` items | `{"type":"object"}` — **`secureArea` def is orphaned** | `{type,top,left,bottom,right}` | ❌ **contract gap (SEV2-9)** | schema:94 + orphan 141-153 / obscuring-source.ts:61 |
| `batch` | req `b,k,e`; items `$ref entry` | builder exists | ⚠️ **never emitted** (SEV3-14) | schema:99-109 / protocol.ts:226 |
| `bye` | req `b,k`; addl:false | exactly those | ✅ | schema:110-119 / protocol.ts:231-233 |
| `control` | req `b,k`; opt `accept,session,config,command`; command enum of 5 | `accept` **never read**, `config.enabledTypes` **never applied**, `session` **stored then unused** | ❌ **3 declared features are no-ops** (SEV2-6/7/8) | schema:120-140 / protocol.ts:132-145, host-bridge-control.ts:40-48 |
| `p` inline-JSON representation | "INLINE as a JSON value … native does exactly ONE JSON.parse" | `spliceRawPayload` splices verbatim | ✅ — matches native (`BridgeMessageParser.java:102`, `:132` read `p` as an already-parsed object/list) | schema:5 / protocol.ts:263-267 |

**Version negotiation:** `hello` carries `b:1` (`protocol.ts:15`, `:153`) and `control` requires a numeric `b` (`:283`) — but that is a *tagging* check, not negotiation. No mismatch handling exists on either side (SEV2-6).

## Fields native must validate (for the Android team)

Every field below arrives on a channel **any script in the page can write to** (SEV2-5), so none of it is trustworthy regardless of what the JS SDK does. Today's receiver handles all of these safely; this table is the list to keep safe.

| field | used by native as | risk if unvalidated | file:line |
|---|---|---|---|
| `t` (FileType) | routing key | If it ever becomes a filename/path component, this is the confirmed Electron defect verbatim — a page script controls it (`../../../etc/passwd` reached native in probe C). **Currently safe:** routed by exact string equality against 7 known values. | emits protocol.ts:51 / consumes `BridgeCaptureRouter.java:91-101` |
| `s` (seq) | ordering + dedup (`long`) | Forged/huge/duplicate seq poisons ordering or displaces real entries in a dedup map; page-controllable (probe C sent `999999`). No range check. | protocol.ts:53 / `BridgeMessageParser.java:92`, `:122` |
| `p` (entry/report) | parsed object → consumer | Unbounded size and arbitrary structure; entry payloads have **no** schema (schema:61). Cap size and depth. | protocol.ts:67 / `BridgeMessageParser.java:102` |
| `p` (secure) rects | mask geometry | **Not schema-validated** (SEV2-9). JS sanitizes bubbles it receives (`obscuring-composer.ts:92-113`) but performs no final validation before posting. Native should reject non-finite/negative-extent rects and clamp to viewport. | obscuring-channel.ts:64 / `BridgeSecureMessage.java:10` |
| `p` rect coordinate space | document-absolute CSS px | No zoom/DPR carried (SEV3-17); flooring biases the mask up-left by <1px (SEV3-16). Round **outward** when converting to device pixels. | obscuring-composer.ts:135,180 |
| `ts`/`mono`/`o` | time-base mapping | Page-controllable; a forged `o`/`mono` can place entries anywhere on the native timeline. | protocol.ts:55-59 / `BridgeMessageParser.java:97-99` |
| `red` | provenance only | Correctly not load-bearing — native re-redacts unconditionally. **Keep it that way**; the flag is page-forgeable. | protocol.ts:61 / redaction-provenance.ts:4-16 |
| `caps` (hello) | drives dropping legacy masking (D10) | The highest-consequence field on the wire: a forged `hello` with `caps:["obscuring"]` makes native stand down while nothing masks. Consider accepting `hello` only once, at handshake time. | protocol.ts:40 / `BridgeMessageParser.java:72` |
| `b` (version) | accepted if `> 0` | Any version parses as v1 (SEV2-6). | protocol.ts:153 / `BridgeMessageParser.java:35-37` |
| `sdk`, `session` (hello) | identifiers | Unbounded strings; page-forgeable. Bound the length before storing/logging. | protocol.ts:38-42 / `BridgeMessageParser.java:70-71` |

## Bridge attack surface

Threat model: a WebView page that loads any third-party script (ads, analytics, chat, tag manager) — the norm, and explicitly contemplated by D9's default-all allowlist.

| attack from page/third-party script | possible? | mitigation today | file:line |
|---|---|---|---|
| Issue control commands (`pause`/`stop` → capture suppression) | **YES** — verified (probe A: capture 1→0; `stop` posts `bye` and removes the global) | none | launch.ts:340-343, host-bridge-control.ts:35-49 |
| Read out the live capture stream (logs, network URLs + bodies) | **YES** — verified (probe 3), because the sink is re-resolved per post and JS-side redaction is off by default | none | host-bridge.ts:37-40, launch.ts:105-107 |
| Read *previously* captured data back out | **No** — the streaming store keeps nothing locally (`snapshot()` is empty, `packages/core/src/streaming-capture-store.ts` `emptySnapshot`) | by construction | host-bridge-capture-store.ts:6-12 |
| Forge capture entries / report triggers to native (poison incident data, bypass D5) | **YES** — verified (probe C) | native's parser is defensive but cannot authenticate | host-bridge.ts:21, webview-report-pipeline.ts:59-61 |
| Steal the app token | **No** — it is a closure-captured `createClient` option, never on the returned client or the `globalThis.__BUGSEE__` carrier | by construction | packages/core/src/client.ts:337, packages/core/src/carrier.ts:28 |
| Spoof/suppress secure rects (privacy) | **YES**, three ways: replace the `__bugsee_bridge` binding (probe B); make rect computation throw (probe E); add `.bugsee-show` (probe G) | none | launch.ts:340, obscuring-channel.ts:83, obscuring-source.ts:15 |
| Spoof secure rects **from a child iframe** so a sensitive area appears un-obscured | **No** — a bubble is accepted only from a verified `<iframe>.contentWindow` of *this* document, is keyed by that window, and composition only **adds** rects | obscuring-composer.ts:161-165 |
| Inject NaN/Infinity/non-numeric rects via a bubble | **No** — `sanitize` requires a valid `type` and four finite numbers | obscuring-composer.ts:92-113 |
| Flood the parent / the native bridge from a child iframe | **YES** — no throttle, no rect cap (probe 6: 50 bubbles → 50 posts; 280 KB single message) | none | obscuring-composer.ts:164-165, obscuring-channel.ts:56-68 |
| Overwrite the `BugseeWebView` IIFE global before the bootstrap runs | Not in practice (same injected document-start script), but the global is writable/configurable | none | iife.ts:9 (verified empirically) |

On `event.origin`: the composer deliberately does **not** check `event.origin` (`obscuring-composer.ts:152-166`); it checks `event.source` identity against this document's `<iframe>.contentWindow` set instead. That is the **stronger** check for this purpose — origin is spoofable in neither case, but source-identity also proves the sender is an actual child frame of this document, which origin alone does not. The outbound side uses `targetOrigin:'*'` (`:148`), justified at `:18-20` because rect coordinates are non-PII; I agree, with the caveat that it does disclose the *positions* of sensitive fields to whatever occupies the parent frame.

## Obscuring fail-open analysis

**A throw during rect computation obscures LESS, not more — this is fail-open, at every level.** There is no `try` anywhere in `obscuring-source.ts`, `obscuring-composer.ts`, or `obscuring-channel.ts`.

Three concrete paths, in order of severity:

1. **At the synchronous native pull** (`obscuring-channel.ts:83` → `composer.snapshot()` → `source.snapshot()` → `collectSecureAreas`): the exception propagates out of `__bugsee_bridge.snapshot()` into native's `evaluateJavascript`. Native receives an error rather than rects, at precisely the moment it is capturing a frame, on a page where it has already dropped legacy masking. Verified (probe E).
2. **At start** (`launch.ts:351`): the throw aborts `launch()` *after* the `obscuring` capability was declared (`:335`, `:347`), so native stands down and then receives zero `secure` messages for the session, with no retraction mechanism. Verified (probe D).
3. **During change-tracking** (`obscuring-source.ts:91` `recompute`, invoked from the MutationObserver callback at `:106` and the scroll/resize/focus listeners at `:117-125`): a throw here is swallowed by the event-dispatch machinery, `ownAreas` keeps its previous value (`obscuring-composer.ts:172-174`), and the mask silently goes **stale** — so a password field added after the failure is never masked, and nothing is reported to `onError`.

A fail-closed design would: wrap each level in try/catch routed to `onError`; on failure emit the **last known good** rect set, or a full-viewport rect, rather than nothing; and either declare the `obscuring` capability only after a first successful collection, or add a capability-retraction message so native can re-enable legacy masking.

Geometry itself is sound where it is exercised: `getBoundingClientRect` correctly accounts for CSS transforms; `position:fixed` elements are correct at computation time and scroll is a tracked recompute event (`obscuring-source.ts:23`); child-iframe offsets are read **fresh** on every compose so an intermediate scroll cannot go stale (`obscuring-composer.ts:132-136`); removed iframes are GC'd (`:129-132`); an element matching both selectors is deduped (`obscuring-source.ts:56-59`). The read-only guarantee holds — I found no DOM mutation anywhere in the obscuring path (only `querySelectorAll`, `getBoundingClientRect`, `add/removeEventListener`, `MutationObserver.observe/disconnect`), which is a real improvement over the legacy interceptor's class-adding behavior.

## IIFE integrity

Genuinely self-contained and correctly gated, verified by an independent rebuild of the real entry (`src/iife.ts`) with the shipped config:

- **Globals defined: exactly `["BugseeWebView"]`**, whose keys are exactly `["VERSION","launch"]` — the minimal surface the design intends (`iife.ts:1-9`).
- **Self-contained:** no `@bugsee/` and no `node:` literal survives. The guard at `webview-bundle.e2e.ts:38-41` uses literal-substring checks and documents *why* (esbuild lowers an external import to a require-helper call, so an ESM-shaped regex would pass vacuously) — that is a well-reasoned test, not a box-tick.
- **Size:** 67.1 KB raw / **23.9 KB gzip**. The `~22 KB` figure is approximately right but is **not** what's gated: the budget is 64 KB gzip / 200 KB raw (`webview-bundle.e2e.ts:23-27`), ~2.7× headroom. The test's own comment is honest about this ("catches a gross regression … while leaving room for organic growth"), so this is a deliberate choice rather than an aspirational claim — but a regression from 24 KB to 60 KB would pass.
- **Loadable:** asserted by evaluating in a fresh `node:vm` context (`:50-63`). That proves module-init has no hidden global dependency; it does **not** prove it runs in a real WebView (see below).
- **Not hardened:** the global is `{writable:true, configurable:true}` and unfrozen (SEV3-21).

## What jsdom / the mock receiver cannot verify

The conformance harness is the strongest part of this package and I want to be precise about where its authority stops:

- **Real geometry.** jsdom's `getBoundingClientRect` returns all zeros, and the harness acknowledges this (`webview-conformance.e2e.ts:196-197`). Every unit test feeds hand-written rect literals. **Nothing anywhere exercises real layout**: scroll offsets, CSS transforms, `position:fixed`, nested-iframe offsets, and pinch-zoom / `devicePixelRatio` are all unverified with real numbers. For a masking feature, that is the single biggest untested surface.
- **Android `@JavascriptInterface` semantics.** Synchronous JNI, string-only marshalling, the argument-size ceiling, and which thread `post` runs on. The 280 KB message from probe 6 is untested against any real limit.
- **`evaluateJavascript` result marshalling.** I verified `snapshot()` *throws*; what Android's `ValueCallback` actually receives on a JS exception (`"null"`) and how the receiver interprets it is unverifiable from this repo.
- **Real cross-origin iframes.** jsdom's `MessageEvent.source` identity is not the browser's; the `contentWindow`-identity check (the security control at `obscuring-composer.ts:161`) is only proven against a same-process fake.
- **Document-start injection ordering** vs page scripts — which is exactly what determines whether the SEV1-3/SEV1-4 hijacks are practical.
- **WebView destruction / navigation mid-stream**, and whether buffered messages (`host-bridge.ts:56-61`) survive.
- **The Android receiver's behavior.** Different repo; I read it (read-only) to confirm the parser is defensive, but the conformance harness validates a *mock* that this repo also wrote — the schema is the only artifact genuinely shared with the native team, and §Schema↔implementation shows two places where it under-specifies (`secure.p`, entry `p`).
- **The IIFE in a real WebView.** `node:vm` with a `{console, globalThis}` sandbox proves loadability, not WebView compatibility.
- **`batch`** — never emitted by the SDK, so the native receiver's batch path (`BridgeMessageParser.java:136-156`) has never round-tripped against a real producer.

**Shared-misconception check:** I looked specifically for the mock receiver being blind in the same way as the implementation. It largely is not — the receiver JSON-parses raw strings (`webview-conformance.e2e.ts:32`) rather than trusting SDK objects, validates *every* message including native's own `control` (`:51-55`), uses `additionalProperties:false` throughout the schema, and includes an explicit anti-vacuity meta-test (`:238-256`) that proves the validator discriminates. The one real blind spot is structural and material: `secure.p`'s items are `{"type":"object"}`, so the harness and the implementation share the assumption that the rect shape is right — and mutation M3 proves that assumption is unchecked (SEV2-9).

## Test quality — mutation results

13 mutations, each backed up with `cp`, applied, run against **both** the unit suite and the conformance e2e, then restored from the backup and byte-verified (`restored=true` for all 13). Baseline: 130 unit tests + 9 conformance tests green.

| mutation | unit | conformance | note |
|---|---|---|---|
| M0 `entry.t` hardcoded to `log` (**control**) | ❌ 14 failed | ❌ 2 failed | harness proven live |
| M1 rename wire field `red`→`redd` | ❌ 13 | ❌ 8 | **caught** — the headline check |
| M2 drop required `mono` | ❌ 6 | ❌ 8 | **caught** |
| M3 rename `SecureArea.bottom`→`btm` | ❌ 18 | ✅ **PASS** | conformance blind (SEV2-9) |
| M4 remove cross-frame source verification | ❌ 1 | ✅ PASS | unit-only |
| M5 remove bubble sanitization | ❌ 1 | ✅ PASS | unit-only |
| M6 `parseControl` drops the `b` requirement | ❌ 1 | ✅ PASS | unit-only |
| M7 `secure.s` emitted as a string | ❌ 3 | ❌ 2 | caught |
| M8 drop required `hello.caps` | ❌ 8 | ❌ 8 | caught |
| M9 drop the document-absolute scroll offset | ❌ 1 | ✅ PASS | unit-only |
| M10 let `.bugsee-show` also un-hide `.bugsee-hide` | ❌ 11 | ✅ PASS | unit-only |
| M11 stop() no longer sends `bye` | ❌ 2 | ❌ 1 | caught |
| M12 `pause` becomes a no-op | ❌ 1 | ❌ 1 | caught |

**No surviving mutations** — every one was caught by at least the unit suite, which is a strong result and the reason most findings above are design/trust-boundary issues rather than logic bugs. The mandate's priority check (rename a wire field / drop a required field) **passes** at the envelope level: M1, M2, M7 and M8 were all caught by the conformance harness. Its promise is broken only for the `secure` **payload** (M3), where the orphaned `secureArea` definition means the shipped contract validates nothing. Coverage config enforces 100% line/fn/stmt and ≥90% branch (`packages/webview/vitest.config.ts`), and several tests are notably well-designed (the strictly-increasing tick assertion at `webview-conformance.e2e.ts:136-141`; the run⟺red equivalence tests at `launch.test.ts:617-692`; the anti-vacuity meta-test at `:238-256`).

## Checked and found clean

- **The Electron sibling defect does NOT reproduce on the native side.** My brief expected the analogue of renderer-controlled wire `type` reaching `path.join`. It is not there: `BridgeCaptureRouter.java:91-101` routes `t` by exact string equality against 7 known values and ignores anything else; `grep -rn 'File(\|getPath\|filename\|Paths\.'` across `BridgeMessageParser/BridgeReceiver/BridgeJsListener` returns **nothing**. The Android parser is properly defensive — it rejects a missing/invalid `b` (`:35-37`), uses throwing typed accessors for required fields, and catches `Throwable` at the boundary (`:59-62`). The residual risk is prospective, not live (see the native-validation table).
- **Cross-frame bubble security (D9).** Source-identity verification (`obscuring-composer.ts:161-163`), shape+version checking (`:154-160`), per-window keying so one child cannot overwrite another's rects (`:164`), finite-number sanitization (`:92-113`), stale-iframe GC (`:129-132`), and add-only composition. A malicious child can only over-mask its own frame. Both the security check and the sanitizer are covered by dedicated tests (`obscuring-composer.test.ts:192`, `:233`) and both mutations were caught.
- **The read-only / no-DOM-mutation guarantee holds.** No mutating DOM call exists anywhere in the obscuring path — a genuine improvement over the legacy interceptor's class-adding approach.
- **`red` provenance is accurate and correctly non-load-bearing.** Per-type mapping (`redaction-provenance.ts:19-23`), lazily read so post-launch filter changes take effect (`:37-48`, tested at `launch.test.ts:692`), no cross-contamination between types (`launch.test.ts:647`), and native re-redacts unconditionally so a wrong flag is not a privacy hazard.
- **`parseControl` is genuinely defensive** for parsing: non-JSON, non-object, wrong `k`, and a missing `b` tag all return `undefined` without throwing (`protocol.ts:272-287`), and unknown commands are ignored forward-compatibly (`launch.ts:204`, tested at `launch.test.ts:347`).
- **Streaming means near-zero data loss on abrupt teardown.** Every entry is posted synchronously at capture time (`streaming-capture-store.ts` `add`), nothing is buffered locally, and `snapshot()` is empty by construction — so an abrupt WebView kill loses at most in-flight JNI calls, not a ring buffer. This is the right architecture for the WebView lifecycle and it directly answers the `@bugsee/browser` no-`pagehide`-flush concern: it does not apply here.
- **`flush` cannot reject in this composition**, so `void publicClient.flush()` (`launch.ts:198`) is not an unhandled-rejection source: `drainPending` uses `Promise.allSettled` and there is no upload pipeline (`packages/core/src/client.ts:405-413`, `:666-668`). The absence of a flush **acknowledgement** is a real limitation but an explicitly documented v1 decision (`docs/design/webview-bridge.md:152`: "v1 has no ack channel"), so I am not raising it as a defect.
- **The app token is not reachable** from page script via any SDK surface (`packages/core/src/client.ts:337`, `packages/core/src/carrier.ts:28`).
- **Seq is genuinely shared** across the capture stream, the report path, and the obscuring channel (`launch.ts:176-177`, threaded to all three at `:219`, `:227`, `:325`; tested at `launch.test.ts:249`, `:474`).
- **Sub-frame entry/origin attribution** (a sub-frame's logs/network carry no frame id) is a **known, documented open item** (`docs/design/webview-bridge.md:331-336`), not a new finding.
