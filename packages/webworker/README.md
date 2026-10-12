# @bugsee/webworker

The Bugsee SDK for Web Workers (dedicated and shared) and Service Workers: console and network capture, and global error and unhandled-rejection reporting, in a worker context that has no DOM.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly, and call it from inside the worker script. Your page code keeps using `@bugsee/bugsee`; the worker needs its own launch because it is a separate JavaScript context.

## Install

```sh
npm install @bugsee/webworker
# or
pnpm add @bugsee/webworker
# or
yarn add @bugsee/webworker
```

## Usage

Web Worker. `launch()` returns the client directly (not a `Promise`):

```ts
// worker.ts
import { launch } from '@bugsee/webworker';

const bugsee = launch('YOUR_APP_TOKEN');
```

It captures console output, `fetch` and `WebSocket` traffic (also `XMLHttpRequest` in dedicated workers), and global `error` and `unhandledrejection` events on the worker.

Not captured, because a worker has no DOM: clicks, key presses, navigation, the view hierarchy and session replay.

## Service Workers

Pass `platformType: 'service-worker'`. A Service Worker is stopped when idle, so wrap event handlers with `withBugseeEvent`. It hands the upload to `event.waitUntil` so the worker stays alive until a report is sent.

```ts
// sw.ts
import { launch, withBugseeEvent } from '@bugsee/webworker';

const bugsee = launch('YOUR_APP_TOKEN', { platformType: 'service-worker' });

self.addEventListener(
  'fetch',
  withBugseeEvent(bugsee, (event) => {
    event.respondWith(fetch(event.request));
  }),
);
```

`withBugseeEvent` never changes your handler's outcome: your own error is rethrown, and SDK failures go to an optional third argument, `withBugseeEvent(bugsee, handler, (error) => console.debug(error))`.

## Options

- `platformType`: `'web-worker'` (default) or `'service-worker'`.
- `persist`: keep assembled report bundles in IndexedDB and re-upload any that a stopped worker left behind. Default `true` for Service Workers and `false` for Web Workers.
- `appVersion`, `appBuild`, `appId`: identify your release in reports.
- `captureLogs`, `captureNetwork`: capture streams, on by default.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/webworker
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
