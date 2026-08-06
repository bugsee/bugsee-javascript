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

`withBugsee` also accepts a **`WorkerEntrypoint` class** (not just a handler object) and instruments its
`fetch`/`scheduled`/`queue`/`email`/`tail` methods; pass `{ instrumentRpcMethods: true }` (or a name list) to
also wrap its arbitrary RPC methods.

**`request.cf` enrichment.** For `fetch`, the incident context is additionally stamped with Cloudflare's free
geo/network metadata — `cf.colo`/`cf.country`/`cf.city`/`cf.timezone`/`cf.asn`/`tls.version` (not
latitude/longitude).

## Durable Objects

A Durable Object is a class bound separately (not the module's handler) and gets its `ctx`/`env` in the
constructor — so it uses a dedicated helper. **Wrap the export**, not just the class:

```ts
import { instrumentDurableObject } from '@bugsee/cloudflare';

class CounterBase extends DurableObject<Env> {
  async fetch(request: Request) {/* ... */}
  async alarm() {/* ... */}
  async increment() {/* RPC */}
}

export const Counter = instrumentDurableObject((env) => env.BUGSEE_APP_TOKEN, CounterBase, {
  instrumentRpcMethods: true, // optional — also wrap arbitrary RPC methods (default off)
});
```

The DO's `fetch` (with http + `request.cf` attrs) and `alarm` run in a Bugsee context, capture + rethrow, and
flush via the DO's `ctx.waitUntil`. Private (`#`) fields keep working (the wrapper preserves `this`).

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

**`nodejs_compat` is REQUIRED.** Add it to `wrangler.toml` and you are done — there is no SDK code to write:

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]
```

```ts
import { launch } from '@bugsee/cloudflare';

launch(env.BUGSEE_APP_TOKEN); // AsyncLocalStorage is wired for you
```

Per-request context isolation needs a run()-scoped async store. On Cloudflare, `globalThis.AsyncLocalStorage`
**does not exist under any compatibility flag** — it is reachable only as an export of `node:async_hooks`.
(Verified on real `workerd` 1.20260722.1 across the flag × compatibility-date matrix; see
`docs/review/cloudflare.md` SEV1 #3. Earlier revisions of this README told you to add the flag and expect the
global to appear — that was wrong, and the SDK silently ran without context isolation as a result.)

The SDK therefore imports `node:async_hooks` itself, which is why the flag is required rather than merely
recommended. **Without it your Worker fails to start**, with workerd unable to resolve the builtin — deliberately, so the
problem is visible immediately instead of surfacing as silently missing context, route attribution and
per-tenant isolation in production. (A wrangler-shaped bundle still *builds*, since `node:*` is external; the
failure is at worker load.) `@sentry/cloudflare` requires the flag for the same reason.

**Per-tenant capture isolation.** Durable Objects for different customers share one isolate, so their
capture is partitioned per DO id and an incident uploads only the faulting tenant's data. This is on by
default; `partitionCaptureByTenant: false` disables it.

The `maxDataSize` budget is **divided** across `maxTenantPartitions + 1` rings (default 8 + 1) so total
capture memory stays within the cap however many tenants appear — the alternative, a full budget per
partition, measured 116 MB against a 128 MB isolate. The trade-off is per-tenant headroom: with the 10 MB
default each tenant gets ~1.16 MB of rolling window. If your Workers host few tenants per isolate, raise
headroom with `maxDataSize`, or lower `maxTenantPartitions` to divide the budget fewer ways:

```ts
launch(env.BUGSEE_APP_TOKEN, { maxTenantPartitions: 3 }); // 10 MB / 4 ≈ 2.5 MB per tenant
```

Advanced: `launch(token, { asyncLocalStorage })` accepts an explicit store, for tests or a runtime that
provides its own. Callers' options win over the default. Tier 2.
