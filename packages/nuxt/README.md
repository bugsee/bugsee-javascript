# @bugsee/nuxt

Nuxt module for the Bugsee SDK: it wires the browser client (with the Vue error handler) and the Nitro server from one entry in `nuxt.config.ts`.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Nuxt 3 apps. It is a single install: it bundles the browser, Node.js and Edge SDKs and the Vue adapter.

## Install

```sh
npm install @bugsee/nuxt
# or
pnpm add @bugsee/nuxt
# or
yarn add @bugsee/nuxt
```

Peer dependencies (all optional, normally already present in a Nuxt app): `nuxt` >= 3, `@nuxt/kit` >= 3 and `nitropack` >= 2. Server code requires Node.js 18 or newer.

## Usage

Register the module and pass your token in the `bugsee` block. There is nothing else to wire.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@bugsee/nuxt"],
  bugsee: {
    appToken: process.env.BUGSEE_TOKEN,
  },
});
```

The module adds a client plugin that launches the browser SDK and installs the Vue error handler, and a Nitro server plugin that launches the server SDK and reports Nitro errors. On an edge Nitro preset (for example Cloudflare or Vercel Edge) it ships the edge SDK instead of the Node.js one.

The token is written to Nuxt's public runtime config so the browser can launch. An application token is not a secret.

## Options

- `appToken`: your Bugsee application token (required).
- `client`: extra browser launch options, for example `{ replay: false }` or `{ maxRecordingTime: 30 }`.
- `server`: extra Nitro (server) launch options, for example `{ captureLocalVariables: true }`.

```ts
export default defineNuxtConfig({
  modules: ["@bugsee/nuxt"],
  bugsee: {
    appToken: process.env.BUGSEE_TOKEN,
    client: { captureNetwork: true },
    server: { instrumentIncomingRequests: true },
  },
});
```

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/nuxt
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
