import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync } from 'node:zlib';

// Promisified node:http(s) request — the transport spine for @bugsee/node's BugseeApi and
// BundleUploader (design §7.5). Uses node:http(s) rather than global fetch so proxy agents can be
// injected later (§5/§6). Advertises gzip/deflate (§8.2) and transparently decompresses the
// response. Non-2xx statuses resolve normally (the caller maps status → outcome); only network
// errors and timeouts reject.

export interface HttpRequestOptions {
  /** HTTP method. Default 'GET'. */
  method?: string;
  /** Request headers. `accept-encoding` defaults to 'gzip, deflate' unless the caller sets it. */
  headers?: Record<string, string>;
  /** Request body. */
  body?: Uint8Array | string;
  /** Abort + reject after this many ms. Default 30_000. */
  timeoutMs?: number;
}

export interface HttpResponse {
  /** HTTP status code (0 if the response had none). */
  status: number;
  /** Response headers (node-lowercased keys). */
  headers: IncomingHttpHeaders;
  /** Decompressed response body bytes. */
  body: Uint8Array;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The node transport module for a URL protocol (https for `https:`, http otherwise). */
export function transportFor(protocol: string): typeof http | typeof https {
  return protocol === 'https:' ? https : http;
}

function decode(body: Buffer, encoding: string | string[] | undefined): Buffer {
  if (encoding === 'gzip') {
    return gunzipSync(body);
  }
  if (encoding === 'deflate') {
    return inflateSync(body);
  }
  return body;
}

export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const parsed = new URL(url);
  const transport = transportFor(parsed.protocol);

  // Advertise compression unless the caller already set accept-encoding (case-insensitive).
  const hasAcceptEncoding = Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding');
  const outHeaders = hasAcceptEncoding
    ? headers
    : { ...headers, 'accept-encoding': 'gzip, deflate' };

  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const req = transport.request(parsed, { method, headers: outHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', fail);
      res.on('end', () => {
        try {
          const decoded = decode(Buffer.concat(chunks), res.headers['content-encoding']);
          // resolve is a no-op if a prior error/timeout already settled the promise.
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: new Uint8Array(decoded),
          });
        } catch (error) {
          fail(error as Error);
        }
      });
    });

    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}
