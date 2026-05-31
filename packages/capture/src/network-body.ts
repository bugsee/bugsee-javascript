import type { NoBodyReason } from '@bugsee/protocol';
import { utf8ByteLength } from '@bugsee/util';

// Runtime-agnostic helpers shared by the request/response capture interceptors (fetch, xhr, and later
// node:http) for body population: synchronous request-body reading + the fetch-spec implied
// Content-Type, case-insensitive header lookup, and UTF-8 chunk decoding. Interceptors emit RAW bodies;
// the networkProvider (F.1) gates (size / Content-Type) and sanitizes.

/** fetch's spec-default Content-Type for a string body (when the caller sets none) — captured so the
 * downstream gate doesn't drop the body as `no_content_type`. */
export const TEXT_PLAIN_TYPE = 'text/plain;charset=UTF-8';
/** fetch's spec-default Content-Type for a URLSearchParams body. */
export const FORM_URLENCODED_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8';

export interface SyncBodyRead {
  /** The captured body text (string / URLSearchParams), if synchronously readable. */
  body?: string;
  /** Why the body is absent, if it could not be read synchronously. */
  reason?: NoBodyReason;
  /** The runtime-implied Content-Type for this body type (caller-set CT takes precedence). */
  contentType?: string;
}

/**
 * Read a request body that is synchronously available WITHOUT consuming a stream: a string (verbatim)
 * or URLSearchParams (serialized), each tagged with the Content-Type the runtime implies on the wire.
 * `null`/`undefined` → no body (neither field). Any other type (FormData / Blob / ArrayBuffer / typed
 * array / Document / ReadableStream) is not synchronously readable → `cant_read_data`. Never consumes
 * the value.
 */
export const readSyncRequestBody = (body: unknown): SyncBodyRead => {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body === 'string') {
    return { body, contentType: TEXT_PLAIN_TYPE };
  }
  const USP = (globalThis as unknown as { URLSearchParams?: new () => unknown }).URLSearchParams;
  if (typeof USP === 'function' && body instanceof USP) {
    return { body: String(body), contentType: FORM_URLENCODED_TYPE };
  }
  return { reason: 'cant_read_data' };
};

/**
 * Bound an ALREADY-BUFFERED body string (e.g. XHR `responseText`) by the byte cap: over `maxBytes`
 * UTF-8 bytes → `size_too_large` (the body is not included), else the body is kept. The `length`
 * fast-path avoids measuring a huge string (UTF-8 bytes ≥ UTF-16 length, so `length > cap` ⇒ over cap).
 */
export const boundedText = (text: string, maxBytes: number): SyncBodyRead => {
  if (text.length > maxBytes || utf8ByteLength(text) > maxBytes) {
    return { reason: 'size_too_large' };
  }
  return { body: text };
};

/** True when the header map already carries a Content-Type (case-insensitive). */
export const hasContentType = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');

/** Case-insensitive header lookup over a record (header maps preserve the producer's casing). */
export const headerValueCI = (
  headers: Record<string, string>,
  name: string,
): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
};

/** Concatenate UTF-8 chunks and decode, or undefined when TextDecoder is unavailable in this runtime. */
export const decodeUtf8 = (chunks: Uint8Array[]): string | undefined => {
  const Decoder = (
    globalThis as unknown as { TextDecoder?: new () => { decode: (b: Uint8Array) => string } }
  ).TextDecoder;
  if (typeof Decoder !== 'function') {
    return undefined;
  }
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Decoder().decode(all);
};
