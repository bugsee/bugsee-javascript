---
'@bugsee/opentelemetry': minor
'@bugsee/nextjs': minor
---

Support OpenTelemetry JS 3.x (issue #94).

OpenTelemetry JS 3.0 removed `@opentelemetry/sdk-trace-base` and replaced it with `@opentelemetry/sdk-trace`, and `@opentelemetry/api` 1.10 widened span attributes to the spec's `AnyValue`. Both packages now declare `@opentelemetry/sdk-trace` (`>=3`) as an optional peer next to `@opentelemetry/sdk-trace-base` (now `>=1.0.0 <3`). Both stay optional: produce-only users install neither. On OpenTelemetry 3 register the processor with `new TracerProvider({ spanProcessors: [processor] })` from `@opentelemetry/sdk-trace` (the class was renamed from `BasicTracerProvider`). OpenTelemetry 3 itself needs Node.js 22.15 or newer; `@bugsee/opentelemetry` does not import OpenTelemetry and still runs on the Node versions the SDK supports.

`@bugsee/nextjs` zero-config provider now falls back to `@opentelemetry/sdk-trace` when `sdk-trace-base` is not installed. Before, an OpenTelemetry 3 install silently left the zero-config provider `unavailable`.

Consumed span attributes that are complex `AnyValue`s are now mapped deliberately instead of being passed through raw: scalars and homogeneous scalar arrays are unchanged, and nested maps, mixed or nested arrays and byte arrays become one bounded JSON string (bytes as base64), so span redaction (`setSpanFilter`, the `db.statement` scrub) keeps seeing strings. `null`, `undefined`, functions and symbols drop the attribute. A `bigint` attribute becomes a number when exact and decimal text otherwise (it used to reach the transaction as a value JSON cannot serialize). The serializer never throws and caps depth (8), visited nodes (1024) and length (8192 characters). On OTLP export a byte array is now sent as `bytesValue` (base64), and an object attribute with a cycle or a bigint no longer throws while it is encoded.

New exports from `@bugsee/opentelemetry`: `normalizeAttributes`, `normalizeAttributeValue`, `stringifyAnyValue` and the `MAX_ATTRIBUTE_*` limits.
