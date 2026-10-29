# @bugsee/remix

Remix and React Router v7/v8 adapter for the Bugsee SDK: server error reporting through `handleError` in `entry.server`, and browser capture through `entry.client`.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Remix and React Router v7 or v8 (framework mode) apps. It is a single install: it bundles the browser and Node.js SDKs and re-exports the React adapter from `@bugsee/remix/client`.

## Install

```sh
npm install @bugsee/remix
# or
pnpm add @bugsee/remix
# or
yarn add @bugsee/remix
```

Optional peer dependency: `react` >= 18. Server code requires Node.js 18 or newer.

## Usage

### Server

Launch Bugsee on the server and export `handleError` so unhandled server errors are reported.

```tsx
// app/entry.server.tsx
import { registerServer } from "@bugsee/remix/server";

registerServer(process.env.BUGSEE_TOKEN!);

export { handleError } from "@bugsee/remix";
```

`registerServer` returns the started client directly.

### Client

Launch the browser SDK at the top of `entry.client` and pass `bugseeOnError` to the router so React errors are reported with their component stack.

```tsx
// app/entry.client.tsx
import { registerClient, bugseeOnError } from "@bugsee/remix/client";

registerClient(import.meta.env.VITE_BUGSEE_TOKEN);

hydrateRoot(document, <HydratedRouter onError={bugseeOnError} />);
```

`registerClient` returns a Promise of the client.

### Remix v2

Remix v2 has no `onError` prop. Call `captureRemixErrorBoundaryError` from your root `ErrorBoundary`. Expected control flow (404s, redirects, thrown responses) is skipped.

```tsx
import { captureRemixErrorBoundaryError } from "@bugsee/remix/client";
import { useRouteError } from "@remix-run/react";

export function ErrorBoundary() {
  captureRemixErrorBoundaryError(useRouteError());
  return <RootError />;
}
```

## Options

Both `registerServer(appToken, options)` and `registerClient(appToken, options)` accept the SDK launch options. The most relevant ones:

- Server: `instrumentIncomingRequests` (default `true`), `captureLocalVariables` (default `false`), `detectHangs` (default `true`).
- Client: `captureLogs`, `captureNetwork`, `maxRecordingTime` (seconds, default `60`), `replay` (or `false` to turn replay off).

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/remix
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
