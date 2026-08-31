// Absolutization of captured network URLs (protocol + host + port), design §16.1.
//
// Every network SOURCE records the target the caller passed, so a same-origin `fetch('/api/x')` was
// stored as `/api/x` while a cross-origin call was stored as `http://localhost:5398/nope`. Same capture
// stream, two different kinds of value, and the origin of the first is simply gone by the time the
// bundle is read. This makes the stored URL absolute at the ONE choke point every mechanism passes
// through (the network capture provider), so fetch/xhr/sse/sendBeacon/ws/webtransport — and anything
// added later — are covered without touching a single interceptor.
//
// GOVERNING PRINCIPLE: resolve with exactly the base the RUNTIME ITSELF used, never a guessed or
// borrowed origin. The value of absolutizing is that it reproduces the real target; a WRONGLY
// absolutized URL is strictly worse than a relative one, because it asserts an origin that was never
// contacted. Every ambiguous case below therefore falls back to the raw string.
//
// Lives in `@bugsee/capture`, NOT in `@bugsee/protocol` next to `sanitizeUrl`, deliberately:
// `@bugsee/protocol` is the tier-0 wire-contract package — pure string work over canonical shapes, with
// no notion of the environment it runs in. Choosing a base URL is environment SENSING (which realm am I
// in? is there a document?), which is the capture tier's job, and `new URL` is neither pure-string nor
// non-throwing, the two properties protocol/url.ts states about itself. The pure half is still split out
// (`absolutizeUrl` takes its globals as an argument) so it is testable without touching `globalThis`.

/**
 * The globals a base URL can be read from. Taken as an argument rather than reached for directly so a
 * caller — a test especially — can express a REALM (page / dedicated worker / service worker) by the
 * shape of the object it passes, instead of mutating one process-wide `globalThis`.
 */
export interface UrlBaseGlobals {
  document?: { baseURI?: unknown };
  location?: { href?: unknown };
}

/** The WHATWG `URL` constructor, reached through `globalThis` because the shared tiers compile without
 *  the DOM/Node libs (tsconfig.base `lib: ES2023`, `types: []`) and must not import `node:*` either. It
 *  is present in every runtime this SDK targets; a host where it is not simply falls into the catch
 *  below and keeps the raw string. */
type UrlConstructor = new (url: string, base?: string) => { href: string };

/** A URL that already carries a scheme: `https:`, `ws:`, `data:`, `blob:`, `chrome-extension:`, … */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Read `pick(source)` without letting a hostile/throwing accessor escape; `undefined` when it throws. */
function tryRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    // A page can define `document`/`location` as throwing getters, and capture must never be the thing
    // that breaks the app (or loses the entry) because it looked at one.
    return undefined;
  }
}

/** The string, or `undefined` when it is not a usable base — `new URL(x, '')` throws, so '' is no base. */
function asBase(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The base URL of the realm this code is executing in, or `undefined` when the host has none.
 *
 * Precedence, and why:
 *
 *  1. `document.baseURI` — the PAGE realm. Not `location.href`: a page carrying
 *     `<base href="https://cdn.example.com/">` resolves every relative URL against that, and
 *     `location.href` would name an origin the request never touched. `baseURI` is what the runtime
 *     used, so it is what we use. (It already folds in `location.href` when there is no `<base>`.)
 *  2. `location.href` — a DEDICATED or SERVICE worker, which has no `document`. There, `location.href`
 *     is the worker SCRIPT's URL, and that is genuinely what the worker's own relative `fetch()` calls
 *     resolve against.
 *  3. `undefined` — node/bun/deno and any other location-less host. No origin is invented; the caller
 *     keeps the raw string. This is what keeps SERVER capture honest: an incoming request target is
 *     captured as `/api/x` and stays `/api/x`, because there is no client origin to attach to it.
 *
 * The realms are never crossed. A worker has no `document`, so rule 1 simply cannot fire there — the
 * probe selects from the realm it is actually in. A service worker's `registration.scope` is
 * deliberately NEVER consulted even though a SW script can be served from a different host/path than the
 * pages it controls: the scope is not what relative resolution uses, so borrowing it would fabricate an
 * origin.
 */
export function resolveBaseUrl(
  globals: UrlBaseGlobals = globalThis as unknown as UrlBaseGlobals,
): string | undefined {
  const documentBase = asBase(tryRead(() => globals.document?.baseURI));
  return documentBase ?? asBase(tryRead(() => globals.location?.href));
}

/**
 * Make a captured URL absolute (protocol + host + port) using the realm's own base.
 *
 * Returns `url` UNCHANGED — by identity, never round-tripped — when:
 *
 *  - it already carries a scheme (`http(s):`, `ws(s):` (always absolute), `data:`, `blob:`, `mailto:`,
 *    `chrome-extension:`, …). Round-tripping an absolute URL through `new URL().href` would NORMALIZE
 *    it: lowercase the host, append a root `/`, strip a default port, percent-encode. That rewrites URLs
 *    the app never wrote, and it is also why this function is exactly idempotent.
 *  - it is empty. `fetch('')` really does resolve to the base, but an empty captured url is a producer
 *    bug rather than a request, and synthesizing an origin for it would assert a target nothing hit.
 *  - the realm has no base (rule 3 above).
 *  - resolution throws — an unparseable target, or an unparseable base.
 *
 * A protocol-relative `//host/path` is NOT a pass-through: it is resolved, gaining the base's scheme.
 * That is exactly what the runtime does with it, `https://host/path` is genuinely the origin contacted,
 * and "add the protocol" is the point of the change. Host and path come through untouched.
 */
export function absolutizeUrl(
  url: string,
  globals: UrlBaseGlobals = globalThis as unknown as UrlBaseGlobals,
): string {
  if (url === '' || HAS_SCHEME.test(url)) {
    return url;
  }
  const base = resolveBaseUrl(globals);
  if (base === undefined) {
    return url;
  }
  try {
    const { URL: Url } = globalThis as unknown as { URL: UrlConstructor };
    return new Url(url, base).href;
  } catch {
    // Unparseable target or base. A wrong origin is a worse defect than a missing one, so capture keeps
    // what the app actually asked for and moves on — an entry is never dropped over this.
    return url;
  }
}
