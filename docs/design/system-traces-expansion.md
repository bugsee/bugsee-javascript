# System traces expansion — competitor gap + mobile-parity port plan — DESIGNED, FROZEN (partially implemented; see §14.5/§15.5)

**Status:** DESIGNED 2026-10-14; **FROZEN 2026-10-14 after review round 9** (PR #53); **§14 (2026-10-14) adopts the mobile tracker/producer structure and supersedes the lifecycle-seam mechanism in §5/§9/§12.** No further prose rewrites: remaining
edge cases are tracked as the pre-implementation checklist in §12 and are resolved test-first in the owning slice. **Partially implemented since: see §14.5 and §15.5 for what shipped and what is still open (as of 2026-10-21 every domain-tracker slice TR0–TR9 is merged on `main`: browser TR0–TR7, node/Bun/Deno TR8 (#87, #88) and Electron TR9 (#90, #91); what remains is the cleanup, hardening and verification list in §15.5).** Built from five read-only research passes
(competitor web, competitor server/cloud/edge, competitor Electron/desktop, Bugsee Android SDK, Bugsee iOS
SDK). Every runtime-support claim marked **UNMEASURED** must be probed on the real runtime before the slice
that depends on it starts (see §7) — on Bun/Deno "the call succeeded" is not evidence the thing happened
(CLAUDE.md, the ELU / `monitorEventLoopDelay` / local-variables precedents).

## 1. Goal and non-goals

**Goal.** Close the highest-value gaps in the `traces.system` / `events.system` catalog, in this order of
authority: (1) Android-canonical wire vocabulary (parity target), (2) what several competitors collect that we
do not, (3) what is cheaply and truthfully obtainable from each JS runtime.

**Non-goals.**
- Anything a runtime cannot answer truthfully. We omit rather than synthesize (precedent: ELU is omitted on
  Bun/Deno; `event_loop_lag_*` is omitted on Deno). A derived value must be NAMED as derived.
- Privacy-sensitive device identifiers (wifi SSID/BSSID/MAC/IP, carrier, accessibility/screen-reader state).
- `*.user` streams. SDK code never writes there (CLAUDE.md, product-owner rule). Everything here is
  `traces.system` / `events.system`.
- Web vitals / long tasks if `@bugsee/performance` already owns them — see Q1.

## 2. Baseline catalog (pre-TR, as of this doc's first draft)

> Historical baseline. The traces and events shipped since (e.g. `app_state`, `fps`, `screen_size`, `main_thread_lag_ms`,
> `DarkModeChanged`, `language_changed`; several since renamed or retired, see §15.6) and the event-driven emission via domain trackers are listed in §14.5/§15.5.

| Tier | Traces | Events |
|---|---|---|
| Browser (`browser/src/system-metrics.ts`, `system-events.ts`) | `ram_js_heap_{total,free,used}` (Chromium `performance.memory`), `ram_system_advertised`, `connection`, `orientation`, `battery`, `charging` | `process_started`, `process_exiting`, the foreground event (`UIApplicationDidBecomeActiveNotification`), the background event (`UIApplicationDidEnterBackgroundNotification`), `online`, `offline`, `OrientationChanged` |
| Node/Bun/Deno (`node/src/system-metrics.ts`, `system-events.ts`) | `process_memory_{rss,heap_total,heap_used,external,array_buffers}`, `ram_system_{total,free}`, `cpu_usage_{user,system,process}`, `event_loop_lag_{ms,max_ms,p99_ms}`, `event_loop_utilization` | `process_started`, `process_exiting`, `process_before_exit`, `process_warning`, `process_signal` |
| Electron | composes the two above; **no Electron-specific telemetry** (only `crashReporter` + `render-process-gone` for incident synthesis) | — |

Sampler: one provider, snapshot at start then every 1000 ms (`capture/src/system-traces-provider.ts`). No
event-driven emission in this baseline (trackers add it; see §15.5). Registered only by node/browser/webview launches (bun/deno reuse node's).

## 3. Findings that drive the design

**Competitors.** Server-side the common set (RSS/heap/CPU/system RAM/event-loop delay+ELU) we already match.
The most-shared gaps: **GC stats** (Datadog, OTel, Splunk, New Relic, AppDynamics), **V8 heap statistics**
(Datadog, AppSignal), **per-space heap** (Datadog, OTel), **active handles/requests** (Elastic, OTel),
**Lambda context** (Sentry, Datadog). Browser-side: **long tasks / LoAF**, **web vitals**, **navigation/resource
timing**, **FPS** (Highlight, OpenReplay), **page visibility**, **viewport**. Electron: Sentry collects
per-process memory (`app.getAppMetrics`), GPU, screen, `child-process-gone`, `powerMonitor`/window/`app`
breadcrumbs. **None of the reviewed implementations reads the Battery API**; none of the reviewed vendor Node SDKs implements cgroup limits (OTel
specifies them). (Scope: the reviewed set only; §11 lists vendors that were docs-only, unverified or not researched, so these are not universal claims.)

**Mobile.** Android has ~28 trace producers + 7 event producers; iOS 24 + ~8. Portable and truthful subset is
small (§4). Many Android/iOS traces have **no JS API** and are explicitly not ported.

**Wire-shape clashes (must resolve before reuse).**
1. `charging`: Android `{state, source}` map; iOS 4-state int; JS boolean (shipped in 0.1.0-beta.3). **Decision needed before any change (ST0):** the Battery API has no `source`, and changing a shipped wire shape is breaking. Options: (a) keep the boolean under its current name and stop calling it a bug; (b) emit Android `{state}` with `source` OMITTED (never invented) and `state` mapped via a table written here (`charging`/`full`/`unplugged`, verified against Android `TracePowerStatus` and the viewer); (c) keep the boolean and accept the viewer gap. **Recommendation: (a)/(c) — do not touch the shipped boolean until Q5 shows what the viewer does with it.** *(Superseded: §13.4 decides to emit `{state}` and §14.5 records it as shipped.)*
2. `cpu`: iOS = percent summed over threads (can exceed 100); JS `cpu_usage_process` = per-core-normalized.
3. `connection` (JS) vs `network` (iOS) vs Android `connection` — JS already follows Android's vocabulary
   (`web-tier-wire-alignment`); keep.
4. `orientation` ints 3/4 mean opposite things on iOS vs Android — JS follows Android; keep.
5. Unavailable service: Android emits `"$$unavailable"`; JS omits. See Q3.

## 4. Proposed additions (prioritised)

Naming rule: use the Android wire name ONLY when the quantity is the same thing; otherwise a JS-specific name in
the existing `process_*` / `event_loop_*` style. Units: bytes unless the reused Android name specifies otherwise
(`disk_mem_*` is MB). Values must be the Android/iOS wire shape or the viewer cannot render them (the
`orientation`/`connection` precedent).

### P1 — Node/Bun/Deno runtime depth (`@bugsee/node`)

| Trace | Source | Notes |
|---|---|---|
| `gc_pause_ms` (sum/max per interval), `gc_count` (optionally by type tag) | `PerformanceObserver({entryTypes:['gc']})` | Broadest competitor-backed gap. **MEASURED: node only — blind on Bun and Deno (§8). Gate OFF there.** |
| `v8_heap_size_limit`, `v8_heap_available`, `v8_heap_malloced`, `v8_heap_peak_malloced` | `v8.getHeapStatistics()` | Cheap on Node/Deno (µs). **MEASURED: do not emit on Bun** — JSC-derived, limit not a ceiling, ~1 ms/call (§8). |
| `ram_js_heap_{total,free,used}` on Node/Deno | `v8.getHeapStatistics()`: `total` = `heap_size_limit` (the CEILING, Android `ram_jvm_heap` contract), `used` = `used_heap_size`, `free` = limit − used | **Not an alias of `process_memory_heap_*`**: `process_memory_heap_total` is `heapTotal` (committed heap, not the ceiling). Only `used` is the same number in both families; `total` and `free` differ. Keep `process_memory_heap_*` as committed. Same name = same quantity as browser/Android. Decision Q2. |
| `process_memory_limit` (cgroup cap) | `process.constrainedMemory()` (Node ≥18.15 — absent on 18.0–18.14, feature-detect;  `SYNTHESIS.md` T1 calls it the real OOM predictor) | Emit ONLY when the value is `> 0` AND `< 2^63` AND `≤ os.totalmem()`; omit for `0` (macOS/unconstrained) and the 2^64 Linux sentinel — never gate on `!== 0` alone. **Needs a Linux probe (macOS-only so far).** Deno/Bun semantics unmeasured. |
| `ram_system_available` | `process.availableMemory()` | Sentry uses it. **MEASURED: not comparable across runtimes (24 GB vs 0.9 GB same host) and absent on Node 18 — Node ≥20.13 only (feature-detected, never a `major ≥ 22` check), if at all (§8).** |
| `disk_mem_free`, `disk_mem_total` | `fs.statfs` (Node ≥18.15) | **Unit: integer MB via the existing `bytesToMegabytes` (`@bugsee/protocol` `units.ts:14-18`: `Math.floor(bytes/1024/1024)`, the Android `(int)` cast — binary, NOT `/1e6`; no second definition of "MB"), a deliberate exception to the bytes rule above, from `bsize × bavail` / `bsize × blocks`, change-deduped (≥1 MB). **Path: the filesystem `dataDir` lives on** (`effectiveDataDir`), not `/` or cwd — it is that volume's space, not mobile "device storage", and differs from `/` on overlay/container roots. **Omit both traces when `effectiveDataDir` is undefined** (in-memory launch, or disk setup degraded — `node/src/launch.ts:580-609` clears it); never fall back to cwd or `/`. The sampler is built today with no `dataDir` dep (`launch.ts:866`), so ST3 must thread it in. Opt-in like iOS `BugseeOptionCaptureDiskSpace`. §8 confirmed `statfs` is present and returns sane block counts on node/bun/deno; it did NOT check wire units or path choice. |
| `handles_active`, `requests_active` | `process.getActiveResourcesInfo()` | Elastic/OTel. Low priority; **MEASURED: always 0 on Bun/Deno → Node only, enforced by `measuresActiveResources` (§5); omit, never emit 0.** |
| `process_uptime_s` | `process.uptime()` | Trivial; Sentry/Datadog/OTel. |

### P2 — Browser parity (`@bugsee/browser`)

| Trace / event | Source | Notes |
|---|---|---|
| `fps` | `requestAnimationFrame` counter over the 1 s window | Android `fps`; iOS `fps`; Highlight/OpenReplay. **Gate on visibility; never keep a permanent rAF loop in a hidden tab** (battery + keeps page awake). |
| `app_state` (step trace) | `document.visibilityState` mapped to the Android vocabulary (`foreground`/`background`, per Android `TraceAppState`) | NEVER put raw `visible`/`hidden`/`prerender` on `traces.system`. Verify the exact Android value set and the viewer table (Q5) first; the process foreground/background events already exist, so this trace is optional until the viewer needs the step curve. |
| `screen_size` (JS-specific; **not** `displays`) | `screen.width/height`, `devicePixelRatio` on `resize` | Android `displays` is a display LIST (id, density, flags, bounds), not two CSS-pixel numbers, so the browser `Screen` must not reuse the name. Static values already ship as `hardware.screen_width/screen_height/pixel_ratio` (`browser/src/environment.ts:116-118`); add this only if resize-over-time is wanted, with an explicit value shape `{width, height, dpr}` and Q5 viewer confirmation. Otherwise stay environment-only. |
| `cpu_pressure` (**not** `thermal_state`) | Compute Pressure `PressureObserver.observe('cpu')` | Chromium-only, experimental, permissions-policy gated. It is CPU CONTENTION (incl. other tabs) with states `nominal/fair/serious/critical`, not Android's 0–6 temperature/throttling enum — so it gets a JS-specific name and the API's own state strings. Map to `thermal_state` only if `PressureObserver.knownSources` includes `thermals` AND the value is converted to Android's int enum. Feature-detect the SOURCE, not just the constructor. Off by default. |
| `DarkModeChanged` event — **`matchMedia` is a method on `Window` returning a `MediaQueryList` you listen on, not a window event, and it is not on `WindowEvents` (`detection-providers.ts:21-24`, shared with detection — do NOT widen it): extend `BrowserSystemEventsEnv` with `matchMedia`; in `onActivate` skip when absent, listen on the returned list, remove in `onDeactivate`, per-attach try/catch (an unguarded throw aborts `captureCoordinator.start()` and with it input/viewtree, which register after events). Tests: fake without `matchMedia` → input still starts, no event; with it → `change` records `DarkModeChanged`.** On `createBrowserSystemEventsSource` (`system-events.ts`), gated by `captureSystemEvents`, torn down in `onDeactivate`; **never on the traces sampler** | `matchMedia('(prefers-color-scheme: dark)')` change | Existing JS `events.system` names are snake_case; use `DarkModeChanged` unless Q5 shows the viewer keys Android's `DarkModeChanged`. |
| `freeze` / `resume` events — same: `createBrowserSystemEventsSource`, `captureSystemEvents` | Page Lifecycle. **Attach on `this.#document`, like `visibilitychange` (`system-events.ts:68-74`) — they fire on Document and do NOT bubble, so a `window` listener beside `pagehide` never runs;** skip when `document` is absent, tear down in `onDeactivate`. Tests: `doc.emit('freeze')` records, `win.emit('freeze')` does not. | Complements the background event (`UIApplicationDidEnterBackgroundNotification`). The traces provider can only write `traces.system` (`system-traces-provider.ts:69-73`); the two options are independent (`captureSystemTraces:false, captureSystemEvents:true` must still record these). |
| Event-driven `battery`/`charging` | `levelchange`, `chargingchange` | May replace 1 s polling for these two. |
| `connection` — **keep polling (or add events) but never drop the `onLine`-first mapper** | `window` `online`/`offline` **and** `connection.change`, mapped through `system-trace-values.ts` (`navigator.onLine` outranks `connection.type`) | `connection.change` does NOT fire on `offline` (a Chromium NetworkInformation can still say `wifi` while offline), so replacing the 1 s read with `change` alone leaves the trace stuck on `wifi` after the network drops while `events.system` `offline` fires — the streams disagree. Do not remove polling until the online/offline + change pair is specified and tested. |
| `hardware_concurrency` (context, not trace) | `navigator.hardwareConcurrency` | Sentry; static → belongs in environment, not a trace. |
| Main-thread responsiveness | **Timer drift**, not a `MessageChannel` ping: on each 1 s sampling tick, `lag = max(0, now() − (previousTick + interval))` from the injected `performance.now`. | Name `main_thread_lag_ms`. **Measure only while `document.visibilityState === 'visible'`; omit (never zero) when hidden** — background tabs clamp/throttle timers to ~1 s then ~1 min, so a hidden-tab measurement would paint a hang that did not happen (the inverse of the Deno `event_loop_lag` lie); fresh baseline on every visible start (a hidden stretch is never lag). **Measured in real Chromium (2026-10): the per-tick MessageChannel ping scheme reports ~0.1 ms for most real freezes** (a block that begins after the ping returned has nothing in flight to delay; the 'in-flight age' branch never fires because the tick timer shares the blocked thread), and re-posting on every receipt is a continuous task loop (~2.2M receipts/s, a pinned core) — both are plausible-healthy lies. Timer drift detects that a block happened but may under-report its length (measured 616 ms for a 1.6 s block in the real run, decision 10). A measured ~0 is a true measurement and is emitted. Honest limit: it measures how late the sampling timer fires, so browser timer throttling while the page is visible-but-occluded also shows as lag, and a block's reported length can be well below its true length (616 ms measured for 1.6 s), so treat the value as a lower-bound signal of a stall, not a duration. |

### P3 — Electron main-process telemetry (`@bugsee/electron`)
There is NO Electron sampler today: `launchMain` (`electron/src/launch-main.ts:110`) forwards `nodeOptions` to `@bugsee/node` `launchCore` with no `systemMetricsSampler`, so Electron main already emits the full node catalog. ST6 must therefore **extend, not replace** — and under §14 that is producers, not a wrapped sampler. `systemTraceProducers` (`node/src/launch.ts`) REPLACES the node defaults when supplied (the bun/deno launches already build their own list), so `launchMain` passes `[...createNodeSystemTraceProducers(...), ...electronProducers]`: the node producers keep `process_memory_*`/`cpu_*`/`event_loop_*` on the process that owns the session, and the Electron producers (`app_metrics`, …) are ADDED, never a second copy of anything the node set emits. There is no `LifecycleSampler` to wrap (it is deleted); each Electron producer is a tracker subscriber whose `onStart`/`onStop` attach and release the Electron listeners, with a per-reader try/catch-omit (`getAppMetrics` too, not only `getGPUInfo`) so one throw cannot drop another producer's values. `electron`/`powerMonitor`/`screen`/`BrowserWindow` are injected into those producers (they are not in `LaunchMainOptions` today and must be added there), never into `@bugsee/node`, where `getAppMetrics` would throw on non-Electron Node. **Events cannot ride the traces producers**: the table below mixes traces (`app_metrics`, `displays`) and events (`child_process_gone`, `power_*`, window focus/blur). A second `events.system` provider is rejected (`capture-coordinator.ts:53-55`, unique `provider.name`), and `launch.ts:870` always builds `createNodeSystemEventsSource(proc)` with no extra-source seam — so ST6 adds a node option (or an Electron-only extra source passed through) that wraps/muxes the node events source. **The mux attaches lazily**: it is an `EventSubscribable`/`InterceptorBase` whose `on()`/`onActivate` attaches BOTH the inner `.on('event')` AND the Electron `app`/`powerMonitor`/`screen`/`BrowserWindow` listeners, and `onDeactivate` removes them. Subscribing to `inner` or Electron in the wrap factory (at `launchMain`) would, with `captureSystemEvents:false`, still activate the node source's SIGTERM/SIGINT/`exit`/`beforeExit`/`warning` handlers (`system-events.ts:75-82`; they suppress default termination until `releaseSignalToDefault`) and keep `child-process-gone`/power listeners with nowhere to go, surviving `client.stop()`. The mux must not emit a second `process_started` (inner already does). Tests: option off → no SIGTERM handler, no `child-process-gone` listener; option on → both; `client.stop()` → released. `ElectronAppLike` is only `on('render-process-gone')` (`launch-main.ts:17-26`); `powerMonitor`/`screen`/`BrowserWindow` are added to `LaunchMainOptions` and destructured out of `...nodeOptions` as `app` already is (`launch-main.ts:76-77`). Tests: node + Electron traces both present (no name emitted twice); `getAppMetrics` throw → node traces still emit; `child_process_gone` lands on `events.system`; the node producers (event-loop histogram included) still start.

| Item | Source |
|---|---|
| Per-process CPU+memory (`app_metrics`: type, pid, cpu %, workingSet) | `app.getAppMetrics()` |
| `child_process_gone` event (type, reason, exitCode) | `app.on('child-process-gone')` — beyond the existing `render-process-gone` incident path |
| `power_suspend/resume`, `power_lock/unlock`, `power_ac/battery` events | `powerMonitor` |
| `displays` as an Android-shaped display LIST (id, size, scale, state), + add/remove/metrics-change events | `screen.getAllDisplays()` — use the name `displays` ONLY once that list shape is specified/confirmed against the viewer (Q5); else a JS-specific name. **As built (TR9, #91): the JS-specific `electron_displays`; the viewer confirmation (Q5) is still pending** |
| GPU info (context, NOT a `sample()` reader; *as built it goes through the `hardwareExtras` seam, see §14.5/§15.5 — the `sample()`/`start()` wording below is superseded*) | `app.getGPUInfo('basic')` returns a **Promise** — try/catch catches nothing, and `#emit` iterates `sample()` synchronously. Kick it once from `start()`, cache the resolved object, `sample()`/context reads the cache and omits until settled; attach `.catch(() => omit)` (a Linux-without-acceleration rejection is an `unhandledRejection` on the session owner, which Bugsee's own detection would report). Tests: rejected `getGPUInfo` → launch succeeds, no `unhandledrejection`, node traces still emit, no GPU entry |
| Window focus/blur/show/hide events; `unresponsive`/`responsive` | `BrowserWindow` for focus/blur/show/hide; **`unresponsive`/`responsive` are listened for on `webContents` ONLY.** Electron documents the pair on BOTH `BrowserWindow` and `webContents` — `BrowserWindow` re-emits the `webContents` event (after ~50 ms when the window is enabled and not destroyed) — so attaching both would record every hang twice. `webContents` is the single source because it also covers renderers with no `BrowserWindow` (a `BrowserView`, a `<webview>`). In the mux `onActivate` attach to `BrowserWindow.getAllWindows()` AND `app.on('browser-window-created')` (apps typically call `launchMain` then `createWindow()` from `whenReady()`, so the list is empty at activation) for the focus/blur/show/hide window events, and to `webContents` via `app.on('web-contents-created')` for the hang pair; remove all in `onDeactivate`. Expand `ElectronAppLike` beyond `render-process-gone`. Tests: a window created AFTER `launchMain` still records focus; `webContents.emit('unresponsive')` records ONCE even when the owning window re-emits it (the window pair is deliberately not listened to), and `win.emit('unresponsive')` alone does not record |

### P4 — Serverless / edge context

| Item | Source | Notes |
|---|---|---|
| Lambda: remaining time, memory limit, request id, cold-start flag, timeout-warning event | Lambda `context` | Sentry/Datadog. Context fields, not polled traces. |
| Cloud provider/region from env | `process.env` (`VERCEL`, `AWS_REGION`, `FLY_REGION`, …) | Check whether the environment builder already does this (Q4). |
| Cloudflare/Vercel CPU/memory | **Platform-side only** — SDK cannot read them; do not fake. | — |

### Explicitly NOT ported
`wifi`, `cellular`, `bluetooth`, `nfc`, `screen_brightness`, `game_mode`, `satellite`, `device_idle`,
`low_power_*`, `thermal_state`/`thermal_headroom` (browser Compute Pressure is CPU, not thermal — see `cpu_pressure`), iOS `accessibility`/`fold_state`/`hinge_angle`, `ram_low_memory` /
`MemoryPressure` / `TrimMemory` (no JS signal; a heap-ratio threshold would be an invention — if wanted later it
must be named derived, e.g. `heap_pressure`), `UserDidTakeScreenshot`, `ClipboardChanged` content, input-device
events. Reasons: no API, privacy, or Bugsee-internal state.

## 5. Architecture constraints

- **Thin kernel, no core piercing.** All additions are sampler entries in the platform packages' existing
  `system-metrics.ts` callbacks (or new interceptors feeding the system-events provider). Nothing in
  `@bugsee/core`.
- **Runtime-portable.** Shared tiers reach globals only via `globalThis as unknown as {…}` casts. `v8`/`fs`/
  `perf_hooks` live in `@bugsee/node` behind the existing guarded-metrics seam (`guarded-system-metrics.ts`).
- **Named per-runtime flags on the GUARDED SAMPLER, never `typeof fn === 'function'` or `value !== 0`.** ST1
  lives in `createNodeSystemMetricsSampler`, which `@bugsee/bun`/`@bugsee/deno` reuse via
  `createGuardedSystemMetricsSampler(deps)` (`node/src/guarded-system-metrics.ts:113-127`). The flags are
  `GuardedSystemMetricsDeps` fields — NOT launch options — passed into the factory call BEFORE `...options`,
  exactly as `deno/src/launch.ts:29` does for `measuresEventLoopDelay: false` (keeping that position lets tests
  still inject `systemMetricsSampler`). `captureLocalVariables: false` after `...options` is a launch option that
  `nodeLaunchCore` reads; flags set there never reach the sampler and are silently ignored. Bun today calls
  `createGuardedSystemMetricsSampler()` with NO args (`bun/src/launch.ts:22`).
  *(The `measures*` honesty flags remain valid; the "`sample()` reader" injection mechanism around them is superseded by §14 — see §14.5.)* New deps (default ON for Node): `measuresGc`, `measuresV8Heap`, `measuresAvailableMemory`,
  `measuresConstrainedMemory`, `measuresActiveResources`. For `sample()` readers, each `false` must INJECT AN OMITTED READER (the way
  `measuresEventLoopDelay: false` injects `eventLoop: unavailableLoop`) or a `NodeSystemMetricsDeps` field the node
  sampler branches on — a boolean that is merely destructured does nothing. **Standing sources are different:** `measuresGc: false` must make `start()` NOT call `PerformanceObserver.observe` at all (a no-op GC lifecycle, analogous to never constructing the histogram) — omitting `gc_*` from `sample()` while still forwarding `inner.start()` leaves an observer registered for the process lifetime on every Bun/Deno session. Every attach in `start()` is per-attach try/catch-omit, so a throwing `observe({entryTypes:['gc']})` cannot abort `captureCoordinator.start()` (and block `process_started`) — the same isolation required of `sample()`. Tests: bun-shaped fake → no `observe` call; `observe` throws → launch succeeds, `process_started` still emits, `gc_*` absent. Values: `@bugsee/bun` all five
  `false`; `@bugsee/deno` `measuresGc`/`measuresAvailableMemory`/`measuresConstrainedMemory`/
  `measuresActiveResources` `false` (blind, incomparable, unprobed on Linux, always 0), `measuresV8Heap: true`
  (measured real). Bun's `constrainedMemory` of 68.7 GB passes any numeric sanity filter, so the sentinel check
  is not a gate. Tests: pin the factory call per runtime
  (`toHaveBeenCalledWith(expect.objectContaining({ measuresV8Heap: false, … }))`, as lag is pinned in
  `deno/src/launch.test.ts`), AND run the sampler under a Bun/Deno-shaped fake asserting the traces are ABSENT.
- **Browser sampler env.** The visibility-gated standing sources (`fps` rAF, `app_state`, the lag ping) need `document.visibilityState` and `requestAnimationFrame`, but `BrowserTracesEnv` has only `performance`/`navigator`/`screen` (`browser/src/system-metrics.ts:44-58`) and both roots build the sampler with NO env (`browser/launch.ts:798`, `webview/launch.ts:671-675`) while events get `{window: win}` / `{window: win, document: domDocument}`. Extend `BrowserTracesEnv` with `window`/`document` (or rAF + a visibility reader) and pass ONE `{window: win, document: domDocument}` pair to BOTH the events source and the traces sampler. Today only webview does that (`webview/launch.ts:680-684`); browser `launch.ts:803` passes `{ window: win }` only — `domDocument` (`options.document ?? win.document`, resolved at `:660-661`) goes to input/viewtree/replay/page-hide flush, and the events factory then defaults a missing `document` to the GLOBAL one (`system-events.ts:89-92`). Fix browser to `{ window: win, ...(domDocument !== undefined ? { document: domDocument } : {}) }` (the webview pattern) and do not copy today's `{window: win}` as the template; `freeze`/`resume` and `visibilitychange` then listen on the same document as input — never read `globalThis.document` while the rest of the SDK is bound to `options.window`, or an injected hidden document drives the background event (`UIApplicationDidEnterBackgroundNotification`) while traces keep a vsync loop on the parent. Probe 5 hide→wait→show must run against launch-injected window/document.
- **Presence vs honesty are different gates.** The `measures*` flags above answer "does this runtime LIE"
  (Bun/Deno: API exists, number is wrong). They do not answer "does this API EXIST on the declared floor"
  (`@bugsee/node` `engines: >=18`): `process.availableMemory()` is absent on Node 18 (§8) and needs ≥20.13/22;
  `constrainedMemory()` needs ≥18.15 (`docs/research/capture-apis/node.md:141-142`). Node launch uses
  `createNodeSystemMetricsSampler()` with no flags (`node/src/launch.ts:866`), not the guarded wrapper. So each
  reader is added with BOTH: a presence check feature-detected at construction (an absent function ⇒ omitted
  reader — this is not the banned `typeof` honesty gate, it is floor compatibility) AND per-reader try/catch
  → omit. This is mandatory because the provider runs `sample()` synchronously in `onStart`→`#emit` with no
  try/catch (`system-traces-provider.ts:59-73`), `captureCoordinator.start()` does not isolate per provider
  (`capture-coordinator.ts:69-71`) and system events register AFTER traces (`launch.ts:870`): one throw on the
  initial snapshot means `process_started` never emits, and a throw on a later tick (e.g. `statfsSync` ENOENT after
  a tmp cleaner removes `dataDir`) is an uncaught `setInterval` exception in the host. A FAILED `statfs` must
  OMIT — never flow through `bytesToMegabytes`, whose 0-on-NaN would report a full disk. Tests: run the sampler
  with each API missing and each API throwing; assert launch succeeds, `process_started` still emits, and only
  that trace is absent.
- **Per-runtime gates, not passive tells.** Anything UNMEASURED on Bun/Deno ships with a runtime flag (like
  `measuresEventLoopDelay`) defaulting to OFF there until measured; `@bugsee/{bun,deno}` flip it only with a
  recorded measurement in this doc.
- **Cadence.** Keep the single 1 s sampler for cheap sync reads. Slow/expensive sources (`fs.statfs`,
  `getAppMetrics`, `getHeapSpaceStatistics`) sample every N ticks (Android precedent: process memory every
  5th tick, disk every 5 s). Event-driven sources emit on change with dedupe (iOS `emitIfChangedName`).
- **Lifecycle seam (REQUIRED, ST0).** *(Superseded by §14: the `{start, stop, sample}` mechanism was deleted (#65); the lifecycle is now tracker `onActivate`/`onDeactivate` driven by producers, and the requirements below remain as tracker tests.)* Today the platform sampler is a bare `sample: () => TraceSample[]`
  (`system-traces-provider.ts:33`) built unconditionally at launch (`browser/src/launch.ts:798`,
  `node/src/launch.ts:866`), and the provider is not tied to an interceptor, so interceptor subscriber-presence
  does NOT apply to it; `stop()` only clears the 1 s timer. Standing sources (GC `PerformanceObserver`, rAF
  counter, the `MessageChannel` ping, `PressureObserver`, battery/charging/connection listeners — NOT `matchMedia`/Page Lifecycle, which are events-source concerns) therefore MUST NOT be installed in the
  sampler factory — they would run with `captureSystemTraces:false` and survive `client.stop()`. Extend the
  sampler contract to `{ start(), stop(), sample() }` (or a dedicated provider/interceptor): attach in
  `start`, tear down in `stop`; **ST0 also migrates the EXISTING factory-time work**: `monitorEventLoopDelay().enable()`
  at sampler construction (`node/src/system-metrics.ts:62-63`) and `getBattery()` in the browser factory
  (`browser/src/system-metrics.ts:96-101`) move into `start()` (disable/release in `stop()`) — today
  `captureSystemTraces:false` / `client.stop()` still starts the histogram and fetches BatteryManager. There are
  THREE composition roots, not two: node (`launch.ts:866`), browser (`launch.ts:798`) and **webview**
  (`webview/src/launch.ts:671-675`, same `createSystemTracesProvider({ sample: … ?? createBrowserSystemTracesSampler() })`);
  all three must PASS the lifecycle sampler through to the provider — **the launch files do not call `start()`/`stop()` themselves**: registration at `addCaptureProvider` is unconditional (`capture-coordinator.ts:52-61`); the option gate is `startProvider` (`:40-44`), which skips `provider.start()` when `captureSystemTraces` is false. Calling `sampler.start()` at those launch lines would `enable()` the histogram / start rAF with the option OFF; only plumbing `sample: () => sampler.sample()` would leave `start()` never called (Bun/Deno lag at the idle floor). So `SystemTracesProviderOptions` (today `{sample, intervalMs, scheduler, now}`) changes to accept a `LifecycleSampler` (a plain function is wrapped sample-only), and the PROVIDER calls `sampler.start()` at the top of `onStart` (before the initial `#emit`) and `sampler.stop()` in `onStop`. Tests: option off → no `enable()`/no rAF; option on → `start()` then first sample; `client.stop()` → released. **The factories themselves change**: `createNodeSystemMetricsSampler`, `createGuardedSystemMetricsSampler`
  (`guarded-system-metrics.ts:116-118`, today `() => TraceSample[]`) and `createBrowserSystemTracesSampler` all
  return `LifecycleSampler = { start, stop, sample }`. Bun/Deno do NOT take the `?? createNodeSystemMetricsSampler()`
  default — they INJECT `createGuardedSystemMetricsSampler(…)` through `options.systemMetricsSampler`
  (`bun/src/launch.ts:22`, `deno/src/launch.ts:29`), so they pick up the object. Widen the public option
  (`browser/src/launch.ts:411`, node equivalent) to `(() => readonly TraceSample[]) | LifecycleSampler` and wrap
  ONLY `typeof === 'function'` values (test stubs like `() => []`) as sample-only; a function wrap at the launch
  line cannot tell a stub from production, which is why the production samplers must stop being bare functions.
  The Bun/Deno event-loop histogram is enabled at CONSTRUCTION in `guardedEventLoop`
  (`guarded-system-metrics.ts:54-56`), NOT in `createEventLoopReader` (`system-metrics.ts:62-63`, node-only): move
  BOTH `enable()` sites into `start()` (and `disable` in `stop()`). Getting this half-right fails two ways —
  moving only the node site leaves Bun leaking a running histogram after `captureSystemTraces:false`/`stop()`;
  no-op-wrapping the guarded sampler while moving `enable()` leaves Bun's `event_loop_lag_*` at the idle floor
  through a real stall (the Deno lie, on Bun). Bun/Deno tests pin that the DEFAULT sampler has a real `start`
  (histogram enabled only after provider start, released on stop), as lag is pinned in
  `deno/src/launch.test.ts:278-279`; the gate is `captureSystemTraces` + provider start/stop. Each standing source
  needs a test proving it is absent when the option is off and released on stop — INCLUDING the two pre-existing
  ones above.
- **Cost.** GC observer and rAF counter run only between provider `start`/`stop` (see Lifecycle seam). Budget: the sampler tick must stay well under the existing
  cost envelope; measure, don't assume.
- **Protocol.** Trace names are free-form in `traces.system`, but the viewer renders from fixed lookup tables
  (`web-tier-wire-alignment`): new names need a viewer-side title/units entry or they render raw. See Q5.

## 6. Test and review plan (binding standards)

Per slice: test-first; mutator loop per new entity (≤10 iterations, roll back by `cp`/restore — never
`git checkout`); integration test at each package boundary; 100% line / ≥90% branch per package; real-runtime
cases added to `@bugsee/instrumentation-tests` (node/bun/deno e2e) and a real-browser e2e for browser traces
(`real-browser-and-otel-e2e` precedent). Each runtime gate gets a test proving the trace is OMITTED where
the probe says the runtime is blind, and PRESENT where it is sound. Convergent multi-agent review per slice
(implementation-standards §7). Run `pnpm ci:local`, not just `pnpm test`.

## 7. Prerequisite probes (do before building P1/P2 slices)

Measure, on real runtimes, with the SDK's own call path (not a toy script):
1. `PerformanceObserver('gc')` — fires? entries have `detail.kind`/`duration`? on node 18/22, bun 1.4, deno 2.9.
2. `v8.getHeapStatistics()` and `getHeapSpaceStatistics()` — present and non-constant on bun and deno?
3. `fs.statfs` — present and correct on bun and deno?
4. `process.availableMemory()` / `getActiveResourcesInfo()` — presence per runtime and min Node version.
5. Browser: rAF-counter cost and accuracy in background tabs; `main_thread_lag_ms` in a hidden tab vs a known sync block; Compute Pressure availability; `battery`
   events on Chromium.
6. Sampler tick cost with P1 enabled (µs per tick) vs the current baseline.
Record each result in §8 with runtime version and date, as `docs/PROGRESS.md` does for the existing gates.

## 8. Measurement log

Measured 2026-10-14 on macOS (arm64) with standalone probe scripts (NOT yet through the SDK's own call path —
that confirmation is still owed per slice). Runtimes: node 18.20.6 / 22.13.1 / 22.20.0 / 24.15.0, bun 1.4.3,
deno 2.8.3. Method: allocate+retain ~100 MB of arrays, churn garbage, read `v8.getHeapStatistics()` and a
`PerformanceObserver({entryTypes:['gc']})`.

| Probe | node (18/22/24) | bun 1.4.3 | deno 2.8.3 |
|---|---|---|---|
| `PerformanceObserver('gc')` entries after heavy churn + forced GC | **works** (28–234 entries; `detail.kind` + `duration` present) | **BLIND — 0 entries** | **BLIND — 0 entries** (also with `--v8-flags=--expose-gc`) |
| `v8.getHeapStatistics()` tracks a +100 MB retained alloc | yes (Δ99.8 MB, = `memoryUsage().heapUsed`) | yes but **JSC-derived**: Δ62 MB for the same alloc; `malloced_memory == used == total` (aliases); **`heap_size_limit` is not a ceiling** — it moved 55.9 MB → 1.07 GB with heap growth | yes (Δ99.9 MB, real V8) |
| `v8.getHeapSpaceStatistics()` | real spaces | answers, but only `old_space` is non-zero (a JSC mapping, not V8 spaces) | real spaces |
| `getHeapStatistics()` cost | 0.3 µs/call | **0.2–1.6 ms/call at a small heap — NOT a bound.** `docs/research/capture-apis/SYNTHESIS.md` (§528–539, 699) measured it **heap-linear on Bun: 394 µs at 1–5 MB → 16.9 ms at 20–52 MB → 69 ms at 127–199 MB** (~7% sustained stall at 1 Hz) because JSC walks the heap to fake V8 stats. Cite 69 ms as the bound. (`bun:jsc.heapStats()` 0.47 ms here, one heap size.) | 1.3 µs/call |
| `fs.statfs` / `statfsSync` | present (node 18.15+ ok); ~0.8 µs sync | present, correct (same blocks as node); 0.5 µs | present, correct; 2.1 µs |
| `process.availableMemory()` | absent on node 18; present 22+ | present | present — but value differs wildly (24 GB vs node's 0.9 GB on the same host): **semantics not comparable across runtimes** |
| `process.constrainedMemory()` | 0 on **macOS**; on Linux Node 22.14 (review host) it returned `18446744073709552000` (≈2^64, the "memory.max = max" sentinel), NOT 0 | 68.7 GB on macOS (not a container limit) | 0 on macOS |
| `process.getActiveResourcesInfo()` | present (18+) | present, returns 0 entries | present, 0 entries |
| `process.resourceUsage()` | present | present | **absent** |

**Consequences (applied to §4/§9):**
1. **GC observer is node-only.** Gate it OFF on Bun and Deno (`measuresGc: false`), same mechanism as
   `measuresEventLoopDelay`; omit rather than report a quiet GC. (Its absence is itself a lie-by-omission only
   if we labelled it — we don't.)
2. **`ram_js_heap_*` / `v8_heap_*` must NOT be emitted on Bun.** Its `heap_size_limit` is not a ceiling, so
   `free = limit − used` is meaningless, and the cost is ~1000× node. Node and Deno only (real V8).
   Bun keeps `process_memory_heap_*` (which reads the same JSC data but is already shipped and honest about
   being "heap used/total").
3. **`ram_system_available` (`availableMemory`) is not portable** — drop from ST1 for Bun/Deno; Node ≥20.13 only (feature-detected, never a `major ≥ 22` check),
   and name/define it as "Node's availableMemory", not Android's `ram_system_free`.
4. `fs.statfs` is sound on all three → ST3 unblocked (still re-confirm through the SDK path).
5. `handles_active`/`requests_active` is near-useless on Bun/Deno (always 0) → Node only, low priority.
6. Per-space heap is meaningless on Bun → Node/Deno only if built at all.

**Corrections after review (PR #53):** `constrainedMemory` unconstrained sentinel differs by OS (Linux 2^64 vs
macOS 0); the Bun heap-stats cost is heap-linear (SYNTHESIS §699), not 1.6 ms.

**Still unmeasured:** Deno <2.8 (declared floor 2.0), Bun <1.4, Node 20; browser probes (rAF in hidden tabs,
Compute Pressure, battery events); sampler tick cost with P1 enabled through the SDK; Linux/Windows
(all numbers above are macOS).

## 9. Slices

| Slice | Content | Depends on |
|---|---|---|
| ST0 | Wire-shape decisions Q2/Q3/Q5 + `charging` decision (§3.1; default = leave as is — *superseded by §13.4/§14.5*) + **sampler `{start,stop,sample}` lifecycle seam** *(superseded by §14)* | — |
| ST1 | Node/Deno: `v8_heap_*`, ceiling-based `ram_js_heap_*`, `process_memory_limit` (Linux probe first), `process_uptime_s`, optional `ram_system_available` (Node ≥20.13, feature-detected) | probes 2, 4 + Linux |
| ST2 | Node: GC observer (`gc_*`) with per-runtime gate | probe 1 |
| ST3 | Node: `disk_mem_*` (+ option) | probe 3 |
| ST4 | Browser: `app_state`, `fps`, `screen_size` (optional), `main_thread_lag_ms`, (dark-mode/freeze/resume go to the EVENTS source, ST4b) | probe 5 |
| ST5 | Browser: event-driven battery/charging; `connection` only with the online/offline + change pair and the `onLine`-first mapper kept | probe 5 |
| ST6 | Electron: `app_metrics`, `child_process_gone`, power/screen/window events, GPU context | — |
| ST7 | Serverless context: Lambda context fields, cloud-region audit | Q4 |
| ST8 | Optional: Compute Pressure `cpu_pressure` (flagged off) | probe 5 |

## 10. Open questions (need a product/owner decision)

- **Q1.** Do long tasks / LoAF / web vitals / navigation+resource timing belong in `@bugsee/performance`
  (already owns `longtask` + web-vitals; it does NOT own `long-animation-frame`, which is research-only in `docs/research/capture-apis/browser.md` — LoAF is the open item) rather than `traces.system`? Recommendation: yes — keep them out of this doc's
  scope and confirm `@bugsee/performance` covers long tasks/LoAF; check for overlap before any build.
- **Q2.** **DECIDED YES (owner, 2026-10-14).** Should Node/Deno emit `ram_js_heap_*` *in addition to* `process_memory_heap_*`? Recommendation: yes,
  as a DIFFERENT quantity (ceiling-based total/free, per §4 P1), not a duplicate; only `used` repeats. Subsumes
  `SYNTHESIS.md` T1 (`heap_size_limit` / `constrainedMemory`), which already proposed this — this doc must
  reconcile with it, not restate it.
- **Q3.** **DECIDED: keep omitting (owner, 2026-10-14).** Omit vs `"$$unavailable"` for unsupported services. Recommendation: keep omitting (consistent with
  the ELU/Deno precedent) unless the viewer needs the sentinel — verify viewer handling first.
- **Q4.** Does the env builder already detect cloud provider/region? **Checked in review: NO** — node/browser env builders do not read `AWS_REGION`/`VERCEL`/`FLY_REGION`; `hardware.cpu_count` and `hardware.screen_*`/`pixel_ratio` already exist, so do not re-emit those as traces.
- **Q5.** ANSWERED — see §13.
- **Q6.** `disk_mem_*` privacy/opt-in: mirror iOS's option-gated capture? Recommendation: opt-in.

## 11. Evidence base and its limits

- Competitor browser: source read from shallow clones (Sentry, Datadog, New Relic, Highlight, OpenReplay,
  Embrace, Faro, PostHog, Bugsnag, Rollbar). **LogRocket, FullStory, Raygun, Dynatrace: docs only** — blanks
  there are absence of evidence.
- Competitor server: Sentry/Datadog/New Relic/Elastic/AppSignal/OTel from docs + source. Datadog Lambda
  CPU//tmp/fd collection mechanism, Sentry `processSession`, Dynatrace metric keys: **unverified**.
- Electron: Sentry from source; Bugsnag from docs only; Datadog has no verified main-process Electron SDK.
- Mobile: Android/iOS read from source (no code run). iOS spec `report-bundle-structure/platforms/ios.md:192`
  says its producer inventory is "still to be audited", so the iOS source is the only authority.
- Not researched: Tauri/NW.js; Raygun/Rollbar/LogRocket Electron.

## 12. Follow-ups from review round 9 (pre-implementation checklist — resolve in the owning slice)

Raised by the automated review on `4ad2ae9`; each was judged plausible but is NOT yet verified against the code
and NOT yet reflected in §4–§9. Each slice's author confirms the claim against the real files first, then adds the
tests named here. These supersede the corresponding prose above where they conflict.

1. **ST4 — complete browser traces env (`BrowserTracesEnv`).** The `{window, document}` pair given to the events
   source is an events env, not a traces env. Build a COMPLETE traces env from the same injected `win`/`domDocument`:
   `performance`/`navigator`/`screen`/`requestAnimationFrame` from that window, `document` from `domDocument`; pass
   only `{window, document}` to the events source. Do not spread `realEnv()` over an injected document. Tests:
   injected window+document still emit `ram_js_heap_*`/`connection` from THAT window; a missing
   `performance.memory` on it omits heap (no fallback to `globalThis`).
2. **ST4b — `matchMedia` from the launch-injected window.** Browser and webview launch pass
   `...(typeof win.matchMedia === 'function' ? { matchMedia: win.matchMedia.bind(win) } : {})` alongside
   `{window: win, document: domDocument}`; never default to `globalThis.matchMedia`. Tests: injected window whose
   `matchMedia` fires `change` records `DarkModeChanged`; a `WindowEvents` fake with no `matchMedia` still starts
   input and emits no dark-mode event.
3. **ST6 — GPU info destination (DECIDED: environment, through a NEW node seam; SHIPPED as `hardwareExtras`, the "must ADD" text below is the historical rationale).** `getGPUInfo` has no destination in
   the traces stream, and the seam the earlier text assumed does not exist: there is no Electron environment builder
   (`@bugsee/electron` has no `environment.ts`; `launchMain`, `electron/src/launch-main.ts:110`, only forwards to
   `launchCore`), `getEnvironment` is a local const in `node/src/launch.ts:637-648` already captured by `createClient`
   (`core/src/client.ts:891`, invoked at assemble `:1091`) so replacing `internals.getEnvironment` after `launchMain`
   returns changes nothing, and `SystemProbe` (`node/src/environment.ts:17-38`) has no GPU field while
   `buildNodeEnvironment` writes a closed `hardware` object (`:117-123`). So ST6 must ADD the seam first: a node launch
   option `hardwareExtras?: () => { gpu?: {vendor, renderer, gl_version?, gl_extensions?} } | undefined`, read LIVE on
   every environment assemble (so a GPU that settles after launch appears on the next report) and merged into
   `hardware` by `buildNodeEnvironment` (unknown keys from the probe stay dropped; only this typed extra is merged). The
   Electron wiring passes a closure over a cache that `start()` fills from `app.getGPUInfo('basic')` (a Promise: kick it
   once, `.catch` to omit, abort on `stop()` per item 5) and that returns `undefined` until settled. `start()` kicks
   the Promise but is not the writer. Tests: `hardwareExtras` unit-tests in `node/src/environment.test.ts` (merged
   when present, omitted when it returns `undefined` or throws, never overrides the closed fields); launch test that a
   report assembled after the extra settles carries `hardware.gpu`; Electron: rejected `getGPUInfo` → no `gpu` field
   and node traces still emit; resolved → the field is on the next report (never a per-tick trace).
4. **ST6 — existing `webContents` and window lifetime.** `web-contents-created` does not replay. In `onActivate`,
   for each current `getAllWindows()` attach the window events (focus/blur/show/hide ONLY — not the hang pair) and, for the hang
   pair, `win.webContents` `unresponsive`/`responsive` (one source: `BrowserWindow` re-emits the same event), plus
   `browser-window-created`/`web-contents-created` for later ones. Remove all in `onDeactivate`, and on
   `closed`/`destroyed` so a closed window is not retained until stop. Tests: a window created BEFORE `launchMain`
   still records `unresponsive` from `webContents` exactly once, even when the window re-emits it; `win.emit('unresponsive'|'responsive')` alone does not record (the window pair is not listened to).
5. **ST0/ST5/ST6 — abort in-flight Promises on `stop()`.** *(Mechanism superseded by §14 — the abort-on-stop requirement now applies to tracker `onDeactivate`.)* `getBattery()` (moved into `start()`) and `getGPUInfo`
   return Promises that `stop()` does not cancel. Use a generation/`aborted` flag in `start()`; `stop()` flips it and
   tears down whatever is already cached; the `then` is a no-op when aborted (no cache, no `levelchange` listener).
   Tests: `start()` then `stop()` before the Promise settles → no listener attached, no retained manager, a later
   fulfill is ignored. Same token for `getGPUInfo`'s late resolve.

**Process note.** Nine automated review rounds each confirmed the previous fixes and found the next layer of
attach-site / call-shape detail. That class is better caught against real files under the repo's own §7 convergent
review per slice than by further doc rewrites, which is why the doc is frozen here.

## 13. Q5 answered — what the viewer and the specs repo say (2026-10-14)

Sources: `bugsee/viewer` at `origin/main` `7b65465` (read via git, working copy untouched) and `bugsee/specs`
`6df4b85`. Verified by reading code, not by rendering a report.

### 13.1 The specs repo is thin on system traces
`sdk/reporting/bundle/traces.md` fixes the envelope (`timestamp`, optional `displayId`, `name`, `value`) and value
schemas for only FOUR traces: `capture`, `cellular`, `fold_state`, `hinge_angle`. Everything else is "scalar,
producer-specific". `platforms/android.md#system-trace-producers` lists Android PRODUCER ids (`connectivity`,
`power_status`, `ram`, `cpu_usage`, `top_activity`, …), not the wire names the producers emit. `platforms/ios.md`
specifies `cellular`, `capture` and `ram_low_memory` only and says the iOS producer inventory is "still pending".
`events-system.md` says only "a platform-reported identifier"; Android names are in `android.md#system-event-names`.
**Consequence: the viewer's tables are the de-facto contract for every other trace name and value shape.** If a new
JS trace/value shape is meant to be cross-platform, it should be added to `traces.md` in the specs repo in the same
change as the viewer entry (the specs README says implementations are checked against the spec).

### 13.2 How the viewer processes system traces
- Named definitions in `recording-system-traces.constant.ts` give display (`blocks`/`lines`/`areas`), `units`,
  `precision`, `measure: dataSize`, `series`/`childs` grouping and `states` tables; titles live in
  `recording-traces-titles.constant.ts`; a fixed list `SYSTEM_TRACES_SPECIAL_TREATMENT` routes some names to
  processors (`battery`, `charging`, `orientation`, `displays`, `connection`, `wifi`, `cellular`, `capture`,
  `fold_state`, `hinge_angle`, `thermal_headroom`, `screen_brightness`, `view`, …).
- A trace with NO definition falls into "process other traces" (`recording-helper.service.ts:245-258`): generic
  `blocks`, title = titles-table entry or the raw name, no units, no chart. Numeric series (GC, heap, lag) therefore
  appear as value blocks, not lines/areas, until a definition exists. Equal consecutive values are collapsed.
- System EVENTS are fully generic: grouped by `name`, one `ticks` row per name titled with the raw name, filtered to
  the recording window. There is NO event-name table, so any name renders; snake_case vs PascalCase only matters for
  cross-platform grouping with Android's names, not for rendering.

### 13.3 Per-name verdicts for this doc's proposals

| Name / shape | Viewer today | Needed |
|---|---|---|
| `ram_js_heap_{total,free,used}` | Defined; viewer comment: same semantics as `ram_jvm_heap`, `total` = heap CEILING | Nothing — confirms the ceiling-based Node/Deno design (Q2) |
| `process_memory_{rss,heap_*,external,array_buffers}`, `cpu_usage_{user,system}`, `event_loop_lag*`, `event_loop_utilization` | Defined (`process_memory_js`, `cpu_usage_js`, `event_loop_lag`) | Nothing |
| `disk_mem_{free,total}` | `disk` group, MB `areas` | Nothing — confirms integer MB (§4 P1) |
| `app_state` | `states`: `started` / `foreground` / `background` (strings) | Emit exactly those strings; never `visible`/`hidden` |
| `displays` | `parseDisplays` expects a LIST of display objects (id, name, width/height or natural size, rotation, …) | `screen_size` stays a separate name; Electron `getAllDisplays()` may use `displays` only in that list shape |
| `thermal_state` | integer enum table (0 Nominal, 1 Fair, …) | `cpu_pressure` must be a separate name |
| `connection` | `processConnection` handles the browser shape, `online`-first, `effectiveType` as label only | Nothing for the current shape; ST5 must keep it |
| `orientation` | `RecordingOrientationsMap` ints 0–4 | Nothing |
| `rendering_fps` | groups `fps` + `fps_max` | `fps` renders with no new entry; `fps_max` has no browser source |
| `v8_heap_*`, `gc_*`, `process_memory_limit`, `process_uptime_s`, `handles_active`, `requests_active`, `main_thread_lag_ms`, `screen_size`, `cpu_pressure`, `app_metrics` | Undefined → generic value blocks | Viewer PR: definitions + titles (+ spec entry in `traces.md` where cross-platform) |
| `DarkModeChanged`, `freeze`, `resume`, `child_process_gone`, `power_*`, window events | Generic ticks rows | Nothing to render; keep names stable and, where Android has one (`DarkModeChanged`), decide on cross-platform grouping |
| `charging` | **see 13.4** | **change the SDK** |

### 13.4 `charging` is broken today, and the fix is supported
The viewer's `charging` table is keyed by integer states `"0"` unknown, `"1"` unplugged, `"2"` charging, `"3"` full,
and `processCharging` accepts an integer OR an `{state, …}` object (`processingHelpers.ts:364`). The shipped JS value is
a boolean: `false` is dropped by the falsy guard before the processor runs, and `true` looks up `states["true"]`
(undefined), so the row has no state. **Supersedes §3.1 and the ST0 default**: emit `{state: 0|1|2|3}` with `source`
OMITTED (never invented), map from `BatteryManager` (`charging` → 2, `!charging` → 1; "full" needs a rule, e.g.
`charging && level === 1` → 3; unknown/unsupported → omit). This is a fix, not a breaking change — nothing rendered
before. Q5 for `charging` is closed; the remaining question is only the "full" rule.

### 13.5 Correction to §3
Clash #4 ("`orientation` ints 3/4 mean opposite things on iOS vs Android") is NOT supported by the viewer's own note:
`recording-orientations-map.constant.ts` says 3/4 "follow the SDK contract, which both platforms state identically"
(Android `Orientation.LandscapeLeft(3)`, iOS `BGSOrientationLandscapeLeft = 3`, `BGSContracts.h`), and that an earlier
swap was a LABEL bug, not a wire difference. The iOS research pass's claim was wrong; no JS action on `orientation`.

### 13.6 Follow-ups
1. Viewer PR: definitions + titles for the new names in §13.3 (group `v8_heap_*`, a `gc` group, `lines` for lag/uptime).
2. Specs PR: add any cross-platform JS trace/value shape (`charging` object, `app_state` strings already implied) to
   `bundle/traces.md`; add the JS runtime names to a platform note.
3. Not yet checked: viewer `hints` table (`RecordingTracesHintsConstant`) and the session-level `hardware.*`
   fields the viewer reads from `request.json` (`hardware.gpu` placement for ST6 GPU info is decided: §13.7 and §12 item 3 — the `hardwareExtras` node seam; only the exact `cpu_count` shape still needs that spec check).

### 13.7 Decisions and the GPU destination (owner, 2026-10-14)
- **Q2 = yes**, **Q3 = keep omitting** (viewer: an omitted trace simply does not appear; `$$unavailable` is handled only
  for wifi/cellular-style traces).
- **GPU info is ENVIRONMENT data, not a trace.** Resolves §12 item 3 as the environment destination (the seam is specified there). The viewer reads
  `environment.hardware.gpu = { vendor, renderer, gl_version?, gl_extensions? }` (`core/types/environment.ts:78`;
  rendered in the context and environment panels, `elements-recording-context.component.html:418-439`,
  `elements-recording-environment.component.html:197`); the specs list `gpu` under `hardware`
  (`api/issues.md#environment-object`). So ST6 sets `hardware.gpu` through the new node `hardwareExtras` launch option (§12 item 3: there is
  no Electron environment builder to hook) once `getGPUInfo` settles, omitted until then, and never as a trace. The seam shipped (`hardwareExtras` in `packages/node/src/environment.ts:152`, wired by `packages/electron/src/launch-main.ts`). The mapping from Electron's GPU info to
  `{vendor, renderer}` is VERIFIED on Electron 44.9.3 / macOS (`'basic'` gives no vendor/renderer; `'complete'` does), see §15.5 decision 3; Linux/Windows `'basic'` output is still unverified. `hardware.gpu` may also be fillable in the browser via the WebGL
  `WEBGL_debug_renderer_info` extension; that is out of this doc's scope and needs its own privacy decision.
- `hardware.charging` is a **boolean** in the viewer's environment type (`environment.ts:71`), unlike the `charging`
  TRACE (`{state}`, §13.4). Do not change the environment field when fixing the trace.

## 14. Structure: shared trackers + per-trace producers (owner decision, 2026-10-14) — SUPERSEDES the lifecycle seam

The design above was written around a platform `sample()` function and then grew a `{start, stop, sample}` lifecycle
seam (§5 "Lifecycle seam", §12 item 5, review rounds 2–9) to keep standing resources from leaking. The owner directed
that system traces follow the mobile SDKs' structure instead. Studied from source (Android `shared/trackers/*`,
`capture/providers/traces_system/*`, `BugseeCaptureValueProducer*`; iOS `Shared/Trackers/*`,
`Capture/Providers/TracesSystem/*`), then mapped onto what JS already has.

### 14.1 The mobile structure
- **Tracker** (`BugseeTrackerBase<T>` / `BGSTrackerBase`): owns a raw OS signal (receiver, callback, 1 s poll), aggregates
  the CURRENT STATE, and notifies typed listeners (Android: `addListener`/`addBoundListener`, per-listener try/catch;
  iOS: weak listener table, `respondsToSelector:` fan-out, no isolation). One tracker serves many producers — Android's
  `BugseeTrackerProcess` owns the 1 s timer and feeds `TraceRandomAccessMemory`, `TraceProcessMemory`, `TraceCpuUsage`.
- **Producer** (`BugseeCaptureValueProducer` / `BGSCaptureSystemTraceProducer`): subscribes to tracker(s) in `start()`,
  emits a baseline, converts state to wire values, de-duplicates (`emitIfChangedName`, equality checks), and emits via a
  listener into the provider. Polled-vs-event-driven is a per-producer fact; cadence is owned by a tracker (Android) or
  the provider timer (iOS).
- **Provider** = a container of producers (`TraceValueProducerContainer`): stamps timestamps, keeps a last-value
  SNAPSHOT per `displayId:name`, and re-emits it at every capture-part switch so a rolling window always starts with the
  current state. Producer construction is guarded per producer on Android.
- **Not copied:** trackers there are process-lifetime singletons that start eagerly and are almost never reset (only
  Android's Storage tracker polls solely while it has listeners); Android has no `captureSystemTraces` gate.

### 14.2 The JS mapping
- **Tracker = `InterceptorBase` subclass** (`core/src/interceptor-base.ts`): already a listenable multi-key emitter with
  per-listener isolation, activating on the first subscriber and deactivating on the last — the behaviour Android only has
  for Storage, here by default, and already the repo's rule ("subscriber-presence drives activation"). The `events.system`
  sources (`createNodeSystemEventsSource`, `createBrowserSystemEventsSource`) are this pattern today; `traces.system` was the
  outlier. Trackers are created **per launch from injected environment** (as the events sources are), not module
  singletons, so they stay testable and compatible with multi-instance coexistence.
- **Producer = `TraceProducerBase`** (`@bugsee/capture`): `start(sink)` subscribes + emits a baseline; `stop()` unsubscribes;
  `emit` / `emitIfChanged`.
- **Provider** = producer container with per-producer start/stop isolation (stronger than either mobile SDK), a sink that
  stamps time and records the snapshot, and a **refresh** (below). The bare `sample()` option stays as a legacy polled
  adapter during migration.
- **Option gate:** `captureSystemTraces` (JS-only) gates the provider; producers start only then, so no tracker activates
  otherwise and everything is released on stop by subscriber presence.

### 14.3 What this dissolves
Most review findings in rounds 2–9 were symptoms of resources living in sampler factories or `start`/`stop` pairs:
the delay histogram and `getBattery()` at construction, rAF/GC-observer/`MessageChannel`/`PressureObserver` standing
sources, hidden-tab gating, late-resolve abort tokens, the Electron "wrap the node sampler" problem, and the lazy
events mux. Under this structure each is a tracker's `onActivate`/`onDeactivate`, gated automatically. The
"same `window`/`document` everywhere" findings (rounds 7–9) become one shared **`PageLifecycleTracker`** bound to the
injected window+document, subscribed by both the system-events source and the traces producers — the way Android's
`TraceAppState` and `EventApplicationLifecycle` share the Application tracker. The `measures*` honesty flags live on the
tracker/factory deps (§5 stays valid in intent; its mechanism is now `NodeTraceProducerDeps`). The §12 items still apply
as test requirements for the trackers that implement them (ST4/ST5/ST6).

### 14.4 New requirement found: last-value refresh
Android/iOS re-emit the last value of every trace on each part switch. JS stores roll a time window with no part hook
(`CaptureStore.tick` evicts by `maxRecordingTimeMs`; `chunk-capture-store.ts`), and today every trace is re-polled every
second so nothing ages out. Event-driven producers with de-duplication (battery, orientation, connection) WOULD age
out of every report. The provider therefore re-emits any held value older than `refreshMs` (default 10 s, bounded by a
quarter of the recording window) with the current timestamp. The viewer collapses equal consecutive values, so the cost is
bytes, not noise.

### 14.5 Slices (replaces the §9 ordering for ST0)
ST0′ (`docs/design/system-traces-st0-plan.md`): producer contract + container provider + refresh; node `ProcessStatsTracker`
(+ guarded lazy event-loop source) and five producers; node/Bun/Deno wiring; browser `BatteryTracker` + `BatteryProducer`
and the `charging` fix. Follow-ons: migrate the rest of the browser sampler to trackers (memory, connection, orientation),
shared `PageLifecycleTracker`, delete the legacy samplers, then ST1+ traces as producers, then Electron trackers (ST6).

**Status (2026-10): shipped.** ST0′ (#55), the browser trackers (#62), `PageLifecycleTracker` (#63) and the node legacy-sampler
deletion (#65; the browser sampler went with #62) are merged, so the bare `sample()` adapter no longer coexists with the producers on browser or node: the legacy
browser sampler (which also emitted `battery`/`charging`, the duplicate rows an interim reading of this section implied) is
deleted and `systemMetricsSampler` survives only as an explicit caller override that REPLACES the heap, connection, orientation, `app_state` and `fps` sensor traces; the `battery` producer still runs alongside it (`browser/src/launch.ts`, the `createSystemTracesProvider` wiring), so a sampler that also emits `battery`/`charging` would have duplicated those rows. Fixed (#154): the producers that keep running alongside the override own their names (`battery`, `charging`, `battery_charging_time_s`, `battery_discharging_time_s`, `route`, `view`, `url` when captured, and `capture` when replay is on) and `launch` drops sampler rows under them (`withoutTraceNames` in `@bugsee/capture`, with the owned set from `producerOwnedNames` in `packages/browser/src/launch.ts`), so there is one writer per name; the sampler's other rows are kept.

The domain-tracker follow-on (§15) is tracked in §15.5. The node `ProcessStatsTracker` that §14.5 lists for ST0′ was replaced by the node `ProcessTracker` in TR8 part 1 (#87): its files, tests and `@bugsee/node` exports (`ProcessStatsTracker`, `ProcessStats`) are gone, and `packages/trackers/src/node/` is no longer a placeholder. The Electron trackers (ST6 above) shipped as TR9 (#90, #91). The per-signal browser trackers that §14.5 originally listed as remaining (`MemoryTracker`, `OrientationTracker`, `FpsTracker`, `ScreenSizeTracker`, `MainThreadLagTracker`) were folded into the domain trackers by TR2 (#82) and TR5 (#83) and their files are deleted: `packages/browser/src/trackers/` no longer exists on `main`.

### 14.6 Verified / not verified
Verified by reading source: the mobile tracker/producer/provider structure (above), `InterceptorBase`/`MultiKeyEmitterBase`
semantics, the JS store's window-based eviction with no part hook. Not verified: Android's polled-trace scheduling details,
how `TraceFps`/FrameMetrics interplay would map to browser `rAF`, and whether per-launch (non-singleton) trackers need any
registration with the internal DI container for multi-instance coexistence.

## 15. Domain trackers (owner decision, 2026-10-19) — SUPERSEDES the per-signal trackers of §14.2

§14 adopted the mobile tracker/producer split but the JS slices then built one small tracker per signal (orientation,
fps, screen size, main-thread lag, GPU cache, GC observer, …). That is a misreading of the mobile design, which this
section corrects. Android reference: `library/src/main/java/com/bugsee/library/shared/trackers/` (`BugseeTrackerBase`,
`…UI`, `…Display`, `…Application`, `…Power`, `…Connectivity`, `…Process`, `…Storage`, `…Device`, `…Threading`).

### 15.1 Principles
1. **A tracker is a global singleton**, created on first need. Its lifetime is the application's, or it stops/resets when
   the last subscriber leaves — **but only if that loses nothing a later subscription needs** (last screen size, battery
   manager, GPU info, language, quota estimate are retained). The tracker decides; subscribers never do.
2. **A tracker encapsulates a DOMAIN**, not a signal. All related notifications, caches and machinery live in one class
   (or a small private group of classes). Nobody iterates through many trackers to find one.
3. **A tracker emits as many related notifications as it can** — in JS: several stages on the existing
   `InterceptorBase`/`MultiKeyEmitterBase` (the analog of Android's many-method listener interface with default no-ops:
   `UIChangeListener.onOrientationChanged / onKeyboardVisibilityChanged / …`). Failure-isolated fan-out
   (a throwing listener never breaks the others or the host's event dispatch) is already provided by the emitter.
4. **Trackers may subscribe to other trackers** (Android: UI → Display, Activity). Producers and events sources are thin
   consumers: they subscribe to notification kinds and map them to trace/event names and wire shapes.
5. **Singleton vs the injected window.** The SDK binds to the window/document passed to `launch()` (hostile-frame
   guards, tests), so "global" means **one instance per window object**: `trackerFor(window, create)` over a `WeakMap`,
   with a default for the host's own `window`; a `reset()` for tests. Every host read stays guarded (`hostRead`).

6. **Trackers are the abstraction layer over the runtime/system APIs** (owner, 2026-10-19), not mere event
   re-translators, so they live in a DEDICATED package `@bugsee/trackers` BELOW `@bugsee/core` (core imports it and
   re-exports the foundation names): a runtime-portable root entry (multi-key emitter, `InterceptorBase`, the registry,
   contracts) plus `./browser`, `./node`, `./electron` subpath entries holding the platform implementations (the only
   places that touch DOM / `node:*` / Electron APIs, through injected env objects). Platform packages
   (`@bugsee/browser`, `@bugsee/node`, `@bugsee/electron`) keep only composition (launch wiring, producers).
7. **Per-launch config on a shared singleton.** The registry's `for(key, create, rebind)` hands every later request's
   config (error sink, capabilities such as `getBattery`) to the existing tracker (`rebind`, latest launch wins); an IDLE
   tracker may also re-bind the window/document it attaches to, an ACTIVE one keeps its bindings and reports the mismatch. **As built (§15.5) this is narrowed:** only `ApplicationTracker` keeps its bindings while active; `ConnectivityTracker`, `UiTracker`, `ProcessTracker` and `EnvironmentTracker` stop/detach and re-attach a running tracker to the new seams (a seam that did not change leaves a running `ProcessTracker` alone), and `StorageTracker` applies new seams at the next activation.
   Keying: the object the tracker listens on (document for Application, window otherwise); there is no silent
   host-global fallback when a window was injected.

### 15.2 Browser tracker catalog

| Tracker | Absorbs today's | Notifications (stages) |
|---|---|---|
| **Application** | `PageLifecycleTracker`, `app_state` | `visibility`, `pagehide`, `freeze`, `resume`, `state` (foreground/background) |
| **UI/Display** | `OrientationTracker`, `ScreenSizeTracker` (#75), `FpsTracker`, dark-mode `matchMedia`, viewport | `orientation`, `screenSize` ({width,height,dpr}), `colorScheme`, `frameRate`, `viewport`, display-mode/`reducedMotion`/contrast where cheap |
| **Connectivity** | `ConnectionTracker` | `online`/`offline`, `networkInfo` (Network Information API, §15.3) |
| **Power** | `BatteryTracker` | one `state` stage ({level, charging, chargingTimeS?, dischargingTimeS?}) fed by all four Battery Status events (§15.3); more stages (e.g. low-battery) only where an API exists |
| **Process** | `MemoryTracker`, `MainThreadLagTracker` (#75), uptime | `heap`, `mainThreadLag`, `idle` (§15.3), `uptime` |
| **Storage** | — | `storageEstimate` (as built: `{usageBytes?, quotaBytes?, persisted?}`; see §15.5, which supersedes this row) |
| **Environment** | — | `language`, `timezone`, `hints`, `permissions`, `privateMode` (as built, §15.5; `displayMode` lives on the UiTracker) |

Node/Bun/Deno: **Process** (absorbs `ProcessStatsTracker`, the GC observer, event loop, heap/limits, uptime) and **Storage**
(the `disk_mem_*` poll, device volume of `effectiveDataDir`); both built, see TR8 in §15.5. Electron main: **Application**, **Display**, **Power**,
**Process** (`app_metrics`, once-only GPU info, `child-process-gone`; window focus/hang events live on Application; §P3); all four built, see TR9 in §15.5. The producers that exist
today keep their trace names and wire shapes; only their source changes.

### 15.3 Owner additions (2026-10-19) and the facts they rest on
1. **Storage (browser).** `navigator.storage.estimate()` → `{quota, usage}` (and `persisted()`), polled sparsely
   (on activate, on visibility→visible, then a slow timer) because there is no change event. This is an **origin quota
   estimate, not device free space**, and browsers fuzz/pad it (Safari and private windows especially), so it is reported
   as approximate under a JS-specific name/shape (`storage_estimate` in integer MB `{usage, quota}`), NOT as the Android
   `disk_mem_*` group, unless the viewer (Q5) is shown to treat the two alike.
2. **Environment tracker.** Aggregates what can be observed about the runtime: `navigator.language(s)` + the
   `languagechange` event, time zone (no event: re-read `Intl.DateTimeFormat().resolvedOptions().timeZone`/offset on tick and
   on visibility), `matchMedia('(display-mode: …)')` (PWA/standalone), cookies enabled, secure context,
   cross-origin isolation, service-worker controlled, `navigator.webdriver` (automation), Do-Not-Track/GPC, Permissions API
   states **queried without prompting**, and **private/incognito detection**. Private-mode detection is heuristic and
   browser-specific (quota size, storage/IndexedDB/OPFS behaviour) and changes between browser versions; it is reported
   tri-state `yes | no | unknown` with the method used, never as a certainty. **Open question (as originally written; RESOLVED 2026-10-20 by the owner, see §15.5):** detecting
   private browsing can read as circumventing the user's intent; the proposal was default OFF behind an explicit launch option
   (`captureEnvironmentHints`), with `language`/`timezone`/`displayMode` on by default. The owner decided it is OPT-OUT: on by default, `captureEnvironmentHints: false` disables it. As built, the `hints`/`permissions` stages are not read by the launch (see §15.5, TR7). Change notifications become
   `events.system` entries (`language_changed`, `timezone_changed`, `private_mode_detected`; `display_mode_changed {mode, previousMode?}` is derived from the UiTracker `displayMode` stage, #93).
3. **Connectivity.** Use the Network Information API where present (`navigator.connection`: `type` (Chromium/Android),
   `effectiveType`, `downlink` (Mbps, capped), `downlinkMax`, `rtt` (coarsened), `saveData`, `change` event) — a fraction
   of browsers (no Safari/Firefox), so every field is optional and omitted when absent. The `online`-first mapper stays
   (`connection.change` does not fire on going offline). Extend the notification with `downlinkMax`.
4. **Process: idle.** Two different things, both wanted:
   - **User/screen idle** via the Idle Detection API (`IdleDetector`: `userState` active/idle, `screenState`
     locked/unlocked; Chromium only, secure context, threshold ≥ 60 s). It needs a **permission prompt** (`requestPermission`,
     user gesture): the SDK MUST NEVER trigger a prompt in the customer's app. It runs only when the Permissions API
     already reports `idle-detection` as `granted`, otherwise the trace is omitted. Trace `user_idle_state`, built OPT-IN via `captureUserIdle` (default `false`, §15.5): it reuses the page's existing Idle Detection grant, and the SDK still never prompts.
   - **JS main-thread idle** via `requestIdleCallback` probing once per sampling tick (is an idle period granted, with what
     `timeRemaining()` ≤ 50 ms) → `main_thread_idle_ms`; Safari has no `requestIdleCallback` (omit). Must be cheap (one
     callback per tick, never a loop — see the main_thread_lag measurement in §P2) and gated to visible pages like fps/lag.
5. **Power.** Use the Battery Status API in full: `level`, `charging`, `chargingTime`, `dischargingTime` with the
   `levelchange`, `chargingchange`, `chargingtimechange`, `dischargingtimechange` events (Chromium-only, secure context,
   `battery` permissions-policy; `Infinity` times are omitted, never sent). `battery` and `charging` keep their current
   Android wire shapes; the times are new JS-specific traces (`battery_charging_time_s`, `battery_discharging_time_s`).

### 15.4 Migration plan (each slice: test-first, mutator loop, Opus review, ready PR)
- **TR0** foundation: per-window `trackerFor` registry + retention policy hook + `reset()` for tests; no behaviour change.
- **TR1** Application (fold `PageLifecycleTracker` + `app_state`), **TR2** UI/Display (orientation, screen size, fps,
  colour scheme, viewport; supersedes #75's `ScreenSizeTracker`), **TR3** Connectivity, **TR4** Power, **TR5** Process
  (memory, main-thread lag, idle, uptime), **TR6** Storage, **TR7** Environment — browser, one PR each, producers rewired
  onto the domain trackers with unchanged trace names and shapes.
- **TR8** node Process (+ GC, event loop) and Storage consolidation; **TR9** Electron trackers (GPU cache folds into
  the Electron Process tracker; supersedes #73's `GpuInfoCache` placement). **Both merged:** TR8 as #87 (Process) and #88 (Storage), TR9 as #90 (Process) and #91 (Power/Display/Application).
- Each tracker's retention rule is stated and tested ("stopping does not lose X"); each producer keeps its existing
  omit-never-zero and guarded-host-read tests.

### 15.5 As-built status (verified against `main` at `ae65d762`, 2026-10-21)

> **Superseded in part by §15.6** (everything merged through #134, `769cbbe9`): trace/event renames and retirements (`screen_size`, `electron_displays`, `ram_system_available`, `process_uptime_s`, `gc_*`, the Android renames of the shared events (C2)), the `availableMemory`/`uptime` Process stages and the open decisions marked below. The tables here are the as-built state at `ae65d762` and are not rewritten.

All domain-tracker slices TR0–TR9 are **merged on `main`**. Browser TR0–TR7 (implementations in `packages/trackers/src/browser/`, producers in `packages/browser/src/trace-producers.ts`, events source in `packages/browser/src/system-events.ts`, wiring in `packages/browser/src/launch.ts` and `packages/webview/src/launch.ts`):

| Slice | PR | Tracker (`…For(env, onError)` / `reset…`) | Stages | Producer / traces |
|---|---|---|---|---|
| TR0 | #77 | `createTrackerRegistry` (`tracker-registry.ts`): per-key `WeakMap`; `for(key, create, rebind?)`, `peek`, `reset` | — | — |
| TR1 | #79 | `ApplicationTracker` (`applicationTrackerFor`) | `pagehide {persisted}`, `visibility {visible}`, `state {state: foreground\|background}`, `freeze`, `resume` (the temporary `orientationchange` stage moved to the UiTracker in TR2; the temporary `online`/`offline` stages were removed in #93, a type change) | `AppStateProducer` (`app_state`, via `state` + `current()`); events source; trace/event names unchanged |
| TR2 | #82 | `UiTracker` (`uiTrackerFor`, `resetUiTracker`) | `orientation {type?, angle?}`, `screenSize {width, height, dpr}`, `viewport {width, height}`, `colorScheme {dark}`, `reducedMotion {reduce}`, `displayMode {mode: fullscreen\|standalone\|minimal-ui\|browser}`, `visualViewport {scale?, offsetLeft?, offsetTop?, width?, height?}` (added in #93; defaults to `window.visualViewport` when the env supplies none), `frameRate` (number) | `OrientationProducer` → `orientation`; `ScreenSizeProducer` → `screen_size {width, height, dpr}`; `FpsProducer` → `fps`; events `OrientationChanged`, `DarkModeChanged`, `display_mode_changed` (#93); the `video.aux` viewport source (`packages/browser/src/viewport-source.ts`) subscribes to the `viewport`/`visualViewport` stages (#93). No producer reads `reducedMotion` yet |
| TR3 | #80 | `ConnectivityTracker` | `online {online}`, `transition {online}` (added in #93: one per DOM `online`/`offline` event, kind taken from the event type, no baseline; feeds the `online`/`offline` events in `system-events.ts`), `networkInfo {type?, effectiveType?, downlink?, downlinkMax?, rtt?, saveData?}`, aggregate `state {online?, networkInfo?}` (activation emits a baseline of whichever of these have a value: `online` only when `navigator.onLine` is readable, `networkInfo` only where the API exists, `state` only when a state is readable) | `ConnectionProducer` → `connection` (unchanged shape; additive `link_downstream_max_kbps`) |
| TR4 | #78 | `PowerTracker` | one stage `state {level?, charging, chargingTimeS?, dischargingTimeS?}`, fed by `levelchange`/`chargingchange`/`chargingtimechange`/`dischargingtimechange` | `BatteryProducer` → `battery`, `charging`, NEW `battery_charging_time_s`, `battery_discharging_time_s` |
| TR5 | #83 | `ProcessTracker` (`processTrackerFor`, `resetProcessTracker`) | `heap {used, limit}`, `mainThreadLag {lagMs}`, `idle {idleMs}`, `userIdle {userState, screenState?}`, `uptime {uptimeMs}` | `MemoryProducer` → `ram_js_heap_{total,free,used}`; `MainThreadLagProducer` → `main_thread_lag_ms`; `MainThreadIdleProducer` → `main_thread_idle_ms`; `UserIdleProducer` → `user_idle_state`. No producer reads `uptime` yet |
| TR6 | #81 | `StorageTracker` | one stage `storageEstimate {usageBytes?, quotaBytes?, persisted?}`; polls on activation, visibility→visible (throttled to 1/min), slow timer (default 5 min, skipped while hidden) | `StorageProducer` → NEW `storage_estimate {usage, quota}` in integer MB (floored); NOT the Android `disk_mem_*` group |
| TR7 | #84 | `EnvironmentTracker` (`environmentTrackerFor`, `resetEnvironmentTracker`) | `language {language?, languages?, previous}`, `timezone {timeZone?, utcOffsetMinutes?, previous}`, `hints {cookiesEnabled?, secureContext?, crossOriginIsolated?, serviceWorkerControlled?, automation?, doNotTrack?, globalPrivacyControl?}`, `permissions {camera?, microphone?, geolocation?, notifications?, 'idle-detection'?}` (each `granted`\|`denied`\|`prompt`), `privateMode {private: yes\|no\|unknown, method?}` | no trace producer; the events source maps `language` → `language_changed`, `timezone` → `timezone_changed`, `privateMode` (`yes` only) → `private_mode_detected` |

Electron GPU (#73) was first placed outside the trackers (a `GpuInfoCache` in `launchMain` filling `environment.hardware.gpu`); TR9 part 1 (#90) folded it into the Electron `ProcessTracker`, and `GpuInfoCache` no longer exists on `main`. Producer gating: the `app_state`, `screen_size`, `fps`, `main_thread_lag_ms` and `main_thread_idle_ms` producers are only built when a shared `lifecycle` tracker is in the env (`trace-producers.ts`).

**Node/Bun/Deno and Electron slices (all merged; implementations in `packages/trackers/src/node/` and `packages/trackers/src/electron/`, exported from `@bugsee/trackers/node` and `@bugsee/trackers/electron`, which are no longer placeholders):**

| Slice | PR | Tracker | Stages | Producer / traces / events |
|---|---|---|---|---|
| TR8 part 1 | #87 | `ProcessTracker` (`node/process-tracker.ts`; `processTrackerFor`, `resetProcessTracker`) | ten: `memory`, `systemMemory`, `cpu {userDelta, systemDelta, processPct}`, `eventLoop {meanMs, maxMs, p99Ms}`, `utilization`, `gc {count, pauseMs, maxPauseMs}`, `v8Heap`, `memoryLimit {bytes}`, `availableMemory {bytes}`, `uptime {seconds}` | ten producers in `packages/node/src/trace-producers.ts` (composition only), trace names and wire values unchanged |
| TR8 part 2 | #88 | `StorageTracker` (`node/storage-tracker.ts`; `storageTrackerFor`, `resetStorageTracker`) | one stage `disk {freeBytes, totalBytes}` | `DiskSpaceProducer` (`packages/node/src/disk-space-producer.ts`) → the opt-in `disk_mem_free` / `disk_mem_total`, unchanged |
| TR9 part 1 | #90 | `ElectronProcessTracker` (`electron/process-tracker.ts`) | `appMetrics`, `childProcessGone`, once-only GPU info (`requestGpuInfo()` + `current('gpu')`, mapped by `gpu-info.ts`) | `app_metrics` trace (`packages/electron/src/system-traces.ts`) `{processes: [{type, pid, cpu_percent?, working_set_mb?, peak_working_set_mb?, private_mb?}]}`; `child_process_gone` event; `hardware.gpu` behaviour of #73 kept |
| TR9 part 2 | #91 | `ElectronPowerTracker`, `ElectronDisplayTracker`, `ElectronApplicationTracker` (`electron/power-tracker.ts`, `display-tracker.ts`, `application-tracker.ts`) | Power `suspendResume`, `lockScreen`, `powerSource`; Display `displayAdded`, `displayRemoved`, `displayMetricsChanged`, `displays`; Application `windowFocus`, `windowVisibility`, `rendererResponsiveness` | events `power_suspend`/`power_resume`/`power_lock`/`power_unlock`/`power_ac`/`power_battery`, `display_added`/`display_removed`/`display_metrics_changed`, `window_focus`/`window_blur`/`window_show`/`window_hide`, `renderer_unresponsive`/`renderer_responsive`; trace `electron_displays {displays: [...]}` (held) |

**TR8 Node/Bun/Deno Process and Storage (#87, #88, merged).** The `ProcessTracker` replaced `@bugsee/node`'s per-signal `ProcessStatsTracker` (files and tests deleted; `@bugsee/node` no longer exports `ProcessStatsTracker`/`ProcessStats` and instead re-exports `processTrackerFor`/`resetProcessTracker`/`ProcessTracker`); the GC observer, guarded event-loop source and runtime readers moved into `packages/trackers/src/node/`. It is a registry singleton keyed on the `process` object (or `env.key`; tests that inject fakes need a private key or `resetProcessTracker()`), with per-stage activation (one shared unref'd timer while any stage has a listener) and "seams merge, never drop" rebinding. A stage whose runtime cannot answer emits nothing. The Bun/Deno honesty gates are tracker env flags (`measuresEventLoopDelay`, `measuresV8Heap`, `measuresAvailableMemory`, `measuresGc`) that `@bugsee/{bun,deno}/src/launch.ts` pass through `createNodeSystemTraceProducers`. **CPU has no start sample:** the tracker keeps an internal baseline, but the first `cpu` datapoint appears about one tick after start (an unusable core count omits the sample). The `StorageTracker` is keyed by the RESOLVED data dir (two launches over one directory share a tracker, different directories get different ones; a launch with no data dir gets an inert `process`-keyed tracker), polls `fs.promises.statfs` (default 5 s, unref'd) only while the `disk` stage has a listener, and keeps no reading across the last unsubscribe. The opt-in `disk_mem_*` traces are emitted with plain non-held `emit`, so a failing statfs does not leave a stale value re-recorded. Changesets: `.changeset/node-process-tracker.md`, `.changeset/node-storage-tracker.md`.

**TR9 Electron (#90, #91, merged).** `electron` is never imported: `app`, `powerMonitor`, `screen` and `BrowserWindow` are injected as structural sources (`launchMain` options `powerMonitor`, `screen`, `BrowserWindow`; window events can be switched off with `captureWindowEvents: false`, fail-closed on a non-boolean). Each tracker is a singleton keyed on its injected object and arms its Electron listeners only while a stage has a subscriber. `appMetrics` polls `app.getAppMetrics()` on one timer; arming makes a PRIMING read whose values are discarded, so `cpu_percent` exists only for a pid the previous read listed, and sizes are converted to MB. The GPU description is read once (`getGPUInfo`, default type `'basic'`, option `gpuInfoType`), kept after the last unsubscribe, and feeds `environment.hardware.gpu` as before. The events source is a lazy mux (`packages/electron/src/system-events.ts`) installed through the new `wrapSystemEventsSource` option of `@bugsee/node`'s launch (`packages/node/src/launch.ts`): nothing attaches until the one `events.system` provider subscribes, and everything is released on stop. The renderer hang pair is listened on `webContents` only, because a `BrowserWindow` re-emits it. `electron_displays` is a held trace (see open decision 1). Power events are platform dependent (`lock-screen`/`unlock-screen` never fire on Linux). Display `label`, bounds position and work area are not kept, and window titles and URLs are never read. Changesets: `.changeset/electron-process-tracker.md`, `.changeset/electron-power-display-app-trackers.md`.

**TR2 UI/Display (#82, merged).** Activation is PER STAGE: a listener/timer exists only while some subscriber wants a stage that needs it (window `resize`, `orientationchange` + `screen.orientation` `change`, `screen` `change`, one `matchMedia` query per scheme/motion/display-mode, and the rAF loop + interval + `visibilitychange` for `frameRate`), via `MultiKeyEmitterBase.listenerCount` and the `onListenersChanged` hook. Retention rule: only the env seams and the per-stage de-duplication baseline survive the last unsubscribe; the baseline is re-read silently when a stage goes from 0 to 1 listener and when a rebind swaps sources; `current(stage)` always reads live and is `undefined` when unavailable. Invalid values (non-finite or non-positive sizes, non-boolean queries) are omitted, never zeroed. Frame rate emits nothing while hidden or without rAF/`visibilitychange`; once frames have flowed, the first frameless window reports 0 and a continuing stall then goes quiet. An `orientation` event with nothing readable is emitted as a bare `{}`. The per-window tracker is shared by the traces and the events source. The browser package's `OrientationTracker`, `ScreenSizeTracker` and `FpsTracker` were deleted.

**TR5 Process (#83, merged).** Five independent stages, each armed only while it has a listener (an `onAny` listener counts for all); `start()`/`stop()` do nothing here. A stage that cannot work (no `performance.memory`, no `requestIdleCallback`, no clock/lifecycle, no `permissions.query`/`IdleDetector`/`AbortController`) stays inert until its listeners have all left and a new one arrives, or a rebind changes the seams. Non-finite or negative values are omitted, never zero. Stage semantics: `heap` polls `performance.memory` every tick (Chromium-only; `limit` is `jsHeapSizeLimit`); `mainThreadLag` is timer drift (`max(0, now - (previous tick + interval))`), measured only while the page is visible, with a fresh baseline on each visible start; `idle` is one `requestIdleCallback` probe per tick (`timeRemaining()` clamped to 50 ms; no sample when no idle period is granted); `userIdle` uses the Idle Detection API with a threshold floored at 60 s and starts the detector ONLY when `permissions.query({name: 'idle-detection'})` already reports `granted` (it never calls `requestPermission`; the permission `change` event is watched); `uptime` emits `performance.now()` each tick. `user_idle_state` is `locked` when `screenState` is `locked`, else `userState`, and the producer exists only for `captureUserIdle: true`. **Retention:** the last `userIdle` state is retained (`currentUserIdle()`; `currentUserIdleFresh()` seeds a held trace and is stricter: while armed it answers only once this run's detector has published, and with no armed stage only while younger than 2 thresholds); the heap is read live; uptime/idle/lag keep nothing; timers, lifecycle subscription, idle probe and detector do not survive. The reporter is wrapped so a throwing `onError` cannot escape.

**TR7 Environment (#84, merged).** `language` and `timezone` are change-only (the first reading is a silent baseline; `timezone` is re-read on a 60 s timer, skipped while hidden, and on visibility→visible). `hints` and `permissions` are read ONLY when the env flags `observeHints` / `queryPermissions` are set; both default to false and the browser launch does not set them and the events source sets both explicitly to `false` (`system-events.ts:248-249`, so a retained value on the shared tracker is not inherited), so no `permissions.query()` call or `change` listener is made and the two stages reach no trace or event. `permissions` never prompts: only `navigator.permissions.query()` is called and only the state string is kept; a name the browser does not know is omitted. `privateMode` runs when `detectPrivateMode` is set (false at the tracker level); the only method is `storage-quota` (below 120 MiB → `yes`, at or above 1 GiB → `no`, else `unknown`, so constrained storage can false-positive). **Retention:** the last language/time zone/hints/permissions/private-mode readings are retained and compared on restart (an unchanged `hints`/`permissions` snapshot is not re-emitted; a retained `yes`/`no` is not re-probed, an `unknown` is retried); DOM listeners, the timer and in-flight async work do not survive.

**Environment options and wiring (as built).**

- `captureEnvironmentHints` (`com.bugsee.option.capture.environment-hints`, `BugseeOption.CaptureEnvironmentHints`): defaults to `true` in the browser launch (`packages/browser/src/launch.ts`) and is FAIL-CLOSED: a non-boolean value is treated as off and reported. It gates only private-mode detection; `false` opts out. The protocol layer defines the key and type only, not a default. Private-mode detection therefore defaults ON in the browser launch. **Owner decision (2026-10-20): detection is OPT-OUT** (on by default, `captureEnvironmentHints: false` disables it). At the tracker level the `EnvironmentTracker` flag `detectPrivateMode` is unset-means-off (`environment-tracker.ts:689`); the browser launch passes `resolved.options.get(BugseeOption.CaptureEnvironmentHints, true)` (`launch.ts:954`) and the events source defaults it to `true` (`system-events.ts:247`).
- `language_changed` and `timezone_changed` are always observed (not gated by that option) in the Browser, and in the WebView whenever it has a window.
- The WebView launch (`packages/webview/src/launch.ts`) passes `detectPrivateMode: false` explicitly (so it never inherits ON from an earlier launch on the same window) and so never emits `private_mode_detected`.
- `private_mode_detected` (`{method}`) is emitted only for a `yes` answer, never for `no`/`unknown`. It is a per-session event while the tracker outlives sessions and does not re-probe a retained answer, so the events source re-delivers a retained `yes` once on subscribe (unless the activation already delivered it). The opt-out is enforced at the sink as well: a source built with detection off never forwards `private_mode_detected`, even if another consumer enabled detection on the shared tracker.
- `captureUserIdle` is OPT-IN, default `false` (only boolean `true` enables it; an invalid value stays off and is reported), same switch in Browser and WebView. Even when on, `user_idle_state` exists only if the page's `idle-detection` permission is already granted. **Decision status:** opt-in is the implementer's decision (2026-10-21, PENDING owner confirmation); the reasoning is that the trace reuses a permission the page itself obtained and the SDK never prompts.
- Changesets: `.changeset/browser-ui-tracker.md`, `browser-process-tracker.md`, `browser-environment-tracker.md`.

**Conventions the merged trackers follow (the "hardening pattern"; uneven in places, gaps listed):**
- Host reads go through `hostRead` in most places (hostile getters cost only their own field and are reported via `onError`), and an unusable field is OMITTED rather than sent as 0
  (non-finite, negative, or a documented "no estimate" such as a zero `rtt`). **Known gaps (verified in code):** `PowerTracker.#publish` reads `manager.level` and `manager.charging`
  directly (`power-tracker.ts:177-178`) — `level` is range/type-checked and omitted when unusable, but `charging` is not type-checked; only the two time fields go through `hostRead`.
  `ApplicationTracker.#listen` reads `target.addEventListener` unguarded (`application-tracker.ts:184-185`), relying on the surrounding `onActivate` try/catch.
- Reporter handling differs per tracker. Connectivity, Power, Storage, UI, Process and Environment hold the reporter in a mutable `#report.fn` / `#reporter.fn` indirection (latest launch wins); Application uses an equivalent `sink.current`.
  Application, Connectivity, UI, Process and Environment wrap the reporter in try/catch so a throwing `onError` cannot escape into a DOM dispatch or timer. **Known gap:** Power's reporter (`power-tracker.ts:67`, `:89-91`) and
  Storage's emitter reporter (`storage-tracker.ts:102`) are not wrapped, so a throwing `onError` on those paths is not contained, and no test is claimed for it. DOM listeners and timer
  callbacks are guarded in the trackers that attach them.
- Async reads carry a token (`PowerTracker` generation, `StorageTracker` epoch) so a promise settling after the last unsubscribe/reset is inert.
- Each tracker states and tests a retention rule: Application retains the last `state`; Power the resolved `BatteryManager` + last snapshot; Storage the last estimate
  (`current()`; `currentFresh()` only while younger than 2x the poll interval); Connectivity caches nothing (reads `navigator` live); UI keeps only its de-duplication baselines; Process the last user-idle state; Environment the last language/time zone/hints/permissions/private-mode readings (details in the TR2/TR5/TR7 notes above). DOM listeners/timers are always released.
- **Rebind rule** (§15.1 #7, as built): `for(key, create, rebind)` calls `rebind` on every request after the creating one, including a caller whose `create` lost a
  re-entrant race; a throwing `rebind` never fails the request. Semantics are "latest launch wins" for `onError` (a defined one replaces, undefined keeps) and for
  defined seams (an undefined seam never clobbers). Application re-binds window/document only while IDLE and reports a mismatch once while ACTIVE; Storage applies
  new seams from the NEXT activation; UI, Process and Environment re-attach a running tracker to changed seams (each only when a seam actually changed; UiTracker swaps its function seams `matchMedia`/`requestAnimationFrame`/`cancelAnimationFrame`/`now` in place, so a running media-query listener stays on the old `MediaQueryList`); Connectivity moves a running tracker's listeners to a changed window/navigator. Keys: Application = document, else window, else a
  module key; Power/Connectivity/Storage/Environment = window, else navigator, else the env object; UI = window, else screen, else the env object; Process = window, else performance, else the env object.

**Open decisions (carried from the code and `docs/PROGRESS.md`):**
1. **Held values cannot be retracted.** The provider re-records every held (`emitIfChanged`) value each `refreshMs`. `storage_estimate` is held (the 5 min poll exceeds the default
   60 s window), so after failed polls the last known estimate keeps being re-recorded; the `battery_*_time_s` traces avoid this by using plain non-held `emit` with a
   producer-side change-only guard, at the cost that an unchanged time ages out of the rolling window. Options: plain `emit` for storage, or a provider retract/release/end-marker mechanism.
   Still true for `user_idle_state` (verified: `UserIdleProducer` uses `emitIfChanged`): the tracker drops its retained state when a running stage finds the permission not granted and
   `currentUserIdleFresh()` stops seeding new subscribers from it, but it emits nothing on revoke, so a producer that already published the last value keeps it re-recorded until the producer stops.
2. **`main_thread_lag_ms` false spikes on suspend/pause (verified still unhandled).** The lag stage is torn down on hidden and takes a fresh baseline on each visible start, but there is no cap and no
   `resume`/`pageshow` reset: `lagMs = max(0, now - expectedAt)` is emitted for every tick. If the page stays `visible` across a system sleep or a debugger pause and `performance.now` advances, the first tick
   after it can record minutes or hours of "lag". Proposed follow-up: omit a tick whose elapsed time exceeds a documented multiple of the interval, reset the baseline on `resume`/`pageshow`, and test with a fake clock that jumps an hour.
3. **Electron GPU `'complete'` vs `'basic'`.** `launchMain({gpuInfoType})` still defaults to `'basic'` (the default is `requestGpuInfo(type = 'basic')`, `packages/trackers/src/electron/process-tracker.ts:282`; still `'basic'` on `main` at `769cbbe9`). The smoke run (below) measured that `'basic'` yields no vendor/renderer on macOS (`hardware.gpu` absent, never guessed) while `'complete'` yields vendor, renderer, `glVersion` and a ~3 KB `glExtensions` (under the 8192 cap, `packages/node/src/environment.ts:81`). Recommendation: default to `'complete'`. Owner decision, not yet taken.
   Both mappings are verified on macOS (above). Still unverified: the Linux/Windows `'basic'` output (where `'basic'` may yield only numeric ids, so `hardware.gpu` is then absent, never guessed).
4. **`captureEnvironmentHints` name.** As built it gates only private-mode detection (now an owner-decided opt-out, see below); `language_changed`/`timezone_changed` are not gated and `hints`/`permissions` are not read by the launch at all. Its name now overstates its scope.
   Undecided: rename it, or widen it to gate the `hints`/`permissions` stages if a consumer for them is added (those stages are already off by default via the `observeHints`/`queryPermissions` tracker flags).
5. **Privacy scope (private-mode default DECIDED).** The owner decided on 2026-10-20 that private-mode detection is opt-out (see the environment options above), so that part is closed.
   Still undecided: whether DNT/GPC, automation and permission states (`hints`/`permissions`, currently unread) belong in the §1 privacy non-goals before any consumer reads them.
6. **`user_idle_state` opt-in pending confirmation.** `captureUserIdle` defaults to `false` (implementer's decision, 2026-10-21); the owner has not yet confirmed it.
7. **Electron held value and unverified shapes.** (`electron_displays` was retired by #102, now `displays`; see §15.6. The held-value concern applies to `displays` all the same.) `electron_displays` was held like `storage_estimate` (decision 1): a failed `getAllDisplays()` refresh leaves the last list re-recorded. The Electron shape facts still unverified (`powerMonitor` events per OS, `display-metrics-changed` argument order) are listed in the "NOT verified" bullet of the smoke-run section below and are read from Electron's documentation and typings only.
8. **Private-mode heuristic is blind in current Chrome incognito (smoke run).** The only method is `storage-quota` with `PRIVATE_QUOTA_BELOW_BYTES` = 120 MiB (`environment-tracker.ts:147`); incognito now reports a quota of about 10 GiB, so `private_mode_detected` never fires there. Owner decision: add a second signal, or report `unknown` honestly.
9. **Renderer-origin duplicates in Electron (smoke run; the traces part is addressed by #132 and #133, see §15.6; `process_started` duplication and the missing runtime versions are not re-checked).** Every renderer streams its own `process_started` and same-named traces (`ram_js_heap_used` zigzags between processes; `app_state`, `screen_size`, `battery`, `connection` repeat per window), and `environment.runtime` lacks the Electron and Chrome versions. Needs a decision on which process owns which trace.
10. **`main_thread_lag_ms` is timer drift** (a 1.6 s block read 616 ms in the smoke run): a documented limit of the method, not a defect (see decision 2 for the separate suspend spike).
11. **Held traces at the slow tick show duplicates (smoke run):** a viewer-side dedupe check is needed (relates to decision 1).
12. **A renderer that rejoins after a crash does not receive the paused state** (smoke run, Electron control channel). Open.

#### Real-Electron + browser/server smoke run (2026-10-21)

Run on Electron 44.9.3, macOS arm64, plus a real browser and a node server; findings below are from that run and were fixed in #95 and #96 where noted. (The Electron and browser measurements themselves cannot be re-derived from the repo; the fixes and the code that encodes them were checked on `main` at `ae65d762`.)

- **VERIFIED on Electron:** `app.getAppMetrics()` memory is in KiB; the first call per process reports `percentCPUUsage` 0 with `cumulativeCPUUsage` present (so the priming read is correct); the cpu figure is a whole-machine share; `child-process-gone` details are `{type, reason, exitCode, serviceName?, name?}`; a renderer hang is recorded once when listened on `webContents`; the `getAllDisplays()` shape; `getGPUInfo('basic')` gives no vendor/renderer on macOS (`hardware.gpu` absent) while `'complete'` gives vendor, renderer, `glVersion` and a ~3 KB `glExtensions` under the 8192 cap.
- **NOT verified (screen was locked or the signal cannot be produced on demand):** OS-delivered window focus/blur/show/hide; a real `display-metrics-changed` (and its argument order); real power events (`powerMonitor` events per OS); the native `crashReporter`; real Chrome `display-mode`, `freeze`/`resume`; battery charging/discharging times; `downlinkMax`.
- **Defects found and FIXED:** #95 (Electron): a `render-process-gone` listener leak, sends to crashed renderers, display refresh-rate rounding (`display-tracker.ts` `round2`), a listener leak on destroyed objects, and `serviceName` missing from the child-process-gone mapping (`process-tracker.ts:202-211`). #96: `connection` with the browser offline now omits the link fields while keeping `save_data` and dropping `effective_type` (`packages/browser/src/trace-producers.ts:214-232`), a duplicate foreground event, and sample drift with an `await launch` in the samples.
- **Still OPEN:** decisions 3 and 8-12 above (Electron GPU default, private-mode blindness, renderer-origin duplicates, lag as timer drift, held-trace duplicates, crashed-renderer rejoin).
- **Staging validation state:** the smoke reports are in the staging apps SNODE and SBROWSER (labels `tracker-smoke/...`), awaiting the owner's validation in the viewer (Q5). Nothing here has been confirmed by the viewer yet.

**Still not verified:** the items under "NOT verified" above, and the viewer-side rendering of every new trace.

**Remaining plan:**

- **Cleanup DONE (#93, merged):** the `video.aux` viewport source reads the `UiTracker` (`packages/browser/src/viewport-source.ts` via `uiTrackerFor`, new `visualViewport` stage defaulting to `window.visualViewport`, `ui-tracker.ts:404-409`); `ApplicationTracker`'s `online`/`offline` stages are removed (`application-tracker.ts` has none) and the events source uses the `ConnectivityTracker` `transition` stage (`connectivity-tracker.ts:52,174-181`, `system-events.ts:218-225`); `display_mode_changed` is derived from `UiTracker.displayMode` (`system-events.ts:197-210`). No producer reads `reducedMotion` or the Process `uptime` stage yet.
- Node/Bun/Deno and Electron follow-ups only where the code shows gaps (none are recorded yet beyond the open decisions above).
- The first real-Electron smoke run is DONE (above); repeat it on an unlocked screen for the focus/blur/show/hide, display-metrics, power and `crashReporter` cases, and on Windows/Linux.
- Viewer confirmation (Q5) of the `app_metrics`, `displays` (was `electron_displays`), `storage_estimate` and `user_idle_state` shapes.
- Close the browser hardening gaps and the open decisions above (Electron GPU default, private-mode second signal, renderer-origin duplicates, held-value retraction, `main_thread_lag_ms` suspend spikes, Electron GPU `'complete'` vs `'basic'`, the `captureEnvironmentHints` name and privacy scope, `captureUserIdle` confirmation).
- Mark this design PR (#53) ready and merge it (its ready/draft state is managed outside this doc).

### 15.6 As-built delta since `ae65d762` (verified against `main` at `769cbbe9`, 2026-10-28)

The spec reference is the JavaScript platform spec (`bugsee/specs` `sdk/reporting/platforms/javascript.md`, specs PR #62); the work items are its change list C1-C27. Each line below was checked against the PR description and the code on `main`.

**Names and shapes (renames and retirements):**

| PR | Change |
|---|---|
| #97 (C2) | Shared `events.system` names follow Android: `OrientationChanged {current, prev?, type, angle}` (bare when type/angle unreadable; emitted only when the Android orientation int changes), `DarkModeChanged {dark}`, the two process foreground/background events became `UIApplicationDidBecomeActiveNotification` / `UIApplicationDidEnterBackgroundNotification`. JS-only events stay snake_case; params are camelCase everywhere. |
| #98 (C1, C8, C9, C10) | `charging` and `battery` omitted when the level is unreadable; dead angle-only orientation branch removed; browser `ram_js_heap_free = max(limit - used, 0)`; Node-family `event_loop_lag_*` fields omitted per non-finite field, `cpu_usage_process` omitted on a zero wall window. |
| #99, #105 (C6) | `ram_system_free` = memory available to new work, bytes. `ram_system_available` and its `availableMemory` stage retired. Sources in order: Electron `getSystemMemoryInfo()`, Deno `systemMemoryInfo().available` (macOS), Bun `/proc/meminfo`, `os.freemem()` (not on macOS). #105 fills macOS Node/Bun (and the Deno fallback) from a rare, rate-limited async `/usr/bin/vm_stat` read (`packages/trackers/src/node/vm-stat.ts`; `readsVmStat: false` opts out; Electron never spawns it). |
| #100 (C15, C16) | `event_loop_utilization` is percent 0-100, one decimal. `gc_count`/`gc_pause_ms`/`gc_pause_max_ms` traces retired; GC is the `gc` event `{count, pauseMs, maxPauseMs}`, one per 1 s interval with a collection, Node and Electron main only (Bun/Deno keep `measuresGc: false`). |
| #101 (C14) | `process_uptime_s` trace and the node `uptime` stage retired; `app.uptime_s` (whole seconds at launch) goes in the environment for node/Bun/Deno/Electron main and the browser. Recovered incidents omit it on purpose. |
| #102, #106 (C3-C5, C26, C27) | `screen_size` and `electron_displays` retired, replaced by `displays` (mobile layout, snake_case keys, device pixels). Browser: one entry `{id: 0, state: "on", width, height, scale, rotation?}`, with `zoom`/`deviceScale` from the UiTracker `screenSize` stage (#106). Electron main: one entry per display, id 0 = the key window's display, others ascending by `native_id`. `display_*` event params are camelCase with the same keys. WebViews and Electron renderers do not write it (`hostOwnedTraces`). |
| #125 (C13) | `ElectronPowerTracker` gains `thermalState` and `speedLimit` stages; `@bugsee/electron` writes `thermal_state` and `cpu_speed_limit` when `powerMonitor` is injected (sampled, not held; no initial `cpu_speed_limit`; `unknown` thermal writes nothing). `thermal_state` is the iOS int form (`nominal` 0 ... `critical` 3), kept in one table, `packages/electron/src/thermal-state-wire.ts`, because iOS (int) and Android (string) disagree (bugsee-cocoa#288, open owner question). No Electron low-power-mode API exists, so nothing is added for it. |
| #108 (C11, C21, C25) | New `url` trace (browser, WebView, Electron renderers): the sanitized `location.href`, held, written at start and on each navigation. Options `captureUrl` (default on; invalid value turns it off and is reported) and `urlSanitizer`. New `sanitizeLocationUrl` in `@bugsee/protocol`; navigation breadcrumbs and URL-detected transaction names are sanitized. |
| #134 (C12) | New `route` (string) and best-effort `view` (`{name, type?}` or `"$$none"`) held traces, public `client.setRoute` / `client.setView`. `ScreenTracker` (`@bugsee/trackers` root entry, values pushed in, change-only) plus `ScreenProducer` (`@bugsee/capture`), wired in the browser and WebView launches; Node/edge hold the value and write nothing. A WebView writes `route` but not `view`. `@bugsee/web-adapter` `setRouteName` also feeds `setRoute`; React/Vue/Solid/Angular/SvelteKit write `route`, and `setViewName` writes `view` only for an obtainable, non-wrapper name. Route/view sanitizing lives in `packages/protocol/src/screen-names.ts`. |

**Capture and storage:**
- **#107 (C7):** `capture` trace (`active` / `blackout` / `low_disk_space` / `no_disk_space`; disk outranks blackout), written by the browser while rrweb replay runs and by Electron main with pixel video only (`CaptureStateProducer`, `packages/capture/src/capture-state-producer.ts`). `DiskPressure` in core (low below 50 MB free, none below 10 MB, +10 MB hysteresis) gates the durable store backends: under low, replay/video/log/network use an in-memory shadow merged at snapshot time; under none nothing is persisted. Feeds are the shared `StorageTracker` (node-family, Electron main) and `quota - usage` (browser). Opt-in via `captureDiskSpace` (`com.bugsee.option.capture.disk-space`, replaces the node-only key). Only unit/integration-tested; real low-disk behaviour is unverified.

**Cross-cutting guards and multi-writer rules:**
- **#131 (C17, C24):** one wire-name registry in `@bugsee/protocol` `system-names.ts` (`TraceName` / `EventName` string enums, `TRACE_SPEC`, `EVENT_PARAMS`); `TraceProducerBase.emit`/`emitIfChanged` take a `TraceName`, so an unregistered literal does not compile. Vendored spec snapshot `packages/protocol/spec/javascript-system-traces.snapshot.json`, `pnpm spec:refresh` / `pnpm spec:check`, and a drift test in `@bugsee/instrumentation-tests` that also fails on a registered name spelled as a literal in a producer. Pending-in-spec names (`route`, `view` at the time) were left out; #134 then added them to the enum, while the file's header comment still lists them as absent.
- **#132 (C22):** a trace name has one writer per session. `@bugsee/capture` `trace-suppression.ts` provides a live layered suppression set; `createSystemTracesProvider({ suppression })` drops suppressed names (a held value is remembered and re-recorded on release). `hostOwnedTraces` takes an array or a live set. WebView table `WEBVIEW_HOST_OWNED_TRACES`; a control message may replace it via `config.hostOwnedTraces`. Electron: the `session` reply carries `ho`, the names main actually writes (`displays`, `capture`, `ram_js_heap_*`), tables in `packages/electron/src/trace-tables.ts`.
- **#133 (C26):** one key window per session (focused, else most recently focused, else first created = lowest window `id`). `ElectronApplicationTracker` gains `keyWindowId()`, `windowIds()` and a `keyWindow` stage; `session` replies carry `kw`, `window-key` is sent to renderers whose answer moved; a non-key renderer suppresses `ELECTRON_PER_WINDOW_TRACES` (`url`, `route`, `view`, `orientation`, `app_state`, `fps`, `storage_estimate`, `main_thread_*`, `user_idle_state`) and the held `url` is re-recorded on becoming key. Without `app` and `BrowserWindow.fromWebContents` every renderer stays key (fail open).

**Not trace work, same window:** #122 fixes a HIGH privacy bug (#118): a blocked same-origin iframe was recorded anyway in rrweb. The fix lives in the `bugsee/rrweb` fork on new branches (tip `bugsee-port-2.2.0-iframe-block`, not merged into `bugsee-port`), and iframes now yield placeholders only. Masking gaps on re-observed observers (#119) remain open. #117 moved the fork onto upstream rrweb 2.2.0.

**Open decisions after this delta:** 1, 2, 3, 4-8, 10-12 are unchanged (decision 2 re-checked: no `resume`/`pageshow` reset in `packages/trackers/src/browser/process-tracker.ts`; decision 3 default still `'basic'`). New: the `thermal_state` value form (int vs string, above); whether `displays` held-value retraction (decision 1) needs the same answer as `storage_estimate`.
