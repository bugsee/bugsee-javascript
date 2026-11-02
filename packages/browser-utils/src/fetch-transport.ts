import {
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  isBlobBundleBody,
  isBundleBody,
} from '@bugsee/core';

// The browser implementation of core's HttpTransport primitive — the fetch analog of
// node-utils `httpRequest`. Wraps the platform `fetch`; non-2xx statuses RESOLVE (the caller maps
// status → outcome), only network errors and timeouts reject. Unlike the node transport it does NOT
// touch Accept-Encoding or decompress: the browser owns content negotiation and decodes the body
// automatically (and Accept-Encoding is a forbidden header). The contract lives in core.

const DEFAULT_TIMEOUT_MS = 30_000;

/** The `fetch` shape the transport calls. Injectable so tests pass a fake; default `globalThis.fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Build an {@link HttpTransport} over `fetchImpl` (default: a late-bound call to `globalThis.fetch`,
 * so it resolves the current global at call time and keeps fetch's required `this` binding).
 */
export function createFetchTransport(fetchImpl?: FetchLike): HttpTransport {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  const transport = async (
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse> => {
    const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        // A BundleBody: a Blob-backed one goes as its Blob (the engine reads it from wherever it keeps it); anything else
        // is turned into bytes (free for an in-memory one).
        const sent =
          typeof body !== 'string' && isBundleBody(body)
            ? isBlobBundleBody(body)
              ? body.blob
              : (body.peek() ?? (await body.bytes()))
            : body;
        // lib.dom's `BodyInit` arms don't include the generic `Uint8Array<ArrayBufferLike>` shape,
        // but a string and a Uint8Array are both valid request bodies at runtime — widen safely.
        init.body = sent as BodyInit;
      }
      const response = await doFetch(url, init);
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      return {
        status: response.status,
        headers: outHeaders,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (error) {
      // The timeout fires via the abort signal; surface it as a clear timed-out error regardless of
      // how the underlying fetch reports the abort. A genuine network error is rethrown untouched.
      if (controller.signal.aborted) {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.assign(transport, { acceptsBundleBody: true as const });
}

/** The default browser transport, over `globalThis.fetch`. */
export const fetchTransport: HttpTransport = createFetchTransport();
