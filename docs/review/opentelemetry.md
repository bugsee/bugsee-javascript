# Adversarial review — @bugsee/opentelemetry

**Reviewed:** 2026-07-26 · **Scope:** packages/opentelemetry (impl 689 LOC across 7 files, tests 887 LOC / 66 tests)
**Verdict:** The prior is broadly accurate — this *is* a two-way bridge (produce `createOtlpTraceExporter`, consume `createBugseeSpanProcessor`), wired via `@bugsee/bugsee` `wire.ts`. **Correction to the prior:** W3C propagation does **not** live in this package. There is exactly one `traceparent`/`tracestate` codec, in `@bugsee/capture` (`traceparent.ts` / `tracestate.ts`), and it is spec-correct — no divergent second parser exists here (verified, clean). The produce mapping is genuinely well-built on the mechanical axes my mandate flagged as classic breaks: **ids are lowercase hex (not base64), `*UnixNano` are BigInt-derived decimal strings (no 2^53 loss), `status`/`kind` are numeric enums, the sampled bit mirrors `bugsee.sampled`** — and the produce test suite is strong (14 of 16 injected mutations caught). The failures are architectural, not mechanical. The headline is that **the §8.8 transaction wire discards the root span's real id, and this package fabricates a replacement by slicing the trace id** — which makes two different services in one distributed trace emit a root span with an *identical* span id while the continued root's `parentSpanId` points at a span nobody exports. That corrupts the trace graph in the customer's Jaeger/Tempo/Honeycomb, and the same mechanism rewrites the host's own OTel span ids on the consume→produce path. Second headline: **no runtime test in this package ever touches the real OTel SDK** (only a type-level `test-d` guard), and consequently three host-pipeline contract violations went undetected — most seriously, a throw inside our `onEnd` propagates out of `span.end()` into the customer's application code and starves every processor registered after ours, which I confirmed against the real `@opentelemetry/sdk-trace-base` 2.7.1.

All findings below were verified empirically by executing code against the real OTel SDK (installed as devDeps: `api` 1.9.1, `sdk-trace-base` 2.7.1). Source was restored to pristine after every mutation; `git status --short packages/` is empty.

---

## SEV1

### 1. The derived root span id collides across services and orphans the continued root
- **Where:** `packages/opentelemetry/src/to-otlp.ts:98-100` (`deriveRootSpanId`), used at `to-otlp.ts:104` and emitted at `to-otlp.ts:124-127`; the propagated id is minted at `packages/performance/src/span.ts:186` and sent at `packages/capture/src/traceparent.ts:154`.
- **What:** The §8.8 `TransactionWire` deliberately omits the root span's id (`packages/performance/src/span.ts:330-345` — `toTransactionWire` filters the root out of `spans` and never writes its `spanId`). OTLP requires one, so `deriveRootSpanId` reconstructs it as `traceId.slice(0, 16)`. But the id that actually goes on the wire in `traceparent` is `Transaction.getSpanId()` — a **random** 8-byte id (`span.ts:186`, `span.ts:234-235`) with no relationship to the trace id. The two notions of "the root's span id" therefore disagree, and because the derived id is a pure function of the trace id, **every service participating in the same trace derives the same root span id.**
- **Why it matters:** In a FE→BE trace exported to the customer's OTLP backend, (a) the FE root and the BE root are emitted with an **identical `(trace_id, span_id)` pair** — OTLP requires uniqueness within a trace; Jaeger/Tempo merge or ambiguously resolve them, so children of the FE root and children of the BE root collapse under one span; and (b) the BE root's `parentSpanId` is the propagated random id, which **no exported span carries**, so the continued root is a dangling orphan. This is the exact "misattributed parent/child relationships corrupt the customer's trace graph" hazard, and it fires on the flagship cross-project-tracing use case.
- **Evidence** (executed; `transactionToOtlpSpans` on a real `createTransaction` FE txn + a continuing BE txn):
  ```
  traceId               = 885f62fd86a2397abbc3a7e8e4a62953
  FE real root spanId   = 5783c6e189c738f0   <- propagated in traceparent
  FE OTLP root spanId   = 885f62fd86a2397a   <- derived
  BE OTLP root spanId   = 885f62fd86a2397a   <- derived  ← IDENTICAL to FE's
  BE OTLP root parent   = 5783c6e189c738f0
  FE OTLP id === propagated id ? false
  FE OTLP id === BE OTLP id    ? true
  BE parent resolves to an FE-exported span ? false
  ```
- **Note:** the comment at `to-otlp.ts:93-97` justifies the derivation only against *collision with a child span id* (~2^-64). That reasoning is sound but addresses a different risk than the one that actually bites — cross-service determinism, which is 100%, not 2^-64. The same applies to the browser pageload continuation (`wire.ts:199-203`), where the browser adopts the server's trace id and would derive the same root id as the server.

### 2. A throw inside `onEnd` escapes into the host's OTel pipeline and application code
- **Where:** `packages/opentelemetry/src/span-processor.ts:98-100` (`onEnd` → `assembler.add(readableSpanToConsumed(span))`), reaching `packages/opentelemetry/src/trace-assembler.ts:79` (`deps.onTransaction(...)`), wired to `wired.recordTransaction` at `packages/bugsee/src/wire.ts:248`.
- **What:** Neither `onEnd` nor the assembler has any `try`/`catch`. The real OTel `MultiSpanProcessor.onEnd` iterates processors with no containment (`packages/opentelemetry/node_modules/@opentelemetry/sdk-trace-base/build/esm/MultiSpanProcessor.js:43-47` — a bare `for` loop calling `spanProcessor.onEnd(span)`), and `Span.end()` calls it synchronously.
- **Why it matters:** Violates the BINDING host-behavior-preservation rule. Any throw from our side — `onTransaction` rejecting, a malformed host span making `span.status.code` or `hrTimeToMs(span.endTime)` throw — propagates **out of the customer's `span.end()` call into their application code**, and starves every span processor registered after ours (their own exporter included). We break the customer's entire tracing, and potentially their request handler.
- **Evidence** (real `BasicTracerProvider`, sdk-trace-base 2.7.1):
  ```
  span.end() -> THREW "boom" INTO APP CODE
  host processor registered after ours saw: []          ← starved
  ```

### 3. Consume→Produce rewrites the host's real OTel span ids
- **Where:** `packages/opentelemetry/src/from-otlp.ts:68-85` (`consumedRootToTransaction` — the root's `spanId` has nowhere to go in `TransactionWire` and is dropped), then `to-otlp.ts:104` fabricates a replacement on re-export; child parent pointers are rewritten at `to-otlp.ts:141-142`.
- **What:** When the host's OTel spans are consumed and then re-exported through the OTLP tee (`wire.ts:181` + `wire.ts:248`, both active when `otelConsume` and `otelExportUrl` are set), the trace root's genuine OTel span id is **discarded and replaced by `derive(traceId)`**, and every direct child's `parentSpanId` is remapped to that fabricated id.
- **Why it matters:** This is the "interception-transformer" principle failing in the direction that matters — identity is not preserved. If the customer sends their spans to their own backend (their exporter) *and* to a collector via our tee, the same logical root arrives **twice under two different span ids**, and our copy's children point at a parent their backend has never seen. It also silently rewrites third-party telemetry we did not author, which is precisely what "transform, don't duplicate" is supposed to prevent.
- **Evidence** (real OTel spans through `createBugseeSpanProcessor` → `transactionToOtlpSpans`):
  ```
  real OTel root span id   = 3fc9aa8db82fda40
  re-exported root span id = 2922e35dd6da6e8f   (= derive(traceId))
  child parent points at   = 2922e35dd6da6e8f | real = 3fc9aa8db82fda40
  ```
  The child's own id survives correctly; only the root identity and the parent link are corrupted.

---

## SEV2

### 4. Profile v1 §4 mandatory resource attributes are absent by default
- **Where:** `packages/opentelemetry/src/to-otlp.ts:183-189`; the umbrella only forwards a resource when the user sets `otelExportResource` (`packages/bugsee/src/wire.ts:176-178`).
- **What:** §4 says "Every producer MUST populate" `service.name`, `service.version`, `telemetry.sdk.name`, `telemetry.sdk.language`, `telemetry.sdk.version`, `bugsee.profile.version`. We hard-set only two.
- **Why it matters:** `service.name` is the primary index in every OTLP backend — without it Jaeger/Tempo/Honeycomb bucket all spans as `unknown_service`, so the customer's traces are unusable until they hand-configure `otelExportResource`. `telemetry.sdk.language` (`webjs`/`nodejs`) is already computed one line away at `wire.ts:164` for the scope name but never written into the resource.
- **Evidence:**
  ```
  resource keys = ["telemetry.sdk.name","bugsee.profile.version"]
    §4 MUST service.name: MISSING
    §4 MUST service.version: MISSING
    §4 MUST telemetry.sdk.language: MISSING
    §4 MUST telemetry.sdk.version: MISSING
  ```
- Correctly done: the two constants are spread **after** `options.resource` (`to-otlp.ts:184-187`) so a caller cannot override them away — mutation M12 (reordering them) was caught by the tests.

### 5. Sub-millisecond spans export as zero duration (Profile v1 §6 timestamp rule not implemented)
- **Where:** `packages/opentelemetry/src/to-otlp.ts:130-131` and `:145-146`, via `toUnixNanoString` (`to-otlp.ts:30-32`, which does `BigInt(Math.round(ms))`).
- **What:** Profile §6 is explicit: "`end_time_unix_nano` = start + monotonic duration (nanos)". We instead round *both* wall-clock endpoints to whole milliseconds and let OTLP derive the duration, discarding the `durationNanos` field that is already present on the §8.8 wire. The header comment at `to-otlp.ts:22-25` acknowledges the loss but calls it "sub-millisecond precision" — in fact it can be a total loss of the duration.
- **Why it matters:** `http.client`, `db.*` and resource spans are routinely sub-ms. When start and end round to the same integer ms, the span exports with **zero duration** and renders as a degenerate tick in the customer's waterfall. The fix is already available in the data (`durationNanos`).
- **Evidence:** a 0.3 ms span with `durationNanos: 300000` on the wire:
  ```
  start= 1700000000001000000  end= 1700000000001000000
  OTLP-derived duration = 0 ns (expected 300000)
  ```

### 6. Span buffering inside a single trace is unbounded
- **Where:** `packages/opentelemetry/src/trace-assembler.ts:41-42` (`maxTraces` default 1000) and `:74` (`buffer.spans.push(span)`), evicted only per-trace at `:57-64`.
- **What:** `maxTraces` caps the number of *concurrent traces*, never the number of spans inside one. A long-lived or never-closed root (a batch job, a streaming handler, a leaked span) accumulates children in `buffer.spans` without limit, and `evictAged` only fires on the 30 s age of the trace's *first* span, so a trace that keeps receiving spans is refreshed-by-activity but never trimmed.
- **Why it matters:** Long-lived Node processes are the target runtime; this is a straightforward unbounded-growth path in a library that plugs into the customer's hot path. The file header at `trace-assembler.ts:8-9` claims "a leaked/never-closed trace can't grow memory unbounded" — that claim is false for the single-trace case.
- **Evidence:** 50,000 child spans pushed under one `traceId` with `maxTraces: 1` — no cap engaged, all retained.

### 7. No self-instrumentation suppression — the export path can feed itself forever
- **Where:** `packages/opentelemetry/src/otlp-exporter.ts:36-40` (the POST) with `wire.ts:167-181` (tee) and `wire.ts:248` (consume). Verified: no `suppressTracing` / `suppressInstrumentation` guard exists anywhere in `packages/` (repo-wide grep, zero hits).
- **What:** With both directions enabled — `otelConsume: true` plus `otelExportUrl` — and the host running standard OTel HTTP auto-instrumentation (`@opentelemetry/instrumentation-http` / `-fetch`, which patch `node:http`/`fetch` globally and so intercept `internals.transport`), our OTLP export POST itself produces an OTel span → our `SpanProcessor` consumes it → it becomes a Bugsee transaction → the next flush exports it → producing another span.
- **Why it matters:** A non-decaying, self-sustaining telemetry loop: every flush interval manufactures at least one new transaction describing the previous flush, forever, even in a completely idle app, polluting both the customer's trace backend and the Bugsee upload. This is exactly why upstream OTLP exporters wrap their sends in `suppressTracing(context)`. Rate is bounded by the flush interval (not exponential), and it requires the two-way opt-in, which is why this is SEV2 rather than SEV1 — but it is silent and permanent once triggered. Note that the self-isolation comment at `wire.ts:166` addresses only *Bugsee's own* network capture, not the host's OTel instrumentation.

### 8. `forceFlush()` is a no-op and `shutdown()` silently drops finished host spans
- **Where:** `packages/opentelemetry/src/span-processor.ts:101-103` (`forceFlush` returns `Promise.resolve()` unconditionally) and `:104-107` (`shutdown` calls `assembler.clear()`, `trace-assembler.ts:86`).
- **What:** Child spans whose root has not yet ended sit in the assembler. `forceFlush` — whose OTel contract is to export everything held — does not touch them, and `shutdown` discards them outright.
- **Why it matters:** On every graceful process shutdown, all in-flight traces (children already *finished* by the host and handed to us) are lost with no diagnostic. `forceFlush` is what OTel SDKs call on `SIGTERM`; ours reports success while dropping data. There is no partial-trace emission path.
- **Evidence:**
  ```
  after forceFlush emitted = []                ← child still buffered, flush claimed success
  after shutdown+parent.end emitted = ["parent"]  ← child dropped entirely
  ```

### 9. Blast radius of the known `@bugsee/performance` single-slot `getActiveSpan` leak, in OTLP terms
- **Where:** `packages/bugsee/src/wire.ts:214` passes `networkSource: internals.network.interceptor` **unconditionally** (both runtimes), and `packages/performance/src/http-spans.ts:106` attributes each finished request via `deps.getActiveSpan()`.
- **What:** Not re-litigated (already filed against `@bugsee/performance`), but the manifestation here is worth recording: on Node under concurrency, an `http.client` child span is parented to whichever transaction is ambient in the single slot, not the one that issued the request. `to-otlp.ts:137-154` then faithfully emits that mis-attribution as a real OTLP `parentSpanId`.
- **Why it matters:** In the customer's OTLP backend this is indistinguishable from a genuine causal edge — an outbound call appears nested under an unrelated inbound request. Wrong parent/child edges are worse than missing spans because they are silently believable. Worth noting the umbrella already reasons carefully about exactly this hazard for the *propagation* decorator (`wire.ts:255-259` explicitly declines to wire the perf-sourced decorator on Node "which would leak the ambient transaction's trace across concurrent server requests") — the identical reasoning was not applied to `networkSource` two lines earlier.

---

## SEV3

### 10. `shutdown()` does not make the processor inert
- **Where:** `packages/opentelemetry/src/span-processor.ts:104-107`.
- The OTel contract is that a processor is a no-op after `shutdown()`. Ours keeps consuming and keeps calling `onTransaction` — pushing data into a Bugsee client that may itself be torn down. `shutdown` is correctly *idempotent* (repeat `clear()` is safe), just not terminal. Evidence: `emitted AFTER shutdown(): ["after-shutdown"]`.

### 11. No validation of ids or timestamps on the produce path; one bad value kills the whole batch
- **Where:** `packages/opentelemetry/src/to-otlp.ts:30-32`, `:124` (raw `txn.traceId`), `:138` (raw `s.spanId`); batch assembly at `otlp-exporter.ts:32`.
- `toUnixNanoString(NaN | ±Infinity)` throws `RangeError` from `BigInt()`, and because `toOtlpExportRequest` maps the whole batch eagerly, **one malformed transaction rejects the entire export** (confirmed). Trace/span ids are passed through with no 32/16-hex or non-zero check, so a malformed id from a manual-API caller or an exotic host span ships as-is. Related: a consumed span with `endTime: [0,0]` yields `end_time_unix_nano < start_time_unix_nano` (`span-processor.ts:40` → `to-otlp.ts:131`), which OTLP backends reject or render as negative duration. Realistically low-frequency (the SDK's own `Clock` and `defaultTraceId` are well-formed, and `parseTraceparent` validates), hence SEV3 — but the mapping is the last line of defence before a third-party wire.

### 12. `toAnyValue` emits a non-conformant `intValue` for large integers
- **Where:** `packages/opentelemetry/src/to-otlp.ts:45` — `Number.isInteger(value) ? { intValue: String(value) } : ...`.
- `Number.isInteger(1e21)` is `true`, and `String(1e21)` is `"1e+21"` — **not** a decimal integer string, so a strict OTLP receiver rejects the value (and 1e21 exceeds int64 range anyway). Confirmed: `1e21 -> {"intValue":"1e+21"}`. Integers between 2^53 and 2^63 are also silently imprecise. A `doubleValue` fallback outside the safe-integer range would be correct.

### 13. Instrumentation scope does not match Profile v1 §5
- **Where:** `packages/opentelemetry/src/to-otlp.ts:27` (`DEFAULT_SCOPE_NAME = '@bugsee/opentelemetry'`) and `packages/bugsee/src/wire.ts:164,172`.
- §5 requires `name = "com.bugsee.<sdk>/<providerId>"` and `version = <SDK version>`. The umbrella gets the **name** right (`com.bugsee.webjs/performance`), but `version` is never set on either path, and the package default used by anyone calling `createOtlpTraceExporter` directly is the non-conformant `@bugsee/opentelemetry`. Evidence: `scope = {"name":"@bugsee/opentelemetry"}`.

### 14. `Span.trace_state` is never emitted
- **Where:** `packages/opentelemetry/src/otlp-wire.ts:44-56` — the `OtlpSpan` shape has no `traceState` field.
- The OTLP `Span` carries an optional `trace_state`; the `bugsee=` vendor entry that Profile v1 §12 defines and that `@bugsee/capture` faithfully propagates on the wire is therefore dropped on the OTLP export path. Optional in the spec, so not a conformance break — but the session-correlation id (`s<id>`) that §12 exists to carry never reaches the customer's backend.

### 15. Performance span attributes bypass the core `filters` redaction service
- **Where:** `packages/opentelemetry/src/to-otlp.ts:132` / `:147-151` spread `txn.attributes` / `s.attributes` verbatim into the third-party POST; `packages/performance/src/*.ts` contains no reference to `filters` or redaction (verified by grep).
- **Bounded, not a leak today:** the SDK's own auto-instrumentation is careful — `packages/performance/src/http-spans.ts:117` strips query and fragment (`start.url.replace(/[?#].*$/, '')`) and the attribute set at `:118-123` is a narrow allowlist (`http.method`, `http.mechanism`, `http.status_code`, `bugsee.server_span_id`) with no headers, bodies or user ids. So the confirmed `@bugsee/capture` credential-leak surface is **not** inherited here. The residual gap is that anything a user sets via the manual `span.setAttribute()` API is exported to a third-party endpoint with **no scrubbing pass at all**, unlike every other egress path in the SDK. Worth an explicit redaction hook on the OTLP send rather than relying on the narrowness of today's producers.

### 16. Test strength: no runtime test exercises the real OTel SDK; two surviving mutations
- **Where:** `packages/opentelemetry/src/span-processor.test.ts` (hand-rolled `readable()` factory, `:9-25`); the only real-OTel contact is the type-level `span-processor.test-d.ts:1`.
- Both `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` are installed as devDeps, yet **no `.test.ts` imports them**. The hand-rolled mock is faithful to our assumptions — which is exactly why findings #2, #8 and #10 (all pure host-contract behaviours, all reproducible in ~10 lines against a real `BasicTracerProvider`) were never surfaced. The mock also uses non-W3C ids (`traceId: 'T'`, `spanId: 'c'`), so realistic id shapes are never exercised.
- **Surviving mutations** (16 injected, 14 caught):
  - **M3** — deleting `.toLowerCase()` from `deriveRootSpanId` (`to-otlp.ts:99`): **survived**. No test covers an uppercase trace id, though Profile §3 mandates lowercase hex.
  - **M13** — widening the exporter success boundary from `>= 300` to `>= 400` (`otlp-exporter.ts:41`): **survived**. No test pins the 3xx boundary, so a redirect being (mis)treated as a successful export would go unnoticed.
- Credit where due: the produce suite is otherwise genuinely strong — not theater. It uses full `toEqual` on complete span objects with pinned `*UnixNano` strings (`to-otlp.test.ts:164-200`), exact resource attribute arrays (`:330`, `:350`), and exact `flags` arrays (`:242`, `:247`). Mutations to timestamp units, id length, `intValue` string-vs-number, status mapping, kind mapping, the sampled flag, consume-side duration units, `hrTime` conversion, the parent-remap rule, resource-override ordering, the remote-parent rule and the assembler root rule were **all caught**.

---

## OTLP conformance audit

| field | spec requirement | what we emit | conformant? | file:line |
|---|---|---|---|---|
| `traceId` / `spanId` / `parentSpanId` | OTLP/JSON carve-out: **lowercase hex** strings, not base64 | hex strings, passed through / `slice(0,16).toLowerCase()` | ✅ (encoding) — but see SEV1 #1 for id *semantics*, and #11 for absence of validation | `otlp-wire.ts:1-5`, `to-otlp.ts:99,124,138` |
| id length / non-zero | trace 32 hex, span 16 hex, both non-zero (Profile §3) | never validated; upstream generators are correct | ⚠️ unvalidated | `to-otlp.ts:124,138` |
| `startTimeUnixNano` / `endTimeUnixNano` | uint64 as **decimal string** | `BigInt(Math.round(ms)) * 1_000_000n` → `.toString()` — no 2^53 loss | ✅ type; ❌ §6 value rule (SEV2 #5) | `to-otlp.ts:30-32,130-131` |
| `status.code` | enum `{0 UNSET, 1 OK, 2 ERROR}` numeric | numeric enum; `message` only on ERROR | ✅ | `to-otlp.ts:65-69`, `otlp-wire.ts:18-22` |
| `kind` | enum 0–5, numeric | numeric; explicit kind always emitted (never UNSPECIFIED) | ✅ (matches §6 mapping) | `to-otlp.ts:71-91` |
| attribute `AnyValue` | one-of `stringValue`/`boolValue`/`intValue`(string)/`doubleValue`/`arrayValue`/`kvlistValue` | string/bool/int-as-string/double; **arrays & objects → JSON `stringValue`** | ⚠️ lossy but legal; `intValue` malformed ≥1e21 (SEV3 #12) | `to-otlp.ts:35-51` |
| `flags` | low 8 bits = W3C trace flags; bit 0 = sampled | `1` when `txn.sampled` else `0`, on root **and** children | ✅ (Profile §8) | `to-otlp.ts:109,134,153`, `otlp-wire.ts:58-59` |
| `Resource.attributes` | §4 MUST list | only `telemetry.sdk.name` + `bugsee.profile.version` | ❌ SEV2 #4 | `to-otlp.ts:183-189` |
| `ScopeSpans.scope` | §5 `com.bugsee.<sdk>/<providerId>` + version | umbrella name ✅; version never set; package default non-conformant | ⚠️ SEV3 #13 | `to-otlp.ts:27,174-177`, `wire.ts:164` |
| `Span.traceState` | optional | never emitted | ⚠️ SEV3 #14 | `otlp-wire.ts:44-56` |
| `events` / `links` / `droppedAttributesCount` | optional in proto3 | omitted | ✅ | `otlp-wire.ts:44-56` |
| envelope | `resourceSpans[].scopeSpans[].spans[]` | correct nesting; `{resourceSpans: []}` for an empty batch | ✅ | `to-otlp.ts:168-194` |
| Content-Type | `application/json` | set, lowercase-mergeable | ✅ | `otlp-exporter.ts:38` |
| `Content-Encoding: gzip` | SHOULD (§2) | not implemented | ⚠️ minor |`otlp-exporter.ts:36-40` |

**Not inherited from `@bugsee/protocol`:** I specifically checked for the two known SEV1s. `status` here is emitted as a **numeric** OTLP enum (`OtlpStatusCode`, `to-otlp.ts:66-68`), so the `logLevelToWire` string-vs-numeric class of mismatch does **not** recur on this path; and this package never touches `NetworkStage`, so the dropped websocket/event encoding has no blast radius here. Severity/status mapping is conformant with Profile §6 including the lossless `bugsee.span.status` round-trip (`to-otlp.ts:117`, `from-otlp.ts:30-38`).

---

## W3C traceparent/tracestate robustness

**There is no traceparent/tracestate code in this package** — the single implementation is `@bugsee/capture` (`traceparent.ts:71-92`, `tracestate.ts:22-69`), consumed by `@bugsee/node` and the seven backend adapters. **No divergent second parser exists**, so the "two parsers that disagree" finding does not apply. I exercised the real parser against hostile input:

| input | spec behavior | our behavior | file:line |
|---|---|---|---|
| `00-0af7…19c-b7ad6b7169203331-01` (valid) | parse | `{traceId, spanId, sampled:true}` ✅ | `traceparent.ts:91` |
| all-zero trace id | **reject** | `undefined` ✅ | `traceparent.ts:82` |
| all-zero span id | **reject** | `undefined` ✅ | `traceparent.ts:85` |
| version `ff` | **reject** (forbidden) | `undefined` ✅ | `traceparent.ts:79` |
| trace id 30 hex (wrong length) | reject | `undefined` ✅ | `traceparent.ts:82` |
| non-hex char (`…319g`) | reject | `undefined` ✅ | `traceparent.ts:82` |
| future version `01-…-01-extra` | **accept**, parse first 4 fields | parsed ✅ (correct forward-compat) | `traceparent.ts:75-78` |
| `''` / non-string | reject | `undefined` ✅ | `traceparent.ts:72-79` |
| malformed / duplicate `tracestate` member | skip, first wins | skipped + deduped, never throws ✅ | `tracestate.ts:33-43` |
| 32-entry / 512-byte caps | cap, drop oldest | both enforced; own entry never dropped ✅ | `tracestate.ts:15-16,29-31,63-68` |
| `bugsee=` on mutation | move to front, preserve others | ✅ | `tracestate.ts:57-69` |

Malformed inbound input degrades to a fresh root and never throws or propagates garbage — as specified. **Sampled-flag propagation end-to-end is consistent:** inbound `flags & 1` (`traceparent.ts:91`) → `RequestContext.sampled` → `TransactionWire.sampled` → OTLP `flags` bit 0 **and** the `bugsee.sampled` attribute (`to-otlp.ts:109,116`) → outbound `traceparent` flags (`traceparent.ts:152`). Clean.

---

## Profile v1 conformance

The profile **was accessible** and read in full (`~/Projects/Bugsee/dev-docs/bugsee-otlp-profile-v1.md`, 221 lines, read-only, unmodified).

| § | requirement | status |
|---|---|---|
| §2 | OTLP/HTTP+JSON, hex ids not base64 | ✅ |
| §2 | SHOULD `Content-Encoding: gzip` | ❌ not implemented |
| §3 | ids 32/16 lowercase hex, non-zero | ⚠️ generators conform; mapping never validates; **root span id is fabricated** (SEV1 #1) |
| §4 | resource MUST list | ❌ 4 of 6 missing (SEV2 #4) |
| §5 | scope `com.bugsee.<sdk>/<providerId>` + version | ⚠️ name ✅ via umbrella; version ❌; package default ❌ |
| §6 | root span IS the transaction; `bugsee.transaction.name` + `bugsee.sampled` on root | ✅ `to-otlp.ts:115-116` |
| §6 | kind mapping (`http.client`→CLIENT, server→SERVER, default INTERNAL, `bugsee.span.kind` overrides) | ✅ `to-otlp.ts:83-91` |
| §6 | status mapping + `bugsee.span.status` lossless | ✅ `to-otlp.ts:65-69,117` |
| §6 | `end = start + monotonic duration (nanos)` | ❌ uses rounded wall-clock end (SEV2 #5) |
| §7 | snapshot: `bugsee.snapshot=true`, end omitted or `== start` | ✅ `to-otlp.ts:121,131` (takes the permitted `== start` branch) |
| §8 | `trace_flags` sampled bit MUST mirror `bugsee.sampled` | ✅ `to-otlp.ts:109` |
| §10 | Bugsee-specific data under `bugsee.*` | ✅ throughout |
| §12 | W3C propagation + `bugsee=` (`r`,`s`), 32/512 caps, allowlist | ✅ in `@bugsee/capture` (see table above) |
| §12 | inbound: missing/invalid → fresh root | ✅ |
| §14 | tolerate generic third-party OTLP (consume side) | ✅ `from-otlp.ts:75-77` treats consumed spans as sampled, as specified |
| §15 | `bugsee.profile.version = "1"` | ✅ `to-otlp.ts:187` |

---

## Host OTel pipeline safety

- **Processor contract:** `onStart`/`onEnd`/`forceFlush`/`shutdown` are all present and the object is structurally assignable to OTel's `SpanProcessor` (type-guarded at `span-processor.test-d.ts:16`, and it does register successfully on a real `BasicTracerProvider`). But `forceFlush` does not flush (SEV2 #8) and `shutdown`, while idempotent, does not render the processor inert (SEV3 #10).
- **Throw containment:** ❌ **absent** — SEV1 #2. Confirmed against the real SDK that a throw reaches application code and starves later processors.
- **In-place mutation of host spans:** ✅ **clean.** `readableSpanToConsumed` only reads (`span-processor.ts:45-64`), and `consumedAttributes` spreads into a fresh object (`from-otlp.ts:44-50`). Verified empirically: a real span's `attributes` were byte-identical before and after consumption. One minor note — `span-processor.ts:62` stores a *reference* to the host's attributes object, which the assembler then retains for up to 30 s; no mutation, but it does pin host objects alive.
- **Version compatibility:** ✅ **good.** The package has **no runtime `@opentelemetry/*` import at all** (structural types only, `span-processor.ts:6-11`), so it works with any OTel major. Both the 1.x `parentSpanId` and 2.x `parentSpanContext` parent shapes are handled with the right precedence (`span-processor.ts:48-49`), which I confirmed against real sdk-trace-base 2.7.1 (`'parentSpanId' in span` → `false`, `'parentSpanContext' in span` → `true`; the parent id resolved correctly). The remote-parent→local-root normalization is also correct and mutation-covered.
- **Peer deps:** ✅ correct — `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` are declared as peers with `peerDependenciesMeta.optional: true` (`package.json:35-46`) and only devDeps otherwise. Produce-only users install nothing; the package no-ops cleanly with no OTel present.
- **Resource safety on export:** no retry, no backoff, no timeout, no request-size cap, no gzip (`otlp-exporter.ts:27-45`). Reachability of the endpoint is entirely the injected transport's problem; a slow collector holds the returned promise, and the umbrella's `teeSend` (`wire.ts:124-132`) uses `Promise.allSettled` so a hanging OTLP export does **not** block the Bugsee upload — good — but it does keep the batch's promise pending. Failures surface to `onError` and the batch is dropped (already drained), so an unreachable endpoint loses data silently rather than leaking memory.

---

## Privacy on the export path

**Not bypassed today, but unguarded by construction.** The OTLP exporter POSTs `txn.attributes` and each span's `attributes` verbatim to a customer-configured third-party endpoint (`to-otlp.ts:132,147-151` → `otlp-exporter.ts:36-40`) with **no redaction pass** — `packages/performance` contains no reference to the core `filters` service (verified by grep).

The saving grace is that today's producers are narrow and careful: `http-spans.ts:117` strips query strings and fragments from the URL before it becomes a span description, and the attribute set (`http-spans.ts:118-123`) is a fixed allowlist of `http.method`, `http.mechanism`, `http.status_code` and `bugsee.server_span_id` — **no headers, no bodies, no user ids, no cookies.** So the confirmed `@bugsee/capture` credential-leak surface is **not** inherited on this path, and I did not find a live leak. The gap is structural rather than actual: this is the only egress in the SDK with no scrubbing seam, so any future attribute producer — or any customer using the manual `span.setAttribute()` API to stamp a user id or a signed URL — ships unredacted to a third party. Recorded as SEV3 #15; recommend a `filters`-backed hook on the exporter before the manual span API is promoted.

---

## Checked and found clean

- **Id encoding is hex, not base64** — the classic total break is correctly avoided and explicitly documented (`otlp-wire.ts:1-5`).
- **`*UnixNano` are decimal STRINGS via `BigInt`, not JS numbers** — no 2^53 precision loss on the timestamp itself (`to-otlp.ts:30-32`); mutation to the unit factor was caught.
- **No duplicate/divergent `traceparent` parser in this package** — one spec-correct implementation in `@bugsee/capture`, validated against 8 hostile inputs including all-zero ids and version `ff`.
- **Sampled-flag propagation is consistent end-to-end** across inbound parse → transaction → OTLP `flags` → `bugsee.sampled` → outbound header.
- **Host span objects are never mutated in place** — verified empirically against real OTel spans.
- **OTel 1.x/2.x parent-shape handling is correct**, verified against real sdk-trace-base 2.7.1 (this is the kind of thing a hand-rolled mock usually gets wrong; here it happens to be right).
- **OTel is genuinely optional** — zero runtime `@opentelemetry/*` imports, correct optional peer-dep declaration, clean no-op when absent.
- **Consume does transform, not duplicate** — one Bugsee transaction per trace via the root-end policy (`trace-assembler.ts:76-82`); no double-emission and no re-entrant loop *within* the bridge. (The loop risk in SEV2 #7 is external, via the host's HTTP instrumentation.)
- **Profile resource constants are override-proof** — spread after the caller's resource (`to-otlp.ts:184-187`); mutation-covered.
- **Snapshot handling conforms to Profile §7** (`bugsee.snapshot` + `end == start`).
- **No inheritance of the `@bugsee/protocol` SEV1s** — status is a numeric enum here; `NetworkStage` is not on this path.
- **The produce test suite is not theater** — full `toEqual` on complete spans with pinned nano strings, exact resource/flags arrays; 14 of 16 injected mutations caught, including every unit, enum and id-length mutation.
- **`pnpm --filter @bugsee/opentelemetry exec tsc --noEmit` passes; 66/66 tests green; coverage gate (100% line/fn/stmt, ≥90% branch) passes.**
- **Repository left pristine** — `git status --short packages/` empty; all mutated files byte-compared against `cp` backups and the scratch test file removed.
