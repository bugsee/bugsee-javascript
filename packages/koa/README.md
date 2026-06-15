# @bugsee/koa

Koa middleware adapter — a backend binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `koa` is a **peer** (structural types only — the adapter never
imports koa). Works on node/bun/deno-hosted Koa (wherever the launched `@bugsee/node` client provides the
context store).

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupKoa } from '@bugsee/koa';
import Koa from 'koa';

launch(appToken);

const app = new Koa();
setupKoa(app, { user: (ctx) => ctx.headers['x-user'] }); // install FIRST, before your routes
// ... your middleware / routes ...
app.listen(3000);
```

## What it does

`setupKoa(app)` installs one middleware (install it first so it wraps the whole chain):

- opens a per-request context (`store.run` wraps `next()`), continues an inbound W3C `traceparent`, and
  starts an `http.server` APM transaction (when `@bugsee/performance` is wired);
- Koa's compose propagates a downstream throw up through `await next()`, so the middleware **catches** the
  error, reports it (mechanism `http-error`), then **re-throws** it untouched — Koa's own `onerror` still
  formats the response;
- finishes the transaction with the route-parametrized name + status.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key.

## Which errors are reported

By default, only **genuine errors** — a plain throw (no status, → 500) or a 5xx is reported; a 4xx
(`ctx.throw(404)`, etc.) is expected control flow and is skipped. Override with
`shouldReport: (err) => boolean`. The matched route comes from `ctx._matchedRoute` (set by `@koa/router`);
without a router it falls back to `ctx.path`.

## Behavior guarantees

- **Opt-in** — with no SDK launched, the middleware is a transparent pass-through.
- **Never breaks the app** — the only thing it re-throws is the original downstream error; it never alters
  Koa's response.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.

**Status:** implemented + tested (incl. a real-Koa e2e: error reporting, 4xx skip, response preservation,
concurrency isolation). Built test-first per `docs/implementation-standards.md`.
