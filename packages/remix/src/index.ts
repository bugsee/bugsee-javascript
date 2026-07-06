// @bugsee/remix — the shared (`.`) entry: runtime-PORTABLE surface only.
//
// Remix/RR7 `entry.server` runs on node OR edge, so anything exported here must be portable (no static
// node/edge-specific import). The node server composition lives behind `@bugsee/remix/server`; the client
// entry (R2) behind `@bugsee/remix/client`. See docs/design/meta-framework-adapters.md.
//
// Tier 4. Built so far: R1 (handleError bridge + ./server node composition) + R2 (./client) + R3
// (trace-meta string builder here; the node stream transformer is in ./server).
export {
  type CreateHandleErrorOptions,
  createHandleError,
  handleError,
  type RemixHandleError,
  type RemixHandleErrorArgs,
} from './handle-error';
export { getBugseeTraceMetaTags } from './trace-meta';
