// Property-based (fast-check) audit of the Astro middleware — the one place in this adapter that REWRITES
// something the app produced.
//
// Two untrusted inputs meet here: the request URL (attacker-controlled) and the downstream `Response`
// (whatever the app's routes, endpoints and adapters return, at any status, with any content type, at any
// point in a streaming/caching chain). The Wave 4.5 regression came from exactly this space — a 304 with
// `content-type: text/html` reached the reconstruct and turned every cached page into a 500 — so the
// invariants are stated over the WHOLE status × content-type space rather than the handful of shapes that
// happened to be in the example tests.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  type AstroMiddlewareContext,
  createBugseeMiddleware,
  injectTraceIntoResponse,
} from './middleware';

const TAG = '<meta name="traceparent" content="00-t-s-01">';

/** A client whose context provider reports an ACTIVE trace, so `traceMetaTag` really produces `TAG`. */
const traced = {
  getClient: () => ({
    getServiceProvider: () => ({
      getImmediate: () => ({
        getCurrent: () => ({ trace: { traceId: 't', spanId: 's', sampled: true } }),
      }),
    }),
  }),
} as never;

/** Statuses the fetch spec forbids a body on — `new Response(body, { status })` is a TypeError for these. */
const NULL_BODY = new Set([204, 205, 304]);
/** The Response constructor only accepts 200–599, so that is the whole constructible space. */
const statusArb = fc.integer({ min: 200, max: 599 });

function makeResponse(status: number, body: string, contentType?: string): Response {
  return new Response(NULL_BODY.has(status) ? null : body, {
    status,
    ...(contentType !== undefined ? { headers: { 'content-type': contentType } } : {}),
  });
}

describe('injectTraceIntoResponse — properties', () => {
  // The Wave 4.5 class, generalized: no status, and no content type, may turn a working response into a
  // thrown error. An adapter that breaks the response is worse than an adapter that injects nothing.
  it('never throws, for any constructible status × content-type (the 304 class, generalized)', async () => {
    await fc.assert(
      fc.asyncProperty(
        statusArb,
        fc.constantFrom(
          'text/html',
          'text/html; charset=utf-8',
          'TEXT/HTML',
          'application/json',
          'text/plain',
          'application/xhtml+xml',
          '',
          undefined,
        ),
        fc.constantFrom('<html><head></head><body>x</body></html>', '', 'no head here', '</head>'),
        async (status, contentType, body) => {
          const out = await injectTraceIntoResponse(
            makeResponse(status, body, contentType),
            traced,
          );
          expect(out.status).toBe(status); // and the status is never rewritten
        },
      ),
    );
  });

  // A response the injector declines to touch must be handed back BY IDENTITY: returning a copy would
  // consume/relay the body and break streaming and `Response.redirect`-style identities alike.
  it('returns the IDENTICAL object (never a copy) for every non-HTML content type', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string()
          .filter((ct) => !ct.toLowerCase().includes('text/html') && !ct.includes('\n'))
          .filter((ct) => {
            try {
              new Headers({ 'content-type': ct });
              return true;
            } catch {
              return false;
            }
          }),
        async (contentType) => {
          const response = new Response('<html><head></head></html>', {
            status: 200,
            headers: { 'content-type': contentType },
          });
          expect(await injectTraceIntoResponse(response, traced)).toBe(response);
        },
      ),
    );
  });

  it('returns the IDENTICAL object for every null-body status, even when it claims text/html', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(204, 205, 304), async (status) => {
        const response = new Response(null, {
          status,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
        expect(await injectTraceIntoResponse(response, traced)).toBe(response);
      }),
    );
  });

  // Injecting means BUFFERING the body through `response.text()` and re-encoding it. `text()` decodes as
  // UTF-8 unconditionally (per the fetch spec, the `charset` parameter is ignored), so a response that
  // declares another encoding comes back with every non-ASCII byte replaced by U+FFFD — `0xE9` → `EF BF BD`,
  // measured. That is silent, irreversible corruption of a page the app rendered correctly.
  it('never re-encodes a response that declares a non-UTF-8 charset (byte-for-byte preserved)', async () => {
    // The charset PARAMETER is written many ways in the wild (`;charset=` with no space is as common as
    // `; charset=`, and quoting is legal), and a label that merely CONTAINS "utf-8" is not utf-8.
    const contentTypes = fc.constantFrom(
      'text/html; charset=iso-8859-1',
      'text/html;charset=iso-8859-1', // no space after the semicolon
      'text/html;   charset=windows-1252', // several spaces
      'text/html; charset="shift_jis"', // quoted, per RFC 9110
      'text/html; charset=EUC-JP', // labels are case-insensitive
      'text/html; charset=iso-8859-15; boundary=x', // a further parameter follows
      'text/html; charset=x-utf-8', // contains "utf-8" but is NOT it — anchoring matters
      'text/html; charset=utf-8x',
    );
    await fc.assert(
      fc.asyncProperty(
        contentTypes,
        fc.integer({ min: 0x80, max: 0xff }),
        async (contentType, highByte) => {
          // `<head></head>` followed by one byte that is NOT valid standalone UTF-8.
          const bytes = new Uint8Array([
            ...new TextEncoder().encode('<html><head></head><body>'),
            highByte,
            ...new TextEncoder().encode('</body></html>'),
          ]);
          const response = new Response(bytes, {
            status: 200,
            headers: { 'content-type': contentType },
          });

          const out = await injectTraceIntoResponse(response, traced);
          expect(new Uint8Array(await out.arrayBuffer())).toEqual(bytes);
        },
      ),
    );
  });

  it('still injects when the charset IS utf-8, in any spelling or casing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          'text/html',
          'text/html; charset=utf-8',
          'text/html;charset=UTF-8',
          'text/html; charset="utf-8"',
          'text/html; charset=utf8',
        ),
        async (contentType) => {
          const out = await injectTraceIntoResponse(
            new Response('<html><head></head></html>', {
              status: 200,
              headers: { 'content-type': contentType },
            }),
            traced,
          );
          expect(await out.text()).toContain(TAG);
        },
      ),
    );
  });

  // The rewrite itself, as an INSERTION invariant rather than a re-statement of `String.replace`: the tag
  // goes in immediately before the FIRST `</head>`, and every other byte of the document survives in place.
  // (`replace` on a regex, or a `replaceAll`, would inject into every `</head>` in the document — SSR output
  // routinely contains one in an inline template or a code sample.)
  it('inserts the tag exactly once, immediately before the FIRST </head>, changing nothing else', async () => {
    const htmlArb = fc
      .tuple(fc.string(), fc.string(), fc.nat({ max: 3 }))
      .map(([before, after, extraHeads]) => {
        // A document with 1..4 `</head>` occurrences — only the first may be used.
        const tail = Array.from({ length: extraHeads }, () => `${after}</head>`).join('');
        return `<html><head>${before}</head><body>${after}${tail}</body></html>`;
      });

    await fc.assert(
      fc.asyncProperty(htmlArb, async (html) => {
        const out = await injectTraceIntoResponse(
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          traced,
        );
        const body = await out.text();
        const at = html.indexOf('</head>');

        expect(body).toHaveLength(html.length + TAG.length); // exactly one insertion, nothing removed
        expect(body.slice(0, at)).toBe(html.slice(0, at)); // everything before is byte-identical
        expect(body.slice(at, at + TAG.length)).toBe(TAG); // the tag sits at the insertion point
        expect(body.slice(at + TAG.length)).toBe(html.slice(at)); // …and the rest follows untouched
      }),
    );
  });

  it('preserves status, statusText and every unrelated header across the rewrite (dropping only content-length)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 599 }).filter((s) => !NULL_BODY.has(s)),
        fc
          .string({ minLength: 1 })
          .filter((v) => /^[\x20-\x7e]+$/.test(v.trim()) && v.trim() !== ''),
        async (status, headerValue) => {
          const response = new Response('<html><head></head></html>', {
            status,
            statusText: 'Custom Reason',
            headers: {
              'content-type': 'text/html',
              'content-length': '25',
              'x-app-header': headerValue,
              'set-cookie': 'sid=abc; Path=/',
            },
          });
          const out = await injectTraceIntoResponse(response, traced);

          expect(out.status).toBe(status);
          expect(out.statusText).toBe('Custom Reason');
          expect(out.headers.get('x-app-header')).toBe(new Headers({ v: headerValue }).get('v'));
          expect(out.headers.get('set-cookie')).toBe('sid=abc; Path=/');
          // The body grew, so the app's content-length is now a lie — and a wrong content-length truncates
          // the page in the browser.
          expect(out.headers.get('content-length')).toBeNull();
        },
      ),
    );
  });
});

describe('createBugseeMiddleware — properties', () => {
  function fakeClient() {
    return {
      event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
      logException: vi.fn(async () => ({ ok: true }) as const),
      getServiceProvider: vi.fn(() => ({
        getImmediate: () => ({ getCurrent: () => undefined }),
      })),
    };
  }

  // Report attributes do NOT pass the redaction pipeline, so anything that reaches `path` is stored as-is.
  // A session token in `?token=…` (or a `#fragment`) must never get there.
  it('never leaks the query string or fragment into the reported path', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.string(),
        async (url, secret) => {
          const client = fakeClient();
          const withSecret = `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(secret)}`;
          const context = {
            request: { url: withSecret, method: 'GET' },
          } as unknown as AstroMiddlewareContext;

          await expect(
            createBugseeMiddleware({ getClient: () => client as never })(context, async () => {
              throw new Error('boom');
            }),
          ).rejects.toThrow();

          const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
          const path = params.path as string | undefined;
          if (path !== undefined) {
            expect(path).toBe(new URL(withSecret).pathname);
            expect(path).not.toContain('?');
            expect(path).not.toContain('#');
            expect(path).not.toContain('token=');
          }
        },
      ),
    );
  });

  // The binding principle: the middleware sits in front of every route with `order: 'pre'`. Whatever the
  // route threw is what Astro must see — same value, no wrapping, no swallowing.
  it('rethrows whatever the route threw, by identity, for any url shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.webUrl(),
          fc.string(), // an unparseable url — safePath must swallow, the rethrow must not change
          fc.constant(''),
        ),
        fc.oneof(
          fc.string().map((m) => new Error(m)),
          fc.string(),
          fc.constant(null),
          fc.constant(undefined),
          fc.object(),
        ),
        async (url, thrown) => {
          const client = fakeClient();
          const context = { request: { url, method: 'GET' } } as unknown as AstroMiddlewareContext;
          let caught: unknown;
          let threw = false;
          try {
            await createBugseeMiddleware({ getClient: () => client as never })(
              context,
              async () => {
                throw thrown;
              },
            );
          } catch (error) {
            threw = true;
            caught = error;
          }
          expect(threw).toBe(true); // never swallowed
          expect(Object.is(caught, thrown)).toBe(true); // never replaced or wrapped
          expect(client.logException).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });
});
