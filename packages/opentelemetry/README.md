# @bugsee/opentelemetry

OpenTelemetry interop for the Bugsee JavaScript SDK: export Bugsee performance transactions as OTLP/HTTP JSON, and feed your own OpenTelemetry spans into Bugsee. Browsers and Node.js.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

You do not need to install this package. It is a dependency of `@bugsee/bugsee`, whose `launch()` wires it in when you set the options below. Install `@bugsee/bugsee` instead:

```bash
npm install @bugsee/bugsee
```

Consuming spans also needs your own OpenTelemetry SDK, all optional peers of this package:

| Your OpenTelemetry JS | Install |
| --- | --- |
| 1.x / 2.x | `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` |
| 3.x (Node.js 22.15 or newer) | `@opentelemetry/api` and `@opentelemetry/sdk-trace` (3.0 replaced `sdk-trace-base`) |

## Usage

Export finished transactions to your OTLP backend (Bugsee still receives them too):

```ts
import { launch } from '@bugsee/bugsee';

launch('YOUR_APP_TOKEN', {
  otelExportUrl: 'https://api.honeycomb.io/v1/traces',
  otelExportHeaders: { 'x-honeycomb-team': 'YOUR_KEY' },
  otelExportResource: { 'service.name': 'web' },
});
```

Consume your OpenTelemetry spans into Bugsee: Bugsee hands you a span processor, and you register it on your own `TracerProvider`.

```ts
import { launch, type BugseeSpanProcessor } from '@bugsee/bugsee';

await launch('YOUR_APP_TOKEN', {
  otelConsume: true,
  onOtelSpanProcessor: (processor: BugseeSpanProcessor) => {
    // Register `processor` on your OpenTelemetry TracerProvider.
    // How depends on your OpenTelemetry SDK version (for example the
    // `spanProcessors` constructor option of `BasicTracerProvider` from
    // `@opentelemetry/sdk-trace-base` on SDK 2.x, or of `TracerProvider` from
    // `@opentelemetry/sdk-trace` on 3.x).
  },
});
```

## Options

All of these require performance monitoring to stay on (the default):

- `otelExportUrl`, `otelExportHeaders`, `otelExportResource`: OTLP export target, headers and resource attributes.
- `otelConsume` and `onOtelSpanProcessor`: consume OpenTelemetry spans.
- `propagateTrace` and `tracePropagationTargets`: W3C `traceparent` propagation to your backend.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/opentelemetry
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
