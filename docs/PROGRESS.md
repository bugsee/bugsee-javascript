# Bugsee JavaScript SDK — Implementation Progress (Hand-off)

**Status as of 2026-05-30 (the original hand-off snapshot; see the dated deltas below for later work).** Repo migrated to **GitHub** 2026-07-16: `origin = https://github.com/bugsee/bugsee-javascript` (sole remote), default branch `main`; a **GitHub Actions CI gate** (`.github/workflows/ci.yml`) runs lint / typecheck / cycles / per-package coverage on every push + PR (§6).

A **runnable Node SDK** exists: capture (console + network + system traces/events), report assembly + signed-PUT upload, uncaught-exception detection with flush-then-exit, and a durable bundle queue that re-uploads crash bundles on the next launch. Public launch-options use Android's canonical `com.bugsee.option.*` identifier scheme internally + on the wire. Every shipped slice was built test-first, mutator-verified, gated at 100% line/fn/stmt + ≥90% branch per package, and passed a multi-agent convergent review.

Read this first; then `docs/design/sdk-design.md` (Draft v3) for the full architecture; then `docs/implementation-standards.md` (§2 mutator loop, §6 multi-agent review — both binding); then `docs/dev-environment.md` for tooling/commands; then `CLAUDE.md` for the per-session distilled rules.

---

## 1. What's implemented

### Tier-0 (foundations — no Bugsee dependencies, pure libs)
| Package | Role |
| --- | --- |
| `@bugsee/types` | Shared TS types (`NameExtensionMapping`, `AccessToken`, `IssueId`, `LogLevelName`, `SeverityName`, …) consumed via declaration merging. |
| `@bugsee/util` | Pure helpers: `fflate` re-export (`zipSync`/`unzipSync`/`gzipSync`/`gunzipSync`/`strToU8`/`strFromU8`), `sha256Hex` (WebCrypto-only; rejects `NotSupportedError` without `crypto.subtle`), `computeBackoff`, `utf8ByteLength` (allocation-free UTF-8 byte measure for the capture-store byte cap). |
| `@bugsee/logger` | Debug logger (`debug.warn` etc.); platforms route `onError` here. |
| `@bugsee/protocol` | Wire types (`RequestJson`, `EnvironmentEnvelope`, `NetworkEvent` superset incl. `'http'` mechanism, `NetworkStage`, `FileType`, `Mechanism`), `Severity` enum + level conversions, header/JSON/params sanitizers, shape redaction, **`BugseeOption` canonical identifiers + `optionsToWire` (dots → colons)**. |
| `@bugsee/service` | The DI/IoC container: `createServiceContainer`/`defineService`/`Provider` (Firebase-component model, LAZY/EXPLICIT, lazy resolution, deps-via-container, `onInit`, late registration). The backbone of the **internal aggregated object** (see DI note below). |

### Kernel — `@bugsee/core` (the thin kernel; runtime-portable)
- **`Client`** (`createClient`) — composition root: identity/attributes via the single global `Environment`, manual capture (`addBreadcrumb`/`log`/`event`/`trace`/`logException`), provider/extension registration, lifecycle (`launch`/`isLaunched`/`stop`/`flush`). `flush()`/`stop()` await both `uploadPipeline.flush` AND in-flight **report promises** (the path that lets crash flush-then-exit deliver), bounded by an unref'd deadline. **Identity reaches the wire (audit fix A):** `setUserIdentifier` → `request.json.email` at assemble time (Android maps the user identifier to the `email` field — "email from global scope"; no separate `user` field, no `setEmail`). **Internal object / DI (Phase 1, `docs/design/internal-object-di.md`):** the Client now owns a per-process `ServiceContainer` (the "BugseeInternal" — the internal aggregated object); `addService`/`getService`/`getServiceProvider` (a typed `ServiceToken<T>` facade over the generic `@bugsee/service` container — see §7 "DI token migration") + `getInternal(carrier)` reach it process-wide via the singleton client. **Phase 2 (delivers E) — redaction filters as the first real service:** a `filters` service (`FilterStore`) registered in the container; the facade `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`/`setReportHandler` mutate it; the capture pipeline (network/log providers, `addBreadcrumb`, the report path) reads it LIVE via `getFilters()` (the singleton client on the carrier). Filter = mutate or return null to DROP; a throwing filter drops (privacy-safe) + one `onError`. The user network filter REPLACES the built-in sanitizer (Android XOR); the default sanitizer is now gated on `CaptureNetworkDefaultSanitizer`. Report `before` mutates/vetoes before assembly. **Phase 3 (COMPLETE) — every platform seam is a container service, resolved by a typed `ServiceToken`:** Node `launch` creates the `ServiceContainer`, registers the HTTP `transport` (and the rest of the seams), resolves it to build the pipeline, and hands the SAME container to `createClient`; the client exposes `getService(TransportToken)`. Behavior-preserving (the `internalTagged`/override path is unchanged). The full token set, the `ServiceToken` migration (replacing the old `NameServiceMapping` declaration-merge), and the carrier-hosted service-manifest auto-registration path are in §7 "DI Phase 3 / token migration". **Lifecycle (audit fix B):** `logException` after `stop()` is a silent no-op (§1501) until re-launch (a `stopped` flag distinct from `!launched`, so pre-launch capture is unaffected). **Kill-state (audit fix D, §1435/§1504; REVISED — see the note below):** the collector's `KILL_SDK` code (`99099`) — and ONLY that — sets `BugseeError.fatal`, which `track()` observes on any report result and which flips the client PERMANENTLY dead: one-time `onError`, capture+detection halt, all capture/`logException` no-op, and `launch()` won't re-arm a killed client. **An HTTP 401/403 no longer kills the client.** It used to, on the theory that a 401/403 on session create meant an invalid app token — but the collector never answers that way: the appserver returns HTTP **200** with an envelope error code (`error.router.js:50` calls `res.code(200)` unconditionally), so an invalid token arrives as code `14019`, which classifies as `permanent` (drop this bundle) and not as `kill_sdk`. A raw 401/403 is therefore an infrastructure answer — a proxy, a WAF, an expiring session mid-upload — and killing the SDK on one silently ended capture for the rest of the process. It is now RETRYABLE. The collector-code namespace (`classifyServerErrorCode`, `transport.ts`) is disjoint from HTTP statuses and is the only thing that carries a control verdict; `BugseeError.code` is the HTTP status (`0` when no response was reached) and `BugseeError.serverCode` is the collector code.
- **Capture data model** (Android aggregator parity): one-way flow `CaptureProvider → CaptureAggregator → CaptureStore (Part/PartManager) → CaptureExporter → bundle`. `CaptureDataEntryBase` + `defaultEntryFactory`. No `Scope` (one global Environment); breadcrumbs are a capture stream.
- **Stores**: `createMemoryCaptureStore` (in-memory); `createFileCaptureStore(adapter, opts)` with per-launch GENERATIONS (`<gen13>__<part12>__<type>`, fresh launch cleans other generations). Both are bounded by TWO axes (drop-oldest whole CLOSED parts, design A1): the time window (`maxRecordingTimeMs`) AND an optional `maxDataSizeBytes` byte cap (slice #34) enforced on `add` via a running UTF-8 byte total (the open current part is never evicted — a single oversized part is a documented soft over-shoot). Byte measure = `@bugsee/util` `utf8ByteLength` (pure, allocation-free); the memory store counts the serialized string, the file store the encoded on-disk line.
- **PartManager + tick**: 1-second parts with rotation + out-of-window cleanup driven by the client's `Scheduler` (`setInterval`-based, unref'd by default).
- **Coordinators**: `CaptureCoordinator` (init-once via `CaptureProviderInit { operations, captureAggregator }`, start-with-options, gated by `controllingOption`), `DetectionCoordinator` (start-with-onReport, same gate).
- **Trigger + Upload pipelines**: `createTriggerPipeline` (serialized assemble, `maxQueueDepth`), `createUploadPipeline` (session→issue→signed PUT, retry/backoff, 403→renew, bounded inFlight). `BugseeApi` + `BundleUploader` over an injected `HttpTransport` (transport logic is core, the primitive is platform).
- **Durable bundle queue** (`createDurableUploadPipeline`, slice #33): persists each bundle (length-prefixed `[4B LE hdr len][request+fileName JSON][zip body]` via `serializeBundle`) BEFORE upload, removes only on confirmed delivery (resolves AFTER removal so the crash flush awaits cleanup), `recover()` re-uploads leftovers and purges corrupt frames. `BundleStore` adapter seam.
  - **`UploadResult.retained` — who owns an incident that did not settle.** A report marker is the ONLY trace of an incident whose bundle never reached durable storage, and it also pins that incident's capture generation against the recovery sweep, so retiring one early loses the report AND the recording. The client therefore retires a marker on exactly two conditions (`client.ts`): the upload SETTLED (delivered, or permanently refused), or the queue RETAINED the bundle — the bytes are durably staged, so the next launch replays and reconciles. Anything else keeps the marker. `retained` is the queue's answer to "do I own this now", and it must be TRUE, not assumed: the queue deliberately catches a failing `BundleStore.put` and attempts the upload anyway (a full disk should still get the crash out), and nothing is staged in that case.
  - **`BundleStore.put` returns `void | Promise<void>`.** It was `: void`, which made an ASYNCHRONOUS durability failure unlearnable — and the browser/worker store is IndexedDB, where `put` is accepted into an in-memory mirror and persisted off the hot path, so it cannot throw synchronously. `retained: true` was consequently unconditional on the one tier where quota exhaustion is the routine failure. A store that completes asynchronously now returns a promise, the queue awaits it before deciding `retained` (never before ATTEMPTING the upload), and `createPersistentBundleStore` surfaces the rejection instead of swallowing it to `onError` — while still marking it handled, so a caller that ignores the return cannot leak an `unhandledrejection` into the host page.
- **Interceptor base** (`InterceptorBase` extends `MultiKeyEmitterBase`): subscriber-presence + explicit `start`/`stop` activation; `onActiveChange` calls abstract `onActivate`/`onDeactivate`. `Interceptor` contract.
- **Carrier** (slice #47, `carrier.ts`): process-global singleton registry at `globalThis.__BUGSEE__[BUGSEE_SDK_VERSION]` (version-keyed, null-proto; design §4.2/§214). `getCarrier(globalObj?)` + `getOrCreateInterceptor(name, factory, globalObj?)` — module-duplicated copies (within one SDK version) converge on ONE interceptor instance per `name`, so a runtime global is patched exactly once (first-config-wins). Factories stay pure; dedup happens at the composition layer (`installNetworkCapture`/`launch`) via an injectable `carrier` seam (default `globalThis`). The open `InterceptorBase` refcount keeps a shared patch alive while any consumer subscribes.
- **Multi-key emitter** (`EventSubscribable`/`MultiKeyEmitter`/`MultiKeyEmitterBase`): `on`/`once`/`off`/`onAny`/`removeAllListeners`/`emit`; per-listener try/catch; snapshot-and-recheck during iteration.
- **Detection-provider base** (`DetectionProviderBase`) + crash/error `createReportingRequest` + `Report` shape.
- **Options scheme** (slice #52): `OptionDefinition` (friendly ↔ canonical key + default), `COMMON_OPTION_DEFINITIONS`, `resolveLaunchOptions(friendly, defs)` → `{ canonical, options: OptionsContainer (keyed by identifier), isEnabled (enabled unless `=== false`) }`. Providers' `controllingOption` = the dotted `BugseeOption.*` constants.
- **Misc**: `createRateLimiter` (storm protection), `dedup` (instance-dedup for re-captured `Error`s), V8 stack parser + scrubbing, `BugseeError` (status carried as `code`).
- **`onError` seam**: provider-start failures + operation-observer failures route here; default no-op. Platforms wire to `@bugsee/logger`.

### Shared capture — `@bugsee/capture` (tier-3, cross-runtime)
- **Console interceptor + log provider** (`createConsoleInterceptor`, `createLogCaptureProvider`): re-entrancy-guarded console patch → `LogEvent` source → `log` entries.
- **Network sources** (all `InterceptorBase`-driven, self-skip when the global is absent):
  - `createFetchInterceptor` (fetch, injectable `FetchTarget`).
  - `createXhrInterceptor` (prototype-wrap, `WeakMap` state).
  - `createWebSocketInterceptor` (subclass-wrap, directioned frames).
  - `createSseInterceptor` (subclass-wrap, read-only `'in'` messages).
  - `createWebTransportInterceptor` (subclass-wrap, method `CONNECT`).
  - `createNetworkInterceptor(...sources)` — umbrella that `onAny`-aggregates subs + re-emits.
- **`installNetworkCapture(opts)`** — one-call wiring of every cross-runtime source under the umbrella + the `networkProvider`. Threads shared `now`/`isInternal`/`fetchTarget`; folds in platform sources via `additionalSources` (Node's `node:http`).
- **`networkProvider` body policy (slice F.1):** per event, `#gateBody` runs FIRST (always) — the `captureNetworkBodies` master toggle strips the body (no reason), else `gateNetworkBody` applies the size + Content-Type gate (`maxNetworkBodySize`/`captureNetworkBodyWithoutType` → `no_body_reason`). THEN the existing XOR: a user network filter REPLACES the default sanitizer; the default sanitizer now also runs `sanitizeBody` on `custom.body` (header + body redaction). The producer interceptors don't set bodies yet (F.2–F.4); the policy is in place and unit-tested with synthetic events.
- **System providers**: `createSystemTracesProvider({ sample })` (periodic + initial snapshot, gated `captureSystemTraces`), `createSystemEventsProvider(source)` (`event`-channel subscriber, gated `captureSystemEvents`).
- **Network self-isolation**: default `isInternal` checks `x-bugsee-internal` header (case-insensitive); the Node launch wraps the transport to stamp this on every SDK request (control plane + S3 PUT).

### Node platform
**`@bugsee/node-utils`** (shared by node/bun/electron):
- `httpRequest` — `HttpTransport` over `node:http`/`node:https` (gzip/deflate decode, timeout, non-2xx resolves; the only platform-specific transport piece).
- `fs-storage` helpers (sync, owner-only `0o600`/`0o700`): `ensureDir`, `writeFileSecure`, `appendFileSecure`, `readFileBytes` (Uint8Array), `listFiles`, `remove`.
- `createNodeFileStorageAdapter(dir)` — core's `FileStorageAdapter` impl.
- `createNodeBundleStore(dir)` — core's `BundleStore` impl (`<id>.bundle` files).
- `nodeSha256Hex` / `nodeSha256Fallback()` — `node:crypto` upload-checksum digest; node launch injects it into core's upload pipeline (`sha256` seam) ONLY where `crypto.subtle` is absent (2026-09-16).

**`@bugsee/node`**:
- `buildNodeEnvironment(input, probe)` — §8.6 envelope via injectable `SystemProbe`. Applies `optionsToWire` to `sdk.options` (dots → colons; server treats dots as nested-document paths).
- `createUncaughtExceptionProvider` / `createUnhandledRejectionProvider` — process-event detection, V8 stack parsed + scrubbed.
- `createNodeHttpInterceptor` — wraps `node:http(s)` `request` + `get` (mechanism `'http'`), captures axios/got/node-fetch that bypass global fetch. **Transparent error handling**: re-raises the original error when it is the sole `'error'` listener so an otherwise-uncaught request error still crashes the app.
- `createNodeSystemMetricsSampler` — process memory (rss/heapTotal/heapUsed/external/**arrayBuffers**), **system memory (`ram_system_total`/`ram_system_free` — Android parity)**, CPU user/system per-sample deltas + **normalized `cpu_usage_process` %** (over wall-time/cores), event-loop lag **mean/max/p99** + **utilization** (perf_hooks `monitorEventLoopDelay` + `eventLoopUtilization`). All readers injectable.
- `createNodeSystemEventsSource` — process lifecycle (`process_started` on activate, `process_exiting`, **`process_before_exit`** clean-drain, `process_warning`, and **`process_signal`** for SIGTERM/SIGINT). Signal capture is PASSIVE: it emits the event, and only when the SDK is the sole handler does it remove itself and **re-raise** (`process.kill`) to restore Node's default termination — so it never hangs a process or hijacks an app's own signal handler.
- **`launch(appToken, options)`** — the composition root: builds the transport (internal-tagged), api/uploader/upload pipeline, durable wrapper (when `dataDir`/`bundleStore` present), env builder, store (in-memory / file-backed), resolves the friendly options once via `NODE_OPTION_DEFINITIONS`, registers gated capture providers (console→log; network umbrella with `node:http` folded in; system traces/events) + detection providers, calls `client.launch()`, runs durable `recover()` on start, installs the uncaughtException → `flush(timeout)` → `proc.exit(1)` policy (opt-out `exitOnUncaught`, default `shutdownTimeoutMs: 3000`), and augments `client.stop()` to remove its process listener. Returns the started `BugseeClient`.

### Browser platform (Milestone 3 — COMPLETE, on `main`)
**`@bugsee/browser-utils`** (runtime primitives, shared by browser/web-worker/service-worker):
- `fetchTransport` / `createFetchTransport(fetchImpl?)` — `HttpTransport` over `fetch` (AbortController timeout, string/Uint8Array body, lowercased response headers, non-2xx resolves). Drops the node gzip/Accept-Encoding logic (the browser owns content negotiation).
- `createIdbBlobStore(opts)` — a minimal async key→bytes `AsyncBlobStore` over IndexedDB (memoized open, injectable `IDBFactory`); `createIdbKeyedStore(opts)` — an `AsyncKeyedStore` with prefix range reads/deletes (`put`/`readPrefix`/`deletePrefix`), the substrate for the chunk backend.
- `createPersistentBundleStore(blob, onError?)` — the SYNC core `BundleStore` over async IDB via an in-memory mirror + async write-through + `whenReady` hydrate-on-open (a `touched` set so a live put/remove during hydration wins).
- `createIdbChunkBackend(keyed, {generation, cleanOtherGenerations?, onError?})` + `createIdbChunkCaptureStore(keyed, opts)` — the durable IndexedDB `CaptureStore`, **durable-as-captured** (replaces the removed B5b `createPersistentCaptureStore` in-memory mirror): each captured entry is written through as `d/<gen13>/<chunk12>/<seq12>` and each chunk's metadata as `m/<gen13>/<chunk12>` (the same chunk-group model as the node file store, over async keyed records). Writes are sync-issue / async-complete on a single in-order queue (loss window ≤1 entry); `snapshot()` pins frozen parts (eviction defers the delete until `release()`) and reads each part's data range bounded by the snapshot-time count; `listParts`/`listGenerations` read durable meta (the recovery index). See the capture-storage note below.

**`@bugsee/browser`**:
- `buildBrowserEnvironment(input, probe)` — §8.6 envelope (`platform.type: 'web'`) via injectable `BrowserProbe` (navigator/screen/Intl; raw UA as `platform.version` — backend parses; deviceMemory/hardwareConcurrency optional). `optionsToWire` on `sdk.options`.
- `createWindowErrorProvider` / `createUnhandledRejectionProvider` — window `error` → crash / `unhandledrejection` → error; `parseStack` dispatches V8 (`at fn (loc)`) vs SpiderMonkey/JSC (`fn@loc`) dialects (core's `parseLocation` reused).
- `createBrowserSystemTracesSampler` (traces: `ram_js_heap_*` (grouped, Android `ram_jvm_heap` parity) + `connection` (transport name from the viewer's CONNECTION_STATES vocabulary, `navigator.onLine` first) + `orientation` (the Android/iOS `Orientation` int, never the browser's `{type, angle}`) + `battery`/`charging`, each degrading where its API is absent) + `createBrowserSystemEventsSource` (events: `process_started`, `pagehide`→`process_exiting`, `visibilitychange`→`process_foreground`/`process_background`, `online`/`offline`, `orientationchange`→`orientation_changed`). See the capture-completeness milestone in §7.
- `createBrowserInputSource` (input: capture-phase/passive DOM listeners → the dedicated **`input`** stream (`input.json`) via the runtime-agnostic `createInputProvider`) — **pointerdown/pointerup/pointercancel** (Pointer Events, so `pointerType` gives the wire `tool` for free and a touchpad correctly reports Mouse; `pointerId` keys the gesture; `button` covers secondary/middle) + **keydown**, emitting the viewer's `RecordingTouchEvent` shape. (`change`/`submit`/`focus` left this stream on 2026-08-31 — they are state-change signals, not device input; see `createUiBreadcrumbSource` below.) PII-safe `describeTarget` (tag/id/class/type/text/selector) masks anything matching the SHARED sensitive-input definition or `[data-bugsee-hidden]`; typed text never captured (AltGr/emoji/IME-robust); **every keystroke aimed at a sensitive/masked field is dropped outright**; throw-isolated. **It does NOT write to `events.user`** — see the `*.user` rule below. See the capture-completeness milestone in §7.
- `createUiBreadcrumbSource` / `createUiBreadcrumbProvider` (**UI breadcrumbs**, 2026-08-31): the state-change half of the DOM interaction split — capture-phase/passive listeners for `change`/`submit`/`focusin` → `client.addBreadcrumb` (so the app's `breadcrumbFilter` runs) in Android `BreadcrumbInputGesture`'s shape: `{type:'user', category:'ui.change'|'ui.submit'|'ui.focus', level:'info', data:{'view.id','view.class','view.tag'}, timestamp: the DOM event's own moment (`performance.timeOrigin + Event.timeStamp`, clamped to now)}`. `type:'user'` is Android's literal for a user-ORIGINATED breadcrumb — **not** the `*.user` stream (these are `breadcrumbs` entries). Why not `input`: `InputEvent.type` is Android's `InputEventStage` (`unknown|begin|move|end|scroll|keydown|keyup`), which a DOM-only value cannot join, and Android already splits its input dispatcher (→ `input.json`) from its gesture dispatcher (→ breadcrumbs). Reuses `describeTarget`; a sensitive/app-masked target **drops the breadcrumb outright** (the focus/change rhythm on a masked field is itself a side channel). Gated by `captureInteractions` (the option means "do not watch what I click and type", whatever stream it lands on). Wired into `@bugsee/browser` **and** `@bugsee/webview` (which also now declares `breadcrumbs` in `hello.caps`).
- `createDomSnapshot` / `createViewtreeSnapshotSource` (view hierarchy: an at-report DOM-tree snapshot → `viewtree`, via the core `reportSnapshots` pull-seam) — reuses `describeTarget` per node + rounded `getBoundingClientRect`; masked subtrees collapse to `{tag, masked, rect}`; bounded (maxNodes/maxDepth) + per-node throw-isolated. Gated by `captureViewHierarchy`. See §7.
- **`launch(appToken, options)`** — the browser composition root (fetch/DOM analog of node's): fetch transport (internal-tagged), api/uploader/upload pipeline, browser env, in-memory store (or IndexedDB-backed when `persist:true`), gated capture providers (console→log; network umbrella, NO `node:http`; system traces; system events; user-interaction input) + detection providers, `client.launch()`. **No `process.exit` path** (the browser flushes via the pipeline/`pagehide`; `stop()` only clears the carrier). `persist:true` builds an IndexedDB durable bundle queue (crash recovery across reload — `recover()` deferred to the store's `whenReady`) + the durable IndexedDB chunk capture store (`createIdbChunkCaptureStore` in its own `bugsee-capture` db). `maxDataSize` defaults to 10 MB. **Session replay is ON by default** (2026-08-27) — parity with the iOS/Android SDKs, which record by default; `replay: false` is the opt-out and is the ONLY value on which `import('@bugsee/replay')` is never evaluated, so an errors-only integration still pays nothing for rrweb (the lazy chunk + the opt-out carry the bundle-size budget, not the default). Masking stays fail-closed on the default path (mask all text/inputs, block all media); `replay.canvas` stays opt-in. Returns the started `BugseeClient`.

### Integration shims — `@bugsee/integration-shims` (tier-3 leaf, slice #13)
No-op stand-ins for DOM-only integrations on DOM-less runtimes (design §372). `createNoopCaptureProvider`/`createNoopInterceptor` (extend `CaptureProviderBase`/`InterceptorBase`) + named shims `createViewHierarchyProviderShim`/`createBreadcrumbsProviderShim`/`createXhrInterceptorShim`. Each is a structurally-valid provider/interceptor that captures nothing and warns ONCE (`logger.warnOnce`, keyed `shim:<name>`, message `<name> is a no-op on <runtime>; ignored`) on ACTIVATION (provider start / interceptor activate) — construction is side-effect-free. Logger (`Pick<Logger,'warnOnce'>`) + runtime label are injected by the platform (runtime-agnostic). **`replay` is intentionally NOT a shim** (design §372: option-driven, ignored-with-warn at option resolution). Per-platform named re-exports land with the platform packages.

### Formerly-scaffold packages (now all built)
No unbuilt feature stubs remain — `@bugsee/replay-canvas` (the opt-in canvas-replay add-on) is now built (RPC1–RPC6, `docs/design/replay-canvas.md`). `vite-plugin`/`webpack-plugin` are intentionally **thin re-export wrappers** over the built `@bugsee/bundler-plugin-core` (the #158 source-map / debug-id tooling — DONE), not stubs. Everything else once listed here is now built + on `main`: `bun`/`deno`/`webworker`, `performance` (APM), **`replay`** (session replay, RP0–RP6), **`electron`** (E0–E8, convergent-reviewed — main+renderer+native convergence + opt-in pixel video D8; `docs/design/electron.md`), `bugsee` (umbrella), `cloudflare`/`vercel-edge` (edge), the frontend adapters (`react`/`vue`/`svelte`/`solid`/`angular`/preact-compat), the meta-framework adapters (`nextjs`/`nuxt`/`remix`/`sveltekit`/`astro`), and the backend adapters (`express`/`fastify`/`hono`/`elysia`/`nestjs`/`koa`/`hapi`).

---

## 2. Architecture as implemented (deltas from the design doc)

| Design (Draft v3)                          | As implemented                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources → hubs → providers`               | **No hubs.** Interceptors are themselves listenable (`InterceptorBase` extends `MultiKeyEmitterBase`); providers subscribe to interceptors directly; subscriber-presence drives activation. |
| Capture providers serialize entries        | **No serialize on providers.** Providers push `CaptureDataEntry` to one `CaptureAggregator`; the codec lives on the store/exporter (Android adapter parity).               |
| Scope per session                          | **No `Scope`** — single global `Environment` on the Client (Android parity).                                                                                                 |
| Stage hooks via `createHooks` primitive    | Hooks rolled INTO the interceptor: components subscribe via `on()`/`onAny()` on the interceptor itself.                                                                      |
| BugseeApi/BundleUploader per platform      | **Core**, not per-platform — logic is platform-agnostic over an injected `HttpTransport`. Only the transport primitive (`httpRequest` on Node) is platform.                  |
| `NetworkEvent.mechanism` minimal           | **Superset**: `'fetch'\|'xhr'\|'ws'\|'sse'\|'sendBeacon'\|'webtransport'\|'http'`. `'http'` added for `node:http` (axios/got bypass `fetch`).                                |
| `environment.sdk.options` keyed freely     | **Android canonical**: keys are `com.bugsee.option.*`; wire form is colon-separated (`optionsToWire`) because the server treats dots as nested-document paths.               |
| `flush()` awaits `uploadPipeline.flush`    | Also awaits in-flight **report promises** (assemble→enqueue→upload), so crash flush-then-exit can actually deliver.                                                          |
| Guaranteed crash delivery                  | **Durable bundle queue (#33)**: persist before upload, remove on confirmed delivery, `recover()` re-uploads leftovers on next launch. At-least-once (server-side dedup).    |
| Interceptor singletons (implicit)          | **Process Carrier (#47)**: `globalThis.__BUGSEE__[version]` version-keyed slot; interceptors are obtained via `getOrCreateInterceptor(name, …)` so module-duplicated copies share ONE instance / ONE global patch. Factories stay pure; dedup is at the composition layer (injectable `carrier` seam). The carrier also holds a **`client` slot** (`getCarrierClient`/`setCarrierClient`, design §473) — used by audit fix C to make Bugsee a **per-process singleton**: a second `launch()` warns (via `onError`) and returns the first client; `stop()` releases the slot so a later launch builds fresh. (`§1498` different-token auto-relaunch remains a documented gap.) |
| `BugseeOptions` typed schema (TODO)        | **Done** — extensible `BugseeOptionTypes` (declaration-merged), `OptionDefinition` + `COMMON_OPTION_DEFINITIONS` + `resolveLaunchOptions`. Public API stays friendly.       |

Pluggable extensions (APM/replay/etc.) remain the contract for non-core features — none built yet. Read design doc §16 *together with* this delta table.

---

## 3. Adapter / portability seams

| Seam | Shared (core) | Node | Browser / others (planned) |
| --- | --- | --- | --- |
| HTTP primitive | `HttpTransport` (type) | `httpRequest` (node:http/https) | fetch/XHR wrapper |
| Capture store | `createMemoryCaptureStore`; `createFileCaptureStore(adapter)` | `createNodeFileStorageAdapter` | `createIndexedDbCaptureStore` (shared by browser + workers) |
| Durable bundle queue | `BundleStore` (type) + `createDurableUploadPipeline` | `createNodeBundleStore` (fs files) | IndexedDB-backed |
| Capture sources | `console`, `fetch`, `xhr`, `sendBeacon`, `ws`, `sse`, `webtransport` (self-skip if absent) | `node:http` added via `installNetworkCapture({ additionalSources })` | DOM-specific sources |
| Process events | — | `process` (`uncaughtException`, `unhandledRejection`, `exit`, `warning`) | `window.onerror`, `unhandledrejection` |
| System metrics | `TraceSample[]` sampler injected | `createNodeSystemMetricsSampler` | `performance.memory` etc. |
| Clock / Scheduler / SystemProbe | injectable interfaces in core | real defaults (`Date.now`, `setInterval`, `os.*`) | platform defaults |

Cross-runtime capture interceptors **self-skip when their global is absent**, so `@bugsee/capture` can be imported safely on any runtime; only the runtime-specific *additionalSources* differ.

---

## 4. Verified by

- **~1017 tests** across the workspace (`pnpm test`), Vitest. Coverage gate **100% line / function / statement, ≥90% branch (aggregate) PER PACKAGE** — failing the gate fails the run.
- **Test-first + mutator loop** on every entity (binding standard, `docs/implementation-standards.md` §2): inject a bug → confirm a test catches it → restore. Documented behaviorally-inert exceptions exist only for memory-hygiene cleanup lines with no observable behavior.
- **End-to-end loopback** for the Node SDK (`packages/node/src/launch.integration.test.ts`): real `http.createServer`, full `session → issue → signed PUT` with a real `node:http` transport and a real zip bundle; plus a recovery e2e that drops a serialized bundle on disk, launches, and asserts re-upload + file removal.
- **Multi-agent convergent review** per feature (binding standard §6): for big features (kernel rebuild, Node launch, recovery, options scheme) ran fresh parallel reviewers (correctness / test quality / architecture) until a round yielded zero new real findings. Notable bugs caught this way:
  - Leaked `uncaughtException` handler that survived `client.stop()` (fixed: launch augments `stop` to `proc.off` it).
  - `node:http` interceptor silently swallowing an otherwise-uncaught request error (transparency violation; fixed: re-raise when sole `'error'` listener).
  - `track()` could surface an unhandled rejection if a report ever rejected (hardened: `.then(forget, forget)` not `.finally`).
  - Tautological tests (onError "test" that never asserted onError; crash test that didn't pin delivery-before-exit ordering; rejection-drain test that only relied on vitest's runner) — all upgraded to explicit assertions.

---

## 5. Commands

Reference: `docs/dev-environment.md` "Commands". Quick view:

```bash
pnpm test                                 # all tests
pnpm test:coverage                        # all tests + coverage (per-package gate)
pnpm typecheck                            # tsc --noEmit per package (vitest does NOT typecheck)
pnpm lint / pnpm lint:fix                 # biome
pnpm check:cycles                         # madge
pnpm --filter @bugsee/<pkg> exec vitest run src/<file>.test.ts   # single test file
pnpm --filter @bugsee/<pkg> exec tsc --noEmit                    # single-package typecheck
```

Pre-commit: run `pnpm lint && pnpm typecheck && pnpm check:cycles && pnpm test` (no automated git hook installed). CI enforces the same gate on every push to `main` + every PR (`.github/workflows/ci.yml`; coverage runs per-package via `turbo run test:coverage`).

### Supported runtime versions (2026-06-15, matching Sentry's "Node 18+")
- **Node ≥ 18** — declared (`engines` on root + `@bugsee/node`/`node-utils`/`express`/`fastify`) and
  **verified by running the real SDK on Node 18 & 22** (AsyncLocalStorage.enterWith, the express adapter +
  full report pipeline + contextId tagging, global fetch, node:inspector CPU profiling, the
  worker_threads/SharedArrayBuffer ANR watchdog — all pass). Nothing in the shipped code needs > Node 18
  (no ES2023-only methods; `randomUUID` from `node:crypto`); newer **optional** globals (`WebSocket`
  Node 21+, WebCrypto, `fetch`/`ReadableStream`) are **capability-guarded → graceful degradation**.
- **Deno ≥ 2.0** — chosen to match `@sentry/deno` (which declares 2.0.0 since its v8→v9) and **verified by
  running the real SDK on Deno 2.0.0**: the core (context foundation + adapters' enterWith, report pipeline
  with contextId tagging, the `platform.type: 'deno'` identity) works; the **diagnostics degrade gracefully
  on 2.0** — CPU profiling (`node:inspector` not yet in Deno 2.0's node-compat) and the ANR watchdog
  (worker_threads node-compat incomplete) self-disable rather than crash (the ANR worker fix above made the
  Deno-2.0 path graceful instead of throwing). **Full support incl. diagnostics on Deno 2.8+** (verified).
- **Bun ~1.1+** — inferred floor, tested only on Bun 1.3 (full feature set incl. profiling + ANR works).
  Not pinned/version-matrix-tested.
- **Tooling caveat:** **vitest 4 cannot run on Node 18** (its `rolldown` dep uses `node:util.styleText`,
  Node 20.12+), so `pnpm test` needs Node ≥ 20; test SDK *code* on Node 18 via `tsx`, not vitest.
- **Node-version matrix — DONE as a portable nvm script (2026-06-20):** `pnpm test:matrix`
  (`scripts/test-matrix.sh`) runs a vitest-free scenario smoke (`packages/instrumentation-tests/smoke.ts`:
  the off-thread disk-capture worker path + the incoming-server context path) via `tsx` under each installed
  Node version — so it covers Node 18, where vitest can't load (`--full` also runs the unit suite on ≥20).
  Complements CI: the GitHub Actions gate runs the unit suite on Node 22; this matrix adds the Node-18 / multi-version smoke vitest can't run. **It caught two real Node-18 crashes** — both used
  the global `crypto` (unflagged only on Node 19+): `instance-layout`'s subtree nonce (→ every disk launch)
  and the per-request context-id minter (`server-instrument` + 4 adapters → every instrumented request).
  Fixed (`node:crypto` for instance-layout; a portable `@bugsee/util` `randomId()` for the minters);
  re-verified green on real Node 18.20 / 22 / 24.

---

## 6. Conventions (binding)

- **`*.user` streams are the APPLICATION's, never the SDK's** (binding, product owner, verbatim):
  > *"'events.user' is totally the wrong target for it. SDK code MUST NOT write anything into 'user.\*'
  > streams. These are for user supplied data."*

  `events.user` / `traces.user` carry ONLY what the app wrote through `client.event()` / `client.trace()`.
  Anything the SDK OBSERVES gets its own stream — device input goes to **`input` → `input.json`**
  (`createInputProvider` in `@bugsee/capture`), never `events.user`. If you find yourself reaching for a
  `user.*` FileType from SDK code, register a new FileType instead (`packages/protocol/src/constants.ts`,
  plus `upload-contract.schema.json` — a drift test enforces the pair — plus, for a stream a WebView emits,
  `packages/webview/bridge-protocol.schema.json` and the webview `CAPABILITIES` list). Design §8.4.1.
- **One definition of "sensitive field"**: `SENSITIVE_INPUT_MATCHERS` / `isSensitiveInput` in
  `@bugsee/core` (`sensitive-input.ts`). `@bugsee/replay`'s masking floor, `@bugsee/webview`'s obscuring
  source and the browser input source all derive from it. It was copied three ways once and the copies
  drifted — an `autocomplete="CC-NUMBER"` field was legible in native video frames while replay masked it.
  Shape it (prefix an element name, build a `:not()` guard) but never restate it.
- **Git remote is GitHub** (migrated from Gerrit 2026-07-16): `origin = https://github.com/bugsee/bugsee-javascript` (sole remote), default branch `main`. Use the `gh` CLI / PR flow; direct `git push origin main` also works. A **GitHub Actions CI gate** (`.github/workflows/ci.yml`) runs lint → typecheck → cycles → per-package coverage on every push to `main` + every PR — keep it green.
- **Commit trailer**: every commit ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **TDD / mutator loop** (binding, §2): no implementation without a failing test first; for every new/changed entity inject a mutation, confirm a test fails, restore; never commit a mutation. Hard limit 10 iterations per entity — if a mutation survives, strengthen the test.
- **100% line/fn/stmt + ≥90% branch per package**, run on each commit; failing the gate fails the commit. Unreachable / platform-guarded lines may be excluded only via an explicit `/* v8 ignore … */` with a one-line justification.
- **Multi-agent convergent review** (binding, §6): once impl + tests + gates pass for a feature, run fresh parallel review agents (read-only, cite `file:line`, no assumptions) and converge to a clean round before declaring done.
- **Tooling lint quirks** worth knowing:
  - **Vitest does NOT typecheck.** Always run `tsc --noEmit` per package before committing. Several bugs slipped past tests because of this until tsc caught them.
  - **Biome `lint:fix` does not auto-remove unused imports** (unsafe fix). Remove manually after a refactor.
  - **Core has no DOM/Node `lib`** — access globals via `globalThis as unknown as { … }` casts.
  - **Per-package `tsc`** is the only typecheck; `vitest --typecheck` is not wired.

---

## 7. Remaining roadmap

### Immediate hardening / Node-tier polish
| # | Slice | Notes |
| --- | --- | --- |
| ~~#34~~ | ~~`maxDataSize` byte bound on the capture store~~ | **DONE (2026-05-30, on `main`).** Byte cap on both capture stores (drop-oldest closed parts, soft-bounded on the open part); friendly `maxDataSize` (MB, Node default 50) → canonical `com.bugsee.option.config.data-size` → wired in Node `launch` for memory + file paths. `@bugsee/util` `utf8ByteLength` added. Test-first, mutator-looped (incl. multi-part single-add eviction + no-drift + clear-reset), multi-agent reviewed to convergence. Node now builds the in-memory store itself (parity with the file path), so `createClient` is untouched. Browser/edge 10 MB default lands with `@bugsee/browser`. |
| ~~#47~~ | ~~Interceptor carrier (global singleton)~~ | **DONE (2026-05-30, on `main`).** `@bugsee/core` `carrier.ts` (`getCarrier` + `getOrCreateInterceptor`) at `globalThis.__BUGSEE__[BUGSEE_SDK_VERSION]`; `installNetworkCapture` (5 net leaves) + Node `launch` (console + node-http) route interceptor creation through it via an injectable `carrier` seam → one instance / one patch per process, module-dup safe. Test-first, mutator-looped, multi-agent reviewed to convergence. Two LOW forward notes: the `'0.0.0'` version literal is duplicated in carrier.ts/launch.ts (different axes — carrier key vs UA default — unify when the real version is wired); carrier keys are string literals (tested to match each interceptor's `.name`). |
| ~~#13~~ | ~~Integration-shims~~ | **DONE (2026-05-30, on `main`).** `@bugsee/integration-shims` implemented: `createNoop{CaptureProvider,Interceptor}` + named `viewHierarchy`/`breadcrumbs`/`xhr` shims; warn-once on activation, side-effect-free construction, injected logger/runtime seam. `replay` excluded per design §372 (option-driven, not a constructed integration). Test-first, mutator-looped, two-agent reviewed clean. **All immediate-hardening items (#34/#47/#13) are now complete — next milestone is `@bugsee/browser`.** |

### Network body capture (F) — **COMPLETE** (policy + every transport's request & response bodies)
| # | Slice | Notes |
| --- | --- | --- |
| **F.1** | **Body sanitization + size/Content-Type gating + options** | **DONE (2026-05-30, on `main`).** The runtime-agnostic POLICY layer (Android `applyBodyFilters`/`NetworkDataSanitizer` parity). `@bugsee/protocol`: `sanitizeBody(body, contentType, opts?)` — JSON media types (`application/json`, `text/json`, any RFC 6839 `+json` suffix; `;`-params stripped, trimmed) get recursive key-denylist redaction (re-serialized), everything else the shape pass; never throws (invalid JSON degrades to the shape pass). `gateNetworkBody(event, {maxBytes, captureWithoutType})` — non-mutating; drops a body (→ `body:null` + `no_body_reason`) on missing/blank Content-Type (`no_content_type`, unless `captureWithoutType`) or over-size in UTF-8 bytes (`size_too_large`); preserves a producer-set reason / absent body. `contentTypeOf(headers)` (case-insensitive) exported. New options `CaptureNetworkBodies` + `CaptureNetworkBodyWithoutType` (+ existing `CaptureNetworkBodySizeLimit`/`CaptureNetworkDefaultSanitizer`). `@bugsee/core`: 3 COMMON friendly defs — `captureNetworkBodies`=true, `maxNetworkBodySize`=20480→`…body-size-limit`, `captureNetworkBodyWithoutType`=false. `@bugsee/capture` `network-provider`: per-event order is **gate (always) → user filter XOR default sanitizer**; the main toggle strips the body (no reason); the default sanitizer now also `sanitizeBody`s `custom.body`. Test-first, mutator-looped (incl. size boundary `>`, UTF-8 vs char count, case-insensitive CT, `+json`/`text/json`/`json5`, parse-failure degrade, gate-runs-when-sanitizer-off), 100% protocol coverage / capture gate met; multi-agent reviewed to convergence (2 rounds — round 1 broadened JSON detection to `+json`/`text/json` and added the sanitizer-off-gate + null-body tests). Residual (documented/intentional): non-standard JSON-ish types (`json5`, `text/x-json`, `application/csp-report`) get the shape pass only — shaped secrets still scrubbed, only a plaintext value behind a sensitive *key name* survives. |
| **F.2a** | **fetch REQUEST body** | **DONE (2026-05-30, on `main`).** `fetch-interceptor` populates `custom.body` on the `before` event for sync-readable request bodies: a string (verbatim) or `URLSearchParams` (`String(body)`); other `init.body` types (FormData/Blob/ArrayBuffer/typed array/ReadableStream) and a body carried on a `Request` passed as `input` → `no_body_reason:'cant_read_data'`; explicit null / no body → neither key. Reads are side-effect-free (never consumes/replaces the body the underlying fetch sends). When the caller set no Content-Type, the fetch-spec **implied** CT is synthesized into the captured request headers (string → `text/plain;charset=UTF-8`, URLSearchParams → `application/x-www-form-urlencoded;charset=UTF-8`) so the F.1 gate keeps the body instead of dropping it `no_content_type`; a caller-set CT is never overwritten. Self-isolated (X-Bugsee-Internal) requests skip before any body read. The interceptor emits RAW; the provider (F.1) gates/sanitizes. Test-first, mutator-looped, capture gate met; multi-agent reviewed to convergence (2 rounds + a confirming pass — round 1 added Request-as-input detection + implied-CT synthesis + key-omission/exclusivity tests; round 2 closed the `requestInputHasBody` conjunct + empty-string-body mutants). |
| **F.2b** | **fetch RESPONSE body** | **DONE (2026-05-30, on `main`).** Bounded-read clone capture honoring the user's **"don't alter app behavior"** principle ([[interceptors-must-not-alter-app-behavior]]). On success the interceptor clones the response (the ORIGINAL is returned untouched — preserves `url`/`redirected`/identity), then OFF the event loop bounded-reads the clone via `getReader()` up to `maxBodyBytes`, `cancel()`s the reader, and delivers the body as a later **`override:true`** amendment event (same id; carries the response headers so F.1's CT dispatch works). The immediate metadata `complete` is never delayed; the app's `await fetch()` is never blocked. Drops: Content-Length fast-skip (known over-cap → `size_too_large`, zero read), over-cap mid-read → cancel + `size_too_large`, read error / non-stream / no `TextDecoder` → `cant_read_data`, no body (204) → no amendment, clone()-throws/absent → no amendment. Gated by `captureBodies` (off → no clone/read at all). `captureBodies`/`maxBodyBytes` threaded `launch` → `installNetworkCapture` → fetch leaf from `CaptureNetworkBodies`/`CaptureNetworkBodySizeLimit`; `BugseeLaunchOptions` gained `captureNetworkBodies`/`maxNetworkBodySize`/`captureNetworkBodyWithoutType`. `readBoundedBody` NEVER throws (so the `void …then()` can't reject); the core emitter isolates listener throws. Test-first, mutator-looped (boundary `>`, cancel-on-over-cap, CL fast-skip no-read, all `cant_read_data` sources, override flag, 204, reads-only-the-clone, byte-cap threading at install+launch via pull-count), capture+node gates met; multi-agent reviewed to convergence (behavior + test-strength rounds + a confirming pass). |
| **F.3** | **xhr request + response body** | **DONE (2026-05-31, on `main`).** Extracted a shared **`network-body.ts`** (`readSyncRequestBody` — string/URLSearchParams + implied Content-Type, else `cant_read_data`; `boundedText` — already-buffered body capped by UTF-8 bytes with a `length` fast-path; `hasContentType`/`headerValueCI`; `decodeUtf8`) and **DRY-refactored `fetch-interceptor`** onto it (behavior-preserving). `xhr-interceptor`: request body in `#wrapSend` (readSyncRequestBody + implied-CT synthesis when the caller set none, raw on the `before` event); response body in `#complete` via `#readResponseBody` — `responseType` `''`/`'text'` → `responseText`, `'json'` → `JSON.stringify(response)` (circular/undefined → `cant_read_data`), binary/document → `cant_read_data`; bounded by `maxBodyBytes` (over-cap → `size_too_large`). **No app-behavior concern** for XHR responses: `responseText` is already buffered at `load` (sync read, no stream to disturb, no clone/tee), so it attaches directly to `complete` (no override amendment) — and `responseText` is only touched for text responseTypes (avoids the real-XHR InvalidStateError throw). New `captureBodies`/`maxBodyBytes` options + an `xhrTarget` seam on `installNetworkCapture` (parity with `fetchTarget`); body opts threaded to BOTH fetch+xhr leaves. Test-first, mutator-looped, capture gate met; multi-agent reviewed to convergence (correctness clean; test-strength round closed the xhr `maxBodyBytes` install-threading + a genuine multibyte-split decode test; `boundedText` length fast-path is a documented equivalent mutant). |
| **F.4a** | **node:http REQUEST body** | **DONE (2026-05-31, on `main`).** `http-interceptor` `#captureRequestBody` wraps the ClientRequest's OWN `write`/`end` (per-instance, not the prototype): observe each chunk (Buffer / ArrayBufferView raw bytes / string-with-declared-encoding), then call the ORIGINAL with the same args and return its value — the body the app sends is never altered (a real-`node:http` integration test asserts the loopback server received the unaltered body). The body is known only at `end()`, so it is delivered as an **`override:true`** amendment to the `before` event (same id, carrying the request headers; node:http implies no Content-Type so none is synthesized — a body without a caller CT is gated out downstream). Bounded by `maxBodyBytes` (over-cap → `size_too_large`); `end(cb)` is body-less; re-entrant `end()` is guarded; a body-less request emits no amendment. New `captureBodies`/`maxBodyBytes` options threaded from `launch` (shared with the fetch/xhr leaves). Test-first (unit + real-node:http integration + launch end-to-end), mutator-looped, node gate met; multi-agent reviewed to convergence (fixed a Uint8Array-chunk capture bug + added a positive launch test). Two documented equivalent mutants: the over-cap `chunks.length=0` clear (finalize never reads chunks when over-cap) and the launch `maxBodyBytes`→node:http hand-off (the provider re-gates at the same cap, masking the stored outcome). |
| **F.4b** | **node:http RESPONSE body** | **DONE (2026-05-31, on `main`).** `#captureResponseBody` PASSIVELY wraps the `IncomingMessage`'s own `push` (the producer hook the HTTP parser feeds body chunks into) — observe each chunk, then call through. This adds NO consumer and never forces flowing mode, so the app reads the stream exactly as uninstrumented (a real-`node:http` integration test consumes a 100 KB body via **`for await`** after a delay and asserts the app received ALL of it — a naive `res.on('data')` observer would have stolen it). `push(null)` = EOF → the body is delivered as a `complete` override amendment (carrying the response headers). A Content-Encoding-compressed body (gzip/br/…, case-insensitive, `identity`/absent = readable) is still-encoded on the wire and can't be read as text via push → `cant_read_data` (fetch captures decoded bodies via undici; node:http does not). Bounded by `maxBodyBytes`; re-entrant `push(null)` guarded; a body-less response emits no amendment. Refactored the request + response observers onto shared `chunkToBuffer` / `createBodyAccumulator` / `#emitBodyAmendment` (DRY). Test-first (unit + real-node:http integration incl. async-iteration non-disturbance), mutator-looped, node gate met; multi-agent reviewed to convergence (impl validated correct + flow-mode-safe; the test-strength round strengthened the async-iter guard to a large delayed body and closed empty-encoding / correlation-field / null-guard / subview gaps). **F is complete: the policy layer (F.1) + request & response bodies on fetch (F.2), xhr (F.3), and node:http (F.4), all honoring the don't-alter-app-behavior principle.** |

### DI Phase 3 / token migration — **COMPLETE** (all platform seams are typed-token container services)
- **Increment 1** (HTTP `transport`). **Increment 2 (2026-05-31):** `captureStore` (`core/contracts.ts`) + `systemProbe` (`node/environment.ts` — Node-local). **Final increment (2026-06-01, on `main`):** the LAST seams — `clock` (`clock.ts`), `scheduler` (`client.ts`), `uploadPipeline` (`transport.ts`), `bundleStore` (`durable-upload-pipeline.ts`), `fileStorageAdapter` (`contracts.ts`). `createClient` registers `clock`/`scheduler`/`captureStore`/`filters` always and `uploadPipeline` when provided; `launch` registers `transport`/`systemProbe` always and `bundleStore`/`fileStorageAdapter` only in file-backed mode (a dataDir/explicit store; `getService` throws for them in in-memory mode — the intended optional-service semantic). All lazy + side-effect-free factories returning the SAME instance used internally (behavior-preserving). The one non-trivial change: `fileStorageAdapter` extracted to a named const in `launch` (guarded `captureStore === undefined && dataDir !== undefined` to preserve the prior `??`-short-circuit — so `createNodeFileStorageAdapter`'s `ensureDir` side-effect still does NOT run when a captureStore override is given). **9 services**, collision-free: transport/uploadPipeline/filters/captureStore/fileStorageAdapter/clock/scheduler/bundleStore (core) + systemProbe (node). Mutator-verified; reviewed clean. **Interceptors stay on the process Carrier** (`getOrCreateInterceptor`), NOT the per-client container — by design: they need cross-module-copy dedup + patch-once + refcount keyed on a process-global, which the per-launch container can't provide; the carrier HOSTS the internal object, so interceptors are still "incorporated." **The container is now the complete internal object (the "BugseeInternal") — every platform component resolvable via `getService`.**
- **Token migration + service-manifest registry (2026-06-01, on `main`, commit `437f14e`).** Replaced the raw-string / `NameServiceMapping` declaration-merge keying with typed **`ServiceToken<T>`** handles (`@bugsee/service`: `ServiceToken<T>`, `serviceToken(name)`, `defineService(token,…)`, `ServiceContainer.getProvider(token)`). A token pairs a stable `name` with a branded phantom `__type` that discriminates `ServiceToken<A>` from `ServiceToken<B>` (a wrong-token use is a compile error); the container keeps its `Map<string,Provider>` internals keyed via `token.name`, so only the typed API boundary changed. Each contract exports its token beside it (`TransportToken`/`UploadPipelineToken` in `transport.ts`, `FiltersToken` in `filters.ts`, `CaptureStoreToken`/`FileStorageAdapterToken` in `contracts.ts`, `ClockToken` in `clock.ts`, `SchedulerToken` in `client.ts`, `BundleStoreToken` in `durable-upload-pipeline.ts`, `SystemProbeToken` in `node/environment.ts`); every `declare module '@bugsee/types'` service block is gone and `NameServiceMapping` is removed from `@bugsee/types` (`NameExtension`/`Hook`/`Hub` mappings stay). The now-orphaned `@bugsee/types` dep was dropped from `@bugsee/node`. **Carrier-hosted service-manifest registry:** `contributeServiceManifest(manifest, carrier?)` / `getServiceManifests(carrier?)` on the carrier; a manifest is `(internal: ServiceRegistrar & ServiceResolver) => void`, and `launch()` runs every contributed manifest against the internal container (`launch.ts`) — so an extension/adapter's services auto-register WITHOUT `launch`/`createClient` ever naming them (auto-registration via an explicit manifest, not import side-effects). Test-first + mutator loop (token plumbing + facade + new same-name-resolution and phantom-discrimination tests, all mutation-verified) and a `tsc`-level type test pinning token branding; multi-agent reviewed to convergence (round 1 → 5 findings fixed → round 2 clean). _Open follow-up:_ the manifest registry's final shape (ship-as-is vs. a per-platform manifest module vs. a fuller declarative config-DI) is still an open design question — landed as-is. _Doc note:_ `docs/design/sdk-design.md` §5.2/§7.4 still describe the original `NameServiceMapping` design; this token migration is the as-built delta recorded here.

### Milestone 3 — `@bugsee/browser` — **COMPLETE (2026-06-03, on `main`)**
A runnable browser SDK + IndexedDB persistence, built in five reviewed slices (commits `0e0bb0a`..`7c0f69b`):
**B1** fetch `HttpTransport` · **B2** env probe + `web` envelope builder · **B3** window crash/rejection
detection + V8/SpiderMonkey/JSC stack-dialect dispatch (core `parseLocation` extracted) · **B4** the
`launch()` composition root (console + network + system traces/events + detection; no `process.exit`
path) · **B5a** IndexedDB durable bundle queue (crash recovery across a reload, `recover()` deferred to
hydration) · **B5b** persistent IndexedDB capture store (**superseded** by the capture-storage redesign
below — its in-memory mirror lost the open chunk on an unpredicted termination). Full detail
in §1 "Browser platform". Each slice: test-first + mutator loop + multi-agent review to convergence,
100% line/fn/stmt coverage. `fake-indexeddb` is the only new (dev) dependency. Deferred follow-ups:
UA parsing (backend does it), richer DOM lifecycle events (freeze/resume/bfcache). (Input/click capture
and the DOM-snapshot view hierarchy have since landed — see the capture-completeness milestone in §7.)

### Capture-storage redesign — durable-as-captured chunk store — **COMPLETE (2026-06-04, on `main`)**
The persistent capture store now follows the **Android directory-per-chunk** model (user-pinned): the
durable store is the source of truth, memory holds ONLY a chunk metadata index, and every entry is
written through **as captured** — so an unpredicted termination (tab close, OOM/kill, navigation) loses
at most ~1 entry, not the whole open chunk (B5b's flaw). Two layers in core, one chunk-store impl for
every backend:
- **Layer 1 `createChunkCaptureStore(backend, opts)`** (Android `CapturePartManager`) — 1s parts, an
  in-memory `PartMeta` index only, time-window + `maxDataSize` byte-cap eviction, sync `snapshot()`.
- **Layer 2 `ChunkBackend`** — `openPart`/`appendEntry`→bytes/`closePart`/`removePart`/
  `removeGeneration`/`snapshot(frozenParts)`/`listParts`/`listGenerations` (the durable recovery index).
  Backends: `createMemoryChunkBackend` (RAM, ephemeral; behind `createMemoryCaptureStore`) ·
  `createFileChunkBackend` over a **`ChunkStorage`** directory seam (node `createFsChunkStorage` at
  `<root>/<gen13>/<chunk12>/{meta,<type>}`; behind `createFileCaptureStore`) · `createIdbChunkBackend`
  over `createIdbKeyedStore` (per-entry `d/…` + per-chunk `m/…` records; async in-order write queue;
  snapshot pinning; behind `createIdbChunkCaptureStore` — replaces B5b in the browser launch).
Each part persists a `meta` record (number/start/end/byteSize) on open + close, so `listParts`/
`listGenerations` are a real recovery index (no data scan). The flat `FileStorageAdapter` was removed
(superseded). Built S1→S4, each test-first + mutator loop + multi-agent review to convergence, 100%
line/fn coverage. Behavior-preserving for the memory + node-file stores. **Capture recovery** consumes
this seam — see below.

### Capture recovery (detected-incidents-only, Node) — **COMPLETE (2026-06-05, on `main`)**
Closes the gap the durable bundle queue doesn't: an incident was **detected** but the process died
before its bundle was assembled+persisted (the assembly is async; a fast kill/OOM beats it). The capture
chunks are already durable; recovery persists the in-RAM incident metadata too, then rebuilds the report
on the next launch. Policy (user-chosen): detected incidents only (no "unexpected termination" → no
clean-shutdown flag → zero false positives). Wired on **Node + browser**; the core (R2) + client hook
(R3) are runtime-portable.
- **R1 `ReportMarkerStore`** (`core/report-marker-store.ts` + node fs impl): a durable per-incident
  marker `{generation, request, attributes, userIdentifier}` keyed by `request.id` (incident-time global
  state snapshotted in), under a STABLE `<dataDir>/incidents`.
- **R2 `recoverReports`** (`core/capture-recovery.ts`): runtime-portable, pure over injected ports.
  Groups markers by generation (excluding current), drains each prior gen ONCE, reassembles per marker
  (reuse `assembleBundle` + a snapshot drain), enqueues through the durable pipeline, removes a marker
  only on delivery; a single SWEEP frees recovered + no-incident prior gens, keeping undelivered ones.
- **R3 client hook** (`client.ts` `submitReport`): both report paths persist a marker BEFORE assembly +
  clear it on settle (the bundle queue owns delivery thereafter). Behavior-preserving without the hook.
- **R4 node launch** (`node/launch.ts`): one shared `captureGeneration`; build the marker store; PRESERVE
  prior gens when recovering (else clean-on-init); after the durable `recover()`, run `recoverReports`
  over a read backend on the same chunk storage. E2e: a seeded prior gen + marker → the recovered bundle
  uploads (logs unzip to the prior capture), marker + gen swept, live gen survives.
- **BR1 IndexedDB marker store** (`browser-utils/idb-report-marker-store.ts`): the async-medium analog —
  a sync `ReportMarkerStore` façade over `AsyncBlobStore` (in-memory mirror + write-through + `whenReady`
  hydrate-on-open + corrupt-marker purge), mirroring `createPersistentBundleStore`.
- **BR2 browser launch** (`browser/launch.ts`): the IndexedDB parallel of R4 (own db `bugsee-markers`;
  the `bugsee-capture` keyed store shared by the live store + the recovery read backend). Async-ordered:
  capture recovery runs only after BOTH the durable `recover()` has run (no double-upload) AND the marker
  mirror hydrated; `void`-ed/best-effort. E2e via fake-indexeddb (a controllable bundle-store `whenReady`
  pins the ordering).
Each slice test-first + mutator loop + multi-agent review to convergence, 100% line/fn coverage.
Accepted v1 limitation (documented): clearing the marker on report SETTLE leaves a narrow
post-persist/pre-upload window where a crash double-delivers (server `signatures` dedup mitigates) — a
tighter "clear on persist" hook is a deferred drop-in. **Optional follow-up:** the
"unexpected-termination" (broad) policy with a clean-shutdown flag (currently out of scope by choice).

### Multi-instance on-disk coexistence + recovery — COMPLETE (2026-06-17, on `main`)
Several SDK aggregators — worker_threads in ONE process, or several processes — can now safely share one
`dataDir` (the per-process carrier singleton does NOT collapse worker_threads, which have their own
globalThis). Android-canonical (`com.bugsee.library` NDK per-process subtree + liveness + opportunistic
recovery). Design `docs/design/multi-instance-disk-coexistence.md`. All in `@bugsee/node`:
- **Per-instance subtree** `<dataDir>/<pid>-<threadId>-<nonce>/{capture,pending,incidents}` + `.live` +
  `owner.json` (`instance-layout.ts`, D1) — concurrent writers never touch the same files (kills the
  same-ms generation collision + interleaved-append corruption by construction). `threadId` separates
  worker_threads; the random `nonce` separates relaunch / guards PID reuse. New advanced `instanceIdentity`
  launch option pins a deterministic id for tests.
- **Liveness** (`liveness.ts`, D2) — the portable replacement for Java's OS `FileLock`: a sibling is DEAD
  iff `process.kill(pid,0)` says the owner is gone (instant + hang-correct — a hung process is a live pid),
  OR an alive pid has gone heartbeat-stale beyond the 120 s patient window (dead worker_thread / PID reuse).
  An alive pid with no heartbeat yet is a still-arming instance → kept.
- **Heartbeat** (`liveness-heartbeat.ts`, D3) — a main-thread scheduler interval re-writes `.live` (mtime)
  every 10 s, stopped on `stop()`. (Worker-thread carrier for true hang-proofness = deferred hardening; the
  pid-probe already makes a hung process read alive and the patient window covers a hung worker_thread.)
- **Coordinator** (`recover-instances.ts`, D4/D5) — on launch, scan the SIBLING subtrees; the liveness gate
  recovers ONLY dead ones (never a live sibling), reusing the existing per-incident recovery pipeline
  (durable-queue drain + marker rebuild) aimed at the sibling's dir, then removes it — but ONLY once fully
  delivered (a failed upload survives to retry). Concurrent recovery is left unclaimed: it is idempotent +
  server-side `signatures`-deduped, so the no-claim path is correct (the atomic-rename claim is a deferred
  optimization). Wired in `launch.ts` (owner.json up front; heartbeat after launch; coordinator replaces the
  old "recover my own prior generations" — a prior crashed run is now a dead sibling).
- **Real two-process e2e** (`@bugsee/instrumentation-tests`): a doomed process persists an incident then
  dies undelivered; a fresh process on the same dataDir recovers + delivers it. GREEN on node/bun/deno.
Slice-0 spikes verified `threadId` / `kill(pid,0)`-ESRCH / worker-thread heartbeat on real node/bun/deno.
Each slice test-first + mutator + multi-agent review to convergence (1 real gap closed, 1 false positive
dismissed). **Deferred:** worker-thread heartbeat (D3) + atomic-rename claim (D5) + cross-machine dataDir +
the browser/IndexedDB tier.

### Server disk capture write path — Phase 1 COMPLETE (2026-06-17, on `main`); Phase 2 (worker+ring) deferred
Design `docs/design/server-disk-capture-write-path.md` (D1–D11). The old per-entry synchronous
`appendFileSync`-per-record was dangerous on a high-load backend (benchmark §10: under blocking I/O it
freezes the event loop for SECONDS); batched `writev` holds p99 1–5 ms / max 7–10 ms at full throughput.
Phase 1 (the live path) — each slice test-first + mutator + 100% line/fn:
- **Batched writer** (`node-utils/batched-fs-chunk-storage.ts`, `b477b52`) — held-open fd per chunk file,
  per-path buffer, `writevSync` on a 64 KB HWM (IOV_MAX-capped), `flushSync`/`sealChunk`/`dispose`.
- **Flat tab-frame (D9)** (`core/file-chunk-backend.ts`, `803b96a`) — `<timestamp>\t<serialized>\n` replaces
  the `JSON.stringify({t,s})` double-wrap; reader splits on the first tab, skips torn lines.
- **Disk is the DEFAULT (D3)** (`node/data-location.ts` + `sweep-instances.ts`, `5bc58b5`) — launch option
  `capturedDataStore: 'memory'|'disk'` (default `'disk'`); no `dataDir` → `os.tmpdir()/bugsee/<instanceId>`;
  a 7-day TTL hygiene sweep reaps abandoned (dead/aged) sibling subtrees before recovery.
- **Flush-on-exit** (`node/launch.ts`, `b5972d1`) — node's `'exit'` hook (non-intrusive, NOT a SIGTERM
  handler) + the existing uncaught/stop flushes, so a clean shutdown loses nothing.
- **e2e** (`instrumentation-tests`): the full real-process battery runs on disk-by-default + a new
  **disk-recovery** scenario proves "a crash loses nothing" (an incident that died before assembly is rebuilt
  next launch from the marker + durable chunks, carrying the pre-crash breadcrumb). 45 e2e tests GREEN on
  node/bun/deno. Host-lag is benchmark-backed, not a flaky CI gate.
**Phase 2 — off-thread worker + lock-free SAB ring — BUILT + reviewed-to-convergence (2026-06-18, opt-in
`captureWriter: 'worker'`).** Six slices in `@bugsee/node-utils`: `capture-ring.ts` (shared SAB byte-ring,
zero-copy reserve/commit/peek/consume, wrap-pad, drop-oldest with a **lock-free Dekker read-cursor** —
producer + consumer each set-flag-then-check-other so an in-flight `writev` is never clobbered),
`capture-ring-drainer.ts` (worker-side drain→fds + self-describing pathId codec, no register channel),
`capture-ring-writer.ts` (drop-in `ChunkStorage` + `createSyncRingWorker` default/fallback),
`worker-ring-worker.ts` (off-thread worker_threads `RingWorker` — inline eval string mirroring the tested
consumer + the Atomics flush-ack / bounded-shutdown handshake), wired in `launch.ts`. The worker owns all
data-file fds (deno can't inherit fds); zero-copy hot path; meta/read/seal/remove stay main-thread. The
3-round convergent review found + fully fixed a CRITICAL two-thread ring race (the Dekker completion is the
load-bearing producer re-check, proven against the JS Atomics seq-cst model). The Phase-1 batched writer is
the DEFAULT live path; the worker is INSURANCE. **Cross-runtime `'worker'` e2e DONE (2026-06-20):** the
instrumentation harness boots `captureWriter: 'worker'` in real node/bun/deno processes and asserts the
off-thread-written capture round-trips into the delivered bundle — green on all three. It caught + fixed a
real bug: the ring writer's `files()`/`chunks()`/`generations()` enumerators didn't flush the worker, so a
LIVE in-process bundle assembly of an OPEN part read an empty dir → an empty bundle (no prior test hit the
live-snapshot-of-pending-ring-data path). (Adverse-I/O host-lag stays §10-benchmark-validated, not a flaky
CI gate.)

### Browser capture-completeness — **COMPLETE** (CE1–CE4, 2026-06-05 → 2026-06-25, on `main`)
The crash/network/storage/recovery pipeline is done, but the browser auto-capture SURFACE was thin vs
the Android/iOS SDKs + competitors (Sentry/Firebase/BugSnag/Datadog) — gap analysis: see
[[capture-completeness-vs-parity]] in memory. Closing it, browser-first (Node's traces are already
solid), in slices:
- **CE1 — system EVENTS breadth (DONE, `main`):** `createBrowserSystemEventsSource` now maps
  visibilitychange→`process_foreground`/`process_background`, online/offline, orientationchange→
  `orientation_changed`, alongside `process_started`/`pagehide`. Injected env (window/document/screen),
  graceful degradation.
- **CE2 — system TRACES breadth (DONE, `main`):** `createBrowserSystemTracesSampler` adds `connection`
  (navigator.connection), `orientation` (screen.orientation), `battery`/`charging` (cached BatteryManager)
  to the existing `ram_js_heap_*`. Android trace-name parity; degrades per-API.
- **CE3 — input capture (DONE, `main`; re-based onto the `input` stream 2026-08-27; the state-change
  signals split off to breadcrumbs 2026-08-31):**
  `createBrowserInputSource` (browser) — capture-phase, passive, observe-only DOM listeners for
  pointerdown/pointerup/pointercancel/keydown → the dedicated **`input`** stream
  (`input.json`), via the runtime-agnostic `createInputProvider` (capture, mirrors
  system-events-provider) gated by the new
  `captureInteractions` option (protocol). `describeTarget` produces a PII-safe target descriptor
  (tag/id/class/type/text/selector) and **masks** password fields + `[data-bugsee-hidden]` subtrees to
  `{tag, masked}`. PII discipline (multi-agent-reviewed): typed text is NEVER captured — plain printable
  keys are dropped, and the drop is robust to AltGr (`getModifierState('AltGraph')` + the Windows
  ctrl+alt signature), supplementary-plane/emoji (`[...key]` code-point count), and IME (`isComposing`);
  input/textarea/select values and editable text are never read; handlers are throw-isolated so a bad
  selector / exotic target can never disrupt the app. Carrier-shared like `console`.
- **CE4 — view hierarchy (DONE, `main`):** an at-report DOM snapshot (the browser analog of mobile's
  at-report screenshot) → a `viewtree` entry, via a new generic **`reportSnapshots`** pull-seam on the
  client's assemble closure (each source PULLED once per LIVE report, merged into the drained map;
  throw-isolated; NOT used by capture-recovery — a next-launch DOM is not the incident's). Browser
  `createDomSnapshot`/`createViewtreeSnapshotSource` walk the DOM reusing the reviewed `describeTarget`
  per node (+ rounded `getBoundingClientRect`): masked subtrees (password / `[data-bugsee-hidden]`)
  collapse to `{tag, masked, rect}` with no recursion; bounded by maxNodes(2000)/maxDepth(32);
  per-node throw-isolated. Gated by the new `captureViewHierarchy` option (protocol). The launch
  `document` option is now the shared `Document` for both input + viewtree.
- **Web Vitals / performance** is the last capture-completeness item, but by design it is the
  `@bugsee/performance` **extension** (§0.6) rather than a browser-core provider — tracked as its own
  milestone below.

### Performance / APM extension (`@bugsee/performance`) — **COMPLETE** (P0–P3.x, 2026-06-08 → 2026-06-14, on `main`)
Full extension (web-vitals + page-load detail + active APM), **on by default via the umbrella**, built
from competitor source as a design reference (Google `web-vitals`, Sentry, Firebase, Datadog) so we ship
past their known rakes — see [[performance-apm-extension-plan]] in memory for the metric catalog + the
rakes-as-tests + the packaging decision (extension, umbrella auto-registers, active span API opt-in).
- **Phase 0 — DONE (`main`):** the Android-canonical Span/Transaction model (`SpanStatus`, fluent API,
  `startChildSpan`, idempotent `finish`, `Clock`-driven timestamps + clamped `durationNanos`) +
  `serializeTransaction` → the §8.8 wire; the bounded FIFO transaction buffer; the controller
  (`startTransaction`/`getActiveSpan`, head-sampled, finish→buffer); the extension shell
  (`createPerformanceExtension` → `setup(client)`/`stop()`, launch-wired — no `addExtension` lifecycle
  yet, so `setup` takes the FULL `BugseeClient`); the `performance.*` options (decl-merged). Reviewed to
  convergence (one real fix: clamp negative `durationNanos`).
- **Phase 1 — DONE (`main`), reviewed to convergence:** the full Core Web Vitals capture
  (`packages/performance/src/web-vitals/`), each reimplemented from Google `web-vitals` (design ref) over
  an injected `WebVitalsEnv` (no DOM lib; self-noops where an API is absent): the machinery (`observe`
  buffered+Safari-microtask, `onHidden`/`onBFCacheRestore`, `firstHiddenTime` watcher, navigation
  entry/activationStart, the `Metric`/`getRating`/`bindReporter` model) → **LCP** (last-entry, trusted
  keydown/click-or-hidden finalize, takeRecords drain) · **FCP** (first-contentful-paint, report-once) ·
  **TTFB** (responseStart validity) · **CLS** (session windows, max-not-sum) · **INP** (p98-of-10,
  interactionId grouping, /7 polyfill, >60s clamp). `collectPageLoadVitals` ties all five into a
  `pageload` transaction (`web_vital.<name>.value/.rating` attributes, finish-on-hidden). The Phase-1
  3-lens review found ZERO correctness defects + all 15 rakes correct; only boundary-test gaps (CLS
  1s/5s, INP /50, /7) — closed.
  - **Deferred (acceptable, not bugs):** CLS FCP-gating; the full bfcache per-metric reset/re-measure
    (the `onBFCacheRestore` hook exists but is unwired, so `navigationType:'back-forward-cache'` is
    currently unreachable); prerender `whenActivated` deferral (mitigated by the `activationStart`
    subtraction); soft-navigations; the buffered `visibility-state` perf-entry.
- **Phase 2 — DONE (`main`):** the page-load detail on the pageload transaction. P2a navigation-timing
  breakdown → `nav.<phase>_ms` attributes (dns/connect/tls/request/response + dom_interactive/
  dom_content_loaded/load; skips zero/missing/reversed phases). P2b a new `recordChildSpan` primitive
  (post-hoc explicit-time spans; recorder is now `SerializableSpan[]`) + `collectResourceTiming` →
  `resource.<initiatorType>` spans (URL query/fragment stripped + data:/blob: collapsed for cardinality/
  PII, fetch/xhr deduped, status/size attributes, capped 100). P2c `collectLongTasks` → `ui.long-task`
  spans (observed live, capped 50; the back-dating rake is structurally avoided since recordChildSpan is
  independent). All wired into `collectPageLoadVitals`.
- **Phase 3 — DONE (`main`), reviewed to convergence (3 rounds):** the active-APM delivery layer.
  `createRateSampler` (head sampling: rate≥1 always / ≤0 never / else `random()<rate`); `collectHttpSpans`
  (subscribe the network interceptor → `http.client` child spans on the active transaction, correlate by
  request id, query-stripped URL + method/status/mechanism attrs, capped `MAX_HTTP_SPANS=100` counting
  only RECORDED spans); `createPerformanceUploader` (interval drain → injected `send`, best-effort
  drop-on-failure→onError, idempotent start/stop); `createPerformanceSend` (POST
  `/v2/performance/transactions`, reuses core `BugseeApi.ensureSession` Bearer auth, throws on non-2xx);
  and **`wirePerformance`** — the on-by-default assembly the umbrella runs after `launch()`: gated by
  `monitoring`, registers `ext('performance')` with the rate sampler, collects page-load vitals +
  nav/resource/long-task spans, wires http spans when a `networkSource` is given, starts the uploader,
  returns a teardown. `send`/`networkSource`/`env` are injected so it stays decoupled + fully testable.
  - **Convergent review (CLAUDE.md §6):** 5 parallel agents (algorithm fidelity, span/wire model,
    delivery+assembly, test strength, portability) → **zero correctness defects**; closed 3 test gaps
    (appVersion/appBuild + onError plumbing untested on the defined side; a `recordChildSpan`
    omit-when-absent `description` that survived a `toEqual`) + 2 within-gate defensive branches; round 2
    added the http-span cap + pinned CLS/INP finalize idempotence; round 3 → **NO FINDINGS**. Coverage
    **100% line/fn/branch** (259/259). Every fix per-entity mutator-verified.
- **D2 part 2 — the active-span store (2026-09-14, uncommitted at time of writing).** The controller's
  active-transaction slot was one module-global variable, which is wrong on a concurrent server: a second
  in-flight request's `startTransaction` overwrote the slot, so a rename meant for request A landed on
  request B's transaction. It is now the injectable **`ActiveSpanStore`** seam (`get`/`set`/`clear`),
  threaded `node launchCore internals → umbrella wire → wirePerformance → extension → controller`.
  - **Default = `createSingleSlotActiveSpanStore()`** — byte-identical historical behaviour, correct for a
    browser's one in-flight navigation/interaction. The browser declares `activeSpanStore: undefined`
    explicitly; the umbrella's key is REQUIRED-but-nullable so a new platform cannot inherit the wrong
    slot silently (it fails `tsc`).
  - **Node = `createRequestScopedActiveSpanStore()`** (`@bugsee/node`, type-only `@bugsee/performance`
    import so the opt-in APM barrel stays out of every node consumer): the JS equivalent of Android's
    `ThreadLocal`-keyed `SpanContextHolder`, keying the slot off the ALS `RequestContext` via a
    symbol-keyed non-enumerable stash. A read under a context is STRICTLY PRIVATE (own live stash or
    nothing); a process-wide ambient slot serves context-less executions (startup, background work) only.
  - **New public exports:** `ActiveSpanStore` + `createSingleSlotActiveSpanStore` (`@bugsee/performance`);
    `createRequestScopedActiveSpanStore` + `RequestScopedActiveSpanStoreOptions` (`@bugsee/node`, for
    hand-wired APM). A store breaking the must-not-throw contract degrades to untracked and is reported
    once per site through `onError`.
  - **Known limitations, documented not fixed:** requests that genuinely SHARE one context object (a
    lingering `enterWith` with `instrumentIncomingRequests:false`) share the stash — isolation is exactly
    as isolated as the context object is; a nested `run()` inside an `enterWith` context reads
    private-empty; and under HTTP pipelining a request's close phase executes in the PREVIOUS request's
    context (measured), so a `res.on('finish')` reader sees `undefined` where the old global slot returned
    the transaction.
  - **Reviewed:** a 5-reviewer round (19 findings, all resolved) then a 3-reviewer Opus round; full detail
    and the resolution tables are in `docs/review/OPEN-FINDINGS.md` § "D2 part 2".
- **Phase 3.x — DONE (`main`), reviewed to convergence:** the on-by-default umbrella wiring, via the
  **`launchCore()` seam** (the user-chosen option A: explicit/typed over a callback hook or service
  discovery). `@bugsee/browser` now exports `launchCore(token, opts): { client, internals }`; `launch()`
  is `launchCore(...).client` (public surface unchanged, behaviour-preserving extract). `LaunchInternals`
  is the typed handoff — everything NOT already a DI service: `api`/`transport`/`baseUrl`/`getEnvironment`
  (to build the perf `send`), the `installNetworkCapture` umbrella (its `.interceptor` is the http-span
  source), + `appVersion`/`appBuild`/`onError`; the clock/scheduler stay services (`getService(ClockToken/
  SchedulerToken)`). `internals` is `undefined` on a repeat launch. The **`@bugsee/bugsee` umbrella** package
  (was a stub) now has a `launch()` that runs `launchCore`, resolves the `performance.*` options, builds
  `createPerformanceSend` over the internals, and calls `wirePerformance` — performance ON BY DEFAULT
  without `@bugsee/browser` depending on the extension (tree-shakeable). Teardown is composed **in place**
  on the client object `launchCore` registered as the process singleton (a wrapper-object approach broke
  singleton identity — caught + fixed in review). Integration-tested through the real `launchCore` with
  injected seams (network globals stubbed → the always-wired http-span subscription patches no real
  fetch/XHR). Convergent review (2 agents): correctness NO findings; only 2 LOW packaging-metadata items
  (an unused `@bugsee/node` dep + a stale description) — fixed. 100% line/branch/fn across the new code.
- **`@bugsee/performance` is COMPLETE** (P0–P3.x) and live by default in the `@bugsee/bugsee` umbrella.
- **P3 delivery — DONE (`main`), reviewed (3 agents → convergent):** chose option (a). A new
  **`performance` capture provider** (`packages/performance/src/capture-provider.ts`, push-driven over
  `CaptureProviderBase`) routes each finished SAMPLED transaction into the capture ring as a
  `performance`-typed entry, alongside the `TransactionStore` continuous `/v2` upload (dual sink). The
  controller gained an `onFinished(wire)` hook (called next to `store.add`); the extension wires
  `onFinished → provider.record` + `client.addCaptureProvider(provider)`, and exposes `recordExternal(wire)`
  so the EXTERNAL path (`wirePerformance.recordTransaction` — Node `app.start` + consumed OTel) ALSO
  dual-writes to the ring. The bundle assembler (`bundle-assembler.ts`) wraps the `performance` file type
  as `{transactions: [...]}` (the only object-wrapped type; all others stay bare arrays) — §711/§8.8.
  Cross-package integration test (real provider → aggregator → memory store → exporter → `assembleBundle`)
  pins the end-to-end §8.8 wire. Mutator-looped per entity; 100% line/fn/stmt across the new code.
  - **Deferred parity gap (Android `PerformanceCaptureExporter` traceId dedup):** Android emits at most
    ONE entry per `traceId`, resolving snapshot-vs-completed (completed wins). The JS bundle path has no
    such dedup yet. Not currently triggerable — `isSnapshot` is always `false` (snapshot transactions are
    not generated) and each finished transaction has a unique `traceId`, so no duplicate-traceId bundle is
    producible today. Add the `traceId`/`isSnapshot` resolution (in the provider or a per-type assembler
    serializer) WHEN snapshot transactions land.

### OpenTelemetry integration (`@bugsee/opentelemetry`) — Produce+Consume BUILT (2026-06-10) → `docs/design/opentelemetry-integration.md`
Two-way OTel interop as a pluggable extension (peers, never piercing core/perf). Design: two-way; a
runtime-portable mapping core; **Hybrid boundary** (SDK-level Consume + light OTLP/HTTP-JSON Produce);
scope = Consume + Produce + Propagation (OTel-API facade deferred); the "interceptors must not alter app
behavior" principle **refined** — a new general **interception-transformer** seam is the opt-in way piped
data is altered; the **propagation transformer** (`traceparent`, opt-in, allowlist-gated, same-origin) is
its first consumer. Design references (Sentry/Faro/Datadog/Honeycomb/Embrace) in the note.
- **A — DONE (`main`), reviewed:** the mapping core — Bugsee §8.8 transactions → OTLP/HTTP-JSON
  (`to-otlp.ts`), hand-rolled, ZERO `@opentelemetry/*` deps. Spec-verified (hex ids, uint64-string ns,
  AnyValue, status/kind); derives the implicit root span id + remaps dangling child parents.
- **B — DONE (`main`), reviewed:** `createOtlpTraceExporter` — a `send`-shaped function (drop-in for
  the perf uploader) POSTing the mapped OTLP request to any collector. **Produce works end-to-end.**
- **C — DONE (`main`), reviewed:** Consume, native-transactions shape. C1 `from-otlp` (OTel span →
  §8.8, round-trip-consistent status). C2 `createTraceAssembler` (root-end + bounded eviction: emit on
  root-span-end, drop a never-rooted trace after maxAgeMs / cap at maxTraces). C3 `createBugseeSpanProcessor`
  — STRUCTURAL `ReadableSpanLike`/`SpanProcessor` (no OTel import; covers SDK 1.x `parentSpanId` + 2.x
  `parentSpanContext`/`isRemote`→local-root); `@opentelemetry/*` are OPTIONAL peers (verified not pulled
  into node_modules) + a dev-only `.test-d.ts` drift guard. **OTel spans now flow INTO Bugsee.**
- **T — DONE (`main`):** the interception-transformer seam in `@bugsee/capture`. Capture interceptors
  stay observe-only; a `RequestDecorator` (sync, truthful-capture, never on SDK-internal traffic) is the
  ONLY way piped data is altered — byte-identical when none registered. Shared `createRequestDecoratorRegistry`
  on BOTH fetch (rebuilds `init.headers`) and xhr (original `setRequestHeader` at send). The "interceptors
  must not alter app behavior" principle, refined into code.
- **D — DONE (`main`):** `createTraceparentDecorator` — the W3C propagation transformer (the seam's
  first consumer). Injects `traceparent` (`00-<traceId>-<spanId>-<flags>`) from the Bugsee active
  transaction (already W3C-shaped; NO `@opentelemetry/*` dep). **SECURITY:** same-origin propagates by
  default; cross-origin ONLY via an explicit allowlist (string/RegExp) — no trace-topology leak;
  never overrides an existing `traceparent`; fail-closed on unparseable URLs. Security mutator loop
  (same-origin inversion, default-deny removal, allowlist bypass, override, sampled-flag, format) all caught.
- **Live wiring — PROPAGATION DONE (`main`); UNIFIED onto the native path (X3b, 2026-06-22):** the network
  umbrella exposes `addRequestDecorator` (fans out to the fetch+xhr leaves); the `@bugsee/bugsee` umbrella now
  registers the NATIVE `createTraceparentDecorator` (the shared `@bugsee/capture` transformer — the OTel-named
  `wireOpenTelemetry` was retired) on the browser network source after launch, fed perf `getActiveSpan` AND
  the `bugsee=` session tracestate (`internals.api.sessionId`, so the FE session floats to the backend).
  Options use the native vocabulary: `propagateTrace` / `tracePropagationTargets` (+ browser-only
  `tracePropagationOrigin`). **`launch('tok', { propagateTrace: true })` links the frontend trace+session to
  the backend end-to-end — the Next.js / SSR story is LIVE** (browser-only in the umbrella; on Node the
  `@bugsee/node` launch owns propagation, so the umbrella never double-wires; same-origin propagates,
  cross-origin needs the allowlist, browser default off).
- **Live wiring — PRODUCE-TEE + CONSUME DONE (`main`):** `wirePerformance` gained `recordTransaction`
  (buffer an already-finished, externally-sampled transaction into the upload pipeline). The umbrella:
  **produce-tee** — `otelExportUrl`/`otelExportHeaders`/`otelExportResource` opts make the perf `send` a
  tee of the Bugsee upload + `createOtlpTraceExporter` (allSettled; failures → onError; internal-tagged
  transport keeps the export out of capture); **consume** — `otelConsume` + `onOtelSpanProcessor` hand the
  user a wired `BugseeSpanProcessor` (onTransaction → recordTransaction) to register on THEIR
  `TracerProvider`, consumed spans riding the same upload + tee. **Two-way OpenTelemetry is COMPLETE** —
  produce (export+tee) + consume (SpanProcessor) + W3C propagation, all wired in the umbrella, each
  integration-tested through the real launch + mutation-verified.
- **Node-perf wiring — DONE (`main`):** the `@bugsee/bugsee` umbrella has a NODE entry (per-runtime `exports`
  conditions: browser→`index.ts`, node→`index.node.ts`) running `@bugsee/node`'s `launchCore` + the shared
  runtime-agnostic `wireUmbrella`. `wirePerformance` gained `pageload?:boolean` (Node skips the browser
  pageload/web-vitals/hidden lifecycle); Node instead records an **`app.start` startup transaction**
  (process-start → launch; `appStartTimeMs` override) so it uploads immediately. **Two-way OTel is now LIVE
  on BOTH browser and node** — consume + produce-tee automatic; http-spans + propagation attach to the
  app's per-request transaction (the span API). The umbrella compiles both entries (DOM lib + node types).
  **The whole two-way OpenTelemetry feature is complete and live on both runtimes.**

### Cross-project distributed tracing — BACKEND COMPLETE (2026-06-22, on `main`) → `docs/design/cross-project-tracing.md`
A FE→BE→FE single distributed transaction, OTel-interoperable (wire = W3C trace-context), conforming to the
cross-SDK **Bugsee OTLP Profile v1** (`~/Projects/Bugsee/dev-docs/bugsee-otlp-profile-v1.md`) from the start.
Built as the *native* (non-OTel-gated) propagation substrate so the upcoming **frontend adapters plug into a
finished protocol**. All slices test-first → per-entity mutator → multi-agent review to convergence:
- **X0** per-launch **session-correlation id** (`@bugsee/util` `randomId`), sent at `/v2/sessions`, exposed
  to the context/decorator; dual-purpose (the `bugsee=s<id>` tracestate + the OTLP `bugsee.session.id`).
- **X1** W3C `tracestate` codec in `@bugsee/capture` (`parse/serialize` + the `bugsee=` `r<flag>:s<id>`
  field; 32-entry/512-byte caps); `createTraceparentDecorator` now emits `tracestate` too.
- **X2** trace **continuation as a CHILD**: `continuation` gained `parentSpanId`+`sampled`;
  `RequestContext.trace` gained `sampled`; server-instrument makes the `http.server` span a child of the
  inbound span, adopting the upstream sampling decision.
- **X3** native outbound propagation in the node launch (`propagateTrace` default true,
  `tracePropagationTargets` allowlist — a backend has no same-origin, so nothing leaks without targets),
  sourced from the per-request context. De-gated from OTel (OTel keeps working, adds OTLP only).
- **X4** **BE→FE return path** (`traceResponse: { traceresponse?, serverTiming? }`, both default OFF/T9):
  `traceresponse` (W3C L2 draft) set at request-open; `Server-Timing` (`traceparent;desc=…`) appended on
  the native-fetch path (coexists with an app's own) / set-at-open on node:http. Wired on node/bun/deno.
- **X5 / T8** report envelope (`request.json`) carries `trace_id`/`span_id` (the cross-project join key);
  proven by a real **two-hop e2e** (external inbound W3C traceparent → continued → report trace_id →
  outbound injected traceparent: one shared traceId, BE-own child span, `bugsee=` riding along) green on
  node/bun/deno — which also covers OTel-interop (the inbound header is arbitrary W3C).
- **Y1** `to-otlp` conforms to Profile v1 §4/§5/§6/§8/§10 (resource constants, `bugsee.*` namespace,
  http.server→SERVER kind, lossless status, root `parentSpanId`).
- **X3b — DONE (2026-06-22):** retired the umbrella's OTel-gated propagation path (deleted `wireOpenTelemetry`);
  the umbrella now wires the native `createTraceparentDecorator` browser-only (node's launch owns it — no
  double-wire) + emits the `bugsee=` session, and the options use the native `propagateTrace`/
  `tracePropagationTargets` vocabulary. One propagation path, not two.
- **Deferred follow-ups:** **originating-session re-propagation** (the BE re-propagates its OWN session id,
  not the inbound FE's — needs parsing inbound tracestate at server-instrument; the FE now DOES emit its
  session via X3b, so this is the remaining BE half); the §17 internal-OTLP **upload cutover** (backend-gated).
  **Next: frontend adapters.**

### Bun runtime (`@bugsee/bun`) — COMPLETE (2026-06-14, on `main`)
The first non-node/browser runtime tier. Bun is node-API-compatible (node:http/fs/os/process/perf_hooks),
so `@bugsee/bun` reuses the ENTIRE `@bugsee/node` composition (transport, fs storage, node:http capture,
crash detection, durable queue + capture recovery) and overrides only what differs (design §264: "node +
Bun overrides"). Built in four reviewed slices (test-first + per-entity mutator loop + 3-agent review to
convergence):
- **S1 — runtime identity on the `SystemProbe`.** `@bugsee/node`'s `SystemProbe` gained `platformType()`
  and renamed `nodeVersion()`→`runtimeVersion()`; `buildNodeEnvironment` now reads both FROM the probe
  (was a hardcoded `'node'`). Behavior-preserving for Node (real probe → `'node'` + `process.versions.node`).
  This is the seam: a sibling runtime swaps identity by injecting its own probe — `launchCore` is unchanged.
  **Design note / known divergence:** identity-on-the-probe is how the node-family (node/bun, and deno next)
  reports `platform.type`; the **browser** tier instead hardcodes `'web'` in `buildBrowserEnvironment` (UA
  -derived version). Both are Android-consistent (Android co-locates `platform.type` with system reads in
  `EnvironmentInfoProvider`); the asymmetry is intentional — do NOT try to unify them.
- **S2 — `bunSystemProbe`** (`createBunSystemProbe(versions=process.versions)`): spreads `realSystemProbe`,
  overrides `platformType→'bun'` + `runtimeVersion→ versions.bun ?? versions.node` (Bun version, node-compat
  fallback). The injectable `versions` makes both `??` arms testable under Node.
- **S3 — guarded `perf_hooks` sampler** (`createBunSystemMetricsSampler`): reuses node's sampler but supplies
  GUARDED event-loop readers (Bun's `perf_hooks` event-loop APIs are partial). Each metric degrades to zero
  on throw — at BOTH construction AND per-sample read (the system-traces provider runs its first sample
  synchronously inside `launch()`, so a read-time throw would otherwise abort startup; review-hardened).
- **S4 — `launch`/`launchCore` + `index`** delegate to node's `launchCore` with the Bun probe + sampler as
  defaults (caller overrides win), and `export * from '@bugsee/node'` + explicit `launch`/`launchCore` that
  SHADOW node's (ESM: an explicit re-export always wins over a star-export name, no dup error). E2e asserts
  the Bun identity on the wire (session envelope AND the report bundle's request.json). Per-package
  `vitest.config.ts` enforces the coverage gate; 100% line/fn/stmt. One documented equivalent mutant (the
  sampler-default line: bun's and node's samplers are behaviorally identical under healthy perf_hooks).

### Node diagnostics — CPU profiling + ANR/event-loop-hang — COMPLETE (2026-06-14, on `main`)
Closes the two in-DEPTH gaps vs Sentry on Node/Bun (we already lead on network-body capture + durable crash
delivery). Design + benchmark + decision log: `docs/design/node-diagnostics.md`. Benchmark-driven: detection
is ~free (worker heartbeat 0% CPU, +12 MB Node / +5 MB Bun), @1ms CPU profile <1% (~0.05 MB gz/60s), and the
DECISIVE finding — **Bun supports the inspector `Profiler` but NOT the `Debugger` domain** — picked the
profile-based ANR stack (works on both runtimes). Built P1→C1→C2→A1→A2→B, each test-first + mutator + 3-/2-agent
review to convergence; both diagnostics verified on REAL Bun (worker_threads + SAB + `Worker#unref` + inspector
Profiler all present).
- **CPU profiling (opt-in, `profiling` off by default):** `profile` FileType → `profile.json` (bare V8
  .cpuprofile, DevTools/speedscope-loadable). `createCpuProfiler` over an in-process `node:inspector` Session
  (ASYNC — Bun defers callbacks; a sync stop() would drop the profile). A rolling controller pulls the current
  segment into the bundle at report time via the now-async `ReportSnapshotSource` seam; serialized collect()
  chain (a concurrent Profiler.stop would corrupt the session). **Gotcha:** a real inspector Profiler corrupts
  vitest's v8 coverage → launch tests inject a fake via a `cpuProfiler` seam.
- **ANR/hang (default ON):** worker + SharedArrayBuffer heartbeat (a blocked loop stops updating the buffer →
  the worker sees staleness); dumb worker posts raw stalls, escalation/dedup on the main thread (`evaluateHang`).
  `createHangDetectionProvider` → Error report "Main thread hang detected", domain `AppHang::{Fair|Medium|Severe}`,
  thresholds 3000/5000/10000 (validated, Android-canonical), option `com.bugsee.option.detect.hang`. The worker
  is `unref()`'d so default-ON never blocks a clean exit. Per-episode dedup (each distinct hang re-reports — a
  documented divergence from Android's per-session, right for a long-running server). Blocking stack comes from
  the CPU profile in the same bundle. `mechanism: 'hang'` added to the wire.
- **Bun (B):** both inherited by `@bugsee/bun` via node-tier reuse; capability-guarded (degrade to no-op if
  worker_threads/inspector absent). Deferred: Node-only live-inspector `Debugger.pause` stack; main-thread-misuse.

### Deno runtime (`@bugsee/deno`) — COMPLETE (2026-06-15, on `main`)
Deno 2 is node-API-compatible, so `@bugsee/deno` mirrors `@bugsee/bun`: re-exports the ENTIRE `@bugsee/node`
composition (transport, fs storage, node:http capture, crash detection, durable queue + capture recovery,
**CPU profiling, ANR/hang detection**) and overrides only the Deno identity probe (`platform.type: 'deno'`,
version from `Deno.version.deno` with a node-compat fallback) + the shared guarded `perf_hooks` sampler.
- **Shared sampler refactor:** the guarded perf_hooks sampler moved from `@bugsee/bun` to `@bugsee/node` as
  `createGuardedSystemMetricsSampler` (runtime-agnostic; Bun + Deno both use it; bun's local copy removed).
- **Verified on REAL Deno 2.8.3:** `Deno.version.deno` = '2.8.3' (note: `process.version` is the *node-compat*
  version, so the probe reads the Deno global, not `process.versions`); and ALL diagnostics primitives work —
  `node:inspector` Profiler (CPU profiling), `worker_threads` + `SharedArrayBuffer` + `Worker#unref` (ANR),
  `perf_hooks` (metrics). So node/bun feature parity is **full** on Deno; capability-guarded paths self-disable
  where a partial API is absent. Deno permission caveats (net/fs/worker) noted in the package README.
- Test-first, per-entity mutator-looped, e2e asserts the Deno identity on the wire (session + bundle
  request.json), single-agent review clean. Per-package `vitest.config.ts`; 100% line/fn/stmt.

### Cross-runtime e2e instrumentation harness (`@bugsee/instrumentation-tests`) — COMPLETE (2026-06-15, on `main`)
The layer the in-process unit tests (vitest under node, injected fakes) cannot reach: it boots the REAL
SDK in a REAL separate **node / bun / deno** process — no fakes, real timers, a real outgoing `fetch`,
the real V8 CPU profiler, the real worker-thread hang watchdog — pointed at a local **mock collector**
(`use mocking`, per the request), and asserts the actual uploaded bundle. Proves the *assembled* SDK runs
and produces the right wire output on each backend.
- **Per runtime, two scenarios** (`app/scenario.ts`): **main** (exit 0) — console→`logs.json`, a captured
  `/echo`→`network.json`, `logException`→an error bundle, a rolling V8 CPU profile→`profile.json`, a
  deliberate event-loop block→an **AppHang** bundle from the real watchdog, + one session carrying the
  runtime's `platform.type`. **crash** (exit 1) — async throw→`uncaughtException`→flush→`process.exit(1)`.
- **Cross-runtime workspace-TS resolution** (the linchpin): node via `tsx`; bun native; **deno via
  `deno run -A --node-modules-dir=manual --sloppy-imports`** (manual = use pnpm's node_modules; sloppy =
  our extensionless relative imports). A runtime whose binary is absent is skipped (node, via the `tsx`
  devDep, is the guaranteed target; bun/deno probed on PATH + `~/.bun|.deno/bin`).
- **Mock collector** (`test/collector.ts`) implements the real control plane (`/v2/sessions` →
  `/v2/issues` → signed `PUT`) + `/echo`; runs in the runner process, app reaches it over loopback, so the
  captured uploads ARE the assertion channel (no IPC).
- **NOT in `pnpm test`** (root globs `*.test.ts`; these are `*.e2e.ts`) and **not coverage-gated** (it
  spawns processes); run on demand via **`pnpm test:e2e`**. **Teeth-verified** (disabling profiling/ANR in
  the scenario fails the matching assertions — not false-green). **Multi-agent reviewed** (3 parallel,
  read-only): contract fidelity CLEAN (endpoints / response shapes / `source.mechanism`
  programmatic·hang·uncaught / report types / file names / all launch-option names match the real SDK),
  isolation confirmed empirically, robustness minors hardened (flush budget vs upload backoff,
  `closeAllConnections`, file-presence asserts, a deno version-provenance check proving it reads
  `Deno.version.deno` end-to-end). **21 tests across node/bun/deno, all green.** Fulfils the deferred
  "per-runtime smoke harness" roadmap item (below).

### Framework adapters — foundation + Express/Fastify/NestJS/Hono/Elysia/Hapi/Koa COMPLETE (2026-06-15, on `main`)
The shared **per-request context foundation** + **`@bugsee/express`** as its first consumer (full
Sentry-parity backend integration), per `docs/design/framework-adapters.md`. Key model (user-driven):
**correlation-by-tagging, not physical isolation** — record everything globally, stamp each capture entry
with its request's `contextId` (+ `traceId`/`spanId` when a trace is active), and the report carries that
`contextId` as the join key; the dashboard can then focus the recording on one request while the full
picture stays. Built in 7 test-first slices (each per-entity mutator-looped + multi-agent reviewed):
- **S1–S3 core foundation** (`feat(core,protocol)`): portable `RequestContext` + `ContextProvider` DI seam;
  the `CaptureAggregator` stamps each entry (onto a COPY — a review-caught MAJOR: never mutate the shared
  source-event object); report assembly merges the active context's user/attributes + sets
  `request.json.context_id`. The context is captured at report-**submit** time into a WeakMap keyed by the
  request (the trigger pipeline queues/detaches assembly, so a by-then-stale active context can't bleed).
  OFF by default → byte-identical for non-adapter users.
- **S4 node binding**: `createNodeRequestContextStore()` over `AsyncLocalStorage`, wired by default as the
  core `ContextProvider` (a no-op until a context opens). Bun/Deno inherit it via the node composition.
- **S5 trace continuation**: `parseTraceparent` (`@bugsee/capture`, defensive W3C parser) + perf
  `startTransaction({continuation:{traceId}})` adopting an inbound trace.
- **S6 `@bugsee/express`**: `requestHandler` (open context + optional `http.server` APM transaction +
  inbound-trace continuation, finishes on response) + `errorHandler` (report `http-error` with the context
  merged, then `next(err)`); express is a PEER; fully defensive (review-caught MAJOR fixed: pass-through
  `next()` moved out of the try so a downstream throw propagates + isn't double-called).
- **S7 e2e**: a REAL express server + REAL SDK + real `AsyncLocalStorage` proving concurrency isolation —
  3 interleaved concurrent requests, each report carries its own user + a distinct `contextId`, the log
  line tagged with a report's `contextId` is that request's own (no bleed).
The foundation (S1–S5) is reused verbatim by the next backend adapters — each a thin
`requestHandler`/`errorHandler`-shaped binding:
- **`@bugsee/fastify`** (`setupFastify`): hook-based (onRequest `enterWith` + onError/onResponse/onRequestAbort);
  proved the foundation reuses across a different framework model; own real-server concurrency-isolation e2e.
- **`@bugsee/nestjs`** (`setupNest`) — **COMPLETE (2026-06-15)**. The first adapter with a *configurable*
  error seam, decided after empirically probing (a real Nest app) which lifecycle phase each seam can see:
  - **Context middleware** (`app.use`, **`enterWith`** — works across the Fastify body-parse async boundary,
    unlike a `run()`-wrapped next()) opens the context earliest, before guards.
  - **Default = a global interceptor** (`catchError` → report → **re-throw untouched**, so Nest's own filters
    format the response; no `@nestjs/core` import; no conflict with a user's own filter). Empirically catches
    handler/service/pipe errors — i.e. all real unhandled bugs — but **not guard-thrown errors** (guards run
    before the interceptor subscribes; almost always expected 4xx anyway).
  - **Opt-in `errorCapture: 'filter' | 'both'`** adds a global `ExceptionFilter extends BaseExceptionFilter`
    (`Catch()` applied functionally) that ALSO catches guard errors and delegates via `super.catch()`; `'both'`
    shares a per-request WeakSet so an error seen by both seams reports **once**. A `@BugseeExceptionCaptured()`
    decorator is the escape hatch for users who already have their own global filter (the Sentry-studied
    collision). `app.getHttpAdapter()` is passed to the filter so `super.catch()` works in the non-DI path.
  - **APM** `http.server` txn finishes with OK/ERROR derived from the **thrown error's** status (a 4xx
    HttpException is client control flow → OK; 5xx / non-HttpException → ERROR), since `res.statusCode` is
    unreliable at the rxjs stream's terminal.
  - **Report policy**: skip Nest `HttpException`s (4xx AND 5xx — control flow), report genuine errors;
    overridable via `shouldReport`. Real-Nest e2e on **both** the express and fastify platforms (seam-coverage
    matrix, 4xx-skip, dedup, response preservation, concurrency isolation). 2 review-caught MAJORs fixed
    (Fastify `run`→`enterWith`; txn OK/ERROR from thrown-error status). `@nestjs/*` + `rxjs` are PEERs;
    `sideEffects` omitted (the filter applies `Catch()` metadata at module load).
- **Four more server-side adapters** (`@bugsee/hono`, `@bugsee/elysia`, `@bugsee/hapi`, `@bugsee/koa`) —
  **COMPLETE (2026-06-15)**. Each is structural-peer (never imports the framework; the framework is a devDep,
  not a peer dep — only nestjs needed peers, for `BaseExceptionFilter`/`rxjs`), uses the global
  `crypto.randomUUID()`, ships dual ESM+CJS, and has a REAL-framework e2e proving error reporting, the
  framework's expected-error skip, response preservation, and concurrency isolation. The per-framework
  deltas — each empirically probed before building — are the interesting part:
  - **`@bugsee/hono`** (`setupHono`): a single middleware. Hono's `compose` routes a thrown error to
    `app.onError` BEFORE it reaches the middleware, so the error is read from **`c.error`** after `next()`
    (NOT a try/catch around next, and the user's onError is untouched). `c.res.status` is reliable → OK/ERROR
    by `status >= 500`. Skips Hono `HTTPException` (duck-typed `getResponse`). e2e via `app.request`.
  - **`@bugsee/elysia`** (`setupElysia`): 3 additive hooks — `onRequest` (`enterWith` + txn, WeakMap by
    request), `onError` (report by Elysia's `code`: `UNKNOWN`/5xx report, named-4xx skip), `mapResponse`
    (finish — `onAfterResponse` doesn't fire via `app.handle`, which is the only Node entry — `.listen` is
    Bun-only). Code-derived status fidelity. e2e via `app.handle`. Elysia's deeply-generic hook types need a
    structural cast (documented).
  - **`@bugsee/hapi`** (`setupHapi`): `onRequest` (`enterWith` + txn) + `onPreResponse` (report a Boom error —
    Hapi's `isServer` is the 5xx signal — + finish). A client disconnect finishes the txn `CANCELLED` (parity
    with fastify). e2e via `server.inject`.
  - **`@bugsee/koa`** (`setupKoa`): a single middleware. Koa's compose DOES propagate a throw up through
    `await next()`, so the middleware catches → reports → re-throws (Koa's onerror still formats the
    response). Status from the error on the error path (`ctx.status` is unreliable in the catch); skip 4xx
    (`ctx.throw(404)`), report no-status/5xx. e2e via a real `http.Server`.
  - (**Restify was built then dropped** — it is unmaintained (last release Jan 2024) and doesn't import on
    Node ≥18; not a target our customers would adopt. See the "After browser" note.)
- **Incoming-server auto-instrumentation + shared server-instrument core (in `@bugsee/node`)** —
  **COMPLETE (2026-06-16, on `main`)**, design `docs/design/incoming-server-instrumentation.md` (the
  authoritative doc; it absorbed & supersedes `generic-server-adapter.md`). `@bugsee/server-adapters` was
  **RETIRED** — its engine is now `packages/node/src/server-instrument.ts`, renamed `openBugsee*`→`server*`
  and **extended**. What landed:
  - **Shared core** (`server-instrument.ts`): plain-values in (`ServerRequestInfo{method,url,route?,
    traceparent?,user?}`), a `ServerRequestSpan{setRoute, captureError(err,{shouldReport?})→bool,
    finish(status,outcome?), cancel()}` out. Entries: `runServerRequest` (`store.run`-scoped — the
    node:http patch / native wraps / express / koa / hono), `openServerRequest` (`enterWith` — fastify /
    hapi / elysia), split `openServerContext` + `startServerSpan` (nestjs middleware vs interceptor), and
    `getActiveServerSpan`. **First-owner-wins re-entrancy:** the first opener OWNS the context + the
    `http.server` txn and stashes its span (with a `runScoped` flag); a later opener gets a REFINING handle
    (setRoute/captureError act on the owner; finish/cancel no-op) — exactly ONE context + ONE txn even when
    the http layer AND a dedicated adapter both run. Only a **run-scoped** owner is refinable (an enterWith
    adapter's context can linger across a shared async context — e.g. Elysia's `app.handle` — and must not
    be mistaken for this request's owner). `finish(status, outcome?)` keeps an EXPLICIT outcome (D10) for
    Nest/Elysia. Robust `defaultShouldReport` (duck-types `getStatus`/`status`/`statusCode`/Boom
    `output.statusCode`).
  - **node:http interceptor** (`http-server-interceptor.ts`): patches `http(s).Server.prototype.emit`
    (`https` patched separately — it doesn't inherit via `http.Server.prototype`); brackets `'request'` via
    `runServerRequest`; finishes on the response's `'close'` (AFTER `'finish'`, so an adapter's `setRoute`
    lands in the txn name first), `writableFinished` → finish-by-status vs cancel; self-isolates
    `x-bugsee-internal`; restores by `delete` (the prototype's `emit` is inherited). A `ServerInstallable`
    (install/uninstall, launch/stop-driven — not subscriber-driven).
  - **Native `Bun.serve`/`Deno.serve` wraps** (`@bugsee/bun`/`@bugsee/deno`): `wrapFetchHandler` (shared,
    in `@bugsee/node`) instruments a Fetch `Request→Response` handler; the per-runtime interceptors patch
    the global `serve` and self-skip when it is absent. Spiked first on real Bun 1.3 + Deno 2.8 (§8.0).
  - **All 7 adapters refactored onto the core** (express/fastify/nestjs/hono/elysia/hapi/koa): each keeps
    its own `shouldReport` + route extraction, but the context/txn mechanics + re-entrancy come from the
    core. nestjs is split (middleware `openServerContext` skips when a context is already active;
    interceptor `startServerSpan` refines the http owner; error capture stays `reportErrorOnce` for the
    `both`-mode WeakSet dedup the core span does not model).
  - **ON BY DEFAULT** (`instrumentIncomingRequests`, default `true`; `false` opts out — D3 flipped). The
    flip re-baselined only 3 wiring tests (1 node + 1 bun + 1 deno + their escape-hatch tests); every
    adapter e2e now exercises the coexistence path. All test-first (mutator, 100%) + multi-agent-reviewed.
  - **Follow-ups:** a real-runtime incoming-server e2e in `@bugsee/instrumentation-tests`; an opt-in
    `http.url` query-strip; Bun `routes`/websocket, `Deno.serve` non-handler options, `server.reload()`
    survival, `node:http2`, WS upgrade (documented gaps — design §10).

### Dual-module (ESM + CJS) packaging — COMPLETE (2026-06-15, on `main`)
Every implemented package now publishes **both** ESM and CJS, per `docs/design/packaging-dual-module.md`
(D1 all-dual + externalize, D2 tsup, D3 publishConfig swap, D4 dual `.d.ts`/`.d.cts`, D5 umbrella
conditions). Shape:
- A shared `tsup.config.base.ts` preset (`entry: src/index.ts`, `format: ['esm','cjs']`, `dts`, externalize
  `@bugsee/*` + declared deps) that each package's one-line `tsup.config.ts` spreads → `dist/index.js`
  (ESM) + `dist/index.cjs` (CJS) + `dist/index.d.ts` + `dist/index.d.cts`.
- **Dev still consumes `src` directly** — the top-level `exports` are unchanged; a per-package
  `publishConfig.exports` (import→`.js`/`.d.ts`, require→`.cjs`/`.d.cts`) swaps in only at `pnpm publish`.
  No build step for in-monorepo development.
- The **`@bugsee/bugsee` umbrella** is special-cased: a **multi-entry** build (`src/index.ts` +
  `src/index.node.ts`, each dual) and per-runtime × per-module `exports` conditions
  (`browser|node|default` × `import|require`) routing to the matching dist artifact.
- Rolled out test-by-proof, not by unit test: P1 (`build(util)`, commit `7db1e87`) established the pipeline +
  proved it on `@bugsee/util`; P2 (commit `a696f31`) extended it to the other 17 + the umbrella. Verified
  END-TO-END by packing the full `@bugsee` dependency tree into a temp `node_modules` and confirming both
  `require('@bugsee/node')` and `import('@bugsee/node')` resolve through the built dist chain (incl. the
  external `fflate`) and `launch()` returns a working client; the umbrella resolves
  node→`index.node.{cjs,js}`, browser→`index.cjs`. Gates green (typecheck 57/57, tests 2013/2013, no cycles).
### `@bugsee/webworker` — Web Workers + Service Worker **COMPLETE** (2026-06-29; SW finished 2026-07-03, on `main`)
A DOM-less browser-family worker SDK. Composition = the clean edge launch (memory-only, no durable queue, no
context provider) with the browser's two detection providers swapped in (`createWindowErrorProvider` /
`createUnhandledRejectionProvider` on the worker `self` — they take any addEventListener target, so the
multi-dialect stack parser is REUSED, not duplicated; webworker depends on `@bugsee/browser` like cloudflare→
vercel-edge) + a DOM-stripped env (`buildWorkerEnvironment`: browser envelope minus screen — a worker has
`navigator` but no `screen`/`window`; `platform.type` `web-worker`/`service-worker`). Capture: console→log +
network (fetch/ws; xhr active in a dedicated worker, self-skips in a SW). **DEDICATED/SHARED Web Workers are
v1-complete** (long-lived → memory + fire-and-forget flush suffice). **Service Worker SUPPORTED** (the review
flagged a SW is killed when idle → memory + fire-and-forget under-serves it; addressed): (1) `withBugseeEvent`
(event.ts) hands the SDK flush to `event.waitUntil`, keeping the SW alive until the upload completes (the SW
analog of edge's `ctx.waitUntil`), and (2) a durable IndexedDB bundle queue (`persist`, default ON for
'service-worker') persists each incident bundle + `recover()` re-uploads any a prior activation left behind on
the next launch — reusing browser-utils + core (same pattern as `@bugsee/browser`). So an assembled crash
bundle survives termination. 32 tests, 100% coverage; mutation loops (env/launch/event/persist) + 2-agent
review. README + design matrix §3.2 (Web Worker xhr ✓) updated. **The rolling-buffer follow-up is DONE**
(#165, `f4193f4`, 2026-07-03): the capture buffer now persists across activations via the IDB chunk capture
store + report-marker store, with `recoverReports` re-reporting what a prior activation left behind — the
cross-activation case that memory-only capture could not serve. Nothing outstanding on this milestone.

### Browser/worker multi-instance IDB coexistence — DONE (bundle queue + capture/markers) (2026-06-30, on `main`) → `docs/design/browser-multi-instance-coexistence.md`
The browser-tier counterpart of the node multi-instance disk coexistence. IndexedDB is **origin-scoped**, so N
tabs + the page's web/service workers all share it; before this, the durable bundle queue (and, under
`persist:true`, the capture-chunk + report-marker stores) used shared, un-namespaced DBs → siblings
**cross-recovered** each other's data, **swept** each other's live capture, and different app tokens could upload
to the **wrong project**. Fixed across slices 1–5 — all in `@bugsee/browser-utils`, wired into both launches:
- **Per-instance namespacing** — each launch writes ALL its durable data (bundles + capture chunks + markers)
  under its own `"<instanceId>/"` key prefix in per-APP-TOKEN DBs (`bugsee-<hash>`, `bugsee-capture-<hash>`,
  `bugsee-markers-<hash>`; FNV-1a sync hash = wrong-project guard). A reload = a fresh instanceId, so the prior
  session is just a **dead sibling**; the random instanceId makes cross-tab key collisions impossible (so
  `generation` stays wall-time, unchanged).
- **Web Locks liveness** (`createWebLockLiveness` over `navigator.locks`) — each instance holds ONE exclusive
  lock for its realm's lifetime (auto-released on death → no staleness window, no PID-reuse, STRICTLY better than
  node's heartbeat). The SAME lock gates bundles + chunks + markers; it doubles as the recovery **claim +
  serializer** (recover a dead sibling INSIDE its held lock so a peer skips). `holdSelf` rejections are
  caught→`warn`. Degrades (no cross-recovery + one-time warn) where absent.
- **`createCoexistence`** (the unified launch helper) builds the per-instance bundle store + capture/marker
  VIEWS + ONE dead-sibling coordinator: discover sibling instanceIds (union of bundle ∪ marker ∪ capture stores
  — new keys-only `AsyncKeyedStore.keys()`), then per DEAD sibling under its lock re-upload its bundles
  (`recoverSiblingBundleQueue`, BASE pipeline) AND rebuild+deliver its incidents (core `recoverReports` over its
  prefixed views, `currentGeneration:-1`). **ALL recovery is dead-sibling recovery** (BD9): self's namespaces are
  fresh/empty, so even a single-tab crash is recovered as a dead sibling next launch — the old self-recoverReports
  + preserve-prior-generations was removed. **`recoverReports` (core) is UNCHANGED → node unaffected.**
- The webworker is bundle-only (no capture-recovery path yet, #165). An explicit `bundleStore`/`captureStore`
  override bypasses the respective coexistence. Injectable `locks`/`indexedDB` seams.
- browser-utils/browser/webworker all **100% coverage**; per-entity mutator loops; **convergent multi-agent
  review** per slice (slice 4: 4 agents; slice 5: 3 agents + a fresh round, both CONVERGED) → SEV findings fixed
  test-first (slice 4: `holdSelf` rejection→warn, live-sibling-skipped e2e, wrong-project isolation; slice 5: the
  per-sibling + per-source recovery error-isolation tests for the inline coordinator).

> **✅ The SEV1 multi-tab capture/marker hazard (a live tab sweeping/stealing another live tab's capture) is
> CLOSED by slice 5** — a LIVE sibling holds its Web Lock, so a launching tab's `recoverDeadSiblings` skips it
> entirely; it never reads, recovers, or sweeps a live tab's data. Verified by the fresh-round review (both
> agents CONVERGED; the live-store's own `cleanOtherGenerations` pass is confined to self's prefixed view).

- **Stub-only packages skipped** (electron, replay\*, framework frontend adapters):
  they gain the identical dual config when implemented. (`@bugsee/vercel-edge` + `@bugsee/cloudflare` now HAVE it — DONE, below.)

### Vercel Edge runtime (`@bugsee/vercel-edge`) — COMPLETE (2026-06-25, on `main`) → `docs/design/edge-runtime.md`
A runnable **Vercel Edge** (`edge-light`) SDK — and the shared edge composition `@bugsee/cloudflare` (C1) will build on. Edge is a V8-isolate, Web-APIs-only runtime (`fetch`/`Request`/`Response`/`crypto.subtle`; NO `node:*`/DOM/`fs`), so the launch strips node's durable queue / crash-recovery / IndexedDB / window·process detection and assembles the runtime-portable kernel over the WinterCG `fetchTransport` + an in-memory capture store. Slices E1–E6:
- **INCIDENT-DRIVEN capture** (the resolved per-invocation-upload concern): a clean request uploads NOTHING (the in-memory buffer is discarded when the isolate ends); only `logException` / a thrown handler / an `unhandledrejection` triggers an upload — a normal bundle to the same `/upload` endpoint. No new backend, no per-invocation streaming.
- **Surviving the isolate freeze (E5):** `withBugseeFetch(client, handler)` runs each request in its own `run()`-scoped context, captures + **RETHROWS** a thrown error, and flushes the eager upload inside `ctx.waitUntil(client.flush())`. `resolveWaitUntil` acquires `waitUntil` from the `@vercel/request-context` global symbol on Vercel (gated on `typeof EdgeRuntime === 'string'` — Vercel has NO `ctx` param) or the explicit `ctx` arg on Cloudflare. The incident context is stamped with `http.method` + the request PATH (`http.url`; query DROPPED — report attrs skip the redaction pipeline) so the report names the failing route.
- **Run()-ONLY ALS (E2):** a portable `RequestContext` store that probes `globalThis.AsyncLocalStorage` (built-in on Vercel; Cloudflare needs the `nodejs_compat`/`nodejs_als` flag) and degrades to a single-slot store + one-time warn — NEVER throws at import; uses ONLY `run()`/`getStore` (no `enterWith`, absent on the WinterCG subset). E3 resolved by analysis (no IsolatedPromiseBuffer — incident-driven enqueue-eagerly + flush-within-`waitUntil` + `fetchTransport`'s response-body drain suffice).
- **unhandledrejection safety net (E5b):** a DetectionProvider over `addEventListener('unhandledrejection')` (V8-parsed stack), gated by `detectCrashes`, self-skips a non-edge target.
Public `launch()` (= `launchEdge`). Built test-first + mutator-looped, then a **3-round multi-agent convergent review**: the impl was correct throughout (the concurrency/re-entrancy model verified SOUND — one client / many concurrent requests, `flush()` never truncates the shared store, correlation-by-tagging matches node; redaction confirmed ACTIVE on the edge path); rounds fixed test-strength gaps + added the route-stamping. 53 tests, 100% line/fn/stmt + ≥90% branch, node-free dist. **Deferred:** source-map upload tooling (X1), edge-APM (per-request transactions; the Workers monotonic-clock clamp makes in-isolate timing unreliable).

**`@bugsee/cloudflare` (Cloudflare Workers / `workerd`) — C1 COMPLETE (2026-06-28, on `main`).** A THIN composition: the `@bugsee/vercel-edge` edge core with the platform identity defaulted to `'workers'` — mirroring the bun/deno → node precedent (`export * from '@bugsee/vercel-edge'` + an explicit `launch` that shadows the re-exported edge-light one with `{ platformType: 'workers', ...options }`; a caller-supplied option still wins). The two Cloudflare specifics need NO new code — they're handled generically by the shared core: **ctx.waitUntil** comes from the handler's 3rd arg (`fetch(req, env, ctx)`; `resolveWaitUntil` tries the explicit `ctx` first), and **AsyncLocalStorage** is probed off `globalThis` (Workers exposes it only under the `nodejs_compat` / `nodejs_als` flag — README documents the `wrangler.toml` setting + the single-slot degrade). A fetch Worker is fully functional with C1 (launch + `withBugseeFetch` + incident upload + `unhandledrejection`; redaction active via the shared `createClient`). 6 tests, 100% coverage, node-free dist, single-round review (zero findings).

**C2 + C3 COMPLETE (2026-06-28, on `main`).** First a shared-core extraction (**C2a**, vercel-edge `2ef680b`): `runInEdgeContext` — open a per-invocation context (caller attributes), capture+rethrow INSIDE it (the capture-inside-run correlation rule), flush via the resolved `waitUntil`; `withBugseeFetch` refactored onto it (behavior-preserving). Then **C2** (`e6e51f4`): `withBugsee(config, handler)` — the unified wrapper that instruments a whole Cloudflare module Worker. It wraps the handler-OBJECT types `fetch` + the non-fetch triggers `scheduled`/`queue`/`email`/`tail` (which have NO incoming Request, so a fetch-only SDK misses them), each in its own context stamped with OTel `faas.*` attributes (`faas.trigger`/`faas.cron`/`faas.time`/`messaging.*`) + a `cloudflare.handler` marker, capture+rethrow, flush via that handler's `ctx.waitUntil`. PII-safe (no email from/to, no message bodies). Because `env` (and the app token, a Worker SECRET) isn't available at module scope, `config` is a `(env)=>token|options` CALLBACK (or static); the client launches lazily on first invocation + caches per-isolate. **C3** (`e6e51f4`): `request.cf` enrichment — fetch incidents carry a curated low-PII geo/network subset (`cf.colo`/`country`/`city`/`timezone`/`asn`/`as_organization` + `http.protocol`/`tls.version`; NOT lat/long). Structural Cloudflare types are local (no `@cloudflare/workers-types` dep). 29 tests, 100% coverage, node-free dist; 2-agent review (impl sound — signatures/env-wrinkle/faas/cf all confirmed vs real Cloudflare + OTel — fixed 2 test gaps + the canonical `faas.time` rename).

**C2d — DO / WorkerEntrypoint CLASS instrumentation COMPLETE (2026-06-28, on `main` `a249653`).** Cloudflare's class-based handlers (Durable Objects + WorkerEntrypoint) receive their `ctx`/`env` in the CONSTRUCTOR (not per-method), so they can't use the handler-object `withBugsee`. Following `@sentry/cloudflare`'s split: **`instrumentDurableObject(config, DOClass, {instrumentRpcMethods?})`** wraps a DO's lifecycle (fetch with http+cf attrs, alarm) + opt-in arbitrary RPC methods (default off, like Sentry's `instrumentPrototypeMethods`); **`withBugsee` ALSO accepts a `WorkerEntrypoint` class** (an overload, folded in like Sentry's `withSentry`) instrumenting its fetch/scheduled/queue/email/tail + opt-in RPC. Shared class-mixin core (`instrument-class.ts`): a subclass that captures the constructor's ctx (arg 0, has `waitUntil`) + env (arg 1), lazily launches the client (cached per-isolate, via the shared `launch-config.ts`), and shadows each target method with a per-instance wrapper running it in a Bugsee context + capture + flush. Uses subclass + own-property shadowing (NOT a Proxy) so the class's **private `#` fields keep working** (methods run with `this` = the real instance); non-Response RPC return values are preserved. **DO flush gotcha (review SEV1, fixed):** `DurableObjectState.waitUntil` EXISTS but is a documented NO-OP ("no effect in Durable Objects") — so the DO incident flush MUST be **awaited in-request** (`runInEdgeContext` `awaitFlush:true`; the request handler's pending promise is the only thing that keeps a DO alive), unlike WorkerEntrypoint/module Workers whose `ExecutionContext.waitUntil` is effective. DO also auto-instruments the WebSocket Hibernation handlers (`webSocketMessage`/`Close`/`Error`). 48 tests (cloudflare) + 63 (vercel-edge), 100% coverage, node-free; mutation-looped + 2 review rounds → converged. (Research correction: Sentry ships `instrumentDurableObjectWithSentry` in the SAME `@sentry/cloudflare` package — a separate function, not a separate package — and folds WorkerEntrypoint into `withSentry`; arbitrary plain-Worker RPC bodies, issue #16898, remain unfinished there too.)

### `@bugsee/webview` — JS SDK inside native mobile WebViews — JS SIDE COMPLETE (slices 1–7, 2026-06-30, on `main`) → `docs/design/webview-bridge.md`
Runs the new JS SDK INSIDE an embedded native WebView and streams its capture UP across the WebView boundary to the hosting native (Android-first) Bugsee SDK, replacing the thin legacy `webview-inject-script`. **The inversion:** reuse `@bugsee/browser`/`@bugsee/capture` capture but swap the `CaptureStoreToken` for a `HostBridgeCaptureStore` that serializes each entry to a versioned protocol message and posts it across the boundary live — **NATIVE is the ring buffer + the bundler**; NO upload pipeline / bundle store / IndexedDB. Slices:
- **1–2 protocol + skeleton + full-parity payloads:** a versioned JSON envelope (`{b,k,t,s,ts,mono,o,tr,red,p}`; kinds hello|entry|batch|report|secure|control|bye; `p` = the entry's serialized JSON string, native does one `JSON.parse` keyed by `k`) over an Android `@JavascriptInterface` `BugseeBridge.post` channel; the `hello` capability handshake; `__bugsee_bridge.control` for native→JS; every captured FileType streamed; the report path (every incident ALWAYS streams a `crash` ENTRY, + a `report` TRIGGER gated behind `reportTrigger`, **D5 default OFF**).
- **3 control commands:** `pause`/`resume` drop+resume the capture stream (incidents unaffected); `flush` awaits pending; `stop` ejects; `snapshot` re-pushes secure rects.
- **4 obscuring (D10):** a READ-ONLY DOM tracker streams the **document-absolute** viewport rects of sensitive elements (password/cc inputs → `text`, `.bugsee-hide` → `hidden`; `.bugsee-show` opt-out) so native masks the pixels; **top-frame only**; declaring the `obscuring` cap is what lets native drop its legacy masking script. NEVER mutates the app DOM.
- **5 redaction (D3):** `network`/`log`/`breadcrumb`/`report` filter launch options install into the core `filters` service; a per-entry-type `red` provenance flag (live/lazy) tells native a JS pass ran — native ALWAYS re-redacts, so `red` is provenance-only/privacy-safe.
- **6 injectable IIFE build (D7):** a self-contained minified `dist/bugsee-webview.iife.js` (~22 KB gzip) that defines the `BugseeWebView` global the native bootstrap calls, + the dual ESM/CJS npm entry; e2e size/self-contained/node-free/loadable guard.
- **7 conformance harness:** `bridge-protocol.schema.json` (machine-checkable JSON Schema, shipped) + `webview-conformance.e2e.ts` (jsdom) boots the REAL SDK vs a mock native receiver, validates EVERY message against the schema (ajv) + asserts the full-session round-trips. **This schema + harness ARE the reference spec for the Android team.**
Every slice test-first, 100% line/fn/stmt + ≥90% branch, per-entity mutator loop, convergent multi-agent review.
- **Sub-frame secure-rect composition (D9) — DONE (2026-07-01).** The last JS item blocking native legacy-suppression. Android-canonical VIEWS_BUBBLE port (`obscuring-composer.ts`): obscuring runs in every injected frame; a sub-frame `postMessage`s its viewport rects to its parent (verified-iframe-only, sanitized, non-PII), each frame folds in a child's rects re-mapped by the iframe offset (fresh each compose), the TOP frame adds page scroll → document-absolute → posts `secure` + alone declares the `obscuring` cap. Composition only ADDS rects (over-mask-only, never leak). The wire protocol/schema are UNCHANGED (the bubble is internal JS↔JS).
**Remaining (out of this repo): the native receivers.** Android's is code-complete on the `android/` repo; iOS's was ported and is in review (Gerrit 16606–16621). Native owns the final "coverage complete → fully drop legacy" decision (it knows its D9 injection set). The per-sub-frame entry/origin attribution question is **CLOSED (2026-08-20): not needed** — a sub-frame runs obscuring only and captures nothing, so there are no sub-frame entries on the wire to attribute; see `docs/design/webview-bridge.md`.

### Meta-framework adapters — `@bugsee/adapter-kit` + Remix DONE + Nuxt COMPLETE (2026-07-07, on `main`) → `docs/design/meta-framework-adapters.md`

The SSR meta-frameworks are the shipped `@bugsee/nextjs` adapter with different **seam names**, composed over `@bugsee/{node,browser,vercel-edge}` + a UI adapter via a fixed set of reusable primitives. Ecosystem-first build order (D7): `K0 → Remix → Nuxt → SvelteKit → Astro`.

- **`@bugsee/adapter-kit` (K0)** — the shared portable primitives (deps: `@bugsee/core` only): `reportServerError` (P4, the `onRequestError` analog), `getTraceparent`/`traceMetaEntries`/`traceMetaTag` (P5, the trace `<meta>` channel). `@bugsee/nextjs` retrofitted onto it.
- **`@bugsee/remix` — essentially complete** (RR7 **and** Remix v2): `handleError`/`createHandleError` (server error hook, skips aborted) · `registerServer` (node `launch`) · `registerClient` + `bugseeOnError` (RR7 `<HydratedRouter onError>`) + `captureRemixErrorBoundaryError` (v2 root `ErrorBoundary`) · `getBugseeTraceMetaTags` + `getBugseeMetaTagTransformer` (node stream, splices before `</head>`). Remaining: R4 (RR7 native route-name instrumentation, beta) · R6 source-maps (#158).
- **`@bugsee/nuxt` — MOAT COMPLETE + real-boot validated.** A Nuxt Module (`modules: ['@bugsee/nuxt']` + `bugsee: { appToken, client?, server? }`): `src/module.ts` (`defineNuxtModule`, build-time only) writes runtimeConfig (client→public, server→private, defu-merged under user/env), registers the browser plugin as a generated `#imports` template (no heavy `nuxt` dep), and `addServerPlugin`s the shipped `runtime/nitro-plugin`. `installBugseeNitro` (one Nitro plugin) launches `bugsee/node` (its `node:http` emit-patch opens the per-request context — no `--import` preload) + wires `nitroApp.hooks('error')` (report, skips <500 H3) + `render:html` (inject `<meta name="traceparent">` for zero-config FE↔BE join; best-effort, never breaks SSR). Client = `installBugseeClient` (`bugsee` browser + `@bugsee/vue` error handler on the Nuxt Vue app). Portable `.` entry (only `@nuxt/kit` + type-only). **Validated by `@bugsee/nuxt-e2e`**: nuxi-builds a fixture app → boots the node-server `.output` vs a mock collector → asserts a thrown route uploads a real bundle (our `http-error` mechanism + the thrown message) + the SSR HTML carries the traceparent meta. Every slice test-first + mutator + multi-agent review to convergence. **Edge (U6) DONE** (`153ec49`): the module branches the shipped Nitro plugin on the build-time preset (`isEdgePreset`) → an edge preset ships `installBugseeNitroEdge` (composes `@bugsee/vercel-edge`; reports on the `error` hook, held past the Response by the resolved `waitUntil` — Cloudflare event ctx / Vercel global symbol), never `bugsee/node` (verified both ways + a real-Nuxt `vercel-edge` build e2e). v1 = edge error reporting; full run()-context/trace on edge is a documented v2 (Nitro owns the fetch entry). **@bugsee/nuxt is COMPLETE across node-server AND edge** — the only remaining item is U7 source-maps, externally blocked on #158.
- **`@bugsee/sveltekit` — COMPLETE (node + edge), real-boot validated.** Function-exports (like Remix): `hooks.server.ts` `handleErrorWithBugsee` (server error → adapter-kit) + `handle` (wraps `resolve()` → injects `<meta traceparent>` via `transformPageChunk`; node context from @bugsee/node emit-patch) + `registerServer` (`./server`, bugsee/node); `hooks.client.ts` `handleErrorWithBugsee` + `registerClient` (`./client`, re-exports @bugsee/svelte). **Edge (`./edge`) — the differentiator:** because SvelteKit's `handle` WRAPS `resolve()`, `createEdgeHandle` wraps it in `runInEdgeContext` for a FULL run()-scoped context on edge (Sentry unsupported). `.` entry portable. Validated by a **real-SvelteKit adapter-node boot e2e** (`@bugsee/sveltekit-e2e`: thrown endpoint → uploaded bundle w/ http-error + message; SSR HTML has the trace meta). Multi-agent reviewed (fixed a missing publishConfig; edge flush/report ordering verified — no double-report). Remaining: edge boot e2e (adapter-vercel/cloudflare) · source-maps (#158).
- **`@bugsee/astro` — COMPLETE (node + edge), real-boot validated.** Island-agnostic (browser-launch only; the user adds their island UI adapter). Delivered as an Integration (`integrations: [bugsee({ appToken })]`) that at `astro:config:setup` injects the browser launch (`injectScript('page')`) + a generated server-middleware virtual module (`addMiddleware`, `order:'pre'`) that launches the server SDK **from the middleware** (Astro has no onRequestError; the middleware wraps `next()` in try/catch to report + rethrow, and injects the trace `<meta>` via an HTML response-rewrite). Edge = `createEdgeMiddleware` wraps `next()` in `runInEdgeContext` (full run()-context). Validated by a real-Astro `@astrojs/node` boot e2e that is **endpoint-first** (probes an endpoint, hits `/api/boom` before any page) — proving the middleware-launch fix (a review-caught major: `page-ssr` is page-gated, so it would have dropped endpoint-first reports). Multi-agent reviewed to convergence.
- **🎉 The 4 SSR meta-framework adapters are COMPLETE: Remix + Nuxt + SvelteKit + Astro** — all node + (Nuxt/SvelteKit/Astro) edge, each real-boot validated + convergence-reviewed, over the shared `@bugsee/adapter-kit`. Only shared follow-ups remain: source-maps (blocked on **#158**) + edge *boot* e2e for SvelteKit/Astro (needs adapter-vercel/cloudflare + an edge VM).

### After browser
- ~~`@bugsee/bun`~~, ~~`@bugsee/deno`~~, ~~`@bugsee/vercel-edge`~~, ~~`@bugsee/cloudflare`~~ (C1 DONE, above), ~~`@bugsee/webworker`~~ (Web Workers DONE; SW partial, above), ~~`@bugsee/webview`~~ (JS side DONE, above), ~~`@bugsee/electron`~~ (E0–E8 DONE + convergent-reviewed, above).
- Per-runtime `exports` conditions in `package.json` — the `@bugsee/bugsee` umbrella now HAS them (browser/node,
  see the dual-module milestone above); the platform packages (`@bugsee/browser`/`node`) are still
  single-entry (split when their runtimes branch). This is the *runtime* split, orthogonal to the ESM/CJS
  *module* split that already landed for every package.
- Framework adapters: **express + fastify + nestjs + hono + elysia + hapi + koa** are **DONE** (see the milestone above). (**Restify was built then dropped** — unmaintained since Jan 2024, doesn't import on Node ≥18; not a customer target.) Remaining: **backend** `nextjs`-server (DEFERRED — it straddles frontend RSC + backend + edge/middleware + the `instrumentation.ts` build hook, so it needs its own design pass) and `nestjs` microservice/GraphQL transports; **frontend** `react`/`vue`/`svelte`/`angular` (error boundaries over `@bugsee/browser`).
- Pluggable extensions: `@bugsee/performance` (APM), `@bugsee/replay`, `@bugsee/replay-canvas`.
- ~~Per-runtime smoke harness~~ (DONE — `@bugsee/instrumentation-tests`, above); mutation-testing CI (Stryker, opt-in).

---

## 7b. Adversarial-review remediation — Waves 0–7 + V0 COMPLETE (2026-08-06, on `main`)

The 53-package adversarial review (`docs/review/`, ~90 SEV1s) was remediated wave by wave. The plan, every
status, and the reasoning behind each decision live in **`docs/review/REMEDIATION-PLAN.md`** — read that
before picking anything up here; this is only the summary.

**Root cause of most of the review's findings: no e2e suite ran in CI.** That was fixed first (3a.1), and
the rest of the harness work (Wave 3b) is what surfaced the worst remaining defects.

**Closed:** Waves 0 (security), 1 (privacy), 2 (host-boundary containment), 3a/3b (harness depth),
4 (features that silently do nothing), 5 (wire correctness), 6 (durability), 7 (hygiene, 7.1–7.9), the two
Cloudflare SEV1s that appeared in no wave table, and **V0** (the shared verification substrate).

A representative slice, each verified against the real runtime rather than a fake:

| Defect | Measured |
|---|---|
| `'exit'` never fires on a signal | `kill -TERM` → exit 143, handler never ran; every graceful container shutdown lost the buffer |
| No page-lifecycle flush in the browser | `pagehide` was recorded as an event and consumed by nothing — the comment claiming a flush described an intention |
| No write back-pressure | stalled IndexedDB held 20 000 writes / **191 MB**; a full disk gave 19 998 doomed syscalls + 19 998 `onError` |
| No durable-queue retention | a bundle the collector REFUSED was re-uploaded at every launch, forever |
| IDB torn-record intolerance | one corrupt record destroyed a whole generation's recovery, permanently |
| Liveness misread a frozen process | real SIGSTOP: subtree deleted underneath a LIVE instance; writes then failed ENOENT forever |
| Umbrella had 3 `exports` conditions | Bun 1.3.14 reported as `node` 24.3.0 and lost `Bun.serve` instrumentation entirely |
| `next build` | **FAILED outright** — twice over, the second time from tier-0 `@bugsee/util` pulling `node:crypto` into every edge graph |
| Nuxt zero-config Cloudflare | shipped the NODE SDK into a workerd bundle (preset resolved after modules run) |
| `instrumentRpcMethods` | DELETED the customer's Durable Object RPC surface — own-property shadowing vs prototype dispatch |
| Source-map plugin | could unlink `.map` files under `node_modules/` and `src/`; `dryRun` aborted the build |

**The recurring lesson, worth more than any individual fix.** Six tests were found asserting the very defect
they existed to prevent — elysia calling the hook Elysia skips, node recovery naming a subtree `9-9-…` while
its owner said `threadId: 0`, cloudflare requiring `Object.hasOwn(instance, 'fetch') === true`, core pinning
`level: 'info'`, the bundler pinning `--dry-run` on both commands, and a "nested components" fixture
containing siblings. A green suite is not evidence; a suite whose mutations die is. **Run the mutator loop
against the assertion itself, not only against the implementation.**

**Still open (unchanged by this work):**
- **Wave V's ~30 sample apps.** V0's substrate is `@bugsee/e2e-kit`; the app scaffold half is partly served
  by `instrumentation-tests/app` + `runtimes.ts` and the four real-framework harnesses. A generalised
  per-package scaffold does not exist.
- **~190 SEV3s** — a long tail, not individually enumerated.
- **Externally gated:** 0.3 (Android WebView receiver), 1.5 (rrweb fork), 5.4 (backend wire coordination).
- **4.8 — a decision, not a task:** delete `@bugsee/integration-shims` or build the §372 integration-object
  API it presupposes.
- **Known flake:** `instrumentation.e2e.ts > 'node' > the AppHang bundle carries a CPU profile whose samples
  include the blocking frame` — 3 of ~13 FULL parallel runs, never in isolation. CPU starvation and
  rolling-window rotation are both ruled out by measurement. No fix was shipped because it could not be
  reproduced; the assertion now prints the profile window, sample count and busiest frames on failure.

### 2026-09-17 — A request decorator can no longer break the app's request

`capture/src/request-decorator.ts` — the transformer seam the fetch and XHR interceptors run INLINE,
before the app's request is sent. A throwing decorator used to propagate out of the patched call: the
app's `fetch()` threw synchronously and `xhr.send()` threw, so the request never went out. That was not
only a third-party risk — the built-in trace-propagation decorator reads the active span through the
performance extension. The registry now runs each decorator isolated: a throw, or a throw while its
result is being READ (hostile getter / Proxy), contributes nothing rather than a partial set; a non-object
result is ignored; and headers the platform REJECTS synchronously are dropped entry by entry — names that
are not an RFC 9110 token, values containing CR/LF/NUL or any code unit above U+00FF (measured on
Chromium 151: `new Headers` throws TypeError and `setRequestHeader` SyntaxError for exactly these; tabs,
obs-text and other controls are accepted). The run iterates a snapshot, so a decorator unsubscribing
itself cannot skip a neighbour. Failures are swallowed like every other internal capture failure. Tests
at the registry and through both interceptors; 8 mutations, all caught.

### 2026-09-16 — Stylus tilt and direction on pen input (issue #6)

`InputEvent` (`core/src/events.ts`) gains `altitudeAngle` / `azimuthAngle` — radians, iOS's names and
conventions (`UITouch.altitudeAngle` / `azimuthAngle(in:)`), which Pointer Events Level 3 shares — so the
viewer's pen glyph can draw the stylus "shadow" for web recordings. `browser/src/pen-angles.ts` reads them
for `tool: Pen` only (mouse/touch entries unchanged), on `pointerdown`/`pointerup`/`pointercancel`:
L3 `altitudeAngle`/`azimuthAngle` when present and in range, else a transcription of the spec's
`tilt2spherical` over `tiltX`/`tiltY` (boundary cases included). **The no-data case is omitted, not
written:** the spec REQUIRES hardware without tilt sensing to report altitude π/2 + azimuth 0 and tilt 0/0,
which a viewer cannot tell from a pen held upright pointing right — and omitting them renders identically
(an upright pen casts no shadow). MEASURED on real Chromium 151 via a CDP pen event: it supplies L3 angles,
reports exactly π/2 + 0 (and tilt 0/0) for a pen with no tilt, and its angles for tilt 30/−20 are
bit-identical to the fallback's conversion (pinned as a test vector). Tests pin cardinal/diagonal/flat/boundary conversions, an independent
pen-axis geometry check over a grid of tilts, L3 preference, fallback, and every omission path; 17
mutations caught. (The endpoints-only limitation this entry originally ended on is closed by the next
entry.)

**Follow-up (same day): pen strokes carry their path.** `browser/src/input-source.ts` now listens to
`pointermove` and records `type: 'move'` entries for PEN gestures only — mouse and touch drags stay two
endpoints, since their moves are the volume that kept `pointermove` out originally. Android-canonical
(`InputEventGenerationHelper.registerMoveEvent`): only while the pen is in contact (a hovering pen records
nothing), only when a recorded field changed (`x`/`y` rounded, `force`, radii, the two angles — compared
against the gesture's last entry), at the browser's own frame-aligned pointermove rate, no time throttle. A
move joins its gesture's `id` and carries no target or button (identity lives on `begin`). **Privacy:** a
gesture that BEGAN on a masked target (shared sensitive-input definition, or `[data-bugsee-hidden]`) records
no moves — a pen path there is handwriting (a signature, a PIN drawn on a pad); its press/release stay as
before, target collapsed to masked. Mouse `pointermove`s land in the same listener, so its common case is a
single `Map.size` check. MEASURED on real Chromium 151 with the real source bundled in and a CDP pen
stroke: hover → nothing; stroke → begin + one move per changed sample with pressure/tilt varying, a repeated
identical sample skipped; stroke on a `data-bugsee-hidden` element → begin/end only; mouse drag → no moves.
12 new tests; 11 mutations — 9 caught, 2 survivors are equivalent (the `size === 0` fast path; minting the
move id via the open-gesture map, which always returns the same id).

### 2026-09-16 — `@bugsee/util` sha256 is WebCrypto-only; the node platform injects its digest

The `import('node:crypto')` fallback in tier-0 `util/src/sha256.ts` is gone, so no browser/worker/edge graph
names `node:crypto` any more: a plain esbuild `platform:'browser'` build of `@bugsee/core`/`browser`/
`vercel-edge` now resolves with no `external` (it used to fail `Could not resolve "node:crypto"`; the
computed-specifier workaround stays rejected — workerd throws `ERR_MODULE_DYNAMIC_SPEC`). Without
`crypto.subtle`, `sha256Hex` rejects with a `NotSupportedError`; the upload pipeline then uploads WITHOUT a
checksum (see the follow-up below). `@bugsee/node`'s
`launchCore` passes `nodeSha256Fallback()` (`@bugsee/node-utils`) to `createUploadPipeline`: `node:crypto` only
when `subtle` is absent (unflagged Node 18), otherwise core's WebCrypto default — one hashing path on every
modern runtime, and on Node `subtle.digest` runs off the event loop where `createHash` blocks it (measured:
512 MB, 159 timer ticks during `subtle` vs 0 during `createHash`). Bun, Deno and Electron main inherit it
through `launchCore`. Guards: `browser.e2e.ts` bundles with no `external`; edge X2 rejects a node import of
ANY kind beyond the allowlist; `tsup-node-protocol.e2e.ts` asserts util's dist carries no `node:` specifier.
Closes the OPEN-FINDINGS sha256 item and R3-8.

**Follow-up (same day): the checksum no longer gates an upload.** The pipeline created the issue BEFORE
hashing, and a failed hash was a retryable upload failure — so a runtime without `crypto.subtle` (an insecure
browser context with persistence on) could never deliver its bundle, and the durable queue re-ran it at every
launch, each run leaving another EMPTY issue on the collector until the 7-day retention expired (the old
fallback behaved the same in browsers; not a regression). The checksum is not sent (`bundle-uploader.ts`
omits the header the collector does not sign), so `upload-pipeline.ts` now computes it best-effort
(`checksumOf`) BEFORE `createIssue` — where iOS needs it, since iOS sends `bundle_sha256` in the issue-create
body — and a rejection uploads the bundle with `PutBundleOptions.checksumSha256` absent (now optional). The
node launch integration test watches `node:crypto` hash the PUT body, since delivery alone no longer proves
the injection ran.

---

## 8. Pointers

- **Spec** — `docs/design/sdk-design.md` (Draft v3). Read alongside §2 of THIS file for the as-built deltas.
- **Binding standards** — `docs/implementation-standards.md` (TDD §2, mutator loop §2, multi-agent review §6, coverage gates §4).
- **Tooling & commands** — `docs/dev-environment.md`.
- **Per-session distilled rules** — `CLAUDE.md`.
- **Android parity reference** — `/Users/alexeykarimov/Projects/Bugsee/android/sdk` (API + architecture target; Sentry/Firebase are *internal design references only*, never migration sources).
- **Adversarial review + remediation** — `docs/review/` (the per-package reports) and `docs/review/REMEDIATION-PLAN.md` (the wave plan, every status, and the reasoning behind each decision — including items closed as NOT-a-defect with the measurement behind them).
- **Memory (cross-session, my notes)** — `~/.claude/projects/.../memory/` (notable: `node-build-state.md`, `launch-options-scheme.md`, `core-package-complete-feat-core.md`, `capture-shared-package.md`, `git-remote-is-gerrit.md`, `core-typecheck-gotcha.md`).
