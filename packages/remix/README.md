# @bugsee/remix

Remix / React Router v7 meta-adapter.

**Status:** in progress. Supported: server error reporting through `handleError` (`@bugsee/remix/server`),
the client entry (`@bugsee/remix/client`), the trace `<meta>` channel, and Remix v2 root error boundaries
(`captureRemixErrorBoundaryError`). Server transaction route names are not yet implemented.

```ts
// entry.server.tsx
export { handleError } from '@bugsee/remix';

// instrument.server.mjs (loaded via --import) or top of a custom server
import { registerServer } from '@bugsee/remix/server';
registerServer(process.env.BUGSEE_TOKEN);
```
