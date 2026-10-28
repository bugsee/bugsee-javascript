# @bugsee/sveltekit

SvelteKit adapter for the Bugsee SDK: server hooks (`handle` and `handleError`) and client hooks, so one session covers the server request and the browser that triggered it.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in SvelteKit apps. It is a single install: it bundles the browser, Node.js and Edge SDKs and the Svelte adapter.

## Install

```sh
npm install @bugsee/sveltekit
# or
pnpm add @bugsee/sveltekit
# or
yarn add @bugsee/sveltekit
```

The Bugsee server adapter requires Node.js 18 or newer; SvelteKit 3 applications require Node.js 22.17 or newer.

## Usage

### Server hooks

Launch Bugsee on the server, add the `handle` hook (it injects the trace into the page head) and the `handleError` hook.

```ts
// src/hooks.server.ts
import { sequence } from "@sveltejs/kit/hooks";
import { registerServer } from "@bugsee/sveltekit/server";
import { handle as bugseeHandle, handleErrorWithBugsee } from "@bugsee/sveltekit";

registerServer(process.env.BUGSEE_TOKEN!);

export const handle = sequence(bugseeHandle);
export const handleError = handleErrorWithBugsee();
```

Add your own handles to `sequence(...)` as usual.

### Client hooks

Launch the browser SDK in the client hooks file, which runs only in the browser, and wire the client error hook.

```ts
// src/hooks.client.ts
import { PUBLIC_BUGSEE_TOKEN } from "$env/static/public";
import { registerClient, handleErrorWithBugsee } from "@bugsee/sveltekit/client";

registerClient(PUBLIC_BUGSEE_TOKEN);

export const handleError = handleErrorWithBugsee();
```

`registerClient` returns a Promise of the client. `handleErrorWithBugsee(appHandler?)` reports the error and then calls your own handler if you pass one.

### Component names in minified builds (optional)

Install the Svelte preprocessor so clicks and errors are attributed to the component that rendered them, even after minification:

```sh
npm install --save-dev @bugsee/svelte-plugin-component-annotate
```

```js
// vite.config.ts (Kit 3: pass options to the plugin; Kit 3 errors if a svelte.config.js exists)
import { componentAnnotatePreprocessor } from "@bugsee/svelte-plugin-component-annotate";
import { sveltekit } from "@sveltejs/kit/vite";

export default {
  plugins: [sveltekit({ preprocess: [componentAnnotatePreprocessor()] })],
};
```

On Kit 2, put `preprocess: [componentAnnotatePreprocessor()]` in `svelte.config.js` instead.

### Edge deployments

For edge targets, use `registerServerEdge` and `createEdgeHandle` from `@bugsee/sveltekit/edge` in place of `registerServer` and `handle`.

## Options

Both `registerServer(appToken, options)` and `registerClient(appToken, options)` accept the SDK launch options. The most relevant ones:

- Server: `instrumentIncomingRequests` (default `true`), `captureLocalVariables` (default `false`), `detectHangs` (default `true`).
- Client: `captureLogs`, `captureNetwork`, `maxRecordingTime` (seconds, default `60`), `replay` (or `false` to turn replay off).

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/sveltekit
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
