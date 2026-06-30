# WebView bridge — advanced JS SDK ↔ native mobile SDK (Android-first) — design

**Status:** DESIGN (2026-06-30, brainstormed + decision-locked; NOT implemented). The protocol + architecture for
running the new `@bugsee/*` JavaScript SDK inside an embedded native WebView and streaming its capture up to the
hosting native Bugsee SDK (Android first; iOS / HarmonyOS / Cordova deferred). Replaces / supersedes the thin
`webview-inject-script` once the obscuring capability is ported (see D10). Android is the canonical reference
(the existing native bridge lives in `android/sdk` `com.bugsee.library.interception.webview`).

## 1. Context & goal

Mobile Bugsee SDKs (iOS/Android) embed web content in WebViews. Today a thin **inject script**
(`webview-inject-script` repo) captures a NARROW surface — network (fetch/xhr/ws/sse + resource timing) +
**secure-area view rects** (so native can mask sensitive fields in its rendered frames); console logs are
captured separately by native (`WebChromeClient`). It carries no JS errors-with-stacks and no performance data.
Its wire protocol (`{source, timestamp, sequence, data}`, sources `network`/`views`) has **no versioning and no
capability handshake**, and rides a transport cascade (Cordova → Android `@JavascriptInterface` `BugseeJsListener`
→ iOS WKScriptMessageHandler → MessageChannel `@@BGSMSG@@` → a 50-entry network-only fallback ring).

**Goal:** use the new, far richer JS SDK (`log, network, traces.*, events.*, viewtree, performance, profile,
crash` + redaction filters + cross-project `trace_id`) inside the WebView and report its data **upward** across
the WebView boundary, where the native SDK picks it up and merges it into its session/timeline and reports. This
doc defines: (a) the **versioned wire protocol** across the boundary, (b) **where it plugs into** the JS SDK, (c)
the **native-side receiver contract**, (d) the **control plane** (gating, config, lifecycle), and (e) an
**Android-first slice plan**.

## 2. Understanding summary

- A WebView is, to the SDK, a **browser environment whose output sink is the native host instead of the
  network**. So the work is a new platform package `@bugsee/webview` that reuses `@bugsee/browser`'s capture and
  **replaces the storage/export/upload tail with a bridge sink**.
- Data crosses as a **live stream of capture entries**; **native is the ring buffer + the bundler**. The JS side
  assembles no bundles, persists nothing, uploads nothing.
- The native SDK owns the **session, the report trigger (by default), the canonical redaction config, and the
  pixel masking**. The WebView enriches whatever the native side does.
- The protocol is **new + versioned**, with a **capability handshake** the legacy protocol lacks; the handshake
  also decides whether the legacy thin script must still be loaded (for obscuring) — see D10.
- First milestone is **Android only**; the envelope is transport-agnostic so each later platform is "+1 channel
  + 1 native receiver".

## 3. Assumptions

- Bugsee owns the native iOS/Android/HarmonyOS receivers → coordinated native changes are in scope.
- The native side knows each WebView/frame's URL at load time (for domain-allowlist gating).
- `performance.timeOrigin` + `performance.now()` + wall-clock are sufficient for time-correlating WebView entries
  into the native monotonic timeline (as the legacy bridge already does via `timeOrigin`).
- The advanced SDK ships **bundled in the native binary** as a resource and is injected by native (D7).
- Passive capture (observing console/network/errors/DOM) does **not** alter the embedded app's behavior — a hard
  binding constraint inherited from the SDK (interceptors must be observe-only).

## 4. Decision log

| # | Decision | Rationale |
|---|---|---|
| **D1** | **New versioned protocol** (not the legacy `{source,data}` envelope). | The legacy envelope can't carry errors-with-stacks or performance; versioning + capability negotiation are first-class. |
| **D2** | **Stream entries; native merges.** The JS SDK emits each `CaptureDataEntry` live; native folds it into its session/timeline. No JS-side bundling. | Matches today's network/views model, gives ONE unified native report with web data inline, and removes the entire upload/persistence tail from the WebView. |
| **D3** | **Native redacts by default; layered when JS filters are set.** JS streams un-redacted unless the embedder configured JS-side filters, in which case JS redacts before crossing AND native re-applies. | Native owns the canonical filter config; a `redacted` provenance flag per message lets native know a JS pass ran (it re-applies regardless — safe). |
| **D4** | **Full taxonomy parity** carried across the bridge. | The whole point is the richer capture; the envelope is `FileType`-tagged + extensible, so unknown types are forward-compatibly ignored. |
| **D5** | **WebView-originated report TRIGGERING is gated behind a launch option, default OFF.** Errors/exceptions still stream up as entries (timeline breadcrumbs with stacks); what's gated is *emitting a `report` trigger* (a WebView error / `logException` causing native to open a bug). | In an embedded WebView, native is the authority on when a bug is opened; you don't want every third-party JS error to spawn a report. Delivered via the handshake config. |
| **D6** | **Android only** for the first milestone; iOS / Cordova / HarmonyOS deferred. | Focus; the transport-agnostic envelope makes later platforms additive. |
| **D7** | **The advanced JS SDK ships bundled inside the native SDK** (resource, modern analog of `R.raw.bugsee_inject_script`), injected by native as a tiny **bootstrap/loader** + the heavy `@bugsee/webview` bundle. | One shipping artifact; the bootstrap (document-start, cheap) activates the heavy SDK from native-pushed config. |
| **D8** | **`advancedWebViewCapture` native option defaults ON (opt-out).** | Get the value by default; embedders disable per need. The SDK ships in the binary regardless (size NFR). |
| **D9** | **Domain allowlist** native option: host + wildcard (`*.example.com`), **default = all**, evaluated **per-frame incl. cross-origin subframes** at load time. | Don't inject Bugsee into third-party content (OAuth/payment/ads) when restricted; per-frame because WebViews embed cross-origin iframes. |
| **D10** | **Obscuring (secure-area masking) drives the legacy relationship, negotiated by the capability handshake.** The advanced SDK declares `caps` in `hello`; if it includes `obscuring` → advanced is the sole path (native suppresses legacy); else native also loads legacy for obscuring and tells advanced to skip the overlap. **Target: build obscuring into `@bugsee/webview` so it fully replaces legacy.** | The new SDK has no obscuring today and obscuring (masking native-rendered pixels via streamed rects) is mandatory + WebView-specific. Making it a negotiated capability means "replace when able, coexist otherwise" falls out automatically — no hard-coded mode. |

## 5. Architecture — the streaming-source inversion

`@bugsee/webview` composes `@bugsee/browser`'s capture (console→log, network umbrella, error/unhandledrejection
detection, user-input, viewtree, `@bugsee/performance`) and **replaces the storage/export/upload tail** at the
`CaptureStoreToken` seam.

```
  sources (interceptors/providers)  →  capture aggregator  →  [CaptureStoreToken]
  ── browser tier (reused) ──────────────────────────────────┘        │
                                                                       ▼
                                                      HostBridgeCaptureStore   (the swap)
                                                         store.add(entry)  →  serialize → post across boundary
```

- The aggregator calls `store.add(entry)`; the **`HostBridgeCaptureStore`** serializes that `CaptureDataEntry` to
  a protocol `entry` message and posts it across the boundary **immediately** — no local ring, no bundle
  assembler, no upload pipeline, no IndexedDB. **Native is the ring + the bundler.**
- Detection (`logException` / uncaught errors) flows up as entries (always) plus an optional `report` trigger
  message (gated by D5).
- Net effect: the WebView SDK is a **pure streaming source** — it reuses ~all of `@bugsee/browser` and drops
  everything below the aggregator. New WebView-specific pieces: the bridge transport, the handshake/control
  channel, the obscuring source (D10), and the `report`-trigger gate.

## 6. The wire protocol

### 6.1 Envelope (transport-agnostic, JSON)

```jsonc
{ "b": 1,            // bugsee protocol version — presence also tags the msg as ours on shared channels
  "k": "entry",      // kind: hello | entry | batch | report | control | bye
  "t": "network",    // FileType (entry/report); see §6.4
  "s": 42,           // seq — monotonic per session (ordering + dedup)
  "ts": 1719000000123,        // wall ms
  "mono": 12345.6,            // performance.now() at capture
  "o": 1719000000000,         // performance.timeOrigin (also sent in hello)
  "tr": { "t": "<traceId>", "s": "<spanId>" },  // optional trace join (FE↔native↔backend)
  "red": false,      // redaction provenance: did a JS filter pass run? (D3)
  "p": "{...}" }     // the entry's serialized JSON STRING (native does ONE JSON.parse(p), keyed by `t`) — see below
```

**`p` shape decision (DECIDED — `p` is the entry's serialized JSON STRING; native parses it per `t`).** Each
`CaptureDataEntry` already self-serializes to its canonical per-type JSON form (`entry.serialize()`), and the
store receives that as `StoredEntry.serialized`. `p` carries that string verbatim. **Rationale:** the alternative
(parse it back to a structured object so the wire `p` is an object) forces an EXTRA `JSON.parse` per entry on
the **embedded app's JS thread** — a real cost for high-volume logs/network — to save native (the resource-rich
host, which already routes + parses per `t`) one parse. So `p:string` is LESS total work and keeps the embedded
thread light; native does one `JSON.parse(p)` per entry, keyed by `t`. (This supersedes the earlier
"structured-final" framing.) The native→JS `control` message ALSO carries `b` (the version tag) so a foreign
message on a shared inbound channel (WebMessageChannel) is rejected, not just one with the wrong `k`.

### 6.2 Kinds

- **`hello`** (JS→native, once per page/handshake) — `{k:"hello", b, sdk:"<version>", caps:[<FileTypes + features
  e.g. "obscuring">], session:"<jsSessionId>"}`. Opens capability negotiation.
- **`control`** (native→JS, via `evaluateJavascript` → `__bugsee_bridge.control(msg)`) — the handshake reply +
  ongoing control (§7).
- **`entry`** — one streamed `CaptureDataEntry`, routed by `t` (§6.4).
- **`batch`** — `{k:"batch","e":[<entry>,…]}` coalescing many entries into one crossing (logs/network can be
  high-volume; one bridge hop beats N). **`batch` carries `entry` messages ONLY** — never `report`s (reports are
  rare + gated, so they cross individually).
- **`report`** (gated by D5) — carries the serialized `ReportingRequest` in `p` so native opens a bug/crash.
- **`bye`** — JS signals teardown (pagehide/stop) so native can finalize.

**Incident model native MUST implement (entry ↔ report correlation — decide before the slice-8 receiver).**
A detected incident / `logException` produces, in the SAME session, a `t:"crash"` **`entry`** (ALWAYS — the
timeline breadcrumb) and — only when `reportTrigger` is on — a **`report`** (the open-a-bug trigger). They carry
the **byte-identical `p`** (`JSON.stringify({source, report})`). **They are ONE incident, not two:**
- Correlate them by **`p.report.id`** (the `ReportingRequest` id), NOT by `s` — the entry and the report get
  DISTINCT seqs (each wire message gets its own ordering slot), and NOT by timestamp (fragile).
- Native MUST NOT double-count: the `crash` entry is the breadcrumb; the matching `report` is the trigger.
- **The exception STACK is a pre-formatted human STRING in `p.report.description`** (via the SDK's
  `formatStack`), with the message in `p.report.summary`, type in `p.report.type` (`crash`/`error`), severity in
  `p.report.severity`. It is NOT a structured frame array and there is NO dedicated `stack` field. If native's
  exceptions model needs structured frames, that is a payload-shape change to settle NOW (it is expensive after
  the receiver ships).
- `report` resolution is `{ok:true}` = "posted to the bridge" (handed off — native owns the bundle), NOT a
  native acknowledgement; v1 has no ack channel.

### 6.3 Handshake / capability negotiation (the gap the legacy protocol has)

1. Native injects bootstrap + bundle (gated by D8/D9) + a seed config.
2. JS auto-launches → posts `hello` with `caps` (declares `obscuring` if present — D10) + protocol version.
3. Native replies via `__bugsee_bridge.control({ k:"control", accept:<version>, session:"<nativeSessionId>",
   timeBase:{…}, config:{ enabledTypes:[…], bodyLimits:{…}, sampling:{…}, redaction:{…}, reportTrigger:false } })`.
4. Native uses `caps` to decide legacy coexistence (D10): `obscuring` present → suppress legacy; absent → also
   load legacy + set `config.skip:["network","obscuring"…]` so advanced doesn't double-capture.
5. Version skew: native accepts the highest protocol version it speaks ≤ JS's; unknown `t` types are ignored
   (forward-compat); a JS newer than native degrades to the accepted version.

### 6.4 FileType → native consumer map

| `t` (FileType) | Native consumer | v1 (Android) |
|---|---|---|
| `network` | `NetworkEventConsumer` (tagged source `webview`) | ✅ (parity) |
| `log` / `log.internal` | `LogEventConsumer` | ✅ |
| `crash` / error entry | exceptions list (+ gated `report` trigger, D5) | ✅ |
| `performance` | native performance/APM metrics | ✅ |
| `traces.user` / `traces.system` | native spans/APM | ✅ |
| `events.user` / `events.system` | native user/system events | ✅ |
| `viewtree` (DOM hierarchy) | native view-hierarchy inspector | ✅ |
| secure-areas (obscuring rects, D10) | `BugseeSecureViewsManager` (pixel masking) | ✅ |
| `breadcrumbs` | native breadcrumbs | ✅ |
| `profile` | native (JS CPU profile) | deferred |
| `replay` / `screenshot` / `attachment` | native owns frames | deferred |

### 6.5 Time, session & trace correlation

JS stamps each entry with `ts` (wall) + `mono` (`performance.now()`) + `o` (`timeOrigin`); native maps to its
monotonic timeline (as today). Entries inherit the native `session` from the handshake. The optional `tr` join
unifies WebView ↔ native ↔ backend into one trace (the new SDK already mints W3C-compatible trace ids).

## 7. Native → JS control channel

Native drives JS via `evaluateJavascript` → a frozen `__bugsee_bridge.control(msg)` the bootstrap exposes:

- **`config`** — push/update `{enabledTypes, bodyLimits, sampling, redaction, reportTrigger, skip}` (handshake
  reply + on change).
- **`pause` / `resume`** — native app backgrounded / WebView offscreen → stop/resume capture.
- **`flush`** — drain batched entries up NOW (native calls this right before capturing a frame or opening a
  report so the timeline is current).
- **`snapshot`** — return the current secure-area rects **synchronously via `evaluateJavascript`'s result** (native
  needs them at frame-capture time to mask — the analog of today's `viewState()`).
- **`setSession`** — the native session id; re-sent on session rotation.
- **`stop`** — eject all interceptors (WebView destroyed / Bugsee stopped natively).

JS→native bridge object (Android): a NEW `@JavascriptInterface` `window.BugseeBridge.post(json)` (distinct name
from legacy `BugseeJsListener`, so both coexist during migration) + a `WebMessageChannel` (API 26+) richer
fallback; the 1-entry-at-a-time vs `batch` choice is the SDK's, transparent to native routing.

## 8. Redaction (D3 + D10)

- **Content redaction:** JS `FilterStore` is empty by default → content streams un-redacted (`red:false`) → native
  applies its canonical filters on receipt. If the embedder sets JS-side filters via webview launch options, JS
  runs them before crossing (`red:true`) AND native re-applies → the union of both filter sets is enforced.
- **Visual masking (obscuring):** JS only streams the secure-area **rects** (it cannot redact native-rendered
  pixels); native masks the frame (scale + scroll-offset mapping, per `BugseeSecureViewsManager`). This is the
  one redaction that MUST be native — and the capability that decides legacy coexistence (D10).

## 9. Packaging, loading & gating

- **Bundle (D7):** native ships the `@bugsee/webview` IIFE as a resource + a tiny **bootstrap**. The bootstrap is
  injected at **document-start** (`WebViewCompat.addDocumentStartJavaScript` where available, else page-ready), so
  interceptors beat app scripts; it activates the heavy SDK from native-pushed config.
- **Gate 1 — `advancedWebViewCapture` (D8, default ON):** native decides per-WebView whether to inject at all.
- **Gate 2 — domain allowlist (D9, default all):** native checks each frame's origin (incl. cross-origin
  subframes) at load; non-matching frames are skipped. The bootstrap also re-checks `location` against the
  pushed allowlist (belt-and-suspenders for a full-navigation between native's gate and activation).
- **Legacy coexistence (D10):** decided by the `hello.caps` handshake — advanced-only when it declares
  `obscuring`, else legacy + advanced with the overlap suppressed.
- **Builds:** an **IIFE single-string** (native resource, strict size budget) + an **npm/ESM** entry (for web
  apps that detect-and-adapt, and for tests).

## 10. Lifecycle (Android)

Inject at document-start → JS `hello` → native `control({config, session, timeBase})`. Re-inject + re-handshake
on full navigation (bootstrap guards on `'__bugsee_bridge' in window`); SPA route changes are tracked in-SDK
(Navigation API). `pagehide` → JS flush + `bye`; native `flush`/`stop` before `WebView.destroy()`. Native app
background → `pause`; foreground → `resume`; native session rotation → `setSession`.

## 11. Non-functional requirements

- **Binary size:** the bundled IIFE adds fixed cost to the native binary (ships even when D8 is off). Strict size
  budget; measure per release.
- **Performance:** `batch` to minimize JS↔native crossings; sampling + `enabledTypes` from native config; capture
  must stay observe-only (no app-behavior change).
- **Privacy:** D3 (native-default + optional JS layer) + D10 (native pixel masking); allowlist (D9) keeps Bugsee
  out of restricted/3rd-party frames.
- **Version skew:** handshake-negotiated; forward-compatible unknown-type handling.
- **Resilience:** a missing/late bridge → bounded buffer + `flush`/drain pull (richer than legacy's 50-entry
  network-only ring); bridge post failures never throw into the embedded app.

## 12. Slice plan (Android-first; each: test-first → mutator loop → 100% cov → multi-agent review)

0. **This design doc** + an envelope JSON schema + the `FileType`→native-consumer map (done: this doc).
1. **`@bugsee/webview` skeleton** — package scaffold; reuse `@bugsee/browser` capture + `HostBridgeCaptureStore`
   (`CaptureStoreToken`) serializing each entry to the envelope + an injectable bridge transport (Android channel
   detection: `BugseeBridge` @JsInterface / `WebMessageChannel`) + the `hello` handshake + `__bugsee_bridge.control`
   global. **No upload pipeline / bundle store / IndexedDB.** `launch()` returns the client. `reportTrigger` gate
   (D5, default off) suppresses the `report` kind.
2. **Full-parity entry serialization** — each captured `FileType` → its envelope `entry` payload (log, network,
   error/crash, performance, events.*, viewtree, traces.*); `batch`; seq/time/trace stamping; the `red` flag.
3. **Control channel** — `__bugsee_bridge.control` handling config/pause/resume/flush/snapshot(sync rects)/
   setSession/stop. **(Commands DONE: `pause`/`resume` drop+resume the capture stream — incidents still report;
   `flush` awaits the client's pending work; `stop` ejects everything; `snapshot` re-pushes the secure-area rects
   (slice 4). DEFERRED: `batch`/batching → a perf follow-up — entries currently post immediately, which keeps the
   timeline live and avoids a flush-latency window. `flush` will additionally drain the capture batch once
   batching lands.)**
4. **Obscuring / secure-area source (D10) — DONE.** Ported the legacy secure-input (`input[type=password]` /
   `autocomplete*="cc-"` → `text`) + `.bugsee-hide` (`hidden`) rect tracking as a **read-only** source
   (`obscuring-source.ts` — MutationObserver + window scroll/resize/orientation + document focus/blur; the legacy
   auto-added a `.bugsee-hide` class, which we DON'T — interceptors must not alter app behavior) + an
   `obscuring-channel.ts` that streams a `secure` envelope on change and answers native's synchronous pull
   `__bugsee_bridge.snapshot()` (serialized rects) + the `snapshot` control command (async re-push). Adds
   `obscuring` to `hello.caps` ONLY when a DOM is present + not opted out (`captureObscuring`, default true) — so
   native drops its legacy masking only when the advanced SDK actually masks. `secure` wire message + builder
   added to the protocol. 100% cov, mutator-looped.
5. **Redaction wiring (D3) — DONE.** Webview launch options `networkFilter`/`logFilter`/`breadcrumbFilter`/
   `reportHandler` install into the core `filters` service (via the facade `set*`), so the capture providers +
   the report path run them before crossing. A `redaction-provenance.ts` helper maps each crossing to its `red`
   flag PER ENTRY TYPE (a `log` entry is `red` iff a log filter is set, `network` iff a network filter, etc.;
   system traces/events are always `red:false` — only native redacts them) and PER REPORT (`red` iff a report
   handler with a `before` pass is set). The provenance reads the `filters` service LIVE (lazy), so a filter set
   on the returned client after launch is honored. `host-bridge-capture-store` (`redactedFor(type)`) +
   `webview-report-pipeline` (`redacted()`) stamp the flag; native still re-applies its canonical filters (the
   union). 100% cov, mutator-looped.
6. **Injectable IIFE build** — single-string output (native resource), size-budgeted; + npm/ESM entry.
7. **E2E conformance harness** — a mock native receiver speaking the protocol; boot real `@bugsee/webview` in
   jsdom/headless and assert the exact handshake/entry/control round-trips. **This harness IS the reference spec
   handed to the Android team.**
8. **Android native receiver** (in the `android/` repo, coordinated) — a new v1 receiver alongside legacy
   `BugseeJsListener`, switched by the handshake; new consumers for performance/traces/events/errors; the gated
   `report` handling; per-frame D8/D9 injection gating; D10 capability-driven legacy suppression. We supply the
   conformance harness + this spec.

## 13. Deferred / open

- **iOS (WKScriptMessageHandler), Cordova, HarmonyOS** receivers + channels (D6).
- **`profile` / `replay` / `screenshot`** streaming (native owns frames for now).
- **Originating-session re-propagation** + WebView↔native trace stitching polish.
- **Obscuring fidelity** parity audit vs legacy (edge cases: nested scroll, transforms, fixed elements).
  - **Coordinate convention — DECIDED (slice 4):** `secure` rects are **document-absolute** — the obscuring
    source adds the floored page scroll (`Math.floor(scrollX/scrollY)`) to each `getBoundingClientRect()`,
    exactly as legacy does, so the existing native masker (which subtracts `scrollX/scrollY`) maps them
    correctly. The slice-8 native receiver MUST treat incoming rects as document-absolute (not viewport).
  - **`.bugsee-show` opt-out — PORTED (slice 4):** the auto-detect secure-input selector excludes
    `.bugsee-show` so an app can keep a password/cc field visible, matching legacy.
- **Bundle-size budget number** (TBD once slice 1 lands).
- **Frame attribution (D9 subframes) — OPEN, decide before slice 8 freezes the native receiver.** A WebView can
  host cross-origin subframes; each injected SDK posts `hello`/entries to the SAME `BugseeBridge.post`. The v1
  envelope carries no frame/origin id, so native cannot attribute an entry to a frame (the legacy bridge bubbles
  cross-frame via a `VIEWS_BUBBLE` postMessage). If per-subframe attribution is in v1 scope, a `frame`/origin
  field must be added to the envelope (or `hello`); if deferred, document single-top-frame support.
  - **Obscuring is TOP-FRAME ONLY (slice 4, interim-safe):** only the top frame tracks + declares the
    `obscuring` capability (`window.top === window.self`); a sub-frame keeps legacy masking. This avoids the
    privacy hazard of a sub-frame declaring `obscuring` (→ native suppresses legacy) while it can only mask its
    OWN viewport-relative rects. **BLOCKING before native suppresses legacy on `obscuring`:** sub-frame secure
    rects must be COMPOSED up to the top frame (legacy `VIEWS_BUBBLE` postMessage + iframe-offset re-mapping) —
    until then a page with sensitive content inside a sub-frame is masked by legacy, not advanced.
- **Machine-checkable envelope schema — sequenced to slice 7 (the e2e conformance harness), NOT slice 0.** The
  envelope is specified in `packages/webview/src/protocol.ts` (TS types). A JSON schema + the executable
  conformance harness land in slice 7 — once slices 2–3 finalize the per-type `p` payloads + the control
  commands — so they are stable before the native (Java) receiver is written in slice 8. (This supersedes the §5
  slice-0 "envelope JSON schema" item: the *types* exist now; the *cross-language artifact* lands with the
  harness it is validated by.)
