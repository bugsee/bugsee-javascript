# @bugsee/hono

Hono adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for Hono apps hosted on Node.js, Bun or Deno.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Hono apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/hono
# or
pnpm add @bugsee/bugsee @bugsee/hono
# or
yarn add @bugsee/bugsee @bugsee/hono
```

Requires Node.js 18 or newer. No peer dependency is declared: the adapter only uses the shape of your `hono` app. For Hono on edge runtimes, use the edge platform packages instead.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupHono`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupHono } from "@bugsee/hono";
import { Hono } from "hono";

launch("YOUR_APP_TOKEN");

const app = new Hono();
setupHono(app);
// ... your routes ...
```

## What it does

`setupHono` registers one middleware. Call it before your routes. It opens a per-request context, continues an inbound W3C `traceparent`, starts an `http.server` transaction, and after `next()` reports a handled error read from `c.error`. Your `app.onError` handler is not touched. A Hono `HTTPException` is treated as control flow and is not reported.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupHono`:

- `user`: `(c) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/hono
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
