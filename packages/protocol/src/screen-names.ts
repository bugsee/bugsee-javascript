import { sanitizeLocationUrl, TRUNCATED_URL_MARKER } from './location-url';

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

/** Clip to `max` characters BEFORE sanitizing (bounded work, fail closed), sanitize, then mark a clip. */
function clean(text: string, max: number): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const clipped = trimmed.length > max;
  const sanitized = sanitizeLocationUrl(clipped ? trimmed.slice(0, max) : trimmed);
  return clipped ? sanitized + TRUNCATED_URL_MARKER : sanitized;
}

/**
 * Where the query of a route string starts, or -1. A `?` is router PATTERN syntax (an optional parameter: `/:id?`,
 * `/:id(\d+)?/edit`) when it ends the string or is followed by `/` or `)`; any other `?` starts a query string.
 */
function queryStart(route: string): number {
  for (let i = route.indexOf('?'); i !== -1; i = route.indexOf('?', i + 1)) {
    const next = route[i + 1];
    if (next !== undefined && next !== '/' && next !== ')') return i;
  }
  return -1;
}

/**
 * The `route` trace value for a router's route string: the pattern (`/orders/:id`, `/orders/[id]`), or a pathname where
 * the router gives no pattern. NEVER a query string or fragment (cut here, before anything else), run through the shared
 * location sanitizer, and clipped at {@link MAX_ROUTE_CHARS}. `undefined` (write nothing) for anything that is not a
 * non-empty string once the query and fragment are gone.
 */
export function sanitizeRoutePattern(route: unknown): string | undefined {
  if (typeof route !== 'string') return undefined;
  const hash = route.indexOf('#');
  const noFragment = hash === -1 ? route : route.slice(0, hash);
  const query = queryStart(noFragment);
  return clean(query === -1 ? noFragment : noFragment.slice(0, query), MAX_ROUTE_CHARS);
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
