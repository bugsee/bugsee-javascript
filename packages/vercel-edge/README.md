# @bugsee/vercel-edge

The Bugsee SDK for Vercel Edge Functions and other edge isolate runtimes built on Web APIs only (`fetch`, `Request`, `Response`, `crypto.subtle`; no `node:*`).

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly for standalone Vercel Edge functions. On Cloudflare Workers use `@bugsee/cloudflare`, which builds on this package. In a Next.js app use `@bugsee/nextjs`, which dispatches to this package on the Edge runtime for you.

Capture is incident-driven. Data is buffered in memory and uploaded only when an incident happens (a handled `logException`, a thrown handler error, or an unhandled rejection). A clean request uploads nothing.

## Install

```sh
npm install @bugsee/vercel-edge
# or
pnpm add @bugsee/vercel-edge
# or
yarn add @bugsee/vercel-edge
```

## Usage

```ts
// api/edge.ts
import { launch, withBugseeFetch } from '@bugsee/vercel-edge';

const bugsee = launch(process.env.BUGSEE_APP_TOKEN!);

export default {
  fetch: withBugseeFetch(bugsee, async (request: Request) => {
    // ... your handler ...
    return new Response('ok');
  }),
};
```

`launch()` returns the client directly (not a `Promise`). `withBugseeFetch` runs each request in its own Bugsee context, captures any error your handler throws and rethrows it (the platform still produces its error response), and flushes the upload through `waitUntil`, because an edge isolate freezes as soon as the response is returned. On Vercel Edge `waitUntil` is found automatically; elsewhere it is read from the `ctx` argument.

## Options

`launch(appToken, options)` accepts, among others:

- `appVersion`, `appBuild`, `appId`: identify your release in reports.
- `captureLogs`, `captureNetwork`, `captureNetworkBodies`: capture streams, on by default.
- `maxDataSize`: size of the in-memory capture buffer in megabytes.
- `maxTenantPartitions`: number of per-tenant capture partitions, used when one isolate serves several tenants.

## App version and build

Reports carry the version and build of your app. The most direct way is to pass them to `launch`:

```ts
launch('<app-token>', { appVersion: '2.4.1', appBuild: '381' });
```

Bugsee can also pick them up at build time. The Bugsee Vite and webpack plugins inject the constants `__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__` automatically when you give `appVersion` and `appBuild` to the plugin, or when `BUGSEE_APP_VERSION` and `BUGSEE_APP_BUILD` are set in the build environment. You can also define those two constants yourself in your bundler, or set `__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__` as globals before launching. Options passed to `launch` always win over the build-time values.

If no version can be found, Bugsee logs a single warning to the console and reports the version as `0.0.0` and the build as `0`.

On Vercel, if no build is given, the deployed commit (`VERCEL_GIT_COMMIT_SHA`) is used as the build.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/vercel-edge
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
