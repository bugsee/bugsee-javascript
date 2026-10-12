# @bugsee/fastify

Fastify adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for Fastify apps on Node.js, Bun and Deno.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Fastify apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/fastify
# or
pnpm add @bugsee/bugsee @bugsee/fastify
# or
yarn add @bugsee/bugsee @bugsee/fastify
```

Requires Node.js 18 or newer. No peer dependency is declared: the adapter only uses the shape of your `fastify` instance.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupFastify`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupFastify } from "@bugsee/fastify";
import Fastify from "fastify";

launch("YOUR_APP_TOKEN");

const app = Fastify();
setupFastify(app);
// ... your routes ...
await app.listen({ port: 3000 });
```

## What it does

`setupFastify` installs lifecycle hooks that cover the whole app:

- `onRequest` opens a per-request context, continues an inbound W3C `traceparent` and starts an `http.server` transaction.
- `onError` reports an unhandled route error with the request context merged in.
- `onResponse` finishes the transaction with the route pattern and status.
- `onRequestAbort` finishes it as cancelled when the client aborts.

Call it on the root Fastify instance. Fastify hooks are encapsulated per scope, so they cover that instance and its child plugins. Order relative to your routes does not matter.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupFastify`:

- `user`: `(req) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/fastify
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
