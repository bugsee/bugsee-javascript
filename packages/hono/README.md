# @bugsee/hono

Hono middleware adapter — a backend binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `hono` is a **peer** (structural types only — the adapter never
imports `hono`). Works on node/bun/deno-hosted Hono (wherever the launched `@bugsee/node` client provides
the context store; edge/Workers follow the edge platform packages).

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupHono } from '@bugsee/hono';
import { Hono } from 'hono';

launch(appToken);

const app = new Hono();
setupHono(app, { user: (c) => c.req.header('x-user') }); // one call, before your routes
// ... your routes ...
```

## What it does

A single `setupHono(app)` call registers one middleware that:

- opens a per-request context (`store.run` wraps `next()`, so the whole chain is correlated), continues an
  inbound W3C `traceparent`, and starts an `http.server` APM transaction (when the `@bugsee/performance`
  extension is wired);
- after `next()` resolves, reports a handled error (mechanism `http-error`) read from **`c.error`** — Hono's
  `compose` routes a thrown handler error to `app.onError` before it would reach the middleware, so the
  error is observed via `c.error`, **not** by wrapping your `onError` (your error handler is untouched);
- finishes the transaction with the route-parametrized name + the final response status.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key.

## Which errors are reported

By default, only **genuine unhandled errors** — a Hono `HTTPException` (duck-typed by its `getResponse()`
method) is deliberate control flow and is skipped. Override with `shouldReport: (err) => boolean`.

## Behavior guarantees

- **Opt-in** — with no SDK launched, the middleware is a transparent pass-through.
- **Never breaks the app** — every step is guarded; the middleware only observes (it does not alter the
  response or your `onError`).
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.

**Status:** implemented + tested (incl. a real-Hono e2e via `app.request`: error reporting, HTTPException
skip, response preservation, concurrency isolation). Built test-first per `docs/implementation-standards.md`.
