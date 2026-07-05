// @bugsee/nextjs — the client↔server trace channel (the moat's correlation capstone).
//
// `getBugseeTraceData()` reads the ACTIVE server-request trace and returns it as a W3C `traceparent`,
// for injection into the SSR'd HTML via `generateMetadata()`. The `@bugsee/browser` client reads
// `<meta name="traceparent">` on pageload and adopts that trace id — so the initial page's CLIENT session
// and the SSR SERVER request become ONE trace (BE→FE continuation). Combined with the FE→BE header
// propagation the platform launches already wire, this closes the loop: the client session and the server
// throw the N3 `onRequestError` bridge reports share a single trace.
//
// RUNTIME-PORTABLE: runs in `generateMetadata()` on the node OR edge server runtime. The trace read +
// traceparent formatting is the shared `@bugsee/adapter-kit` `traceMetaEntries` (P5) — Next just re-exports
// it under the framework-idiomatic name. Fully defensive — never throws out of `generateMetadata`.
import { type TraceDataOptions, traceMetaEntries } from '@bugsee/adapter-kit';

export type GetBugseeTraceDataOptions = TraceDataOptions;

/**
 * Read the active server-request trace as Next.js `Metadata.other` entries — spread the result into
 * `generateMetadata()`'s `other` so Next renders `<meta name="traceparent" content="…">` and the browser
 * client adopts the SSR trace. Returns `{}` when no trace is active (no `<meta>` emitted).
 *
 * ```ts
 * // app/layout.tsx (App Router)
 * import { getBugseeTraceData } from '@bugsee/nextjs';
 * export function generateMetadata() {
 *   return { other: getBugseeTraceData() };
 * }
 * ```
 */
export function getBugseeTraceData(
  options: GetBugseeTraceDataOptions = {},
): Record<string, string> {
  return traceMetaEntries(options);
}
