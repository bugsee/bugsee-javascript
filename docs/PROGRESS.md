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
- **`Client`** (`createClient`) — composition root: identity/attributes via the single global `Environment`, manual capture (`addBreadcrumb`/`log`/`event`/`trace`/`logException`), provider/extension registration, lifecycle (`launch`/`isLaunched`/`stop`/`flush`). `flush()`/`stop()` await both `uploadPipeline.flush` AND in-flight **report promises** (the path that lets crash flush-then-exit deliver), bounded by an unref'd deadline. **Identity reaches the wire (audit fix A):** `setUserIdentifier` → `request.json.email` at assemble time (Android maps the user identifier to the `email` field — "email from global scope"; no separate `user` field, no `setEmail`). **Internal object / DI (Phase 1, `docs/design/internal-object-di.md`):** the Client now owns a per-process `ServiceContainer` (the "BugseeInternal" — the internal aggregated object); `addService`/`getService`/`getServiceProvider` (NameServiceMapping-typed facade over the generic `@bugsee/service` container) + `getInternal(carrier)` reach it process-wide via the singleton client. Zero migration yet — Phase 2 makes redaction filters (E) the first real service; Phase 3 migrates the platform seams (transport/storage/...). **Lifecycle (audit fix B):** `logException` after `stop()` is a silent no-op (§1501) until re-launch (a `stopped` flag distinct from `!launched`, so pre-launch capture is unaffected). **Kill-state (audit fix D, §1435/§1504):** a fatal auth failure (401/403 on **session create** = invalid app token; `BugseeError.fatal`) — detected in the upload pipeline (distinct from a recoverable stale-session 401 on issue-create) and observed via `track()` on any report result — flips the client PERMANENTLY dead: one-time `onError`, capture+detection halt, all capture/`logException` no-op, and `launch()` won't re-arm a killed client.
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

### Integration shims — `@bugsee/integration-shims` (tier-3 leaf, slice #13)
No-op stand-ins for DOM-only integrations on DOM-less runtimes (design §372). `createNoopCaptureProvider`/`createNoopInterceptor` (extend `CaptureProviderBase`/`InterceptorBase`) + named shims `createViewHierarchyProviderShim`/`createBreadcrumbsProviderShim`/`createXhrInterceptorShim`. Each is a structurally-valid provider/interceptor that captures nothing and warns ONCE (`logger.warnOnce`, keyed `shim:<name>`, message `<name> is a no-op on <runtime>; ignored`) on ACTIVATION (provider start / interceptor activate) — construction is side-effect-free. Logger (`Pick<Logger,'warnOnce'>`) + runtime label are injected by the platform (runtime-agnostic). **`replay` is intentionally NOT a shim** (design §372: option-driven, ignored-with-warn at option resolution). Per-platform named re-exports land with the platform packages.

### Scaffold only (1-file stubs, no impl yet)
`browser`, `browser-utils`, `bun`, `deno`, `electron`, `webworker`, `performance`, `replay`, `replay-canvas`, `bugsee` (umbrella), `cloudflare`, `vercel-edge`, and every framework adapter (`react`, `vue`, `svelte`, `sveltekit`, `solid`, `angular`, `nextjs`, `nuxt`, `remix`, `astro`, `express`, `fastify`, `hono`, `elysia`, `nestjs`, `vite-plugin`, `webpack-plugin`).

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

### Next milestone — `@bugsee/browser` (Milestone 3)
- DOM/fetch transport (the browser's `HttpTransport`).
- `IndexedDB` capture store (`@bugsee/browser-utils`, reused by `webworker` + `service-worker`).
- Window error / `unhandledrejection` detection.
- Browser env builder (User-Agent / Window features) → wire-form `sdk.options`.
- Compose the shared `@bugsee/capture` layer; add browser-specific sources (e.g. DOM mutations later for replay).

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
