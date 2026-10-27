import { sanitizeLocationUrl, TRUNCATED_URL_MARKER } from './location-url';
import { REDACTED_URL_ENCODED } from './sensitive';

// Sanitizing the application-supplied names of the `route` and `view` system traces. Both are untrusted app strings
// that a framework adapter or the application hands to `client.setRoute` / `client.setView`, so they take the same
// treatment as the page address (the shared location sanitizer: secret shapes, sensitive matrix segments) and are
// bounded, and nothing that is not a usable name is ever written (never a fabricated one).

/** The longest `route` written; a longer pattern is clipped (before any scan) and marked `%3Ctruncated%3E`. */
export const MAX_ROUTE_CHARS = 1024;
/** The longest `view` `name` / `type` written; clipped and marked the same way. */
export const MAX_VIEW_FIELD_CHARS = 256;
/** The `view` value that means "no view" (Android's `$$none`), written by `setView(null)`. */
export const VIEW_NONE = '$$none';

/** The wire `view` object: the component or view name, and optionally the producer (adapter id). */
export interface ViewValue {
  name: string;
  type?: string;
}

/** A route is never looked at past this many characters (a megabyte pushed into the router must not cost a megabyte of work). */
const MAX_INPUT_CHARS = 8192;

/**
 * Sanitize the (bounded) text, THEN clip the result to `max` and mark a clip. In that order on
 * purpose: clipping first leaves the head of a token that straddles the cut (`ghp_Ab3dEf6hIj9`), which the shape
 * redaction no longer recognises; sanitizing the whole bounded string first redacts it before anything is cut.
 */
function clean(text: string, max: number): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const sanitized = sanitizeLocationUrl(trimmed);
  return sanitized.length > max ? sanitized.slice(0, max) + TRUNCATED_URL_MARKER : sanitized;
}

/**
 * What may follow a modifier `?` (the text right after it): the end, `/`, the next param (`?:b`) or another modifier, `-` /
 * `_` / `~` joining the next param (`?-:b`), or `.` and the next param or a short extension (`?.json`). A word right after the
 * `?` (`?token`, `?-SECRET`, `?_k9f8`) is a query. Tested on an 8-character slice, so it stays constant-time.
 */
const FOLLOWER = /^(?:$|[/:?]|[-_~]:|\.(?::|[A-Za-z0-9]{1,6}(?:[/?]|$)))/;
const isWord = (c: string | undefined): boolean => /\w/.test(c ?? '');

/** A `?` found by the scan: `at` (the backslash of an escaped `\?`), whether it is escaped, directly follows a bare param
 *  token (`:` after a non-word, then only word characters), and the index of the innermost open `(` (or -1). */
type Candidate = readonly [at: number, escaped: boolean, afterParam: boolean, group: number];

/**
 * Where the query of a route string starts, or its length when there is none. A `?` is router PATTERN syntax, not a query, when
 *  - it is regexp inside a group (`/:id(colou?r)`, `/:file(.*?\.json)`, `(?:a|b)`, `(?=y)`) with no `=` or `&` between it
 *    and the group's closing `)` (`/wiki/Foo_(bar?user=alice&id=42)` is a query; `(?` is group syntax only before `:=!<`), or
 *  - it is an optional-parameter modifier: right after a param token (`/:id?`) or after `)`, `}`, `]` or `*`, followed by
 *    the end or a separator ({@link FOLLOWER}), with no `=` or `&` before the next `?` (`/a?/next=/home&email=x`).
 * Anything else starts a query: after a plain word (`/index.php?/x`), after a param that is not a bare name (`/:id.json?_x`),
 * or an escaped `\?` followed by `=` or `&`. An unbalanced paren is not trusted: the group rule is then dropped, so a `(`
 * cannot hide a query. One pass, then one check per `?`: linear.
 */
function queryStart(route: string): number {
  const n = route.length;
  // nextKv[i]: the index of the first `=` or `&` at or after i (n when none), so "any `=`/`&` in a range" is O(1)
  const nextKv = new Int32Array(n + 2).fill(n);
  for (let i = n - 1; i >= 0; i--)
    nextKv[i] = route[i] === '=' || route[i] === '&' ? i : (nextKv[i + 1] as number);
  const found: Candidate[] = [];
  const closeOf: number[] = [];
  const open: number[] = [];
  let balanced = true;
  let param = false; // inside a bare param token (`:name`) of the current segment
  for (let i = 0; i < n; i++) {
    const c = route[i];
    const group = open.length ? (open[open.length - 1] as number) : -1;
    if (c === '\\') {
      if (route[i + 1] === '?') found.push([i, true, false, group]);
      param = false;
      i += 1;
    } else if (c === '?') found.push([i, false, param, group]);
    else {
      if (c === ':') param = !isWord(route[i - 1]);
      else if (!isWord(c)) param = false;
      if (c === '(') open.push(i);
      else if (c === ')') {
        const opener = open.pop();
        if (opener === undefined) balanced = false;
        else closeOf[opener] = i;
      }
    }
  }
  for (let k = 0; k < found.length; k++) {
    const [at, escaped, afterParam, group] = found[k] as Candidate;
    const grouped = balanced && !open.length && group !== -1;
    const prev = route[at - 1] ?? '';
    // a literal `\?` inside a group is regexp; outside, `\?` followed by `key=value` is a query written to look like one
    if (escaped) {
      if (!grouped && (nextKv[at + 1] as number) < n) return at;
    } else if (prev === '(') {
      if (!/[:=!<]/.test(route[at + 1] ?? '')) return at;
    } else if (grouped) {
      if ((nextKv[at + 1] as number) < (closeOf[group] as number)) return at;
    } else if (
      !(
        (afterParam || /[)}\]*]/.test(prev)) &&
        (nextKv[at + 1] as number) >= (found[k + 1]?.[0] ?? n) &&
        FOLLOWER.test(route.slice(at + 1, at + 9))
      )
    )
      return at;
  }
  return n;
}

/** `scheme://user:pw@host`, `scheme:/user@host`, `//user:pw@host`, then a scheme-less `user:pw@host`: the userinfo goes. */
const USERINFO_URL = /^([A-Za-z][A-Za-z0-9+.-]*:|(?=[/\\]{2}))[/\\]+(?:[^/\\?#@]*@)+/;
const USERINFO_BARE = /^[^/\\?#@:]+:[^/\\?#@]*@/;

/**
 * An e-mail address in a path segment (`/verify/alice@example.com`, or `alice%40example.com` as a router leaves it): a local
 * part, `@` or `%40`, then a domain whose LAST label is alphabetic with 2+ letters (any script: `/u/алиса@пример.рф`), so
 * `react@18.2.0`, `pkg@1.2.3` and `b@c.d` are not addresses. The lookbehind anchors the match to the start of a run, which
 * keeps it linear (unanchored, every start offset rescanned the run: 170 ms at 8192 characters). Known limit: `logo@2x.png`
 * has an alphabetic extension and is redacted. `/@handle` and `/:name@:domain` have none.
 */
const EMAIL =
  /(?<![^\s/@:?#])[^\s/@:?#]+(?:@|%40)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-])/gu;

function withoutPersonalData(route: string): string {
  return route
    .replace(USERINFO_URL, '$1//')
    .replace(USERINFO_BARE, '')
    .replace(EMAIL, REDACTED_URL_ENCODED);
}

/**
 * The `route` trace value for a router's route string: the pattern (`/orders/:id`, `/orders/[id]`), or a pathname where
 * the router gives no pattern. NEVER a query string or fragment (cut here, before anything else), never userinfo
 * (`alice:pw@host`) or an e-mail address, run through the shared location sanitizer, and clipped at
 * {@link MAX_ROUTE_CHARS}. `undefined` (write nothing) for anything that is not a non-empty string once the query and
 * fragment are gone.
 */
export function sanitizeRoutePattern(route: unknown): string | undefined {
  if (typeof route !== 'string') return undefined;
  const noFragment = route.slice(0, MAX_INPUT_CHARS).replace(/#.*/s, '');
  return clean(
    withoutPersonalData(noFragment.slice(0, queryStart(noFragment)).trim()),
    MAX_ROUTE_CHARS,
  );
}

/**
 * The `view` trace value for `client.setView`'s argument: a string or `{name, type?}` becomes `{name, type?}` (keys in
 * that order, each sanitized and clipped at {@link MAX_VIEW_FIELD_CHARS}), `null` becomes {@link VIEW_NONE}, and
 * anything unusable (an empty name, a wrong type) is `undefined`: write nothing. An unusable `type` is dropped and the
 * name kept.
 */
export function normalizeView(view: unknown): ViewValue | typeof VIEW_NONE | undefined {
  if (view === null) return VIEW_NONE;
  const raw = typeof view === 'string' ? view : (view as { name?: unknown } | undefined)?.name;
  if (typeof raw !== 'string') return undefined;
  const name = clean(raw, MAX_VIEW_FIELD_CHARS);
  if (name === undefined) return undefined;
  const rawType = typeof view === 'object' ? (view as { type?: unknown }).type : undefined;
  const type = typeof rawType === 'string' ? clean(rawType, MAX_VIEW_FIELD_CHARS) : undefined;
  return { name, ...(type !== undefined ? { type } : {}) };
}
