// @bugsee/astro — the request middleware (Astro's `onRequest`).
//
// Astro has NO `onRequestError` hook, so the middleware WRAPS `next()` in a try/catch to report a thrown
// route/render error (the moat's server-error path), then RETHROWS so Astro still renders its error page.
// Because the middleware wraps `next()`, it is also where the trace `<meta>` is injected (an HTML
// response-rewrite before `</head>`) so the client pageload adopts the server trace (FE↔BE join). On node
// the per-request context comes from @bugsee/node's `node:http` emit-patch; the `@bugsee/astro/edge`
// middleware additionally opens the context.
//
// The Astro Integration wires this via `addMiddleware({ entrypoint: '@bugsee/astro/middleware', order:
// 'pre' })`. RUNTIME-PORTABLE (adapter-kit only) + fully defensive — never breaks the response.
import { reportServerError, type TraceDataOptions, traceMetaTag } from '@bugsee/adapter-kit';

/** The subset of Astro's middleware `context` (`APIContext`) we read (structural; no `astro` import). */
export interface AstroMiddlewareContext {
  request: Request;
}

/** Astro's middleware `next` — resolves the downstream `Response`. */
export type AstroMiddlewareNext = () => Promise<Response>;

/** An Astro `onRequest` middleware. */
export type AstroMiddleware = (
  context: AstroMiddlewareContext,
  next: AstroMiddlewareNext,
) => Promise<Response>;

export interface CreateBugseeMiddlewareOptions extends TraceDataOptions {}

/** The request path (no query string — report attributes don't pass the redaction pipeline, so a secret in
 *  `?token=…` must not leak), best-effort. */
function safePath(url: string | undefined): string | undefined {
  try {
    // `new URL(undefined)` throws too, so the catch covers both a missing and a malformed url.
    return new URL(url as string).pathname;
  } catch {
    return undefined;
  }
}

/** Report a thrown Astro route error with method/path attribution. Fully defensive. */
function reportAstroError(
  error: unknown,
  context: AstroMiddlewareContext,
  options: TraceDataOptions,
): void {
  const path = safePath(context?.request?.url);
  reportServerError(error, {
    ...(options.getClient !== undefined ? { getClient: options.getClient } : {}),
    event: {
      name: 'astro.request-error',
      params: {
        ...(context?.request?.method !== undefined ? { method: context.request.method } : {}),
        ...(path !== undefined ? { path } : {}),
      },
    },
    mechanism: 'http-error',
  });
}

/** Inject the trace `<meta>` into an HTML response before `</head>`; return the ORIGINAL response untouched
 *  when it is not HTML, has no active trace, or has no `</head>`. Rewriting buffers the body (Astro's
 *  response is not streamed here) + drops the now-stale `content-length`. */
async function injectTraceIntoResponse(
  response: Response,
  options: TraceDataOptions,
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return response;
  const tag = traceMetaTag(options);
  if (tag === '') return response;
  const html = await response.text();
  if (!html.includes('</head>')) return new Response(html, response); // body already read → reconstruct
  const headers = new Headers(response.headers);
  headers.delete('content-length'); // the body length changed
  return new Response(html.replace('</head>', `${tag}</head>`), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Build an Astro `onRequest` middleware: report a thrown route error (then rethrow) and inject the trace
 * `<meta>` into the HTML response.
 */
export function createBugseeMiddleware(
  options: CreateBugseeMiddlewareOptions = {},
): AstroMiddleware {
  return async (context, next) => {
    let response: Response;
    try {
      response = await next();
    } catch (error) {
      reportAstroError(error, context, options);
      throw error; // rethrow so Astro renders its error page
    }
    return injectTraceIntoResponse(response, options);
  };
}

/** The ready-made middleware bound to the carrier client. `export const onRequest = onRequest`. */
export const onRequest: AstroMiddleware = createBugseeMiddleware();
