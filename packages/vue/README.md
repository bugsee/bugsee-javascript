# @bugsee/vue

Vue 3 adapter for the Bugsee SDK: reports errors from Vue's error handler and names navigations after the matched vue-router route, for apps running in the browser.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Vue 3 apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`.

## Install

```sh
npm install @bugsee/bugsee @bugsee/vue
# or
pnpm add @bugsee/bugsee @bugsee/vue
# or
yarn add @bugsee/bugsee @bugsee/vue
```

Peer dependency: `vue` >= 3 (optional).

## Usage

Launch Bugsee as early as possible, at the top of your entry module. In the browser `launch()` returns a Promise of the client. Await it only if you need the client right away.

```ts
// main.ts
import { launch } from "@bugsee/bugsee";
import { installBugseeErrorHandler } from "@bugsee/vue";
import { createApp } from "vue";
import App from "./App.vue";

launch("YOUR_APP_TOKEN");

const app = createApp(App);
installBugseeErrorHandler(app);
app.mount("#app");
```

`installBugseeErrorHandler(app)` hooks `app.config.errorHandler` so Vue errors are reported to the launched client.

### Route naming (vue-router)

Name the active navigation after the matched route pattern instead of the concrete URL. Call once after `createRouter(...)`:

```ts
import { instrumentVueRouter } from "@bugsee/vue";

instrumentVueRouter(router);
```

### Component names in minified builds (optional)

Register the mixin so clicks and errors are attributed to the Vue component that rendered them, even after minification:

```ts
// main.ts
import { createBugseeVueComponentMixin } from "@bugsee/vue";

app.mixin(createBugseeVueComponentMixin());
```

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones in the browser:

- `captureLogs`: capture console output (default `true`).
- `captureNetwork`: capture network requests (default `true`).
- `maxRecordingTime`: seconds of recording to keep (default `60`).
- `replay`: session replay settings, or `false` to turn replay off.
- `captureInteractions`: capture user interactions (default `true`).

This package also re-exports everything from `@bugsee/bugsee`.

Nuxt users: use [`@bugsee/nuxt`](https://github.com/bugsee/bugsee-javascript/tree/main/packages/nuxt), which wires this adapter for you.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/vue
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
