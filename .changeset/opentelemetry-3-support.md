---
'@bugsee/opentelemetry': minor
'@bugsee/performance': minor
---

Support OpenTelemetry JS 3.x (issue #94).

OpenTelemetry JS 3.0 removed `@opentelemetry/sdk-trace-base` and replaced it with `@opentelemetry/sdk-trace`, and `@opentelemetry/api` 1.10 widened span attributes to the spec's `AnyValue`. `@bugsee/opentelemetry` and `@bugsee/nextjs` (peer ranges) now declare `@opentelemetry/sdk-trace` (`>=2.9.0`) as an optional peer next to `@opentelemetry/sdk-trace-base` (now `>=1.0.0 <3`); `sdk-trace` exists from 2.9 and exports the same `TracerProvider`. Both stay optional: produce-only users install neither. On OpenTelemetry 3 register the processor with `new TracerProvider({ spanProcessors: [processor] })` from `@opentelemetry/sdk-trace` (the class was renamed from `BasicTracerProvider`). OpenTelemetry 3 itself needs Node.js 22.15 or newer; `@bugsee/opentelemetry` does not import OpenTelemetry and still runs on the Node versions the SDK supports.

Complex span attributes (OpenTelemetry API 1.10 `AnyValue`) are now handled deliberately. Consumed scalars and small homogeneous scalar arrays are unchanged (a scalar string is capped at 32 KiB); a byte array becomes base64; a `bigint` becomes a number when exact and decimal text otherwise (it used to reach the transaction as a value JSON cannot serialize); `null`, `undefined`, functions and symbols drop the attribute; nested maps and mixed arrays become a bounded JSON-safe copy that the span sanitizer and `setSpanFilter` now see as a tree, so nested sensitive keys (`user: { password }`, `http.request.headers: { authorization }`) are redacted by default. What remains complex is flattened to a bounded JSON string when the transaction is recorded. The copy never throws and is bounded in work as well as size (leaf, key, node, depth and length caps). On OTLP export a byte array is sent as `bytesValue` (base64), and one hostile attribute (a Proxy that throws, a cycle, an enormous string) no longer rejects the whole export batch.

`createBugseeSpanProcessor` now ignores `onEnd` after `shutdown()`.

New exports from `@bugsee/performance` (also re-exported from `@bugsee/opentelemetry`): `normalizeAttributes`, `normalizeAttributeValue`, `flattenAttributes`, `stringifyAnyValue` and the `MAX_ATTRIBUTE_*` limits.
