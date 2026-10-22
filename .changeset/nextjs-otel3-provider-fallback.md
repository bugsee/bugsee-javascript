---
'@bugsee/nextjs': minor
---

The zero-config OpenTelemetry provider now falls back to `@opentelemetry/sdk-trace` (its `TracerProvider`) when `@opentelemetry/sdk-trace-base` is not installed. OpenTelemetry JS 3 removed `sdk-trace-base`, so before this an OpenTelemetry 3 install silently left the zero-config provider `unavailable`. `sdk-trace-base` is still preferred when both are installed, so OpenTelemetry 1.x/2.x installs behave as before.

`@opentelemetry/sdk-trace` (`>=2.9.0`) is now declared as an optional peer next to `@opentelemetry/sdk-trace-base` (`>=1.0.0 <3`).
