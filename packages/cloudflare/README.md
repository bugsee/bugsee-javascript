# @bugsee/cloudflare

The Bugsee SDK for Cloudflare Workers (`workerd`): it captures errors, logs and network calls inside your Worker, Durable Objects, Cron, Queue, Email and Tail handlers, and uploads a report when something goes wrong.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Worker projects. It is the `@bugsee/vercel-edge` edge build with the platform identity set to Cloudflare, so you do not install that package separately. Edge isolates run only Web APIs (`fetch`, `Request`, `Response`, `crypto.subtle`), and capture is incident-driven: data is buffered in memory and uploaded only when an incident happens (a handled `logException`, a thrown handler error, or an unhandled rejection). A clean request uploads nothing.

## Install

```sh
npm install @bugsee/cloudflare
# or
pnpm add @bugsee/cloudflare
# or
yarn add @bugsee/cloudflare
```

Required: enable Node.js compatibility in `wrangler.toml`. The SDK imports `node:async_hooks` for per-request context, and without the flag your Worker fails to start.

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]
```

## Usage

Wrap everything your Worker exports with `withBugsee`. The first argument is a function that receives `env`, because Cloudflare exposes secrets only inside handlers. The client launches on the first invocation and is cached for the isolate's lifetime.

```ts
import { withBugsee } from '@bugsee/cloudflare';

export default withBugsee((env) => env.BUGSEE_APP_TOKEN, {
  fetch: async (request, env, ctx) => new Response('ok'),
  scheduled: async (controller, env, ctx) => {
    /* Cron */
  },
  queue: async (batch, env, ctx) => {
    /* Queue consumer */
  },
  email: async (message, env, ctx) => {
    /* Email */
  },
  tail: async (events, env, ctx) => {
    /* Tail Worker */
  },
});
```

Each handler runs in its own Bugsee context, errors are captured and rethrown, and the upload is flushed through that handler's `ctx.waitUntil`, so it survives the isolate freezing after the response. Each non-fetch trigger is labeled (cron, queue, email, tail) so a report says which trigger fired. Email addresses and message bodies are never captured. For `fetch`, the report also includes Cloudflare's coarse geo and network metadata from `request.cf` (colo, country, city, timezone, ASN, TLS version).

`withBugsee` also accepts a `WorkerEntrypoint` class. Pass `{ instrumentRpcMethods: true }` to wrap its RPC methods too.

### Durable Objects

A Durable Object is bound separately from the module handlers, so wrap its export with `instrumentDurableObject`:

```ts
import { instrumentDurableObject } from '@bugsee/cloudflare';

class CounterBase extends DurableObject<Env> {
  async fetch(request: Request) {
    /* ... */
  }
  async alarm() {
    /* ... */
  }
}

export const Counter = instrumentDurableObject((env) => env.BUGSEE_APP_TOKEN, CounterBase, {
  instrumentRpcMethods: true, // optional, also wraps RPC methods (default off)
});
```

## Options

Instead of a token string, the callback passed to `withBugsee` (or `instrumentDurableObject`) may return an options object that includes `appToken`:

```ts
export default withBugsee(
  (env) => ({ appToken: env.BUGSEE_APP_TOKEN, appVersion: '1.4.2' }),
  { fetch: async () => new Response('ok') },
);
```

The options are the same as for `launch(appToken, options)`: `appVersion`, `appBuild`, `captureLogs`, `captureNetwork`, `maxDataSize`, plus:

- `maxTenantPartitions`: Durable Objects for different customers can share one isolate, so capture is kept per Durable Object id and an incident uploads only the faulting tenant's data. The `maxDataSize` budget (10 MB by default) is divided across `maxTenantPartitions + 1` buffers (default 8 + 1). Lower `maxTenantPartitions` if your Workers host few tenants, to give each more room.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/cloudflare
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
