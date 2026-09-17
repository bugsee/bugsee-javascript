import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';

// The Node implementation of core's HttpTransport primitive (design §7.5) — the spine for core's
// BugseeApi + BundleUploader. Uses node:http(s) rather than global fetch so proxy agents can be
// injected later (§5/§6). Advertises gzip/deflate (§8.2) and transparently decompresses the
// response. Non-2xx statuses resolve normally (the caller maps status → outcome); only network
// errors and timeouts reject. The transport contract (HttpRequestOptions/HttpResponse) lives in core.

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

// Typed as core's HttpTransport so drift from the contract is caught here, not only at call sites.
/**
 * Settle a promise at most once. Through a real socket the second failure is a RACE — a timeout destroys the
 * request, and the in-flight response errors too — so the guard is its own unit, tested without one.
 */
export function settleOnce<T>(
  resolve: (value: T) => void,
  reject: (error: Error) => void,
): { succeed: (value: T) => void; fail: (error: Error) => void } {
  let settled = false;
  return {
    succeed(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    },
    fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    },
  };
}

export const httpRequest: HttpTransport = (url: string, options: HttpRequestOptions = {}) => {
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const parsed = new URL(url);
  const transport = transportFor(parsed.protocol);

  // Advertise compression unless the caller already set accept-encoding (case-insensitive).
  const hasAcceptEncoding = Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding');
  const outHeaders = hasAcceptEncoding
    ? headers
    : { ...headers, 'accept-encoding': 'gzip, deflate' };

  return new Promise<HttpResponse>((resolve, reject) => {
    const { succeed, fail } = settleOnce(resolve, reject);

    const req = transport.request(parsed, { method, headers: outHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', fail);
      res.on('end', () => {
        try {
          const decoded = decode(Buffer.concat(chunks), res.headers['content-encoding']);
          // A no-op if a prior error/timeout already settled the promise.
          succeed({
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
};
