# @bugsee/opentelemetry

OpenTelemetry interop for the Bugsee JS SDK — a pluggable extension (Tier 3), not part of the core.

Two-way bridge (see `docs/design/opentelemetry-integration.md`):

- **Produce** — map Bugsee performance transactions (§8.8) to OTLP/HTTP-JSON and export to any OTel
  collector/endpoint. *(Phase A: the mapping core — built. Phase B: the exporter.)*
- **Consume** — a `SpanProcessor`/`SpanExporter` bridge that maps the user's OTel spans into Bugsee.
  *(Phase C; peer `@opentelemetry/sdk-trace-base`.)*
- **Propagate** — W3C `traceparent` on outgoing requests via the interception-transformer seam.
  *(Phases T + D.)*

The runtime-portable mapping core has **no `@opentelemetry/*` dependencies** — OTLP/JSON is hand-rolled;
OTel SDK deps are peers introduced only by the per-runtime wiring of later phases.
