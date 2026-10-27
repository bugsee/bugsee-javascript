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

/** What may follow a `?` that is router syntax (an optional-parameter modifier): the end, a separator, or the next piece. */
const MODIFIER_FOLLOWERS = '/)-.:_~*+?';

/**
 * Where the query of a route string starts, or -1. A `?` is router PATTERN syntax, not a query, when it is
 *  - inside parentheses (a regexp: `/:id(colou?r)`, `/:file(.*?\.json)`; an escaped paren does not count), or
 *  - a modifier: followed by the end or a separator (`/:id?`, `/:id?/edit`, `/:file?.json`, `/:a?-:b?`) AND with no
 *    `=` or `&` between it and the next `?` (`/a?/next=/home&email=x` is a query even though `/` follows).
 * Anything else starts a query. An unbalanced paren is not trusted: the depth rule is then dropped, so a `(` cannot hide a query.
 */
function queryStart(route: string): number {
  const candidates: Array<{ at: number; depth: number }> = [];
  let depth = 0;
  let balanced = true;
  for (let i = 0; i < route.length; i++) {
    const c = route[i];
    if (c === '\\') i += 1;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth < 0) {
        balanced = false;
        depth = 0;
      }
    } else if (c === '?') candidates.push({ at: i, depth });
  }
  if (depth !== 0) balanced = false;
  const live = balanced ? candidates.filter((c) => c.depth === 0) : candidates;
  for (let k = 0; k < live.length; k++) {
    const at = (live[k] as { at: number }).at;
    const end = live[k + 1]?.at ?? route.length;
    const next = route[at + 1];
    const modifier =
      (next === undefined || MODIFIER_FOLLOWERS.includes(next)) &&
      !/[=&]/.test(route.slice(at + 1, end));
    if (!modifier) return at;
  }
  return -1;
}

/** `scheme://user:pw@host`, `scheme:/user@host`, `//user:pw@host`, then a scheme-less `user:pw@host`: the userinfo goes. */
const USERINFO_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*:)[/\\]{1,2}[^/\\?#@]+@/;
const USERINFO_SLASHES = /^[/\\]{2}[^/\\?#@]+@/;
const USERINFO_BARE = /^[^/\\?#@:]+:[^/\\?#@]*@/;
/** An e-mail address in a path segment (`/verify/alice@example.com`). A `/@handle` or `/:name@:domain` route has none. */
const EMAIL = /[^\s/@:?#]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function withoutPersonalData(route: string): string {
  return route
    .replace(USERINFO_SCHEME, '$1//')
    .replace(USERINFO_SLASHES, '//')
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
  const bounded = route.slice(0, MAX_INPUT_CHARS);
  const hash = bounded.indexOf('#');
  const noFragment = hash === -1 ? bounded : bounded.slice(0, hash);
  const query = queryStart(noFragment);
  const path = query === -1 ? noFragment : noFragment.slice(0, query);
  return clean(withoutPersonalData(path.trim()), MAX_ROUTE_CHARS);
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
