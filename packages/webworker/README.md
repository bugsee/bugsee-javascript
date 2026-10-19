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

## App version and build

Reports carry the version and build of your app. The most direct way is to pass them to `launch`:

```js
launch('<app-token>', { appVersion: '2.4.1', appBuild: '381' });
```

Bugsee can also pick them up at build time. The Bugsee Vite and webpack plugins inject the constants `__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__` automatically when you give `appVersion` and `appBuild` to the plugin, or when `BUGSEE_APP_VERSION` and `BUGSEE_APP_BUILD` are set in the build environment. You can also define those two constants yourself in your bundler, or set `__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__` as globals before launching (for example `self.__BUGSEE_APP_VERSION__ = '2.4.1'`). Options passed to `launch` always win over the build-time values.

If no version can be found, Bugsee logs a single warning to the console and reports the version as `0.0.0` and the build as `0`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/webworker
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
