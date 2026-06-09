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
- **Remaining:** P3 active span API + fetch/xhr http spans + head sampling + the continuous
  `/v2/performance/transactions` upload; P3.x umbrella auto-register (on-by-default wiring lives there,
  NOT `@bugsee/browser`, to keep the extension tree-shakeable).
- **Delivery decision to make (P3):** the bundle assembler emits each file type as
  `JSON.stringify(entries.map(e => e.data))` (a top-level ARRAY), but §711/§8.8 want `performance.json` =
  `{transactions: [...]}` (an object), and the perf `TransactionStore` is a SEPARATE buffer not fed to
  the capture aggregator. The continuous `/v2/performance/transactions` POST body is controlled directly
  (`{transactions: store.drain()}`); the bundle `performance.json` needs either (a) push finished
  transactions to the aggregator as `performance`-typed entries + a `type==='performance'` wrapping
  branch / per-type serializer on the assembler, or (b) a separate store-drain bundle hook.

### After browser
- `@bugsee/bun`, `@bugsee/deno`, `@bugsee/electron`, edge/workers (`cloudflare`, `vercel-edge`, `webworker`).
- Per-runtime `exports` conditions in `package.json` (currently single entry).
- Framework adapters (`react`/`vue`/`svelte`/`angular`/`express`/`fastify`/`nextjs`/etc.) — thin pass-throughs that wrap `@bugsee/<runtime>`.
- Pluggable extensions: `@bugsee/performance` (APM), `@bugsee/replay`, `@bugsee/replay-canvas`.
- Per-runtime smoke harness; mutation-testing CI (Stryker, opt-in).

---

## 8. Pointers

- **Spec** — `docs/design/sdk-design.md` (Draft v3). Read alongside §2 of THIS file for the as-built deltas.
- **Binding standards** — `docs/implementation-standards.md` (TDD §2, mutator loop §2, multi-agent review §6, coverage gates §4).
- **Tooling & commands** — `docs/dev-environment.md`.
- **Per-session distilled rules** — `CLAUDE.md`.
- **Android parity reference** — `/Users/alexeykarimov/Projects/Bugsee/android/sdk` (API + architecture target; Sentry/Firebase are *internal design references only*, never migration sources).
- **Memory (cross-session, my notes)** — `~/.claude/projects/.../memory/` (notable: `node-build-state.md`, `launch-options-scheme.md`, `core-package-complete-feat-core.md`, `capture-shared-package.md`, `git-remote-is-gerrit.md`, `core-typecheck-gotcha.md`).
