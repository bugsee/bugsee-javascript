# @bugsee/express

Express middleware adapter — the first framework binding over Bugsee's per-request context foundation
(design: `docs/design/framework-adapters.md`). `express` is a **peer** dependency.

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { requestHandler, errorHandler } from '@bugsee/express';
import express from 'express';

launch(appToken);

const app = express();
app.use(requestHandler({ user: (req) => req.user?.email })); // user getter is opt-in (privacy-safe default: off)

// ... your routes ...

app.use(errorHandler()); // before your own error-response middleware
```

## What it does

- **`requestHandler(options?)`** opens a per-request `AsyncLocalStorage` context for the request's async
  chain, so any `logException` / capture inside a route automatically attributes to *that* request — and
  stays isolated across concurrent requests. It continues an inbound W3C `traceparent`, and (when the
  `@bugsee/performance` extension is wired) starts an `http.server` APM transaction that publishes its
  trace onto the context and finishes on response (route-parametrized name + status). Degrades to
  context-only when performance isn't wired.
- **`errorHandler(options?)`** reports an unhandled route error (mechanism `http-error`) **with the
  request context merged** — the report carries the request's user + a `contextId` that matches the
  `contextId` stamped on every capture entry recorded during the request — then re-throws via `next(err)`.

Correlation, not isolation: the SDK records everything globally and tags each entry with its request's
`contextId`; the report carries that id as the join key, so a viewer can focus the recording on one
request while the full picture stays available.

## Behavior guarantees

- **Opt-in** — installing the middleware is the only behavior change; with no SDK launched it is a
  transparent no-op.
- **Never breaks the app** — every adapter step is guarded; a downstream throw propagates to express
  untouched, and `next`/`next(err)` is called exactly once on every path.
- **Privacy-safe** — no user identity is read unless you provide a `user` getter.

**Status:** implemented + tested (incl. a real-server concurrency-isolation e2e). Built test-first per
`docs/implementation-standards.md`.
