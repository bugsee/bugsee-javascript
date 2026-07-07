// @bugsee/remix — the trace-meta string builder (P5, portable half).
//
// Reads the active server-request trace and renders a `<meta name="traceparent">` tag for injection into
// the SSR HTML `<head>`. The `@bugsee/browser` client reads it on pageload and adopts the trace id, so the
// SSR server request and the initial client pageload become ONE trace (BE→FE continuation). The node
// stream `getBugseeMetaTagTransformer` (`@bugsee/remix/server`) injects this before `</head>`.
//
// PORTABLE (node + edge): both the trace read and the `<meta>` rendering are the shared
// `@bugsee/adapter-kit` `traceMetaTag` (P5). This is a thin, Remix-named re-export of it.
import { type TraceDataOptions, traceMetaTag } from '@bugsee/adapter-kit';

/** The `<meta name="traceparent">` tag for the active server trace, or `''` when no trace is active.
 *  Thin re-export of the shared `@bugsee/adapter-kit` `traceMetaTag`. */
export function getBugseeTraceMetaTags(options: TraceDataOptions = {}): string {
  return traceMetaTag(options);
}
