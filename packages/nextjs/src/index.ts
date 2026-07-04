// @bugsee/nextjs — the shared (`.`) entry: runtime-PORTABLE surface only.
//
// Next invokes `instrumentation.ts` exports on both the node AND edge runtimes, so anything exported
// here must be portable (no static node/edge-specific import). Node-only composition lives behind the
// `./server` subpath (reached via `await import` from the `register()` dispatcher). See
// docs/design/nextjs-adapter.md §3.
//
// Tier 4. Built so far: N1a/N1b-1 (server composition, ./server) + N3 (register dispatcher +
// onRequestError bridge).
export {
  createOnRequestError,
  type NextOnRequestError,
  type NextRequestErrorContext,
  type NextRequestErrorRequest,
  type OnRequestErrorOptions,
  onRequestError,
} from './on-request-error';
export { register } from './register';
