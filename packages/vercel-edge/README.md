# @bugsee/vercel-edge

The Bugsee SDK for **Vercel Edge** (and the shared composition that `@bugsee/cloudflare` builds on) — a
V8-isolate, Web-APIs-only runtime (`fetch`/`Request`/`Response`/`crypto.subtle`; no `node:*`). See
`docs/design/edge-runtime.md`.

```ts
import { launch, withBugseeFetch } from '@bugsee/vercel-edge';

const bugsee = launch(process.env.BUGSEE_APP_TOKEN!);

export default {
  fetch: withBugseeFetch(bugsee, async (request: Request) => {
    // ... your handler ...
    return new Response('ok');
  }),
};
```

**Incident-driven.** Capture is buffered in memory and uploaded **only on an incident** (a `logException`,
a thrown handler error, or an `unhandledrejection`) — a clean request uploads nothing (the buffer is discarded
when the isolate ends). There is no continuous/per-invocation upload and no new backend: an incident produces
a normal bundle to the same `/upload` endpoint.

**Surviving the isolate freeze.** An edge isolate freezes the instant the `Response` returns, so
`withBugseeFetch` flushes the upload inside `ctx.waitUntil(client.flush())`. It acquires `waitUntil` from the
`@vercel/request-context` global symbol on Vercel Edge (which has no `ctx` param) or from the explicit `ctx`
argument on Cloudflare. A thrown handler error is captured and **rethrown** (the platform still produces its
error response). `unhandledrejection` is captured too as a safety net (best-effort delivery for rejections
that fire after the response).

**Per-request context.** Each request runs in its own `run()`-scoped `AsyncLocalStorage` context (Vercel Edge
has it built-in; on Cloudflare add the `nodejs_compat` / `nodejs_als` compatibility flag) so captures correlate
to the request; it degrades to a single-slot store + a one-time warning when unavailable, and never throws at
import. Tier 2. Implementation follows `docs/implementation-standards.md`.
