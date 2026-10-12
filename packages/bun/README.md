# @bugsee/bun

The Bugsee SDK for Bun: crash and error capture, console and network capture, incoming `Bun.serve` request instrumentation, and on-disk capture with crash recovery.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Bun projects. It runs the same pipeline as `@bugsee/node` and only changes how the runtime is identified in reports (`bun` and its version).

## Install

```sh
bun add @bugsee/bun
```

Also works with `npm install @bugsee/bun` and `pnpm add @bugsee/bun`. The SDK is tested on Bun 1.3.

## Usage

Call `launch()` at the top of your entry file. It returns the client directly (not a `Promise`).

```ts
import { launch } from '@bugsee/bun';

const bugsee = launch('YOUR_APP_TOKEN', { appVersion: '1.0.0' });
```

## Options

`launch(appToken, options)` accepts the same options as `@bugsee/node`. Common ones:

- `appVersion`, `appBuild`, `appId`: identify your release in reports.
- `captureLogs`, `captureNetwork`, `captureNetworkBodies`: capture streams, all on by default.
- `maxRecordingTime`: rolling recording window in seconds (default 60).
- `dataDir`: where the on-disk capture buffer lives (default `<os tmpdir>/bugsee`).
- `detectHangs`: event-loop hang detection.
- `profiling`: attach a rolling CPU profile to reports (off by default).

- `instrumentIncomingRequests`: automatic `Bun.serve` request instrumentation (on by default).

Local-variable capture (`captureLocalVariables`) is always off on Bun, because the runtime does not provide the debugger API it needs.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/bun
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
