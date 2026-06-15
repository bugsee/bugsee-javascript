# @bugsee/elysia

Elysia adapter — a backend binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `elysia` is a **peer** (structural types only — the adapter never
imports `elysia`). Works on node/bun/deno-hosted Elysia (wherever the launched `@bugsee/node` client
provides the context store).

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupElysia, type ElysiaAppLike } from '@bugsee/elysia';
import { Elysia } from 'elysia';

launch(appToken);

const app = new Elysia();
// Elysia's hook methods are deeply generic and don't unify with a structural interface, so a cast is
// needed (the app does have onRequest/onError/mapResponse):
setupElysia(app as unknown as ElysiaAppLike, { user: (c) => c.request.headers.get('x-user') ?? undefined });
// ... your routes ...
```

## What it does

Elysia's lifecycle hooks are **additive** (registering ours never replaces yours), so `setupElysia(app)`
adds three hooks over the foundation:

- **`onRequest`** — opens a per-request context (via the store's `enterWith`, since the hook returns before
  the route handler runs), continues an inbound W3C `traceparent`, and starts an `http.server` APM
  transaction (when `@bugsee/performance` is wired).
- **`onError`** — reports a **genuine** error (mechanism `http-error`). Elysia classifies errors via
  `code`: a plain throw is `'UNKNOWN'`, a `status(n)` throw is the number `n`, and framework control flow is
  a named code (`NOT_FOUND` / `VALIDATION` / `PARSE` / …). We report server errors (`UNKNOWN` / 5xx) and skip
  the rest; override with `shouldReport: (err) => boolean`.
- **`mapResponse`** — fires last for both success and error; finishes the transaction (route-parametrized
  name + outcome) and returns nothing, so it never alters the response.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key.

## Notes

- **Register on the instance that owns your routes** — Elysia hooks are scoped per instance.
- On **Node**, Elysia's `.listen` is unsupported (use the fetch handler `app.handle` / `app.fetch`); on
  **Bun** the full server works.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.
- **Opt-in** — with no SDK launched, the hooks are transparent no-ops, and never break the request.

**Status:** implemented + tested (incl. a real-Elysia e2e via `app.handle`: error reporting, 404 skip,
response preservation, concurrency isolation). Built test-first per `docs/implementation-standards.md`.
