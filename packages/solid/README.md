# @bugsee/solid

SolidJS adapter for the Bugsee SDK: reports errors from Solid's error primitives and names navigations after the matched @solidjs/router route, for apps running in the browser.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in SolidJS apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`.

## Install

```sh
npm install @bugsee/bugsee @bugsee/solid
# or
pnpm add @bugsee/bugsee @bugsee/solid
# or
yarn add @bugsee/bugsee @bugsee/solid
```

Peer dependencies: `solid-js` >= 1.6 and `@solidjs/router` >= 0.10 (both optional).

## Usage

Launch Bugsee as early as possible, at the top of your entry module. In the browser `launch()` returns a Promise of the client. Await it only if you need the client right away.

```tsx
// index.tsx
import { launch } from "@bugsee/bugsee";

launch("YOUR_APP_TOKEN");
```

Solid hands errors to a callback, so pass Bugsee's reporter to Solid's own error seam:

```tsx
// App.tsx
import { ErrorBoundary } from "solid-js";
import { solidErrorHandler } from "@bugsee/solid";

const report = solidErrorHandler();

<ErrorBoundary fallback={(err) => { report(err); return <Crashed />; }}>
  <App />
</ErrorBoundary>;
```

`catchError(() => <App />, solidErrorHandler())` works the same way. These seams catch synchronous render and reactive errors. Asynchronous and event-handler errors are covered by the SDK's global error capture.

### Route naming (@solidjs/router)

```ts
import { useCurrentMatches } from "@solidjs/router";
import { createEffect } from "solid-js";
import { setRouteNameFromSolidMatches } from "@bugsee/solid";

const matches = useCurrentMatches();
createEffect(() => setRouteNameFromSolidMatches(matches()));
```

### Component names in minified builds (optional)

Install the Babel plugin so clicks and errors are attributed to the component that rendered them, even after minification:

```sh
npm install --save-dev @bugsee/babel-plugin-component-annotate
```

```js
// babel.config.js
module.exports = {
  plugins: [["@bugsee/babel-plugin-component-annotate"]],
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

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/solid
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
