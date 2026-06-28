# @bugsee/cloudflare

The Bugsee SDK for **Cloudflare Workers** (`workerd`) — the `@bugsee/vercel-edge` edge composition with the
platform identity set to `workers`. Edge is a V8-isolate, Web-APIs-only runtime (`fetch`/`Request`/`Response`/
`crypto.subtle`; no `node:*`). See `docs/design/edge-runtime.md`.

```ts
import { launch, withBugseeFetch } from '@bugsee/cloudflare';

export default {
  fetch: withBugseeFetch(launch('<BUGSEE_APP_TOKEN>'), async (request, env, ctx) => {
    // ... your handler ...
    return new Response('ok');
  }),
};
```

**Incident-driven.** Capture is buffered in memory and uploaded **only on an incident** (a `logException`, a
thrown handler, or an `unhandledrejection`) — a clean request uploads nothing. Same bundle, same `/upload`
endpoint, no new backend. (Cron/Queue/Email/Tail/Durable-Object/RPC handlers are a follow-up — C2.)

**`ctx.waitUntil`.** Cloudflare passes the `ExecutionContext` as the handler's 3rd argument; `withBugseeFetch`
reads `ctx.waitUntil` from it to flush an incident's upload after the `Response` returns (an edge isolate
freezes the instant it responds).

**AsyncLocalStorage requires `nodejs_compat`.** Per-request context isolation uses
`globalThis.AsyncLocalStorage`, which Cloudflare exposes only when the **`nodejs_compat`** (or the narrower
**`nodejs_als`**) compatibility flag is enabled. Add it to `wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
```

Without it the SDK still runs but degrades to a single-slot context store (no isolation across `await`
boundaries between concurrent requests in one isolate) and logs a one-time warning — it never throws. Tier 2.
