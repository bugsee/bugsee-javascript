# @bugsee/svelte

Svelte and SvelteKit adapter for the Bugsee SDK: a `handleError` hook that reports client errors and route naming from SvelteKit navigation, for apps running in the browser.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Svelte or SvelteKit apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`. For SvelteKit with server-side code, prefer [`@bugsee/sveltekit`](https://github.com/bugsee/bugsee-javascript/tree/main/packages/sveltekit), which covers client and server.

## Install

```sh
npm install @bugsee/bugsee @bugsee/svelte
# or
pnpm add @bugsee/bugsee @bugsee/svelte
# or
yarn add @bugsee/bugsee @bugsee/svelte
```

Peer dependencies: `svelte` >= 4 and `@sveltejs/kit` >= 2 (both optional).

## Usage

Launch Bugsee as early as possible, at the top of your entry module. In the browser `launch()` returns a Promise of the client. Await it only if you need the client right away.

```ts
// src/main.ts
import { launch } from "@bugsee/bugsee";

launch("YOUR_APP_TOKEN");
```

In SvelteKit, wire the client error hook:

```ts
// src/hooks.client.ts
import { handleErrorWithBugsee } from "@bugsee/svelte";

export const handleError = handleErrorWithBugsee();
```

`handleErrorWithBugsee(appHandler?)` reports the error with its route id, then calls your own handler if you pass one.

### Route naming (SvelteKit)

Name the active navigation after the route id. Wire it once, after mount:

```ts
import { afterNavigate } from "$app/navigation";
import { instrumentSvelteKitNavigation } from "@bugsee/svelte";

afterNavigate(instrumentSvelteKitNavigation());
```

### Component names in minified builds (optional)

Install the Svelte preprocessor so clicks and errors are attributed to the component that rendered them, even after minification:

```sh
npm install --save-dev @bugsee/svelte-plugin-component-annotate
```

```js
// svelte.config.js
import { componentAnnotatePreprocessor } from "@bugsee/svelte-plugin-component-annotate";

export default {
  preprocess: [componentAnnotatePreprocessor()],
};
```

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones in the browser:

- `captureLogs`: capture console output (default `true`).
- `captureNetwork`: capture network requests (default `true`).
- `maxRecordingTime`: seconds of recording to keep (default `60`).
- `replay`: session replay settings, or `false` to turn replay off.
- `captureInteractions`: capture user interactions (default `true`).

This package also re-exports everything from `@bugsee/bugsee`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/svelte
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
