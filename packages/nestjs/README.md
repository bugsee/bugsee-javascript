# @bugsee/nestjs

NestJS adapter — a backend binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `@nestjs/common`, `@nestjs/core` and `rxjs` are **peer**
dependencies. Works on both the **express-** and **fastify-**based Nest platforms.

```ts
// main.ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupNest } from '@bugsee/nestjs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

launch(appToken);

const app = await NestFactory.create(AppModule);
setupNest(app, {
  // privacy-safe, opt-in: return the end-user identity for reports during this request
  user: (req) => {
    const h = req.headers['x-user'];
    return typeof h === 'string' ? h : undefined;
  },
});
await app.listen(3000);
```

## What it does

A single `setupNest(app)` call installs, over the same foundation as `@bugsee/express` / `@bugsee/fastify`:

- A **context middleware** (`app.use`) that opens a per-request context (via the store's `enterWith`, so
  it works across the Fastify body-parse async boundary too) — registered first, so even guard-phase
  capture attributes to the request.
- A **global interceptor** (default) that starts an `http.server` APM transaction (when the
  `@bugsee/performance` extension is wired), continues an inbound W3C `traceparent`, and — on a thrown
  error — reports it (mechanism `http-error`) **then re-throws it untouched**, so Nest's own exception
  filters format the response exactly as before.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key, so a viewer can focus the recording on one
request while the full picture stays available.

## Choosing the error-capture seam

NestJS gives two places to catch errors, with different coverage (empirically mapped — see the design
doc). Pick via `errorCapture`:

| `errorCapture` | Catches | Notes |
| --- | --- | --- |
| `'interceptor'` (default) | route handler, services, pipes | Non-intrusive: report + re-throw, no `@nestjs/core` import, never conflicts with your own filter. Does **not** see errors thrown in **guards** (which are almost always expected `401`/`403`s, skipped anyway). |
| `'filter'` | **also guards** + pipes | A global `ExceptionFilter` (broadest coverage). Imports `@nestjs/core`; being a catch-all it can collide with your own global filter — see below. |
| `'both'` | everything above | Interceptor + filter, **deduped** (an error seen by both is reported once). |

```ts
setupNest(app, { errorCapture: 'both' });
```

**If you already have your own global exception filter**, don't use `'filter'`/`'both'` (two catch-all
filters collide). Instead decorate your filter's `catch` method:

```ts
import { BugseeExceptionCaptured } from '@bugsee/nestjs';

@Catch()
export class MyFilter extends BaseExceptionFilter {
  @BugseeExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost) { /* your handling */ }
}
```

The building blocks (`createBugseeMiddleware`, `BugseeInterceptor`, `BugseeExceptionFilter`) are also
exported for DI-style wiring (`APP_INTERCEPTOR` / `APP_FILTER`).

## Which errors are reported

By default, only **genuine unhandled errors** — a Nest `HttpException` (4xx *and* 5xx — deliberate control
flow) is skipped. Override with `shouldReport: (err) => boolean`.

## Behavior guarantees

- **Opt-in** — with no SDK launched, `setupNest` is a transparent no-op.
- **Never breaks the app** — every adapter step is guarded; the interceptor re-throws the original error
  and the filter delegates to `super.catch()`, so Nest's response is unchanged.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.

**Status:** implemented + tested (incl. real-Nest e2e on both the express and fastify platforms: the
seam-coverage matrix, the 4xx-skip policy, cross-seam dedup, response preservation, and concurrency
isolation). Built test-first per `docs/implementation-standards.md`.
