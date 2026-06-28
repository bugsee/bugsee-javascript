# @bugsee/cloudflare

The Bugsee SDK for **Cloudflare Workers** (`workerd`) — the `@bugsee/vercel-edge` edge composition with the
platform identity set to `workers`. Edge is a V8-isolate, Web-APIs-only runtime (`fetch`/`Request`/`Response`/
`crypto.subtle`; no `node:*`). See `docs/design/edge-runtime.md`.

## `withBugsee` — instrument the whole Worker

A Cloudflare module Worker can export more than `fetch` — `scheduled` (Cron), `queue`, `email`, and `tail`
handlers have **no incoming `Request`**, so a fetch-only SDK misses them. `withBugsee` wraps every handler your
Worker exports so each runs in its own Bugsee context, captures + rethrows errors, and flushes via that
handler's `ctx.waitUntil`:

```ts
import { withBugsee } from '@bugsee/cloudflare';

export default withBugsee((env) => env.BUGSEE_APP_TOKEN, {
  fetch: async (request, env, ctx) => new Response('ok'),
  scheduled: async (controller, env, ctx) => {/* Cron */},
  queue: async (batch, env, ctx) => {/* Queue consumer */},
  email: async (message, env, ctx) => {/* Email */},
  tail: async (events, env, ctx) => {/* Tail Worker */},
});
```

**The token comes from `env`.** Cloudflare exposes secrets (and the app token) only inside handlers, never at
module scope — so `withBugsee`'s first argument is a **callback that receives `env`** (you may also pass a
static token string or an options object). The client is launched lazily on the first invocation and cached for
the isolate's lifetime.

Each non-fetch trigger is stamped with OpenTelemetry `faas.*` attributes (`faas.trigger`, `faas.cron`,
`messaging.*`) plus a `cloudflare.handler` marker, so an incident report names which trigger fired. Email
addresses and message bodies are never captured.

**`request.cf` enrichment.** For `fetch`, the incident context is additionally stamped with Cloudflare's free
geo/network metadata — `cf.colo`/`cf.country`/`cf.city`/`cf.timezone`/`cf.asn`/`tls.version` (not
latitude/longitude). Durable-Object / `WorkerEntrypoint` (RPC) methods can be wrapped manually with the exported
`runInEdgeContext` + `cloudflareRequestAttributes`.

## Just `fetch`

```ts
import { launch, withBugseeFetch } from '@bugsee/cloudflare';

export default {
  fetch: withBugseeFetch(launch('<BUGSEE_APP_TOKEN>'), async (request, env, ctx) => new Response('ok')),
};
```

## Notes

**Incident-driven.** Capture is buffered in memory and uploaded **only on an incident** (a `logException`, a
thrown handler, or an `unhandledrejection`) — a clean request uploads nothing. Same bundle, same `/upload`
endpoint, no new backend.

**`ctx.waitUntil`.** Cloudflare passes the `ExecutionContext` as the handler's 3rd argument; the wrappers read
`ctx.waitUntil` from it to flush an incident's upload after the response returns (an edge isolate freezes the
instant it responds).

**AsyncLocalStorage requires `nodejs_compat`.** Per-request context isolation uses
`globalThis.AsyncLocalStorage`, which Cloudflare exposes only when the **`nodejs_compat`** (or the narrower
**`nodejs_als`**) compatibility flag is enabled. Add it to `wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
```

Without it the SDK still runs but degrades to a single-slot context store (no isolation across `await`
boundaries between concurrent requests in one isolate) and logs a one-time warning — it never throws. Tier 2.
