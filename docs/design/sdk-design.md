# Bugsee JavaScript SDK — Architecture & Design Doc

**Status:** Draft v3 (2026-05-25)
**Audience:** Bugsee engineering + backend team (open questions in §18 are blockers).
**Prior versions:** v1 (2026-05-11), v2 (2026-05-11) — see §20 (v1→v2) and §21 (v2→v3) changelogs.
**Reviewers (v1 → v2):** six parallel specialist reviews — architecture, modularity/tree-shaking, multi-runtime, wire-protocol, DX/public API, security/privacy. Review reports at `/tmp/sdk-research/review-{architecture,modularity,multi-runtime,wire-protocol,dx-api,security}.md`.
**Research baselines:** Sentry JS SDK v10.52 (`/tmp/sdk-research/sentry-report.md`), Firebase JS SDK current `main` (`/tmp/sdk-research/firebase-report.md`), Bugsee Android + iOS SDKs (`/tmp/sdk-research/bugsee-mobile-report.md`).
**Working repo:** `/Users/alexeykarimov/Projects/Bugsee/javascript` (empty at start; this doc is the first artifact).

Citation shorthand: **[S]** Sentry research report, **[F]** Firebase research report, **[M]** Bugsee mobile research report. **[R:X]** = review report X (e.g. **[R:wire]**, **[R:sec]**).

---

## 0. Decisions baked into v2 (vs. v1)

These are the structural decisions changed by v2; everything else inherits from v1. Each is justified in the corresponding section.

1. **`Component` → `Service`** (resolves React name collision per **[R:arch §Naming]**). `ComponentContainer` → `ServiceContainer`. `NameServiceMapping` keeps its name (already correct).
2. **`Transport` is split** into `BugseeApi` (control plane: sessions, issue-create, renew) + `BundleUploader` (data plane: PUT signed URLs) + `UploadPipeline` (orchestrator with buffer, retry, outcomes). Resolves **[R:arch C1]**.
3. **Late service registration is supported** via `client.addService(s)` with pending-Deferred semantics (Firebase pattern, per-Client not global). Resolves **[R:arch C3]**.
4. **Two capture modes**: `bundle` (default, mobile-style; trigger-driven) and `streaming` (send-on-capture, mandatory on edge runtimes). Resolves **[R:multi C1]**.
5. **`launch()` is synchronous**, returns `Client`. `client.ready: Promise<void>` for users who need the post-init signal. Resolves **[R:dx C1]**.
6. **No universal multi-runtime exports matrix.** Each platform package is single-platform; only the umbrella uses `node`/`browser`/`workerd`/`edge-light`/etc. conditions. Resolves **[R:mod C1]**.
7. **No import-time service registration.** Platform packages MUST register imperatively from `launch()`. Resolves **[R:mod C2]**.
8. **Wire-protocol corrections** (resolves **[R:wire C1–C3]** + MAJORs): network `type` (stage) values from Android (`before`/`complete`/`redirect`/`error`/`abort`/`timing`/`websocket`), WebSocket `event` adds `create`, PUT mirrors iOS (`x-amz-checksum-sha256` + `fileName`), `uploadDataRenew` body = full original `request.json` + overlay, `attrs` lives in `manifest.json` not `request.json`, `breadcrumbs` file has no `.json` extension.
9. **Public log level + severity are string-typed** at the API surface (`'error'|'warning'|'info'|'debug'|'verbose'`); `@bugsee/protocol` maps to wire numerics. Avoids the `1=error` inversion trap **[R:wire M5]**.
10. **Replay defaults fail-closed**: `maskAllText: true`, `maskAllInputs: true`, `blockAllMedia: true`; `<input type="password">` and `autocomplete="cc-*"` always masked; iframes & shadow DOM excluded by default. Resolves **[R:sec C2]**.
11. **Error-message + stack scrubbing** with `denyUrls`/`allowUrls`/`ignoreErrors` + shape regex; default on. Resolves **[R:sec C3]**.
12. **`__BUGSEE_DEBUG__` default is `false` in npm builds** (off by default, opt-in). Resolves **[R:sec MINOR-13]**.
13. **GDPR API added**: `grantConsent()`, `revokeConsent()`, `deleteCollectedData()`, `isCapturing()`. Resolves **[R:sec MAJOR-10]**.
14. **Mobile-parity methods added** to public API: `createReport(listener) → upload(report)`, `setReportHandler({before, after})`, `setLifecycleListener`, `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`, `setAttachments`, `captureViewHierarchy()` method, `isLaunched()`, `testCrash()`, `logUnhandledException()`, `snapshot()`, `clearUser()`, `clearEmail()`, `setUserIdentifier()`. Resolves **[R:dx MAJOR-5]**.
15. **`@bugsee/electron` deferred to v1.1.** v1 ships an empty package stub with a clear "not yet supported" warning. Resolves **[R:multi MAJOR-5]**.
16. **Manifest schema version is committed in v1.** `manifest.json.version: 2` (JS SDK) — coordinate with backend to ensure forward-compat with mobile's `version: 1`. Resolves **[R:arch MINOR #7]** + **[R:arch Gap #2]**.

Open questions that must be resolved before code starts are consolidated in §18.

---

## 0.5 Decisions changed in v3 (2026-05-25)

v3 unifies the public API with the **Bugsee Android SDK** (`/Users/alexeykarimov/Projects/Bugsee/android/sdk/library/Bugsee.java`) and resolves several §18 backend questions. Everything not listed here inherits from v2. Where v2 body text still reflects the old decision, **this section supersedes it** until inlined.

**API unification — Android is canonical; Sentry-isms removed (user review 2026-05-25):**

1. **Public surface mirrors Android `Bugsee`.** `captureException`/`captureMessage`/`captureEvent` → **`logException`/`log`/`event`**. `setUser`/`setEmail`/`getEmail`/`clearEmail` → **`setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier`** (Android has no email setter — email is collected in the report flow). `pause`/`resume` → **`startBlackout`/`endBlackout`/`isBlackout`**. Added **`getLaunchOptions(): OptionsContainer`**. `deleteCollectedData()` → **`deleteCollectedDataOnDevice(includingIntermediate)`**.
2. **Sentry scope model dropped from the public API.** `withScope`/`withIsolationScope`/`getCurrentScope`/`getIsolationScope`/`getGlobalScope`/`addEventProcessor` **removed**. Identity & attributes are process-global (single scope), matching mobile. **Consequence:** no per-async-context isolation on Node servers in v1 — concurrent-request user/attribute attribution is a documented limitation (§7.2). The three-tier scope model + AsyncContextStrategy are demoted to **internal/deferred** (retained in the design for a possible v1.x server-isolation feature).
3. **`beforeSend` removed.** No Android equivalent. Event/report mutation goes through `setReportHandler({before, after})`; per-event drops via `ignoreErrors`/`denyUrls`/typed filters.
4. **Capture hooks are methods, not options.** `beforeSend`/`beforeBreadcrumb`/`beforeBundle`/`reportHandler`/`beforeNetworkEvent`/`beforeLogEvent`/`attachments`/`lifecycleListener` **removed from `BugseeOptions`**; set imperatively via `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`/`setReportHandler`/`setAdditionalDataCapture`/`setLifecycleListener` (Android parity). Because `launch()` is synchronous, call these immediately after `launch()` to cover early events.
5. **Consent API removed.** `grantConsent`/`revokeConsent`/`requireConsent`/`isCapturing` dropped (no Android equivalent; redundant with `launch`/`stop` for capture and `startBlackout`/`endBlackout` for visual). GDPR erasure stays via `deleteCollectedDataOnDevice()`.
6. **Replay is option-driven, not an integration.** `replayIntegration()` **removed** from the public API. Visual capture is configured via the `replay: boolean | ReplayOptions` launch option (mobile DX). `@bugsee/replay` (rrweb) is **lazy-`import()`ed only when `replay` is truthy**, preserving the ≤15 KB errors-only budget; CDN keeps the `bugsee.replay.min.js` add-on. `addIntegration()` remains for custom/third-party integrations.
7. **`LogExceptionOptions` matches Android `ExceptionOptions`:** `{ domain, skipFrames, labels, includeVideo }`. `domain` is canonical (not `category`); `skipFrames` **added** (was missing); `includeVideo` kept (Android key) — on JS it gates **rrweb replay** inclusion.

**Backend questions resolved (§18):**

8. **`app_token` moved to an HTTP header** (`X-App-Token` — *confirm exact name with backend*). No longer in the query string. **Done.** Resolves §18.1#4 / **[R:sec C1]**.
9. **`x-client-type: web`** for v1 (the HTTP header). Runtime-specific client types come later as sub-packages stabilize. Distinct from `sdk.type`.
10. **`environment.sdk.type: "javascript"`** (was `"JS"`).
11. **`platform.type` ships the full granular taxonomy** in v1 (`web`/`node`/`bun`/`deno`/`workers`/`edge-light`/`service-worker`/`web-worker`/`electron-main`/`electron-renderer`) — backend must accept all values. This is where runtime granularity lives, while `x-client-type` stays coarse (`web`).
12. **`x-amz-checksum-sha256` is optional for MVP/BETA.** Omittable; not a launch blocker.
13. **Replay visual representation: dashboard renders rrweb natively.** SDK uploads `replay.bin` (gzipped rrweb stream) as the new `replay` file type; the web dashboard integrates an rrweb player. No server-side MP4 transcode; mobile's `video` path is unchanged. §18.1#5 becomes a **frontend** (rrweb player) + **backend** (`replay` file type) task, not a wire change.

> **Naming-philosophy note:** v3 is Android-canonical. We do **not** ship migration guides from other SDKs — Sentry and Firebase are studied as *internal design references* (to avoid reinventing the wheel), never as schemes to migrate *from*. The former Sentry→Bugsee / Firebase→Bugsee migration sections are removed in v3.

---

## 0.6 Capture architecture & APM decoupling (v3)

Principle (user review 2026-05-25): **Sentry weaves APM/tracing through its core; we will not.** Instead the JS SDK **reuses the Bugsee Android event-flow architecture** — a pub/sub system where *sources* emit to *hubs* and the capture pipeline is just *one subscriber*. Everything domain-specific (replay, performance/APM, view-hierarchy, frustration, anomaly) attaches through pluggable seams, so any component interoperates with the core with little or no friction. Full contract + Android→JS mapping in **§16**.

1. **Pub/sub, not woven-in.** Mirror Android: **interception coordinators / adapters** (sources) `emit` events to process-wide **event hubs** *regardless of whether capture is active*; the **capture pipeline** is one consumer among many (APM, extensions, custom listeners subscribe to the same hubs). Reuses `EventEmitter` + `NetworkEventHub`/`LogEventHub`/`InputEventHub` semantics from Android **[android: `contracts/common/EventEmitter.java`, `interception/network/NetworkEventHub.java`]**.
2. **Thin kernel.** `Client` owns only generic machinery: config, the service container, the event hubs, the **capture coordinator + per-file-type cyclic ring buffers**, the **detection coordinator** (report triggers), the single global scope, the upload pipeline, the extension registry, and the bundle assembler. It knows nothing about any specific feature.
3. **Pluggable capture & detection providers** (Android parity). `CaptureProvider<T>` (subscribes a hub → filters/sanitizes → emits entries to the aggregator; declares its wire file-type + controlling option) and `DetectionProvider` (subscribes → decides when to trigger a report). Both are **registerable, including custom implementations** — `client.addCaptureProvider(...)` / `client.addDetectionProvider(...)`, mirroring `BugseeCaptureCoordinator.addProvider` / `BugseeDetectionCoordinator.addProvider`.
4. **Adapters bridge external sources.** Framework middleware (Express/Hono), an OpenTelemetry adapter, and **build-plugin-injected** operations (Vite/Webpack — the JS analog of Android's bytecode `BugseeOperationDispatcher`) feed events in and accept their own subscribers via `OperationDispatcher.registerObserver`.
5. **Extension registry** = Android `ext()` / `registerExt()` + an `Extension` interface (`name` / `setup(client)` / `stop()`). An extension exposes its *own* typed API via `client.ext(Name)` (typed by declaration-merge `NameExtensionMapping`), and in `setup()` registers providers, hub listeners, services, and buffers. **[android: `BugseeExtensions.java`, `contracts/extensions/Extension.java`]**
6. **APM fully decoupled → `@bugsee/performance` (opt-in, off by default).** It is an Extension that subscribes to `networkEventHub` + registers as an `OperationDispatcher` observer, registers a `performance` capture provider + `performance.json` buffer, owns the `/v2/performance/transactions` call and the `Span`/`Transaction`/`SpanStatus`/`SpanOptions` types and `performance*` options, and exposes `startTransaction`/`startSpan`/`getActiveSpan` via `ext()`. Removed from the kernel/protocol entirely. Tree-shakes to nothing when unused. (Decided over "defer entirely" — capability stays available, burden does not.)

> **JS adaptations of the Android model:** (A1) cyclic buffers are **in-memory ring buffers** bounded by `maxRecordingTime`/`maxDataSize`, optionally persisted via the Storage service (Node `fs` / IndexedDB), memory-only on edge — same rolling/drop-oldest semantics as Android's on-disk parts. (A2) no bytecode rewriting — the `OperationDispatcher` is fed by build-plugin injection + framework middleware. (A3) this **replaces Sentry's `Integration` abstraction** as the core model; §4.1/§7.6/§7.7 are reframed accordingly.

---

## 1. Goals & non-goals

### 1.1 Goals

1. **One SDK, every non-mobile-app JS runtime.** Tier-1: modern browsers, Node.js ≥18, Bun, Deno. Tier-2: Cloudflare Workers, Vercel Edge, Web Workers, Service Workers. Tier-1.5 (v1.1): Electron main + renderer. React Native is out (separate SDK).
2. **Wire-format compatibility with the existing Bugsee backend** (with the corrections in §0 and §8) **[M §Wire Protocol]**.
3. **Two capture modes**:
   - **Bundle mode** (default): mobile-style; buffer everything, assemble a `.bundle.zip` on a trigger, upload via the 3-step flow.
   - **Streaming mode** (mandatory on edge runtimes): each `logException` produces a minimal single-event bundle uploaded immediately; works inside a Cloudflare Workers / Vercel Edge request's lifetime.
4. **Tree-shakable, lazy by default.** Errors-only browser bundle ≤15 KB gzipped; replay add-on ≤90 KB gzipped.
5. **First-class TypeScript** with strict mode, branded identifier types (`AppToken`, `IssueId`, `RecordingId`), and api-extractor-flattened public types.
6. **Privacy-safe defaults.** Replay fail-closed; error-message scrubbing on; denylist superset of mobile; SDK doesn't capture its own traffic.

### 1.2 Non-goals (v1)

- **React Native.** Existing dedicated SDK.
- **Native crash capture** beyond what V8 surfaces.
- **In-browser MP4 replay encoding.** Replay is a new wire file type, see §11.
- **Source-map upload from the SDK runtime.** Stays a build-tool/CLI concern.
- **Multi-instance Bugsee clients per process.** Single-instance is v1; architecture preserves multi-instance feasibility.
- **End-to-end encryption** (`e2e_encrypted` flag). Explicitly deferred; flag never set by JS v1.
- **Cross-tab session sharing.** Each tab is independent in v1.
- **OpenTelemetry auto-instrumentation.** Add as `@bugsee/opentelemetry` later.
- **`@bugsee/electron`** beyond a stub package. Slated for v1.1.

---

## 2. Hard constraints (read first)

Architecture follows from these.

1. **Wire protocol is fixed.** Endpoints, headers, manifest layout, file-type names, payload field names match mobile **[M Wire Protocol]**, with the §8 corrections.
2. **Bundle = ZIP.** Single-bundle uploads use a JS-side ZIP writer (`fflate`, ~13 KB, MIT, pure JS, no native deps). Streaming-mode single-event bundles are also ZIPs (server pipeline expects the bundle format on the PUT path).
3. **Numeric severity (1–5) and log level (1–5)** match mobile. Severity ascending = severer (1=VeryLow, 5=Blocker). Log level: 1=Error, 5=Verbose. Public API is string-typed; protocol layer translates.
4. **Option keys are dotted strings with `.` → `:` substitution.** Only inside `environment.sdk.options` **[M EnvironmentInfoProvider.java:312-333]**.
5. **3-step upload + 403-renew + 401-reauth.** Session → issue-create → signed PUT; 403 triggers `uploadDataRenew` re-issue with full `request.json` body + overlay **[R:wire M3]**; 401 invalidates cached `access_token`.
6. **Auto-sanitizer is part of the contract.** Headers/body/query keys redacted with token `<redacted>` (raw) / `%3Credacted%3E` (URL-encoded) — server-side dedup depends on byte-identical tokens.
7. **`@bugsee/protocol` is the single source of truth** for wire shapes, enums, sanitizer lists, and option-key translation. Pinned exactly across all packages.

---

## 3. Runtime tiers & capability matrix

### 3.1 Tier table

| Tier | Runtime | Default capture mode | Persistent storage available | v1 status |
|---|---|---|---|---|
| **1** | Modern browsers (Chrome/Edge/Firefox/Safari current −2) | bundle | IndexedDB → localStorage → memory | Ships v1 |
| **1** | Node.js ≥18 | bundle | `node:fs` under `os.tmpdir()` | Ships v1 |
| **1** | Bun ≥1.1.13 | bundle | `node:fs` | Ships v1 |
| **1** | Deno ≥1.36 (with `--allow-net`, `--allow-write`) | bundle | `Deno.makeTempDir` | Ships v1 |
| **1.5** | Electron main + renderer | bundle | main: `node:fs`+`app.getPath('userData')`; renderer: IndexedDB | **v1.1** (stub package in v1) |
| **2** | Cloudflare Workers | **streaming** | none (in-memory only) | Ships v1 |
| **2** | Vercel Edge | **streaming** | none | Ships v1 |
| **2** | Web Workers | bundle (in-memory cap) | IndexedDB | Ships v1 |
| **2** | Service Workers | streaming | IndexedDB or Cache API | Ships v1 (static bundle only) |
| **3** | Deno Deploy, Fastly Compute, niche edges | streaming | varies | Community-driven |

### 3.2 Capture provider / interceptor × runtime support matrix

This is the public-facing capability matrix, named per the v3 model (§16): **interceptors** are sources, **capture providers** are consumers. Platform packages enforce support via their default provider/interceptor set and `@bugsee/integration-shims` (no-op shims for absent features).

| Provider / interceptor | Browser | Node | Bun | Deno | Workers | Vercel Edge | Web Worker | Service Worker | Electron Main¹ | Electron Renderer¹ |
|---|---|---|---|---|---|---|---|---|---|---|
| `globalErrorInterceptor` | ✓ | ✓ | ✓ | ✓ | ✓ (per-handler) | ✓ (per-handler) | ✓ (`self.onerror`) | ✓ (`self.onerror`) | ✓ (`process`) | ✓ (`window`) |
| `consoleInterceptor` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `fetchInterceptor` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `xhrInterceptor` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (XHR removed) | ✗ | ✓ |
| `webSocketInterceptor` | ✓ | ✓ | ✓ | ✓ | ✓ outbound | ✓ outbound | ✓ | ✓ | ✓ | ✓ |
| `breadcrumbsProvider` (clicks/keys/history) | ✓ | shim | shim | shim | shim | shim | shim | shim | shim | ✓ |
| `replay` (via `replay` option) | ✓ | shim | shim | shim | shim | shim | shim | shim | shim | ✓ |
| `@bugsee/performance` (extension, opt-in) | ✓ (web-vitals, long task) | ✓ (http span) | ✓ | ✓ | ✓ | ✓ | partial | partial | ✓ | ✓ |
| `viewHierarchyProvider` (DOM snapshot) | ✓ | shim | shim | shim | shim | shim | shim | shim | shim | ✓ |

¹ Electron platform packages ship in v1.1.

### 3.3 AsyncContextStrategy per runtime

| Runtime | ALS available? | Strategy | Fallback |
|---|---|---|---|
| Browser | No (no Web ALS spec) | Stack-based (Sentry-style) | n/a |
| Node ≥18 | Yes (`node:async_hooks`) | ALS | n/a |
| Bun ≥1.1.13 | Yes | ALS | n/a |
| Deno ≥1.36 | Yes via `node:async_hooks` | ALS | n/a |
| Cloudflare Workers **with `nodejs_compat` or `nodejs_als`** | Yes (`node:async_hooks`) | ALS | n/a |
| Cloudflare Workers **without compat flag** | No | **Vendored `globalThis.AsyncLocalStorage` shim** (probe at runtime) | Falls back to stack with one-time `debug.warn`. We do NOT throw at import time. |
| Vercel Edge | Yes via `globalThis.AsyncLocalStorage` (not `node:async_hooks`) | ALS via global | n/a |
| Web Workers | No | Stack | n/a |
| Service Workers | No | Stack | n/a |
| Electron main | Yes | ALS | n/a |
| Electron renderer | No | Stack | n/a |

### 3.4 Storage per runtime

| Runtime | Primary | Probe-fallback | Notes |
|---|---|---|---|
| Browser | IndexedDB (probe `validateIndexedDBOpenable()`) | localStorage → memory | Safari iframes / private mode silently fail on IDB; mirror Firebase's probe **[F §5.4]** |
| Node | `node:fs` under `bugsee.getStorageDir()` (default `path.join(os.tmpdir(), 'bugsee', appTokenHash)`) | memory | Files written with `mode: 0o600` |
| Bun | Same as Node | memory | |
| Deno | `Deno.makeTempDir({ prefix: 'bugsee-' })`; needs `--allow-write` | memory (with one-time warn) | |
| Electron main | `node:fs` under `path.join(app.getPath('userData'), 'bugsee')` | memory | v1.1 |
| Electron renderer | IndexedDB | memory | v1.1 |
| Cloudflare Workers | **memory only** (per-isolate, no persistence) | n/a | Capture mode forced to `streaming` |
| Vercel Edge | **memory only** | n/a | Streaming |
| Web Worker | IndexedDB (workers can open IDB) | memory | |
| Service Worker | IndexedDB (or Cache API for bundles) | memory | |

`@bugsee/protocol` declares `BugseeStorage` as an interface; each platform package contributes an implementation via `client.addService('storage', ...)`.

---

## 4. Architectural pillars

### 4.1 Extension model (Android-derived; full contract in §16)

> **v3:** the canonical model is the Bugsee Android event-flow architecture (§0.6, §16), **not** Sentry's `Integration`. The kernel is a pub/sub system; features attach at one of these seams (litmus test, resolves **[R:arch MINOR #8]**):

- **Service** (`Service<T>` + `Provider<T>` + per-Client `ServiceContainer`): a *replaceable platform-specific implementation* — `Transport`, `Storage`, `Clock`, `IdGenerator`, `Platform`, `BundleWriter`, `Logger`, `StackParser`. Singletons within a Client.
- **Interceptor / Adapter** (source): owns a runtime hook (fetch/console/DOM/error) or bridges an external lib / build-injection, and `emit`s to an **event hub** regardless of capture state.
- **Capture provider** (consumer): subscribes to a hub, filters+sanitizes, writes entries to its per-file-type ring buffer for bundling.
- **Detection provider** (consumer): subscribes to hubs/operations and triggers report assembly.
- **Extension**: a feature module that in `setup()` registers any of the above and exposes its own API via `ext()`.

A feature with both a platform impl and a capture loop (e.g. replay = an encoder Service + a recorder Capture provider) uses both seams. The old Sentry "Integration" concept maps onto the **Interceptor + Capture-provider** pair.

### 4.2 Core abstractions table

| Abstraction | Purpose | Citation |
|---|---|---|
| **`Client`** | Owns config, transport pipeline, integrations, scope tree, hook bus, capture buffers (bundle mode), the service container | Sentry v10 (`packages/core/src/client.ts`) — single non-abstract class; platform-specific bootstrap lives in the platform package's `register()` function (called from `launch()`), not via subclassing **[R:arch §4 fix (a)]** |
| **`Scope`** | User, attributes, breadcrumbs (capped), contexts, event processors, propagation context | Sentry v10 (`scope.ts`) |
| **Three-tier scopes** | global / isolation / current — **internal/deferred in v3 (§0.5, §7.2)**; v1 exposes a single global scope. Retained in the design only for a possible v1.x server-isolation feature | Sentry v10 (`currentScopes.ts`) — studied as a design reference |
| **`AsyncContextStrategy`** | Pluggable async-context propagation; per-runtime impl | Sentry v10 (`asyncContext/types.ts`) |
| **`Carrier`** | `globalThis.__BUGSEE__[SDK_VERSION]` so versions coexist | Sentry v10 (`carrier.ts`) |
| **`BugseeApi`** | Authenticated control plane: `ensureSession()`, `createIssue(req)`, `renewUpload(id, rec)` | New v2 (split from v1's `Transport`) |
| **`BundleUploader`** | Unauthenticated data plane: `putBundle(url, body, sha256)` | New v2 |
| **`UploadPipeline`** | Orchestrator: buffer, retry, outcomes, captures-vs-uploads bookkeeping, edge-mode vs bundle-mode dispatch | New v2 |
| **`Service` / `Provider` / `ServiceContainer`** | Per-Client service registry with `LAZY` + `EXPLICIT` modes and pending-Deferred late registration | Firebase `@firebase/component` (renamed; **[R:arch §Naming]**) |
| **`NameServiceMapping`** | TS declaration-merge cross-package service typing | Firebase **[F §2.1]** |
| **`EventEmitter` / event hubs** | pub/sub source→consumer fan-out (`networkEventHub`/`logEventHub`/`inputEventHub`); emit regardless of capture state | Android `EventEmitter` / `NetworkEventHub` (§16) |
| **Interceptor / Adapter** | runtime-hook sources + external/build-injection bridges (`OperationDispatcher`) | Android interception coordinators + adapters (§16) |
| **`CaptureProvider` / `DetectionProvider`** | pluggable consumers: capture → ring buffer, or trigger a report; custom impls registerable | Android `BugseeCaptureDataProviderBase` / `BugseeDetectionProviderBase` (§16) |
| **`Extension`** | feature module bundling the above; `registerExt`/`ext` | Android `BugseeExtensions` (§16) |
| **Event/trigger pipeline** | source → hub → capture provider → ring buffer; detection provider → trigger → `reportHandler.before` → assemble bundle → upload | Android event flow (§16) + §7.7; no `beforeSend`/scope merge in v3 (§0.5) |

### 4.3 Differences from Sentry (annotated)

- **No DSN.** `app_token` + optional `endpoint` override.
- **No envelope wire.** Bundle ZIP via 3-call upload.
- **Bundle-mode default, streaming-mode for edge.** Edge runtimes invert the model.
- **Three-step transport orchestration.** Not a single envelope POST.
- **Tunnel option deferred to v1.x**, not "out of scope" (ad-blockers and strict CSP make `api.bugsee.com` unreachable for some browser traffic; addressed in §18).
- **Public log/severity API is string-typed.** Mobile's numeric inversion (1=Error, 5=Verbose) is hidden behind the protocol layer.

### 4.4 Differences from Firebase (annotated)

- **No multi-App story.** Single-Client design.
- **No global `_components` map.** Per-Client `ServiceContainer` only.
- **Two instantiation modes** (`LAZY` + `EXPLICIT`); no `EAGER`. Fire-and-forget services (like the performance batched flusher) are implemented as `LAZY` services whose `init()` schedules its own timer.
- **No heartbeat in getter.** Mistake we don't copy **[F §13 #1]**.
- **`Service` not `Component`** to avoid React name collision.

---

## 5. Package layout

```
packages/
  # tier 0: runtime-agnostic foundation (zero internal deps among themselves except util→types)
  @bugsee/types                 # TS types only; declaration-merge target for NameServiceMapping
  @bugsee/util                  # pure utilities: env detection, Deferred, base64, sha256, deep-merge, json-safe-stringify, exponential-backoff, fflate re-export
  @bugsee/logger                # log-level + handler registration
  @bugsee/service               # Service / Provider / ServiceContainer (~400 LOC). Renamed from "component" per R:arch.
  @bugsee/protocol              # canonical wire shapes (TS types + JSON serializers + sanitizer lists + option-key translator + numeric enum maps)
  @bugsee/integration-shims     # no-op stand-ins for replay/canvas/etc. on runtimes without DOM (mirrors Sentry's pattern, [S §10.4])

  # tier 1: SDK kernel
  @bugsee/core                  # Client, single global Scope (three-tier model internal/deferred, §7.2), AsyncContextStrategy interfaces, BugseeApi/BundleUploader/UploadPipeline interfaces, event hubs + EventEmitter, CaptureProvider/DetectionProvider + Extension registry (ext/registerExt), cyclic ring buffers, event/trigger pipeline, BundleWriter (§16)

  # tier 2: platform packages — each is single-platform
  @bugsee/browser               # window/document, fetch transport, IndexedDB storage, error/unhandledrejection handlers, stack-trace parser (Chrome/FF/Safari/WebKit)
  @bugsee/node                  # Node http(s) transport (NOT native fetch — keeps proxy support per R:multi §Node), node:fs storage, uncaughtException/unhandledRejection, AsyncLocalStorage ACS
  @bugsee/bun                   # re-exports @bugsee/node + Bun-specific overrides (Bun.serve wrapper)
  @bugsee/deno                  # Deno fetch + permissions-aware storage + Deno.serve wrapper
  @bugsee/cloudflare            # Workers ALS (with shim fallback), edge-mode transport with ctx.waitUntil integration, IsolatedPromiseBuffer
  @bugsee/vercel-edge           # WinterCG fetch, globalThis.AsyncLocalStorage probe
  @bugsee/webworker             # Generic Web Worker entry — DOM-less; SW variant has its own static bundle (see §12.6)
  @bugsee/electron              # STUB in v1; full impl in v1.1

  # tier 3: shared mid-tier
  @bugsee/browser-utils         # DOM utilities, click/keypress instrumentation, history API hooks
  @bugsee/replay                # rrweb-based recorder (Sentry's actively-maintained fork)
  @bugsee/replay-canvas         # canvas-replay add-on (opt-in)
  @bugsee/performance           # APM extension (opt-in, off by default); ext()/registerExt; owns /v2/performance/transactions, Span/Transaction types, performance.* options — zero core footprint when unused (§0.6, §16)
  @bugsee/node-utils            # http/https/fs/AsyncLocalStorage helpers shared by node/bun/electron-main

  # tier 4: framework adapters
  @bugsee/react                 # ErrorBoundary, hooks, dedup-via-checkOrSetAlreadyCaught
  @bugsee/vue                   # errorHandler integration
  @bugsee/angular | /svelte | /solid
  @bugsee/nextjs                # meta: client + server + edge entries (workerd/edge-light conditions live here)
  @bugsee/nuxt | /sveltekit | /remix | /astro
  @bugsee/express | /fastify | /nestjs | /hono | /elysia
  @bugsee/vite-plugin           # auto-define __BUGSEE_DEBUG__, source-map upload trigger
  @bugsee/webpack-plugin        # ditto

  # tier 5: convenience
  bugsee                        # umbrella; the ONLY package with multi-runtime exports conditions
```

### 5.1 Normative: no import-time service registration

> **Platform packages MUST NOT register services at import time.** `@bugsee/{platform}` exports a `launch()` (or `register()`) function that imperatively builds the service list. This is the contract that keeps `sideEffects: false` safe across the monorepo and that makes tree-shaking predictable.

This rule applies to integrations too: importing `@bugsee/replay` must NOT install rrweb hooks. In v3 (§0.5) the SDK lazy-`import()`s and registers the replay recorder internally only when the `replay` launch option is truthy — there is no public `replayIntegration()` to construct. Resolves **[R:mod C2]**.

`@bugsee/protocol` and tier-0 packages are bound to zero runtime side effects (types + pure functions only).

### 5.2 `NameServiceMapping`

```ts
// @bugsee/service
export interface NameServiceMapping {}

// @bugsee/protocol (declaration-merge)
declare module '@bugsee/service' {
  interface NameServiceMapping {
    'api': BugseeApi;
    'uploader': BundleUploader;
    'storage': BugseeStorage;
    'clock': BugseeClock;
    'platform': BugseePlatform;
    'bundle-writer': BundleWriter;
    'logger': BugseeLogger;
    'id-generator': IdGenerator;
    'stack-parser': StackParser;
  }
}

// @bugsee/replay (optional)
declare module '@bugsee/service' {
  interface NameServiceMapping {
    'replay-encoder': ReplayEncoder;
  }
}
```

`container.getProvider('replay-encoder')` is typed `Provider<ReplayEncoder>` only when `@bugsee/replay`'s types are reachable — matches Firebase **[F §2.1]**.

### 5.3 Avoiding dev-dep cycles

Per **[R:mod MINOR-13]**: `@bugsee/service` tests must NOT import `@bugsee/replay`. Type-only merges are safe; runtime imports would create a dev-dep cycle. CI enforces this via `madge --circular`.

---

## 6. Runtime adaptation strategy

Three mechanisms, applied in this priority order:

1. **Separate packages per runtime.** `@bugsee/cloudflare` IS the Workers build; `@bugsee/deno` IS the Deno build. Their `package.json` declares no runtime conditions (only `import`/`require`). This matches what Sentry and Firebase actually ship **[R:mod C1]**: `packages/cloudflare/package.json` has only `import`+`require`; `packages/deno/package.json` has only `import`. Conditions like `bun`/`deno`/`workerd` are runtime-resolver conventions, not bundler conventions, and putting them on every package adds noise without coverage.

2. **Conditional exports only on the umbrella `bugsee` package.** This is where multi-runtime resolution actually matters — a user does `import { launch } from 'bugsee'` and the umbrella's `exports` map routes to `@bugsee/browser` or `@bugsee/node` or `@bugsee/cloudflare` based on the consumer's bundler conditions:
   ```json
   "exports": {
     ".": {
       "types": "./dist/types/index.d.ts",
       "workerd": "./dist/esm/cloudflare.js",
       "edge-light": "./dist/esm/vercel-edge.js",
       "worker": "./dist/esm/webworker.js",
       "deno": "./dist/esm/deno.js",
       "bun": "./dist/esm/bun.js",
       "node": { "import": "./dist/esm/node.js", "require": "./dist/cjs/node.cjs" },
       "browser": {
         "development": "./dist/esm/browser.dev.js",
         "production": "./dist/esm/browser.prod.js",
         "default": "./dist/esm/browser.prod.js"
       },
       "default": "./dist/esm/browser.prod.js"
     },
     "./package.json": "./package.json"
   }
   ```
   Resolved order matches the runtime detection priority: `workerd` first because Cloudflare's resolver sets both `workerd` AND `worker`; we want `workerd` to win.

3. **Build-time file aliasing.** When a single source file in `@bugsee/core` needs different impls of one helper (rare — most divergence is at the entry-file or service-registration level), use `src/platform/<env>/<file>.ts` with Rollup `alias` plugin. Mirrors Firestore's pattern **[F §5.3]**. Reserved for things like the SHA-256 helper (WebCrypto on browsers; `node:crypto` on Node; `crypto.subtle` on Workers/Edge — all available but accessed differently).

Runtime detection (`isBrowser`/`isNode`/`isBun`/`isDeno`/`isCloudflareWorker`/`isVercelEdge`/`isWebWorker`/`isServiceWorker`/`isElectronRenderer`/`isElectronMain`) lives in `@bugsee/util` and is used **only for content decisions** (e.g. "should I open IndexedDB?"); the runtime adapter for transport/storage is chosen at build time.

`@bugsee/integration-shims` provides no-op exports for `viewHierarchyProvider`/`xhrInterceptor` etc. that the non-browser platform packages re-export, so user code that references these in a Workers entry still type-checks and produces a friendly `debug.warn("viewHierarchyProvider is a no-op on cloudflare; ignored")` instead of an opaque crash. (Replay is not in this list — it is option-driven, not a user-constructed integration; the `replay` option is simply ignored with a warn on non-browser runtimes.)

---

## 7. Core abstractions in detail

### 7.1 `Client`

```ts
export class Client<O extends ClientOptions = ClientOptions> {
  readonly options: O;
  readonly ready: Promise<void>;       // resolves after first session-creation or fails fast on invalid token
  readonly captureMode: 'bundle' | 'streaming';

  init(): void;                                // called by launch(); idempotent
  // Sentry capture* (captureException/captureMessage/captureEvent) removed in v3 (§0.5);
  // capture entry points are logException / log / event (declared below) + addBreadcrumb.
  addBreadcrumb(b: Breadcrumb): void;

  // mobile parity
  upload(report: ManualReport): Promise<UploadResult>;
  showReportDialog(opts?: ReportDialogOptions): Promise<UploadResult | null>;
  logException(err: unknown, opts?: LogExceptionOptions): Promise<UploadResult>;
  logUnhandledException(err: unknown): Promise<UploadResult>;
  createReport(listener: (rep: MutableReport) => void | Promise<void>): Promise<MutableReport>;
  snapshot(opts?: SnapshotOptions): Promise<UploadResult>;
  captureViewHierarchy(): Promise<string>;     // returns viewtree id

  // lifecycle (Android parity)
  startBlackout(): void;     // pauses VISUAL capture (replay) only — errors/network/logs continue
  endBlackout(): void;
  isBlackout(): boolean;
  stop(timeout?: number): Promise<boolean>;    // drains pending uploads (unless `discardPending: true`); becomes !isLaunched
  relaunch(opts?: Partial<O>): Promise<Client>;
  flush(timeout?: number): Promise<boolean>;
  close(timeout?: number): Promise<boolean>;
  isLaunched(): boolean;
  getLaunchOptions(): OptionsContainer;

  // privacy / data deletion (Android parity — consent API removed in v3, §0.5)
  deleteCollectedDataOnDevice(includingIntermediate: boolean): Promise<boolean>;

  // identity (Android parity — setUser/setEmail removed in v3, §0.5)
  setUserIdentifier(id: string): void;
  getUserIdentifier(): string | null;
  clearUserIdentifier(): void;
  setAttribute(k: string, v: AttributeValue): void;
  getAttribute(k: string): AttributeValue | undefined;
  clearAttribute(k: string): void;
  clearAllAttributes(): void;
  getAllAttributes(): Record<string, AttributeValue>;

  // events/traces (mobile parity)
  event(name: string, params?: Record<string, unknown>): void;
  trace(name: string, value: unknown): void;
  log(message: string, level?: LogLevel | LogLevelName, timestamp?: number): void;

  // privacy/sanitization hooks
  setNetworkEventFilter(fn: ((e: NetworkEvent) => NetworkEvent | null) | null): void;
  setLogEventFilter(fn: ((e: LogEvent) => LogEvent | null) | null): void;
  setBreadcrumbFilter(fn: ((b: Breadcrumb) => Breadcrumb | null) | null): void;
  setReportHandler(h: { before?: ReportFn; after?: ReportFn } | null): void;
  setAdditionalDataCapture(fn: () => Attachment[] | Promise<Attachment[]>): void;   // Android parity (was setAttachments)
  setLifecycleListener(fn: (e: LifecycleEvent) => void): void;
  addSecureView(target: Element | string): void;
  removeSecureView(target: Element | string): void;

  // extension model — Android-derived; full contract §16
  registerExt<K extends keyof NameExtensionMapping>(name: K, ext: NameExtensionMapping[K]): void;
  ext<K extends keyof NameExtensionMapping>(name: K): NameExtensionMapping[K];
  addCaptureProvider(p: CaptureProvider): void;       // pluggable capture data source (Android addProvider)
  addDetectionProvider(d: DetectionProvider): void;   // pluggable report trigger
  readonly hubs: EventHubs;                           // pub/sub: networkEventHub/logEventHub/inputEventHub
  readonly operations: OperationDispatcher;           // build-injection / framework-adapter bridge

  // integrations: kept ONLY for custom/third-party; first-party features use the model above.
  // NOTE: Sentry scope API (withScope/getCurrentScope/...) and addEventProcessor removed in v3 (§0.5);
  // identity & attributes are process-global (§7.2).
  addIntegration(i: Integration): void;
  getIntegration<T = Integration>(name: string): T | undefined;

  // services (late-registration via Deferreds — Firebase pattern, per-Client)
  addService<K extends keyof NameServiceMapping>(name: K, factory: ServiceFactory<NameServiceMapping[K]>): void;
  getService<K extends keyof NameServiceMapping>(name: K): NameServiceMapping[K];

  // hook bus
  on(hook: HookName, fn: HookFn): () => void;
  emit(hook: HookName, ...args: unknown[]): void;

  // testing
  testCrash(): never;
}
```

**`launch()` returns a `Client` synchronously.** Capture buffers are live the moment `launch()` returns; the first `/v2/sessions` call is lazy (on first upload, matching mobile **[M Lifecycle item 1]**). For users who need the post-init signal:

```ts
const client = Bugsee.launch(token, opts);
await client.ready;   // resolves after first session-creation, or rejects on invalid token / hard-fail
```

The namespace `Bugsee.logException(...)` reads `getClient()` from the carrier; if no Client has been launched, captures are queued into a 50-event pre-launch buffer drained on `launch()` (same shape as webview-inject's queue **[M §webview]**).

### 7.2 `Scope` and the three-tier model

> **v3 (§0.5):** the public scope API (`withScope`/`getCurrentScope`/…) is **removed**. Identity & attributes are process-global (a single scope), matching mobile. The three-tier model and AsyncContextStrategy below are **internal/deferred** — retained in the design for a possible v1.x server-isolation feature, not exposed in v1. **Known limitation:** on Node/Bun/Deno servers, concurrent requests share one global scope, so per-request user/attribute attribution is not isolated in v1. The tie-break table below therefore collapses to "the single global scope" until isolation ships.

Original v2 design (retained for reference): three scopes (global / isolation / current) stored on the carrier, accessed via the AsyncContextStrategy.

**Tie-break rules at trigger time** (resolves **[R:arch C5]**):

| Field on the assembled `request.json` | Source priority (first non-null wins) |
|---|---|
| `email` / `user.email` | current → isolation → global |
| `user.id` / `userIdentifier` | current → isolation → global |
| Breadcrumb ring | merged across all scopes by `timestamp`; cap to `maxBreadcrumbs` |
| Attributes (`manifest.attrs`) | merged (current overrides isolation overrides global) |
| Tags / labels | merged (current overrides isolation overrides global) |
| Contexts (`environment.app`, etc.) | merged (current overrides isolation overrides global) |
| Event-level fields (`severity`, `summary`, `description`) | exclusively from the triggering event/hint |

For browser runtimes (stack-strategy ACS, no async propagation), `current` and `isolation` collapse onto each other across async boundaries — moot in v1 since the public scope API is removed (§0.5) and there is a single global scope.

### 7.3 `AsyncContextStrategy`

Per §3.3 table. The Cloudflare implementation probes for `globalThis.AsyncLocalStorage` first, then falls back to `node:async_hooks` only if available, then to stack with a one-time `debug.warn('AsyncLocalStorage unavailable; scope isolation across awaits will not work. Add "nodejs_compat" or "nodejs_als" to wrangler.toml to enable.')`. **The SDK never throws at module-load time** from a missing ACS implementation — Sentry's Cloudflare package throws today **[R:multi C2]** and we avoid that.

### 7.4 `Service` / `Provider` / `ServiceContainer`

Per-Client (no global), with two modes:

- **`LAZY`** (default): instantiate on first `getImmediate()` / `get()`.
- **`EXPLICIT`**: caller invokes `provider.initialize(opts)` before `get()`. Used for services that need init params (e.g. `ReplayEncoder` needs masking options).

**Late registration via `client.addService()`** uses Firebase's pending-Deferred pattern **[F §2.3]**:
- `provider.get('foo')` before `addService('foo', factory)` returns a Deferred that resolves when the factory is registered.
- `provider.getImmediate()` before registration throws (or returns null with `{ optional: true }`).
- **On factory failure, pending Deferreds are rejected with the factory error** — we don't keep them hanging, fixing Firebase's wart **[F §13 #3]**.
- **`clearInstance(id)` rejects pending Deferreds** — fixing Firebase's wart **[F §13 #4]**.

`onInit(callback)` hook chains service init (e.g. when `Transport` becomes ready, replay encoder registers its flush hook).

No global `_components` map — components live in the per-Client container. We don't need cross-Client coordination because we don't support multi-instance.

No `EAGER` mode. Services that need to do periodic work (the 30s performance flush) implement it inside their `LAZY` factory: the first `getImmediate()` call schedules the timer.

### 7.5 Transport architecture — split into three roles

This replaces v1's single `Transport.send(bundle)` interface. Resolves **[R:arch C1]**.

```ts
// CONTROL PLANE — authenticated; orchestrates session + issue lifecycle
interface BugseeApi {
  // Memoized; refreshes on 401. Returns Bearer token.
  ensureSession(env: EnvironmentEnvelope): Promise<AccessToken>;
  // POST /v2/issues?app_token=<t> with full request.json body. Returns signed PUT url + issueId + recordingId.
  // (Status quo: app_token is in query. See §8.1 and §18 — backend coordination to move to header.)
  createIssue(req: RequestJson): Promise<IssueCreateResult>;
  // POST /v2/issues?app_token=<t> with full original request.json + { uploadDataRenew: { issueId, recordingId } } overlay.
  renewUpload(req: RequestJson, id: IssueId, rec: RecordingId): Promise<IssueCreateResult>;
  // (performance upload removed from core in v3, §0.6 — the @bugsee/performance extension
  //  owns POST /v2/performance/transactions, not the core BugseeApi)
  invalidateSession(): void;     // drops cached access token; next ensureSession re-acquires
}

// DATA PLANE — unauthenticated PUT; mirrors iOS PUT headers
interface BundleUploader {
  putBundle(url: string, body: Uint8Array, opts: {
    contentLength: number;
    checksumSha256: string;       // hex; cheap via crypto.subtle.digest('SHA-256', body)
    fileName: string;             // <random20>.bundle.zip
  }): Promise<PutResult>;          // { ok: true } | { ok: false, status, retryable }
}

// ORCHESTRATOR
interface UploadPipeline {
  enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult>;
  flush(timeout?: number): Promise<boolean>;
  drop(reason: DropReason, category: OutcomeCategory): void;
}
```

The orchestrator owns:
- Promise buffer (default size: **4 in bundle mode** because each operation is 3 HTTP calls; **8 in streaming mode** for edge throughput).
- Retry with exponential backoff (5xx + network errors) — but **max 3 consecutive 401s** before giving up on the bundle to avoid the auth-oracle scenario **[R:sec MINOR-15]**.
- 403→`renewUpload` retry path.
- Outcome bookkeeping per `OutcomeCategory` (one of: `session`, `issue`, `upload`, `performance`).
- On Cloudflare: integrates with `ctx.waitUntil(pipeline.flushPromise)` so uploads survive past `Response`.
- On Workers/Edge: uses `IsolatedPromiseBuffer` (drained before request return) instead of the default promise buffer.

The bundle PUT mirrors iOS:
- `Content-Length: <bytes>`
- `x-amz-checksum-sha256: <hex>` (computed via `crypto.subtle.digest` or `node:crypto.createHash`)
- `fileName: <basename>`
- **No `Authorization` header** (signed URL self-auths)
- **No `Content-Type` header** (iOS sends `""`; in JS we omit entirely — equivalent for S3)

### 7.6 Capture providers, detection providers & extensions

> **v3:** the Sentry `Integration` interface is **replaced** by the Android-derived pub/sub model. The full interfaces (`EventEmitter`, event hubs, `Interceptor`/`Adapter`/`OperationDispatcher`, `CaptureProvider`, `DetectionProvider`, `Extension`) and all registration seams live in **§16**.

Mapping from the old Sentry shape:
- `Integration.setup` → `Interceptor.start` (source) and/or `CaptureProvider.start` / `Extension.setup` (consumer).
- `preprocessEvent` / `processEvent` → the capture provider's filter+sanitize step plus the event-filter setters (`setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`, §9/§16.3).
- `onBundle` (flush at assembly) → `CaptureProvider.serialize(entries)` — ring buffer → bundle file, called once per trigger.
- `processSpan` → **removed**; APM is the `@bugsee/performance` extension (§0.6), which subscribes to hubs/operations rather than piercing the core.

### 7.7 Event pipeline

> **v3:** the general source→hub→capture-provider→ring-buffer flow is defined in **§16**. This section details the **error-capture and trigger** paths specifically. "Event processors" below are the capture provider's filter+sanitize steps (not Sentry integrations).

```
[capture time — bundle mode]
  Bugsee.logException(e) → client capture (global scope; no per-call scope in v3)
    → client._enrichEvent → emit('preprocessEvent')
    → capture provider enrich (apply global scope: user, attributes, breadcrumbs)
    → event processors (sequential; may drop by returning null)
    → DROP FILTERS: ignoreErrors / denyUrls (no user beforeSend in v3, §0.5)
    → DEDUP CHECK: if event signature matches one already in any active bundle's buffer
                   within the last 100 ms, drop with outcome 'duplicate' [R:arch Gap #3]
    → enqueue into client._buffers[type]
    │
[capture time — streaming mode (edge)]
  Same up through the dedup check, then:
    → ASSEMBLE single-event bundle immediately (single typed file + minimal manifest)
    → UploadPipeline.enqueue(bundle) — must be awaited inside the request handler so ctx.waitUntil sees it
  Skip buffers; no breadcrumb ring (breadcrumbs that were captured during this request are bundled)

[trigger time — bundle mode]
  Bugsee.upload(...) | logException(...) | logUnhandledException(...) | crash-handler | snapshot()
    → if alreadyAssembling flag set: queue trigger (max queue depth 2; further triggers drop)
    → snapshot-copy buffers atomically; clear them for next bundle
    → resolve global scope into request.json (single scope in v3, §7.2)
    → reportHandler.before(report) (user; try/catch/timeout-wrapped per [R:sec MAJOR-7])
    → emit('beforeBundle') — each CaptureProvider.serialize(entries) (replay flushes its stream, perf extension flushes its spans)
    → serialize each buffer via @bugsee/protocol
    → BundleWriter.toZip(files) → Uint8Array
    → emit('beforeUpload')
    → UploadPipeline.enqueue(bundle)
```

**Atomicity** (resolves **[R:arch C2]**):
- Buffers are snapshot-copied on trigger, not drained-in-place. Concurrent captures during assembly land in the *next* bundle.
- A boolean `alreadyAssembling` flag guards against re-entrant triggers; if true, new triggers wait or are dropped beyond a queue depth of 2.
- Replay's `serialize` (flush at trigger) runs with a 500 ms timeout (configurable); if it times out, the replay file is omitted from the bundle with a `debug.warn` and an outcome event.

**Dedup** (resolves **[R:arch Gap #3]**):
- Sentry's `checkOrSetAlreadyCaught(err)` pattern: tag exception objects with a hidden symbol on capture; re-capture of the same instance is a no-op.
- Signature-based dedup: compute SHA-1 of `error.name + error.message + frame[0:5].fn + frame[0:5].file` and drop captures with a matching signature within a 100 ms rolling window. Configurable cap to avoid silencing genuinely repeating errors.

**Clock model** (resolves **[R:arch Gap #1]**):
- `Date.now()` for wire `timestamp` fields (matches mobile's unix-ms).
- `performance.now() + performance.timeOrigin` for *internal* ordering and duration computation.
- `manifest.time.start` / `time.end` are bracketing wall-clock timestamps from the earliest buffered event and the trigger moment, respectively.

**Sustained-error storm policy**:
- Rate limit on captures: max 100 captures per 60 s window per Client; excess captures drop with outcome `rate_limit`, exposed via `client.on('drop', ...)` for visibility.
- This is independent of mobile error codes `12003`/`12004` (server-side dedup) — we still upload, server still dedups, but we self-protect.

**Buffer policy**:
- One ring buffer per wire file type: `logs`, `network`, `events.user`, `events.system`, `breadcrumbs`, `traces.user`, `traces.system`, `errors`, `performance`.
- Each buffer is capped (`maxBreadcrumbs` for breadcrumbs at 100; other buffers cap at `maxRecordingTime`-bounded count).
- `logException` lands in `errors`; `log` lands in `logs`; `event`/`trace` route to `events.user`/`traces.user`. (Sentry's polymorphic `captureEvent` entry removed in v3, §0.5.)

### 7.8 Backpressure policy

When `UploadPipeline`'s promise buffer is full:
- Bundle mode: latest bundle dropped, outcome `queue_overflow` recorded; user-visible via `client.on('drop', ...)`.
- Streaming mode: latest event dropped (since "single bundle" is "single event"); same outcome.
- Buffer sizes: 4 bundle / 8 streaming; configurable via `transport.bufferSize`.

---

## 8. Wire protocol — `@bugsee/protocol`

Single source of truth. Owns: types, serializers, sanitizer lists, option translator, enum maps, default filename table, and the manifest schema version constant.

**Schema version commitment:** `manifest.json.version = 2` (JS SDK). Mobile currently emits `version = 1`. Backend must accept both during transition. See §18 for the backend coordination item.

### 8.1 Endpoints

| Endpoint | Method | Auth | Body | Notes |
|---|---|---|---|---|
| `/v2/sessions` | POST | none (`app_token` in body) | `{ app_token, environment }` | Lazy on first upload. Returns `{access_token}`. |
| `/v2/issues?app_token=<t>`¹ | POST | Bearer `access_token` | `request.json` verbatim | Returns `{endpoint, issueId, recordingId}`. |
| `<signed S3 url>` | PUT | none (signed) | raw `*.bundle.zip` | iOS-style headers. 403 → `uploadDataRenew`. |
| `/v2/issues?app_token=<t>`¹ | POST | Bearer | **full original `request.json` + `{ uploadDataRenew: {issueId, recordingId} }` overlay** | Body shape per `BGSNetworkManager.m:909-915` **[R:wire M3]** |
| `/v2/performance/transactions` | POST | Bearer | Span tree | **Owned by `@bugsee/performance` extension (v3, §0.6)**, not core. Batched every 30 s default; per-transaction in `realtime`. |

¹ **`app_token` is sent in the `X-App-Token` HTTP header** (moved out of the query string in v3; *confirm exact header name with backend*). The `?app_token=<t>` shown above is the pre-v3 form, retained only to mark the endpoints. Resolves the former security item **[R:sec C1]** / §18.1#4.

### 8.2 Request headers (every SDK → API call except the signed PUT)

| Header | Value | Notes |
|---|---|---|
| `Content-Type` | `application/json` | |
| `accept` | `*/*` | |
| `accept-encoding` | (transport default) | Browser: not user-settable. Node/Bun/Deno: `gzip, deflate` set by transport. |
| `x-client-type` | **`web`** (v3 decision) | Coarse client-type for auth-path routing. Runtime granularity lives in `environment.platform.type`, not here. Per-runtime client-types come later. *(v2 proposed `javascript`; reversed in v3 — confirm `web` does not take the dashboard cookie-auth path **[R:wire C3]**.)* |
| `user-agent` | `BugseeJS/<sdk-version>` | Mirrors mobile shape (`BugseeAndroid` / `iPhone-OS`). |
| `authorization` | `Bearer <access_token>` (after session) | |
| `X-Bugsee-Internal` | `1` | **Sentinel header on every SDK outbound** so the network-capture integration can skip it **[R:sec MAJOR-12]**. |

### 8.3 PUT headers (signed-URL upload — mirror iOS)

| Header | Value | Notes |
|---|---|---|
| `Content-Length` | bytes | Required. |
| `x-amz-checksum-sha256` | hex of SHA-256(zip) | **OPTIONAL for MVP/BETA (v3) — may be omitted.** When sent: computed via `crypto.subtle.digest('SHA-256', body)` (browser/Workers/Edge) or `crypto.createHash('sha256')` (Node/Bun). Protects against MITM, satisfies S3 integrity-checksum signed URLs. |
| `fileName` | `<random20>.bundle.zip` | Mirrors iOS `BGSBundleAPIHandler.m:124`. |
| (no `Authorization`) | — | Signed URL self-auths. |
| (no `Content-Type`) | — | iOS sends `""`; we omit. Equivalent for S3. |

### 8.4 Bundle layout

`*.bundle.zip` contains, at the root:

- `request.json` — the issue-create payload (verbatim copy of the `/v2/issues` body).
- `manifest.json` — bundle inventory + user attributes.
- `apptoken` — plain-text app token.
- Any number of typed files per the table below.

**Default filename table** (resolves **[R:wire M6]**):

| File type | Default filename | Format |
|---|---|---|
| `attachment` | caller-supplied | binary |
| `video` | (mobile only — JS does not emit `video`) | n/a |
| `replay` | `replay.bin` | gzipped rrweb event stream (new file type — backend coord, §18) |
| `screenshot` | (mobile only — JS may emit a single `screenshot.png` via `captureViewHierarchy` follow-up if user opts in) | PNG |
| `traces.system` | `traces.system.json` | JSON array of `{timestamp, name, value}` |
| `traces.user` | `traces.user.json` | same |
| `events.system` | `events.system.json` | JSON array of `{timestamp, name, params?}` |
| `events.user` | `events.user.json` | same |
| `viewtree` | `viewtree.json` | DOM snapshot |
| `log` | `logs.json` | `{timestamp, level (1-5), source, tag?, message}` |
| `log.internal` | `internal.logs.json` | SDK self-diagnostics (only if `debug: true`) |
| `network` | `network.json` | array of canonical network events (§8.7) |
| `breadcrumbs` | `breadcrumbs` | **NO `.json` extension** — mobile contract |
| `performance` | `performance.json` | `{transactions: [...]}` |
| `crash` | `crash.json` | (JS: best-effort, mostly empty — no native dump) |

### 8.5 `request.json` schema (JS-emitted)

```json
{
  "type": "bug" | "crash" | "error",
  "summary": "string",
  "description": "string?",
  "labels": ["string"],
  "severity": 1..5,                           // bare integer
  "email": "user@example.com?",
  "signatures": ["sha1(error fingerprint)?"],
  "source": { "type": "<source_type>", "origin": "<app-supplied>" },
  "created_on": "<ISO-8601 with Z>",
  "environment": { /* §8.6 */ }
}
```

JS `source.type` enum (to coordinate with backend, §18): `programmatic`, `uncaught`, `unhandledrejection`, `console-error`, `http-error`, `snapshot`, `manual-dialog`.

**`attrs` lives in `manifest.json`, NOT `request.json`** **[R:wire M8]**:
```json
// manifest.json
{
  "version": 2,
  "time": { "start": <unix-ms>, "end": <unix-ms> },
  "files": [{ "filename": "...", "type": "<TYPE>", "name": "...", "attrs": {...} }],
  "attrs": { "<user_attr_key>": <value> }
}
```

### 8.6 Environment envelope (JS-flavored)

```json
{
  "platform": {
    "type": "web" | "node" | "bun" | "deno" | "workers" | "edge-light" | "service-worker" | "web-worker" | "electron-main" | "electron-renderer",
    "version": "...",         // browser version, Node version, etc.
    "release_name": "...",
    "kernel_version": "?",
    "utc_offset": <minutes>,
    "disk_free": "?",
    "disk_total": "?",
    "memory_total": <bytes>,
    "locale": "en-US",
    "locale_extended_info": {...},
    "jailbreak": false
  },
  "hardware": {
    "model": "<navigator.userAgentData?.model | os.machine() | 'unknown'>",
    "manufacturer": "<userAgentData brand | os.type()>",
    "cpu_count": <navigator.hardwareConcurrency | os.cpus().length>,
    "memory_total": <(navigator as any).deviceMemory * 1024^3 | os.totalmem()>,
    "screens": [{"width": ..., "height": ..., "pixel_ratio": ...}],   // browser/Electron only
    "gpu": "<WebGL renderer | null>",
    "device_id": "<persisted UUID, sessionStorage on browser / fs on Node>",
    "device_id2": null,
    "device_id3": null,
    "battery": null,                          // omitted (Battery Status API deprecated)
    "cellular": null,
    "chipset": null,
    "boot_time": null,
    "android_id": null
  },
  "app": {
    "package_id": "<options.appId | location.host | 'unknown'>",
    "version": "<options.appVersion | '0.0.0'>",
    "build": "<options.appBuild | '0'>",
    "debuggable": <__BUGSEE_DEBUG__>,
    "debugger_attached": false,
    "build_type": "?",
    "build_flavor": "?",
    "locale": "en-US",
    "instant": false,
    "mdm_config": false,
    "permissions": []
  },
  "sdk": {
    "version": "<sdk version>",
    "build": "<git SHA>",
    "type": "javascript",          // v3 decision (was "JS")
    "options": { "<sanitized:dotted:key>": <value>, ... }
  },
  "wrapper": null                  // omitted by core; framework adapters MUST NOT populate this (reserved for cross-platform wrappers like Cordova/Flutter)
}
```

`hardware.device_id`: generated on first launch, persisted in `Storage` (browser `sessionStorage` by default, NOT `localStorage` per **[R:sec MAJOR-6]** — opt-in to `localStorage` for cross-session continuity via `persistDeviceId: true`).

### 8.7 Network event (canonical wire shape — corrected)

```ts
{
  "timestamp": 1709990000123,
  "id": "<uuid>",
  "sequence": "<uuid same as id>",
  "mechanism": "fetch" | "xhr" | "ws" | "sse" | "sendBeacon",
  "url": "https://example.com/...",
  "method": "GET",
  // CORRECTED stage values per [R:wire C1]:
  "type": "before" | "complete" | "redirect" | "error" | "abort" | "timing" | "websocket",
  "size": 1234,
  "redirect": false,
  "status": 200,
  "statusText": "OK",
  "customError": null,
  // WebSocket sub-event — added "create" per [R:wire C2]:
  "event": null | "create" | "open" | "send" | "message" | "close" | "error",
  "custom": {
    "headers": { "Header-Name": "value", ... },
    "body": "string | null",
    "error": null,
    "no_body_reason": null | "size_too_large" | "no_content_type" | "unsupported_content_type" | "cant_read_data",
    "timings": { /* PerformanceResourceTiming fields */ }
  },
  "override": false
}
```

A single request emits multiple entries sharing `id`/`sequence`; server merges. **The webview-inject-script's stage names (`start`/`timeout`/`abort`) are NOT canonical** — they're rewritten by the mobile host before bundling. JS SDK emits canonical strings directly.

### 8.8 Performance transaction (owned by `@bugsee/performance` extension, v3 §0.6)

> Not part of core `@bugsee/protocol`; the extension owns this wire shape and its `/v2/performance/transactions` upload. Shown here for completeness.

```json
{
  "traceId": "<uuid>",
  "name": "Checkout",
  "operation": "ui.load",
  "status": "OK" | "ERROR" | "TIMEOUT" | "CANCELLED" | "DEADLINE_EXCEEDED" | "UNKNOWN",
  "startTimestampMs": 1709990000123,
  "endTimestampMs": 1709990001234,
  "durationNanos": 1111234000,         // performance.now() * 1_000_000, sub-ms preserved
  "isSnapshot": false,
  "appVersion": "1.2.3",
  "appBuild": "456",
  "spans": [
    { "spanId": "...", "parentSpanId": "...?", "operation": "...", "description": "...",
      "status": "OK", "startTimestampMs": ..., "endTimestampMs": ...,
      "durationNanos": ..., "attributes": { ... } }
  ]
}
```

### 8.9 Public enums (string-typed API, numeric wire)

```ts
// Public:
type LogLevelName = 'error' | 'warning' | 'info' | 'debug' | 'verbose';
type SeverityName = 'verylow' | 'medium' | 'high' | 'critical' | 'blocker';
// Wire (set by protocol layer; user never sees raw numbers unless they want them):
enum LogLevel { Error = 1, Warning = 2, Info = 3, Debug = 4, Verbose = 5 }
enum Severity { VeryLow = 1, Medium = 2, High = 3, Critical = 4, Blocker = 5 }
```

`Bugsee.log('msg', 'error')` is canonical. `Bugsee.log('msg', LogLevel.Error)` works but is documented as advanced usage. Mobile's `Low` (iOS) name aliases to `verylow` for cross-platform (Bugsee mobile ↔ JS) API consistency.

### 8.10 Sanitization wire contract

Token: `<redacted>` (raw), `%3Credacted%3E` (URL-encoded). Byte-identical to mobile. Disabled if the user sets a custom network filter.

**Denylist superset** (additions per **[R:sec MAJOR-4]**; backport to mobile for server-dedup consistency — §18):

*Headers (lowercase, case-insensitive match):* `authorization, proxy-authorization, cookie, set-cookie, x-api-key, x-auth-token, x-csrf-token, x-forwarded-for, x-real-ip, authentication, x-amz-security-token, x-amz-credential, x-amz-signature, x-goog-api-key, x-goog-iam-authorization-token, x-vault-token, x-vault-wrap-ttl, x-forwarded-authorization, x-original-authorization, proxy-cookie, x-shopify-access-token, x-clerk-session-token, x-supabase-auth, x-okapi-token, x-ms-token-aad-access-token, x-ms-token-aad-id-token, x-ms-token-aad-refresh-token`

*Body / query (lowercase, case-insensitive substring match):* `password, passwd, pass, secret, client_secret, token, access_token, refresh_token, id_token, auth_token, api_key, apikey, authorization, credit_card, creditcard, card_number, cardnumber, cvv, cvc, cvv2, ssn, social_security, pin, private_key, privatekey, jwt, bearer, bearer_token, auth, creds, credentials, session_token, sessionid, phpsessid, jsessionid, connect.sid, csrf, csrf_token, _csrf, xsrf_token, code_verifier, client_assertion, signature, hmac, mfa_token, otp, totp, routing_number, account_number, iban, swift, bank_account, dob, date_of_birth, passport, passport_number, national_id, tax_id, ein`

**Shape-based redaction** (second pass, applied to values regardless of key name):
- JWT shape: `^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`
- AWS keys: `^A(KIA|SIA|GPA|IDA|ROA)[0-9A-Z]{16}$`
- Stripe: `(sk|pk|rk)_live_[A-Za-z0-9]+`, `whsec_[A-Za-z0-9]+`
- GitHub PATs: `gh[posu]_[A-Za-z0-9]{36,}`
- CC Luhn-valid 12–19 digit strings (configurable; off by default to avoid false positives)

**Body content types supported** (resolves **[R:sec MAJOR-5]**):
- `application/json` (mobile contract; key-based)
- `application/x-www-form-urlencoded` (new in JS)
- `multipart/form-data` (new in JS; sanitize per-part key)
- `application/xml`/`text/xml`: shape-regex only (no per-key parsing in v1)
- `text/plain` / unknown: shape-regex only

**URL path scrubbing** (**[R:sec MAJOR-11]**): applies shape regex to path segments (emails, JWTs, CC Luhn, SSN). User-customizable via `networkUrlFilter: (url) => string`.

**Error-message scrubbing** (**[R:sec C3]**): applies shape regex to `error.message`, `error.cause.message`, and stack-frame text. Strips `file://` URLs from frames (developer machine path leak).

### 8.11 Wire-protocol open questions (consolidated)

Promoted to **§18 — Open questions for backend**:

1. **`x-client-type` value.** Confirm `javascript` is allowlisted in `populate.middleware.js`; ensure it does NOT trigger the cookie-auth path (`web` and `unknown` already do).
2. **`sdk.type` value.** Confirm `JS` is accepted by dashboards.
3. **`platform.type` taxonomy.** Confirm: `web`/`node`/`bun`/`deno`/`workers`/`edge-light`/`service-worker`/`web-worker`/`electron-main`/`electron-renderer`.
4. **Replay file type.** Add `replay` to backend `ReportFile`-equivalent schema; pipeline processor; dashboard renderer.
5. **Network `mechanism` strings.** Confirm `fetch`/`xhr`/`ws`/`sse`/`sendBeacon` are accepted (`mechanism` is free-text but worth a smoke test).
6. **Move `app_token` out of URL query string.** Header-only auth on `/v2/issues`. Security imperative.
7. **`source.type` enum for JS.** Confirm dashboard recognizes the new values.
8. **`manifest.json.version: 2` from JS.** Backend accepts v1 (mobile) and v2 (JS) concurrently.
9. **Sanitizer denylist superset.** Backport JS-added keys/shapes to mobile for server-dedup consistency.
10. **`x-amz-checksum-sha256` enforcement.** Confirm signed URLs are minted with `ChecksumAlgorithm=SHA256`.
11. **Attribute size enforcement.** Confirm server caps and align JS-side clamps.
12. **`uploadDataRenew` window.** Confirm there's no server-side rate limit we'd violate with normal retry.

---

## 9. Configuration model

Full type definition (resolves **[R:dx C3]** by enumerating every option; resolves **[R:dx C2]** duplicate `release`; applies naming convention from **[R:dx §Naming]**).

```ts
interface BugseeOptions {
  // ── Identity (required: appToken) ─────────────────────────────────
  appToken: AppToken;
  appVersion?: string;                          // default '0.0.0' + one-time warn
  appBuild?: string;                            // default '0'
  appId?: string;                               // default location.host on browser, process.env.npm_package_name on Node
  release?: string;                             // freeform; overrides {appVersion}.{appBuild} for dashboards
  environment?: 'production' | 'staging' | 'dev' | string;     // default: process.env.NODE_ENV ?? 'production'
  endpoint?: string;                            // default 'https://api.bugsee.com/v2'; validated as https:// (or http://localhost) at launch

  // ── Capture mode ──────────────────────────────────────────────────
  captureMode?: 'bundle' | 'streaming';         // default: 'bundle' on tier-1; 'streaming' on tier-2 edge runtimes (forced)

  // ── Capture toggles (boolean unless noted) ────────────────────────
  captureLogs?: boolean;                        // default true
  captureLogsLevel?: LogLevelName;              // default 'verbose'
  captureNetwork?: boolean;                     // default true
  captureNetworkBodies?: boolean;               // default true
  maxNetworkBodySize?: number;                  // bytes; default 20480
  captureNetworkSanitize?: boolean;             // default true
  captureBreadcrumbs?: boolean;                 // default true
  captureScreenshot?: boolean;                  // default false (privacy-conscious; opt-in)
  captureViewHierarchy?: boolean;               // default false (DOM dump; opt-in)
  captureXhr?: boolean;                         // default true (browser only)
  captureWebSocket?: boolean;                   // default true
  captureConsole?: boolean;                     // default true

  // ── Replay (nested only — no top-level replay* options) ───────────
  replay?: boolean | ReplayOptions;             // default false; set true to enable with safe defaults

  // ── Detection ─────────────────────────────────────────────────────
  detectCrash?: boolean;                        // default true (window.onerror / process.on)
  detectEarlyCrash?: boolean;                   // default true (pre-launch error queue)
  detectHttpErrors?: boolean;                   // default false (5xx → error report)
  detectAnomaly?: boolean;                      // default false
  detectFrustration?: boolean;                  // browser-only; default false (rage clicks, dead clicks)

  // ── Performance ───────────────────────────────────────────────────
  // MOVED to @bugsee/performance extension options in v3 (§0.6). NOT in core BugseeOptions.
  // (performanceMonitoring / performanceSampleRate / performanceUploadMode /
  //  performanceAdaptiveSampling / performanceFlushIntervalMs live on the extension's own options.)

  // ── Recording size / duration ─────────────────────────────────────
  maxRecordingTime?: number;                    // seconds; default 60
  maxDataSize?: number;                         // megabytes; default 10 on browser/edge, 50 on Node/Electron — per [R:dx MAJOR-11]
  maxBreadcrumbs?: number;                      // default 100

  // ── Severity defaults ─────────────────────────────────────────────
  defaults?: {
    crashSeverity?: SeverityName;               // default 'blocker'
    errorSeverity?: SeverityName;               // default 'high'
    bugSeverity?: SeverityName;                 // default 'high'
  };

  // ── Privacy & consent (resolves [R:sec C2,C3,MAJOR-10]) ────────────
  // requireConsent removed in v3 (§0.5) — gate capture by calling launch() only after consent.
  sendDefaultPii?: boolean;                     // default false; affects IP / full UA / email harvesting
  ipAnonymization?: 'none' | 'last-octet' | 'full';        // default 'last-octet' if sendDefaultPii=false
  sanitizeKeys?: string[] | { mode: 'extend' | 'replace'; keys: string[] };   // default: undefined (use built-in denylist)
  errorMessageFilter?: (msg: string) => string; // user-supplied secondary scrubber
  networkUrlFilter?: (url: string) => string;   // normalize PII out of paths
  denyUrls?: (string | RegExp)[];               // capture-time exclusion for outgoing requests + error origins
  allowUrls?: (string | RegExp)[];              // inverse
  ignoreErrors?: (string | RegExp)[];           // skip captures matching message
  onRedact?: (kind: 'header' | 'body' | 'query' | 'path' | 'error-msg', key: string) => void;

  // ── Hooks ─────────────────────────────────────────────────────────
  // REMOVED from options in v3 (§0.5). Set imperatively via methods after the synchronous
  // launch() (try/catch + 2s timeout-wrapped per [R:sec MAJOR-7] still applies):
  //   setNetworkEventFilter, setLogEventFilter, setBreadcrumbFilter,
  //   setReportHandler({before, after}), setAdditionalDataCapture (attachments),
  //   setLifecycleListener.
  // beforeSend is removed entirely (no Android equivalent) — mutate via setReportHandler({before}).

  // ── Integrations ──────────────────────────────────────────────────
  integrations?: Integration[] | ((defaults: Integration[]) => Integration[]);
  defaultIntegrations?: boolean;                // default true; set false to start with empty list

  // ── Transport / runtime ───────────────────────────────────────────
  transport?: (opts: TransportOptions) => UploadPipeline;   // power user
  storage?: BugseeStorage;                       // power user; override Storage service
  logger?: BugseeLogger;
  bufferSize?: number;                          // upload pipeline; default 4 (bundle) / 8 (streaming)
  sampleRate?: number;                          // 0..1; error-sampling, default 1.0
  asyncContext?: boolean;                       // default true; opt-out for ALS overhead concerns

  // ── Diagnostics ───────────────────────────────────────────────────
  debug?: boolean;                              // default false; if true, internal logs.json is bundled
  persistDeviceId?: boolean;                    // default false; if true, device_id in localStorage instead of sessionStorage
  initialScope?: Partial<ScopeData> | ((s: Scope) => void);
}

interface ReplayOptions {
  sessionSampleRate?: number;                   // 0..1, default 0.1
  errorSampleRate?: number;                     // 0..1, default 1.0
  maxDurationSeconds?: number;                  // default 60
  // Privacy — fail-closed defaults [R:sec C2]
  maskAllText?: boolean;                        // default true
  maskAllInputs?: boolean;                      // default true
  blockAllMedia?: boolean;                      // default true
  maskTextSelector?: string;                    // CSS selector; additional
  blockSelector?: string;                       // CSS selector; element & subtree fully blocked
  ignoreSelector?: string;                      // CSS selector; element ignored from snapshot
  unmaskTextSelector?: string;                  // explicit opt-out, for limited use
  // Performance
  recordCanvas?: boolean;                       // default false
  collectFonts?: boolean;                       // default false
  workerUrl?: string;                           // for OffscreenCanvas compression worker
  networkDetailAllowUrls?: (string | RegExp)[]; // capture request/response bodies for matching URLs
  // Hook
  beforeAddRecordingEvent?: (e: RecordingEvent) => RecordingEvent | null;
}

interface LogExceptionOptions {                 // matches Android ExceptionOptions (v3, §0.5)
  domain?: string;                              // canonical — exception grouping/categorization
  skipFrames?: number;                          // stack-trace frames to drop (e.g. wrapper frames)
  labels?: string[];
  includeVideo?: boolean;                       // Android key; on JS gates rrweb replay inclusion
}
```

### 9.1 Naming conventions (lock these in v1)

| Category | Pattern | Examples |
|---|---|---|
| Capture toggles | `capture<Noun>` | `captureNetwork`, `captureLogs`, `captureScreenshot` |
| Limits | `max<Noun>` | `maxNetworkBodySize`, `maxBreadcrumbs`, `maxRecordingTime`, `maxDataSize` |
| Detection toggles | `detect<Noun>` | `detectCrash`, `detectHttpErrors` |
| Capture providers / interceptors | `<noun>` provider/interceptor (§16) | `networkCaptureProvider`, `consoleInterceptor`, `breadcrumbsProvider` — replay = `replay` option; performance = `@bugsee/performance` extension |
| Filters / handlers (set via methods) | `set<Noun>Filter` / `setReportHandler` | `setNetworkEventFilter`, `setLogEventFilter`, `setBreadcrumbFilter` |
| Setters/getters/clearers | `set<Noun>` / `get<Noun>` / `clear<Noun>` | `setUserIdentifier`, `getUserIdentifier`, `clearUserIdentifier` |
| Capture/log verbs (Android parity) | bare | `logException`, `log`, `event`, `trace` |
| Lifecycle verbs (mobile parity) | bare | `launch`, `stop`, `pause`, `resume`, `relaunch`, `flush`, `close` |
| Reporting verbs (mobile parity) | bare | `upload`, `logException`, `showReportDialog`, `createReport`, `snapshot`, `testCrash` |

**Rename actions from v1 draft:**
- `networkMonitorIntegration` → `networkCaptureIntegration` → **`networkCaptureProvider`** (v3; the `*Integration` suffix is dropped — see §16)
- `crashPriority`/`errorPriority`/`bugPriority` → `crashSeverity`/`errorSeverity`/`bugSeverity`
- `Level` → `LogLevel` (type), `LogLevelName` (string union)
- ~~`includeVideo` → `includeReplay`~~ **reverted in v3** — `includeVideo` retained (Android key; gates rrweb replay inclusion on JS)

---

## 10. Public types reference

For every type referenced in §7 and §9. All defined in `@bugsee/protocol` and re-exported via platform packages.

```ts
// branded identifiers
type AppToken = string & { readonly __brand: 'AppToken' };
type AccessToken = string & { readonly __brand: 'AccessToken' };
type IssueId = string & { readonly __brand: 'IssueId' };
type RecordingId = string & { readonly __brand: 'RecordingId' };

// enums (numeric wire / string public)
type SeverityName = 'verylow' | 'medium' | 'high' | 'critical' | 'blocker' | 'low';   // 'low' is iOS alias for 'verylow'
type LogLevelName = 'error' | 'warning' | 'info' | 'debug' | 'verbose';
type IssueType = 'bug' | 'crash' | 'error';

// user
interface User {
  id?: string;
  email?: string;
  name?: string;
  attributes?: Record<string, AttributeValue>;
}
type AttributeValue = string | number | boolean | string[];

// events
interface Event {
  type?: 'error' | 'message' | 'transaction' | 'user-event';
  severity?: SeverityName;
  message?: string;
  exception?: { values: ExceptionValue[] };
  breadcrumbs?: Breadcrumb[];
  attributes?: Record<string, AttributeValue>;
  user?: User;
  contexts?: Record<string, Record<string, unknown>>;
  tags?: Record<string, string>;
  fingerprint?: string[];
  timestamp?: number;       // unix-ms
}
interface ExceptionValue { type: string; value: string; stacktrace?: Stacktrace; mechanism?: { handled?: boolean; type: string } }
interface Stacktrace { frames: StackFrame[] }
interface StackFrame { filename?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean }
interface EventHint { event_id?: string; originalException?: unknown; attachments?: Attachment[]; mechanism?: 'handled' | 'unhandled' | string; data?: Record<string, unknown> }
interface Breadcrumb { type?: string; category?: string; message?: string; level?: LogLevelName; data?: Record<string, unknown>; timestamp: number }
interface Attachment { name: string; filename: string; data: Uint8Array | string; mimeType?: string }

// network / log
interface NetworkEvent { /* per §8.7 — canonical wire shape */ }
interface LogEvent { timestamp: number; level: LogLevelName | LogLevel; source: string; tag?: string; message: string }

// bundle / report
interface ManualReport {
  type?: IssueType;             // default 'bug'
  summary: string;
  description?: string;
  labels?: string[];
  severity?: SeverityName;
  email?: string;
  attachments?: Attachment[];
  includeVideo?: boolean;        // Android key; gates rrweb replay inclusion on JS
}
interface MutableReport extends ManualReport { /* listener receives this, may mutate before upload */ }
interface BundleDraft { manifest: ManifestJson; request: RequestJson; files: Map<FileType, Uint8Array | string> }
interface UploadResult { ok: boolean; issueId?: IssueId; recordingId?: RecordingId; error?: BugseeError }
interface ReportDialogOptions { summary?: string; description?: string; severity?: SeverityName; labels?: string[] }
type ReportFn = (rep: MutableReport) => MutableReport | null | void | Promise<MutableReport | null | void>;
type SnapshotOptions = { summary?: string; severity?: SeverityName; labels?: string[]; includeVideo?: boolean };

// lifecycle (JS-relevant subset)
type LifecycleEvent =
  | 'launched' | 'started' | 'stopped' | 'paused' | 'resumed' | 'relaunched-after-crash'
  | 'before-report-assembled' | 'after-report-assembled'
  | 'before-report-uploaded' | 'after-report-uploaded'
  | 'report-upload-failed' | 'report-upload-failed-with-future-retry';

// spans / performance — MOVED to @bugsee/performance in v3 (§0.6); NOT in core @bugsee/protocol.
// The extension declares Span / Transaction / SpanStatus / SpanOptions and merges them where needed
// (e.g. NameExtensionMapping['performance']). Shown here for reference only:
//   interface Span { spanId; parentSpanId?; operation; description?; status: SpanStatus;
//                    startTimestampMs; endTimestampMs?; durationNanos?; attributes?; finish() }
//   interface Transaction extends Span { traceId; name; spans: Span[]; isSnapshot }
//   type SpanStatus = 'OK'|'ERROR'|'TIMEOUT'|'CANCELLED'|'DEADLINE_EXCEEDED'|'UNKNOWN'

// scope / integration / transport
interface Scope { /* see §7.2 */ }
interface ScopeData { user?: User; tags?: Record<string, string>; attributes?: Record<string, AttributeValue>; contexts?: Record<string, Record<string, unknown>>; breadcrumbs?: Breadcrumb[]; level?: LogLevelName; fingerprint?: string[] }
interface Integration { /* see §7.6 */ }
interface UploadPipeline { /* see §7.5 */ }
interface BugseeApi { /* see §7.5 */ }
interface BundleUploader { /* see §7.5 */ }
type TransportOptions = { endpoint: string; appToken: AppToken; api: BugseeApi; uploader: BundleUploader; bufferSize: number };
type EventProcessor = (event: Event, hint: EventHint) => Event | null | Promise<Event | null>;
// Core lifecycle hooks only (v3, §0.6). Extensions add their own via declaration-merge on
// NameHookMapping (e.g. @bugsee/performance adds 'spanStart'|'spanEnd'; @bugsee/replay adds
// 'replayStart'|'replayEnd') — the core HookName enum no longer hardcodes feature hooks.
interface NameHookMapping {
  preprocessEvent: [Event, EventHint]; processEvent: [Event, EventHint];
  launched: []; stopped: [];
  beforeBundle: [BundleDraft]; beforeUpload: [Bundle]; afterUpload: [UploadResult]; drop: [DropReason];
}
type HookName = keyof NameHookMapping;        // open: extensions declaration-merge additional hooks
type HookFn = (...args: unknown[]) => void;

// errors
class BugseeError extends Error { code: number; cause?: unknown }
```

---

## 11. Replay strategy

### 11.1 Implementation

- Vendor (not fork) `@sentry-internal/replay`'s rrweb fork; track upstream.
- `@bugsee/replay` wraps it; `@bugsee/replay-canvas` is the canvas add-on.
- Stack-frame: emits an `onBundle` hook (§7.6) that flushes the rrweb event ring to a `replay.bin` (gzipped JSON in v1; **msgpack as a v1.x optimization** per **[R:wire m7]**).
- Mask classes recognized: `bgs-protected`, `bgs-mask`, `bgs-block`, `bgs-ignore`. `addSecureView(el | selector)` adds `bgs-block`.

### 11.2 Privacy defaults — fail-closed

Per **[R:sec C2]**, `ReplayOptions` defaults:
- `maskAllText: true`
- `maskAllInputs: true`
- `blockAllMedia: true`
- `<input type="password">`: **always** masked regardless of flags.
- `<input autocomplete="cc-*">`, `autocomplete="one-time-code"`, `autocomplete="*-password"`: always masked.
- `<iframe>` and shadow DOM: excluded by default (rrweb's exclude flags).

Opting out (e.g. `maskAllText: false`) requires explicit `replay: { maskAllText: false }`; documented prominently.

### 11.3 Wire path

**Decision (v3):** new file type `replay`, content `replay.bin` (gzipped rrweb event stream). **The web dashboard renders it natively via an rrweb player** — rrweb is a serialized DOM-snapshot + incremental-mutation stream, not pixels, so there is **no server-side MP4 transcode**; mobile's `video` path is unchanged. §18.1#5 becomes a backend task (accept/store the `replay` file type) + a frontend task (integrate the rrweb player). Manifest entry:
```json
{ "type": "replay", "filename": "replay.bin", "name": "rrweb", "attrs": { "format": "rrweb-v2-gzipped", "duration_ms": 60000, "events": 5421 } }
```

Mobile's `video` file type stays mobile-only. JS never emits `video`.

### 11.4 Runtime support

Replay works only on browser + Electron renderer. It is enabled via the **`replay` launch option** — *not* a user-constructed integration (`replayIntegration()` was removed in v3, §0.5). The platform package **lazy-`import()`s `@bugsee/replay` only when `replay` is truthy**, so rrweb stays out of the base bundle and the ≤15 KB errors-only budget is preserved; bundlers code-split it into a separate chunk, and the CDN keeps the standalone `bugsee.replay.min.js` add-on. On non-browser runtimes the `replay` option is ignored with a one-time `debug.warn`.

---

## 12. Build, packaging, release

### 12.1 Tooling stack

| Layer | Choice | Rationale |
|---|---|---|
| **Package manager** | **pnpm ≥9** | Strict node_modules, fast, monorepo-friendly. Yarn 1 (Sentry+Firebase) is EOL. |
| **Monorepo orchestration** | **Turborepo** with mandatory **remote cache** from day one (R2-backed or Vercel free tier) | Simpler than Nx for ~20 packages. Pipeline: `build:types` ∥ `build:transpile` → `build:bundle` → `build:size-check`. |
| **Versioning + changelog** | **Changesets** with independent versioning | Firebase pattern **[F §1]**. Sentry's unified versioning is a wart **[S §13]**. |
| **Build (tier-0 packages)** | **tsup** | Simple; no bundle-size optimization needed |
| **Build (platform / framework / replay)** | **Rollup 4** with shared `@bugsee/rollup-utils` | Conditional exports, debug-flag string replacement, tree-shaking, source maps |
| **Transpiler** | **swc** | Faster than Sucrase; native decorators/JSX; aligned with Vite/Next.js |
| **Minifier** | **Terser** | Battle-tested. Compress config must DCE the `DEBUG_BUILD && ...` form. |
| **Type emission** | `tsc --emitDeclarationOnly` per package; **api-extractor** flattens public types for `@bugsee/browser`, `@bugsee/node`, framework adapters, umbrella | Firebase pattern **[F §6]**; enforces `@internal` discipline |
| **Lint / format** | **Biome** for format + base lints; **Oxlint** for type-aware rules in CI | Sentry's actual practice **[S §1]** |
| **Unit tests** | **Vitest** | Sentry's pick |
| **Browser e2e** | **Playwright** | Sentry's pick |
| **Runtime smoke tests** | Per-runtime: `bun test` / `deno test` / `wrangler dev` / Vercel CLI | One harness per runtime in `dev-packages/` |
| **Framework e2e** | Verdaccio + 10 framework apps at v1; target 30 by year-end | Down-scaled Sentry pattern **[S §11]**. Initial list: React+CRA, React+Vite, Next.js, Nuxt, Vue, Svelte, Angular, Remix, Express, Fastify |
| **Bundler tests** | `dev-packages/bundler-tests/` validating tree-shaking against webpack/rollup/vite/esbuild/turbopack/parcel | Sentry pattern; catches regressions |
| **Bundle size budget** | `size-limit` per package + umbrella with concrete byte budgets (§12.6) + `bundlemon` PR comments | Required for PR review |
| **PR snapshot publishing** | Changesets `--snapshot` | Lets reviewers `pnpm add @bugsee/browser@pr-1234` |

### 12.2 Conditional exports — corrected

**Tier-0 packages**: plain `import` + `require` only.

**Browser package**:
```json
"exports": {
  ".": {
    "types": "./dist/types/index.d.ts",
    "development": "./dist/esm/index.dev.js",
    "production": "./dist/esm/index.prod.js",
    "default": "./dist/esm/index.prod.js"
  }
}
```

**Other platform packages** (`@bugsee/node`, `@bugsee/cloudflare`, etc.): plain `import` + `require`. Platform identity = package name.

**Umbrella `bugsee`** is the ONE place with multi-runtime conditions. See §6.

`sideEffects: false` on every package. Files that ARE side-effecting (`debug-build.ts`) are explicitly excluded by the Rollup config (Sentry pattern **[S §5.1]**). The §5.1 normative rule (no import-time registration) is the policy that makes this safe.

### 12.3 `__BUGSEE_DEBUG__` flag

Build-time string replacement, identical mechanism to Sentry's `__SENTRY_DEBUG__`:

```ts
// every package's src/debug-build.ts
declare const __BUGSEE_DEBUG__: boolean;
export const DEBUG_BUILD = __BUGSEE_DEBUG__;
```

In **npm builds**, `__BUGSEE_DEBUG__` is rewritten to `(typeof __BUGSEE_DEBUG__ === 'undefined' || __BUGSEE_DEBUG__)` — but **default is `false`** in published artifacts (resolves **[R:sec MINOR-13]**, opposite of Sentry's default). Customers opt INTO debug, not OUT.

In **CDN bundles**, `__BUGSEE_DEBUG__` is replaced with literal `false`; `.debug.min.js` variants get `true`.

Sharp edges (**[R:mod MAJOR-3]**):
- **Terser config**: `compress: { defaults: true, passes: 2, pure_getters: true, drop_console: false, global_defs: { __BUGSEE_DEBUG__: false } }` for the prod build.
- **Source-map fidelity**: degrades on lines with stripped logging; documented as a known limitation.
- **Vite/Next.js dev mode** doesn't run Rollup, so `__BUGSEE_DEBUG__` is undefined → `ReferenceError`. **We ship `@bugsee/vite-plugin` + `@bugsee/webpack-plugin`** that auto-inject `define: { __BUGSEE_DEBUG__: false }`. Without these the customer's dev mode breaks.

### 12.4 Versioning

Changesets, independent per-package versioning. Inter-package version pins:
- `@bugsee/protocol` is **exact-pinned** by every consumer (protocol drift is dangerous).
- Other packages use caret ranges.

Cut a release: `pnpm changeset` → `pnpm version-packages` → `pnpm release`. CI publishes from `main` after tag.

### 12.5 ESM / CJS strategy

- **Tier-0**: **ESM-only** (Node ≥18, all bundlers, all frameworks support ESM). Drops dual-package hazard. Resolves **[R:mod MINOR-12]**.
- **Tier-1 (`@bugsee/core`)**: ESM + CJS (CJS for legacy Node integrations).
- **Platform packages**: ESM + CJS (CJS for users still on `require()`).
- **Framework adapters**: ESM + CJS as needed.
- **Umbrella**: ESM + CJS.

### 12.6 CDN bundle strategy

Mirrors Sentry's actual approach **[R:mod C4]** — two base bundles + per-feature add-ons + shims:

| Bundle | Contents | Gzip budget |
|---|---|---|
| `bugsee.min.js` | core + errors + breadcrumbs + console + fetch | **≤15 KB** |
| `bugsee.full.min.js` | base + network + performance + viewtree (no replay) | **≤45 KB** |
| `bugsee.replay.min.js` | add-on: rrweb-based replay | **≤90 KB** |
| `bugsee.canvas.min.js` | add-on: canvas replay | **≤30 KB** |
| `bugsee.performance.min.js` | add-on (if not using `full`) | **≤20 KB** |

Each gets a `.debug.min.js` sibling. Add-ons register on `window.Bugsee.Integrations`; if the `replay` option is set but the replay add-on script wasn't loaded, the base bundle emits a friendly one-time warning (via `@bugsee/integration-shims`) instead of failing.

**SRI hashes published per release.** Customers use:
```html
<script src="https://cdn.bugsee.com/v1/bugsee.full.min.js"
        integrity="sha384-..." crossorigin="anonymous"></script>
```

Per **[R:sec MAJOR-8]**, Rollup build fails if `eval`/`Function()`/`setTimeout(string)` appears in the bundle (audit step). CSP requirements documented: `connect-src https://*.bugsee.com <signed-upload-host>` — the signed-upload host is `s3.amazonaws.com` or whatever the backend mints (§18 open Q).

### 12.7 CDN loader script + data-attribute init

Per **[R:dx §CDN]**, ship a small loader that supports the common embed pattern:

```html
<script src="https://cdn.bugsee.com/v1/loader.js"
        data-bugsee-token="YOUR_TOKEN"
        data-bugsee-environment="production"
        data-bugsee-app-version="1.2.3"
        async></script>
```

The loader reads `data-*` attributes, lazily fetches `bugsee.min.js`, and calls `launch()`. Captures during the load window are buffered in a small pre-launch queue.

### 12.8 Umbrella subpath strategy

The umbrella `bugsee` package keeps subpath count ≤7 at v1 to avoid Firebase's hand-maintained-225-line `exports` wart **[R:mod MAJOR-7]**:

- `bugsee` (default — runtime-resolved)
- `bugsee/react`
- `bugsee/vue`
- `bugsee/next`
- `bugsee/express`
- `bugsee/types`
- `bugsee/protocol` (escape hatch for advanced consumers)

Framework adapters beyond these stay published as `@bugsee/<framework>` direct packages. A subpath generator is a v1.x consideration.

### 12.9 Distribution security

- **SRI hashes** in CDN release notes and `package.json` `bin` (for `bugsee/loader`).
- **No `eval` / `Function()` / `setTimeout(string)`** audit in Rollup (build fails).
- **TLS-only endpoints**: SDK validates `endpoint` starts with `https://` at `launch()`, allows `http://localhost` for dev, throws `BugseeError` with code `INVALID_ENDPOINT` otherwise.

---

## 13. Testing strategy

**Methodology is binding — see `docs/implementation-standards.md`** (also summarized in `CLAUDE.md`): test-first TDD; a hand-driven **mutator loop** per testable entity (inject bug → confirm test catches it → roll back, ≤10 iterations); integration tests at every class-interaction / cross-package boundary with the same discipline. The table below is the tooling/layer breakdown.

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest, per-package `test/` | Pure-function logic; mocked services |
| Integration (Node) | Vitest spawning real Node processes | http transport, fs storage, AsyncLocalStorage, edge-mode failure paths |
| Integration (browser) | Playwright + Vite fixtures | fetch transport, IndexedDB storage, error handlers, replay |
| Runtime smoke | Per-runtime harness in `dev-packages/{bun,deno,cloudflare,vercel-edge}-tests/` | Real runtime with capture + send-on-capture |
| Wire-format compatibility | Vitest snapshots in `dev-packages/wire-snapshots/` | 30-fixture set per **[R:wire §Fixtures]**: sessions, issues, performance, every file type, all corner cases. **Updating a snapshot requires a commit-message `backend-ref: <PR>` line.** |
| Framework e2e | Verdaccio + 10 fixture apps | Reduced Sentry pattern |
| Bundler tests | `dev-packages/bundler-tests/` | Tree-shake regression detection across 6 bundlers |
| Bundle size | `size-limit` per package with byte budgets (§12.6) | CI-blocking |
| Type tests | `vitest --typecheck` per public-API package | Public types are contract |
| Security tests | Vitest, in `dev-packages/security-tests/` | Sanitizer denylist coverage, error-message scrubbing, token storage location, X-Bugsee-Internal sentinel, callback timeout |
| **Coverage gate** | Vitest + v8 provider, **per runtime** | **100% line, ≥90% branch (CI-blocking)**; exclusions only via annotated `/* v8 ignore */` + justification |
| **Mutation testing** | **Stryker (Vitest runner) — opt-in**, per package | On-demand/nightly audit of test strength; complements the always-on per-entity mutator loop (not a blocking gate) |

---

## 14. Privacy & security

Restructured per **[R:sec §Specific edits]**.

### 14.1 Defaults summary

- Replay defaults fail-closed (§11.2).
- `sendDefaultPii: false` by default; honored at capture time, not just upload (no IP, no full UA, no email auto-harvested).
- Network sanitizer enabled by default with superset denylist + shape regex.
- URL path scrubbing on by default.
- Error-message + stack-trace scrubbing on by default.
- `__BUGSEE_DEBUG__: false` in published artifacts.
- No consent API (§0.5); GDPR-bound customers gate capture by calling `launch()` only after consent and `stop()` to withdraw.
- TLS-only endpoints (refuse `http://` except localhost).
- No cross-tab session sharing in v1.
- Internal logs (`log.internal`) hold event IDs/types only, never event content; bundled only when `debug: true`.

### 14.2 Network sanitizer

See §8.10. Per-stage application: each `NetworkEvent` is independently sanitized (request stage and response stage have separate events sharing an `id`, each gets the full key+shape pass) **[R:wire m9]**.

### 14.3 Error & stack-trace scrubbing

Pipeline order:
1. Match against `ignoreErrors` — drop with outcome `ignored`.
2. Match against `denyUrls` / `allowUrls` — drop with outcome `filtered_url`.
3. Apply shape regex (CC Luhn, SSN, JWT, email, AWS/GCP/Stripe/GitHub patterns) to `error.message`, `error.cause.message`.
4. Apply user-supplied `errorMessageFilter`.
5. Strip `file://` URLs from stack frames; normalize `webpack:///` etc. to friendly paths.

### 14.4 Replay masking

See §11.2. `addSecureView` adds the `bgs-block` class. Documented timing race: call `addSecureView` *before* render or attach the class in markup, per **[R:sec MINOR-18]**.

### 14.5 Deletion API (consent API removed in v3, §0.5)

- Capture is gated by `launch()` / `stop()`; visual capture by `startBlackout()` / `endBlackout()`. There is **no separate consent API** (`grantConsent`/`revokeConsent`/`requireConsent`/`isCapturing` removed — Android parity). For consent-gated apps: call `launch()` only after consent, `stop()` to withdraw.
- `Bugsee.deleteCollectedDataOnDevice(includingIntermediate: boolean): Promise<boolean>` — clears in-memory ring buffers; IndexedDB `__bugsee_*` stores; localStorage/sessionStorage `__bugsee_*` keys; Node `fs` cache dir; pending offline-transport queue. Verified by test fixture.

### 14.6 SDK self-isolation

- `X-Bugsee-Internal: 1` header on every SDK outbound request **[R:sec MAJOR-12]**.
- Network-capture integration filters by this sentinel + by URL prefix matching the configured `endpoint`.
- User callbacks (`setReportHandler` before/after, the typed filters, `setAdditionalDataCapture`, etc.) are wrapped:
  - `try`/`catch`: on throw, drop the event with outcome `before_send_threw`; never propagate.
  - 2 s timeout (configurable) for async callbacks via `Promise.race`; on timeout, drop with outcome `before_send_timeout`.
  - Shape validation via `@bugsee/protocol` schema; on bad shape, drop with outcome `before_send_bad_shape`, warn once.

### 14.7 Token storage

- **Browser**: `access_token` in `sessionStorage` by default (re-acquire on next launch). Optional `persistAccessToken: true` for `localStorage` (advanced; documented risk).
- **Node**: `fs.writeFile` with `mode: 0o600` to an app-token-derived subdir.
- **Workers / Edge**: in-memory only (no persistent storage anyway).
- All keys prefixed `__bugsee_`.
- Tokens never written to `document.cookie`.
- Token reads validate JWT shape; reject malformed values.

### 14.8 Transport hardening

- 5xx + network errors: exponential backoff (start 5 s, max 1 h, jitter ±10%).
- 401: invalidate session, retry once after backoff; **max 3 consecutive 401s** before giving up on that bundle (auth-oracle prevention **[R:sec MINOR-15]**).
- 403 (signed PUT): `uploadDataRenew` once; if still 403, give up with outcome `renew_failed`.
- 12003 (similar crash): drop without retry; outcome `server_dedup`.
- 12004 (too many similar): blacklist signature in memory for the session; subsequent matches dropped client-side.
- `INVALID_APP_TOKEN`: surface via `Bugsee.on('drop', ...)`; no further attempts.
- `KILL_SDK`: enter kill-state; all subsequent captures no-op; one-time `debug.error`.

### 14.9 GDPR / CCPA compliance matrix

| Requirement | Implementation |
|---|---|
| Lawful basis (consent) | Host app calls `launch()` only after consent; `stop()` to withdraw. No SDK-level consent API (Android parity, §0.5). |
| Right of erasure (client cache) | `deleteCollectedDataOnDevice(includingIntermediate)` |
| Data minimization | Sanitizer + replay fail-closed + `sendDefaultPii: false` |
| Storage limitation | `maxRecordingTime` (60 s default) |
| Pseudonymization | Random session ID per launch; `User.id` is customer-set |
| Children's data (COPPA / AADC) | `Bugsee.setIsMinor(true)` forces `sendDefaultPii: false`, max masking, replay disabled |
| Right of access / portability | Out of scope (server-side flow) |

---

## 15. Public API summary

See §7.1 for the full `Client` interface and §9 for `BugseeOptions`. Namespace API (delegating to current Client via the carrier):

```ts
import * as Bugsee from '@bugsee/browser';

Bugsee.launch(token, options): Client;       // synchronous
Bugsee.logException, logUnhandledException, log, event, trace, addBreadcrumb
Bugsee.setUserIdentifier, getUserIdentifier, clearUserIdentifier
Bugsee.setAttribute, getAttribute, clearAttribute, clearAllAttributes, getAllAttributes
Bugsee.upload, showReportDialog, createReport, snapshot
Bugsee.captureViewHierarchy
Bugsee.startBlackout, endBlackout, isBlackout, stop, relaunch, flush, close, isLaunched, getLaunchOptions
Bugsee.deleteCollectedDataOnDevice
Bugsee.addSecureView, removeSecureView
Bugsee.setNetworkEventFilter, setLogEventFilter, setBreadcrumbFilter, setReportHandler, setAdditionalDataCapture, setLifecycleListener
Bugsee.getClient
// performance/APM via the extension (v3, §0.6): Bugsee.ext('performance').startTransaction / startSpan / getActiveSpan
Bugsee.testCrash
Bugsee.registerExt, ext, addCaptureProvider, addDetectionProvider, addIntegration, getIntegration

// REMOVED in v3 (§0.5): captureException, captureMessage, captureEvent, setUser/getUser/clearUser,
// setEmail/getEmail/clearEmail, pause/resume, grantConsent/revokeConsent/isCapturing,
// withScope/withIsolationScope/getCurrentScope/getIsolationScope/getGlobalScope, addEventProcessor.

// interceptors (sources) + capture providers (consumers), re-exported from @bugsee/core / @bugsee/browser
import {
  defineIntegration,            // helper for custom/third-party integrations (addIntegration escape hatch)
  globalErrorInterceptor,
  breadcrumbsProvider,
  fetchInterceptor,
  xhrInterceptor,
  webSocketInterceptor,
  consoleInterceptor,
  networkCaptureProvider,
  viewHierarchyProvider,
} from '@bugsee/browser';
// NOTE (v3): replay is enabled via the `replay` launch option (§0.5); performance/APM is the
// opt-in @bugsee/performance extension reached via ext() (§0.6) — neither is a public integration.
```

### 15.1 Error semantics for user mistakes

| Scenario | Behavior |
|---|---|
| `launch()` called twice with same token | Warn-and-ignore the second call. |
| `launch()` called twice with different tokens | Auto-`relaunch()` with the new token. One-time warning. |
| `launch()` with invalid token | No throw; one-time `console.error`; namespace functions become no-ops. |
| `logException` before `launch()` | Buffered in pre-launch queue (cap 50); drained on `launch()`. |
| `logException` after `stop()` | Silent no-op (matches mobile). |
| Wrong runtime package (e.g. `@bugsee/browser` in Node) | Detected at `launch()`; one-time `debug.error`; namespace functions become no-ops. |
| Network unreachable | Offline transport buffers (where storage available); silent retry on reconnect. |
| `INVALID_APP_TOKEN` from server | Kill-state; no further captures; one-time `debug.error`. |
| Concurrent-request identity on Node servers | Process-global scope in v1 (no `withScope`/isolation, §7.2); document the attribution limitation. |

---

## 16. Capture architecture & extension contract (Android-derived)

This is the **authoritative core architecture**. It reuses the Bugsee Android event-flow design (§0.6) and **supersedes the Sentry-`Integration` framing** wherever §4.1/§7.6/§7.7 still describe it. The goal: a thin kernel with many clean injection points, so replay, performance/APM, view-hierarchy, frustration/anomaly detection, framework adapters, and third-party components all plug in the same way — with little or no friction.

### 16.1 Layered data flow

```
 SOURCES                         HUBS (pub/sub)            CONSUMERS                         OUTPUT
 ───────                         ─────────────             ─────────                         ──────
 NetworkInterceptor   ┐                                ┌─ CaptureProvider<Network> ─┐
   (fetch/XHR/WS,      │                                │   filter+sanitize → entry  │
    http/undici)       │   ┌─────────────────┐         │                            │
 ConsoleInterceptor    ├──▶│ networkEventHub │────────▶├─ DetectionProvider(http)   │   ┌────────────┐
 InputInterceptor      │   │ logEventHub     │         │                            ├──▶│ Aggregator │
 GlobalErrorInterceptor│   │ inputEventHub   │────────▶├─ @bugsee/performance (APM) │   │  (ring)    │
                       │   └─────────────────┘         │   (subscriber only)        │   └─────┬──────┘
 Adapters:             │            ▲                  └─ custom listeners ─────────┘         │
  OperationDispatcher ─┘            │                                                         ▼
  (build-injected /                 │ emit() happens                                  cyclic ring buffers
   framework middleware,            │ REGARDLESS of                                   (per wire file-type,
   OTel adapter)                    │ capture state                                   bounded by maxRecordingTime)
                                                                                              │
 DetectionProvider (crash/frustration/anomaly) ──── triggers ────▶ report assembly ◀──────────┘
                                                                          │
                                                                          ▼  §7.7 trigger path
                                                                   BundleWriter → UploadPipeline
```

**Decoupling invariant:** sources `emit` to hubs unconditionally; the capture pipeline is *one* subscriber. APM and extensions subscribe to the **same** hubs and never touch the capture pipeline. (Android: events are posted to `NetworkEventHub`/`InputEventHub` whether or not capture is active.)

### 16.2 Core primitives (in `@bugsee/core`)

```ts
// pub/sub primitive — mirrors android contracts/common/EventEmitter.java
interface EventEmitter<T> {
  subscribe(listener: (event: T) => void): () => void;   // returns unsubscribe
  unsubscribe(listener: (event: T) => void): void;
  emit(event: T): void;
}

// process-wide hubs (singletons on the carrier; mirror NetworkEventHub/LogEventHub/InputEventHub)
interface EventHubs {
  network: EventEmitter<NetworkEvent>;
  log: EventEmitter<LogEvent>;
  input: EventEmitter<InputEvent>;
  // extensions add hubs via declaration-merge on NameHubMapping
}

// a source that owns runtime hooks and emits to a hub
interface Interceptor { name: string; start(client: Client): void; stop(): void; }

// bridge for external libs / build-time injection; also fans out to its own observers
interface OperationDispatcher {
  registerObserver(o: OperationObserver): () => void;
  onOperation(op: Operation): void;     // called by middleware / injected code
}

// CONSUMER: capture pipeline data source (one per wire file-type)
interface CaptureProvider<T = unknown> {
  name: string;                          // component id  (android @BugseeCaptureComponentName)
  wireFileType: FileType;                // contributes this file to the bundle
  filename: string;
  controllingOption?: keyof BugseeOptions; // e.g. 'captureNetwork' (android @BugseeCaptureControllingOptions)
  start(client: Client): void;           // subscribe to its hub, wire filter+sanitizer
  stop(): void;
  serialize(entries: T[]): Uint8Array | string;   // ring-buffer → bundle file
}

// CONSUMER: decides when to assemble & upload a report
interface DetectionProvider {
  name: string;
  controllingOption?: keyof BugseeOptions;
  start(client: Client, trigger: (hint: TriggerHint) => void): void;
  stop(): void;
}

// feature module — mirrors android contracts/extensions/Extension.java + BugseeExtensions
interface Extension {
  readonly name: string;
  setup(client: Client): void;   // register providers, hub listeners, services, buffers, hooks
  stop(): void;
}
```

### 16.3 Registration seams (the injection points)

Every seam mirrors an Android registration path; all are per-`Client`:

| Seam | API | Android parity | Use |
|---|---|---|---|
| Subscribe to a hub | `client.hubs.network.subscribe(fn)` | `NetworkEventHub.addListener` | APM/extensions/custom code observe events without capture |
| Add a capture provider | `client.addCaptureProvider(p)` | `BugseeCaptureCoordinator.addProvider` | new wire file-type / custom data source |
| Add a detection provider | `client.addDetectionProvider(d)` | `BugseeDetectionCoordinator.addProvider` | custom report trigger |
| Register an operation observer | `client.operations.registerObserver(o)` | `BugseeOperationDispatcher.registerObserver` | APM consumes DB/HTTP/file ops |
| Replace a platform service | `client.addService(name, factory)` | (Service container, §7.4) | storage/transport/clock/encoder swap |
| Register an extension | `client.registerExt(name, ext)` / `client.ext(name)` | `BugseeExtensions.registerExtension` | bundle the above into a feature module |
| Event filter | `client.setNetworkEventFilter(fn)` etc. | `setDataFilter(type, cb)` | transform/drop before buffering |

`NameExtensionMapping`, `NameHubMapping`, and the existing `NameServiceMapping` are declaration-merge targets, so `client.ext('performance')` and `client.hubs.<x>` are typed only when the owning package's types are reachable (same mechanism as §5.2).

### 16.4 Worked example — `@bugsee/performance` as an extension

```ts
// registered via launch({ extensions: [performanceExtension()] }) or client.registerExt(...)
const performanceExtension = (): Extension => ({
  name: 'performance',
  setup(client) {
    client.hubs.network.subscribe(toSpanFromNetwork);          // observe, don't own
    client.operations.registerObserver(toSpanFromOperation);   // db/http/file ops from adapters
    client.addCaptureProvider(performanceCaptureProvider);     // -> performance.json
    // exposes startTransaction/startSpan/getActiveSpan via client.ext('performance')
  },
  stop() { /* unsubscribe all */ },
});
```
When the extension isn't loaded: zero hub subscribers, zero provider, zero `performance.json`, no `/v2/performance/transactions` call — tree-shaken away.

### 16.5 Other extension points (unchanged)

- **Third-party feature packages** publish an `Extension` (`@yourcompany/bugsee-foo`).
- **Framework adapters**: thin wrappers around `@bugsee/browser` (client) / `@bugsee/node` (SSR) that install middleware feeding the `OperationDispatcher` + add error boundaries.
- **OpenTelemetry bridge** (v1.x): `@bugsee/opentelemetry` adapter ↔ OTel spans, as a `DetectionProvider`/observer.
- **Custom transport / storage**: `BugseeOptions.transport` / `BugseeOptions.storage` (power-user service overrides).

---

## 17. What we're explicitly NOT doing in v1

- No `Hub` (Sentry v10 abandoned it).
- No abstract `BaseClient` with platform subclasses (use Services).
- No envelope wire (bundle ZIP is our wire).
- No global `_components` map (per-Client `ServiceContainer`).
- No EAGER service mode.
- No `@bugsee/types` legacy re-export package.
- No prototype monkey-patching at import time (Firebase wart).
- No two-pass Rollup property mangling (Firestore optimization).
- No Lerna, no Karma.
- No OpenTelemetry auto-instrumentation.
- No multi-instance Bugsee clients per process.
- No cross-tab session sharing.
- No end-to-end encryption (`e2e_encrypted` always omitted).
- No React Native (separate SDK).
- No native crash dump / minidump.
- No universal multi-runtime exports matrix on platform packages.
- No `mp4`/`mov` replay format; replay is rrweb-stream only.
- No source-map upload from SDK runtime (CLI workstream).
- No Sentry/Firebase migration guides or compatibility shims — those SDKs are internal design references only, not migration sources (§0.5).

---

## 18. Open questions (consolidated)

### 18.1 MUST resolve with backend before code

> **v3 resolutions (2026-05-25, §0.5):**
> - **#1 `x-client-type` → decided `web`** (not `javascript`). Still verify `web` does **not** take the dashboard cookie-auth path for SDK calls.
> - **#2 `sdk.type` → decided `javascript`** (was `JS`).
> - **#3 `platform.type` → decided to ship the full taxonomy now**; backend must accept all 10 values.
> - **#4 `app_token` → moved to `X-App-Token` header. Done** (confirm exact header name).
> - **#5 Replay → dashboard renders rrweb natively**; backend adds the `replay` file type, frontend adds an rrweb player. No transcode, no wire/video change.
> - **#10 `x-amz-checksum-sha256` → optional for MVP/BETA.**
> Items below still need backend confirmation.

1. **`x-client-type` allowlist.** Confirm **`web`** (v3 decision) is accepted for the JS SDK and does NOT take the cookie-auth path **[R:wire C3]**. (Runtime-specific client-types deferred.)
2. **`sdk.type` value.** Confirm `JS` accepted by dashboards / analytics.
3. **`platform.type` taxonomy.** Confirm `web`/`node`/`bun`/`deno`/`workers`/`edge-light`/`service-worker`/`web-worker`/`electron-main`/`electron-renderer` recognized.
4. **Move `app_token` out of URL query string** to an HTTP header (e.g. `X-App-Token`). Security imperative **[R:sec C1]**.
5. **Replay file type.** Add `replay` to backend `ReportFile`-equivalent schema; add pipeline processor for rrweb; dashboard rendering.
6. **Network `mechanism` and `type` (stage) string acceptance.** Smoke-test JS values don't get rejected by ingestion validators.
7. **`source.type` enum for JS.** Confirm dashboard filter recognizes new values.
8. **`manifest.json.version: 2`.** Concurrent acceptance with mobile's v1.
9. **Sanitizer denylist superset.** Backport JS-added keys (OAuth/JWT/cloud-provider) + shape regex to mobile for server-dedup consistency.
10. **`x-amz-checksum-sha256` enforcement.** Confirm signed URLs minted with `ChecksumAlgorithm=SHA256`.
11. **Attribute size caps.** Align JS-side clamps to actual server-side limits.
12. **`uploadDataRenew` rate limit.** Confirm no server-side cap on renew frequency.
13. **`X-Bugsee-Internal: 1` sentinel header.** Confirm it doesn't trigger any special server behavior; document the contract.
14. **Tunneling support.** v1.x? CSP-strict customers and ad-blockers (≈10% of browser traffic) will block `api.bugsee.com` directly.

### 18.2 Architectural decisions (no external blocker)

15. **Edge-runtime capture mode.** Confirmed: `streaming` mode with single-event bundles per request, wired through `ctx.waitUntil` on Cloudflare/Vercel.
16. **Worker threads in Node.** v1: each worker_thread requires its own `Bugsee.launch()`; no auto-wiring. Document as a known limitation.
17. **Deno permission failures.** Catch + one-time `debug.warn`; never throw at launch.
18. **rrweb in workers.** v1: no — replay is browser/electron-renderer only. Validate in v1.x if needed.
19. **Multi-instance roadmap.** v1 single-instance; `ServiceContainer` is per-Client; no global state outside the carrier slot.
20. **Pre-launch error queue size.** Confirmed: 50 events FIFO.

### 18.3 Build / tooling decisions

21. **Turbo remote-cache provider.** Recommend: Cloudflare R2-backed self-hosted (cheap; we run other Bugsee infra there). Alternative: Vercel free tier.
22. **api-extractor adoption.** Recommend: yes for `@bugsee/browser`, `@bugsee/node`, framework adapters, umbrella.
23. **`@bugsee/vite-plugin` / `@bugsee/webpack-plugin` at v1.** Recommend: yes — without them, Vite/Next.js users get `ReferenceError: __BUGSEE_DEBUG__`.
24. **Umbrella subpath generator.** Recommend: hand-maintain ≤7 subpaths for v1; build generator at v1.1.
25. **`fflate` vendor or depend.** Recommend: depend (~13 KB MIT, well-maintained). Document licensing.
26. **CDN host.** `cdn.bugsee.com`? Coordinate with infra.
27. **License.** **OPEN** — open-source on GitHub like Sentry/Firebase, or proprietary? Affects everything downstream (contribution model, telemetry, license file).

---

## 19. References

- **`/tmp/sdk-research/sentry-report.md`** — Sentry JS SDK v10.52 (~5,500 words, file:line citations)
- **`/tmp/sdk-research/firebase-report.md`** — Firebase JS SDK current `main` (~5,200 words)
- **`/tmp/sdk-research/bugsee-mobile-report.md`** — Bugsee Android + iOS SDK wire protocol + feature inventory (~4,400 words)
- **`/tmp/sdk-research/review-architecture.md`** — Architecture & abstractions review (v1 → v2)
- **`/tmp/sdk-research/review-modularity.md`** — Modularity / tree-shaking / build review
- **`/tmp/sdk-research/review-multi-runtime.md`** — Multi-runtime correctness review
- **`/tmp/sdk-research/review-wire-protocol.md`** — Wire-protocol compatibility review
- **`/tmp/sdk-research/review-dx-api.md`** — DX & public API review
- **`/tmp/sdk-research/review-security.md`** — Security & privacy review
- Bugsee mobile SDKs: `/Users/alexeykarimov/Projects/Bugsee/android/sdk`, `/Users/alexeykarimov/Projects/Bugsee/ios/sdk`
- Closest existing JS reference: `/Users/alexeykarimov/Projects/Bugsee/webview-inject-script`
- Public Bugsee docs: `/Users/alexeykarimov/Projects/Bugsee/docs` (Docusaurus)
- Sentry repo (cloned): `/tmp/sdk-research/sentry-javascript`
- Firebase repo (cloned): `/tmp/sdk-research/firebase-js-sdk`

---

## 20. Changelog v1 → v2

### Structural

- **Renamed `Component` → `Service`** to avoid React collision. `ComponentContainer` → `ServiceContainer`.
- **Split `Transport`** into `BugseeApi` + `BundleUploader` + `UploadPipeline`.
- **Added late service registration** via `client.addService()` with pending-Deferred semantics.
- **Added two capture modes**: `bundle` (default) and `streaming` (edge-mandatory).
- **`launch()` is synchronous**, returns `Client`; added `client.ready: Promise<void>`.
- **Dropped universal multi-runtime exports matrix** on platform packages; only umbrella uses runtime conditions.
- **Added normative rule**: no import-time service registration; `launch()` registers imperatively.

### Wire protocol corrections

- Network `type` (stage) values changed from `start|complete|error|timeout|abort|timing` to **`before|complete|redirect|error|abort|timing|websocket`** (Android canonical).
- WebSocket event sub-type adds **`create`**.
- PUT headers now mirror iOS: **`x-amz-checksum-sha256`** + **`fileName`**.
- `uploadDataRenew` body is **full original `request.json` + overlay**, not just `{uploadDataRenew}`.
- `attrs` lives in **`manifest.json`**, not `request.json`.
- `breadcrumbs` file has **no `.json` extension** (mobile contract).
- Public log level + severity are **string-typed**; numeric only inside `@bugsee/protocol`.
- `manifest.json.version: 2` committed.
- Added JS `environment.hardware` envelope shape.
- `x-client-type: javascript` (NOT `web` — collides with cookie auth).
- Default filename table added in full.

### Security

- Replay defaults **fail-closed**: `maskAllText`/`maskAllInputs`/`blockAllMedia` all `true`; password and `autocomplete="cc-*"` always masked.
- **Error-message + stack-trace scrubbing** added with `denyUrls`/`allowUrls`/`ignoreErrors` + shape regex (CC/SSN/JWT/AWS/Stripe/GitHub).
- **Sanitizer denylist extended** with OAuth/JWT/cloud-provider headers and keys; **shape-based redaction** as second pass.
- **Body sanitizer** now covers `application/x-www-form-urlencoded` and `multipart/form-data`.
- **URL path scrubbing** on by default.
- **`X-Bugsee-Internal: 1`** sentinel on all SDK outbound (SDK never captures itself).
- **`__BUGSEE_DEBUG__` default `false`** in published npm artifacts (was `true` in v1 draft).
- **User callbacks wrapped**: try/catch + 2s timeout + shape validation.
- **GDPR API**: `grantConsent()`, `revokeConsent()`, `deleteCollectedData()`, `isCapturing()`, `requireConsent` option.
- **`access_token` in `sessionStorage`** by default; key prefix `__bugsee_`.
- **TLS-only endpoints** enforced at launch.
- **401 rate-limited** to max 3 consecutive retries (auth-oracle prevention).
- **No cross-tab session sharing** in v1.
- **SRI hashes published** for CDN bundles; `eval`/`Function()` audit in Rollup.

### DX / API

- **20+ public types** now defined in §10 (`Event`, `Breadcrumb`, `Attachment`, `Span`, `Transaction`, `ManualReport`, `UploadResult`, `LifecycleEvent`, `EventHint`, etc.).
- **Duplicate `release?` removed** (was at lines 453 + 511 in v1).
- **Naming convention** locked in §9.1; renamed `networkMonitorIntegration` → `networkCaptureIntegration`, `*Priority` → `*Severity`, `Level` → `LogLevel`/`LogLevelName`.
- **`maxDataSize: 50 MB` → `10 MB`** on browser/edge; 50 MB stays for Node/Electron.
- **Mobile-parity methods added**: `createReport`, `setReportHandler`, `setLifecycleListener`, `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`, `setAttachments`, `captureViewHierarchy` method, `isLaunched`, `testCrash`, `logUnhandledException`, `snapshot`, `clearUser`, `clearEmail`, `setUserIdentifier`.
- **Sentry-to-Bugsee migration map** added (§15.1). *(Removed in v3 — see §21.)*
- **Error semantics table** added (§15.1 in v3).
- **CDN loader script + data-attribute init** specified (§12.7).

### Multi-runtime

- **Cloudflare `nodejs_compat` fallback**: vendor `globalThis.AsyncLocalStorage` shim; never throw at import.
- **`ctx.waitUntil` integration** for Cloudflare/Vercel uploads.
- **Service Workers** get a dedicated **static** bundle variant.
- **Per-runtime Storage matrix** added (§3.4).
- **Async-context table split** Cloudflare from Vercel Edge (different ALS access paths).
- **Capture features × runtime matrix** added (§3.2).

---

## 21. Changelog v2 → v3 (2026-05-25)

Driven by user review against the Bugsee Android SDK. Full rationale in §0.5.

### API unification (Android canonical; Sentry-isms removed)

- Public surface mirrors Android `Bugsee`: `captureException`/`captureMessage`/`captureEvent` → `logException`/`log`/`event`; `setUser`/`setEmail`/`getEmail`/`clearEmail` → `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier`; `pause`/`resume` → `startBlackout`/`endBlackout`/`isBlackout`; `deleteCollectedData()` → `deleteCollectedDataOnDevice(includingIntermediate)`; added `getLaunchOptions()`.
- **Sentry scope model removed** from the public API (`withScope`/`getCurrentScope`/… + `addEventProcessor`). Identity/attributes are process-global; per-request server isolation is a documented v1 limitation (§7.2). AsyncContextStrategy demoted to internal/deferred.
- **`beforeSend` removed** (no Android equivalent) — mutate via `setReportHandler({before})`.
- **Capture hooks moved from options to methods**: `beforeNetworkEvent`/`beforeLogEvent`/`beforeBreadcrumb`/`reportHandler`/`attachments`/`lifecycleListener`/`beforeBundle` → `setNetworkEventFilter`/`setLogEventFilter`/`setBreadcrumbFilter`/`setReportHandler`/`setAdditionalDataCapture`/`setLifecycleListener`.
- **Consent API removed** (`grantConsent`/`revokeConsent`/`requireConsent`/`isCapturing`); gate via `launch`/`stop`. Erasure stays via `deleteCollectedDataOnDevice()`.
- **Replay is option-driven**: `replayIntegration()` removed from the public API; enabled via the `replay` launch option; `@bugsee/replay` lazy-`import()`ed only when truthy.
- **`LogExceptionOptions`** now matches Android `ExceptionOptions`: `{ domain, skipFrames, labels, includeVideo }` (`domain` canonical; `skipFrames` added).
- Sentry→Bugsee migration map **removed entirely**. We do not ship migration guides; Sentry and Firebase are internal design references only, not migration sources. (Error-semantics table is now §15.1.)

### Wire protocol / backend

- **`app_token` moved to `X-App-Token` header** (done; out of the query string).
- **`x-client-type: web`** for v1 (was proposed `javascript`).
- **`environment.sdk.type: "javascript"`** (was `"JS"`).
- **`platform.type` ships the full granular taxonomy** in v1.
- **`x-amz-checksum-sha256` is optional** for MVP/BETA.
- **Replay representation decided**: dashboard renders rrweb natively (new `replay` file type, `replay.bin`); no server-side MP4 transcode; mobile `video` path unchanged.

### Architecture (Android-derived event flow; §0.6, §16)

- **Reuse Android's pub/sub capture architecture** instead of Sentry's woven-in `Integration` model: **sources** (interception coordinators / adapters) `emit` to process-wide **event hubs** regardless of capture state; the **capture pipeline** is one subscriber. Adds `EventEmitter`, event hubs, `Interceptor`/`Adapter`/`OperationDispatcher`, `CaptureProvider`, `DetectionProvider`, `Extension`.
- **Pluggable capture & detection providers** (incl. custom impls): `client.addCaptureProvider` / `client.addDetectionProvider` (Android `addProvider` parity).
- **Extension registry** `registerExt`/`ext` + `Extension` interface (Android `BugseeExtensions` parity); typed via `NameExtensionMapping`.
- **Open hook bus**: `HookName` becomes `keyof NameHookMapping`; extensions declaration-merge their own hooks (no hardcoded `spanStart`/`replayStart` in core).
- **APM fully decoupled** into the opt-in `@bugsee/performance` extension: removed `BugseeApi.uploadPerformance`, `Integration.processSpan`, `spanStart`/`spanEnd` from core `HookName`, `Span`/`Transaction`/`SpanStatus`/`SpanOptions` from core protocol, the `/v2/performance/transactions` ownership, and `performance*` from core `BugseeOptions`. Reached via `ext('performance')`. Zero core footprint when unused.
- **JS adaptations**: cyclic buffers = in-memory ring buffers (persisted via Storage where available); adapters fed by build-plugin injection + framework middleware (no bytecode rewriting).
- `setAttachments` → `setAdditionalDataCapture` (Android parity).
- **Electron deferred to v1.1**; v1 ships stub package.
- **Bun ≥1.1.13** and **Deno ≥1.36** version pins.

### Build / packaging

- **pnpm + Turborepo + Changesets + Rollup (platform) + tsup (tier-0) + swc + Biome + Oxlint + Vitest + Playwright + api-extractor + Turbo remote cache** confirmed.
- **`@bugsee/vite-plugin` + `@bugsee/webpack-plugin`** in v1 scope.
- **CDN bundle plan** rewritten as 2 base + add-ons + shims (Sentry's actual pattern).
- **Byte budgets**: errors-only ≤15 KB gz, full no-replay ≤45 KB gz, replay add-on ≤90 KB gz.
- **ESM-only tier-0**.
- **Bundler-tests fixture** added across 6 bundlers.

---

*End of Draft v2. Open questions in §18 must be resolved with backend before code begins.*
