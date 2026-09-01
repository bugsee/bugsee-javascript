# Capture-API synthesis — the converged, tiered table

Converges `node.md`, `bun-deno.md`, `browser.md` and `frameworks.md` into one decision-ready classification
for the **first beta**. Every claim about the SDK's current behaviour below was re-checked against the repo
(`file:line`) or against a running runtime — the four researchers worked from docs; this pass had the code.

Optimised for **a support engineer debugging a customer's incident**, not for surface area. Rows were
rejected freely: ~110 candidate rows across the four inputs collapse to **8 T1**, 13 T2, 11 T3, and a
rejected list kept so nobody re-proposes them.

## How to read the columns

Schema is `README.md`'s, plus a leading **Tier**:

- **T1 — beta.** High value, low risk, small; or it closes a gap the SDK already half-built or already claims.
- **T2 — post-beta.** Real value, but more work, more risk, or a required spike first.
- **T3 — opportunistic.** Cheap enrichment of something already captured; take it while touching the file.
- **T4 — rejected.** With the reason, kept so it is not re-proposed.

**`Availability` legend** — this column is the single easiest way for this research to waste engineering
time, so it is marked sharply. Four states, and only the first is worth money:

| marker | meaning |
|---|---|
| **PROD** | present and useful in a standard production build |
| **DEV-ONLY** | hard no-op outside a development build — **worth nothing to us** |
| **PROD-ONLY** | exists *only* in production; dev shows something else (the inverse trap) |
| **PROD-DEGRADED** | present in production but the values are useless or wrong — the worst of the four, because it looks like it works |

`Confidence` is carried forward from the source file **unchanged** where this pass did not re-check it. A row
whose confidence this pass **raised** by reading code or running a runtime is marked `verified (this pass)`.

---

## The disagreements, resolved

### 1. `diagnostics_channel` — additive fast path, full replacement, or neither?

**Neither, except for one narrow piece.** The Node researcher recommends the HTTP channels as a replacement
for `http-interceptor.ts` / `http-server-interceptor.ts`; the Bun/Deno researcher found Bun's built-in
channel set incomplete and read that as validating the patch. Both are partly right, and the code settles it:

- **Full replacement is not on the table.** `http.client.request.error` does not exist on Node 18 (present on
  the v20 doc snapshot, absent on v18.20.8 — the Node researcher's own doc-diff), and the SDK declares
  `engines: node >= 18`. Bun does not populate `http.server.*` at all. So the monkey-patch stays regardless —
  a "replacement" would in fact be a **permanent second mechanism**, not a migration.
- **The cost of two paths is the real argument.** Everything hanging off network capture would need a second
  implementation and a second test matrix: bounded body capture, `sanitizeUrl` redaction, span correlation,
  the `additionalSources` seam (`packages/capture/src/install-network-capture.ts`), and the first-owner-wins
  re-entrancy in `packages/node/src/server-instrument.ts` — plus a de-dup guard so a request seen by *both*
  mechanisms is not captured twice. Against a per-package gate of **100% line / ≥90% branch**, a second
  mechanism roughly doubles the network-capture test surface. It buys nothing the patch does not already
  deliver on http/1.
- **The patch is the more portable mechanism, which neither researcher said.** All three runtimes implement
  `node:http`, so `http-interceptor.ts` runs unmodified on Node, Bun and Deno. Channel *population* differs per
  runtime and per version. Portability favours the patch.
- **The one piece worth building is `http2.*`, and it is genuinely net-new — not a replacement.** Verified:
  `packages/node/src/http-interceptor.ts:1-3` imports `node:http` and `node:https` only, so `node:http2` is
  **entirely uncaptured** today. That mostly means `@grpc/grpc-js` traffic is invisible. Build it as a new,
  additive, http2-only source behind the existing `additionalSources` seam, feature-detected on channel
  presence so it degrades to nothing on Bun/Deno. → **T2**, and only the http2 half.

**Verdict: keep the patch as the sole http/1 mechanism on all three runtimes. Do not build an additive
`diagnostics_channel` fast path for http/1. Build the http2 channel family as a separate additive source
(T2).**

### 2. `PerformanceResourceTiming.serverTiming` — the strongest beta candidate, and bigger than it looks

Confirmed, and the framing needs one correction. The gap is real and self-documented at
`packages/performance/src/http-spans.ts:57-66`, verbatim: *"cross-origin its value is readable only via
`PerformanceResourceTiming.serverTiming` + TAO — the deferred passive F3b path."* But **the premise that "the
backend emits the header and sets TAO" is not true by default**:

- `TraceResponseConfig` is documented at `packages/node/src/server-instrument.ts:32-35` as **"BOTH default
  OFF (T9) — there is no consumer until the frontend adapters read them, at which point they flip on."**
  `buildTraceResponseHeaders` (`:161-185`) emits nothing unless `serverTiming`/`traceresponse` are explicitly
  set, and `Timing-Allow-Origin` is emitted only when `timingAllowOrigin` is *also* explicitly configured.
- On the browser side, `collectResourceTiming` (`packages/performance/src/page-load.ts:99-116`) **skips
  `fetch` and `xmlhttprequest` initiators** (`SKIP_INITIATORS`, `:45`) — precisely the entries that would
  carry the header — and reads only `responseStatus`/`transferSize`/`encodedBodySize`/`decodedBodySize`
  (`resourceAttributes`, `:62-69`). It is a one-shot `getEntriesByType` at page-hide, not an observer.

So the work is three things, not one: read the field, flip the backend defaults on (which T9 already
anticipates), and add a `resource` observer path for fetch/xhr entries that the pageload collector
deliberately skips. Still **T1 and still the top item** — it is the only thing here that changes an
already-claimed capability from "works same-origin, silently does nothing cross-origin" to "works" — but it
is a ~2 day item, not a one-line field read.

### 3. Deno's built-in OTel — nothing to do; the conflict does not exist

The premise ("`@bugsee/opentelemetry` calls `setGlobalTracerProvider`") is **false**. Verified by grep across
all package sources: `@bugsee/opentelemetry` contains no `setGlobal*` call at all. It exports a
**`SpanProcessor` the user registers on their own provider** (`packages/opentelemetry/src/span-processor.ts:6-12`).

The only `setGlobalTracerProvider` in the repo is `packages/nextjs/src/otel-provider.ts:50,83`, and it is
already **first-wins by explicit design** (`:8-11`, `:83-93`): if the global slot is occupied it does not
clobber, it emits a coexistence notice and returns `'existing-provider'`. `OTEL_DENO=1` self-registers the
providers → the slot is taken → the SDK already defers. Correct behaviour, already shipped, no change.

Outbound propagation cannot collide either: `packages/capture/src/traceparent.ts:147` never overrides an
existing `traceparent` header, so whichever of Deno-OTel and the SDK runs first, the other defers.

**The only real residue is duplication in the customer's own collector**, not in the Bugsee bundle: with
`OTEL_DENO` on, `console.*` is exported as OTLP log records *and* captured by the SDK's console interceptor
as `log`. That is the customer's configuration choice and costs Bugsee nothing.

**Verdict: coexist silently. Do not detect, do not defer, do not warn** — warning about a valid customer
configuration is noise. Document the console double-export in the Deno docs. → **T4** for "detect and
defer/warn"; nothing to build.

### 4. The dev-only trap, both directions

Enforced through the `Availability` legend above. The four DEV-ONLY seams (React `<Profiler>` without
`react-dom/profiling`, Vue `app.config.performance` / `warnHandler`, Solid `DEV.hooks`, Svelte 5 `$inspect`)
are all **T4** — they are worth exactly zero in a production app, and Solid's is the strictest (`DEV` is
`undefined` in production and server bundles with no flag to force it on).

The inverse and the degraded cases are called out just as loudly, because they are the ones that get built by
mistake:

- **PROD-ONLY:** `error.digest` — the real message/stack are stripped *in production only*, so a developer
  testing the integration in dev sees a working message and never notices the digest is the only join key
  that survives to a real user's client-side boundary.
- **PROD-DEGRADED:** React's `__REACT_DEVTOOLS_GLOBAL_HOOK__` fires in production but reports
  `actualDuration: 0` for every fiber — present, callable, and useless. And, found by this pass and not by any
  researcher, **`performance.eventLoopUtilization()` on Bun and Deno** (see Corrections §2).

---

## The merged table

### T1 — beta

| Tier | API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| T1 | `PerformanceResourceTiming.serverTiming` (+ flip `TraceResponseConfig` defaults on, + observe `resource` entries for fetch/xhr) | Baseline since Mar 2023, all engines; cross-origin needs `Timing-Allow-Origin` | `[{name, duration, description}]` — the `traceparent;desc="00-…"` the backend already knows how to emit | field on the existing `resource` stream | EXISTING `http.client` span — adds the backend span id cross-origin, closing F3b | One `resource` observer callback per fetch/xhr entry; ~0.6 KB gzip | **PROD** (needs the customer's own TAO header; SDK emits it once `timingAllowOrigin` is set) | Backend-controlled `description`; TAO exposes the customer's full resource timing to the listed origins — recommend an explicit origin list, never `*` | verified (this pass) — `http-spans.ts:57-66`, `server-instrument.ts:32-55,161-185`, `page-load.ts:45,62-69,99-116` |
| T1 | Loaded-**package** list, deduplicated, as a `ReportSnapshotSource` — Bun: `require.cache`; Node/Deno: `require.cache` ∪ a brief `Debugger.enable`→`disable` pull | Node ≥18 / Bun / Deno, all in-process, no CLI flag | `[{name, version, count, native?}]` — which version of X was really loaded, **duplicate copies of one package**, native `.node` addons | snapshot (report-time pull) | **NEW** FileType — OTel-wise a resource-attribute set, not a span | **1.8 KB gzip** in the bundle. Pull: **free on Bun**, ~11–18 ms on Node, ~8 ms on Deno, once per report | **PROD** all three | Absolute paths leak usernames and internal project names — **the proposal emits no paths at all** (see Privacy) | verified (this pass, measured on Node 24.15 / Bun 1.4.0 / Deno 2.9.5) |
| — | Full module **tree** (parent/child edges) | same | adds parent edges | snapshot | — | **~10–11.5 KB gzip, ~6× the flat list** — and the edges exist for **CJS only**, so the tree is structurally incomplete on any ESM app | — | — | **→ T4, rejected** |
| T1 | `LargestContentfulPaint.element`/`.url`/`.size` + `LayoutShift.sources[].node` | LCP 4-engine since Safari 26.2 (Dec 2025); `layout-shift` Chromium-only | The LCP candidate element and its image URL/size; which nodes shifted and by how much | field on entries already observed | EXISTING `web_vital.lcp.*` / `web_vital.cls.*` — turns a number into a finding | Zero new observers — the entries are already retained and never read; ~0.5 KB gzip (reuses `describeTarget`) | **PROD**; CLS attribution Chromium-only (unchanged from today) | **Live `Element` references — must route through `describeTarget` + `isSensitiveInput`, never `outerHTML`.** LCP `url` through `normalizeResourceUrl` | verified (this pass) — `lcp.ts:41`, `cls.ts:52`, `page-load.ts:143-150` |
| T1 | Event Timing `processingStart` / `processingEnd` | Chrome 92+, Firefox 140ish, Safari 26.2+ — same entries already observed | Splits an interaction into input delay / processing / presentation delay | field on entries already observed | EXISTING `interact` emitter + INP — answers "busy main thread or slow handler" | Two more field reads on a running observer; ~0.1 KB gzip | **PROD** (self-skips where absent, already) | None beyond today — `target` already goes through the masked `describeTarget` | verified (this pass) — `browser/src/interaction-source.ts:96-110` |
| T1 | `securitypolicyviolation` (`SecurityPolicyViolationEvent`) | Baseline all 4 engines since Oct 2018; plain DOM event, no header or permission | `blockedURI`, `effectiveDirective`, `sourceFile`, `lineNumber`, `disposition`, `sample` | event | **NEW** breadcrumb — "a script from evil.example was blocked by your CSP" | One `addEventListener`; fires only on an actual violation; ~0.3 KB gzip | **PROD** — cleanest availability story in the whole document | **`sample` is the first 40 chars of the inline violator — if the violation is an XSS attempt that is injected user data. Drop `sample` by default** | verified (absence confirmed this pass by grep across all package sources) |
| T1 | System-metrics enrichment: `v8.getHeapStatistics().heap_size_limit` + `process.constrainedMemory()` + `process.resourceUsage()` context switches / page faults — **Node and Deno only, NOT Bun** | Node ≥18.15 for `constrainedMemory`; heap stats + `resourceUsage` on ≥18 | "You are at 94% of `heap_size_limit`" and "the cgroup cap is 512 MB", vs today's bare `heapUsed` | sample | EXISTING `traces.system` — the difference between "heap crept up" and "you are about to be OOM-killed" | Node 0.19 µs, Deno 0.19 µs per call. **Bun 69 ms per call at a 127 MB heap — see Corrections §5** | **PROD**; `constrainedMemory` gated at Node ≥18.15 | None | verified (this pass, measured) |
| T1 | `process.on('warning')` | Node ≥6, Bun, Deno — Stable | `name` (`MaxListenersExceededWarning`, `DeprecationWarning`, …), `message`, `code`, `stack` | event | **NEW** breadcrumb — Node's own "this is probably a bug" signal, invisible today | Negligible; fires only on a real Node-detected issue | **PROD** | Low — mostly Node-internal text, occasionally an app path in the stack | verified (absence confirmed this pass) — `packages/node/src/detection-providers.ts` handles only `uncaughtException`/`unhandledRejection` |
| T1 | React `onRecoverableError` root option | React DOM ≥18, standard `createRoot`/`hydrateRoot` option | React's synthesized recoverable error + `errorInfo.componentStack`; fires on hydration mismatch | event | EXISTING React error path — adds `mechanism: hydration-mismatch` classification | Negligible; ~0.1 KB | **PROD** (unlike `<Profiler>`) | Component stack may echo rendered content — same class as the already-shipped handlers | verified (this pass) — `packages/react/src/handlers.ts:16-33` returns only `onUncaughtError`/`onCaughtError` |

### T2 — post-beta

| Tier | API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| T2 | `diagnostics_channel` `http2.client.stream.*` / `http2.server.stream.*` as a NEW additive source | Node; channel Stability 1 – Experimental; **v18 floor not verified** | `id`, `bytesRead`/`bytesWritten`, `timeToFirstByte`, `timeToFirstHeader` | event | **NEW** — `node:http2` is entirely uncaptured today (mainly `@grpc/grpc-js`) | Publish-gated (zero unsubscribed); `bodyChunkSent` gives wire bytes → must reuse the existing size cap | **PROD** Node only; feature-detect → nothing on Bun/Deno | Body chunks are the actual wire bytes — reuse `maxBodySize` | documented, NOT v18-verified (carried forward from `node.md`) — verified absence: `http-interceptor.ts:1-3` |
| T2 | Nitro `request` + `beforeResponse` hooks | Nitro ≥2.x, **node AND edge presets** | Paired → a real `http.server` span with a genuine duration on edge | event pair → span | Closes the SDK's OWN documented v2 gap for `@bugsee/nuxt` on edge | Low; two hook subscriptions | **PROD**; per-preset firing behaviour needs a real spike (Cloudflare vs Netlify Edge) | Headers must go through redaction; never buffer the response body | verified (gap) this pass — `packages/nuxt/src/nitro-edge.ts:10-11,65`; hook behaviour `documented` |
| T2 | Angular `Router` events — `GuardsCheckStart↔End`, `ResolveStart↔End`, `RouteConfigLoadStart↔End`, `NavigationError` | `@angular/router` ≥4.1, standard; zoneless-safe | Guard / resolver / lazy-chunk spans; `shouldActivate:false` = blocked by a guard; `NavigationError` carries route `url` + target snapshot | event pairs → spans | **NEW** child spans under the navigation transaction; `NavigationError` is a strictly better error source than the bare `ErrorHandler` | Low — the Router already fires these | **PROD** | Route URLs may carry path params — same class as the existing route-naming seam | documented (field shapes not re-fetched); gap verified this pass — `packages/angular/src/router.ts:55-64` reads the snapshot for naming only |
| T2 | SvelteKit `beforeNavigate`→`afterNavigate` and Astro `astro:before-preparation`→`astro:page-load` as timed span pairs | SvelteKit ≥1.0; Astro ≥3.6 **with `<ClientRouter />` active** | A real client route-transition duration, start to visible-and-loaded | event pair → span | **NEW** — today `afterNavigate` only renames the transaction | Low — two listeners per framework | **PROD**; Astro's chain fires only on View-Transitions sites | Route pattern only | documented; gap verified this pass — `packages/svelte/src/router.ts:31-32` |
| T2 | Remix / React Router `middleware` + `clientMiddleware` | React Router ≥7.9 (stabilized); **app must opt in** | One span bracketing the whole loader/action tree of a navigation | event → span | **NEW** — the data-loader span; today `instrumentReactRouter` only renames | Low — one wrapper around `next()` | **PROD**, but requires the app to enable middleware and add the export | Never read `context` or loader results — time only | documented |
| T2 | `PerformanceObserver({type:'gc'})` — **Node and Deno only** | Node ≥8.5, Stable | `startTime`, `duration`, `detail.kind` (major/minor/incremental) | event | **NEW** `gc.pause` metric — correlates against the ANR watchdog and event-loop-lag samples | No documented overhead caveat | **PROD** Node; **Bun never emits `gc` entries** (Bun's own compat doc) → hard-branch, do not ship a metric that is silently always-empty | None | verified (Node fields); Bun non-emission `documented` |
| T2 | `net`/`tls` enrichment on outbound spans — `socket.on('lookup')`, `tlsSocket.isSessionReused()`/`getProtocol()`/`getCipher()`, `.authorized`/`.authorizationError`, `bytesRead`/`bytesWritten` | Node ≥18 (all long-stable) | Per-request DNS time, TLS version/cipher, session-resumption, cert-expiry as a *reason*, real wire bytes | sample on an existing event | EXISTING `network` — turns "ECONNRESET" into "the peer cert expired 3 days ago" | Free — property reads and events that already exist | **PROD** on Node; needs a Bun/Deno socket-shape check | Capture `authorized`/`authorizationError` only — **never the full `getPeerCertificate()` by default** | verified (Node docs) |
| T2 | `process.report.getReport()` on fatal error | Node ≥11.8, Stable | pid/versions/cmdline, JS + native stack, `resourceUsage`, **the full libuv active-handle table**, `sharedObjects` | snapshot | Enriches EXISTING `crash` — Node's own structured "what did the process look like" | Synchronous, but crash-only so irrelevant | **PROD** | **`environmentVariables` is literally `process.env` — must be filtered before upload; stacks can carry argument values** | verified |
| T2 | `worker.on('error')` / `'exit'` + `worker.performance.eventLoopUtilization()` / `worker.resourceLimits` | Node ≥18 (ELU ≥15.1; `getHeapStatistics`/`cpuUsage` are ≥22.16/24 — out of reach on the 18 floor) | An uncaught throw *inside a worker* (invisible today); per-worker loop utilization; the worker's own configured OOM ceiling | event / sample | **NEW** — main-thread `uncaughtException` capture does not span into workers | Negligible | **PROD** Node; **Bun's per-worker ELU is a stub** and Deno's `worker_threads` is partial | Error message/stack from inside the worker | verified (Node); Bun/Deno gaps `documented` |
| T2 | `PerformanceObserver({type:'long-animation-frame'})` (LoAF) | Chrome/Edge 123+; no Firefox commitment, no Safari | Per-script attribution: `sourceURL`, `sourceFunctionName`, `sourceCharPosition`, `invoker`, `blockingDuration`, `forcedStyleAndLayoutDuration` | stream | **NEW** enrichment layer *alongside* the existing `ui.long-task` span — never a replacement | Low — fires only on janky frames | **PROD**, Chromium-only | `sourceURL`/`sourceFunctionName` reveal bundle structure — not end-user PII, but a customer may consider it proprietary | verified (fields) + verified compat |
| T2 | `navigator.storage.estimate()` | Baseline since Sep 2023; secure context only | `{usage, quota, usageDetails}` | slow sample (once per session) | **NEW** `traces.system` — self-diagnostic: is the SDK's own IndexedDB buffer near the origin quota, or is the app's? | Async, cheap — session cadence, never the 1 s tick | **PROD**, secure context | Aggregate byte counts only | verified |
| T2 | Passthrough `TransformStream` via `pipeThrough()` on captured response bodies | Streams Baseline all engines | Byte-level throughput, chunk count, and **inter-chunk gaps** (stall detection mid-stream) | derived stream | EXISTING `network` — distinguishes "server slow to compute" from "stream stalled at 60%" | **One microtask hop per chunk** — real, scales with chunk count | **PROD** | Record sizes and timestamps only, never chunk content | documented (design proposal on verified mechanics) |
| T2 | Reporting API **`crash`** report type + `window.crashReport` | Chromium-only, WICG stage, shipped-version unverified | `body.reason` (`oom`/`unresponsive`) + pre-registered key-value context, **delivered after JS is dead** | server-delivered event | **NEW** — the browser analogue of the Electron minidump harvest already built (NM1–NM5) | Requires a `Reporting-Endpoints` header and a new Bugsee collector endpoint | Chromium-only; needs site-operator infrastructure | Delivered by the browser's own POST — **bypasses the SDK's bundle pipeline, redaction filters and auth**. That is an architecture decision, not a footnote | documented, shipped-status **unverified** — **design spike only, do not schedule a build** |

### T3 — opportunistic

| Tier | API | Where | Yields | Shape | Maps to | Cost | Availability | Privacy | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| T3 | `PerformanceResourceTiming.nextHopProtocol` | Baseline all engines | `h2`/`h3`/`http/1.1` — detects protocol downgrades | field | EXISTING `resource.*` attrs | Free — same entries already iterated | **PROD** | None | verified |
| T3 | `.deliveryType` / `.renderBlockingStatus` | Chrome 117+ / 107+ only | served-from-cache; did this resource block first paint | field | EXISTING `resource.*` attrs | Free | **PROD**, Chromium-only | None | verified |
| T3 | `pageshow.persisted` → `page.bfcache_restore` breadcrumb, + `navigation` entry `.notRestoredReasons` | `persisted` universal; `notRestoredReasons` Chromium-only | The restore itself as a recorded fact; *why* bfcache was denied (`unload-listener`, `cache-control:no-store`, …) | event / field | **NEW** breadcrumb; the listener already exists (`onBFCacheRestore`) and only resets vitals today | Negligible | **PROD** / Chromium-only for the reasons | None — capability facts | verified |
| T3 | `process.resourceUsage()` `involuntaryContextSwitches` / `majorPageFaults` | Node ≥12.6, Stable; works on Bun and Deno | "the OS is starving this process" — a signal no current metric carries | sample | EXISTING `traces.system` | 0.27 µs measured on all three | **PROD** | None | verified (this pass, measured) |
| T3 | `v8.getHeapSpaceStatistics()` old-space vs new-space — **Node and Deno only** | Node ≥6, Deno ≥2 | Explains "leaking" vs "big working set" | sample | EXISTING `traces.system` | Node 0.80 µs, Deno 1.29 µs. **Bun: same heap-walk trap as `getHeapStatistics` — exclude** | **PROD** Node/Deno | None | verified (this pass, measured) |
| T3 | SvelteKit `afterNavigate` → `navigation.type` | SvelteKit ≥1.0 | `'enter'`/`'link'`/`'goto'`/`'popstate'`/`'form'` — **already on the object the adapter receives and thrown away** | field | EXISTING nav naming — tags hydration-entry vs a real transition | Free, the field is in hand | **PROD** | None | verified |
| T3 | `rejectionhandled` | Same engines as `unhandledrejection` | A rejection previously reported as unhandled later got a `.catch()` | event | Noise *reduction* — annotate/suppress a crash entry that was retracted | Negligible | **PROD** | None | verified (absence confirmed this pass) |
| T3 | Bun `server.requestIP(req)` / `pendingRequests`; Deno `ServeHandlerInfo.remoteAddr` / `completed` | Bun ≥1.0 / Deno ≥1.x, per-runtime | Client remote address without header parsing; live in-flight counts; **`completed` catches client-side aborts** | event / sample | EXISTING `network` on the native serve wraps | Negligible | **PROD**, runtime-specific | Client IP is PII in some jurisdictions — same class the node path already handles | documented |
| T3 | React `<Profiler>` `phase` third value | React DOM, already built | `phase` carries `mount`/`update`/**`nested-update`** — the current span distinguishes two | field | EXISTING render span | Free | **DEV-ONLY** in effect (`<Profiler>` needs `react-dom/profiling`) — take it only while touching the file | None | documented — `packages/react/src/profiler.ts:30,115` |
| T3 | Next.js OTel span relabeling (`next.span_type` → friendly ops) | Next.js, already flowing through `otelConsume` | `Render.getServerSideProps` presented as "data loader" rather than a raw internal name | mapping table | EXISTING consumed spans — presentation, not capture | Zero marginal — the spans already flow | **PROD**; the full catalog needs `NEXT_OTEL_VERBOSE=1` | Route/page attrs are patterns, not raw params | verified |
| T3 | `socket.autoSelectFamilyAttemptedAddresses` | Node ≥18.18 | The dual-stack addresses attempted, read once post-hoc | snapshot | EXISTING `network` — the Happy-Eyeballs retry story, cheaper than the per-attempt events (which need Node ≥20.12) | Free — one property read | **PROD** Node ≥18.18 only | IP addresses attempted | verified |

### T4 — rejected

| Rejected | Why — kept so it is not re-proposed |
|---|---|
| `diagnostics_channel` as an http/1 replacement or additive fast path | Two permanent mechanisms, doubled test surface against a 100%-line gate, no data the patch lacks. Resolved above. |
| `async_hooks.createHook` | Node's own docs say migrate away ("usability issues, safety risks, and performance implications"); process-global side effects the SDK cannot scope to itself; **non-functional stubs on both Bun and Deno**. No runtime where it pays. |
| `trace_events` | File-based (`node_trace.*.log` for `chrome://tracing`), no live in-process delivery; unavailable in worker threads. `diagnostics_channel` gives the same underlying data as live objects. |
| `inspector.Network.*` | A **publish** API for reporting activity *into* an attached DevTools client — the inverse of an observation hook. Named to be misread; recorded so nobody reaches for it twice. |
| `process.on('uncaughtExceptionMonitor')` | Proposed as a "better source". The code already considered and declined it, with a reason: `packages/node/src/detection-providers.ts:13-14` — the SDK needs the *listening* event to get an async window to flush before exit. The monitor cannot provide it. |
| Heap snapshots as anything default-on (`v8.writeHeapSnapshot`, `inspector` `HeapProfiler`, `Bun.generateHeapSnapshot`) | Documented to block the event loop and need ~2× the live heap in memory, and the output contains **every live string in the process** — tokens, request bodies, session data. Only defensible as an explicitly user-triggered, permission-gated, report-time source. |
| `tlsSocket.on('keylog')` | Yields the key material needed to decrypt the customer's traffic. Never, under any option. |
| `module.register()` loader hooks for module-load timing | Structurally mistimed: hooks must be registered before the modules they observe load, and `launch()` runs from inside app code. (Note: this objection does **not** apply to a report-time read of an existing registry — see the module-list section.) |
| `process.execve` channel | Payload includes the full environment being exec'd into, for an API almost never invoked in real Node code. High sensitivity × near-zero applicability. |
| `v8.queryObjects(ctor, {format:'summary'})` | Forces a full GC for an accurate count, and `summary` yields object field values. Node ≥20.13 anyway. |
| `performance.measureUserAgentSpecificMemory()` | Requires COOP + COEP cross-origin isolation. **Any** unopted third-party ad, widget, analytics tag or iframe breaks isolation for the whole page — most real customer sites cannot meet it. Keep `performance.memory` as the practical default; its "deprecated" label is not an action item. |
| React `__REACT_DEVTOOLS_GLOBAL_HOOK__` | **PROD-DEGRADED**: fires in production but `actualDuration` is `0` for every fiber. Plus a whole-fiber-tree walk per commit, plus explicit "may break production apps" warnings from the tools that use it. |
| Vue `app.config.performance` / `app.config.warnHandler`; Svelte 5 `$inspect`; Solid `DEV.hooks`/`writeSignal`/`registerGraph`; Angular `ng.getComponent()`/`ng.profiler` | **DEV-ONLY** — hard no-ops in production. Solid's is the strictest: `DEV` is `undefined` in production and server bundles with no flag to force it on. Worth exactly nothing to a shipped app. |
| Angular `NgZone.onStable`/`onUnstable`/`onMicrotaskEmpty` as a change-detection span | Production-viable but a real **production tax**: a span on every interaction, timer and XHR in a zone-patched app, and it never fires under zoneless (default from Angular v21). Wrong risk profile for a beta. |
| Pinia `$subscribe`/`$onAction`, Vuex `subscribe`/`subscribeAction`, `svelte/store` `.subscribe` | The payload is **raw application state**. Cannot be default-on under the SDK's obscure-by-default rule, and an opt-in that ships raw state is a support liability, not a feature. `$onAction`'s *timing* (name + duration, never args or result) is the only defensible subset — revisit post-beta. |
| Next.js `fetch [method] [url]` OTel span | Duplicates the SDK's own network capture **and carries the full unscrubbed query string**, where the native path already applies `sanitizeUrl`. Consuming it is a privacy regression, not an improvement. Recommend `NEXT_OTEL_FETCH_DISABLED=1`. |
| `OTEL_DENO` as a capture *source*, and detect/defer/warn logic for it | No documented way to tap Deno's internal OTel pipeline in-process (no `Deno.telemetry` read-back). And there is nothing to defer from — the SDK never registers a global provider (Disagreement 3). |
| `ReadableStream.tee()` for throughput measurement | Independently buffers both branches, measurably altering the app's memory and backpressure timing — violates the binding "interceptors must not alter application behaviour" rule. `pipeThrough` does not. |
| Soft Navigation Heuristics | Chrome-only, origin-trial-gated — not deployable to arbitrary end users. `navigation-source.ts` already solves SPA route detection without a token. |
| `SharedWorker` as a capture-buffer redesign | **Chrome for Android does not support SharedWorker on any version.** Non-starter for a mechanism meant to be session-critical on mobile web. |
| Element Timing (`elementtiming="…"`) | Requires the customer to annotate their own markup per element, Chromium-only. Real but a rounding error in audience. |
| `PerformanceObserver({type:'visibility-state'})` | Chromium-only, adds only timeline-coordinate convenience over the `visibilitychange`/`pagehide` listeners already in `web-vitals/observe.ts`. |
| `scheduler.postTask`, `isInputPending`, `requestIdleCallback` | Not capture APIs. Genuinely useful for making the SDK's *own* background work less disruptive — that belongs in an implementation-quality backlog, not here. |
| Navigation API `navigate`→`navigatesuccess` as a timed pair | Compat claim `unverified` in the source, **and** the pair only completes for navigations the app routes through `navigateEvent.intercept()` — which React Router, Next and most others do not; they use `history.pushState`. It would fire for a minority of real apps. |
| `bun:sqlite` statement introspection | Supplies labels but no timing and no hooks — a real span still needs the SDK to wrap `.run()/.all()/.get()`. Narrow audience (direct `bun:sqlite`, not an ORM). |
| Bun `--cpu-prof` | Launch-time CLI flag with no programmatic start/stop. The existing `node:inspector` rolling profiler is strictly better on Bun and already ships. |
| Astro island hydration timing; SvelteKit `handleFetch`; Nuxt `vue:error`; Angular `NgZone.onError`/`NavigationCancel`; React `startTransition`/`<Suspense>`/`use()`; Solid `<Suspense>` lifecycle | Each is a confirmed **negative finding**: either no public seam exists at all (Astro islands, Solid Suspense, React transition timing) or it duplicates an already-wired seam with narrower coverage (`handleFetch`, `vue:error`, `NgZone.onError`). |
| Full module **tree** (parent/child edges) rather than the flat package list | Measured: **~10–11.5 KB gzip vs 1.8 KB** for the flat list — 6× the bytes for a rarer question. And on Node and Deno the parent edges exist **only for CJS**, so the tree silently omits every ESM edge. A tree that lies by omission is worse than no tree. |
| `process.moduleLoadList` as a module inventory | Measured: **builtins-only on Node** (253 entries, zero userland) and a **permanently-empty stub on Bun and Deno** (`count: 0`). Its name promises an app-module registry; it is not one. |
| Bun `node:inspector` for anything; `Bun.plugin` as a passive module observer | Measured: with `inspector.open()`, Bun accepts `Debugger.enable` and delivers **zero** `scriptParsed` events (0 even for modules loaded after enable); `Runtime.evaluate` returns `-32601 not found`. `Bun.plugin`'s `onLoad` cannot return `undefined` — a passive observer would have to take over loading the file. Bun's `require.cache` is complete anyway. |
| Leaving `Debugger.enable` on for the session | Measured **+39–43% on the throw path** (+82–86% with `pauseOnExceptions`), which for an error-reporting SDK is the worst possible hot path to tax. Steady-state hot code is free (−0.5%), so the folklore about deopt is out of date — but the throw tax settles it: brief report-time pull only. |

---

## Ranked T1 — what to build for the beta

**Ranking principle:** value to a support engineer *debugging an incident*, tie-broken by cost. That
deliberately puts "an incident class we cannot see at all" above "a performance metric we report without
attribution" — the audience the brief names is a support engineer, not a performance consultant. Sizes are
honest estimates **including** test-first work and the 100%-line / ≥90%-branch gate, which for this codebase
is typically half the total effort.

### 1. `serverTiming` passive read — make cross-origin distributed tracing actually work (~2 days)

**What the span carries.** The existing `http.client` span gains `bugsee.backend_span_id` (and therefore
joins to the backend's `http.server` transaction) **for cross-origin requests**, which is the common
deployment shape: SPA on `app.example.com`, API on `api.example.com`. Today that join silently does not
happen and nothing says so.

**Packages touched.** `@bugsee/performance` (read `serverTiming` off a matched `resource` entry in
`http-spans.ts`; add a `resource` observer for fetch/xhr initiators that `page-load.ts` skips),
`@bugsee/node` (flip `TraceResponseConfig.serverTiming` + a sane `timingAllowOrigin` default — the T9 comment
already anticipates exactly this), docs.

**Why first.** It is the only item here that converts a capability the SDK **already claims** from
half-working to working. Everything else adds a stream; this one stops a shipped feature from lying.

### 2. Loaded-package list at report time — the flat list, not the tree (~3 days)

**What it carries.** A deduplicated `[{name, version, count, native?}]` resource-attribute set answering, at
crash time: which version of X was actually loaded, which packages have **two copies** in one process (a
classic, near-invisible bug class), and which native `.node` addons were present. None of it is recoverable
from a lockfile, because the lockfile is not what the process loaded. **1.8 KB gzipped** for a realistic
189-package express + mongoose + babel app — 4.6% of the viewtree's 38.8 KB.

**Packages touched.** `@bugsee/protocol` (new FileType + `upload-contract.schema.json` — a drift test enforces
the pair), `@bugsee/node` (a `ReportSnapshotSource` appended at `packages/node/src/launch.ts:570-573`,
alongside the CPU-profile source that already lives there), with a per-runtime branch for the pull.

Full evidence, per-runtime mechanism and the rejection of the tree: the section below.

### 3. `securitypolicyviolation` (~half a day)

**What the breadcrumb carries.** `blocked_uri`, `effective_directive`, `disposition`, `source_file`,
`line_number` — an entire incident class ("a third-party script was blocked by your CSP and the checkout
button stopped working") that the SDK cannot see today and that otherwise requires the customer to go dig
through a separate CSP report dashboard. Best cost-to-value ratio in the document: four engines since 2018,
one `addEventListener`, zero cost until a violation actually fires.

**Packages touched.** `@bugsee/browser`.

### 4. `process.on('warning')` (~half a day)

**What the breadcrumb carries.** `MaxListenersExceededWarning` (a leaking `EventEmitter` — a real
production-degradation cause), deprecation and experimental warnings, each with `code` and `stack`. Node's own
"this is probably a bug" channel, currently thrown on the floor. Same shape of win as #3: an existing signal
the runtime already computes, that we simply do not listen to.

**Packages touched.** `@bugsee/node` (`detection-providers.ts`).

### 5. System-metrics enrichment, **Node and Deno only** (~1 day)

**What the sample carries.** `heap_size_limit` (so "heap used" becomes "94% of the ceiling"),
`constrainedMemory` (the cgroup cap — the number that actually predicts an OOM kill in a container, which
`os.totalmem()` cannot give), and involuntary context switches / major page faults ("the OS is starving this
process"). Measured cost: 0.19–0.80 µs per call on Node and Deno at the existing 1 s cadence.

**Packages touched.** `@bugsee/node` (`system-metrics.ts`), plus a **runtime branch excluding Bun** — see
Corrections §5, this is not optional.

### 6. LCP element + CLS source attribution (~1 day)

**What the metric carries.** `web_vital.lcp.element` (`img.hero`, via `describeTarget`), `.url`
(`normalizeResourceUrl`-scrubbed), `.size`; and for CLS, up to 5 masked selectors of the nodes that shifted
with their shift distance. "CLS regressed to 0.31" becomes "`.ad-slot` shifted 120 px when a late ad loaded."

**Packages touched.** `@bugsee/performance` only. The raw entries are **already retained** in `metric.entries`
(`lcp.ts:41`, `cls.ts:52`) and simply never read (`page-load.ts:143-150` stamps `.value`/`.rating` and stops).
No new observer, no new dependency — `describeTarget` and `isSensitiveInput` are already in the browser graph.
Ranked below the four above because it is performance polish, not an unseen incident class.

### 7. INP sub-parts (~half a day)

**What the span carries.** `input_delay_ms`, `processing_ms`, `presentation_delay_ms` on the existing
interaction. That is the actual answer to the question every slow-interaction ticket asks: was the main
thread busy before the handler ran, or was the handler itself slow?

**Packages touched.** `@bugsee/browser` (`interaction-source.ts:96-110` — two more field reads on an observer
already running), `@bugsee/performance` (`interactions.ts` attributes).

### 8. React `onRecoverableError` (~half a day)

**What the report carries.** `mechanism: hydration-mismatch` plus the component stack, distinguishing "React
recovered from an SSR mismatch" from every other error. **Honest scope note:** React's default
`onRecoverableError` calls `console.error`, and the SDK's console interceptor already captures that — so these
are probably landing in `log` today, unclassified and un-reported. The value is classification and a real
report, not net-new visibility. That is still worth half a day for the single most common SSR-era incident
class, but it should not be sold as a new capability.

**Packages touched.** `@bugsee/react` (`handlers.ts` — extend `createBugseeErrorHandlers`'s return),
`@bugsee/nextjs` (pass it through).

---

## The loaded-module list — measured, then tiered

Evaluated as a first-class candidate at the product owner's request. **Verdict: T1 as a flat deduplicated
package list; the module tree is rejected (T4).** All numbers below were produced by running real code on
**Node 24.15.0 / Bun 1.4.0 / Deno 2.9.5** against a real 189-package app (express, mongoose, @babel/core,
winston, pg, axios via CJS `require`; nanoid, p-limit via static ESM `import`; axios again via dynamic
`import()`), not from docs.

### What is actually reachable, per runtime

| | complete inventory? | is it a tree? | ESM covered? | cost of the pull |
|---|---|---|---|---|
| **Node** | `require.cache` **∪** a brief `Debugger.enable` pull | CJS only | **only via the inspector** | ~11–18 ms per pull (88 ms on the very first, cold) |
| **Bun** | `require.cache` **alone — complete** | **yes, a full tree** | **yes** | free (in-memory read) |
| **Deno** | `require.cache` **∪** a brief `Debugger.enable` pull | CJS only | **only via the inspector** | ~8 ms per pull |

**Node.** `require.cache` is a genuine parent/child graph — 804 entries, 791 with `.parent`, 2172 child edges
— but it is **CJS-only**: `nanoid`, `p-limit`, `yocto-queue` and the dynamically-imported `axios` ESM files
were all absent, as was the entry module itself. It missed **104 of 907** loaded files in this app, and that
fraction rises with how ESM-first the app is. `process.moduleLoadList` **exists but is builtins-only** (253
entries, zero userland) — a dead end, not the undocumented app-module registry it sounds like. There is **no
public ESM registry**: `process.binding('module_wrap')` is undefined and `internal/modules/esm/loader` throws
`ERR_UNKNOWN_BUILTIN_MODULE`. `Module._pathCache` is a *resolution* cache (things resolved, not things
loaded).

**`Debugger.scriptParsed` is the only complete answer on Node, and the Node researcher's objection to loader
hooks correctly does not apply to it** — because `Debugger.enable` **replays every already-parsed script**,
and delivers them *synchronously inside the `post` callback*: 1037 events, 0 arriving after the tick. 1108
scripts total vs `require.cache`'s 804, each carrying `url`, `hash`, `length`, `isModule` and `sourceMapURL`.
Flat, no parent edges.

**Bun is the surprise: `require.cache` alone is complete and richer than Node's** — 911 entries covering ESM
*and* builtins, with a real tree (778 parents, 2134 child edges). One gotcha worth writing into the
implementation: `Object.keys(entry)` returns only `["exports","require"]`; `id`/`filename`/`parent`/`children`
live on the **prototype** as accessors, so a naive `Object.keys` / spread / `JSON.stringify` silently loses
everything. Bun's `node:inspector` is a shell — with `inspector.open()` it accepts `Debugger.enable` and then
delivers **zero** `scriptParsed` events, and `Runtime.evaluate` is not implemented. `Bun.plugin` cannot be
used as a passive observer (`onLoad` must return a value, i.e. take over loading).

**Deno.** `require.cache` works via node compat but is CJS-only (289 entries, no ESM, no builtins), and
`process.moduleLoadList` is a permanently-empty stub. **No `Deno.*` API enumerates the module graph** —
`Deno.emit`/`bundle`/`moduleGraph`/`loadedModules` are all undefined, and of the 376 internal ops none walks
the graph. But `node:inspector` **does** work and does replay: 634 scripts, full CDP fields, a strict superset
of `require.cache` (353 node_modules files vs 289 — the extra 68 are the ESM ones).

### The `Debugger.enable` cost question — answered, and it changes the design

The concern was that `Debugger.enable` historically inhibited V8 optimisations. Measured (7 trials,
interleaved OFF/ON/OFF, medians, two independent runs):

| workload | OFF | ON | delta |
|---|---|---|---|
| mixed numeric + string + object | 46.4 ms | 46.2 ms | **−0.5%** (run 2: +0.6%) |
| code freshly `new Function`-compiled and re-JIT'd *while* the debugger was on | 27.4 ms | 27.2 ms | **−0.9%** |
| **200k throw/catch** | 154.9 ms | 215.6 ms | **+39.2%** (run 2: +43.0%) |
| 200k throw/catch with `setPauseOnExceptions:'uncaught'` | 154.9 ms | 288.8 ms | **+86.4%** |

**Modern V8 does not deopt on `Debugger.enable` alone** — steady-state hot code is free, even code JIT'd while
enabled. The old folklore is out of date. But the **throw path costs ~40%**, because every `throw` must be
reported to the debugger. For an *error-reporting* SDK that is exactly the wrong hot path to tax.

So the design is settled by measurement: **do a brief `enable`→`disable` at report time and never leave the
Debugger on.** Repeated 5×, each pull delivered all 1037 scripts in 11–18 ms with a 0.2 ms disable; Deno
settles at 8.0–8.5 ms. Two implementation constraints: use a **separate `inspector.Session`** from the one
`cpu-profiler.ts` drives (different domain, and a profile may be in flight), and **guard for a real attached
debugger** — an in-process `Debugger.enable` will collide with one.

Resolving each module path to a package `name`+`version` requires reading `node_modules/<pkg>/package.json`
(the directory name is not the manifest name, and the version is nowhere in the path). Measured at
**17–22 µs/package**: ~3–5 ms warm for this app's 168 package dirs, ~104 ms warm even for a pathological
4674-dir walk. Cache it once per process; it is not a report-time concern.

### Size — the tree does not earn its bytes

| form | raw | gzip |
|---|---|---|
| **flat `[{name, version, count}]`** | 8,525 B | **1,808 B** |
| flat `[{name, version}]` | 6,869 B | 1,636 B |
| full tree, index+parent tuples, root-relative paths | 52,772 B | 10,520 B |
| full tree, `{i,p,f}` with absolute paths | 180,514 B | **11,540 B** |
| *(for scale)* the existing `viewtree` at 2000 nodes | — | ~38.8 KB in-bundle |

Two things decide it:

1. **The tree costs ~6× the flat list gzipped** (≈10–11.5 KB vs 1.8 KB) for information a support engineer
   rarely needs. "Which version of X was loaded" and "are there two copies of X" — the two questions that
   motivated this — are both answered **entirely by the flat list**. The tree answers "who required X", which
   is a different and much rarer question.
2. **The tree is structurally incomplete on Node and Deno.** Parent edges exist only in `require.cache`, i.e.
   only for CJS. The 104 ESM files in the test app have no parent at all. Shipping a "module tree" that
   silently omits every ESM edge is worse than not shipping one — it invites the reader to conclude a package
   was not required when it was.

**Reject the tree.** On Bun, where a complete tree is free and available, it is still not worth 6× the bytes
for a per-runtime-inconsistent artifact.

### The redaction proposal

The list form makes this easy, because **it emits no paths at all**:

- **Package rows** carry `name` and `version` read from the manifest — never the path they were found at.
- **Application code** (anything not under a `node_modules` boundary) collapses to a single aggregate row,
  `{name: "(application)", count: N}`. No filenames, no directory names, no per-directory counts — directory
  names are exactly where internal project codenames live.
- **Builtins** aggregate to one row or are dropped.
- **Native addons** set `native: true` on the package that owns the `.node` file — the package name is already
  being emitted, so this adds no exposure.

*What does this tell an attacker who reads a report?* The customer's server-side dependency inventory and
versions — i.e. which published CVEs might apply. That is genuinely useful to an attacker, and it should be
said plainly rather than waved away. Three things make it acceptable:

1. It is **strictly less sensitive than what a Bugsee report already carries** — stack traces, request URLs,
   log lines, and (on Node) `process.env`-adjacent context. Anyone who can read the report already has far
   more.
2. The *new* exposure the naive version would add — `/Users/jane.doe/work/project-codename/…` — is closed
   completely by emitting no paths.
3. **Finding, worth acting on separately:** the SDK **already leaks those absolute paths today**, through
   crash stack frames. `scrubFramePath` (`packages/core/src/stack.ts:21-29`) strips the `file://` scheme and
   normalises `webpack://`, but **keeps the full absolute path**. So today's Node `crash.json` already ships
   `/Users/jane.doe/work/project-codename/node_modules/express/lib/router/index.js`. If the username leak is
   worth closing — and under the obscure-by-default rule it is — the fix belongs in `scrubFramePath` (relativise
   to `process.cwd()`, or truncate at the `node_modules` boundary), not in this feature. That is a separate,
   small, and arguably more valuable privacy item than the module list itself.

### Known limitation

`reportSnapshots` is explicitly **not used by capture-recovery** (`packages/core/src/client.ts:257-262`), so a
crash rebuilt at next launch carries no module list. For a DOM viewtree that is correct by design; for a
module list a next-launch read would actually be approximately right. Not worth solving in the beta — note it,
and if it matters later, persist the list once at launch alongside the capture generation.

---

## Corrects an existing claim or gap

Everything here was checked against the code or a running runtime.

### 1. `CLAUDE.md`'s Deno-profiling "correction", made today, is itself wrong — and the runtime proves it

`CLAUDE.md:21` now states: *"**Deno does NOT get CPU profiling** — `node:inspector`'s Profiler domain is a
non-functional stub there."* That was taken from `bun-deno.md`, which cites Deno's compat page, not a run.

Run on the installed **Deno 2.9.5**:

```
Profiler.enable -> {"err":null,"r":{}}
Profiler.start  -> {"err":null,"r":{}}
Profiler.stop err -> null   nodes: 10  samples: 34     # Node control: nodes: 5  samples: 29
```

`node:inspector` `Profiler` **works on Deno 2.9** and returns a real CPU profile. `docs/PROGRESS.md:168`
("**Full support incl. diagnostics on Deno 2.8+** (verified)") is the accurate statement, and `CLAUDE.md` now
contradicts it. Two further doc-sourced Deno rows in `bun-deno.md` are also stale as of 2.9:
`perf_hooks.monitorEventLoopDelay` **works** (mean/max/count all populated), and `v8.writeHeapSnapshot`
**works** (the source says it throws). The researcher's Deno rows describe an older Deno.

**Action: revert the `CLAUDE.md:21` claim** (it is in project instructions, so it will keep propagating), and
state the floor precisely — profiling degrades on Deno **2.0–2.7** and works from 2.8. Not edited here: this
task is scoped to `docs/research/capture-apis/`.

### 2. NEW — `performance.eventLoopUtilization()` silently reports **zero** on Bun and Deno, and the guard does not catch it

Measured on the same 200 ms wait, all three runtimes:

| runtime | `eventLoopUtilization()` |
|---|---|
| Node 24.15 | `{"idle":200.64,"active":2.35,"utilization":0.0116}` |
| Bun 1.4.0 | `{"idle":0,"active":0,"utilization":0}` |
| Deno 2.9.5 | `{"idle":0,"active":0,"utilization":0}` |

`guardedElu` (`packages/node/src/guarded-system-metrics.ts:68-84`) guards against a **throw** — it does not
guard against a stub that returns plausible zeros. So the SDK ships an `event_loop_utilization` trace reading
a flat `0` on Bun and Deno, forever. That is **worse than a missing metric**: a support engineer reading a Bun
session sees 0% event-loop utilization and concludes the process was idle while it was in fact saturated.
This is the **PROD-DEGRADED** category, found in our own shipped code.

**Fix (small, and it belongs in the beta):** probe once at sampler construction — take two ELU readings around
a known-busy tick; if the delta is exactly `{idle:0, active:0}`, **omit the metric** rather than emit zero.

### 3. NEW — `monitorEventLoopDelay()` values are not comparable across runtimes

Same idle 200 ms wait, `resolution: 10`, mean delay:

| runtime | mean |
|---|---|
| Node 24.15 | 10.86 ms |
| Bun 1.4.0 | 0.99 ms |
| Deno 2.9.5 | 0.0144 ms |

Three implementations, three semantics, one metric name. Any threshold, alert or viewer heuristic on
`event_loop_lag` is **runtime-specific** and must be documented as such. This is a data-quality caveat on a
stream the SDK already ships, not a proposal.

### 4. The F3b gap is confirmed, and larger than described

Confirmed verbatim at `packages/performance/src/http-spans.ts:57-66`. Two things the framing missed:

- **The backend does not emit the header by default.** `packages/node/src/server-instrument.ts:33-35`:
  *"BOTH default OFF (T9)."* `buildTraceResponseHeaders` (`:161-185`) emits nothing unless explicitly enabled,
  and `Timing-Allow-Origin` only when `timingAllowOrigin` is *separately* configured. So today cross-origin
  tracing does not silently fail because the browser cannot read the header — it fails because **nothing sends
  it**. Both halves are needed.
- **The browser's resource collector skips exactly the right entries.** `SKIP_INITIATORS`
  (`packages/performance/src/page-load.ts:45`) drops `fetch` and `xmlhttprequest`, and
  `collectResourceTiming` is a one-shot `getEntriesByType` at page-hide (`:99-116`), not an observer. A
  passive read needs a new `resource` observer path.

### 5. NEW — the Bun/Deno researcher's #2 recommendation is a serious performance trap on Bun

`bun-deno.md` top-5 #2 claims `node:v8` `getHeapStatistics()` is "the one `node:v8` API the SDK can call
identically on Node, Bun, and Deno without a runtime branch." It is *supported* on all three. It is not
*free*, and the cost scales linearly with live heap — measured:

| live heap | Node | Bun |
|---|---|---|
| ~1–5 MB | 0.5 µs | 394 µs |
| ~20–52 MB | 0.3 µs | 16.9 **ms** |
| ~127–199 MB | 0.4 µs | **69 ms** |

Bun's JSC shim walks the heap to synthesize V8-shaped stats. At the SDK's 1-second `traces.system` cadence
with a 127 MB heap that is **69 ms of main-thread block every second — a ~7% sustained stall**, growing with
the app's heap. Shipping this on Bun would be precisely the "beta that regresses production" the brief warns
against.

It needs a **runtime branch — the exact opposite of the claimed benefit.** T1 item 6 is therefore scoped
Node + Deno only. (Checked: the *existing* sampler is unaffected — `process.memoryUsage()` on Bun is a flat
0.5 µs at any heap size.)

### 6. The Nuxt edge path is incomplete — confirmed, in our own words

`packages/nuxt/src/nitro-edge.ts:10-11`: *"Full per-request context/trace correlation on edge needs Nitro
fetch-entry wrapping — a documented v2."* Only the `error` hook is wired (`:65`). The node path (`nitro.ts:69,90`)
wires `error` + `render:html` and leans on the `node:http` emit-patch, which does not exist on edge presets.
The Nitro `request`/`beforeResponse` proposal targets exactly this gap — **T2, gated on a per-preset spike**
(the researcher could not confirm hook firing on Cloudflare vs Netlify Edge, and marked it so).

### 7. `node:http2` is entirely uncaptured

`packages/node/src/http-interceptor.ts:1-3` imports `node:http` and `node:https` only. Confirmed: an app whose
traffic goes over `node:http2` — in practice `@grpc/grpc-js` — is invisible to network capture. The `http2`
`diagnostics_channel` family is the only additive thing in that whole proposal worth building.

### 8. Two researcher proposals the code already considered and declined

- **`uncaughtExceptionMonitor`** as a "better source": `packages/node/src/detection-providers.ts:13-14` states
  the SDK deliberately uses the *listening* event because it needs the async window to flush before exit. The
  monitor cannot provide one. Not an improvement.
- **The OTel global-provider conflict** does not exist: `@bugsee/opentelemetry` never registers a global
  provider, and the one place that does (`packages/nextjs/src/otel-provider.ts:83-93`) is already first-wins.

### 9. Confirmed absent, so the "not currently captured" claims hold

Grep across all package sources (hits only in `node_modules`): `securitypolicyviolation`, `rejectionhandled`,
`ReportingObserver`, `navigator.storage.estimate`, `measureUserAgentSpecificMemory`, `notRestoredReasons`,
`long-animation-frame`. Also confirmed: `packages/react/src/handlers.ts:16-33` returns only
`onUncaughtError`/`onCaughtError`; `packages/angular/src/router.ts:55-64` reads the router snapshot for
naming and subscribes to no router events; `packages/svelte/src/router.ts:31-32` uses `afterNavigate` for
renaming only.

### 10. NEW — the SDK already ships the customer's absolute filesystem paths, in every crash

Found while designing the module-list redaction. `scrubFramePath` (`packages/core/src/stack.ts:21-29`) strips
the `file://` scheme and normalises `webpack://`, but **keeps the full absolute path**. A Node `crash.json`
therefore already carries frames like:

```
/Users/jane.doe/work/project-codename/node_modules/express/lib/router/index.js
```

That is the OS username, the home-directory layout, and often an internal project codename, in every crash
report, today. Under the SDK's own "obscured to the maximum extent possible by default" rule this is a real
gap. The fix is small and local — relativise to `process.cwd()`, or truncate at the `node_modules` boundary
and keep the package-relative remainder, which is what a symbolicator wants anyway. **Arguably a better
privacy item than anything proposed in this document**, and it is a correction to shipped behaviour rather
than a new capture stream.

### 11. A minor retention note found while checking LCP

`lcp.ts:41` assigns `metric.entries = [entry]`, so a **live LCP `Element` reference is retained for the life
of the page** even though nothing ever reads it (`page-load.ts:143-150`). Harmless today, but if T1 item 3 is
built the extraction should happen in the callback and the entry should be dropped — do not start reading
`metric.entries` later without also releasing the node.

---

## Privacy

The SDK's rule is that privacy-relevant data is obscured to the maximum extent possible **by default**. Under
that rule the candidates split three ways.

### Must be masked before they can ship

| Candidate | Exposure | Required treatment |
|---|---|---|
| LCP `element`, CLS `sources[].node`, Element Timing `element` | All three hand back a **live `Element`**. Reading `outerHTML` (or a naive selector build) would leak exactly the DOM content that `SENSITIVE_INPUT_MATCHERS`, `describeTarget` and replay blackout exist to protect | Route through the **single existing definition** — `describeTarget` (`packages/browser/src/input-source.ts:124-146`) + `isSensitiveInput` (`packages/core/src/sensitive-input.ts:67`). Never restate the matcher list. CLAUDE.md names this exact failure mode ("three copies once drifted apart and a card field went unmasked") |
| LCP `url` (the hero-image URL) | Query-string tokens on signed CDN image URLs | `normalizeResourceUrl` (`page-load.ts:55-60`) — it strips query and fragment outright, which is stronger than `sanitizeUrl` here. Use it |
| `securitypolicyviolation.sample` | First 40 chars of the inline violator. If the violation **is** an XSS attempt, `sample` contains attacker-injected content, which may itself contain exfiltrated user data | **Drop `sample` by default.** Ship `blockedURI`, `effectiveDirective`, `disposition`, `sourceFile`, `lineNumber` — that is the whole diagnostic value. Make `sample` an explicit opt-in with a documented caveat |
| Loaded-module/package list | Absolute paths leak the OS username, home-directory layout, and internal project/codename directories | **Emit no paths at all** — `name`+`version` from the manifest, application code aggregated to one `(application)` row. Detail and the attacker analysis in the module-list section |
| **ALREADY SHIPPING — crash stack frames** | `scrubFramePath` (`packages/core/src/stack.ts:21-29`) keeps the **full absolute path**, so today's `crash.json` carries `/Users/jane.doe/work/project-codename/node_modules/…` | Relativise to `process.cwd()` or truncate at the `node_modules` boundary. **This is a correction to shipped behaviour, not a new-feature gate** — see Corrections §10 |
| `process.report.getReport()` | **`environmentVariables` is literally `process.env`** — the single densest concentration of secrets in a Node process. `javascriptStack`/`nativeStack` can carry argument values | Filter `environmentVariables` to an allowlist (or drop it) before upload; treat stacks with the same policy as existing crash capture. If the filter cannot be built confidently, ship the report *without* the env section |
| `child_process`/`Bun.spawn` argv | `spawn` options carry the full argv, and secrets passed as CLI arguments are common | Capture the executable and argv **count**, not argv values, unless run through the redaction pipeline |
| LoAF `sourceURL` / `sourceFunctionName` | Not end-user PII, but reveals bundle structure and third-party script internals a customer may consider proprietary | No masking needed for end-user safety; disclose it in the docs so a customer can opt out |
| `Timing-Allow-Origin` (the backend half of T1 #1) | Setting `TAO: *` exposes the customer's **full resource timing** to every origin on the page, not only to Bugsee | Default to an explicit origin list derived from the configured frontend origin. **Never default to `*`**; if a customer sets `*`, that is their call, made explicitly |
| Bun `requestIP` / Deno `remoteAddr` | Client IP is PII in several jurisdictions | Same policy the node path already applies to `req.socket.remoteAddress` — do not introduce a second one |

### Should never ship

- **`tlsSocket.on('keylog')`** — the key material to decrypt the customer's traffic. No option, no gate.
- **Any heap snapshot as a rolling or sampled source** (`v8.writeHeapSnapshot`, `inspector` `HeapProfiler`,
  `Bun.generateHeapSnapshot`). A snapshot contains every live string in the process. Defensible only as an
  explicitly user-triggered, permission-gated, report-time source — the same posture as the Electron pixel-video
  gate — and even then it should be off by default and loudly documented.
- **Pinia / Vuex / `svelte/store` subscription payloads** — raw application state. `$onAction`'s *timing*
  (name + duration, never `args` or `result`) is the only defensible subset.
- **The Next.js `fetch` OTel span** — carries the **full unscrubbed query string**, where the SDK's own
  network capture already applies `sanitizeUrl`. Consuming it is a strict privacy regression.
- **`v8.queryObjects(..., {format:'summary'})`** and **`process.execve`'s `env`**.

### Already safe, no work needed

`measureUserAgentSpecificMemory`'s `attribution[].url` is coarsened to a `cross-origin-url` sentinel by spec
(moot — the API is rejected on isolation grounds). `notRestoredReasons`, `pageshow.persisted`, GC entries,
`process.on('warning')`, `resourceUsage`, heap statistics and `storage.estimate` carry no user data at all.

---

## Cost

Measured baselines, so the budget is real rather than asserted.

### Bundle size — browser

Built `dist/index.js`, gzipped:

| package | raw | gzip |
|---|---|---|
| `@bugsee/browser` | 52.1 KB | **15.4 KB** |
| `@bugsee/core` | 89.6 KB | 23.7 KB |
| `@bugsee/capture` | 47.5 KB | 10.9 KB |
| `@bugsee/performance` | 36.5 KB | 9.5 KB |
| `@bugsee/protocol` | 22.5 KB | 7.3 KB |
| `@bugsee/util` | 5.9 KB | 2.1 KB |
| concatenated tier | — | **66.1 KB** |
| `@bugsee/webview` IIFE (a real tree-shaken, self-contained browser build) | 86.6 KB | **30.2 KB** |

The 30.2 KB IIFE is the honest reference for what lands in a customer's page. Estimated additions for the
four browser T1 items:

| item | est. gzip | why it is that small |
|---|---|---|
| `serverTiming` read + `resource` observer | ~0.6 KB | one observer, one parse, reuses the existing `traceparent` parser |
| LCP/CLS attribution | ~0.5 KB | `describeTarget` + `isSensitiveInput` + `normalizeResourceUrl` are **already in the graph** |
| INP sub-parts | ~0.1 KB | two field reads and two attribute writes |
| `securitypolicyviolation` | ~0.3 KB | one listener, one entry builder |
| **total** | **~1.5 KB gzip** | **≈ +5% of the shipped IIFE, ≈ +2% of the concatenated tier** |

Nothing in T1 pulls a new dependency. The items that *would* move this needle are all T2 or T4: LoAF (a new
observer and a script-attribution mapper), Streams `pipeThrough`, and the Reporting-API `crash` path.

### Runtime overhead — browser

- **Zero new `PerformanceObserver` instances** for LCP/CLS attribution and INP sub-parts. Every one of those
  fields rides an observer that is already running and whose entries are already retained. This is the
  cheapest category of work in the document: reading data the SDK already holds and throws away.
- `securitypolicyviolation` is one `addEventListener` on `document` that never fires on a healthy page.
- The **one** T1 item with a real implementation choice is `serverTiming`. The pageload collector's one-shot
  `getEntriesByType('resource')` at page-hide is not enough (it skips fetch/xhr and stops at page-hide), so a
  `resource` `PerformanceObserver` filtered to fetch/xhr initiators is the clean answer: one callback per
  matched resource entry, no polling, no `getEntriesByName` scan of the whole buffer.
- Not adopted, and worth saying why: `tee()` (alters backpressure — violates the binding
  interceptors-must-not-alter-behaviour rule), Angular `NgZone` CD spans (a span per interaction, timer and
  XHR), React's DevTools hook (whole-fiber-tree walk per commit).

### Runtime overhead — server (measured, µs/call, at the existing 1 s sampler cadence)

| call | Node 24.15 | Bun 1.4.0 | Deno 2.9.5 |
|---|---|---|---|
| `process.memoryUsage()` *(already shipped)* | 0.55 | 0.40 | 0.65 |
| `process.resourceUsage()` | 0.27 | 0.25 | 0.26 |
| `process.constrainedMemory()` | 0.013 | 0.008 | 0.026 |
| `v8.getHeapStatistics()` | 0.19 | **2 663 → 69 000 (scales with heap)** | 0.19 |
| `v8.getHeapSpaceStatistics()` | 0.80 | **2 770 (same trap)** | 1.29 |

The whole T1 server enrichment costs **~1.3 µs per second on Node and Deno** — unmeasurable. On **Bun the same
code costs up to 69 ms per second and grows with the app's heap**, so it must be branched off. That single
measurement is the most consequential cost finding in this document, and it inverts a top-5 recommendation.

`process.on('warning')` costs nothing until Node itself detects a problem.

### Bundle payload size

The `serverTiming` value adds ~60 bytes to a span that already exists. LCP/CLS attribution adds ~200 bytes per
page-load transaction (one element descriptor plus a capped list of shift sources — cap it at 5). CSP
violations are event-driven and rate-limited by the existing capture-storm limiter (100 / 60 s). The flat
package list measures **1.8 KB gzipped** for a realistic 189-package server app.

None of these approach the `viewtree`'s ~38.8 KB at 2000 nodes, which remains the largest single artifact in a
bundle. Total T1 bundle-payload cost, server-side: **~1.9 KB gzipped per report** — under 5% of one viewtree.

### The one item with a real report-time cost

The module-list pull blocks for **~11–18 ms on Node and ~8 ms on Deno** (free on Bun), once per report, on
the report-assembly path. That is the same class of cost as the existing report-time DOM viewtree walk, and
`ReportSnapshotSource` already supports async sources which the assembler awaits
(`packages/core/src/client.ts:193-201`). The one place to watch it is the `uncaughtException` flush-before-exit
window, where 15 ms comes out of the flush budget — measure it against the configured flush timeout before
shipping, and skip the pull if the budget is already tight.
