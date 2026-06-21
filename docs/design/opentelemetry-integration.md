# OpenTelemetry integration — design & roadmap note

**Status:** agreed direction (2026-06-10), validated via a brainstorming session + competitor research.
Supersedes the bare "v1.x bridge" mentions in `sdk-design.md` (§73/§103/§1529/§1630/§1646). This is a
**design + sequencing** note — the workstream is slotted *after* the current `@bugsee/performance`
follow-ups (node-perf wiring, bundle `performance.json`); nothing is built yet. Read with the memory
`performance-apm-extension-plan` and `interceptors-must-not-alter-app-behavior`.

---

## Understanding summary

- **What:** a pluggable `@bugsee/opentelemetry` adapter giving **two-way OTel interop** — *consume* the
  user's OTel spans, *produce* Bugsee transactions as OTLP, and *propagate* W3C trace-context for
  end-to-end frontend↔backend traces — over a **runtime-portable mapping core** + per-runtime adapters,
  with OTel dependencies isolated as **peers** and **never piercing core/perf**.
- **Why:** meet customers where their observability already is (export to their backend, ingest their
  existing instrumentation) and deliver true distributed traces — the Next.js / SSR story (one trace
  spanning browser → server).
- **Who:** customers running an OTel pipeline (collectors, OTLP backends — Honeycomb/Tempo/Datadog/NR/
  Elastic) who want Bugsee data in it and/or their OTel spans in Bugsee; and anyone wanting frontend↔
  backend trace correlation.
- **Constraints:** features are **pluggable extensions** (Android-derived thin-kernel rule) — OTel must
  not pierce core or perf; it consumes only public seams. OTLP/HTTP-**JSON** is the v1 wire. Greenfield
  (Android has no OTel) — JS leads.
- **Non-goals (v1):** our own auto-instrumentation (Consume covers it), an OTel-API facade, OTLP
  protobuf/gRPC, being an OTLP *receiver*, async transformers, browser-Consume (deferred for bundle cost).

## Assumptions

- Design/sequence now, **build later** (after the current perf follow-ups).
- OTLP/HTTP-JSON suffices for v1; Consume is **Node-first** (OTel's home; browser carries the ~60 KB
  OTel-web bundle cost, so browser-Consume is opt-in later).
- Propagation is **opt-in, allowlist-gated, same-origin default**; capture stays observe-only.
- Not Android-parity — JS leads; Android may follow.

---

## Decision log

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| **D1** | OTel support is **two-way** (produce + consume) | export-only; ingest-only; correlation-only; facade-only | User wants Bugsee both to feed OTel backends and to ingest existing OTel instrumentation. |
| **D2** | A **runtime-portable mapping core** (Span↔OTel) + thin per-runtime adapters | node-first; browser-first | Mirrors the core/capture/perf runtime-adapter split; build the mapping once. |
| **D3** | **Hybrid boundary:** SDK-level *Consume* (`SpanProcessor`/`SpanExporter`) + lightweight OTLP/HTTP-JSON *Produce*; OTel deps isolated as **peers** in the adapter | SDK-level both ways (Sentry-pure); OTLP-wire both ways (no OTel dep) | The two precedents that share our shape (Sentry, Faro) both bridge this exact way; consuming wants the SDK, producing is light. |
| **D4** | Scope = **Consume + Produce + Propagation**; OTel-API facade **deferred** | include the facade | Facade is ~90% redundant with Consume; Sentry ships none. YAGNI. |
| **D5** | Principle **refined**: *capture* interceptors stay observe-only; propagation is a distinct, explicit, opt-in capability | keep the principle absolute (no propagation); drop it entirely | Distributed tracing inherently needs header injection; make it deliberate + scoped, not silent. |
| **D6** | **Interception transformers** — a general, **sync**, opt-in mutation seam on interceptors (lives in `@bugsee/capture`/`InterceptorBase`); the propagation transformer is its first consumer | a tracing-specific "request-decoration write seam" | Generalizes the mutation capability cleanly; OTel stays a pure consumer of a public seam. |

---

## Design references (studied, never copied — `sdk-design-references-not-migration`)

The two precedents that match Bugsee's shape (an SDK with its **own** model + OTel) both **keep their
model and bridge at the edges** — neither rips it out to become OTel-native (only pure-OTel rebuilds like
Embrace do that, which we can't, given Android parity):

- **Sentry JS (error+perf, own model)** — on **Node**, OTel *is* the tracing substrate: it registers
  `SentrySpanProcessor` + `SentrySampler` + `SentryPropagator` on the user's `TracerProvider`, converts
  each ended OTel span to a Sentry transaction at the processor boundary, and ships its **own** envelope
  (no OTLP-out from the SDK). OTel packages are **peerDependencies**, isolated in `@sentry/opentelemetry`.
  **Browser tracing stays proprietary** (OTel-web too heavy/thin). Propagation: `traceparent` injected,
  gated by `tracePropagationTargets`.
  <https://github.com/getsentry/sentry-javascript/blob/develop/packages/opentelemetry/README.md> ·
  <https://blog.sentry.io/sentry-javascript-v8-sdk-otel-and-node-support/>
- **Grafana Faro (frontend RUM, own model — closest analog)** — core RUM model is proprietary; OTel
  tracing is a **separate opt-in package** kept out of core *because the OTel-web stack is ~60 KB
  gzipped*. Its `FaroTraceExporter` both **embeds the OTLP-JSON span blob** in the envelope **and**
  **mirrors each span into a native event** for correlation. `@grafana/faro-transport-otlp-http` emits
  real **OTLP/HTTP-JSON depending only on `@opentelemetry/otlp-transformer`** (no `sdk-trace-web`) —
  proving lightweight Produce. W3C propagation **on by default** once tracing is enabled.
  <https://github.com/grafana/faro-web-sdk/blob/main/packages/web-tracing/src/faroTraceExporter.ts>
- **Datadog dd-trace-js** — satisfies the OTel **API** (registers its own `TracerProvider`), proprietary
  Agent transport, OTLP-out bolted on recently. The `@opentelemetry/api` > 1.4.1 breakage is a
  cautionary tale about coupling to OTel-API internals.
  <https://docs.datadoghq.com/tracing/trace_collection/custom_instrumentation/nodejs/otel/>
- **Honeycomb / New Relic / Elastic (EDOT) / Embrace** — pure OTLP: their ingest *is* a collector
  (accept OTLP/HTTP-JSON + protobuf + gRPC). Not us — we keep our Android-canonical model.

**Takeaways baked into the design:** (1) keep our model, bridge at the edges; (2) OTel deps isolated as
peers in one adapter package (= our "don't pierce core"); (3) Consume = `SpanProcessor`; Produce =
lightweight OTLP-JSON (hand-rolled or `otlp-transformer` only); (4) browser-Consume is a real bundle
cost — Node-first; (5) Faro's "embed OTLP **and** project to native" is the reference for how consumed
spans land in a bundle.

---

## The design

### Architecture
`@bugsee/opentelemetry` is a **pluggable extension** (like `@bugsee/performance`), tree-shakeable, with
OTel packages as **peerDependencies** so we never force a version into a non-OTel app. A
**runtime-portable mapping core** (Span/Transaction ↔ OTel span model + the OTLP-JSON encoder) is shared;
thin per-runtime wiring sits on top. It consumes only **public seams** (the extension registry, the
network interceptor's transformer seam, the `TransactionStore`) — core and perf are untouched.

### Two-way data flow
- **Consume (SDK-level):** a `BugseeSpanProcessor`/`SpanExporter` the user registers on their
  `TracerProvider`. `onEnd(otelSpan)` → map → Bugsee. Open sub-decision (Faro does both): consumed spans
  become Bugsee **Transactions** (native model, for UI/correlation) and/or are preserved as an **OTLP
  blob** in the bundle (full fidelity — events/links/resource/scope our model lacks). Peer:
  `@opentelemetry/sdk-trace-base`. **Node-first.**
- **Produce (OTLP-JSON):** `TransactionStore.drain()` → `resourceSpans` (OTLP-JSON) → `POST
  application/json` → the user's collector / OTLP endpoint. Hand-rolled mapping or a thin
  `@opentelemetry/otlp-transformer` dep — no full SDK. Dropped vs the SDK exporter: protobuf, gzip,
  retry/backoff (acceptable v1).

### Interception transformers (D6) — the enabling seam
An interceptor is **observe-only on its own** (existing listenable stages; observers `on()`, never
touch). It additionally accepts **injected transformers** that *may rewrite the data it pipes through*
before it continues to the real operation. Contract:
- **Synchronous, no added latency** — a transformer may add/modify headers but must not block or delay
  (latency is itself a behavior change). Async transformers are deferred.
- **Truthful capture** — transformers run first; observers/capture then record the **post-transform**
  request (the bytes that actually went on the wire).
- **Lives in `@bugsee/capture` / `InterceptorBase`** — a general capture-layer capability (reusable for
  request-tagging, header enrichment, …); OTel is merely its first consumer.
- **Distinct from redaction filters** (DI Phase 2): redaction transforms *what Bugsee stores*;
  transformers transform *what flows through*. Different targets — kept separate.

### Propagation + security
The **propagation transformer** adds `traceparent`/`tracestate` (from the active span — our `traceId`
is already 16-byte/128-bit, `spanId` 8-byte/64-bit, W3C-shaped) at the network `before` stage. **Opt-in;
allowlist-gated; same-origin default.** This is a *security* boundary, not polish: injecting `traceparent`
to third-party origins leaks trace topology — so propagate to your own backend(s) by default, never to
arbitrary cross-origin calls without an explicit allowlist (Sentry `tracePropagationTargets`, Faro
`propagateTraceHeaderCorsUrls`).

### Runtime nuance
Mapping core is portable. **Produce** (light) ships on both runtimes. **Consume** is **Node-first**
(OTel's home; bundle cost free); **browser-Consume** is opt-in later given the ~60 KB OTel-web weight.
**Propagation** is cheap on both (it only adds a header).

---

## Phasing (sequenced after the current perf follow-ups)

- **A. Portable mapping core** — `@bugsee/opentelemetry`: Span/Transaction ↔ OTel span + the OTLP-JSON
  encoder. Foundation; pure; test-first.
- **B. Produce** — OTLP-JSON exporter from `TransactionStore`. Read-only, low-risk, first user-visible win.
- **C. Consume** — `BugseeSpanProcessor` (peer `sdk-trace-base`), **Node-first**. Resolve the
  native-map-vs-OTLP-blob sub-decision here (likely both, Faro-style).
- **T. Interception-transformer seam** — in `@bugsee/capture`/`InterceptorBase` (general; sync; truthful
  capture). Prerequisite for D, independently useful.
- **D. Propagation transformer** — `traceparent` on allowlisted/same-origin targets → the Next.js
  end-to-end story. Builds on T; needs a security pass on the allowlist defaults.

Order rationale: foundation → low-risk Produce → Consume → the general mutation seam → the highest-care
propagation phase (principle revision + security) last. T+D are somewhat independent of A–C and could
move earlier if the distributed-trace story is the priority.

## Open questions / deferred

- **Consume mapping:** native Transactions vs preserved OTLP blob vs both (lean: both, Faro-style) —
  settle in Phase C.
- **Deferred:** OTel-API facade; OTLP protobuf/gRPC; OTLP *receiver*; async transformers; browser-Consume;
  our own auto-instrumentation (Consume subsumes it).

## Risks

- **OTel version coupling** — peer-dep range churn + the OTel SDK v2 transition (Sentry hit this; Datadog
  broke at `@opentelemetry/api` > 1.4.1). Mitigate: wide peer ranges, isolate in one package, test against
  pinned matrices.
- **Principle erosion** — the transformer seam could become a footgun. Mitigate: sync/no-latency contract,
  capture-records-post-transform, transformers only via explicitly-enabled features.
- **Cross-origin trace leakage** — same-origin/allowlist default is a hard security requirement, not a knob.
- **Mapping fidelity** — our model lacks OTel events/links/resource/scope; preserving the OTLP blob on
  Consume avoids lossy round-trips.

---

## Cross-SDK coordination addendum (2026-06-21, from the Android OTel workstream)

The Android SDK is adding OTLP interop and the team decided to make **OTLP the native format of the internal
Bugsee APM upload** (not just third-party export), across **all** SDKs. A shared, SDK-agnostic contract was
drafted — **`Bugsee OTLP Profile v1`**, now hoisted to the shared workspace folder
**`~/Projects/Bugsee/dev-docs/bugsee-otlp-profile-v1.md`** (reachable by all repos; indexed in the
`bugsee-projects` skill). It lifts this repo's `bugsee=` tracestate codec and the cross-project-tracing
protocol into an SDK-agnostic spec so Android/iOS implement the identical bytes. Two deltas for **this** SDK:

1. **"Produce" must also feed Bugsee's own ingest, not only the customer's collector.** §103 here scopes the
   OTLP-JSON exporter to "the user's collector / OTLP endpoint." Under the unified decision the *same*
   OTLP-JSON encoder should *also* upload to Bugsee's ingest (one encoder, two destinations), replacing the
   proprietary report/upload path for APM data. The Bugsee ingest accepts all three OTLP variants, so JS
   staying **OTLP/HTTP-JSON is fully first-class** (no need to add protobuf — D3/non-goals hold).
2. **The internal-upload path must keep delivery guarantees.** The Produce path here deliberately drops
   gzip/retry/backoff ("acceptable v1") — fine for fire-and-forget third-party export, **not** for first-party
   telemetry. When Produce targets Bugsee's ingest it must wrap the OTLP-JSON payload in a reliable transport
   (disk-backed queue + retry), the way Android's `PerformanceUploadJob` already does.

Confirmed alignments (no change needed): pluggable extension + OTel as peers; two-way Consume/Produce/Propagate;
W3C trace-context; W3C-shaped ids (Android is changing its span-id width to match JS's existing 8-byte ids);
same-origin/allowlist + `propagateTrace` security; `bugsee=` (`r`,`s`) tracestate. Backend items (ingest
accepts all three encodings; join reports by `traceId`; consume the `/v2/sessions` session-correlation id) are
shared cross-SDK dependencies on appserver/worker/collector — see profile §17.
