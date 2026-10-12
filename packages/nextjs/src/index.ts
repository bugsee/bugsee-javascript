// @bugsee/nextjs — the shared (`.`) entry: runtime-PORTABLE surface only.
//
// Next invokes `instrumentation.ts` exports on both the node AND edge runtimes, so anything exported
// here must be portable (no static node/edge-specific import). Node-only composition lives behind the
// `./server` subpath (reached via `await import` from the `register()` dispatcher).
//
// It exposes the portable surface: the register dispatcher, the onRequestError bridge and the
// getBugseeTraceData trace channel.
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
