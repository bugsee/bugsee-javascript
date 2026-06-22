# Cross-project distributed tracing (frontend ↔ backend ↔ frontend)

**Status:** Design (2026-06-20; aligned to the cross-SDK profile 2026-06-21). Backend gap-closure first;
frontend hooks defined here, built with the frontend-adapters milestone. Builds on the propagation foundation
in `opentelemetry-integration.md`.

> **Canonical cross-SDK contract.** The wire protocol below (W3C `traceparent` + the `bugsee=` `tracestate`
> entry, ids, propagation/continuation, option names) is now pinned by the SDK-agnostic **Bugsee OTLP Profile
> v1** — `~/Projects/Bugsee/dev-docs/bugsee-otlp-profile-v1.md` (§3, §12; indexed in the `bugsee-projects`
> skill). That profile **lifts this SDK's X1 `bugsee=` codec as the reference Android/iOS implement verbatim**,
> so any change to the bytes here is a cross-SDK change — make it there first. X1 conforms (incl. the §12
> 32-entry / **512-byte** caps, commit `21ef92a`). **Related cross-SDK item (in `opentelemetry-integration.md`
> + profile §17), tracked separately from X0–X5:** the OTLP "Produce" encoder must *also* feed Bugsee's own
> ingest (one encoder, two destinations) with reliable delivery (disk queue + retry), replacing the
> proprietary APM upload path — OTLP becomes the native internal APM format, not just third-party export.

## Purpose

One user action that crosses process/project boundaries — a click on the web frontend that calls a Node
backend that calls another service — should be reconstructable as **a single distributed trace**, and that
trace must **interconnect with any OpenTelemetry-instrumented hop** in the chain (the wire format is W3C
trace-context, not a Bugsee-proprietary header). The product payoff: a frontend error and the backend error
it triggered are shown as one transaction, joined by a shared `traceId`.

```
[Frontend]                              [Backend]                              [downstream]
 root span (traceId=T, span=A, sampled)
 fetch('/api/x')
   inject  traceparent: 00-T-A-01       parse → http.server span
           tracestate:  bugsee=…          traceId=T, parent=A, span=B   ── inject 00-T-B-01 ──►
                                          response headers (configurable):
   FE network span: child of A, trace T    Server-Timing + traceresponse: 00-T-B-01
   adopts B as the precise child  ◄───────
```

The **join key is `traceId` T**; "back to front" is implicit (the BE span is already a child of the FE span
because the FE minted the `traceparent`). The optional return headers let the FE adopt the BE's exact span id
and surface backend timing.

## Decision log

| # | Decision | Rationale |
| --- | --- | --- |
| T1 | **Wire format = W3C `traceparent` + `tracestate`.** Not proprietary. | OTel-standard ⇒ any OTel hop interops for free; "OTel-compatible" is structural, not bolted on. Our `traceId`/`spanId` are already 128/64-bit W3C-shaped. |
| T2 | **Propagation native + default-on (same-origin); cross-origin allowlist-only; global kill-switch.** | User T-answer. Distributed tracing requires header injection — make it deliberate + scoped, not silent (refines "interceptors must not alter app behavior": *capture* stays observe-only; propagation is a distinct, explicit capability). De-gate from the OTel extension. |
| T3 | **Return path BE→FE = all three, each configurable:** implicit (always), `Server-Timing`, `traceresponse`. | User T-answer ("have all, controllable"). Implicit is free; the headers are additive on the response and toggleable. |
| T4 | **A `bugsee=` `tracestate` entry** carries Bugsee-vendor linkage. | User T-answer. `tracestate` is the OTel-legal vendor channel; lets a hop attribute the trace to the originating Bugsee session/replay without a pure traceId server-join. |
| T5 | **No Android parity to match — Android has no distributed-tracing code** (pure mobile client, doesn't propagate). The JS SDK **defines** the convention; design the `bugsee=` encoding SDK-agnostically so Android/iOS can adopt it later (mobile→backend propagation). | Verified: zero `traceparent`/`tracestate`/propagation in the Android SDK. |
| T6 | **Backend first.** Close the BE gaps (native wiring, per-request source, parent link, return path, report linkage) before the frontend, so the frontend just plugs into a finished protocol. | User direction. |
| T7 | **Mint + propagate a client session-correlation id now** (resolves Q1). A per-launch id (via `@bugsee/util` `randomId`) sent at `/v2/sessions` + carried as `bugsee=s<id>`. | User Q1-answer. Gives FE-session↔BE-trace join on the wire; collector-side consumption is a coordination dependency (flagged). |
| T8 | **Report envelope carries `traceId`** (resolves Q2). | The clean per-report cross-project join (entries already carry `trace_id`). |
| T9 | **Return headers (`Server-Timing`/`traceresponse`) default OFF until the frontend consumes them** (resolves Q3); implicit `traceId` linkage is always on. | No consumer until the FE milestone; flip to on-by-default then. |

## What already exists (the substrate — we extend, not rebuild)

- `capture/traceparent.ts` `createTraceparentDecorator` — injects `traceparent` (same-origin default,
  allowlist cross-origin, never overrides upstream). **Gap: injects only `traceparent`, not `tracestate`.**
- `capture/request-decorator.ts` — the `RequestDecorator` "T seam" (sync outgoing-header mutation), fanned
  into fetch/xhr by `installNetworkCapture({ additionalDecorators })`.
- `capture/traceparent.ts` `parseTraceparent` — inbound parse (defensive). Used by `server-instrument.ts`.
- `node/server-instrument.ts` — inbound: starts the `http.server` transaction with `continuation:{traceId}`.
  **Gaps: (a) drops the parent span link; (b) doesn't parse/continue `tracestate`; (c) doesn't emit return headers.**
- `performance/controller.ts` — `startTransaction({continuation:{traceId}})`; `getActiveSpan()` is a single
  slot ("most recently started txn"). **Gap: not async-context-aware → wrong trace under server concurrency.**
- `core/capture-aggregator.ts` — stamps each capture entry with `trace_id`/`span_id` from the active
  `RequestContext.trace`. **Gap (to confirm): the report ENVELOPE (`request.json`) doesn't surface `traceId`.**
- `@bugsee/opentelemetry` — wires *this same* decorator + OTLP produce + consuming SpanProcessor. After this
  work, OTel becomes **additive** (export/consume); propagation lives in the base.

## Protocol spec

### Outbound (the originator + every forwarding hop)
On the network `before` stage, for an allowed target (same-origin, or allowlist), with an active trace and no
upstream `traceparent`:
- `traceparent: 00-<traceId>-<spanId>-<flags>` — `spanId` = the **current span** (the FE root, or the BE's
  `http.server` span when the backend forwards); `flags` low bit = the sampled decision.
- `tracestate: bugsee=<v>` — prepended per W3C rules (vendor's entry moves to the front on mutation; existing
  other-vendor entries preserved; cap at 32 entries / 512 bytes; drop oldest on overflow).

### The `bugsee=` tracestate value (compact, W3C-legal: chars 0x20–0x7E, no `,`/`=`, ≤256 chars)
`bugsee=` `<field>(:<field>)*` — colon-delimited, ordered, forward-compatible (unknown fields ignored):
- `r<0|1>` — **record flag**: the originator is recording/replaying this trace (a Bugsee-specific signal
  distinct from the W3C sampled bit; lets a backend align its own record decision).
- `s<id>` — **session-correlation id** (T7): a client-minted per-launch id so the collector joins the
  originating FE session/replay to this trace without relying on traceId alone. A receiving hop adopts the
  inbound `s` (the trace's originating session) and re-propagates it unchanged downstream.

### Inbound continuation (every receiving hop)
Parse `traceparent` → `{traceId, spanId, sampled}` and `tracestate` → the `bugsee=` fields. Start the
`http.server` transaction as a **child**: `continuation: { traceId, parentSpanId: spanId, sampled }`. Stamp
the `RequestContext.trace` with `{traceId, spanId(=new), sampled}` + the inbound `bugsee` fields (so the
backend's reports carry the cross-project linkage). Missing/invalid header → fresh root trace (defensive).

### Return path BE→FE (each independently configurable) — **BUILT (X4, see below)**
1. **Implicit** (always): the shared `traceId` already links the BE span as a child of the FE span — no header.
2. **`Server-Timing`** (`traceResponse.serverTiming`, default **OFF** per T9): a `Server-Timing` entry the
   browser exposes via PerformanceObserver — emitted as `traceparent;desc="00-<traceId>-<beSpanId>-<flags>"`
   carrying the BE span id (the `dur` is deferred to the FE-consumption milestone). On the node:http path it
   is set at request-open (skipped if headers already sent); on the native fetch path it is **appended** to
   the returned Response so an app's own `Server-Timing` survives (binding: interceptors must not alter app
   behavior).
3. **`traceresponse`** (`traceResponse.traceresponse`, default **OFF** per T9): the W3C trace-context-L2
   *draft* header `00-<traceId>-<beSpanId>-<flags>` so the FE adopts the BE's exact span id as its
   network-span child. Set at request-open (span id known immediately), so it survives streaming responses;
   a singleton header → `set` (never appended).

### Config surface (launch options)
- `propagateTrace?: boolean` (default `true`) — the global kill-switch (T2).
- `tracePropagationTargets?: Array<string | RegExp>` — cross-origin allowlist (same-origin always on).
- `traceResponse?: { serverTiming?: boolean; traceresponse?: boolean }` — the BE→FE return headers (T3).
- (Frontend, next milestone) the FE reads `Server-Timing`/`traceresponse` off responses to refine its network span.

## Data-model changes (backend slices)
1. `RequestContext.trace` gains `sampled: boolean` (+ optional `bugsee` inbound fields) — needed for the
   outbound `flags` + respecting upstream sampling.
2. `StartTransactionOptions.continuation` gains `parentSpanId?` and `sampled?` — the BE root span becomes a
   true child of the inbound span; the transaction adopts the upstream sampled decision.
3. The outbound decorator's `getActiveSpan` is sourced from the **per-request `ContextProvider`**
   (AsyncLocalStorage) on the server, not `perf.getActiveSpan()` — concurrency-correct.
4. Report envelope (`request.json`) surfaces the active `traceId` (Open Q2) for collector-side cross-project
   stitching of reports.

## Profile-conformance plan (comply-from-the-start, 2026-06-21)

Per the "comply with the cross-SDK spec from the start" directive, the work conforms to **Bugsee OTLP
Profile v1** as we build, rather than refactoring later. Scope decision: **conform everything the SDK
controls now; STAGE the §17 upload cutover** (it needs the Bugsee OTLP ingest endpoint, a backend dependency).
- **Y1 — OTLP data-model conformance** (`@bugsee/opentelemetry` `to-otlp.ts`): `to-otlp` is only ~60%
  conformant. Add the root's `bugsee.transaction.name` + `bugsee.sampled` (§6/§10), lossless `bugsee.span.status`
  (§6), kind **SERVER** for `http.server` + a `bugsee.span.kind` override (§6), the profile-mandated resource
  constants `telemetry.sdk.name="bugsee"` + `bugsee.profile.version="1"` (§4); the scope name
  `com.bugsee.<sdk>/<provider>` (§5) is set by the wiring. Pure encoding, no backend dep.
- **X0 is DUAL-PURPOSE:** the minted session id feeds BOTH the `bugsee=s<id>` tracestate (X1) AND the OTLP
  `bugsee.session.id` resource attribute (§10/§12) — one source, two consumers, conformant from the start.
- **§17 internal OTLP upload (DEFERRED, backend-gated):** make the OTLP encoder feed Bugsee's own ingest
  (one encoder, two destinations) with disk-queue+retry reliability, replacing the proprietary
  `/v2/performance/transactions` path. Build when the ingest endpoint is confirmed; until then `/v2/performance`
  stays the live internal APM upload. (The data model we emit is already profile-shaped via Y1, so the cutover
  is a transport swap, not a re-encode.)

## Backend gap-closure slices (each: test-first → mutator → review → commit)

> **STATUS — ALL BACKEND SLICES COMPLETE + reviewed-to-convergence, on `master` (2026-06-22).** X0–X5 +
> Y1 (OTLP profile conformance) are built. The backend half of the cross-project tracing protocol is
> closed: a backend continues an inbound W3C trace as a child (X2), stamps the report envelope with the
> join key (T8/X5), propagates outbound (X3), and emits the BE→FE return headers (X4) — all conformant to
> Bugsee OTLP Profile v1 §12. Proven end-to-end on node/bun/deno (the X5 two-hop e2e). **Next milestone:
> the frontend adapters** (which plug into this finished protocol). Deferred follow-ups: retire the
> umbrella's OTel-gated propagation path (X3b), originating-session re-propagation (the BE currently
> re-propagates its own session id, not the inbound FE's), and the §17 internal-OTLP upload cutover.

- **X0** Client **session-correlation id** (T7): mint a per-launch id (`@bugsee/util` `randomId`) in
  core/launch, send it at `/v2/sessions`, expose it to the context/decorator. (Collector consumption =
  external coordination — flagged, not blocking the SDK side.)
- **X1** `tracestate` codec in `@bugsee/capture` (`parseTracestate`/`serializeTracestate` + the `bugsee=`
  field encode/decode), W3C-conformant (ordering, caps); extend `createTraceparentDecorator` to emit
  `tracestate`. Pure, runtime-portable.
- **X2** `continuation` gains `parentSpanId`+`sampled` (`@bugsee/performance`); `RequestContext.trace` gains
  `sampled`. server-instrument passes inbound `spanId`/`sampled` + the `bugsee` fields.
- **X3** Native propagation wiring in `@bugsee/node` launch: install the decorator via
  `installNetworkCapture({ additionalDecorators })`, sourced from the per-request context, gated by
  `propagateTrace` + `tracePropagationTargets`. (De-gates from OTel; OTel keeps working — it adds OTLP only.)
- **X4** Return path: server-instrument emits `traceresponse` (open) + `Server-Timing` (pre-flush), each
  config-gated; the adapters forward the response-header seam.
- **X5** Report-envelope `traceId` + e2e: a real frontend-less round-trip (process A injects → process B
  continues → asserts one shared traceId across both reports + the return headers). Plus the OTel-interop
  assertion (an external W3C `traceparent` continues correctly).

## Frontend hooks (defined now; built with frontend adapters)
- A FE **root transaction** per pageload/navigation/interaction owns the trace (`traceId`), propagated
  outbound by the *same* decorator (browser origin = `location.origin`).
- The FE network interceptor **reads** `Server-Timing`/`traceresponse` off responses to refine its network span.
- React/Vue/… adapters surface route/interaction as the transaction name; everything rides this protocol.

## OTel interop
The wire is W3C trace-context, so an OTel service between two Bugsee hops continues the trace transparently,
and a Bugsee hop continues an OTel-originated trace (`parseTraceparent` already tolerates external headers).
The `bugsee=` `tracestate` entry is OTel-legal (vendor channel) and ignored by non-Bugsee hops. The
`@bugsee/opentelemetry` extension is **additive** (OTLP export + consuming user spans), not the propagation
gatekeeper.

## Resolved (was Open) — see Decision log T7–T9
- **Q1 → T7:** mint + propagate the client session-correlation id now (slice X0). **Collector-side
  consumption of the `/v2/sessions` session-correlation id remains an external coordination item.**
- **Q2 → T8:** elevate the active `traceId` into the report envelope (slice X5).
- **Q3 → T9:** `Server-Timing`/`traceresponse` default OFF until the FE consumes them; implicit is always on.

## Remaining external dependency
- The collector/server must (a) accept + index the `/v2/sessions` session-correlation id and (b) join reports
  by `traceId` across projects. The SDK ships the wire side; these are server-team coordination items.
