# @bugsee/react

React adapter for the Bugsee SDK: an error boundary, React 19 root error handlers, a render profiler and react-router route naming for apps running in the browser.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in React (and Preact) apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`.

## Install

```sh
npm install @bugsee/bugsee @bugsee/react
# or
pnpm add @bugsee/bugsee @bugsee/react
# or
yarn add @bugsee/bugsee @bugsee/react
```

Peer dependency: `react` >= 18.

## Usage

Launch Bugsee as early as possible, at the top of your entry module. In the browser `launch()` returns a Promise of the client. Await it only if you need the client right away.

```tsx
// main.tsx
import { launch } from "@bugsee/bugsee";

launch("YOUR_APP_TOKEN");
```

Wrap your app in the error boundary. A render error is reported with the React component stack and the fallback is shown.

```tsx
// App.tsx
import { BugseeErrorBoundary } from "@bugsee/react";

<BugseeErrorBoundary fallback={<Crashed />}>
  <App />
</BugseeErrorBoundary>;
```

A higher-order component is available as well:

```tsx
import { withBugseeErrorBoundary } from "@bugsee/react";

export default withBugseeErrorBoundary(App, { fallback: <Crashed /> });
```

For React 19 root-level error callbacks, pass the handlers to `createRoot` or `hydrateRoot`:

```tsx
import { createRoot } from "react-dom/client";
import { createBugseeErrorHandlers } from "@bugsee/react";

createRoot(document.getElementById("root")!, createBugseeErrorHandlers()).render(<App />);
```

### Route naming (react-router)

Name the active navigation after the matched route pattern (`/users/:id`) instead of the concrete URL. With a data router, wire it once:

```tsx
import { createBrowserRouter } from "react-router-dom";
import { instrumentReactRouter } from "@bugsee/react";

const router = createBrowserRouter(routes);
instrumentReactRouter(router);
```

With a declarative router, call `instrumentRouterMatches(matchRoutes(routes, location))` on each navigation.

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

### Preact

Preact (10+) works through this package via `preact/compat`. Alias `react` and `react-dom` to `preact/compat` in your bundler, as a Preact app already does, and use `@bugsee/react` as is. Under Preact the report carries the error but no React component stack.

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones in the browser:

- `captureLogs`: capture console output (default `true`).
- `captureNetwork`: capture network requests (default `true`).
- `maxRecordingTime`: seconds of recording to keep (default `60`).
- `replay`: session replay settings, or `false` to turn replay off.
- `captureInteractions`: capture user interactions.

This package also re-exports everything from `@bugsee/bugsee`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/react
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
