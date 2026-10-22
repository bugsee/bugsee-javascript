# @bugsee/nextjs

Next.js adapter for the Bugsee SDK: server error reporting through `instrumentation.ts` (Node.js and Edge runtimes), browser capture through `instrumentation-client.ts`, and middleware error reporting.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Next.js apps. It is a single install: it bundles the browser, Node.js and Edge SDKs and re-exports the React adapter from `@bugsee/nextjs/client`.

## Install

```sh
npm install @bugsee/nextjs
# or
pnpm add @bugsee/nextjs
# or
yarn add @bugsee/nextjs
```

Optional peer dependencies: `react` >= 18, and `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` (>= 1.0.0) for the automatic OpenTelemetry bridge. Server code requires Node.js 18 or newer.

## Usage

### Server

`register()` picks the Node.js or Edge SDK by runtime. Re-export `onRequestError` so Next.js reports server errors.

```ts
// instrumentation.ts
import { register as bugsee } from "@bugsee/nextjs";

export function register() {
  return bugsee(process.env.BUGSEE_TOKEN!);
}

export { onRequestError } from "@bugsee/nextjs";
```

### Client

Next.js 15.3 and later load `instrumentation-client.ts` in the browser before your app code. Export `onRouterTransitionStart` to record a breadcrumb for each client-side navigation.

```ts
// instrumentation-client.ts
import { registerClient } from "@bugsee/nextjs/client";

registerClient(process.env.NEXT_PUBLIC_BUGSEE_TOKEN!);

export { onRouterTransitionStart } from "@bugsee/nextjs/client";
```

`registerClient` returns a Promise of the client. `@bugsee/nextjs/client` also re-exports the React adapter, so `BugseeErrorBoundary` can be imported from there.

### Middleware (optional)

Errors thrown in Next.js middleware are not delivered to `onRequestError`. Wrap your middleware to capture them:

```ts
// middleware.ts
import { withBugseeMiddleware } from "@bugsee/nextjs/middleware";

export const middleware = withBugseeMiddleware((request, event) => {
  // ...
});
```

## Options

Both `register(appToken, options)` and `registerClient(appToken, options)` accept the SDK launch options. The most relevant ones:

- Server: `instrumentIncomingRequests` (default `true`), `captureLocalVariables` (default `false`), `detectHangs` (default `true`).
- Client: `captureLogs`, `captureNetwork`, `maxRecordingTime` (seconds, default `60`), `replay` (or `false` to turn replay off).
- Server: `setupOtelProvider` (default `true`), set `false` if you manage OpenTelemetry yourself.

## Entry points

- `@bugsee/nextjs`: `register`, `onRequestError`, `createOnRequestError`, `getBugseeTraceData`.
- `@bugsee/nextjs/client`: `registerClient`, `onRouterTransitionStart`, plus the React adapter.
- `@bugsee/nextjs/middleware`: `withBugseeMiddleware`.
- `@bugsee/nextjs/server` and `@bugsee/nextjs/edge`: the Node.js and Edge compositions that `register()` loads for you.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/nextjs
- Bugsee: https://bugsee.com

## Navigation breadcrumbs

`onRouterTransitionStart` writes one `navigation` breadcrumb per soft navigation. The `href` (in the message and in `data.href`) is run through the SDK's location sanitizer first, so a `?code=...`, `?state=...`, `#access_token=...` or a `;jsessionid=` never reaches the bundle (the location denylist: the shared sensitive keys plus the exact keys `code`, `state`, `session`, `sid`, `sig`, `ticket`; `key` and `t` are not redacted). Ids, emails and other values in a path segment are not redacted, only token shapes and sensitive `;key=value` matrix segments.

## License

MIT. See the LICENSE file.
