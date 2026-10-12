# @bugsee/express

Express adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for Express apps on Node.js, Bun and Deno.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Express apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/express
# or
pnpm add @bugsee/bugsee @bugsee/express
# or
yarn add @bugsee/bugsee @bugsee/express
```

Requires Node.js 18 or newer. No peer dependency is declared: the adapter only uses the shape of your `express` app.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupExpress`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupExpress } from "@bugsee/express";
import express from "express";

launch("YOUR_APP_TOKEN");

const app = express();
setupExpress(app);
// ... your routes ...
app.listen(3000);
```

`setupExpress` installs the request middleware immediately. It appends the error handler on the first request, by which point your routes are registered, so it lands last.

If you have your own error-response middleware, place Bugsee's handler explicitly before yours:

```ts
import { setupExpress, setupExpressErrorHandler } from "@bugsee/express";

setupExpress(app, { autoErrorHandler: false });
// ... your routes ...
setupExpressErrorHandler(app); // reports, then calls next(err)
app.use((err, req, res, next) => {
  /* your error response */
});
```

The two middlewares are also exported as `requestHandler()` (mount first) and `errorHandler()` (mount after your routes) for full control over placement.

## What it does

- Opens a per-request context, so anything reported inside a route is attributed to that request and stays isolated across concurrent requests.
- Continues an inbound W3C `traceparent` and records an `http.server` transaction named after the route pattern.
- Reports unhandled route errors with the request context merged in, then re-throws them through `next(err)`.
- With no SDK launched, the middleware is a transparent no-op.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupExpress`:

- `user`: `(req) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported. By default errors with no status or a 5xx status are reported and 4xx are skipped.
- `autoErrorHandler`: set `false` to place the error handler yourself.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/express
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
