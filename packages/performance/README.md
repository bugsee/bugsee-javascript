# @bugsee/performance

Performance monitoring (APM) for the Bugsee JavaScript SDK: web vitals, page-load and navigation transactions, HTTP spans and a manual span API, for browsers and Node.js.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

You do not need to install this package. It is a dependency of `@bugsee/bugsee` (and of `@bugsee/node` and the server adapters), and the umbrella's `launch()` switches it on by default. Install `@bugsee/bugsee` instead:

```bash
npm install @bugsee/bugsee
```

## Usage

```ts
import { launch } from '@bugsee/bugsee';

const bugsee = await launch('YOUR_APP_TOKEN', {
  performanceSampleRate: 0.5,
});

// Optional manual instrumentation on the launched client.
const transaction = bugsee.startTransaction('checkout', 'ui.action');
```

On a server, `launch()` returns the client directly (no `await` needed).

## Options

Pass these to `launch()` from `@bugsee/bugsee`:

- `performanceMonitoring`: master switch, default `true`. Set `false` to turn performance capture off.
- `performanceSampleRate`: head sampling rate from 0 to 1, default `1`.
- `performanceUploadMode`: `'batched'` (default) or `'realtime'`.
- `performanceFlushIntervalMs`: batched upload interval, default `30000`.
- `traceNavigations` and `traceInteractions` (browser): a transaction per route change and per slow user interaction, both default `true`.
- `propagateTrace` and `tracePropagationTargets`: send W3C `traceparent` headers to your own backend services to link frontend and backend traces. Off by default.

The bare platform packages (`@bugsee/browser`) do not wire this extension. Use the umbrella to get it.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/performance
- Bugsee: https://bugsee.com

## Navigation transaction names

A navigation detected from the URL is named after the location, passed through the SDK's location sanitizer (matrix session ids, secret-shaped path segments and any query are redacted; ordinary path segments, ids included, are kept). A name supplied by a framework adapter (`route`/`custom`, a router pattern) is kept as given.

## License

MIT. See the LICENSE file.
