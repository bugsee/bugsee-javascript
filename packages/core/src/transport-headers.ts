import type { HttpRequestOptions, HttpResponse, HttpTransport } from './transport';

/**
 * Wrap a transport so every request carries extra headers (the launchers tag SDK traffic `x-bugsee-internal`). The wrapper
 * keeps the inner transport's `acceptsBundleBody` flag: dropping it would silently turn every streamed upload back into a
 * whole-bundle read.
 */
export function withTransportHeaders(
  transport: HttpTransport,
  headers: Readonly<Record<string, string>>,
): HttpTransport {
  const wrapped = (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> =>
    transport(url, { ...options, headers: { ...options.headers, ...headers } });
  return transport.acceptsBundleBody === true
    ? Object.assign(wrapped, { acceptsBundleBody: true as const })
    : wrapped;
}
