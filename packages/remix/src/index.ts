// @bugsee/remix — the shared (`.`) entry: runtime-PORTABLE surface only.
//
// Remix/RR7 `entry.server` runs on node OR edge, so anything exported here must be portable (no static
// node/edge-specific import). The node server composition lives behind `@bugsee/remix/server`; the client
// entry behind `@bugsee/remix/client`.
//
// The handleError bridge, the ./server node composition, the /client entry and the trace-meta
// string builder live here; the node stream transformer is in ./server.
export {
  type CreateHandleErrorOptions,
  createHandleError,
  handleError,
  type RemixHandleError,
  type RemixHandleErrorArgs,
} from './handle-error';
export { getBugseeTraceMetaTags } from './trace-meta';
