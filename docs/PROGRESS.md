# Bugsee JavaScript SDK — Implementation Progress (Hand-off)

**Status as of 2026-05-30, all on `master` (`origin = ssh://krassx@code.bugsee.com:29418/javascript`, 109 commits, in sync).**

A **runnable Node SDK** exists: capture (console + network + system traces/events), report assembly + signed-PUT upload, uncaught-exception detection with flush-then-exit, and a durable bundle queue that re-uploads crash bundles on the next launch. Public launch-options use Android's canonical `com.bugsee.option.*` identifier scheme internally + on the wire. Every shipped slice was built test-first, mutator-verified, gated at 100% line/fn/stmt + ≥90% branch per package, and passed a multi-agent convergent review.

Read this first; then `docs/design/sdk-design.md` (Draft v3) for the full architecture; then `docs/implementation-standards.md` (§2 mutator loop, §6 multi-agent review — both binding); then `docs/dev-environment.md` for tooling/commands; then `CLAUDE.md` for the per-session distilled rules.

---

## 1. What's implemented

### Tier-0 (foundations — no Bugsee dependencies, pure libs)
| Package | Role |
| --- | --- |
| `@bugsee/types` | Shared TS types (`NameExtensionMapping`, `AccessToken`, `IssueId`, `LogLevelName`, `SeverityName`, …) consumed via declaration merging. |
| `@bugsee/util` | Pure helpers: `fflate` re-export (`zipSync`/`unzipSync`/`gzipSync`/`gunzipSync`/`strToU8`/`strFromU8`), `sha256Hex`, `computeBackoff`, `utf8ByteLength` (allocation-free UTF-8 byte measure for the capture-store byte cap). |
| `@bugsee/logger` | Debug logger (`debug.warn` etc.); platforms route `onError` here. |
| `@bugsee/protocol` | Wire types (`RequestJson`, `EnvironmentEnvelope`, `NetworkEvent` superset incl. `'http'` mechanism, `NetworkStage`, `FileType`, `Mechanism`), `Severity` enum + level conversions, header/JSON/params sanitizers, shape redaction, **`BugseeOption` canonical identifiers + `optionsToWire` (dots → colons)**. |
| `@bugsee/service` | The DI/IoC container: `createServiceContainer`/`defineService`/`Provider` (Firebase-component model, LAZY/EXPLICIT, lazy resolution, deps-via-container, `onInit`, late registration). The backbone of the **internal aggregated object** (see DI note below). |

### Kernel — `@bugsee/core` (the thin kernel; runtime-portable)
- **`Client`** (`createClient`) — composition root: identity/attributes via the single global `Environment`, manual capture (`addBreadcrumb`/`log`/`event`/`trace`/`logException`), provider/extension registration, lifecycle (`launch`/`isLaunched`/`stop`/`flush`). `flush()`/`stop()` await both `uploadPipeline.flush` AND in-flight **report promises** (the path that lets crash flush-then-exit deliver), bounded by an unref'd deadline. **Identity reaches the wire (audit fix A):** `setUserIdentifier` → `request.json.email` at assemble time (Android maps the user identifier to the `email` field — "email from global scope"; no separate `user` field, no `setEmail`). **Internal object / DI (Phase 1, `docs/design/internal-object-di.md`):** the Client now owns a per-process `ServiceContainer` (the "BugseeInternal" — the internal aggregated object); `addService`/`getService`/`getServiceProvider` (a typed `ServiceToken<T>` facade over the generic `@bugsee/service` container — see §7 "DI token migration") + `getInternal(carrier)` reach it process-wide via the singleton client. **Phase 2 (delivers E) — redaction filters as the first real service:** a `filters` service (`FilterStore`) registered in the container; the facade `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`/`setReportHandler` mutate it; the capture pipeline (network/log providers, `addBreadcrumb`, the report path) reads it LIVE via `getFilters()` (the singleton client on the carrier). Filter = mutate or return null to DROP; a throwing filter drops (privacy-safe) + one `onError`. The user network filter REPLACES the built-in sanitizer (Android XOR); the default sanitizer is now gated on `CaptureNetworkDefaultSanitizer`. Report `before` mutates/vetoes before assembly. **Phase 3 (COMPLETE) — every platform seam is a container service, resolved by a typed `ServiceToken`:** Node `launch` creates the `ServiceContainer`, registers the HTTP `transport` (and the rest of the seams), resolves it to build the pipeline, and hands the SAME container to `createClient`; the client exposes `getService(TransportToken)`. Behavior-preserving (the `internalTagged`/override path is unchanged). The full token set, the `ServiceToken` migration (replacing the old `NameServiceMapping` declaration-merge), and the carrier-hosted service-manifest auto-registration path are in §7 "DI Phase 3 / token migration". **Lifecycle (audit fix B):** `logException` after `stop()` is a silent no-op (§1501) until re-launch (a `stopped` flag distinct from `!launched`, so pre-launch capture is unaffected). **Kill-state (audit fix D, §1435/§1504):** a fatal auth failure (401/403 on **session create** = invalid app token; `BugseeError.fatal`) — detected in the upload pipeline (distinct from a recoverable stale-session 401 on issue-create) and observed via `track()` on any report result — flips the client PERMANENTLY dead: one-time `onError`, capture+detection halt, all capture/`logException` no-op, and `launch()` won't re-arm a killed client.
- **Capture data model** (Android aggregator parity): one-way flow `CaptureProvider → CaptureAggregator → CaptureStore (Part/PartManager) → CaptureExporter → bundle`. `CaptureDataEntryBase` + `defaultEntryFactory`. No `Scope` (one global Environment); breadcrumbs are a capture stream.
- **Stores**: `createMemoryCaptureStore` (in-memory); `createFileCaptureStore(adapter, opts)` with per-launch GENERATIONS (`<gen13>__<part12>__<type>`, fresh launch cleans other generations). Both are bounded by TWO axes (drop-oldest whole CLOSED parts, design A1): the time window (`maxRecordingTimeMs`) AND an optional `maxDataSizeBytes` byte cap (slice #34) enforced on `add` via a running UTF-8 byte total (the open current part is never evicted — a single oversized part is a documented soft over-shoot). Byte measure = `@bugsee/util` `utf8ByteLength` (pure, allocation-free); the memory store counts the serialized string, the file store the encoded on-disk line.
- **PartManager + tick**: 1-second parts with rotation + out-of-window cleanup driven by the client's `Scheduler` (`setInterval`-based, unref'd by default).
- **Coordinators**: `CaptureCoordinator` (init-once via `CaptureProviderInit { operations, captureAggregator }`, start-with-options, gated by `controllingOption`), `DetectionCoordinator` (start-with-onReport, same gate).
- **Trigger + Upload pipelines**: `createTriggerPipeline` (serialized assemble, `maxQueueDepth`), `createUploadPipeline` (session→issue→signed PUT, retry/backoff, 403→renew, bounded inFlight). `BugseeApi` + `BundleUploader` over an injected `HttpTransport` (transport logic is core, the primitive is platform).
- **Durable bundle queue** (`createDurableUploadPipeline`, slice #33): persists each bundle (length-prefixed `[4B LE hdr len][request+fileName JSON][zip body]` via `serializeBundle`) BEFORE upload, removes only on confirmed delivery (resolves AFTER removal so the crash flush awaits cleanup), `recover()` re-uploads leftovers and purges corrupt frames. `BundleStore` adapter seam.
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

**`@bugsee/node`**:
- `buildNodeEnvironment(input, probe)` — §8.6 envelope via injectable `SystemProbe`. Applies `optionsToWire` to `sdk.options` (dots → colons; server treats dots as nested-document paths).
- `createUncaughtExceptionProvider` / `createUnhandledRejectionProvider` — process-event detection, V8 stack parsed + scrubbed.
- `createNodeHttpInterceptor` — wraps `node:http(s)` `request` + `get` (mechanism `'http'`), captures axios/got/node-fetch that bypass global fetch. **Transparent error handling**: re-raises the original error when it is the sole `'error'` listener so an otherwise-uncaught request error still crashes the app.
- `createNodeSystemMetricsSampler` — process memory (rss/heapTotal/heapUsed/external/**arrayBuffers**), **system memory (`ram_system_total`/`ram_system_free` — Android parity)**, CPU user/system per-sample deltas + **normalized `cpu_usage_process` %** (over wall-time/cores), event-loop lag **mean/max/p99** + **utilization** (perf_hooks `monitorEventLoopDelay` + `eventLoopUtilization`). All readers injectable.
- `createNodeSystemEventsSource` — process lifecycle (`process_started` on activate, `process_exiting`, **`process_before_exit`** clean-drain, `process_warning`, and **`process_signal`** for SIGTERM/SIGINT). Signal capture is PASSIVE: it emits the event, and only when the SDK is the sole handler does it remove itself and **re-raise** (`process.kill`) to restore Node's default termination — so it never hangs a process or hijacks an app's own signal handler.
- **`launch(appToken, options)`** — the composition root: builds the transport (internal-tagged), api/uploader/upload pipeline, durable wrapper (when `dataDir`/`bundleStore` present), env builder, store (in-memory / file-backed), resolves the friendly options once via `NODE_OPTION_DEFINITIONS`, registers gated capture providers (console→log; network umbrella with `node:http` folded in; system traces/events) + detection providers, calls `client.launch()`, runs durable `recover()` on start, installs the uncaughtException → `flush(timeout)` → `proc.exit(1)` policy (opt-out `exitOnUncaught`, default `shutdownTimeoutMs: 3000`), and augments `client.stop()` to remove its process listener. Returns the started `BugseeClient`.

### Browser platform (Milestone 3 — COMPLETE, on `master`)
**`@bugsee/browser-utils`** (runtime primitives, shared by browser/web-worker/service-worker):
- `fetchTransport` / `createFetchTransport(fetchImpl?)` — `HttpTransport` over `fetch` (AbortController timeout, string/Uint8Array body, lowercased response headers, non-2xx resolves). Drops the node gzip/Accept-Encoding logic (the browser owns content negotiation).
- `createIdbBlobStore(opts)` — a minimal async key→bytes `AsyncBlobStore` over IndexedDB (memoized open, injectable `IDBFactory`); `createIdbKeyedStore(opts)` — an `AsyncKeyedStore` with prefix range reads/deletes (`put`/`readPrefix`/`deletePrefix`), the substrate for the chunk backend.
- `createPersistentBundleStore(blob, onError?)` — the SYNC core `BundleStore` over async IDB via an in-memory mirror + async write-through + `whenReady` hydrate-on-open (a `touched` set so a live put/remove during hydration wins).
- `createIdbChunkBackend(keyed, {generation, cleanOtherGenerations?, onError?})` + `createIdbChunkCaptureStore(keyed, opts)` — the durable IndexedDB `CaptureStore`, **durable-as-captured** (replaces the removed B5b `createPersistentCaptureStore` in-memory mirror): each captured entry is written through as `d/<gen13>/<chunk12>/<seq12>` and each chunk's metadata as `m/<gen13>/<chunk12>` (the same chunk-group model as the node file store, over async keyed records). Writes are sync-issue / async-complete on a single in-order queue (loss window ≤1 entry); `snapshot()` pins frozen parts (eviction defers the delete until `release()`) and reads each part's data range bounded by the snapshot-time count; `listParts`/`listGenerations` read durable meta (the recovery index). See the capture-storage note below.

**`@bugsee/browser`**:
- `buildBrowserEnvironment(input, probe)` — §8.6 envelope (`platform.type: 'web'`) via injectable `BrowserProbe` (navigator/screen/Intl; raw UA as `platform.version` — backend parses; deviceMemory/hardwareConcurrency optional). `optionsToWire` on `sdk.options`.
- `createWindowErrorProvider` / `createUnhandledRejectionProvider` — window `error` → crash / `unhandledrejection` → error; `parseStack` dispatches V8 (`at fn (loc)`) vs SpiderMonkey/JSC (`fn@loc`) dialects (core's `parseLocation` reused).
- `createBrowserSystemTracesSampler` (traces: `browser_memory_*` + `connection` + `orientation` + `battery`/`charging`, each degrading where its API is absent) + `createBrowserSystemEventsSource` (events: `process_started`, `pagehide`→`process_exiting`, `visibilitychange`→`process_foreground`/`process_background`, `online`/`offline`, `orientationchange`→`orientation_changed`). See the capture-completeness milestone in §7.
- `createBrowserInputSource` (input: capture-phase/passive DOM listeners → `events.user` via the runtime-agnostic `createUserEventsProvider`) — click/keydown/change/submit/focusin with a PII-safe `describeTarget` (tag/id/class/type/text/selector, masking password + `[data-bugsee-hidden]`); typed text never captured (AltGr/emoji/IME-robust); throw-isolated. See the capture-completeness milestone in §7.
- `createDomSnapshot` / `createViewtreeSnapshotSource` (view hierarchy: an at-report DOM-tree snapshot → `viewtree`, via the core `reportSnapshots` pull-seam) — reuses `describeTarget` per node + rounded `getBoundingClientRect`; masked subtrees collapse to `{tag, masked, rect}`; bounded (maxNodes/maxDepth) + per-node throw-isolated. Gated by `captureViewHierarchy`. See §7.
- **`launch(appToken, options)`** — the browser composition root (fetch/DOM analog of node's): fetch transport (internal-tagged), api/uploader/upload pipeline, browser env, in-memory store (or IndexedDB-backed when `persist:true`), gated capture providers (console→log; network umbrella, NO `node:http`; system traces; system events; user-interaction input) + detection providers, `client.launch()`. **No `process.exit` path** (the browser flushes via the pipeline/`pagehide`; `stop()` only clears the carrier). `persist:true` builds an IndexedDB durable bundle queue (crash recovery across reload — `recover()` deferred to the store's `whenReady`) + the durable IndexedDB chunk capture store (`createIdbChunkCaptureStore` in its own `bugsee-capture` db). `maxDataSize` defaults to 10 MB. Returns the started `BugseeClient`.

### Integration shims — `@bugsee/integration-shims` (tier-3 leaf, slice #13)
No-op stand-ins for DOM-only integrations on DOM-less runtimes (design §372). `createNoopCaptureProvider`/`createNoopInterceptor` (extend `CaptureProviderBase`/`InterceptorBase`) + named shims `createViewHierarchyProviderShim`/`createBreadcrumbsProviderShim`/`createXhrInterceptorShim`. Each is a structurally-valid provider/interceptor that captures nothing and warns ONCE (`logger.warnOnce`, keyed `shim:<name>`, message `<name> is a no-op on <runtime>; ignored`) on ACTIVATION (provider start / interceptor activate) — construction is side-effect-free. Logger (`Pick<Logger,'warnOnce'>`) + runtime label are injected by the platform (runtime-agnostic). **`replay` is intentionally NOT a shim** (design §372: option-driven, ignored-with-warn at option resolution). Per-platform named re-exports land with the platform packages.

### Scaffold only (1-file stubs, no impl yet)
`bun`, `deno`, `electron`, `webworker`, `performance`, `replay`, `replay-canvas`, `bugsee` (umbrella), `cloudflare`, `vercel-edge`, and every framework adapter (`react`, `vue`, `svelte`, `sveltekit`, `solid`, `angular`, `nextjs`, `nuxt`, `remix`, `astro`, `express`, `fastify`, `hono`, `elysia`, `nestjs`, `vite-plugin`, `webpack-plugin`).

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
| Capture sources | `console`, `fetch`, `xhr`, `ws`, `sse`, `webtransport` (self-skip if absent) | `node:http` added via `installNetworkCapture({ additionalSources })` | DOM-specific sources |
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

Pre-commit: run `pnpm lint && pnpm typecheck && pnpm check:cycles && pnpm test` (no automated git hook installed).

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
  Node 20.12+), so `pnpm test` needs Node ≥ 20; test SDK *code* on Node 18 via `tsx`, not vitest. A CI
  Node-version matrix is still TODO (the `@bugsee/instrumentation-tests` harness already spawns
  node/bun/deno — pointing it at pinned versions would make the bun/deno floors *tested*).

---

## 6. Conventions (binding)

- **Git remote is Gerrit**, not GitHub: `origin = ssh://krassx@code.bugsee.com:29418/javascript`. Current convention: **push DIRECT to `refs/heads/master`** (`git push origin HEAD:refs/heads/master`), skipping the Gerrit `refs/for/master` review queue. Do NOT use `gh`. The Gerrit commit-msg hook prints non-blocking warnings on subject > 50 / lines > 72 chars.
- **Commit trailer**: every commit ends with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
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
| ~~#34~~ | ~~`maxDataSize` byte bound on the capture store~~ | **DONE (2026-05-30, on `master`).** Byte cap on both capture stores (drop-oldest closed parts, soft-bounded on the open part); friendly `maxDataSize` (MB, Node default 50) → canonical `com.bugsee.option.config.data-size` → wired in Node `launch` for memory + file paths. `@bugsee/util` `utf8ByteLength` added. Test-first, mutator-looped (incl. multi-part single-add eviction + no-drift + clear-reset), multi-agent reviewed to convergence. Node now builds the in-memory store itself (parity with the file path), so `createClient` is untouched. Browser/edge 10 MB default lands with `@bugsee/browser`. |
| ~~#47~~ | ~~Interceptor carrier (global singleton)~~ | **DONE (2026-05-30, on `master`).** `@bugsee/core` `carrier.ts` (`getCarrier` + `getOrCreateInterceptor`) at `globalThis.__BUGSEE__[BUGSEE_SDK_VERSION]`; `installNetworkCapture` (5 net leaves) + Node `launch` (console + node-http) route interceptor creation through it via an injectable `carrier` seam → one instance / one patch per process, module-dup safe. Test-first, mutator-looped, multi-agent reviewed to convergence. Two LOW forward notes: the `'0.0.0'` version literal is duplicated in carrier.ts/launch.ts (different axes — carrier key vs UA default — unify when the real version is wired); carrier keys are string literals (tested to match each interceptor's `.name`). |
| ~~#13~~ | ~~Integration-shims~~ | **DONE (2026-05-30, on `master`).** `@bugsee/integration-shims` implemented: `createNoop{CaptureProvider,Interceptor}` + named `viewHierarchy`/`breadcrumbs`/`xhr` shims; warn-once on activation, side-effect-free construction, injected logger/runtime seam. `replay` excluded per design §372 (option-driven, not a constructed integration). Test-first, mutator-looped, two-agent reviewed clean. **All immediate-hardening items (#34/#47/#13) are now complete — next milestone is `@bugsee/browser`.** |

### Network body capture (F) — **COMPLETE** (policy + every transport's request & response bodies)
| # | Slice | Notes |
| --- | --- | --- |
| **F.1** | **Body sanitization + size/Content-Type gating + options** | **DONE (2026-05-30, on `master`).** The runtime-agnostic POLICY layer (Android `applyBodyFilters`/`NetworkDataSanitizer` parity). `@bugsee/protocol`: `sanitizeBody(body, contentType, opts?)` — JSON media types (`application/json`, `text/json`, any RFC 6839 `+json` suffix; `;`-params stripped, trimmed) get recursive key-denylist redaction (re-serialized), everything else the shape pass; never throws (invalid JSON degrades to the shape pass). `gateNetworkBody(event, {maxBytes, captureWithoutType})` — non-mutating; drops a body (→ `body:null` + `no_body_reason`) on missing/blank Content-Type (`no_content_type`, unless `captureWithoutType`) or over-size in UTF-8 bytes (`size_too_large`); preserves a producer-set reason / absent body. `contentTypeOf(headers)` (case-insensitive) exported. New options `CaptureNetworkBodies` + `CaptureNetworkBodyWithoutType` (+ existing `CaptureNetworkBodySizeLimit`/`CaptureNetworkDefaultSanitizer`). `@bugsee/core`: 3 COMMON friendly defs — `captureNetworkBodies`=true, `maxNetworkBodySize`=20480→`…body-size-limit`, `captureNetworkBodyWithoutType`=false. `@bugsee/capture` `network-provider`: per-event order is **gate (always) → user filter XOR default sanitizer**; the master toggle strips the body (no reason); the default sanitizer now also `sanitizeBody`s `custom.body`. Test-first, mutator-looped (incl. size boundary `>`, UTF-8 vs char count, case-insensitive CT, `+json`/`text/json`/`json5`, parse-failure degrade, gate-runs-when-sanitizer-off), 100% protocol coverage / capture gate met; multi-agent reviewed to convergence (2 rounds — round 1 broadened JSON detection to `+json`/`text/json` and added the sanitizer-off-gate + null-body tests). Residual (documented/intentional): non-standard JSON-ish types (`json5`, `text/x-json`, `application/csp-report`) get the shape pass only — shaped secrets still scrubbed, only a plaintext value behind a sensitive *key name* survives. |
| **F.2a** | **fetch REQUEST body** | **DONE (2026-05-30, on `master`).** `fetch-interceptor` populates `custom.body` on the `before` event for sync-readable request bodies: a string (verbatim) or `URLSearchParams` (`String(body)`); other `init.body` types (FormData/Blob/ArrayBuffer/typed array/ReadableStream) and a body carried on a `Request` passed as `input` → `no_body_reason:'cant_read_data'`; explicit null / no body → neither key. Reads are side-effect-free (never consumes/replaces the body the underlying fetch sends). When the caller set no Content-Type, the fetch-spec **implied** CT is synthesized into the captured request headers (string → `text/plain;charset=UTF-8`, URLSearchParams → `application/x-www-form-urlencoded;charset=UTF-8`) so the F.1 gate keeps the body instead of dropping it `no_content_type`; a caller-set CT is never overwritten. Self-isolated (X-Bugsee-Internal) requests skip before any body read. The interceptor emits RAW; the provider (F.1) gates/sanitizes. Test-first, mutator-looped, capture gate met; multi-agent reviewed to convergence (2 rounds + a confirming pass — round 1 added Request-as-input detection + implied-CT synthesis + key-omission/exclusivity tests; round 2 closed the `requestInputHasBody` conjunct + empty-string-body mutants). |
| **F.2b** | **fetch RESPONSE body** | **DONE (2026-05-30, on `master`).** Bounded-read clone capture honoring the user's **"don't alter app behavior"** principle ([[interceptors-must-not-alter-app-behavior]]). On success the interceptor clones the response (the ORIGINAL is returned untouched — preserves `url`/`redirected`/identity), then OFF the event loop bounded-reads the clone via `getReader()` up to `maxBodyBytes`, `cancel()`s the reader, and delivers the body as a later **`override:true`** amendment event (same id; carries the response headers so F.1's CT dispatch works). The immediate metadata `complete` is never delayed; the app's `await fetch()` is never blocked. Drops: Content-Length fast-skip (known over-cap → `size_too_large`, zero read), over-cap mid-read → cancel + `size_too_large`, read error / non-stream / no `TextDecoder` → `cant_read_data`, no body (204) → no amendment, clone()-throws/absent → no amendment. Gated by `captureBodies` (off → no clone/read at all). `captureBodies`/`maxBodyBytes` threaded `launch` → `installNetworkCapture` → fetch leaf from `CaptureNetworkBodies`/`CaptureNetworkBodySizeLimit`; `BugseeLaunchOptions` gained `captureNetworkBodies`/`maxNetworkBodySize`/`captureNetworkBodyWithoutType`. `readBoundedBody` NEVER throws (so the `void …then()` can't reject); the core emitter isolates listener throws. Test-first, mutator-looped (boundary `>`, cancel-on-over-cap, CL fast-skip no-read, all `cant_read_data` sources, override flag, 204, reads-only-the-clone, byte-cap threading at install+launch via pull-count), capture+node gates met; multi-agent reviewed to convergence (behavior + test-strength rounds + a confirming pass). |
| **F.3** | **xhr request + response body** | **DONE (2026-05-31, on `master`).** Extracted a shared **`network-body.ts`** (`readSyncRequestBody` — string/URLSearchParams + implied Content-Type, else `cant_read_data`; `boundedText` — already-buffered body capped by UTF-8 bytes with a `length` fast-path; `hasContentType`/`headerValueCI`; `decodeUtf8`) and **DRY-refactored `fetch-interceptor`** onto it (behavior-preserving). `xhr-interceptor`: request body in `#wrapSend` (readSyncRequestBody + implied-CT synthesis when the caller set none, raw on the `before` event); response body in `#complete` via `#readResponseBody` — `responseType` `''`/`'text'` → `responseText`, `'json'` → `JSON.stringify(response)` (circular/undefined → `cant_read_data`), binary/document → `cant_read_data`; bounded by `maxBodyBytes` (over-cap → `size_too_large`). **No app-behavior concern** for XHR responses: `responseText` is already buffered at `load` (sync read, no stream to disturb, no clone/tee), so it attaches directly to `complete` (no override amendment) — and `responseText` is only touched for text responseTypes (avoids the real-XHR InvalidStateError throw). New `captureBodies`/`maxBodyBytes` options + an `xhrTarget` seam on `installNetworkCapture` (parity with `fetchTarget`); body opts threaded to BOTH fetch+xhr leaves. Test-first, mutator-looped, capture gate met; multi-agent reviewed to convergence (correctness clean; test-strength round closed the xhr `maxBodyBytes` install-threading + a genuine multibyte-split decode test; `boundedText` length fast-path is a documented equivalent mutant). |
| **F.4a** | **node:http REQUEST body** | **DONE (2026-05-31, on `master`).** `http-interceptor` `#captureRequestBody` wraps the ClientRequest's OWN `write`/`end` (per-instance, not the prototype): observe each chunk (Buffer / ArrayBufferView raw bytes / string-with-declared-encoding), then call the ORIGINAL with the same args and return its value — the body the app sends is never altered (a real-`node:http` integration test asserts the loopback server received the unaltered body). The body is known only at `end()`, so it is delivered as an **`override:true`** amendment to the `before` event (same id, carrying the request headers; node:http implies no Content-Type so none is synthesized — a body without a caller CT is gated out downstream). Bounded by `maxBodyBytes` (over-cap → `size_too_large`); `end(cb)` is body-less; re-entrant `end()` is guarded; a body-less request emits no amendment. New `captureBodies`/`maxBodyBytes` options threaded from `launch` (shared with the fetch/xhr leaves). Test-first (unit + real-node:http integration + launch end-to-end), mutator-looped, node gate met; multi-agent reviewed to convergence (fixed a Uint8Array-chunk capture bug + added a positive launch test). Two documented equivalent mutants: the over-cap `chunks.length=0` clear (finalize never reads chunks when over-cap) and the launch `maxBodyBytes`→node:http hand-off (the provider re-gates at the same cap, masking the stored outcome). |
| **F.4b** | **node:http RESPONSE body** | **DONE (2026-05-31, on `master`).** `#captureResponseBody` PASSIVELY wraps the `IncomingMessage`'s own `push` (the producer hook the HTTP parser feeds body chunks into) — observe each chunk, then call through. This adds NO consumer and never forces flowing mode, so the app reads the stream exactly as uninstrumented (a real-`node:http` integration test consumes a 100 KB body via **`for await`** after a delay and asserts the app received ALL of it — a naive `res.on('data')` observer would have stolen it). `push(null)` = EOF → the body is delivered as a `complete` override amendment (carrying the response headers). A Content-Encoding-compressed body (gzip/br/…, case-insensitive, `identity`/absent = readable) is still-encoded on the wire and can't be read as text via push → `cant_read_data` (fetch captures decoded bodies via undici; node:http does not). Bounded by `maxBodyBytes`; re-entrant `push(null)` guarded; a body-less response emits no amendment. Refactored the request + response observers onto shared `chunkToBuffer` / `createBodyAccumulator` / `#emitBodyAmendment` (DRY). Test-first (unit + real-node:http integration incl. async-iteration non-disturbance), mutator-looped, node gate met; multi-agent reviewed to convergence (impl validated correct + flow-mode-safe; the test-strength round strengthened the async-iter guard to a large delayed body and closed empty-encoding / correlation-field / null-guard / subview gaps). **F is complete: the policy layer (F.1) + request & response bodies on fetch (F.2), xhr (F.3), and node:http (F.4), all honoring the don't-alter-app-behavior principle.** |

### DI Phase 3 / token migration — **COMPLETE** (all platform seams are typed-token container services)
- **Increment 1** (HTTP `transport`). **Increment 2 (2026-05-31):** `captureStore` (`core/contracts.ts`) + `systemProbe` (`node/environment.ts` — Node-local). **Final increment (2026-06-01, on `master`):** the LAST seams — `clock` (`clock.ts`), `scheduler` (`client.ts`), `uploadPipeline` (`transport.ts`), `bundleStore` (`durable-upload-pipeline.ts`), `fileStorageAdapter` (`contracts.ts`). `createClient` registers `clock`/`scheduler`/`captureStore`/`filters` always and `uploadPipeline` when provided; `launch` registers `transport`/`systemProbe` always and `bundleStore`/`fileStorageAdapter` only in file-backed mode (a dataDir/explicit store; `getService` throws for them in in-memory mode — the intended optional-service semantic). All lazy + side-effect-free factories returning the SAME instance used internally (behavior-preserving). The one non-trivial change: `fileStorageAdapter` extracted to a named const in `launch` (guarded `captureStore === undefined && dataDir !== undefined` to preserve the prior `??`-short-circuit — so `createNodeFileStorageAdapter`'s `ensureDir` side-effect still does NOT run when a captureStore override is given). **9 services**, collision-free: transport/uploadPipeline/filters/captureStore/fileStorageAdapter/clock/scheduler/bundleStore (core) + systemProbe (node). Mutator-verified; reviewed clean. **Interceptors stay on the process Carrier** (`getOrCreateInterceptor`), NOT the per-client container — by design: they need cross-module-copy dedup + patch-once + refcount keyed on a process-global, which the per-launch container can't provide; the carrier HOSTS the internal object, so interceptors are still "incorporated." **The container is now the complete internal object (the "BugseeInternal") — every platform component resolvable via `getService`.**
- **Token migration + service-manifest registry (2026-06-01, on `master`, commit `437f14e`).** Replaced the raw-string / `NameServiceMapping` declaration-merge keying with typed **`ServiceToken<T>`** handles (`@bugsee/service`: `ServiceToken<T>`, `serviceToken(name)`, `defineService(token,…)`, `ServiceContainer.getProvider(token)`). A token pairs a stable `name` with a branded phantom `__type` that discriminates `ServiceToken<A>` from `ServiceToken<B>` (a wrong-token use is a compile error); the container keeps its `Map<string,Provider>` internals keyed via `token.name`, so only the typed API boundary changed. Each contract exports its token beside it (`TransportToken`/`UploadPipelineToken` in `transport.ts`, `FiltersToken` in `filters.ts`, `CaptureStoreToken`/`FileStorageAdapterToken` in `contracts.ts`, `ClockToken` in `clock.ts`, `SchedulerToken` in `client.ts`, `BundleStoreToken` in `durable-upload-pipeline.ts`, `SystemProbeToken` in `node/environment.ts`); every `declare module '@bugsee/types'` service block is gone and `NameServiceMapping` is removed from `@bugsee/types` (`NameExtension`/`Hook`/`Hub` mappings stay). The now-orphaned `@bugsee/types` dep was dropped from `@bugsee/node`. **Carrier-hosted service-manifest registry:** `contributeServiceManifest(manifest, carrier?)` / `getServiceManifests(carrier?)` on the carrier; a manifest is `(internal: ServiceRegistrar & ServiceResolver) => void`, and `launch()` runs every contributed manifest against the internal container (`launch.ts`) — so an extension/adapter's services auto-register WITHOUT `launch`/`createClient` ever naming them (auto-registration via an explicit manifest, not import side-effects). Test-first + mutator loop (token plumbing + facade + new same-name-resolution and phantom-discrimination tests, all mutation-verified) and a `tsc`-level type test pinning token branding; multi-agent reviewed to convergence (round 1 → 5 findings fixed → round 2 clean). _Open follow-up:_ the manifest registry's final shape (ship-as-is vs. a per-platform manifest module vs. a fuller declarative config-DI) is still an open design question — landed as-is. _Doc note:_ `docs/design/sdk-design.md` §5.2/§7.4 still describe the original `NameServiceMapping` design; this token migration is the as-built delta recorded here.

### Milestone 3 — `@bugsee/browser` — **COMPLETE (2026-06-03, on `master`)**
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

### Capture-storage redesign — durable-as-captured chunk store — **COMPLETE (2026-06-04, on `master`)**
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

### Capture recovery (detected-incidents-only, Node) — **COMPLETE (2026-06-05, on `master`)**
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

### Multi-instance on-disk coexistence + recovery — COMPLETE (2026-06-17, on `master`)
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

### Browser capture-completeness — IN PROGRESS (started 2026-06-05)
The crash/network/storage/recovery pipeline is done, but the browser auto-capture SURFACE was thin vs
the Android/iOS SDKs + competitors (Sentry/Firebase/BugSnag/Datadog) — gap analysis: see
[[capture-completeness-vs-parity]] in memory. Closing it, browser-first (Node's traces are already
solid), in slices:
- **CE1 — system EVENTS breadth (DONE, `master`):** `createBrowserSystemEventsSource` now maps
  visibilitychange→`process_foreground`/`process_background`, online/offline, orientationchange→
  `orientation_changed`, alongside `process_started`/`pagehide`. Injected env (window/document/screen),
  graceful degradation.
- **CE2 — system TRACES breadth (DONE, `master`):** `createBrowserSystemTracesSampler` adds `connection`
  (navigator.connection), `orientation` (screen.orientation), `battery`/`charging` (cached BatteryManager)
  to the existing `browser_memory_*`. Android trace-name parity; degrades per-API.
- **CE3 — input capture (DONE, `master`):** `createBrowserInputSource` (browser) — capture-phase,
  passive, observe-only DOM listeners for click/keydown/change/submit/focusin → `events.user`, via the
  runtime-agnostic `createUserEventsProvider` (capture, mirrors system-events-provider) gated by the new
  `captureInteractions` option (protocol). `describeTarget` produces a PII-safe target descriptor
  (tag/id/class/type/text/selector) and **masks** password fields + `[data-bugsee-hidden]` subtrees to
  `{tag, masked}`. PII discipline (multi-agent-reviewed): typed text is NEVER captured — plain printable
  keys are dropped, and the drop is robust to AltGr (`getModifierState('AltGraph')` + the Windows
  ctrl+alt signature), supplementary-plane/emoji (`[...key]` code-point count), and IME (`isComposing`);
  input/textarea/select values and editable text are never read; handlers are throw-isolated so a bad
  selector / exotic target can never disrupt the app. Carrier-shared like `console`.
- **CE4 — view hierarchy (DONE, `master`):** an at-report DOM snapshot (the browser analog of mobile's
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

### Performance / APM extension (`@bugsee/performance`) — IN PROGRESS (started 2026-06-08)
Full extension (web-vitals + page-load detail + active APM), **on by default via the umbrella**, built
from competitor source as a design reference (Google `web-vitals`, Sentry, Firebase, Datadog) so we ship
past their known rakes — see [[performance-apm-extension-plan]] in memory for the metric catalog + the
rakes-as-tests + the packaging decision (extension, umbrella auto-registers, active span API opt-in).
- **Phase 0 — DONE (`master`):** the Android-canonical Span/Transaction model (`SpanStatus`, fluent API,
  `startChildSpan`, idempotent `finish`, `Clock`-driven timestamps + clamped `durationNanos`) +
  `serializeTransaction` → the §8.8 wire; the bounded FIFO transaction buffer; the controller
  (`startTransaction`/`getActiveSpan`, head-sampled, finish→buffer); the extension shell
  (`createPerformanceExtension` → `setup(client)`/`stop()`, launch-wired — no `addExtension` lifecycle
  yet, so `setup` takes the FULL `BugseeClient`); the `performance.*` options (decl-merged). Reviewed to
  convergence (one real fix: clamp negative `durationNanos`).
- **Phase 1 — DONE (`master`), reviewed to convergence:** the full Core Web Vitals capture
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
- **Phase 2 — DONE (`master`):** the page-load detail on the pageload transaction. P2a navigation-timing
  breakdown → `nav.<phase>_ms` attributes (dns/connect/tls/request/response + dom_interactive/
  dom_content_loaded/load; skips zero/missing/reversed phases). P2b a new `recordChildSpan` primitive
  (post-hoc explicit-time spans; recorder is now `SerializableSpan[]`) + `collectResourceTiming` →
  `resource.<initiatorType>` spans (URL query/fragment stripped + data:/blob: collapsed for cardinality/
  PII, fetch/xhr deduped, status/size attributes, capped 100). P2c `collectLongTasks` → `ui.long-task`
  spans (observed live, capped 50; the back-dating rake is structurally avoided since recordChildSpan is
  independent). All wired into `collectPageLoadVitals`.
- **Phase 3 — DONE (`master`), reviewed to convergence (3 rounds):** the active-APM delivery layer.
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
- **Phase 3.x — DONE (`master`), reviewed to convergence:** the on-by-default umbrella wiring, via the
  **`launchCore()` seam** (the user-chosen option A: explicit/typed over a callback hook or service
  discovery). `@bugsee/browser` now exports `launchCore(token, opts): { client, internals }`; `launch()`
  is `launchCore(...).client` (public surface unchanged, behaviour-preserving extract). `LaunchInternals`
  is the typed handoff — everything NOT already a DI service: `api`/`transport`/`baseUrl`/`getEnvironment`
  (to build the perf `send`), the `installNetworkCapture` umbrella (its `.interceptor` is the http-span
  source), + `appVersion`/`appBuild`/`onError`; the clock/scheduler stay services (`getService(ClockToken/
  SchedulerToken)`). `internals` is `undefined` on a repeat launch. The **`bugsee` umbrella** package
  (was a stub) now has a `launch()` that runs `launchCore`, resolves the `performance.*` options, builds
  `createPerformanceSend` over the internals, and calls `wirePerformance` — performance ON BY DEFAULT
  without `@bugsee/browser` depending on the extension (tree-shakeable). Teardown is composed **in place**
  on the client object `launchCore` registered as the process singleton (a wrapper-object approach broke
  singleton identity — caught + fixed in review). Integration-tested through the real `launchCore` with
  injected seams (network globals stubbed → the always-wired http-span subscription patches no real
  fetch/XHR). Convergent review (2 agents): correctness NO findings; only 2 LOW packaging-metadata items
  (an unused `@bugsee/node` dep + a stale description) — fixed. 100% line/branch/fn across the new code.
- **`@bugsee/performance` is COMPLETE** (P0–P3.x) and live by default in the `bugsee` umbrella.
- **P3 delivery — DONE (`master`), reviewed (3 agents → convergent):** chose option (a). A new
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
- **A — DONE (`master`), reviewed:** the mapping core — Bugsee §8.8 transactions → OTLP/HTTP-JSON
  (`to-otlp.ts`), hand-rolled, ZERO `@opentelemetry/*` deps. Spec-verified (hex ids, uint64-string ns,
  AnyValue, status/kind); derives the implicit root span id + remaps dangling child parents.
- **B — DONE (`master`), reviewed:** `createOtlpTraceExporter` — a `send`-shaped function (drop-in for
  the perf uploader) POSTing the mapped OTLP request to any collector. **Produce works end-to-end.**
- **C — DONE (`master`), reviewed:** Consume, native-transactions shape. C1 `from-otlp` (OTel span →
  §8.8, round-trip-consistent status). C2 `createTraceAssembler` (root-end + bounded eviction: emit on
  root-span-end, drop a never-rooted trace after maxAgeMs / cap at maxTraces). C3 `createBugseeSpanProcessor`
  — STRUCTURAL `ReadableSpanLike`/`SpanProcessor` (no OTel import; covers SDK 1.x `parentSpanId` + 2.x
  `parentSpanContext`/`isRemote`→local-root); `@opentelemetry/*` are OPTIONAL peers (verified not pulled
  into node_modules) + a dev-only `.test-d.ts` drift guard. **OTel spans now flow INTO Bugsee.**
- **T — DONE (`master`):** the interception-transformer seam in `@bugsee/capture`. Capture interceptors
  stay observe-only; a `RequestDecorator` (sync, truthful-capture, never on SDK-internal traffic) is the
  ONLY way piped data is altered — byte-identical when none registered. Shared `createRequestDecoratorRegistry`
  on BOTH fetch (rebuilds `init.headers`) and xhr (original `setRequestHeader` at send). The "interceptors
  must not alter app behavior" principle, refined into code.
- **D — DONE (`master`):** `createTraceparentDecorator` — the W3C propagation transformer (the seam's
  first consumer). Injects `traceparent` (`00-<traceId>-<spanId>-<flags>`) from the Bugsee active
  transaction (already W3C-shaped; NO `@opentelemetry/*` dep). **SECURITY:** same-origin propagates by
  default; cross-origin ONLY via an explicit allowlist (string/RegExp) — no trace-topology leak;
  never overrides an existing `traceparent`; fail-closed on unparseable URLs. Security mutator loop
  (same-origin inversion, default-deny removal, allowlist bypass, override, sampled-flag, format) all caught.
- **Live wiring — PROPAGATION DONE (`master`):** the network umbrella exposes `addRequestDecorator` (fans
  out to the fetch+xhr leaves); `wireOpenTelemetry` (the OTel analog of `wirePerformance`) registers the
  traceparent decorator on the network source, and the `bugsee` umbrella wires it after launch
  (`tracePropagation`/`tracePropagationAllowlist`/`tracePropagationOrigin` opts, fed perf `getActiveSpan`).
  **`launch('tok', { tracePropagation: true })` now links the frontend trace to the backend end-to-end —
  the Next.js / SSR story is LIVE** (integration-tested through the real launch driving a wrapped global
  fetch: same-origin propagates, cross-origin needs the allowlist, off by default).
- **Live wiring — PRODUCE-TEE + CONSUME DONE (`master`):** `wirePerformance` gained `recordTransaction`
  (buffer an already-finished, externally-sampled transaction into the upload pipeline). The umbrella:
  **produce-tee** — `otelExportUrl`/`otelExportHeaders`/`otelExportResource` opts make the perf `send` a
  tee of the Bugsee upload + `createOtlpTraceExporter` (allSettled; failures → onError; internal-tagged
  transport keeps the export out of capture); **consume** — `otelConsume` + `onOtelSpanProcessor` hand the
  user a wired `BugseeSpanProcessor` (onTransaction → recordTransaction) to register on THEIR
  `TracerProvider`, consumed spans riding the same upload + tee. **Two-way OpenTelemetry is COMPLETE** —
  produce (export+tee) + consume (SpanProcessor) + W3C propagation, all wired in the umbrella, each
  integration-tested through the real launch + mutation-verified.
- **Node-perf wiring — DONE (`master`):** the `bugsee` umbrella has a NODE entry (per-runtime `exports`
  conditions: browser→`index.ts`, node→`index.node.ts`) running `@bugsee/node`'s `launchCore` + the shared
  runtime-agnostic `wireUmbrella`. `wirePerformance` gained `pageload?:boolean` (Node skips the browser
  pageload/web-vitals/hidden lifecycle); Node instead records an **`app.start` startup transaction**
  (process-start → launch; `appStartTimeMs` override) so it uploads immediately. **Two-way OTel is now LIVE
  on BOTH browser and node** — consume + produce-tee automatic; http-spans + propagation attach to the
  app's per-request transaction (the span API). The umbrella compiles both entries (DOM lib + node types).
  **The whole two-way OpenTelemetry feature is complete and live on both runtimes.**

### Bun runtime (`@bugsee/bun`) — COMPLETE (2026-06-14, on `master`)
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

### Node diagnostics — CPU profiling + ANR/event-loop-hang — COMPLETE (2026-06-14, on `master`)
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

### Deno runtime (`@bugsee/deno`) — COMPLETE (2026-06-15, on `master`)
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

### Cross-runtime e2e instrumentation harness (`@bugsee/instrumentation-tests`) — COMPLETE (2026-06-15, on `master`)
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

### Framework adapters — foundation + Express/Fastify/NestJS/Hono/Elysia/Hapi/Koa COMPLETE (2026-06-15, on `master`)
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
  **COMPLETE (2026-06-16, on `master`)**, design `docs/design/incoming-server-instrumentation.md` (the
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

### Dual-module (ESM + CJS) packaging — COMPLETE (2026-06-15, on `master`)
Every implemented package now publishes **both** ESM and CJS, per `docs/design/packaging-dual-module.md`
(D1 all-dual + externalize, D2 tsup, D3 publishConfig swap, D4 dual `.d.ts`/`.d.cts`, D5 umbrella
conditions). Shape:
- A shared `tsup.config.base.ts` preset (`entry: src/index.ts`, `format: ['esm','cjs']`, `dts`, externalize
  `@bugsee/*` + declared deps) that each package's one-line `tsup.config.ts` spreads → `dist/index.js`
  (ESM) + `dist/index.cjs` (CJS) + `dist/index.d.ts` + `dist/index.d.cts`.
- **Dev still consumes `src` directly** — the top-level `exports` are unchanged; a per-package
  `publishConfig.exports` (import→`.js`/`.d.ts`, require→`.cjs`/`.d.cts`) swaps in only at `pnpm publish`.
  No build step for in-monorepo development.
- The **`bugsee` umbrella** is special-cased: a **multi-entry** build (`src/index.ts` +
  `src/index.node.ts`, each dual) and per-runtime × per-module `exports` conditions
  (`browser|node|default` × `import|require`) routing to the matching dist artifact.
- Rolled out test-by-proof, not by unit test: P1 (`build(util)`, commit `7db1e87`) established the pipeline +
  proved it on `@bugsee/util`; P2 (commit `a696f31`) extended it to the other 17 + the umbrella. Verified
  END-TO-END by packing the full `@bugsee` dependency tree into a temp `node_modules` and confirming both
  `require('@bugsee/node')` and `import('@bugsee/node')` resolve through the built dist chain (incl. the
  external `fflate`) and `launch()` returns a working client; the umbrella resolves
  node→`index.node.{cjs,js}`, browser→`index.cjs`. Gates green (typecheck 57/57, tests 2013/2013, no cycles).
- **Stub-only packages skipped** (electron, webworker, replay\*, edge/workers, framework frontend adapters):
  they gain the identical dual config when implemented.

### After browser
- ~~`@bugsee/bun`~~, ~~`@bugsee/deno`~~ (DONE, above), `@bugsee/electron`, edge/workers (`cloudflare`, `vercel-edge`, `webworker`).
- Per-runtime `exports` conditions in `package.json` — the `bugsee` umbrella now HAS them (browser/node,
  see the dual-module milestone above); the platform packages (`@bugsee/browser`/`node`) are still
  single-entry (split when their runtimes branch). This is the *runtime* split, orthogonal to the ESM/CJS
  *module* split that already landed for every package.
- Framework adapters: **express + fastify + nestjs + hono + elysia + hapi + koa** are **DONE** (see the milestone above). (**Restify was built then dropped** — unmaintained since Jan 2024, doesn't import on Node ≥18; not a customer target.) Remaining: **backend** `nextjs`-server (DEFERRED — it straddles frontend RSC + backend + edge/middleware + the `instrumentation.ts` build hook, so it needs its own design pass) and `nestjs` microservice/GraphQL transports; **frontend** `react`/`vue`/`svelte`/`angular` (error boundaries over `@bugsee/browser`).
- Pluggable extensions: `@bugsee/performance` (APM), `@bugsee/replay`, `@bugsee/replay-canvas`.
- ~~Per-runtime smoke harness~~ (DONE — `@bugsee/instrumentation-tests`, above); mutation-testing CI (Stryker, opt-in).

---

## 8. Pointers

- **Spec** — `docs/design/sdk-design.md` (Draft v3). Read alongside §2 of THIS file for the as-built deltas.
- **Binding standards** — `docs/implementation-standards.md` (TDD §2, mutator loop §2, multi-agent review §6, coverage gates §4).
- **Tooling & commands** — `docs/dev-environment.md`.
- **Per-session distilled rules** — `CLAUDE.md`.
- **Android parity reference** — `/Users/alexeykarimov/Projects/Bugsee/android/sdk` (API + architecture target; Sentry/Firebase are *internal design references only*, never migration sources).
- **Memory (cross-session, my notes)** — `~/.claude/projects/.../memory/` (notable: `node-build-state.md`, `launch-options-scheme.md`, `core-package-complete-feat-core.md`, `capture-shared-package.md`, `git-remote-is-gerrit.md`, `core-typecheck-gotcha.md`).
