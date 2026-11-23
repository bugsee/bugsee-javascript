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

Optional peer dependencies: `react` >= 18, and `@opentelemetry/api` plus your OpenTelemetry SDK for the automatic OpenTelemetry bridge: `@opentelemetry/sdk-trace-base` (OTel JS 1.x/2.x) or `@opentelemetry/sdk-trace` (OTel JS 2.9+, required on 3.x). Server code requires Node.js 18 or newer.

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

## Source maps (build integration)

`withBugsee` makes `next build` upload source maps to Bugsee, so a minified browser, server or edge stack trace is shown against your original source. It handles both bundlers: webpack (`next build --webpack`, the default up to Next 15) and Turbopack (the default in Next 16).

```js
// next.config.mjs
import { withBugsee } from "@bugsee/nextjs/config";

export default withBugsee(
  {
    // your Next config: an object, a (phase) function, or an async one
  },
  {
    // BUGSEE_APP_TOKEN in the environment (or .env.bugsee-build-plugin) works too
    appToken: process.env.BUGSEE_APP_TOKEN,
  },
);
```

CommonJS works as well: `const { withBugsee } = require("@bugsee/nextjs/config");` in `next.config.js`.

What it does, for a production build:

- Turns on `productionBrowserSourceMaps` (only when you did not set it, and only when this build can actually upload: not for Turbopack with `experimental.sri`, not for Turbopack on Next older than 15.4.0) so the browser bundles have maps to upload. Where it cannot upload it leaves the option as you set it and says so.
- **webpack**: adds one Bugsee plugin to each of the client, server and edge compilations. Each stamps a debug ID into its bundles inside the build (before Subresource Integrity hashes are taken) and, after emit, uploads the maps of exactly the files that compilation wrote.
- **Turbopack**: has no plugin API, so the upload runs from Next's `compiler.runAfterProductionCompile` hook (Next 15.4.0 or later): after Turbopack wrote `.next` and before Next generates the static pages, it stamps the written bundles with the real `bugsee-cli sourcemaps inject` (verified, and undone if a stamp does not verify), uploads the maps and removes them.
- Deletes the browser maps (`.next/static/**/*.map`, which `next start` and CDNs serve publicly) after a confirmed upload. Server and edge maps stay on disk (`deleteServerMaps` to remove them).
- Bakes `appVersion` / `appBuild` into every bundle (`compiler.define`) for the runtime SDK.

Your own config is kept: your `webpack` function runs first and its result is extended (Next itself needs a synchronous `webpack` function; an async one fails in Next 16), your `compiler.runAfterProductionCompile` runs before ours, `compiler.define` keys you set win, and `productionBrowserSourceMaps: false` is respected. `next dev`, `next start` and `next export` are not touched.

Options are those of the Bugsee bundler plugins (`appToken`, `appVersion`, `appBuild`, `endpoint`, `deleteMaps`, `dryRun`, `failOnError`, `stripSourcesContent`, `disabled`, `vcs`, `commit`, `registerBuild`, `onError`, `onNotice`, see `@bugsee/webpack-plugin`), plus:

| Option | Default | |
| --- | --- | --- |
| `serverSourceMaps` | `true` | Emit and upload server and edge maps. With webpack the server and edge compilations get `devtool: "source-map"` if you left it unset; Next's own `experimental.serverSourceMaps` is never changed. |
| `deleteServerMaps` | `false` | Delete server and edge maps after a confirmed upload. |
| `silent` | `false` | Suppress configuration notices (failures are still reported). |

Without a token the integration changes nothing about what Next emits (it adds no source maps, no define, no hook) and uploads nothing.

Things to know:

- The config is resolved once, at load, from the working directory: the token file, the app version and the installed Next version are looked up there. Run `next build` from the project directory. For a Turbopack build the hook is told which project Next is building, and prints a notice if that differs (for example `next build apps/web` from a monorepo root).
- `withBugsee` turns `productionBrowserSourceMaps` on, so the browser maps are written to `.next/static`, which is served publicly. They are deleted after a confirmed upload. If the upload fails (and `failOnError` is off) they stay there, publicly served, so you can retry. If that is not acceptable, set `failOnError: true` so a failed upload stops the build, or delete `.next/static/**/*.map` in your deploy step.
- Next 15's Turbopack builds point two runtime chunks at one shared map. Those chunks are left unstamped and that map is neither uploaded nor deleted: it stays in `.next/static`, public. It contains Turbopack's runtime source, not your code.
- `compiler.define` (the baked version and build) needs Next 15.1.0 or later; the Turbopack upload needs 15.4.0 or later.
- `@bugsee/nextjs` depends on `@bugsee/bundler-plugin-core` (which brings `@bugsee/cli`, acorn, magic-string and unplugin) so that `withBugsee` works with no extra install. Only `next.config` loads it; your app bundles never import it. Making it an optional peer would force every user of the config to install it by hand and break `next build` out of the box, so it stays a regular dependency.

Turbopack and Subresource Integrity: Turbopack hashes its output (`experimental.sri`) before the post-build hook runs, so stamping afterwards would make the browser refuse your scripts. An SRI build under Turbopack is therefore left exactly as Next wrote it, with a notice, and no maps are uploaded; build with `--webpack` to upload maps for an SRI build (webpack stamps before the hashes are taken). On webpack with `experimental.sri`, if the in-build stamp itself fails, the fallback of stamping the written files is skipped (it would invalidate the pinned hashes) and nothing is uploaded for that compilation, with a notice; the browser maps then stay in `.next/static`, publicly served.

## Options

Both `register(appToken, options)` and `registerClient(appToken, options)` accept the SDK launch options. The most relevant ones:

- Server: `instrumentIncomingRequests` (default `true`), `captureLocalVariables` (default `false`), `detectHangs` (default `true`).
- Client: `captureLogs`, `captureNetwork`, `maxRecordingTime` (seconds, default `60`), `replay` (or `false` to turn replay off).
- Server: `setupOtelProvider` (default `true`), set `false` if you manage OpenTelemetry yourself.

## Entry points

- `@bugsee/nextjs`: `register`, `onRequestError`, `createOnRequestError`, `getBugseeTraceData`.
- `@bugsee/nextjs/client`: `registerClient`, `onRouterTransitionStart`, plus the React adapter.
- `@bugsee/nextjs/middleware`: `withBugseeMiddleware`.
- `@bugsee/nextjs/config`: `withBugsee` (build-time; import it from `next.config`, never from app code).
- `@bugsee/nextjs/server` and `@bugsee/nextjs/edge`: the Node.js and Edge compositions that `register()` loads for you.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/nextjs
- Bugsee: https://bugsee.com

## Navigation breadcrumbs

`onRouterTransitionStart` writes one `navigation` breadcrumb per soft navigation. The `href` (in the message and in `data.href`) is run through the SDK's location sanitizer first, so a `?code=...`, `?state=...`, `#access_token=...` or a `;jsessionid=` never reaches the bundle (the location denylist: the shared sensitive keys plus the exact keys `code`, `state`, `session`, `sid`, `sig`, `ticket`; `key` and `t` are not redacted). Ids, emails and other values in a path segment are not redacted, only token shapes and sensitive `;key=value` matrix segments.

## License

MIT. See the LICENSE file.
