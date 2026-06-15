# @bugsee/hapi

Hapi adapter — a backend binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `@hapi/hapi` is a **peer** (structural types only — the adapter
never imports hapi). Works on node/bun/deno-hosted Hapi (wherever the launched `@bugsee/node` client
provides the context store).

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupHapi } from '@bugsee/hapi';
import Hapi from '@hapi/hapi';

launch(appToken);

const server = Hapi.server({ port: 3000 });
setupHapi(server, { user: (req) => req.headers['x-user'] }); // before server.start()
// ... your routes ...
await server.start();
```

## What it does

`setupHapi(server)` registers two request-lifecycle extensions over the foundation (Hapi extensions are
additive — registering ours never replaces yours):

- **`onRequest`** (before routing) — opens a per-request context (via the store's `enterWith`, since the
  extension returns before the route handler), continues an inbound W3C `traceparent`, and starts an
  `http.server` APM transaction (when `@bugsee/performance` is wired). The transaction is kept per-request.
- **`onPreResponse`** (both success and error) — if the response is a **Boom** error, reports it (mechanism
  `http-error`). Hapi marks 5xx as `isServer`, so by default we report **server** errors and skip **client**
  (4xx) Boom; override with `shouldReport: (err) => boolean`. Then finishes the transaction
  (route-parametrized name + status) and returns `h.continue`, so it never alters the response.
- A **client disconnect** (which skips `onPreResponse`) finishes the transaction as `CANCELLED` (via the
  request's `disconnect` event), so it is still delivered rather than dropped.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key.

## Behavior guarantees

- **Opt-in** — with no SDK launched, the extensions are transparent no-ops.
- **Never breaks the app** — every extension is guarded and always returns `h.continue`; it only observes.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.

**Status:** implemented + tested (incl. a real-Hapi e2e via `server.inject`: 5xx reporting, 404 skip,
response preservation, concurrency isolation). Built test-first per `docs/implementation-standards.md`.
