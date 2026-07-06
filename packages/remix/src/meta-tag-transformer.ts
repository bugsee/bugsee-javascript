// @bugsee/remix — the node stream trace-meta transformer (P5, node half).
//
// Node-only (uses `node:stream`) → exported from `@bugsee/remix/server`. Wire it into the
// `renderToPipeableStream` pipe in a Node `entry.server.tsx` so the trace `<meta>` is spliced into the
// streamed SSR HTML before `</head>` (mirrors React Router v7's `getMetaTagTransformer`):
//
// ```tsx
// import { getBugseeMetaTagTransformer } from '@bugsee/remix/server';
// onShellReady() {
//   const body = new PassThrough();
//   const stream = createReadableStreamFromReadable(body);
//   responseHeaders.set('Content-Type', 'text/html');
//   resolve(new Response(stream, { headers: responseHeaders, status }));
//   pipe(getBugseeMetaTagTransformer(body));   // React → transformer → body
// }
// ```
import { Transform, type Writable } from 'node:stream';
import type { TraceDataOptions } from '@bugsee/adapter-kit';
import { getBugseeTraceMetaTags } from './trace-meta';

/**
 * A `node:stream` `Transform` that injects the active server trace's `<meta name="traceparent">` before
 * `</head>` in the streamed SSR HTML, then pipes to `body`. The trace is read ONCE at creation (stable for
 * the response). No-op (pass-through) when no trace is active. Return this from `pipe(...)` in a Node
 * `entry.server`.
 */
export function getBugseeMetaTagTransformer(
  body: Writable,
  options: TraceDataOptions = {},
): Transform {
  const meta = getBugseeTraceMetaTags(options);
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (meta === '') {
        callback(null, chunk); // no trace → pass through untouched
        return;
      }
      // Per-chunk replace of the first `</head>`. If `</head>` ever straddles a chunk boundary (extremely
      // rare — the framework emits it in one head chunk) the meta is simply not injected; worst case the
      // pageload starts a fresh trace (same as no-meta), never broken HTML. Matches RR7/Sentry's approach.
      const html = chunk.toString();
      callback(null, html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : chunk);
    },
  });
  transform.pipe(body);
  return transform;
}
