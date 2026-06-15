# @bugsee/fastify

Fastify adapter — the second framework binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `fastify` is a **peer** dependency.

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupFastify } from '@bugsee/fastify';
import Fastify from 'fastify';

launch(appToken);

const app = Fastify();
setupFastify(app, { user: (req) => req.headers['x-user'] }); // one call — the hooks cover every route
// ... your routes ...
await app.listen({ port: 3000 });
```

## What it does

Unlike Express (middleware), Fastify is hook-based, so a single `setupFastify(app)` call installs four
lifecycle hooks that cover the whole app — no error-handler placement, no `listen()` wrapping:

- **`onRequest`** — opens a per-request context (via the store's `enterWith`, since the hook returns
  before the route handler runs), continues an inbound W3C `traceparent`, and (when the
  `@bugsee/performance` extension is wired) starts an `http.server` APM transaction.
- **`onError`** — reports an unhandled route error (mechanism `http-error`) **with the request context
  merged** (the report's user + a `contextId` matching the `contextId` stamped on the request's capture
  entries).
- **`onResponse`** — finishes the transaction (route-parametrized name + status).
- **`onRequestAbort`** — finishes the transaction as `CANCELLED` when a client aborts before a response.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key, so a viewer can focus the recording on one
request while the full picture stays available.

## Setup constraints
- Call `setupFastify` on the **root** Fastify instance — Fastify hooks are encapsulated per scope, so the
  hooks cover this instance and its child plugins, not a parent/sibling scope.
- Hook-vs-route **ordering doesn't matter** (Fastify binds hooks at ready time), so it may be called
  before or after your routes — just register it on the root.

## Behavior guarantees
- **Opt-in** — installing the hooks is the only behavior change; with no SDK launched they are a no-op.
- **Never breaks the request** — every hook is guarded and always calls `done()`.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.
- **Isolated under concurrency** — verified by a real-Fastify e2e: 3 interleaved concurrent requests,
  each report carries its own user + `contextId`, no cross-request bleed.

**Status:** implemented + tested. Built test-first per `docs/implementation-standards.md`.
