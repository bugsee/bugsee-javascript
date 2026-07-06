# @bugsee/remix

Remix / React Router v7 meta-adapter. See `docs/design/meta-framework-adapters.md`.

**Status:** in progress. Built: **R1** — the server `handleError` bridge (`@bugsee/remix`, portable) +
the node server composition (`@bugsee/remix/server`). Remaining: R2 client entry, R3 trace channel, R4
server txn / route names, R5 Remix-v2 back-compat, R6 source-maps (#158).

```ts
// entry.server.tsx
export { handleError } from '@bugsee/remix';

// instrument.server.mjs (loaded via --import) or top of a custom server
import { registerServer } from '@bugsee/remix/server';
registerServer(process.env.BUGSEE_TOKEN);
```
