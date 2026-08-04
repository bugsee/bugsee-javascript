import { utf8ByteLength } from '@bugsee/util';
import { redactFormBody } from './pairs';
import { isSensitiveHeader, isSensitiveKey, REDACTED } from './sensitive';
import { redactShapes, type ShapeRedactionOptions } from './shapes';
import type { NetworkEvent, NoBodyReason } from './wire';

// Object/header/param sanitization (design §8.10): apply the key denylists (§sensitive) and the
// shape pass (§shapes). Inputs are not mutated; outputs are null-prototype so a `__proto__` key
// (e.g. from JSON.parse'd untrusted data) is stored as own data and cannot corrupt a prototype.

/** Redacts sensitive header values entirely; shape-scans the rest. Header names/casing preserved. */
export function sanitizeHeaders(
  headers: Record<string, string>,
  options?: ShapeRedactionOptions,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? REDACTED : redactShapes(value, options);
  }
  return out;
}

/** Flat query/form params: sensitive key -> redacted; other values shape-scanned. */
export function sanitizeParams(
  params: Record<string, string>,
  options?: ShapeRedactionOptions,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactShapes(value, options);
  }
  return out;
}

/**
 * Recursively sanitizes a parsed JSON value: object keys checked against the key denylist (sensitive
 * -> redacted), string values shape-scanned, arrays/objects recursed, other primitives unchanged.
 */
export function sanitizeJson(value: unknown, options?: ShapeRedactionOptions): unknown {
  if (typeof value === 'string') {
    return redactShapes(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item, options));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeJson(val, options);
    }
    return out;
  }
  return value;
}

/**
 * Whether a Content-Type denotes a JSON body: `application/json`, the legacy `text/json`, or any
 * RFC 6839 structured-syntax `+json` suffix (`application/vnd.api+json`, `application/ld+json`,
 * `application/problem+json`, …). Parameters (e.g. `; charset=utf-8`) are ignored; matched on the bare
 * media type so a non-JSON type that merely contains `json` (e.g. `application/json5`) does not match.
 */
function isJsonContentType(contentType: string | undefined): boolean {
  const lower = (contentType ?? '').toLowerCase();
  const semicolon = lower.indexOf(';');
  const mediaType = (semicolon === -1 ? lower : lower.slice(0, semicolon)).trim();
  return (
    mediaType === 'application/json' || mediaType === 'text/json' || mediaType.endsWith('+json')
  );
}

/** A header/STOMP field name: the RFC 7230 token charset, minus the characters that only ever appear in
 *  structured text (`{`, `"`, `,`, whitespace). */
const HEADER_TOKEN = /^[A-Za-z0-9_.!#$%&'*+^`|~-]+$/;

/**
 * Redact the values of sensitive keys in a `key: value` line sequence — the STOMP / header-style shape
 * (`CONNECT\npasscode:s3cret`), which reaches reports because WebSocket frame bodies are captured by
 * default. Line-delimited; each line splits on its FIRST colon. A leading colon is not a key, and a key
 * that is not sensitive is left alone, so timestamps and URLs inside a value survive.
 */
function redactSensitiveColonLines(body: string): string {
  if (!body.includes(':')) {
    return body;
  }
  let changed = false;
  const lines = body.split('\n').map((line) => {
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim();
    // The key must look like a header/STOMP token. Without this, `{"password":"x"}` under a non-JSON
    // Content-Type reads as the key `{"password"` and the pass replaces the rest of the LINE — redacting
    // the value but destroying the closing brace. Refusing to treat punctuation as a key keeps the
    // structural passes from corrupting any body they were not designed to parse.
    if (colon > 0 && HEADER_TOKEN.test(key) && isSensitiveKey(key)) {
      changed = true;
      return `${line.slice(0, colon + 1)}${REDACTED}`;
    }
    return line;
  });
  return changed ? lines.join('\n') : body;
}

/** Sanitize an NDJSON body line by line, or undefined when it is not NDJSON. */
function sanitizeNdjson(body: string, options?: ShapeRedactionOptions): string | undefined {
  if (!body.includes('\n')) {
    return undefined;
  }
  const lines = body.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    try {
      out.push(JSON.stringify(sanitizeJson(JSON.parse(line), options)));
    } catch {
      return undefined; // one unparseable line → not NDJSON; leave the body to the textual passes
    }
  }
  return out.join('\n');
}

/** Does the body look like a JSON document, whatever the Content-Type claims? */
function looksLikeJson(body: string): boolean {
  const first = body.trimStart()[0];
  return first === '{' || first === '[';
}

/**
 * Sanitize a request/response body string by Content-Type (design §8.10). A JSON media type (see
 * {@link isJsonContentType}) → recursive key-denylist redaction (re-serialized). Anything else — INCLUDING
 * a body that claimed a JSON type but does not parse — gets the two textual shapes we can structurally
 * read: form-urlencoded `key=value&…` and colon-delimited `key: value`, then the shape pass.
 *
 * The non-JSON key redaction is Android parity (`NetworkDataSanitizer.sanitizeBody`) and closes
 * docs/review/capture.md SEV1 #5: `new URLSearchParams({username, password})` is the canonical HTML login
 * body, and it was stored verbatim because the denylist ran for JSON media types only. Never throws.
 */
export function sanitizeBody(
  body: string,
  contentType: string | undefined,
  options?: ShapeRedactionOptions,
): string {
  // Parse as JSON when the TYPE says so OR the body SHAPE says so. Type alone was not enough: the textual
  // passes below are structurally incapable of reading JSON (the form pass needs `=`, the colon pass rejects
  // `{"password"` as a field name), so a JSON body under any non-canonical JSON media type was returned
  // verbatim — including `application/x-amz-json-1.1`, the AWS SDK v3 default for DynamoDB, KMS, Cognito and
  // STS, and `application/x-ndjson`. A label must never buy a body LESS redaction than its content earns.
  if (isJsonContentType(contentType) || looksLikeJson(body)) {
    try {
      return JSON.stringify(sanitizeJson(JSON.parse(body), options));
    } catch {
      // Not one JSON document. NDJSON is the common case — `{"a":1}\n{"b":2}` never parses whole, and the
      // textual passes below cannot read JSON at all, so it used to ship verbatim despite the commit that
      // claimed `application/x-ndjson` was covered. Try it line by line, and only accept the result if
      // EVERY non-blank line parses (so prose that merely starts with `{` is not mangled).
      const ndjson = sanitizeNdjson(body, options);
      if (ndjson !== undefined) {
        return ndjson;
      }
    }
  }
  return redactShapes(redactSensitiveColonLines(redactFormBody(body)), options);
}

/** Find a header's value case-insensitively (header maps preserve the producer's casing). */
function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/** The `Content-Type` header value, found case-insensitively (drives body sanitization dispatch). */
export function contentTypeOf(headers: Record<string, string> | undefined): string | undefined {
  return findHeader(headers, 'content-type');
}

export interface NetworkBodyGateOptions {
  /** Max captured body size in UTF-8 bytes; a larger body is dropped (`size_too_large`). */
  maxBytes: number;
  /** Keep a body whose Content-Type is missing/blank (else drop it `no_content_type`). */
  captureWithoutType: boolean;
}

/**
 * Apply the body size + Content-Type policy to a NetworkEvent (Android applyBodyFilters parity, §8.10).
 * Non-mutating. A present `custom.body` is dropped (→ null + `no_body_reason`) when its Content-Type is
 * missing/blank and `captureWithoutType` is off, or when it exceeds `maxBytes`. A producer-set
 * `no_body_reason` (or an absent body) is left untouched.
 */
export function gateNetworkBody(
  event: NetworkEvent,
  options: NetworkBodyGateOptions,
): NetworkEvent {
  const body = event.custom?.body;
  if (body === undefined || body === null || event.custom?.no_body_reason != null) {
    return event;
  }
  const contentType = contentTypeOf(event.custom?.headers);
  let reason: NoBodyReason | null = null;
  if (!options.captureWithoutType && (contentType === undefined || contentType.trim() === '')) {
    reason = 'no_content_type';
  } else if (utf8ByteLength(body) > options.maxBytes) {
    reason = 'size_too_large';
  }
  if (reason === null) {
    return event;
  }
  return { ...event, custom: { ...event.custom, body: null, no_body_reason: reason } };
}
