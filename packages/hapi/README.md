# @bugsee/hapi

hapi adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for @hapi/hapi servers on Node.js, Bun and Deno.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in hapi apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/hapi
# or
pnpm add @bugsee/bugsee @bugsee/hapi
# or
yarn add @bugsee/bugsee @bugsee/hapi
```

Requires Node.js 18 or newer. No peer dependency is declared: the adapter only uses the shape of your `@hapi/hapi` server.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupHapi`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupHapi } from "@bugsee/hapi";
import Hapi from "@hapi/hapi";

launch("YOUR_APP_TOKEN");

const server = Hapi.server({ port: 3000 });
setupHapi(server); // before server.start()
// ... your routes ...
await server.start();
```

## What it does

`setupHapi` registers two request extensions. They are additive and never replace yours:

- `onRequest` opens a per-request context, continues an inbound W3C `traceparent` and starts an `http.server` transaction.
- `onPreResponse` reports a Boom error and finishes the transaction. By default server errors (5xx) are reported and client errors (4xx) are skipped. The response itself is not altered.

A client disconnect finishes the transaction as cancelled.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupHapi`:

- `user`: `(req) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/hapi
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
