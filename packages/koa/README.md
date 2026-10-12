# @bugsee/koa

Koa adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for Koa apps on Node.js, Bun and Deno.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Koa apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/koa
# or
pnpm add @bugsee/bugsee @bugsee/koa
# or
yarn add @bugsee/bugsee @bugsee/koa
```

Requires Node.js 18 or newer. No peer dependency is declared: the adapter only uses the shape of your `koa` app.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupKoa`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupKoa } from "@bugsee/koa";
import Koa from "koa";

launch("YOUR_APP_TOKEN");

const app = new Koa();
setupKoa(app); // register first so it wraps the whole middleware chain
// ... your middleware and routes ...
app.listen(3000);
```

## What it does

`setupKoa` installs one middleware. Register it before your other middleware. It opens a per-request context, continues an inbound W3C `traceparent`, starts an `http.server` transaction, and reports a downstream error before re-throwing it untouched, so Koa's own `onerror` still formats the response. By default a plain throw or a 5xx is reported and a 4xx (for example `ctx.throw(404)`) is skipped. With `@koa/router` the transaction is named after the matched route.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupKoa`:

- `user`: `(ctx) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/koa
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
