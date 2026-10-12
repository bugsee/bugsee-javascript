# @bugsee/elysia

Elysia adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for Elysia apps on Bun, Node.js and Deno.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Elysia apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/elysia
# or
pnpm add @bugsee/bugsee @bugsee/elysia
# or
yarn add @bugsee/bugsee @bugsee/elysia
```

Requires Node.js 18 or newer where run on Node.js. No peer dependency is declared: the adapter only uses the shape of your `elysia` app.

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupElysia`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupElysia } from "@bugsee/elysia";
import { Elysia } from "elysia";

launch("YOUR_APP_TOKEN");

const app = new Elysia();
setupElysia(app);
// ... your routes ...
```

If your Elysia app type does not unify with the adapter's structural type, cast it:

```ts
import { type ElysiaAppLike, setupElysia } from "@bugsee/elysia";

setupElysia(app as unknown as ElysiaAppLike);
```

## What it does

Elysia hooks are additive, so `setupElysia` adds three without replacing yours:

- `onRequest` opens a per-request context, continues an inbound W3C `traceparent` and starts an `http.server` transaction.
- `onError` reports server errors (a plain throw or a 5xx status) and skips framework control flow such as `NOT_FOUND` and `VALIDATION`.
- `mapResponse` finishes the transaction without altering the response.

Register it on the Elysia instance that owns your routes, because hooks are scoped per instance. On Node.js, Elysia's `.listen` is not supported: use the fetch handler (`app.fetch`). On Bun the full server works.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupElysia`:

- `user`: `(c) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/elysia
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
