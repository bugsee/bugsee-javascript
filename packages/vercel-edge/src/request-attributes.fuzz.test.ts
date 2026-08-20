import { sanitizeUrl } from '@bugsee/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { requestAttributes } from './fetch-handler';
import { resolveWaitUntil } from './wait-until';

/**
 * Property-based tests for the two edge functions fed by input we do not control.
 *
 * `requestAttributes` reads a Request that arrived from the public internet, and its output is stamped onto
 * the per-invocation context and merged into any incident report. Report attributes do NOT pass through the
 * redaction pipeline (fetch-handler.ts:24-26), so this function is the LAST line of defence for a secret in
 * `?token=…`. That makes its promises security properties, not formatting details:
 *
 *   • a parseable URL is reduced to its PATH — no query, no fragment, no userinfo;
 *   • an unparseable one keeps its raw value, but only after `sanitizeUrl` has scrubbed it;
 *   • neither branch may throw, whatever shape the Request-like object has.
 *
 * `resolveWaitUntil` reads a GLOBAL the platform owns (`Symbol.for('@vercel/request-context')`) plus a `ctx`
 * the customer's handler was handed. Both are arbitrary objects at runtime; returning a callable no-op rather
 * than throwing is what keeps a wrong-shaped host from failing every request.
 */

const SECRET = 'sk-SUPERSECRET-0123456789';

// Request-like objects: the fields requestAttributes reads, in every type a host could produce.
const anyValue = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant({}),
    fc.constant([]),
  );

const requestLike = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant({}),
    fc.record({ method: anyValue(), url: anyValue() }),
    fc.record({ method: fc.constantFrom('GET', 'POST', 'DELETE'), url: fc.webUrl() }),
    fc.webUrl().map((url) => ({ method: 'GET', url })),
  );

const attrs = (request: unknown): Record<string, unknown> =>
  requestAttributes(request as Request) as Record<string, unknown>;

describe('requestAttributes — never throws, stamps only what it can type', () => {
  it('survives any Request-like shape, including none at all', () => {
    fc.assert(
      fc.property(requestLike(), (request) => {
        expect(() => attrs(request)).not.toThrow();
      }),
    );
  });

  it('stamps http.method exactly when the method is a string, verbatim', () => {
    fc.assert(
      fc.property(requestLike(), (request) => {
        const method = (request as { method?: unknown } | null | undefined)?.method;
        const out = attrs(request);
        expect('http.method' in out).toBe(typeof method === 'string');
        if (typeof method === 'string') {
          expect(out['http.method']).toBe(method); // no normalization, no truncation
        }
      }),
    );
  });

  it('stamps http.url exactly when the url is a string, and nothing else ever appears', () => {
    fc.assert(
      fc.property(requestLike(), (request) => {
        const url = (request as { url?: unknown } | null | undefined)?.url;
        const out = attrs(request);
        expect('http.url' in out).toBe(typeof url === 'string');
        for (const key of Object.keys(out)) {
          expect(['http.method', 'http.url']).toContain(key);
        }
      }),
    );
  });
});

describe('requestAttributes — the stamped URL cannot carry a query secret', () => {
  it('drops the query of any parseable URL (differential against the URL parser)', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.string({ minLength: 1 }).filter((s) => !s.includes('#')),
        (url, key) => {
          const withSecret = `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${SECRET}`;
          const stamped = attrs({ url: withSecret })['http.url'] as string;
          // The model: whatever the platform URL parser calls the path, scrubbed. Anything the parser puts
          // in `search`/`hash`/`username` is by construction absent from it.
          expect(stamped).toBe(sanitizeUrl(new URL(withSecret).pathname));
          expect(stamped).not.toContain(SECRET);
          expect(stamped).not.toContain('?');
          expect(stamped).not.toContain('#');
        },
      ),
    );
  });

  it('strips userinfo credentials from a parseable URL', () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.stringMatching(/^[a-z]{3,10}$/),
        fc.stringMatching(/^[a-z0-9]{6,16}$/),
        (url, user, password) => {
          const parsed = new URL(url);
          parsed.username = user;
          parsed.password = password;
          const stamped = attrs({ url: parsed.toString() })['http.url'] as string;
          expect(stamped).not.toContain(password);
          expect(stamped).not.toContain(`${user}:`);
        },
      ),
    );
  });

  it('scrubs the raw value on the unparseable fallback (differential against sanitizeUrl)', () => {
    fc.assert(
      fc.property(
        // Relative / malformed targets — the branch that keeps the value RAW, so the only protection left
        // is the sanitizer. This is the branch a secret actually escapes through.
        fc
          .tuple(
            fc.stringMatching(/^\/[a-z/]{0,20}$/),
            fc.constantFrom(
              'token',
              'access_token',
              'password',
              'api_key',
              'secret',
              'harmless_id',
            ),
          )
          .map(([path, key]) => `${path}?${key}=${SECRET}`),
        (target) => {
          const out = attrs({ url: target });
          expect(() => new URL(target)).toThrow(); // precondition: this really is the fallback branch
          expect(out['http.url']).toBe(sanitizeUrl(target));
        },
      ),
    );
  });

  it('redacts a sensitive query key on the unparseable fallback', () => {
    for (const key of ['token', 'access_token', 'password', 'api_key', 'secret']) {
      const stamped = attrs({ url: `/callback?${key}=${SECRET}` })['http.url'] as string;
      expect(stamped).not.toContain(SECRET);
      expect(stamped).toContain('%3Credacted%3E');
    }
  });
});

describe('resolveWaitUntil — always returns a usable function', () => {
  const anyCtx = (): fc.Arbitrary<unknown> =>
    fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({}),
      fc.record({ waitUntil: anyValue() }),
      fc.constant({ waitUntil: () => {} }),
    );

  it('returns a callable for any ctx shape, and never throws when invoked', () => {
    fc.assert(
      fc.property(anyCtx(), (ctx) => {
        const waitUntil = resolveWaitUntil(ctx as never);
        expect(typeof waitUntil).toBe('function');
        expect(() => waitUntil(Promise.resolve(1))).not.toThrow();
      }),
    );
  });

  it('returns a callable for any shape of the Vercel request-context global', () => {
    const symbol = Symbol.for('@vercel/request-context');
    const holders = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({}), // a holder with NO `get` — the optional call is the only thing saving this
      fc.record({ get: anyValue() }),
      fc.constant({ get: () => undefined }),
      fc.constant({ get: () => ({}) }),
      fc.constant({ get: () => ({ waitUntil: () => {} }) }),
    );
    try {
      (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = 'edge-runtime';
      fc.assert(
        fc.property(holders, (holder) => {
          (globalThis as Record<symbol, unknown>)[symbol] = holder;
          const waitUntil = resolveWaitUntil();
          expect(typeof waitUntil).toBe('function');
          expect(() => waitUntil(Promise.resolve(1))).not.toThrow();
        }),
      );
    } finally {
      delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
      delete (globalThis as Record<symbol, unknown>)[symbol];
    }
  });
});
