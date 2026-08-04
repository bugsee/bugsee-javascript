import { utf8ByteLength } from '@bugsee/util';
import { redactFormBody } from './pairs';
import { isSensitiveHeader, isSensitiveKey, REDACTED } from './sensitive';
import { redactShapes, type ShapeRedactionOptions } from './shapes';
import type { NetworkEvent, NoBodyReason } from './wire';

// Object/header/param sanitization (design §8.10): apply the key denylists (§sensitive) and the
// shape pass (§shapes). Inputs are not mutated; outputs are null-prototype so a `__proto__` key
// (e.g. from JSON.parse'd untrusted data) is stored as own data and cannot corrupt a prototype.

/**
 * Coerce a captured value to text without ever throwing.
 *
 * `String(x)` is not total: a null-prototype object, or one with a throwing `toString`/`Symbol.toPrimitive`,
 * throws `TypeError: Cannot convert object to primitive value`. Since the whole point of coercing here is
 * that a throw inside the sanitizer makes the emitter drop the entire network entry, the coercion itself
 * must not be able to throw.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return String(value);
  } catch {
    return REDACTED; // unreadable → fail closed rather than lose the entry
  }
}

/**
 * Redacts sensitive header values entirely; shape-scans the rest. Header names/casing preserved.
 *
 * Values are COERCED, not trusted to be strings. The type says `string`, but headers arrive from
 * application code: `setRequestHeader('X-Count', 42)` is ordinary JS that the browser coerces without
 * complaint. `redactShapes` then called `.replace` on a number and threw, the throw was swallowed by the
 * emitter's dispatch, and the entire network entry vanished — request headers AND request body — with no
 * diagnostic. A sanitizer silently deleting the data it was asked to sanitize is the worst failure mode
 * available to it, so this fails toward "capture something".
 */
export function sanitizeHeaders(
  headers: Record<string, string>,
  options?: ShapeRedactionOptions,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? REDACTED : redactShapes(asText(value), options);
  }
  return out;
}

/** Flat query/form params: sensitive key -> redacted; other values shape-scanned. Values are coerced for
 *  the same reason {@link sanitizeHeaders} coerces them — a throw here deletes the whole entry. */
export function sanitizeParams(
  params: Record<string, string>,
  options?: ShapeRedactionOptions,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(params)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactShapes(asText(value), options);
  }
  return out;
}

/**
 * Recursively sanitizes a parsed JSON value: object keys checked against the key denylist (sensitive
 * -> redacted), string values shape-scanned, arrays/objects recursed, other primitives unchanged.
 *
 * A sensitive key's value is replaced WHOLE, whatever its type — the subtree is never walked. I briefly
 * changed this to walk and redact each leaf so a report could show which fields existed; review round 5
 * found that wrong on three independent counts:
 *
 *  1. It opened a redaction BYPASS. Walking recurses, so a deep body threw RangeError out of here,
 *     `sanitizeBody`'s catch fell to the textual passes, and `JSON_PAIR` cannot match `"password":{` —
 *     its value alternative excludes `{`. Measured: safe at every depth before, leaking from ~4000 after.
 *  2. KEY NAMES became a leak channel. `{"tokens":{"eyJ…":true}}` emitted the token, because the token IS
 *     the key. Maps keyed by a secret or an identifier (session→token, user→credential) are ordinary.
 *  3. It broke Android parity, which CLAUDE.md makes binding: `NetworkDataSanitizer` does
 *     `obj.put(key, REDACTED_VALUE)` unconditionally, and sdk-design.md requires byte-identical output.
 *
 * The diagnostic cost is accepted and real: inside a subtree the app labelled `password`/`token`/`secret`,
 * a report cannot show which fields existed. Recovering that safely needs a shape SUMMARY (key count and
 * types, never key names) plus a backend contract — not a walk.
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
      // Keep the `\r` that `split('\n')` left on the end of the line. Dropping it deleted every CRLF in a
      // redacted body — STOMP frames are CRLF by spec — so the uploaded body no longer matched the bytes
      // on the wire. The identical defect was fixed in the NDJSON path and not swept to here.
      const cr = line.endsWith('\r') ? '\r' : '';
      return `${line.slice(0, colon + 1)}${REDACTED}${cr}`;
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
      // `split('\n')` leaves the `\r` of a CRLF on the end of the line. JSON.parse tolerates it and
      // JSON.stringify discards it, so every `\r` in the body was silently deleted — the re-serialized
      // report then differed from the bytes on the wire. Strip it for parsing, put it back after.
      const cr = line.endsWith('\r') ? '\r' : '';
      out.push(JSON.stringify(sanitizeJson(JSON.parse(line), options)) + cr);
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
 * `"key": value` pairs, for JSON-SHAPED text that does not parse.
 *
 * ANCHORED on `[{,]` — a JSON key is always preceded by an opening brace or a comma. That is not cosmetic:
 * the unanchored form was quadratic for exactly the reason the JWT pattern was, a candidate start at every
 * `"`. On `{"\"\"\"…` (escaped quotes, never closed) it cost 16 ms at 8 KB and 227 ms at 32 KB; anchored it
 * is 0.43 ms at 256 KB. I wrote the unanchored version first, in this same review round, having just fixed
 * that defect one file over.
 *
 * The unquoted-value alternative excludes `{` and `"` so a scalar cannot swallow a nested object — without
 * that, `{"outer":{"password":"p"}}` consumed the inner object as `outer`'s value and the nested secret
 * escaped. The separator is captured and replayed so only the VALUE's bytes change.
 */
const JSON_PAIR =
  /([{,]\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\]\s{"']+)/g;

/**
 * Textual key redaction for a body that is JSON-shaped but is NOT a JSON document.
 *
 * Reached when both `JSON.parse` and the NDJSON pass fail, where the fallbacks are structurally blind: the
 * form pass needs an `=`, and the colon pass's HEADER_TOKEN rejects `{"password"` as a field name. So a body
 * like `{"password":"hunter2","score":NaN}` got ZERO redaction — not partial, none. That exact shape is what
 * Python's `json.dumps` emits by default (`allow_nan=True`), so Flask/FastAPI/Django responses carrying
 * numpy or pandas values hit it routinely; truncated and trailing-comma documents land here too.
 */
function redactJsonPairs(body: string): string {
  return body.replace(
    JSON_PAIR,
    (
      match,
      lead: string,
      dq: string | undefined,
      sq: string | undefined,
      bare: string | undefined,
      separator: string,
    ) => {
      const key = dq ?? sq ?? bare ?? '';
      if (!isSensitiveKey(key)) {
        return match;
      }
      // Re-emit the key in the quoting style it arrived in, so only the VALUE's bytes change.
      const quoted = dq !== undefined ? `"${key}"` : sq !== undefined ? `'${key}'` : key;
      const marker = sq !== undefined ? `'${REDACTED}'` : `"${REDACTED}"`;
      return `${lead}${quoted}${separator}${marker}`;
    },
  );
}

/**
 * Redact sensitive parts of a `multipart/form-data` body, or undefined when it is not multipart.
 *
 * Nothing else could reach these: a part's value sits alone after a blank line carrying no `=` and no `:`,
 * and the part header's own key (`Content-Disposition`) is not sensitive — so a file-upload login form
 * shipped its password verbatim through every textual pass. Split on the boundary rather than matched with
 * a regex, so a large body cannot backtrack.
 */
/**
 * The `name` parameter of a part's Content-Disposition, or undefined.
 *
 * Anchored on `;` or whitespace so it cannot match inside `filename=`. The un-anchored `/name="([^"]*)"/`
 * did exactly that: RFC 7578 does not mandate parameter order, so `filename="a.txt"; name="password"` gave
 * the captured name `a.txt`, which is not sensitive, and the password shipped. Quoted, single-quoted and
 * bare-token forms are all legal and all accepted.
 */
function partName(headers: string): string | undefined {
  const m = /(?:^|[;\s])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(headers);
  return m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
}

function redactMultipart(body: string, contentType: string | undefined): string | undefined {
  const declared = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  // The Content-Type is the authority, but a captured body sometimes arrives without one; the first line of
  // a multipart body IS the delimiter, so sniff it rather than give up and ship the value. `firstLine` must
  // be checked before slicing — a body starting with `--` and carrying no CRLF gives `indexOf` -1, and
  // `slice(0, -1)` would silently produce a delimiter one character short of the whole body.
  const firstLine = body.indexOf('\r\n');
  const sniffed =
    body.startsWith('--') && firstLine > 2
      ? body.slice(0, firstLine)
      : /* not multipart */ undefined;
  const delimiter = declared === null ? sniffed : `--${declared[1] ?? declared[2]}`;
  if (delimiter === undefined || delimiter === '--') {
    return undefined;
  }
  const parts = body.split(delimiter);
  if (parts.length < 2) {
    return undefined;
  }
  let changed = false;
  const out = parts.map((part) => {
    // CRLF is what the RFC says; bare LF is what several real clients send. Taking whichever blank line
    // comes first — rather than `indexOf('\r\n\r\n')` alone — is the difference between reading the part
    // and skipping it entirely, and skipping it shipped the value.
    const crlf = part.indexOf('\r\n\r\n');
    const lf = part.indexOf('\n\n');
    const sep = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf;
    if (sep < 0) {
      return part; // a preamble, the closing `--`, or a part with no header block
    }
    const gap = sep === crlf ? 4 : 2;
    const name = partName(part.slice(0, sep));
    if (name === undefined || !isSensitiveKey(name)) {
      return part;
    }
    changed = true;
    const value = part.slice(sep + gap);
    // Keep the line break that separates the value from the next boundary — framing, not content.
    const trailing = value.endsWith('\r\n') ? '\r\n' : value.endsWith('\n') ? '\n' : '';
    return `${part.slice(0, sep)}${part.slice(sep, sep + gap)}${REDACTED}${trailing}`;
  });
  return changed ? out.join(delimiter) : undefined;
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
      // JSON-shaped but not a document (NaN/Infinity, a trailing comma, truncation). Read the pairs
      // textually rather than hand the body to passes that cannot see JSON keys at all — then still run
      // the form and colon passes, because a body can arrive under a JSON Content-Type and be neither
      // (`password=hunter2` sent as `application/json` is real, and only the form pass reads it).
      return redactShapes(
        redactSensitiveColonLines(redactFormBody(redactJsonPairs(body))),
        options,
      );
    }
  }
  // The multipart pass ADDS to the textual passes; it does not replace them. Returning its result early
  // meant redacting one part switched the form and colon passes off for the whole body — so a part holding
  // `api_key: sk_live_…` or `token=…` shipped in the clear BECAUSE a sibling part had been redacted.
  // Redacting one secret un-redacted another.
  const multipart = redactMultipart(body, contentType) ?? body;
  return redactShapes(redactSensitiveColonLines(redactFormBody(multipart)), options);
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
  // Coerced HERE rather than at each call site. Both consumers assume a string and both throw on a number
  // — `sanitizeBody` via `.toLowerCase()`, `gateNetworkBody` via `.trim()` — and either throw is swallowed
  // by the emitter, deleting the whole network entry. Fixing only `sanitizeBody`'s caller left the gate
  // still crashing; the accessor is the shared seam, so the guard belongs in it.
  const found = findHeader(headers, 'content-type');
  return found === undefined ? undefined : asText(found);
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
