# @bugsee/astro

Astro integration for the Bugsee SDK: it launches the browser client on every page and adds a server middleware that launches the server SDK, reports request errors and injects the trace.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Astro apps. It is a single install: it bundles the browser, Node.js and Edge SDKs.

## Install

```sh
npm install @bugsee/astro
# or
pnpm add @bugsee/astro
# or
yarn add @bugsee/astro
```

Server code requires Node.js 18 or newer.

## Usage

Add the integration to your Astro config. There is nothing else to wire.

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import { bugsee } from "@bugsee/astro";

export default defineConfig({
  integrations: [
    bugsee({ appToken: process.env.BUGSEE_TOKEN, runtime: "node" }),
  ],
});
```

Use `runtime: "edge"` for Vercel or Cloudflare edge deployments. The default is the Node.js runtime.

The token is inlined into the client script so the browser can launch. An application token is not a secret.

## Options

- `appToken`: your Bugsee application token (required).
- `runtime`: `"node"` (default) or `"edge"`.
- `client`: extra browser launch options, for example `{ replay: false }` or `{ maxRecordingTime: 30 }`.
- `server`: extra server launch options, for example `{ captureLocalVariables: true }`.

```js
bugsee({
  appToken: process.env.BUGSEE_TOKEN,
  client: { captureNetwork: true },
  server: { instrumentIncomingRequests: true },
});
```

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/astro
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
