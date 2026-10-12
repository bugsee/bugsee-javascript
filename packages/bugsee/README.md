# @bugsee/bugsee

The Bugsee JavaScript SDK: one package that captures crashes, errors, logs, network traffic and (in the browser) session replay in any JavaScript runtime, and uploads them to Bugsee as bug and crash reports.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is the main entry point. Install it directly. It resolves to the right build for your runtime through package `exports` conditions (browser, Node.js, Bun, Deno, Cloudflare Workers, Vercel Edge, Web Workers), and it turns on performance monitoring (web vitals and transactions) by default.

## Install

```sh
npm install @bugsee/bugsee
# or
pnpm add @bugsee/bugsee
# or
yarn add @bugsee/bugsee
```

Node.js 18 or newer for server use. Framework integrations (React, Vue, Express, Next.js and others) are separate packages that you install next to this one; see the table below.

## Usage

Call `launch()` as early as possible, ideally at the top of your entry module. Get the app token from your application in the Bugsee dashboard.

```ts
import { launch } from '@bugsee/bugsee';

launch('YOUR_APP_TOKEN');
```

In the browser `launch()` returns a `Promise` of the client (await it only if you need the client right away). On a server it returns the client directly.

```ts
const bugsee = await launch('YOUR_APP_TOKEN', { appVersion: '1.4.2' }); // browser

// later, anywhere
bugsee.addBreadcrumb({ message: 'checkout started' });
bugsee.logException(new Error('payment failed'));
```

## Which package for which runtime

| Where your code runs | Install | Launch from |
| --- | --- | --- |
| Browser, Node.js | `@bugsee/bugsee` | `@bugsee/bugsee` |
| Bun | `@bugsee/bun` | `@bugsee/bun` |
| Deno | `@bugsee/deno` (`deno add npm:@bugsee/deno`) | `@bugsee/deno` |
| Electron | `@bugsee/electron` | `@bugsee/electron/main`, `/preload`, `/renderer` |
| Cloudflare Workers | `@bugsee/cloudflare` | `@bugsee/cloudflare` |
| Vercel Edge | `@bugsee/vercel-edge` | `@bugsee/vercel-edge` |
| Web Worker, Service Worker | `@bugsee/webworker` | `@bugsee/webworker` |
| React, Preact | `@bugsee/bugsee` and `@bugsee/react` | `@bugsee/bugsee` |
| Vue, Angular, Svelte, Solid | `@bugsee/bugsee` and `@bugsee/vue`, `@bugsee/angular`, `@bugsee/svelte`, `@bugsee/solid` | `@bugsee/bugsee` |
| Next.js, Nuxt, Remix, SvelteKit, Astro | `@bugsee/nextjs`, `@bugsee/nuxt`, `@bugsee/remix`, `@bugsee/sveltekit`, `@bugsee/astro` | the adapter package |
| Express, Fastify, NestJS, Hono, Koa, hapi, Elysia | `@bugsee/bugsee` and `@bugsee/express`, `@bugsee/fastify`, `@bugsee/nestjs`, `@bugsee/hono`, `@bugsee/koa`, `@bugsee/hapi`, `@bugsee/elysia` | `@bugsee/bugsee` |

The umbrella also ships explicit subpath entries (`@bugsee/bugsee/node`, `/bun`, `/deno`, `/workerd`, `/edge-light`, `/worker`) for tools that do not honor `exports` conditions.

`@bugsee/browser` and `@bugsee/node` are the platform builds this package wraps. You do not need to install them.

## Options

`launch(appToken, options)` takes an optional options object. Common options:

- `appVersion`, `appBuild`, `appId`: identify your release in reports.
- `captureLogs`, `captureNetwork`, `captureNetworkBodies`: turn capture streams on or off (all default to `true`).
- `maxRecordingTime`: rolling recording window in seconds (default 60).
- `replay` (browser): session replay, on by default; pass `false` to disable.
- `performanceMonitoring`: web vitals and performance transactions, on by default; pass `false` to disable.
- `dataDir` (server runtimes): directory for the on-disk capture buffer (default `<os tmpdir>/bugsee`).

The full list is available as TypeScript types (`BugseeLaunchOptionsWithPerformance` in the browser, `BugseeNodeLaunchOptions` on Node.js).

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/bugsee
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
