# Bun and Deno — capture-API research

Verified against **Bun 1.3.x docs** (bun.sh/docs + bun.com/reference, fetched 2026-09-01) and
**Deno 2.x docs** (docs.deno.com, fetched 2026-09-01). The SDK declares `Deno >= 2.0` / `Bun ~1.1+`;
where a finding depends on a feature that landed after those floors, the version is called out
explicitly. Neither runtime's docs were cross-checked against a running process for this pass —
every row is `documented` unless the SDK's own source (cited inline) already proves it `verified` in
practice.

## Top 5

1. **Deno's built-in OpenTelemetry (`OTEL_DENO`)** is the single highest-value finding. On Deno
   ≥2.4, setting `OTEL_DENO=true` makes the runtime itself emit `http.server`/`http.client` spans
   (for `Deno.serve` and `fetch`) plus request-duration and active-request metrics, and it wires the
   global `npm:@opentelemetry/api` tracer/meter providers automatically — no SDK boot code needed to
   get real OTel data flowing. This is a better source for Deno network capture than re-deriving spans
   from a `fetch`/`Deno.serve` interceptor, and it's already OTel-shaped, so it composes directly with
   the SDK's existing OTel producer instead of being translated into it. See the Deno section and the
   OTel-story note below for the coexistence caveat.
2. **`node:v8` `getHeapStatistics()` is genuinely supported on both Bun and Deno** (unlike most of
   `node:v8`, which is stubbed on both). It's a strictly richer, more portable heap-space breakdown
   (`total_heap_size`, `used_heap_size`, `heap_size_limit`, `malloced_memory`, `does_zap_garbage`,
   etc.) than `process.memoryUsage()` alone, and — critically — it is the one `node:v8` API the SDK
   can call identically on Node, Bun, and Deno without a runtime branch.
3. **`Bun.serve`'s per-connection surface** (`server.requestIP(req)`, `server.pendingRequests`,
   `server.pendingWebSockets`, `server.subscriberCount(topic)`, `server.timeout(req, s)`) is free,
   already-available data the current network capture doesn't surface: live concurrent-request/
   WebSocket counts (a load metric with no Node equivalent this cheap) and per-request remote address
   without parsing headers.
4. **`bun:jsc` `heapStats()`** gives JSC-native leak-detection signal that `process.memoryUsage()`
   cannot: `objectTypeCounts` / `protectedObjectTypeCounts` (e.g. an unbounded `Promise` or `Timeout`
   count is a specific, actionable finding a generic RSS number isn't).
5. **Confirmation, not a new API: `node:inspector`'s `Session`+`Profiler` domain and
   `AsyncLocalStorage` both genuinely work on Bun**, validating two things the SDK already leans on
   (`packages/node/src/cpu-profiler.ts` uses `node:inspector` `Session`; the per-request context
   foundation uses `AsyncLocalStorage`). The important asymmetry is that the *same* `node:inspector`
   path does **not** work on Deno — see the compatibility-traps section, this is the load-bearing
   finding of this whole doc for the SDK's existing "full parity" claim.

---

## Bun

Verified against bun.sh/docs and bun.com/reference (current docs, exact "as of Bun version" not
stated on most pages — treat point-in-time facts, e.g. `--cpu-prof`, as needing a live version check
before relying on them).

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| `server.requestIP(req)` | Bun ≥1.0, `Bun.serve` handler arg, de-facto (Bun-only) | `{ address, port } \| null` — client remote address/port per request | event | `network` (better source: today's fetch/http interceptors don't carry remote IP) | negligible, sync call | `null` for closed requests / unix sockets; no flag needed | client IP is PII in some jurisdictions — same class of data the SDK already handles for `node:http` `req.socket.remoteAddress` | documented — [bun.sh/docs/api/http](https://bun.sh/docs/api/http) |
| `server.pendingRequests` / `server.pendingWebSockets` | Bun ≥1.0, `Server` instance property, Bun-only | live in-flight HTTP request count / active WebSocket count | sample (read anytime) | NEW — metric (gauge), e.g. `bun.server.pending_requests` | negligible, O(1) read | always available inside the `fetch`/`websocket` handlers or off the returned `Server` | none — aggregate counts only | documented — [bun.com/reference/bun/Server](https://bun.com/reference/bun/serve) |
| `server.subscriberCount(topic)` | Bun ≥1.0, `Server`, Bun-only | subscriber count for a pub/sub WebSocket topic | sample | NEW — metric, only relevant if the app uses Bun's WS pub/sub | negligible | requires the app to use `ws.subscribe(topic)`; else always 0 | topic names could leak business logic (e.g. `"user:123"`) if logged verbatim | documented — [bun.sh/docs/api/http](https://bun.sh/docs/api/http) |
| `server.timeout(req, seconds)` / `idleTimeout` | Bun ≥1.0, `Server`, Bun-only | not itself telemetry, but its *absence of use* explains request hangs — worth knowing default is 10s / max 255s | n/a (config) | context for `network` spans that show as slow/aborted | none | — | none | documented — [bun.sh/docs/api/http](https://bun.sh/docs/api/http), [github.com/oven-sh/bun/issues/27479](https://github.com/oven-sh/bun/issues/27479) |
| `Bun.nanoseconds()` | Bun ≥1.0, global, Bun-only | ns since process start, monotonic | sample | span timing source (alternative to `process.hrtime.bigint()`, which also works — no net-new value, listed for completeness) | negligible | always available | none | documented — [bun.sh/docs/api/utils](https://bun.sh/docs/api/utils) |
| `Bun.peek(promise)` / `Bun.peek.status(promise)` | Bun ≥1.0, global, Bun-only | synchronously reads an already-settled promise's value/error, or its status (`pending`/`fulfilled`/`rejected`) without awaiting | snapshot | not a capture source — an internal perf primitive, not user-facing telemetry | none if already settled | always available | none | documented — [bun.sh/docs/api/utils](https://bun.sh/docs/api/utils) |
| `bun:jsc` `heapStats()` | Bun ≥1.0, `bun:jsc` module, Bun-only (JSC, not V8) | `heapSize`, `heapCapacity`, `objectCount`, `globalObjectCount`, `protectedObjectCount`, `extraMemorySize`, `objectTypeCounts` (per-constructor live counts), `protectedObjectTypeCounts` (GC-rooted counts, e.g. live timers) | sample (poll) | NEW metric — richer memory diagnostic than `traces.system` memory today | non-trivial: walks the live heap, don't poll every tick (recommend same cadence as existing memory trace, e.g. every N seconds) | Bun-only import, silently absent elsewhere (must runtime-guard) | object-type names could reveal internal class/module names; counts alone are safe | documented — [bun.com/reference/bun/jsc/heapStats](https://bun.com/reference/bun/jsc/heapStats) |
| `Bun.generateHeapSnapshot('v8' \| 'jsc', 'arraybuffer'?)` | Bun ≥1.0, global, Bun-only | full heap snapshot; `'v8'` mode emits Chrome-DevTools-compatible JSON (same viewer as Node's `.heapsnapshot`) | snapshot (on demand) | `profile`-adjacent NEW file — a heap-snapshot companion to the existing CPU `profile` stream, gated the same way (opt-in, report-time only — snapshots are large and can contain arbitrary in-memory string/object data) | high: full heap walk, main-thread pause proportional to live heap size, snapshot itself can be tens of MB | always available, no flag | **high** — a heap snapshot can contain literal string contents of in-memory objects (tokens, PII in variables) — must be opt-in and treated like the existing pixel-video permission gate, not default-on | documented — [bun.com/reference/bun/generateHeapSnapshot](https://bun.com/reference/bun/generateHeapSnapshot) |
| `bun --cpu-prof` / `--cpu-prof-dir` / `--cpu-prof-interval` | Bun ≥1.3.x (exact landing version unverified — recent, per 2026 blog posts), CLI flag, Bun-only | writes a `.cpuprofile` file at process exit | snapshot | **not usable by the SDK today** — it's a launch-time CLI flag, not a programmatic API; `packages/node/src/cpu-profiler.ts` already gets equivalent (better: rolling, in-process) coverage via `node:inspector` `Session`+`Profiler`, which is confirmed to work on Bun (see Node-API compatibility traps) | n/a | requires the flag at `bun` invocation — an SDK cannot enable it after the fact | none beyond existing profile privacy | documented, and marked `unverified` for exact version — [x.com/lydiahallie/status/1987916655855648876](https://x.com/lydiahallie/status/1987916655855648876), open programmatic-API request: [github.com/oven-sh/bun/issues/28204](https://github.com/oven-sh/bun/issues/28204) |
| `Bun.spawn`/`Bun.spawnSync` `resourceUsage()` | Bun ≥1.0, global, Bun-only | `maxRSS`, `cpuTime.{user,system,total}`, `contextSwitches.{voluntary,involuntary}`, `messages`, `ops`, `signalCount`, `swapCount`, `shmSize` for a subprocess the app spawned | event (on exit) | NEW — only relevant if the customer's app shells out; a span/breadcrumb for child-process exit with resource cost | none (post-exit read) | only if the app uses `Bun.spawn` (not `child_process`) — narrow applicability | command-line args of the spawned process could contain secrets if logged | documented — [bun.sh/docs/api/spawn](https://bun.sh/docs/api/spawn) |
| `bun:sqlite` statement introspection (`columnNames`, `paramsCount`, `.toString()` with bound params) | Bun ≥1.0, `bun:sqlite`, Bun-only | schema/shape of a query, and (via `.toString()`) the fully-bound SQL text | snapshot (per call, would need wrapping) | NEW `network`-analog span for DB calls — **no timing, no hooks**: getting a span requires the SDK to wrap `.run()/.all()/.get()` itself (same pattern as fetch/XHR interceptors), this API only supplies the *labels* | wrapping cost only, no native overhead | Bun-only, narrow (only apps using `bun:sqlite` directly, not an ORM) | bound SQL text can contain literal user data — same class of risk as query-string capture elsewhere, needs the same redaction | documented — [bun.sh/docs/api/sqlite](https://bun.sh/docs/api/sqlite) |
| `--inspect` / WebKit Inspector Protocol | Bun ≥1.0, CLI flag, Bun-only protocol (not CDP) | full debugger surface externally | n/a | not a capture source — external-tool only, no confirmed in-process start API | n/a | CLI-flag-gated, no evidence of a programmatic "start inspector now" call | full source/heap visibility to whoever connects — this is a debug tool, not a telemetry source | documented — [bun.sh/docs/runtime/debugger](https://bun.sh/docs/runtime/debugger) |

---

## Deno

Verified against docs.deno.com (Deno 2.x, current as of 2026-09-01).

| API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|
| Built-in OTel (`OTEL_DENO=true`) | Deno ≥2.2 (unstable, needs `--unstable-otel`), **stable since Deno 2.4** (`OTEL_DENO=1`, no flag) | Auto-instruments `Deno.serve` (server spans + `http.server.request.duration`/`http.server.active_requests` metrics + response/body-size), `fetch` (client spans), `node:http2`, `Deno.cron()`; `console.*` calls exported as OTel logs; runtime fatal errors exported as log records; sets up global `npm:@opentelemetry/api` tracer/meter providers automatically | stream (continuous export) | Directly **NEW** OTel-native source — could replace or supplement the SDK's own network-span derivation on Deno specifically, since it's already OTel-shaped | export is off-thread OTLP over `http/protobuf` by default to `localhost:4318`; auto-console-log-as-telemetry could double-count if the SDK's own `console`→`log` interceptor is also active — **not measured, flag as cost-unverified** | env var only, **no code change** — but the SDK targets Deno ≥2.0, so `OTEL_DENO` is unavailable (unstable, needs a flag) below 2.2 and unstable between 2.2–2.3; treat as Deno ≥2.4 only | span/log data will include full URLs, and `console.*`→log export means anything already logged goes out over OTLP a second time via a channel the SDK doesn't control — needs explicit user opt-in/awareness, not silent | documented — [docs.deno.com/runtime/fundamentals/open_telemetry](https://docs.deno.com/runtime/fundamentals/open_telemetry/), [deno.com/blog/v2.2](https://deno.com/blog/v2.2), [deno.com/blog/v2.4](https://deno.com/blog/v2.4) |
| `Deno.serve` handler's `ServeHandlerInfo` | Deno ≥1.x (stable), global, Deno-only | `remoteAddr` (client transport address: TCP/unix/vsock) + `completed: Promise<void>` that resolves on full response delivery or rejects on client disconnect | event (per request) | `network` — better source: `completed` catches client-side aborts that a fetch-style interceptor may not observe, and `remoteAddr` is free connection info the SDK's current network capture doesn't carry on Deno | negligible | always available in the handler signature, no flag | client remote address — same PII class as Bun's `requestIP` | documented — [docs.deno.com/api/deno/~/Deno.serve](https://docs.deno.com/api/deno/~/Deno.serve) |
| `Deno.serve({ onListen })` | Deno ≥1.x, global, Deno-only | `localAddr` at bind time | event (once) | `events.system`-style startup breadcrumb, minor value (already knowable from launch options) | none | always available | none | documented — [docs.deno.com/api/deno/~/Deno.serve](https://docs.deno.com/api/deno/~/Deno.serve) |
| `Deno.memoryUsage()` | Deno ≥1.x (stable), global, Deno-only (Node-shaped) | `rss`, `heapTotal`, `heapUsed`, `external` — same shape as Node's `process.memoryUsage()` | sample | `traces.system` (already captured on Node via `process.memoryUsage`; this is Deno's parity source — the SDK's Deno tier should confirm it calls this, or the Node-composition `process.memoryUsage()` shim, not silently return zeros) | negligible | no permission required | none | documented — [docs.deno.com/api/deno/~/Deno.memoryUsage](https://docs.deno.com/api/deno/~/Deno.memoryUsage) |
| `node:v8` `getHeapStatistics()` under Deno | Deno ≥2.x, `node:v8` compat shim | real V8 heap breakdown: `total_heap_size`, `heap_size_limit`, `used_heap_size`, `malloced_memory`, `does_zap_garbage`, etc. (Node-identical shape, and Deno actually runs V8 so this is not an emulation) | sample | NEW — richer than `Deno.memoryUsage()`; same call works on Node too, giving one code path across Node+Deno (not Bun — see traps) | negligible | always available on Deno ≥2.x per the compat doc, no flag | none | documented — [docs.deno.com/api/node/v8](https://docs.deno.com/api/node/v8/) |
| `Deno.systemMemoryInfo()` | Deno ≥1.x (stable), global, Deno-only, requires `--allow-sys` | `total`, `free`, `available`, `buffers`, `cached`, `swapTotal`, `swapFree` (bytes) — OS-level, not process-level | sample | `traces.system` — better source than process memory for "is the host under memory pressure" | negligible | **needs `allow-sys` permission**; throws/prompts if not granted and not interactively resolvable in a server process — must be requested at launch or the metric silently unavailable | host-level memory figures, low sensitivity | documented — [docs.deno.com/api/deno/~/Deno.systemMemoryInfo](https://docs.deno.com/api/deno/~/Deno.systemMemoryInfo) |
| `Deno.loadavg()` | Deno ≥1.x, global, requires `--allow-sys` | `[1m, 5m, 15m]` OS load averages | sample | `traces.system` NEW — no Node equivalent this cheap (`os.loadavg()` exists on Node too, so really cross-runtime parity, not Deno-only value) | negligible | needs `allow-sys` | none | documented — [docs.deno.com/api/deno/~/Deno.loadavg](https://docs.deno.com/api/deno/~/Deno.loadavg) |
| `Deno.osUptime()` | Deno ≥1.x, global, requires `--allow-sys` | OS uptime in seconds | sample | context field, minor value | negligible | needs `allow-sys` | none | documented — [docs.deno.com/api/deno/~/Deno.osUptime](https://docs.deno.com/api/deno/~/Deno.osUptime) |
| `Deno.permissions.query(...)` | Deno ≥1.x, global, standard (Deno-only shape) | current grant state (`"granted"`/`"denied"`/`"prompt"`) for `read`/`write`/`net`/`env`/`sys`/`run`/`ffi`/`import`, each scopeable (e.g. `sys` scoped to `"loadavg"`, `"hostname"`, etc.) | snapshot (query anytime) | **not telemetry itself — a capability gate**: the SDK's Deno tier should query `sys` before relying on `Deno.systemMemoryInfo`/`loadavg`/`osUptime` and degrade gracefully rather than throwing/prompting, since a server process can't answer an interactive permission prompt | negligible | — | none | documented — [docs.deno.com/api/deno/~/Deno.permissions](https://docs.deno.com/api/deno/~/Deno.permissions) |
| `Deno.metrics()` / `Deno.resources()` | **REMOVED in Deno 2.0**, no replacement | n/a | n/a | n/a — do not target, confirmed gone | n/a | throws/undefined on Deno ≥2.0 (the SDK's declared floor) | n/a | documented — [github.com/denoland/deno/issues/12109](https://github.com/denoland/deno/issues/12109), [docs.deno.com/runtime/reference/migration_guide](https://docs.deno.com/runtime/reference/migration_guide/) |
| `--inspect` / CDP session (external) | Deno ≥1.x, CLI flag, standard CDP (Deno uses V8, unlike Bun's WebKit protocol) | full CDP surface (Profiler, HeapProfiler, Debugger domains) to an *external* client | n/a | not usable in-process — see the `node:inspector` trap below: Deno's own `node:inspector` compat shim does not expose this in-process | n/a | CLI-flag-gated, external connection required | full runtime visibility to whoever connects | documented — [docs.deno.com/runtime/fundamentals/debugging](https://docs.deno.com/runtime/fundamentals/debugging/) |

---

## Node-API compatibility traps

This is the section that matters most for the SDK: both Bun and Deno tiers **re-export the Node
composition and only override the runtime-identity probe**, so anything the Node code path calls
either works for free or silently degrades. Verified against each runtime's own compat docs, not
tested live against a running process, so mark these `documented` unless the SDK's source already
proves otherwise (called out inline).

| Node API | Bun 1.3.x | Deno 2.x | Trap for this SDK |
|---|---|---|---|
| `node:inspector` `Session` + `Profiler` domain | **Works** — `Session` supports `Profiler.enable/setSamplingInterval/start/stop`, `Runtime.enable`, `NodeTracing`, `open()`/`url()`/`close()`/`waitForDebugger()` | **Stub** — "console is supported. Other APIs are non-functional stubs." `Profiler` domain is not functional | **Load-bearing.** `packages/node/src/cpu-profiler.ts` drives CPU profiling entirely through `node:inspector` `Session`. It already has a capability guard (no-ops when the session/API throws), so it will not crash on Deno — but PROGRESS.md's claim of "full Node feature parity incl. profiling + ANR" on Bun+Deno is **only true for Bun**; on Deno, rolling CPU profiling is confirmed to silently no-op. Worth an explicit doc correction or a Deno-specific profiling story (there isn't an obvious in-process replacement — Deno's own `--inspect` is external-only). | [bun.sh/docs/runtime/nodejs-apis](https://bun.sh/docs/runtime/nodejs-apis), [docs.deno.com/api/node/inspector](https://docs.deno.com/api/node/inspector/), code: `packages/node/src/cpu-profiler.ts:1-69` |
| `node:async_hooks` `AsyncLocalStorage` | **Works** | **Works** ("no compatibility warning provided; appears to be fully functional") | None — this is the one piece both runtimes genuinely support, and it's exactly what the per-request context foundation (`AsyncLocalStorage.run`/`enterWith`) relies on. Confirmed safe on both. |
| `node:async_hooks` `AsyncResource`, `createHook`, `executionAsyncId`, `triggerAsyncId` | **Non-functional stubs** on all four (async IDs always `0`, hooks never invoked except `init` for `process.nextTick`) | **Non-functional stubs**, same four, Deno explicitly discourages using them at all | Symmetric trap: do not build anything that assumes execution-context tracking via these primitives on either runtime — they exist (won't throw) but silently produce nothing. Correlation-by-tagging (the SDK's actual design) sidesteps this entirely, which is presumably why it was chosen. |
| `node:perf_hooks` `monitorEventLoopDelay()` | **Works** (implemented, per Bun's own compat doc) | **Not implemented** ("This symbol is not implemented.") | **Already handled** — `packages/node/src/guarded-system-metrics.ts` explicitly guards `monitorEventLoopDelay` and degrades its metric to zero rather than throwing, with a comment noting it's "PARTIAL perf_hooks (Bun, Deno)". This research **confirms** the guard is necessary on Deno and *unnecessary but harmless* on Bun (Bun actually has it). Code: `guarded-system-metrics.ts:1-33`. |
| `node:perf_hooks` `PerformanceObserver` (mark/measure/http/net entries) | **Works** for `mark`/`measure`/`function`/`net`/`http`/`http2`; **never emits `gc`, `dns`, `resource`**; `eventLoopUtilization()` always zero | Core marks/measures work; Deno's own compat page doesn't confirm `net`/`http` entry types | Trap: don't build a `gc`-entry-based metric expecting it to fire on Bun — it never will (confirmed by Bun's own docs, not just "may not"). |
| `node:v8` (`getHeapStatistics`, `writeHeapSnapshot`, `serialize`/`deserialize`, `setFlagsFromString`) | `getHeapStatistics`, `writeHeapSnapshot`, `getHeapSnapshot`, `GCProfiler`, `startupSnapshot` **work**; `setFlagsFromString` is a no-op; missing `queryObjects`, `startCpuProfile`/`startHeapProfile`, `promiseHooks`, coverage APIs; heap stats describe JSC not V8 | `getHeapStatistics`, `serialize`, `deserialize`, `cachedDataVersionTag` **work** (real V8, not an emulation); `setFlagsFromString` is a no-op; **everything else, including `writeHeapSnapshot`/`getHeapSnapshot`, throws** | Trap: a heap-snapshot feature built on `node:v8` `writeHeapSnapshot` works on Node and Bun but **throws on Deno** — must branch (Bun's own `Bun.generateHeapSnapshot('v8')` is the Deno-less alternative on Bun; Deno has no in-process substitute at all found in this research). `getHeapStatistics` is the one call safe across all three. |
| `node:diagnostics_channel` | **Partial** — `channel()`, `subscribe()`, `tracingChannel()` work; built-in channels limited to `http` (client only), `http2`, `dgram` — **no `http.server.*`, `net`, `module`, `child_process`, `worker_threads` channels**; subscribers don't keep a channel alive (must hold your own reference) | **Listed as fully implemented** in Deno's own compat matrix, but the module's own doc page states no compatibility caveats either way — treated here as `documented`, not independently confirmed for built-in channel population | Trap for symmetry: don't assume Bun populates the same built-in channels Deno (or Node) does. Any future incoming-server instrumentation that leans on `diagnostics_channel`'s `http.server.*` channel (instead of the current `emit`-patch approach the SDK actually uses) would silently get no events on Bun. The SDK's actual `Server.prototype.emit` patch approach avoids this trap entirely — worth noting as validation of that choice, not a new problem. |
| `node:worker_threads` | **Partial** — `Worker` works, `execArgv` respected; ignores `resourceLimits`/`trackUnmanagedFds`; `performance.eventLoopUtilization()` on a worker is a stub; missing `moveMessagePortToContext`, `locks` | **Partial** — `parentPort.emit`/`removeAllListeners` unsupported; `markAsUntransferable`, `moveMessagePortToContext`, `receiveMessageOnPort` unsupported; `Worker#getHeapSnapshot()` unavailable | Relevant because the SDK's ANR/hang-detection watchdog (`packages/node/src/event-loop-watchdog.ts`) is worker-thread-based. Core `Worker` construction/messaging works on both, which is presumably why the watchdog was built that way rather than on `perf_hooks`. `Worker#getHeapSnapshot()` being unavailable on Deno means a worker-side heap snapshot isn't an option there either. |

---

## Deno's OTel story (detail)

- **Mechanism:** `OTEL_DENO=true` (stable Deno ≥2.4; unstable + `--unstable-otel` flag on 2.2–2.3;
  entirely absent below 2.2) turns on runtime-level auto-instrumentation. It does **not** need the
  app to call `NodeSDK` or configure exporters — Deno registers the global tracer/meter providers for
  `npm:@opentelemetry/api` itself.
- **What it emits:** server spans for `Deno.serve` requests, client spans for `fetch`, HTTP/2 trace
  context propagation, `Deno.cron()` invocation spans, `http.server.request.duration` and
  `http.server.active_requests` metrics, request/response body-size metrics, and `console.*` output
  re-exported as OTel log records. Default export target is OTLP `http/protobuf` to
  `localhost:4318`, fully redirectable via the standard `OTEL_EXPORTER_OTLP_*` env vars (including a
  `console` protocol mode for local debugging).
- **Coexistence with the SDK's own OTel producer:** Deno's own docs describe this as ambient and
  additive rather than something the app configures, and state explicitly that the app should *not*
  call `setGlobalTracerProvider`/`setGlobalMeterProvider` itself — Deno already has. This means the
  SDK's own `@bugsee/opentelemetry` "Produce OTLP-JSON" path, if it also tries to register a global
  provider on Deno, would be fighting Deno's own registration rather than composing with it. The
  **safer integration is to treat `OTEL_DENO`'s output as an independent, parallel export path** the
  customer can point at their own collector, not something the SDK should try to intercept or merge
  into its own bundle — I could not find documentation of a supported way to tap Deno's internal OTel
  pipeline as a data *source* (e.g., there is no `Deno.telemetry` API to read spans back out
  in-process). This composability question (silent double-export of `console.*` specifically, since
  the SDK also captures console as `log`) is `unverified` — I did not run both simultaneously.
- **Minimum version gap:** the SDK declares `Deno >= 2.0`; `OTEL_DENO` needs 2.2 at the very earliest
  (unstable) and 2.4 for the stable, no-flag path. Any recommendation building on this must either
  raise the Deno floor for that specific feature or feature-detect (`Deno.version.deno` compared
  against `"2.4.0"`) and no-op below it.

Sources: [docs.deno.com/runtime/fundamentals/open_telemetry](https://docs.deno.com/runtime/fundamentals/open_telemetry/),
[deno.com/blog/v2.2](https://deno.com/blog/v2.2), [deno.com/blog/v2.4](https://deno.com/blog/v2.4),
[deno.com/blog/otel-tracing-in-node-and-deno](https://deno.com/blog/otel-tracing-in-node-and-deno).

---

## What I would NOT recommend, and why

- **`Bun.generateHeapSnapshot()` / any full heap-snapshot capture as a default-on feature.** High
  cost (main-thread pause proportional to live heap, multi-MB output) and high privacy exposure
  (literal in-memory string contents — tokens, PII sitting in variables). If built at all, it belongs
  behind the same explicit, permission-gated, report-time-only pattern as the Electron pixel-video
  snapshot source, never a rolling capture.
- **Building anything on `node:async_hooks`'s `createHook`/`AsyncResource`/`executionAsyncId`.**
  Confirmed non-functional stubs on *both* Bun and Deno (and Node itself discourages `async_hooks` in
  favor of `AsyncLocalStorage`). There is no runtime where this pays off for the SDK's stated targets.
- **`bun:sqlite` / DB-call spans as a Bun-specific feature.** The API only supplies query-shape
  labels, not timing or hooks — getting a real span requires wrapping `.run()/.all()/.get()` exactly
  like the existing fetch/XHR interceptors, and `bun:sqlite` itself is a narrow surface (only apps
  using it directly, not through an ORM/driver most Bun users actually pick). Not worth a
  Bun-exclusive integration for the audience size.
- **Treating Bun's `--cpu-prof` CLI flag as a capture mechanism.** It's launch-time-only with no
  programmatic start/stop (there's an open, unresolved feature request for a programmatic API —
  [oven-sh/bun#28204](https://github.com/oven-sh/bun/issues/28204)). The SDK's existing
  `node:inspector`-based rolling profiler already gives strictly better (in-process, rolling,
  segment-able) coverage on Bun; this flag adds nothing on top of it.
- **Relying on Deno's `node:diagnostics_channel` compat as fully symmetric with Node's real
  implementation.** Even though Deno's compat matrix lists it as fully implemented, I could not
  independently verify that Deno's own internals actually *publish* to the same built-in channels
  (`http`, `net`, etc.) Node's do — the module's own doc page is silent on that specifically. Treat
  channel *plumbing* as verified but channel *population* as `unverified` until checked against a
  running Deno process; don't design a Deno-only diagnostics_channel-based capture source on the
  strength of the compat-matrix line alone.
- **A Deno in-process heap-snapshot replacement.** I looked for one (a `Deno.core` internal, a
  `Deno.inspector`-style API) and found none in current docs — `node:v8`'s `writeHeapSnapshot` throws
  on Deno, and `node:inspector`'s `HeapProfiler` domain is one of the non-functional stubs. The only
  path found is external `--inspect` + a real DevTools/CDP client, which isn't something the SDK can
  drive in-process. Don't scope a Deno heap-snapshot feature until/unless this changes.

## What I could not verify

- Whether Deno's own `Deno.serve`/`fetch` internals actually populate the `http`/`net` built-in
  `diagnostics_channel` channels the way Node's do (see above).
- The exact Bun version `node:diagnostics_channel` support and `--cpu-prof` landed in — both are
  confirmed present in *current* docs but I could not pin an exact version number from official
  release notes within this pass; treat both as "true as of Bun 1.3.x, not confirmed for the SDK's
  declared 1.1+ floor."
- Whether running the SDK's own OTel exporter alongside `OTEL_DENO=true` on Deno actually causes
  duplicate `console.*`-as-log export or any span conflict in practice — this needs a live two-way
  test, not just doc-reading.
- `node:perf_hooks` `PerformanceObserver`'s exact entry-type coverage on Deno (marks/measures
  confirmed; `net`/`http` entry types were not explicitly confirmed one way or the other in the pages
  fetched).
