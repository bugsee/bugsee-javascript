# @bugsee/restify

Restify adapter — a backend binding over Bugsee's per-request context foundation (design:
`docs/design/framework-adapters.md`). `restify` is a **peer** (structural types only — the adapter never
imports restify). Works on node/bun/deno-hosted Restify (wherever the launched `@bugsee/node` client
provides the context store).

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { setupRestify } from '@bugsee/restify';
import restify from 'restify';

launch(appToken);

const server = restify.createServer();
setupRestify(server, { user: (req) => req.headers['x-user'] }); // before your routes
// ... your routes ...
server.listen(3000);
```

## What it does

`setupRestify(server)` wires a `use` middleware plus the server `after` event over the foundation:

- the **`use`** middleware opens a per-request context (via the store's `enterWith`, since restify
  middleware is callback-style and returns before the route handler), continues an inbound W3C
  `traceparent`, and starts an `http.server` APM transaction (when `@bugsee/performance` is wired);
- the **`after`** event fires once per request (success and error). It reports a **genuine** error
  (mechanism `http-error`) and finishes the transaction. A plain throw (no status, → 500) or a 5xx is
  reported; a 4xx (`NotFoundError`, etc.) is skipped — override with `shouldReport: (err) => boolean`. The
  report **re-enters the saved context** so it carries the right `contextId` even if the `after` event runs
  outside the request's async chain.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key.

## Compatibility note

> **restify 11.x does not import on Node ≥ 18** — its transitive `spdy` → `http-deceiver` dependency uses
> the removed `process.binding('http_parser')`. This is a restify-the-framework limitation, not an adapter
> one: the adapter is structural (it never imports restify) and is validated by unit tests; it runs
> wherever restify itself runs. There is therefore no real-restify e2e in this package (unlike the other
> framework adapters).

## Behavior guarantees

- **Opt-in** — with no SDK launched, the hooks are transparent no-ops.
- **Never breaks the app** — every hook is guarded; the `use` middleware always calls `next()`.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.

**Status:** implemented + tested (unit, with injection-first fakes). Built test-first per
`docs/implementation-standards.md`.
