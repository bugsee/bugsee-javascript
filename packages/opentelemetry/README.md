# @bugsee/opentelemetry

OpenTelemetry interop for the Bugsee JS SDK — a pluggable extension, not part of the core.

Two-way bridge:

- **Produce** — map Bugsee performance transactions to OTLP/HTTP-JSON and export to any OTel
  collector/endpoint.
- **Consume** — a `SpanProcessor`/`SpanExporter` bridge that maps the user's OTel spans into Bugsee.
  Uses `@opentelemetry/sdk-trace-base` as a peer dependency.
- **Propagate** — W3C `traceparent` on outgoing requests via the interception-transformer seam.

The runtime-portable mapping core has **no `@opentelemetry/*` dependencies** — OTLP/JSON is hand-rolled;
the OTel SDK packages are peers that only the per-runtime wiring depends on.
