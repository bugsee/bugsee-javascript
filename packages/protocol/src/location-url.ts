import { redactSensitivePairs } from './pairs';
import { REDACTED_URL_ENCODED } from './sensitive';
import { redactShapes, type ShapeRedactionOptions } from './shapes';
import { sanitizeUrl } from './url';

// Sanitizer for the page's OWN address: the `url` system trace and the navigation breadcrumbs. `sanitizeUrl` is the
// NETWORK sanitizer and is intentionally left as it is (it scans http(s)-style `scheme://authority/path?query#fragment`
// and nothing else). A page can be at any address the browser opens, and three measured gaps of `sanitizeUrl` matter
// there: `data:text/plain;token=abc,hello` has its payload read as `key=value` pairs and half-eaten,
// `blob:https://u:p@a.com/x` keeps its password (a `blob:` URL has no `://` after the scheme, so the userinfo is not
// recognised), and `file:`/`javascript:` URLs pass through whole (a local path names the user's home directory).
// So this layer adds deliberate SCHEME HANDLING, then defers to `sanitizeUrl` for everything else, and adds a bounded
// scan of a URL nested inside a query value (`?next=https://x/?token=…`).
//
// Never throws: a URL we merely observed must not break the host. Linear: no recursion except the bounded nested
// scan below (constant depth, each level scanning only its own sub-string, so total work stays a small multiple of
// the input length; `pairs.ts` explains the quadratic version that this must not become).

/** How many levels of URL-inside-a-query are scanned. A constant, so the work is at most (MAX + 1) x the input. */
const MAX_NESTED_DEPTH = 2;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
/** An absolute or protocol-relative URL: the shape of a query value that is itself an address. */
const NESTED_RAW = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//;
/** The same, percent-encoded (`https%3A%2F%2F…` or `%2F%2F…`). */
const NESTED_ENCODED = /^(?:[A-Za-z][A-Za-z0-9+.-]*%3A)?%2F%2F/i;
/** `scheme://authority` at the start of a blob/filesystem inner URL. */
const INNER_ORIGIN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#\\]*)/;

/** A scheme whose body is data or code, not an address: nothing of it is kept. */
const OPAQUE_SCHEMES = new Set(['data', 'javascript', 'vbscript']);
/** A scheme that wraps an origin plus an unguessable handle: only the origin is kept. */
const ORIGIN_ONLY_SCHEMES = new Set(['blob', 'filesystem']);

const decode = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined; // malformed escapes are common; leave the value alone
  }
};

/**
 * `file:` keeps `file:///…/<last path segment>`, so a local path (`/Users/bob/…`, `C:\Users\…`, a UNC host) never
 * reaches the bundle while the page is still recognisable. The query and fragment are kept and redacted like http's:
 * an Electron app routing on `file:///app/index.html#/orders/42` is told apart by its fragment.
 */
function sanitizeFileUrl(afterScheme: string, options: ShapeRedactionOptions | undefined): string {
  let rest = afterScheme;
  if (rest.startsWith('//')) {
    const end = rest.slice(2).search(/[/?#]/);
    rest = end < 0 ? '' : rest.slice(2 + end); // drop the authority (a host / UNC share)
  }
  const hash = rest.indexOf('#');
  const fragment = hash < 0 ? undefined : rest.slice(hash + 1);
  const beforeHash = hash < 0 ? rest : rest.slice(0, hash);
  const question = beforeHash.indexOf('?');
  const query = question < 0 ? undefined : beforeHash.slice(question + 1);
  const path = question < 0 ? beforeHash : beforeHash.slice(0, question);
  const segment = path.slice(path.lastIndexOf('/') + 1);
  const keptSegment = redactSensitivePairs(segment, 0, segment.length, true);
  const keptQuery = query === undefined ? undefined : redactSensitivePairs(query, 0, query.length);
  const keptFragment =
    fragment === undefined ? undefined : redactSensitivePairs(fragment, 0, fragment.length);
  return redactShapes(
    `file:///…/${keptSegment}${keptQuery === undefined ? '' : `?${keptQuery}`}${
      keptFragment === undefined ? '' : `#${keptFragment}`
    }`,
    options,
  );
}

/**
 * Sanitize each query value that is itself a URL, to a fixed depth. `sanitizeUrl` scans only the first `?`'s own
 * pairs, so a secret one level down (`?next=https://x/?token=…`, the OAuth `redirect_uri` shape) shipped.
 * Unencoded and percent-encoded values are both handled; an encoded value is decoded ONCE, sanitized, and re-encoded
 * only when the sanitizer changed it, so an untouched URL stays byte-identical.
 */
function sanitizeNestedQueryUrls(
  url: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) {
    return url;
  }
  const hash = url.indexOf('#', queryStart);
  const queryEnd = hash < 0 ? url.length : hash;
  const pieces: string[] = [];
  let changed = false;
  let pos = queryStart + 1;
  let copyFrom = 0;
  while (pos < queryEnd) {
    let segEnd = pos;
    let eq = -1;
    for (; segEnd < queryEnd; segEnd += 1) {
      const c = url[segEnd];
      if (c === '&' || c === ';') {
        break;
      }
      if (eq < 0 && c === '=') {
        eq = segEnd;
      }
    }
    if (eq >= 0) {
      const value = url.slice(eq + 1, segEnd);
      let replacement: string | undefined;
      if (NESTED_RAW.test(value)) {
        replacement = sanitizeAddress(value, options, depth + 1);
      } else if (NESTED_ENCODED.test(value)) {
        const decoded = decode(value);
        if (decoded !== undefined) {
          const clean = sanitizeAddress(decoded, options, depth + 1);
          replacement = clean === decoded ? value : encodeURIComponent(clean);
        }
      }
      if (replacement !== undefined && replacement !== value) {
        pieces.push(url.slice(copyFrom, eq + 1), replacement);
        copyFrom = segEnd;
        changed = true;
      }
    }
    pos = segEnd + 1;
  }
  return changed ? pieces.join('') + url.slice(copyFrom) : url;
}

function sanitizeAddress(
  input: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  // The browser drops tab/CR/LF anywhere in a URL and skips leading C0 controls and spaces, so `java\tscript:` IS
  // `javascript:`. Normalise first, or the scheme check below is a bypass.
  const stripped = input.replace(/[\t\n\r]/g, '');
  let from = 0;
  while (from < stripped.length && stripped.charCodeAt(from) <= 0x20) {
    from += 1;
  }
  const url = stripped.slice(from);
  const scheme = SCHEME.exec(url);
  if (scheme !== null) {
    const name = (scheme[1] as string).toLowerCase();
    const rest = url.slice(scheme[0].length);
    if (OPAQUE_SCHEMES.has(name)) {
      return `${name}:${REDACTED_URL_ENCODED}`;
    }
    if (ORIGIN_ONLY_SCHEMES.has(name)) {
      const origin = INNER_ORIGIN.exec(rest);
      if (origin === null) {
        return `${name}:${REDACTED_URL_ENCODED}`; // `blob:null/…`: an opaque origin, nothing to keep
      }
      // The authority's userinfo is dropped WHOLE (the part before the last `@`), not just its password.
      const authority = origin[2] as string;
      return `${name}:${origin[1]}://${authority.slice(authority.lastIndexOf('@') + 1)}`;
    }
    if (name === 'view-source') {
      return depth >= MAX_NESTED_DEPTH
        ? `${name}:${REDACTED_URL_ENCODED}`
        : `${name}:${sanitizeAddress(rest, options, depth + 1)}`;
    }
    if (name === 'file') {
      return sanitizeFileUrl(rest, options);
    }
  }
  const flat = sanitizeUrl(url, options);
  return depth < MAX_NESTED_DEPTH ? sanitizeNestedQueryUrls(flat, options, depth) : flat;
}

/**
 * Sanitize the page's own address. Scheme rules, by input:
 *  - `data:`, `javascript:`, `vbscript:` become `<scheme>:%3Credacted%3E` (the body is data or code, never an address);
 *  - `blob:` / `filesystem:` keep only the inner origin (`blob:https://a.com`), never userinfo, path or query;
 *  - `file:` becomes `file:///…/<last segment>` (query and fragment kept, redacted as for http);
 *  - `view-source:` sanitizes what it wraps;
 *  - everything else is `sanitizeUrl` (userinfo password, sensitive query/fragment/matrix values, secret shapes),
 *    plus a bounded scan of URLs nested in a query value.
 * Returns the redaction placeholder for a non-string, and never throws.
 */
export function sanitizeLocationUrl(url: string, options?: ShapeRedactionOptions): string {
  if (typeof url !== 'string') {
    return REDACTED_URL_ENCODED;
  }
  try {
    return sanitizeAddress(url, options, 0);
  } catch {
    return REDACTED_URL_ENCODED; // fail closed: an unreadable address is not shipped
  }
}
