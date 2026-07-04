// @bugsee/nextjs — the shared (`.`) entry: runtime-PORTABLE surface only.
//
// Next invokes `instrumentation.ts` exports on both the node AND edge runtimes, so anything exported
// here must be portable (no static node/edge-specific import). Node-only composition lives behind the
// `./server` subpath (reached via `await import` from the `register()` dispatcher). See
// docs/design/nextjs-adapter.md §3.
//
// Tier 4. Built so far: N1a/N1b-1 (./server) + N2 (./edge) + N4 (./client) + N3 (register dispatcher +
// onRequestError bridge) + N7 (getBugseeTraceData trace channel) — the portable surface is here.
export {
  createOnRequestError,
  type NextOnRequestError,
  type NextRequestErrorContext,
  type NextRequestErrorRequest,
  type OnRequestErrorOptions,
  onRequestError,
} from './on-request-error';
export { type NextjsRegisterOptions, register } from './register';
export { type GetBugseeTraceDataOptions, getBugseeTraceData } from './trace-data';
