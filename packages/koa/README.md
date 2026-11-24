# @bugsee/koa

Koa adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for Koa apps on Node.js and Bun.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Koa apps, on its own: it depends on `@bugsee/bugsee` and re-exports it, so `launch()` and the adapter API come from this one package. On Bun, also install `@bugsee/bugsee` and import `launch` from `@bugsee/bugsee/bun` (the Bun build, with performance monitoring), while `setup*` still comes from this package.

## Install

```sh
npm install @bugsee/koa
# or
pnpm add @bugsee/koa
# or
yarn add @bugsee/koa
```

Requires Node.js 18 or newer. No peer dependency is declared: the adapter only uses the shape of your `koa` app.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupKoa`.

```ts
// server.ts (Node.js)
import { launch, setupKoa } from "@bugsee/koa";
import Koa from "koa";

launch("YOUR_APP_TOKEN");

const app = new Koa();
setupKoa(app); // register first so it wraps the whole middleware chain
// ... your middleware and routes ...
app.listen(3000);
```

On Bun, import `launch` from the umbrella Bun entry instead (the rest of the file is unchanged):

```ts
// server.ts (Bun)
import { launch } from "@bugsee/bugsee/bun";
import { setupKoa } from "@bugsee/koa";
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

This package installs `@bugsee/bugsee` for you and re-exports everything from its Node entry, so you do not install or import it separately.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/koa
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
