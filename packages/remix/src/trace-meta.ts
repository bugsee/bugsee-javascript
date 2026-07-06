// @bugsee/remix — the trace-meta string builder (P5, portable half).
//
// Reads the active server-request trace and renders a `<meta name="traceparent">` tag for injection into
// the SSR HTML `<head>`. The `@bugsee/browser` client reads it on pageload and adopts the trace id, so the
// SSR server request and the initial client pageload become ONE trace (BE→FE continuation). The node
// stream `getBugseeMetaTagTransformer` (`@bugsee/remix/server`) injects this before `</head>`.
//
// PORTABLE (node + edge): the trace read + traceparent formatting is the shared `@bugsee/adapter-kit`
// `getTraceparent`. The `traceparent` value is a fixed `version-hex-hex-hex` shape (no HTML-special chars),
// so no attribute escaping is needed.
import { getTraceparent, type TraceDataOptions } from '@bugsee/adapter-kit';

/** The `<meta name="traceparent">` tag for the active server trace, or `''` when no trace is active. */
export function getBugseeTraceMetaTags(options: TraceDataOptions = {}): string {
  const traceparent = getTraceparent(options);
  return traceparent === undefined ? '' : `<meta name="traceparent" content="${traceparent}">`;
}
