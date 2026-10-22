import { FRAGMENT_PIECE_BOUNDARY, isFragmentPieceBoundary, redactSensitivePairs } from './pairs';
import { normalizeKey, REDACTED_URL_ENCODED } from './sensitive';
import { redactShapes, type ShapeRedactionOptions } from './shapes';
import { sanitizeUrlCore } from './url';

// Sanitizer for the page's OWN address: the `url` system trace and the navigation breadcrumbs. It builds on
// `sanitizeUrlCore` (the network sanitizer's engine, which scans http(s)-style `scheme://authority/path?query#fragment`)
// and adds what a PAGE address needs: a page can be at any address the browser opens, and `data:text/plain;token=abc,hello`
// would have its payload read as `key=value` pairs and half-eaten, `file:`/`javascript:` URLs would pass through whole (a
// local path names the user's home directory), and nothing nested in a query value would be scanned. So this layer adds
// deliberate SCHEME HANDLING, the location denylist, a tolerant bounded scan of a URL nested inside a query or fragment
// value (`?next=https://x/?token=…`), and a browser-like normalisation of raw strings. (The network `sanitizeUrl` itself
// only gained the userinfo of `blob:`/`filesystem:` URLs and the fragment cut at `#key=`; none of the rest.)
//
// Never throws: a URL we merely observed must not break the host. Linear: no recursion except the bounded nested
// scan below (constant depth, each level scanning only its own sub-string, so total work stays a small multiple of
// the input length; `pairs.ts` explains the quadratic version that this must not become).

/** How many levels of URL-inside-a-query are scanned. A constant: each level costs at most ~3x its input (raw, decoded
 *  once and decoded twice are each tried), so two levels bound the work at a small constant multiple of the length. */
const MAX_NESTED_DEPTH = 2;

/**
 * The longest address processed. The default sanitizer is linear, but a page can set a megabyte `location` (~0.9 s of
 * main-thread time measured for 1 MB, inside the app's own `pushState`), so anything longer is clipped BEFORE any
 * work and carries a marker. A secret past the cut is dropped with the rest of the tail.
 */
const MAX_INPUT_CHARS = 8192;
/** Appended to a clipped address (and to a clipped `urlSanitizer` result). */
export const TRUNCATED_URL_MARKER = '%3Ctruncated%3E';

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
/** A query value that is worth sanitizing as an address: an absolute or protocol-relative URL, a path, `scheme:`
 *  anything, or anything carrying a `?` or `#` (a relative return path with its own query, a bare `#access_token=…`). */
const NESTED_RAW = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/)/;
/** `scheme://authority` at the start of a blob/filesystem inner URL (the authority ends at `/`, `?`, `#` or `\`). */
const INNER_ORIGIN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#\\]*)/;

/** A scheme whose body is data or code, not an address: nothing of it is kept. */
const OPAQUE_SCHEMES = new Set(['data', 'javascript', 'vbscript']);
/** A scheme that wraps an origin plus an unguessable handle: only the origin is kept. */
const ORIGIN_ONLY_SCHEMES = new Set(['blob', 'filesystem']);
/** Schemes the WHATWG parser treats as "special": a backslash is a slash and any run of slashes after the scheme is
 *  `//`. An un-normalised string (a framework `href`, a direct caller) is normalised the same way before scanning. */
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

/**
 * Keys redacted in a page ADDRESS on top of the shared denylist, for the credential-carrying keys the shared list does
 * not match. Matched EXACTLY (after the shared key normalisation: lower case, no `-` `_` `.` or whitespace; a form `+`
 * is a space and a trailing `[]`/`[n]` is dropped, so `code[]`, `code%5B%5D` and `+code` all match), never as
 * substrings: `code` as a substring would eat `encoding`, `barcode` and `zipcode`. The shared list is a substring list and
 * already catches `sessionid`, `signature`, `otp` and `code_verifier` (and, as a side effect, `footprint`), so they are
 * not repeated here. `key` and `t` are deliberately NOT redacted: far too common, and a false redaction loses a
 * screen's identity.
 */
const LOCATION_EXTRA_KEYS = new Set(['code', 'state', 'session', 'sid', 'sig', 'ticket']);
const isLocationKey = (decodedKey: string): boolean =>
  LOCATION_EXTRA_KEYS.has(
    normalizeKey(
      decodedKey
        .replace(/\+/g, ' ')
        .replace(/^[\s"']+|[\s"']+$/g, '')
        .replace(/\[[^\]]*\]$/, ''),
    ),
  );

/**
 * Decode percent-escapes TOLERANTLY: every maximal run of valid `%XX` escapes is decoded as UTF-8 when it is valid, and
 * otherwise only its single-byte (ASCII) escapes are; an invalid or partial escape (`%`, `%2`, `%E0%A4`) stays as it is.
 * `decodeURIComponent` is all-or-nothing, so one stray `%` in a value (`q%3D100%%26token%3DS`) used to disable the
 * redaction of everything else in it.
 */
function decodeTolerant(raw: string): string {
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });
}

/** `encodeURIComponent` for any string: a lone surrogate (which makes it throw) is first replaced by U+FFFD, so the
 *  value stays ENCODED and the shape of the address survives. */
const encodeSafe = (value: string): string =>
  encodeURIComponent(
    value.replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      '\ufffd',
    ),
  );

const redactPairs = (value: string): string =>
  redactSensitivePairs(value, 0, value.length, false, isLocationKey);

/** One piece of a fragment (see `FRAGMENT_PIECE_BOUNDARY`): its pairs, then the pairs after a hash-router `?` (`#/nav?code=C`), whose first key
 *  would otherwise carry the route as a prefix (`/nav?code`) and miss an exact-key match. */
function redactFragmentPiece(piece: string): string {
  const once = redactPairs(piece);
  const question = once.indexOf('?');
  return question < 0
    ? once
    : redactSensitivePairs(once, question + 1, once.length, false, isLocationKey);
}

/** A fragment, cut at each `#` that starts a `key=` (vue-router hash mode: `#/cb?x=1#access_token=…`), each piece scanned
 *  alone; a `#` that is not followed by `key=` stays inside its value (`#password=p#ss`). */
const redactFragment = (fragment: string): string =>
  fragment.split(FRAGMENT_PIECE_BOUNDARY).map(redactFragmentPiece).join('#');

/**
 * `file:` keeps `file:///…/<last path segment>`, so a local path (`/Users/bob/…`, `C:\Users\…`, a UNC host) never
 * reaches the bundle while the page is still recognisable. The query and fragment are kept and redacted like http's:
 * an Electron app routing on `file:///app/index.html#/orders/42` is told apart by its fragment.
 */
function sanitizeFileUrl(
  afterScheme: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  // The browser reads a backslash in the path of a `file:` URL as a slash (the query and fragment keep theirs).
  const delimiter = afterScheme.search(/[?#]/);
  const head = delimiter < 0 ? afterScheme : afterScheme.slice(0, delimiter);
  let rest = head.replace(/\\/g, '/') + (delimiter < 0 ? '' : afterScheme.slice(delimiter));
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
  const keptSegment = redactSensitivePairs(segment, 0, segment.length, true, isLocationKey);
  const keptQuery = query === undefined ? undefined : redactPairs(query);
  const keptFragment = fragment === undefined ? undefined : redactFragment(fragment);
  const built = `file:///…/${keptSegment}${keptQuery === undefined ? '' : `?${keptQuery}`}${
    keptFragment === undefined ? '' : `#${keptFragment}`
  }`;
  // A `file:` page (an Electron renderer) carries the same return-URL query as any other, so it gets the nested scan too.
  return redactShapes(
    depth < MAX_NESTED_DEPTH ? sanitizeNestedQueryUrls(built, options, depth) : built,
    options,
  );
}

/** Whether a (decoded) query value should be sanitized as an address. */
const looksNested = (value: string): boolean =>
  NESTED_RAW.test(value) || value.includes('?') || value.includes('#');

/**
 * Sanitize each value of the `key=value` run in `[start, end)` that looks like a URL or a path with a query, to a
 * fixed depth. `sanitizeUrl` scans only the first `?`'s own pairs, so a secret one level down (`?next=https://x/?token=…`,
 * `?returnTo=%2Freset%3Ftoken%3D…`, the OAuth `redirect_uri` shape) shipped. A value is tried raw, then decoded once and
 * twice (a value is often encoded once or twice, or only partly); a decoded value that changed is re-encoded with
 * `encodeURIComponent`. A value the sanitizer leaves alone keeps its original bytes.
 */
function sanitizeNestedRun(
  url: string,
  start: number,
  end: number,
  options: ShapeRedactionOptions | undefined,
  depth: number,
  /** A fragment: a `#` that starts a `key=` also ends a pair (`#/cb?x=1#access_token=…`). */
  splitHash = false,
): string {
  const pieces: string[] = [];
  let changed = false;
  let pos = start;
  let copyFrom = 0;
  while (pos < end) {
    let segEnd = pos;
    let eq = -1;
    for (; segEnd < end; segEnd += 1) {
      const c = url[segEnd];
      if (
        c === '&' ||
        c === ';' ||
        (splitHash && c === '#' && isFragmentPieceBoundary(url, segEnd))
      ) {
        break;
      }
      if (eq < 0 && c === '=') {
        eq = segEnd;
      }
    }
    if (eq >= 0) {
      const value = url.slice(eq + 1, segEnd);
      const replacement = sanitizeNestedValue(value, options, depth);
      if (replacement !== value) {
        pieces.push(url.slice(copyFrom, eq + 1), replacement);
        copyFrom = segEnd;
        changed = true;
      }
    }
    pos = segEnd + 1;
  }
  return changed ? pieces.join('') + url.slice(copyFrom) : url;
}

/** Leading whitespace, and the `+` that `URLSearchParams` writes for a leading space. */
const LEADING_BLANKS = /^[\s+]+/;
/** One unit of an ENCODED value: a double-encoded byte (`%252B`), a percent-escaped character (`%C2%A0` is one), or one char. */
const RAW_TOKEN = /%25[0-9A-Fa-f]{2}|%[0-9A-Fa-f]{2}(?:%[89ABab][0-9A-Fa-f])*|[\s\S]/y;

/**
 * The raw (as written) prefix of an encoded `value` that decodes, unit by unit, to exactly `lead`: `+`, `%2B`, `%20`,
 * `%09`, `%C2%A0` and the double-encoded `%252B`/`%2520` each stay as they were written (a form decoder reads `+` as a
 * space but `%2B` as a plus). Undefined when no prefix does (a triple-encoded blank).
 */
function rawLeadFor(value: string, lead: string): string | undefined {
  let position = 0;
  let decoded = '';
  while (position < value.length && decoded.length < lead.length) {
    RAW_TOKEN.lastIndex = position;
    const token = (RAW_TOKEN.exec(value) as RegExpExecArray)[0]; // always matches: `[\s\S]` is the last alternative
    decoded += token.startsWith('%25')
      ? decodeTolerant(decodeTolerant(token))
      : decodeTolerant(token);
    position += token.length;
  }
  return decoded === lead ? value.slice(0, position) : undefined;
}

/** Percent-encode leading blanks that no raw prefix matched (a triple-encoded one); a `+` stays `+`. */
const encodeLead = (lead: string): string =>
  lead.replace(/[\s+]/g, (c) => (c === '+' ? '+' : encodeURIComponent(c)));

/** Sanitize nested TEXT as an address, ignoring (and keeping) its leading blanks: `%20https%3A%2F%2F…` is an address
 *  to a browser, and the normalisation inside would otherwise drop the space and make a harmless value look changed. */
function sanitizeNestedText(
  text: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  const body = text.replace(LEADING_BLANKS, '');
  if (!looksNested(body)) {
    return text;
  }
  const clean = sanitizeAddress(body, options, depth + 1);
  return clean === body ? text : text.slice(0, text.length - body.length) + clean;
}

function sanitizeNestedValue(
  value: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  if (!value.includes('%')) {
    return sanitizeNestedText(value, options, depth); // plain text: sanitize it as it is
  }
  // Something is encoded (once, twice or partly: `https%3A//b`, `https:%2F%2Fb`): read the DECODED form, which is what
  // the receiving app sees. The raw form of a half-encoded URL is not a URL a parser would split correctly.
  const once = decodeTolerant(value);
  const decoded = once.includes('%') ? decodeTolerant(once) : once;
  const clean = sanitizeNestedText(decoded, options, depth);
  if (clean === decoded) {
    return value;
  }
  // Nothing was really decoded (only invalid escapes): the sanitized raw text is the answer, not a re-encoding of it.
  if (decoded === value) {
    return clean;
  }
  const lead = LEADING_BLANKS.exec(clean)?.[0] ?? '';
  // Keep the leading blanks EXACTLY as written (`+`, `%2B`, `%20`, `%09`, `%C2%A0`, `%252B`: a form decoder reads them
  // differently), so reuse the raw prefix that decodes to them.
  return (rawLeadFor(value, lead) ?? encodeLead(lead)) + encodeSafe(clean.slice(lead.length));
}

/** The nested scan over the main query and over the fragment (its `key=value` pairs, and a hash-router `?` query). */
function sanitizeNestedQueryUrls(
  input: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  let url = input;
  const hash = url.indexOf('#');
  const queryStart = url.indexOf('?');
  if (queryStart >= 0 && (hash < 0 || queryStart < hash)) {
    url = sanitizeNestedRun(url, queryStart + 1, hash < 0 ? url.length : hash, options, depth);
  }
  // The WHOLE fragment is scanned as pairs: `#next=https%3A%2F%2F…`, `#/route?next=…` and an implicit-flow `#a=1&next=…`
  // all carry a nested address, and a route prefix before the first `=` is not part of any value.
  const fragment = url.indexOf('#');
  if (fragment >= 0) {
    url = sanitizeNestedRun(url, fragment + 1, url.length, options, depth, true);
  }
  return url;
}

/** Strip the browser-ignored characters, skip leading C0/space, and normalise the slashes of a special scheme. */
function normalise(input: string): string {
  // The browser drops tab/CR/LF anywhere in a URL and skips leading C0 controls and spaces, so `java\tscript:` IS
  // `javascript:`. Normalise first, or the scheme check below is a bypass.
  const stripped = input.replace(/[\t\n\r]/g, '');
  let from = 0;
  while (from < stripped.length && stripped.charCodeAt(from) <= 0x20) {
    from += 1;
  }
  const url = stripped.slice(from);
  const scheme = SCHEME.exec(url);
  if (scheme === null || !SPECIAL_SCHEMES.has((scheme[1] as string).toLowerCase())) {
    return url;
  }
  // `https:/u:p@a.com`, `https:u:p@a.com` and `https:\\u:p@a.com\x` all mean `https://u:p@a.com/x`.
  const rest = url.slice(scheme[0].length);
  const delimiter = rest.search(/[?#]/);
  const head = (delimiter < 0 ? rest : rest.slice(0, delimiter)).replace(/\\/g, '/');
  return `${scheme[0]}//${head.replace(/^\/+/, '')}${delimiter < 0 ? '' : rest.slice(delimiter)}`;
}

function sanitizeAddress(
  input: string,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  // Clip FIRST, before any scan (even the normalisation reads the whole string): a megabyte `location` cost ~0.9 s of
  // main-thread time. A cut that lands inside a percent-escape drops the partial escape, so a half escape never
  // glues itself to the marker.
  const clipped = input.length > MAX_INPUT_CHARS;
  const normalised = normalise(clipped ? input.slice(0, MAX_INPUT_CHARS) : input);
  const scheme = SCHEME.exec(normalised);
  const name = scheme === null ? undefined : (scheme[1] as string).toLowerCase();
  if (name !== undefined && OPAQUE_SCHEMES.has(name)) {
    return `${name}:${REDACTED_URL_ENCODED}`;
  }
  const url = clipped ? normalised.replace(/%[0-9A-Fa-f]?$/, '') : normalised;
  const result = sanitizeBounded(
    url,
    scheme === null ? undefined : scheme[0].length,
    name,
    options,
    depth,
  );
  return clipped ? result + TRUNCATED_URL_MARKER : result;
}

function sanitizeBounded(
  url: string,
  schemeLength: number | undefined,
  name: string | undefined,
  options: ShapeRedactionOptions | undefined,
  depth: number,
): string {
  if (name !== undefined && schemeLength !== undefined) {
    const rest = url.slice(schemeLength);
    if (ORIGIN_ONLY_SCHEMES.has(name)) {
      const origin = INNER_ORIGIN.exec(rest);
      if (origin === null) {
        return `${name}:${REDACTED_URL_ENCODED}`; // `blob:null/…`: an opaque origin, nothing to keep
      }
      // The authority's userinfo is dropped WHOLE (everything up to the LAST `@`), not just its password.
      const authority = origin[2] as string;
      return `${name}:${origin[1]}://${authority.slice(authority.lastIndexOf('@') + 1)}`;
    }
    if (name === 'view-source') {
      return depth >= MAX_NESTED_DEPTH
        ? `${name}:${REDACTED_URL_ENCODED}`
        : `${name}:${sanitizeAddress(rest, options, depth + 1)}`;
    }
    if (name === 'file') {
      return sanitizeFileUrl(rest, options, depth);
    }
  }
  let flat = sanitizeUrlCore(url, options, isLocationKey);
  // A hash-router query (`#/nav?code=C`): the shared fragment scan sees `/nav?code` as the key, so scan after the `?`.
  const fragment = flat.indexOf('#');
  if (fragment >= 0) {
    flat = flat.slice(0, fragment + 1) + redactFragment(flat.slice(fragment + 1));
  }
  return depth < MAX_NESTED_DEPTH ? sanitizeNestedQueryUrls(flat, options, depth) : flat;
}

/**
 * Sanitize the page's own address. Rules, by input:
 *  - a string over 8192 characters is clipped to that FIRST (before any scan), sanitized, and marked `%3Ctruncated%3E`;
 *  - `data:`, `javascript:`, `vbscript:` become `<scheme>:%3Credacted%3E` (the body is data or code, never an address);
 *  - `blob:` / `filesystem:` keep only the inner origin (`blob:https://a.com`), never userinfo, path or query;
 *  - `file:` becomes `file:///…/<last segment>` (query and fragment kept, redacted as for http);
 *  - `view-source:` sanitizes what it wraps;
 *  - an `http(s)`/`ws(s)`/`ftp` string is first normalised like a browser would (`https:/u:p@a.com` is
 *    `https://u:p@a.com`, a backslash is a slash);
 *  - everything else is `sanitizeUrl` (userinfo password, sensitive query/fragment/matrix values, secret shapes) with
 *    the location denylist added (exact keys `code`, `state`, `session`, `sid`, `sig`, `ticket`; the shared
 *    substring list already catches `sessionid`, `signature`, `otp`, `code_verifier`), the hash-router query scanned,
 *    and URLs or paths with a query nested in a query or fragment value scanned to two levels (raw, or percent-encoded
 *    once or twice, with invalid escapes tolerated). `file:` pages get the nested scan too.
 * Not covered, by design: ids, emails, long base64 and local paths in a PATH segment (only token shapes and sensitive
 * `;key=value` matrix segments are), and keys outside the denylist. Returns the placeholder for a non-string, and
 * never throws.
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

/**
 * The name of a navigation (a transaction name): the PATH of the sanitized address, with no query or fragment. For an
 * address with an authority (`https://a.com/p?q`, `file:///…/x`) that is the path after the host; for one without
 * (`blob:https://a.com`, `data:…`, `about:blank?code=C`, `view-source:https://a.com/p/q?x`) it is the sanitized address with
 * its query and fragment removed. Given the absolute `href`, a `file:` page names as `/…/index.html`, never as the raw
 * directory; given only a pathname it is sanitized as a relative address.
 */
export function sanitizeLocationName(href: string | undefined, pathname: string): string {
  const sanitized = sanitizeLocationUrl(href ?? pathname);
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(sanitized);
  const withoutQuery = (value: string): string => value.replace(/[?#].*$/s, '');
  if (authority === null) {
    return withoutQuery(sanitized);
  }
  const rest = withoutQuery(sanitized.slice(authority[0].length));
  return rest === '' ? '/' : rest;
}
