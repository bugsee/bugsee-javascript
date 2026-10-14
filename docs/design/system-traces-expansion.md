# System traces expansion — competitor gap + mobile-parity port plan — DESIGNED (not built)

**Status:** DESIGNED 2026-10-14. Nothing here is implemented. Built from five read-only research passes
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
1. `charging`: Android `{state, source}` map; iOS 4-state int; JS boolean.
2. `cpu`: iOS = percent summed over threads (can exceed 100); JS `cpu_usage_process` = per-core-normalized.
3. `connection` (JS) vs `network` (iOS) vs Android `connection` — JS already follows Android's vocabulary
   (`web-tier-wire-alignment`); keep.
4. `orientation` ints 3/4 mean opposite things on iOS vs Android — JS follows Android; keep.
5. Unavailable service: Android emits `"$$unavailable"`; JS omits. See Q3.

## 4. Proposed additions (prioritised)

Naming rule: use the Android wire name when the quantity is the same thing; otherwise a JS-specific name in
the existing `process_*` / `event_loop_*` style. Units: bytes unless Android says otherwise.

### P1 — Node/Bun/Deno runtime depth (`@bugsee/node`)
| Trace | Source | Notes |
|---|---|---|
| `gc_pause_ms` (sum/max per interval), `gc_count` (optionally by type tag) | `PerformanceObserver({entryTypes:['gc']})` | Broadest competitor-backed gap. **UNMEASURED on Bun/Deno** — gate per runtime like `measuresEventLoopDelay`. |
| `v8_heap_size_limit`, `v8_heap_available`, `v8_heap_malloced`, `v8_heap_peak_malloced` | `v8.getHeapStatistics()` | Cheap, sync. Bun support **UNMEASURED**. |
| `ram_js_heap_{total,free,used}` on Node | `v8.getHeapStatistics()` (`heap_size_limit` = total, as Android's `ram_jvm_heap` contract: total = max, free = total − used) | Gives the viewer the same grouping browser already gets. Decision Q2. |
| `ram_system_available` (cgroup-aware) | `process.availableMemory()` | Sentry uses it. Fallback = omit, not `os.freemem()`. |
| `disk_mem_free`, `disk_mem_total` | `fs.statfs` (Node ≥18.15) | Android/iOS MB integer, change-deduped (≥1 MB). Opt-in-able like iOS `BugseeOptionCaptureDiskSpace`. **UNMEASURED on Bun/Deno.** |
| `handles_active`, `requests_active` | `process.getActiveResourcesInfo()` | Elastic/OTel. Low priority; API exists Node ≥17.3. |
| `process_uptime_s` | `process.uptime()` | Trivial; Sentry/Datadog/OTel. |

### P2 — Browser parity (`@bugsee/browser`)
| Trace / event | Source | Notes |
|---|---|---|
| `fps` | `requestAnimationFrame` counter over the 1 s window | Android `fps`; iOS `fps`; Highlight/OpenReplay. **Gate on visibility; never keep a permanent rAF loop in a hidden tab** (battery + keeps page awake). |
| `app_state` (step trace) | `document.visibilityState` | Android+iOS have it; JS has only the events today. Reuse the existing visibility listener. |
| `displays` | `screen.width/height`, `devicePixelRatio`; Electron `screen.getAllDisplays()` | Static snapshot + `resize`/`display-metrics-changed`. |
| `thermal_state` | Compute Pressure `PressureObserver` | Chromium-only, experimental, permissions-policy gated → **behind feature detection, off by default**. |
| `DarkModeChanged` event | `matchMedia('(prefers-color-scheme: dark)')` change | Android name; trivial. |
| `freeze` / `resume` events | Page Lifecycle | Complements `process_background`. |
| Event-driven `battery`/`charging`/`connection` | `levelchange`, `chargingchange`, `connection` `change` | Replaces 1 s polling for these; OpenReplay precedent. Keep a 1 s fallback only where events are absent. |
| `hardware_concurrency` (context, not trace) | `navigator.hardwareConcurrency` | Sentry; static → belongs in environment, not a trace. |
| Main-thread responsiveness | `setTimeout`/`MessageChannel` round-trip delta | Browser analogue of node `event_loop_lag_*` / iOS `queue.main`. Name `main_thread_lag_ms`. |

### P3 — Electron main-process telemetry (`@bugsee/electron`)
Gated into the main-process sampler; `electron` is already an injected arg (no package dependency).
| Item | Source |
|---|---|
| Per-process CPU+memory (`app_metrics`: type, pid, cpu %, workingSet) | `app.getAppMetrics()` |
| `child_process_gone` event (type, reason, exitCode) | `app.on('child-process-gone')` — beyond the existing `render-process-gone` incident path |
| `power_suspend/resume`, `power_lock/unlock`, `power_ac/battery` events | `powerMonitor` |
| `displays` (above) incl. add/remove/metrics-change events | `screen` |
| GPU info (context) | `app.getGPUInfo('basic')` — wrap in try/catch (throws on Linux without acceleration, per Sentry) |
| Window focus/blur/show/hide/unresponsive events | `BrowserWindow` |

### P4 — Serverless / edge context
| Item | Source |
|---|---|
| Lambda: remaining time, memory limit, request id, cold-start flag, timeout-warning event | Lambda `context` | Sentry/Datadog. Context fields, not polled traces. |
| Cloud provider/region from env | `process.env` (`VERCEL`, `AWS_REGION`, `FLY_REGION`, …) | Check whether the environment builder already does this (Q4). |
| Cloudflare/Vercel CPU/memory | **Platform-side only** — SDK cannot read them; do not fake. |

### Explicitly NOT ported
`wifi`, `cellular`, `bluetooth`, `nfc`, `screen_brightness`, `game_mode`, `satellite`, `device_idle`,
`low_power_*`, `thermal_headroom`, iOS `accessibility`/`fold_state`/`hinge_angle`, `ram_low_memory` /
`MemoryPressure` / `TrimMemory` (no JS signal; a heap-ratio threshold would be an invention — if wanted later it
must be named derived, e.g. `heap_pressure`), `UserDidTakeScreenshot`, `ClipboardChanged` content, input-device
events. Reasons: no API, privacy, or Bugsee-internal state.

## 5. Architecture constraints

- **Thin kernel, no core piercing.** All additions are sampler entries in the platform packages' existing
  `system-metrics.ts` callbacks (or new interceptors feeding the system-events provider). Nothing in
  `@bugsee/core`.
- **Runtime-portable.** Shared tiers reach globals only via `globalThis as unknown as {…}` casts. `v8`/`fs`/
  `perf_hooks` live in `@bugsee/node` behind the existing guarded-metrics seam (`guarded-system-metrics.ts`).
- **Per-runtime gates, not passive tells.** Anything UNMEASURED on Bun/Deno ships with a runtime flag (like
  `measuresEventLoopDelay`) defaulting to OFF there until measured; `@bugsee/{bun,deno}` flip it only with a
  recorded measurement in this doc.
- **Cadence.** Keep the single 1 s sampler for cheap sync reads. Slow/expensive sources (`fs.statfs`,
  `getAppMetrics`, `getHeapSpaceStatistics`) sample every N ticks (Android precedent: process memory every
  5th tick, disk every 5 s). Event-driven sources emit on change with dedupe (iOS `emitIfChangedName`).
- **Cost.** GC observer and rAF counter run only while a subscriber is present (subscriber-presence drives
  activation, per the pub/sub architecture). Budget: the sampler tick must stay well under the existing
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
5. Browser: rAF-counter cost and accuracy in background tabs; Compute Pressure availability; `battery`
   events on Chromium.
6. Sampler tick cost with P1 enabled (µs per tick) vs the current baseline.
Record each result in §8 with runtime version and date, as `docs/PROGRESS.md` does for the existing gates.

## 8. Measurement log

*(empty — fill as probes run)*

## 9. Slices

| Slice | Content | Depends on |
|---|---|---|
| ST0 | Wire-shape decisions Q2/Q3/Q5 + `charging` shape fix | — |
| ST1 | Node: `v8_heap_*`, `ram_js_heap_*` aliases, `process_uptime_s`, `ram_system_available` | probes 2, 4 |
| ST2 | Node: GC observer (`gc_*`) with per-runtime gate | probe 1 |
| ST3 | Node: `disk_mem_*` (+ option) | probe 3 |
| ST4 | Browser: `app_state`, `fps`, `displays`, `main_thread_lag_ms`, dark-mode/freeze/resume events | probe 5 |
| ST5 | Browser: event-driven battery/connection | probe 5 |
| ST6 | Electron: `app_metrics`, `child_process_gone`, power/screen/window events, GPU context | — |
| ST7 | Serverless context: Lambda context fields, cloud-region audit | Q4 |
| ST8 | Optional: Compute Pressure `thermal_state` (flagged off) | probe 5 |

## 10. Open questions (need a product/owner decision)

- **Q1.** Do long tasks / LoAF / web vitals / navigation+resource timing belong in `@bugsee/performance`
  (already owns web-vitals) rather than `traces.system`? Recommendation: yes — keep them out of this doc's
  scope and confirm `@bugsee/performance` covers long tasks/LoAF; check for overlap before any build.
- **Q2.** Should Node emit `ram_js_heap_*` *in addition to* `process_memory_heap_*`? Recommendation: yes
  (viewer grouping parity with browser/Android); accept the duplicate values.
- **Q3.** Omit vs `"$$unavailable"` for unsupported services. Recommendation: keep omitting (consistent with
  the ELU/Deno precedent) unless the viewer needs the sentinel — verify viewer handling first.
- **Q4.** Does the env builder already detect cloud provider/region? (Not checked.)
- **Q5.** Which new trace names does the viewer already render? (Viewer tables not inspected.) Any name the
  viewer lacks needs a viewer PR (precedent: worker PR 46 / viewer PR 14).
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
