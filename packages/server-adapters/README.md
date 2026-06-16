# @bugsee/server-adapters

The **framework-agnostic server-instrumentation engine** for the Bugsee JS SDK (design:
`docs/design/generic-server-adapter.md`). It takes **plain values** (no framework objects), so you can
instrument **any** Node backend framework — Sails, AdonisJS, h3/Nitro, Polka, tinyhttp, a raw
`http.Server`, or anything else — in a few lines. It's also the shared substrate the first-class adapters
(`@bugsee/express`/`fastify`/`nestjs`/`hono`/`elysia`/`hapi`/`koa`) delegate to.

```ts
import { launch } from '@bugsee/bugsee'; // or @bugsee/node
import { openBugseeRequest } from '@bugsee/server-adapters';

launch(appToken);

// In ANY framework's request entry — you extract these plain values yourself:
const span = openBugseeRequest({
  method,        // 'GET'
  url,           // '/orders/7'   → http.url
  route,         // '/orders/:id' → http.route + span name (optional; refine later via span.setRoute)
  traceparent,   // inbound W3C traceparent header value (optional)
  user,          // resolved end-user identity (optional, privacy-safe)
});
try {
  await runHandler();
} catch (err) {
  span.captureError(err); // reports iff it should (default: skip 4xx, report genuine/5xx); override per-call
  throw err;              // re-throw so the framework still handles the response
} finally {
  span.setRoute(matchedRoute); // refine once routing resolved
  span.finish(statusCode);     // OK if <500 else ERROR  — or span.cancel() on a client abort
}
```

## API

- **`openBugseeRequest(info, options?) → span`** — opens the per-request context (via `enterWith`), starts
  an `http.server` APM transaction (when `@bugsee/performance` is wired), and continues an inbound trace.
- **`span.setRoute(route)`** — refine the matched route (updates `http.route` + the finished span name).
- **`span.captureError(err, { shouldReport? }) → boolean`** — report the error (mechanism `http-error`) iff
  it should be; returns whether it reported (lets a caller dedup across multiple error seams).
- **`span.finish(status)`** — finish the transaction: `OK` if `status < 500`, else `ERROR`.
- **`span.cancel()`** — finish as `CANCELLED` (e.g. a client abort).
- **`openBugseeContext(info, options?)`** / **`startBugseeServerSpan(info, options?)`** — the decoupled
  primitives, for frameworks whose context-open and transaction-start live in different hooks.
- **`defaultShouldReport(err)`** — the default report policy: report a genuine error, skip an "expected"
  4xx. Duck-types the common HTTP-error shapes (`getStatus()`, `status`/`statusCode`, Boom `output.statusCode`).

`options`: `getClient` (default the process-singleton carrier client), `newContextId` (default
`crypto.randomUUID`), `shouldReport` (default `defaultShouldReport`).

## Behavior guarantees

- **Opt-in** — with no SDK launched, `openBugseeRequest` returns a safe no-op span; every method is a no-op.
- **Never breaks the app** — every method is guarded; `captureError` is fire-and-forget and never throws.
- **Privacy-safe** — only the values you pass are read; no framework object is ever inspected.

**Status:** implemented + tested (unit, per-entity mutator loop, 100% line/fn/branch, + a raw-`http.Server`
e2e proving the long-tail path with real concurrency isolation). Built test-first per
`docs/implementation-standards.md`.
