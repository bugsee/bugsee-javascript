# @bugsee/remix

Remix / React Router v7 meta-adapter. See `docs/design/meta-framework-adapters.md`.

**Status:** in progress. Built: **R1** (server `handleError` bridge + `@bugsee/remix/server` node composition) + **R2**
(`@bugsee/remix/client`) + **R3** (trace `<meta>` channel) + **R5** (Remix-v2 back-compat: `captureRemixErrorBoundaryError` for the v2
root ErrorBoundary — v2's server handleError / init / trace already work via R1–R3). Remaining: R4 server txn
/ route names (RR7 native instrumentation API, beta), R6 source-maps (#158).

```ts
// entry.server.tsx
export { handleError } from '@bugsee/remix';

// instrument.server.mjs (loaded via --import) or top of a custom server
import { registerServer } from '@bugsee/remix/server';
registerServer(process.env.BUGSEE_TOKEN);
```
