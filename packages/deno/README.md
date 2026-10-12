# @bugsee/deno

The Bugsee SDK for Deno: crash and error capture, console and network capture, incoming `Deno.serve` request instrumentation, and on-disk capture with crash recovery.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Deno projects. It runs the same pipeline as `@bugsee/node` through Deno's `node:` compatibility layer and only changes how the runtime is identified in reports (`deno` and its version).

## Install

```sh
deno add npm:@bugsee/deno
```

Requires Deno 2.0 or newer. Core capture works on 2.0. The CPU profiler and the hang detector depend on Deno's Node compatibility and disable themselves where it is missing; they are fully available on Deno 2.8 and newer.

## Usage

Call `launch()` at the top of your entry file. It returns the client directly (not a `Promise`).

```ts
import { launch } from '@bugsee/deno';

const bugsee = launch('YOUR_APP_TOKEN', { appVersion: '1.0.0' });
```

Run with the permissions the SDK needs:

```sh
deno run --allow-net --allow-read --allow-write main.ts
```

`--allow-net` is for report upload. `--allow-read` and `--allow-write` are for on-disk capture and crash recovery (`dataDir`). If a permission is denied, the affected feature fails and the error goes to the `onError` callback instead of your app.

## Options

`launch(appToken, options)` accepts the same options as `@bugsee/node`. Common ones:

- `appVersion`, `appBuild`, `appId`: identify your release in reports.
- `captureLogs`, `captureNetwork`, `captureNetworkBodies`: capture streams, all on by default.
- `maxRecordingTime`: rolling recording window in seconds (default 60).
- `dataDir`: where the on-disk capture buffer lives (default `<os tmpdir>/bugsee`).
- `instrumentIncomingRequests`: automatic `Deno.serve` request instrumentation (on by default).
- `onError`: receives errors the SDK itself hits, such as denied permissions.

On Deno, local-variable capture (`captureLocalVariables`) is always off, and the event-loop lag traces are omitted, because Deno's debugger and event-loop APIs do not behave the way those features need.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/deno
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
