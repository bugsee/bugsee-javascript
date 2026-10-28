# @bugsee/nestjs

NestJS adapter for the Bugsee SDK: per-request context, `http.server` tracing and error reporting for NestJS apps, on both the Express and Fastify platforms.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in NestJS apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. The umbrella resolves to the Node build automatically.

## Install

```sh
npm install @bugsee/bugsee @bugsee/nestjs
# or
pnpm add @bugsee/bugsee @bugsee/nestjs
# or
yarn add @bugsee/bugsee @bugsee/nestjs
```

Requires Node.js 18 or newer. Peer dependencies: `@nestjs/common` and `@nestjs/core` (`^9 || ^10 || ^11 || ^12`), and `rxjs` (`^7`).

## Usage

Call `launch()` as early as possible, at the top of your server entry. On a server it returns the client directly. Then pass your app to `setupNest`.

```ts
// server.ts
import { launch } from "@bugsee/bugsee";
import { setupNest } from "@bugsee/nestjs";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

launch("YOUR_APP_TOKEN");

const app = await NestFactory.create(AppModule);
setupNest(app);
await app.listen(3000);
```

## What it does

`setupNest` installs a context middleware (opens a per-request context) and, by default, a global interceptor that starts an `http.server` transaction, continues an inbound W3C `traceparent`, and reports a thrown error before re-throwing it untouched, so Nest's own exception filters still format the response.

## Choosing the error-capture seam

Pick where errors are caught with the `errorCapture` option:

| `errorCapture` | Catches | Notes |
| --- | --- | --- |
| `'interceptor'` (default) | route handlers, services, pipes | Report and re-throw. Never conflicts with your own filter. Does not see errors thrown in guards. |
| `'filter'` | also guards | A global `ExceptionFilter`. Being a catch-all, it can collide with your own global filter. |
| `'both'` | everything above | Interceptor and filter, deduplicated so an error is reported once. |

```ts
setupNest(app, { errorCapture: "both" });
```

If you already have your own global exception filter, decorate its `catch` method instead of using `'filter'` or `'both'`:

```ts
import { BugseeExceptionCaptured } from "@bugsee/nestjs";

@Catch()
export class MyFilter extends BaseExceptionFilter {
  @BugseeExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost) {
    /* your handling */
  }
}
```

By default a Nest `HttpException` (4xx and 5xx, deliberate control flow) is not reported.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones on a server:

- `instrumentIncomingRequests`: auto-instrument incoming HTTP requests (default `true`).
- `captureLocalVariables`: attach local variables to the crash frames of reported errors (default `false`).
- `captureSourceContext`: attach source lines around crash frames (default `false`).
- `detectHangs`: report event-loop hangs (default `true`).
- `profiling`: rolling CPU profiling (default `false`).

Adapter options, passed as the second argument of `setupNest`:

- `errorCapture`: `'interceptor'` (default), `'filter'` or `'both'`.
- `user`: `(req) => string | undefined`, the end-user identity for reports. Off by default.
- `shouldReport`: `(err) => boolean`, override which errors are reported.

This package also re-exports everything from `@bugsee/bugsee/node`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/nestjs
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
