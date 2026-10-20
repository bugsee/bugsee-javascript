# System traces expansion — competitor gap + mobile-parity port plan — DESIGNED, FROZEN (not built)

**Status:** DESIGNED 2026-10-14; **FROZEN 2026-10-14 after review round 9** (PR #53); **§14 (2026-10-14) adopts the mobile tracker/producer structure and supersedes the lifecycle-seam mechanism in §5/§9/§12.** No further prose rewrites: remaining
edge cases are tracked as the pre-implementation checklist in §12 and are resolved test-first in the owning slice. Nothing here is implemented. Built from five read-only research passes
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

## 2. Current catalog (as built)

| Tier | Traces | Events |
|---|---|---|
| Browser (`browser/src/system-metrics.ts`, `system-events.ts`) | `ram_js_heap_{total,free,used}` (Chromium `performance.memory`), `ram_system_advertised`, `connection`, `orientation`, `battery`, `charging` | `process_started`, `process_exiting`, `process_foreground`, `process_background`, `online`, `offline`, `orientation_changed` |
| Node/Bun/Deno (`node/src/system-metrics.ts`, `system-events.ts`) | `process_memory_{rss,heap_total,heap_used,external,array_buffers}`, `ram_system_{total,free}`, `cpu_usage_{user,system,process}`, `event_loop_lag_{ms,max_ms,p99_ms}`, `event_loop_utilization` | `process_started`, `process_exiting`, `process_before_exit`, `process_warning`, `process_signal` |
| Electron | composes the two above; **no Electron-specific telemetry** (only `crashReporter` + `render-process-gone` for incident synthesis) | — |

Sampler: one provider, snapshot at start then every 1000 ms (`capture/src/system-traces-provider.ts`). No
event-driven emission today. Registered only by node/browser/webview launches (bun/deno reuse node's).

## 3. Findings that drive the design

**Competitors.** Server-side the common set (RSS/heap/CPU/system RAM/event-loop delay+ELU) we already match.
The most-shared gaps: **GC stats** (Datadog, OTel, Splunk, New Relic, AppDynamics), **V8 heap statistics**
(Datadog, AppSignal), **per-space heap** (Datadog, OTel), **active handles/requests** (Elastic, OTel),
**Lambda context** (Sentry, Datadog). Browser-side: **long tasks / LoAF**, **web vitals**, **navigation/resource
timing**, **FPS** (Highlight, OpenReplay), **page visibility**, **viewport**. Electron: Sentry collects
per-process memory (`app.getAppMetrics`), GPU, screen, `child-process-gone`, `powerMonitor`/window/`app`
breadcrumbs. **No competitor reads the Battery API**; no vendor Node SDK implements cgroup limits (OTel
specifies them).

**Mobile.** Android has ~28 trace producers + 7 event producers; iOS 24 + ~8. Portable and truthful subset is
small (§4). Many Android/iOS traces have **no JS API** and are explicitly not ported.

**Wire-shape clashes (must resolve before reuse).**
1. `charging`: Android `{state, source}` map; iOS 4-state int; JS boolean (shipped in 0.1.0-beta.3). **Decision needed before any change (ST0):** the Battery API has no `source`, and changing a shipped wire shape is breaking. Options: (a) keep the boolean under its current name and stop calling it a bug; (b) emit Android `{state}` with `source` OMITTED (never invented) and `state` mapped via a table written here (`charging`/`full`/`unplugged`, verified against Android `TracePowerStatus` and the viewer); (c) keep the boolean and accept the viewer gap. **Recommendation: (a)/(c) — do not touch the shipped boolean until Q5 shows what the viewer does with it.**
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
| `app_state` (step trace) | `document.visibilityState` mapped to the Android vocabulary (`foreground`/`background`, per Android `TraceAppState`) | NEVER put raw `visible`/`hidden`/`prerender` on `traces.system`. Verify the exact Android value set and the viewer table (Q5) first; `process_foreground`/`process_background` events already exist, so this trace is optional until the viewer needs the step curve. |
| `screen_size` (JS-specific; **not** `displays`) | `screen.width/height`, `devicePixelRatio` on `resize` | Android `displays` is a display LIST (id, density, flags, bounds), not two CSS-pixel numbers, so the browser `Screen` must not reuse the name. Static values already ship as `hardware.screen_width/screen_height/pixel_ratio` (`browser/src/environment.ts:116-118`); add this only if resize-over-time is wanted, with an explicit value shape `{width, height, dpr}` and Q5 viewer confirmation. Otherwise stay environment-only. |
| `cpu_pressure` (**not** `thermal_state`) | Compute Pressure `PressureObserver.observe('cpu')` | Chromium-only, experimental, permissions-policy gated. It is CPU CONTENTION (incl. other tabs) with states `nominal/fair/serious/critical`, not Android's 0–6 temperature/throttling enum — so it gets a JS-specific name and the API's own state strings. Map to `thermal_state` only if `PressureObserver.knownSources` includes `thermals` AND the value is converted to Android's int enum. Feature-detect the SOURCE, not just the constructor. Off by default. |
| `dark_mode_changed` event — **`matchMedia` is a method on `Window` returning a `MediaQueryList` you listen on, not a window event, and it is not on `WindowEvents` (`detection-providers.ts:21-24`, shared with detection — do NOT widen it): extend `BrowserSystemEventsEnv` with `matchMedia`; in `onActivate` skip when absent, listen on the returned list, remove in `onDeactivate`, per-attach try/catch (an unguarded throw aborts `captureCoordinator.start()` and with it input/viewtree, which register after events). Tests: fake without `matchMedia` → input still starts, no event; with it → `change` records `dark_mode_changed`.** On `createBrowserSystemEventsSource` (`system-events.ts`), gated by `captureSystemEvents`, torn down in `onDeactivate`; **never on the traces sampler** | `matchMedia('(prefers-color-scheme: dark)')` change | Existing JS `events.system` names are snake_case; use `dark_mode_changed` unless Q5 shows the viewer keys Android's `DarkModeChanged`. |
| `freeze` / `resume` events — same: `createBrowserSystemEventsSource`, `captureSystemEvents` | Page Lifecycle. **Attach on `this.#document`, like `visibilitychange` (`system-events.ts:68-74`) — they fire on Document and do NOT bubble, so a `window` listener beside `pagehide` never runs;** skip when `document` is absent, tear down in `onDeactivate`. Tests: `doc.emit('freeze')` records, `win.emit('freeze')` does not. | Complements `process_background`. The traces provider can only write `traces.system` (`system-traces-provider.ts:69-73`); the two options are independent (`captureSystemTraces:false, captureSystemEvents:true` must still record these). |
| Event-driven `battery`/`charging` | `levelchange`, `chargingchange` | May replace 1 s polling for these two. |
| `connection` — **keep polling (or add events) but never drop the `onLine`-first mapper** | `window` `online`/`offline` **and** `connection.change`, mapped through `system-trace-values.ts` (`navigator.onLine` outranks `connection.type`) | `connection.change` does NOT fire on `offline` (a Chromium NetworkInformation can still say `wifi` while offline), so replacing the 1 s read with `change` alone leaves the trace stuck on `wifi` after the network drops while `events.system` `offline` fires — the streams disagree. Do not remove polling until the online/offline + change pair is specified and tested. |
| `hardware_concurrency` (context, not trace) | `navigator.hardwareConcurrency` | Sentry; static → belongs in environment, not a trace. |
| Main-thread responsiveness | **Timer drift**, not a `MessageChannel` ping: on each 1 s sampling tick, `lag = max(0, now() − (previousTick + interval))` from the injected `performance.now`. | Name `main_thread_lag_ms`. **Measure only while `document.visibilityState === 'visible'`; omit (never zero) when hidden** — background tabs clamp/throttle timers to ~1 s then ~1 min, so a hidden-tab measurement would paint a hang that did not happen (the inverse of the Deno `event_loop_lag` lie); fresh baseline on every visible start (a hidden stretch is never lag). **Measured in real Chromium (2026-10): the per-tick MessageChannel ping scheme reports ~0.1 ms for most real freezes** (a block that begins after the ping returned has nothing in flight to delay; the 'in-flight age' branch never fires because the tick timer shares the blocked thread), and re-posting on every receipt is a continuous task loop (~2.2M receipts/s, a pinned core) — both are plausible-healthy lies. Timer drift cannot miss a block: the overdue tick fires late by the block's length. A measured ~0 is a true measurement and is emitted. Honest limit: it measures how late the sampling timer fires, so browser timer throttling while the page is visible-but-occluded also shows as lag. |

### P3 — Electron main-process telemetry (`@bugsee/electron`)
There is NO Electron sampler today: `launchMain` (`electron/src/launch-main.ts:110`) forwards `nodeOptions` to `@bugsee/node` `launchCore` with no `systemMetricsSampler`, so Electron main already emits the full node catalog. ST6 must therefore **extend, not replace** — and under §14 that is producers, not a wrapped sampler. `systemTraceProducers` (`node/src/launch.ts`) REPLACES the node defaults when supplied (the bun/deno launches already build their own list), so `launchMain` passes `[...createNodeSystemTraceProducers(...), ...electronProducers]`: the node producers keep `process_memory_*`/`cpu_*`/`event_loop_*` on the process that owns the session, and the Electron producers (`app_metrics`, …) are ADDED, never a second copy of anything the node set emits. There is no `LifecycleSampler` to wrap (it is deleted); each Electron producer is a tracker subscriber whose `onStart`/`onStop` attach and release the Electron listeners, with a per-reader try/catch-omit (`getAppMetrics` too, not only `getGPUInfo`) so one throw cannot drop another producer's values. `electron`/`powerMonitor`/`screen`/`BrowserWindow` are injected into those producers (they are not in `LaunchMainOptions` today and must be added there), never into `@bugsee/node`, where `getAppMetrics` would throw on non-Electron Node. **Events cannot ride the traces producers**: the table below mixes traces (`app_metrics`, `displays`) and events (`child_process_gone`, `power_*`, window focus/blur). A second `events.system` provider is rejected (`capture-coordinator.ts:53-55`, unique `provider.name`), and `launch.ts:870` always builds `createNodeSystemEventsSource(proc)` with no extra-source seam — so ST6 adds a node option (or an Electron-only extra source passed through) that wraps/muxes the node events source. **The mux attaches lazily**: it is an `EventSubscribable`/`InterceptorBase` whose `on()`/`onActivate` attaches BOTH the inner `.on('event')` AND the Electron `app`/`powerMonitor`/`screen`/`BrowserWindow` listeners, and `onDeactivate` removes them. Subscribing to `inner` or Electron in the wrap factory (at `launchMain`) would, with `captureSystemEvents:false`, still activate the node source's SIGTERM/SIGINT/`exit`/`beforeExit`/`warning` handlers (`system-events.ts:75-82`; they suppress default termination until `releaseSignalToDefault`) and keep `child-process-gone`/power listeners with nowhere to go, surviving `client.stop()`. The mux must not emit a second `process_started` (inner already does). Tests: option off → no SIGTERM handler, no `child-process-gone` listener; option on → both; `client.stop()` → released. `ElectronAppLike` is only `on('render-process-gone')` (`launch-main.ts:17-26`); `powerMonitor`/`screen`/`BrowserWindow` are added to `LaunchMainOptions` and destructured out of `...nodeOptions` as `app` already is (`launch-main.ts:76-77`). Tests: node + Electron traces both present (no name emitted twice); `getAppMetrics` throw → node traces still emit; `child_process_gone` lands on `events.system`; the node producers (event-loop histogram included) still start.
| Item | Source |
|---|---|
| Per-process CPU+memory (`app_metrics`: type, pid, cpu %, workingSet) | `app.getAppMetrics()` |
| `child_process_gone` event (type, reason, exitCode) | `app.on('child-process-gone')` — beyond the existing `render-process-gone` incident path |
| `power_suspend/resume`, `power_lock/unlock`, `power_ac/battery` events | `powerMonitor` |
| `displays` as an Android-shaped display LIST (id, size, scale, state), + add/remove/metrics-change events | `screen.getAllDisplays()` — use the name `displays` ONLY once that list shape is specified/confirmed against the viewer (Q5); else a JS-specific name |
| GPU info (context, NOT a `sample()` reader) | `app.getGPUInfo('basic')` returns a **Promise** — try/catch catches nothing, and `#emit` iterates `sample()` synchronously. Kick it once from `start()`, cache the resolved object, `sample()`/context reads the cache and omits until settled; attach `.catch(() => omit)` (a Linux-without-acceleration rejection is an `unhandledRejection` on the session owner, which Bugsee's own detection would report). Tests: rejected `getGPUInfo` → launch succeeds, no `unhandledrejection`, node traces still emit, no GPU entry |
| Window focus/blur/show/hide events; `unresponsive`/`responsive` | `BrowserWindow` for focus/blur/show/hide; **`unresponsive`/`responsive` are listened for on `webContents` ONLY.** Electron documents the pair on BOTH `BrowserWindow` and `webContents` — `BrowserWindow` re-emits the `webContents` event (after ~50 ms when the window is enabled and not destroyed) — so attaching both would record every hang twice. `webContents` is the single source because it also covers renderers with no `BrowserWindow` (a `BrowserView`, a `<webview>`). In the mux `onActivate` attach to `BrowserWindow.getAllWindows()` AND `app.on('browser-window-created')` (apps typically call `launchMain` then `createWindow()` from `whenReady()`, so the list is empty at activation) for the focus/blur/show/hide window events, and to `webContents` via `app.on('web-contents-created')` for the hang pair; remove all in `onDeactivate`. Expand `ElectronAppLike` beyond `render-process-gone`. Tests: a window created AFTER `launchMain` still records focus; `webContents.emit('unresponsive')` records ONCE even when the owning window re-emits it (the window pair is deliberately not listened to), and `win.emit('unresponsive')` alone does not record |

### P4 — Serverless / edge context
| Item | Source |
|---|---|
| Lambda: remaining time, memory limit, request id, cold-start flag, timeout-warning event | Lambda `context` | Sentry/Datadog. Context fields, not polled traces. |
| Cloud provider/region from env | `process.env` (`VERCEL`, `AWS_REGION`, `FLY_REGION`, …) | Check whether the environment builder already does this (Q4). |
| Cloudflare/Vercel CPU/memory | **Platform-side only** — SDK cannot read them; do not fake. |

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
  New deps (default ON for Node): `measuresGc`, `measuresV8Heap`, `measuresAvailableMemory`,
  `measuresConstrainedMemory`, `measuresActiveResources`. For `sample()` readers, each `false` must INJECT AN OMITTED READER (the way
  `measuresEventLoopDelay: false` injects `eventLoop: unavailableLoop`) or a `NodeSystemMetricsDeps` field the node
  sampler branches on — a boolean that is merely destructured does nothing. **Standing sources are different:** `measuresGc: false` must make `start()` NOT call `PerformanceObserver.observe` at all (a no-op GC lifecycle, analogous to never constructing the histogram) — omitting `gc_*` from `sample()` while still forwarding `inner.start()` leaves an observer registered for the process lifetime on every Bun/Deno session. Every attach in `start()` is per-attach try/catch-omit, so a throwing `observe({entryTypes:['gc']})` cannot abort `captureCoordinator.start()` (and block `process_started`) — the same isolation required of `sample()`. Tests: bun-shaped fake → no `observe` call; `observe` throws → launch succeeds, `process_started` still emits, `gc_*` absent. Values: `@bugsee/bun` all five
  `false`; `@bugsee/deno` `measuresGc`/`measuresAvailableMemory`/`measuresConstrainedMemory`/
  `measuresActiveResources` `false` (blind, incomparable, unprobed on Linux, always 0), `measuresV8Heap: true`
  (measured real). Bun's `constrainedMemory` of 68.7 GB passes any numeric sanity filter, so the sentinel check
  is not a gate. Tests: pin the factory call per runtime
  (`toHaveBeenCalledWith(expect.objectContaining({ measuresV8Heap: false, … }))`, as lag is pinned in
  `deno/src/launch.test.ts`), AND run the sampler under a Bun/Deno-shaped fake asserting the traces are ABSENT.
- **Browser sampler env.** The visibility-gated standing sources (`fps` rAF, `app_state`, the lag ping) need `document.visibilityState` and `requestAnimationFrame`, but `BrowserTracesEnv` has only `performance`/`navigator`/`screen` (`browser/src/system-metrics.ts:44-58`) and both roots build the sampler with NO env (`browser/launch.ts:798`, `webview/launch.ts:671-675`) while events get `{window: win}` / `{window: win, document: domDocument}`. Extend `BrowserTracesEnv` with `window`/`document` (or rAF + a visibility reader) and pass ONE `{window: win, document: domDocument}` pair to BOTH the events source and the traces sampler. Today only webview does that (`webview/launch.ts:680-684`); browser `launch.ts:803` passes `{ window: win }` only — `domDocument` (`options.document ?? win.document`, resolved at `:660-661`) goes to input/viewtree/replay/page-hide flush, and the events factory then defaults a missing `document` to the GLOBAL one (`system-events.ts:89-92`). Fix browser to `{ window: win, ...(domDocument !== undefined ? { document: domDocument } : {}) }` (the webview pattern) and do not copy today's `{window: win}` as the template; `freeze`/`resume` and `visibilitychange` then listen on the same document as input — never read `globalThis.document` while the rest of the SDK is bound to `options.window`, or an injected hidden document drives `process_background` while traces keep a vsync loop on the parent. Probe 5 hide→wait→show must run against launch-injected window/document.
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
- **Lifecycle seam (REQUIRED, ST0).** Today the platform sampler is a bare `sample: () => TraceSample[]`
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
| ST0 | Wire-shape decisions Q2/Q3/Q5 + `charging` decision (§3.1; default = leave as is) + **sampler `{start,stop,sample}` lifecycle seam** | — |
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
   `matchMedia` fires `change` records `dark_mode_changed`; a `WindowEvents` fake with no `matchMedia` still starts
   input and emits no dark-mode event.
3. **ST6 — GPU info destination (DECIDED: environment, through a NEW node seam).** `getGPUInfo` has no destination in
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
5. **ST0/ST5/ST6 — abort in-flight Promises on `stop()`.** `getBattery()` (moved into `start()`) and `getGPUInfo`
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
| `dark_mode_changed`, `freeze`, `resume`, `child_process_gone`, `power_*`, window events | Generic ticks rows | Nothing to render; keep names stable and, where Android has one (`DarkModeChanged`), decide on cross-platform grouping |
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
  no Electron environment builder to hook) once `getGPUInfo` settles, omitted until then, and never as a trace. The mapping from Electron's GPU info to
  `{vendor, renderer}` is UNVERIFIED (`basic` returns ids; fuller names may need `'complete'`) — confirm against a real
  Electron before building. `hardware.gpu` may also be fillable in the browser via the WebGL
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

**Status (2026-10): shipped.** ST0′ (#55), the browser trackers (#62), `PageLifecycleTracker` (#63) and the legacy-sampler
deletion (#65) are merged, so the bare `sample()` adapter no longer coexists with the producers on browser or node: the legacy
browser sampler (which also emitted `battery`/`charging`, the duplicate rows an interim reading of this section implied) is
deleted and `systemMetricsSampler` survives only as an explicit caller override that REPLACES the sensor traces.

The domain-tracker follow-on (§15) is tracked in §15.5; per-signal trackers that remain in `packages/browser/src/trackers/` on `main` (`MemoryTracker`, `OrientationTracker` from #62/BT1; `FpsTracker` from #69/ST4a;
`ScreenSizeTracker`, `MainThreadLagTracker` from #75/ST4c) are the ones §15.5 still has to fold into domain trackers.

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
   tracker may also re-bind the window/document it attaches to, an ACTIVE one keeps its bindings and reports the mismatch. **As built (§15.5) this is narrowed:** only `ApplicationTracker` keeps its bindings while active; `ConnectivityTracker` and `UiTracker` re-attach a running tracker to the new objects, and `StorageTracker` applies new seams at the next activation.
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
| **Environment** | — | `language`, `timezone`, `privateMode`, `displayMode`, `permissions`, … (§15.3) |

Node/Bun/Deno: **Process** (absorbs `ProcessStatsTracker`, the GC observer, event loop, heap/limits, uptime) and **Storage**
(the `disk_mem_*` poll, device volume of `effectiveDataDir`). Electron main: **Application**, **Display**, **Power**,
**Process** (`app_metrics`, GPU info cache, `child-process-gone`, window focus/hang events; §P3). The producers that exist
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
   tri-state `yes | no | unknown` with the method used, never as a certainty. **Owner decision needed:** detecting
   private browsing can read as circumventing the user's intent; propose default OFF behind an explicit launch option
   (`captureEnvironmentHints`), with `language`/`timezone`/`displayMode` on by default. Change notifications become
   `events.system` entries (`language_changed`, `timezone_changed`, `display_mode_changed`, `private_mode_detected`).
3. **Connectivity.** Use the Network Information API where present (`navigator.connection`: `type` (Chromium/Android),
   `effectiveType`, `downlink` (Mbps, capped), `downlinkMax`, `rtt` (coarsened), `saveData`, `change` event) — a fraction
   of browsers (no Safari/Firefox), so every field is optional and omitted when absent. The `online`-first mapper stays
   (`connection.change` does not fire on going offline). Extend the notification with `downlinkMax`.
4. **Process: idle.** Two different things, both wanted:
   - **User/screen idle** via the Idle Detection API (`IdleDetector`: `userState` active/idle, `screenState`
     locked/unlocked; Chromium only, secure context, threshold ≥ 60 s). It needs a **permission prompt** (`requestPermission`,
     user gesture): the SDK MUST NEVER trigger a prompt in the customer's app. It runs only when the Permissions API
     already reports `idle-detection` as `granted`, otherwise the trace is omitted. Trace `user_idle_state`.
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
  the Electron Process/Display tracker; supersedes #73's `GpuInfoCache` placement).
- Each tracker's retention rule is stated and tested ("stopping does not lose X"); each producer keeps its existing
  omit-never-zero and guarded-host-read tests.

### 15.5 As-built status (verified against `main` and the open branches, 2026-10-20)

**Merged on `main`** (implementations in `packages/trackers/src/browser/`, producers in `packages/browser/src/trace-producers.ts`):

| Slice | PR | Tracker (`…For(env, onError)` / `reset…`) | Stages | Producer / traces |
|---|---|---|---|---|
| TR0 | #77 | `createTrackerRegistry` (`tracker-registry.ts`): per-key `WeakMap`; `for(key, create, rebind?)`, `peek`, `reset` | — | — |
| TR1 | #79 | `ApplicationTracker` (`applicationTrackerFor`) | `pagehide {persisted}`, `visibility {visible}`, `state {state: foreground\|background}`, `freeze`, `resume`, plus TEMPORARY `online`, `offline`, `orientationchange` | `AppStateProducer` (`app_state`, via `state` + `current()`); events source; trace/event names unchanged |
| TR3 | #80 | `ConnectivityTracker` | `online {online}`, `networkInfo {type?, effectiveType?, downlink?, downlinkMax?, rtt?, saveData?}`, aggregate `state {online?, networkInfo?}` (activation emits a baseline of whichever of these have a value: `online` only when `navigator.onLine` is readable, `networkInfo` only where the API exists, `state` always) | `ConnectionProducer` → `connection` (unchanged shape; additive `link_downstream_max_kbps`) |
| TR4 | #78 | `PowerTracker` | one stage `state {level?, charging, chargingTimeS?, dischargingTimeS?}`, fed by `levelchange`/`chargingchange`/`chargingtimechange`/`dischargingtimechange` | `BatteryProducer` → `battery`, `charging`, NEW `battery_charging_time_s`, `battery_discharging_time_s` |
| TR6 | #81 | `StorageTracker` | one stage `storageEstimate {usageBytes?, quotaBytes?, persisted?}`; polls on activation, visibility→visible (throttled to 1/min), slow timer (default 5 min, skipped while hidden) | `StorageProducer` → NEW `storage_estimate {usage, quota}` in integer MB (floored); NOT the Android `disk_mem_*` group |

Also merged but NOT yet domain trackers (still per-signal, in `packages/browser/src/trackers/`): `MemoryTracker`, `FpsTracker`, `OrientationTracker`, and #75's `screen_size` `{width, height, dpr}`
(`ScreenSizeTracker`/`ScreenSizeProducer`) and `main_thread_lag_ms` (`MainThreadLagTracker`/`MainThreadLagProducer`); the app_state/fps/screen_size/lag producers are only built when a
shared `lifecycle` tracker is in the env. #73 (Electron GPU): GPU is ENVIRONMENT data, not a trace — `launchMain` passes a `hardwareExtras`
closure over a `GpuInfoCache` (`packages/electron/src/launch-main.ts`) that fills `environment.hardware.gpu`, so it is not yet placed in an Electron
Process/Display tracker (TR9).

**In review (NOT merged): TR2 UI/Display, PR #82, branch `feat/ui-tracker`.** `UiTracker` (`uiTrackerFor`, `resetUiTracker`) with stages `orientation {type?, angle?}`,
`screenSize {width, height, dpr}`, `viewport {width, height}`, `colorScheme {dark}`, `reducedMotion {reduce}`, `displayMode {mode}`, `frameRate` (number). Activation is
PER STAGE (listeners/timers exist only while a subscriber wants a stage that needs them, via a new `MultiKeyEmitterBase.onListenersChanged` hook plus
`listenerCount`); the de-duplication baseline is re-read silently when a stage goes from 0 to 1 listener. On that branch the browser package's
`OrientationTracker`, `ScreenSizeTracker` and `FpsTracker` (with their tests) are deleted, `ApplicationTracker` no longer binds `orientationchange`, and `OrientationProducer`/`ScreenSizeProducer`/`FpsProducer`
are rewired onto one `UiTracker` per window. Everything in this paragraph is subject to change until merged.

**In review (NOT merged): TR5 Process / `ProcessTracker` (#83, `feat/process-tracker`) and TR7 Environment / `EnvironmentTracker` (#84, `feat/environment-tracker`).** Both are
ready PRs that went through the mutator loop and several read-only Opus review rounds; their stage names and shapes are defined in `packages/trackers/src/browser/process-tracker.ts` /
`environment-tracker.ts` on those branches and are subject to change until merged, so they are not catalogued here yet.

**Conventions the merged trackers follow (the "hardening pattern"; uneven in places, gaps listed):**
- Host reads go through `hostRead` in most places (hostile getters cost only their own field and are reported via `onError`), and an unusable field is OMITTED rather than sent as 0
  (non-finite, negative, or a documented "no estimate" such as a zero `rtt`). **Known gaps (verified in code):** `PowerTracker.#publish` reads `manager.level` and `manager.charging`
  directly (`power-tracker.ts:177-178`) — `level` is range/type-checked and omitted when unusable, but `charging` is not type-checked; only the two time fields go through `hostRead`.
  `ApplicationTracker.#listen` reads `target.addEventListener` unguarded (`application-tracker.ts:185-186`), relying on the surrounding `onActivate` try/catch.
- Reporter handling differs per tracker. Connectivity, Power and Storage hold the reporter in a mutable `#report.fn` indirection (latest launch wins); Application uses an equivalent `sink.current`.
  Only Application and Connectivity wrap the reporter in try/catch so a throwing `onError` cannot escape into a DOM dispatch. **Known gap:** Power's reporter (`power-tracker.ts:67`, `:89-91`) and
  Storage's emitter reporter (`storage-tracker.ts:102`) are not wrapped, so a throwing `onError` on those paths is not contained, and no test is claimed for it. DOM listeners and timer
  callbacks are guarded in the trackers that attach them.
- Async reads carry a token (`PowerTracker` generation, `StorageTracker` epoch) so a promise settling after the last unsubscribe/reset is inert.
- Each tracker states and tests a retention rule: Application retains the last `state`; Power the resolved `BatteryManager` + last snapshot; Storage the last estimate
  (`current()`; `currentFresh()` only while younger than 2x the poll interval); Connectivity caches nothing (reads `navigator` live). DOM listeners/timers are always released.
- **Rebind rule** (§15.1 #7, as built): `for(key, create, rebind)` calls `rebind` on every request after the creating one, including a caller whose `create` lost a
  re-entrant race; a throwing `rebind` never fails the request. Semantics are "latest launch wins" for `onError` (a defined one replaces, undefined keeps) and for
  defined seams (an undefined seam never clobbers). Application re-binds window/document only while IDLE and reports a mismatch once while ACTIVE; Storage applies
  new seams from the NEXT activation; Connectivity moves a running tracker's listeners to a changed window/navigator. Keys: Application = document, else window, else a
  module key; Power/Connectivity/Storage = window, else navigator, else the env object.

**Open owner decisions (carried from the code and `docs/PROGRESS.md`):**
1. **Held values cannot be retracted.** The provider re-records every held (`emitIfChanged`) value each `refreshMs`. `storage_estimate` is held (the 5 min poll exceeds the default
   60 s window), so after failed polls the last known estimate keeps being re-recorded; the `battery_*_time_s` traces avoid this by using plain non-held `emit` with a
   producer-side change-only guard, at the cost that an unchanged time ages out of the rolling window. Options: plain `emit` for storage, or a provider retract/release/end-marker mechanism.
2. **Private-mode detection default OFF** behind an explicit launch option (`captureEnvironmentHints`), as proposed in §15.3 item 2; this belongs to TR7 and is not decided.
3. **Electron GPU `'complete'` vs `'basic'`.** `launchMain({gpuInfoType})` defaults to `'basic'`; `'complete'` is expected to carry the `auxAttributes` GL strings but is heavier.
   Both mappings are UNVERIFIED against a real Electron (on macOS/Linux `'basic'` commonly yields only numeric ids, so `hardware.gpu` is then absent, never guessed).

**Remaining plan:** merge TR2 (#82) and migrate the remaining window-listener consumers onto `UiTracker` (e.g. `packages/browser/src/viewport-source.ts`, which today attaches its own
`window`/`visualViewport` `resize`/`scroll` listeners); fold `MemoryTracker`/`MainThreadLagTracker` into TR5 and finish TR7; then **remove `ApplicationTracker`'s temporary
`online`/`offline` stages** (still bound for the events source; Connectivity owns its own copies, so they are bound twice today); TR8 node/Bun/Deno Process (+ GC, event loop) and
Storage consolidation (`packages/trackers/src/node/` is an empty placeholder today); TR9 Electron trackers (`packages/trackers/src/electron/` is an empty placeholder; GPU cache folds in).

