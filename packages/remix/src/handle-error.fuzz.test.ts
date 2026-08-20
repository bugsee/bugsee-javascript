// Property tests for the Remix / React Router `handleError` bridge.
//
// The hook's inputs come straight off the wire (an arbitrary request URL and method) and from a framework
// whose `args` shape varies between Remix v2, RR7 and the many hand-rolled `entry.server` setups. Two
// contracts are stated as properties rather than examples:
//   1. PRIVACY — the captured `path` never carries the query string or fragment (report attributes do not
//      pass the redaction pipeline, so a `?token=…` there would leak verbatim);
//   2. the binding project principle — an interceptor must not alter app behaviour: whatever it is handed,
//      the hook reports the SAME error object and never throws back into Remix's own error handling.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createHandleError } from './handle-error';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn<(error: unknown, options?: unknown) => Promise<{ ok: true }>>(
      async () => ({ ok: true }) as const,
    ),
  };
}

const SECRET = 'sup3rs3cr3t';

/** Arbitrary `handleError` args, including the degenerate shapes a non-standard entry.server can produce. */
const anyArgs = fc.oneof(
  fc.constant(undefined),
  fc.constant({}),
  fc.record(
    {
      request: fc.oneof(
        fc.constant(undefined),
        fc.record(
          {
            method: fc.string(),
            url: fc.webUrl(),
            signal: fc.record({ aborted: fc.constant(false) }),
          },
          { requiredKeys: [] },
        ),
      ),
      params: fc.oneof(fc.constant(undefined), fc.dictionary(fc.string(), fc.string())),
    },
    { requiredKeys: [] },
  ),
);

describe('createHandleError — properties', () => {
  it('never leaks the query string or fragment into the captured path', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.string({ minLength: 1 }),
        (base, key) => {
          const client = fakeClient();
          const sep = base.includes('?') ? '&' : '?';
          const url = `${base}${sep}${encodeURIComponent(key)}=${SECRET}`;
          createHandleError({ getClient: () => client as never })(new Error('x'), {
            request: { method: 'GET', url, signal: { aborted: false } } as unknown as Request,
          });
          const params = client.event.mock.calls[0]?.[1] as Record<string, unknown>;
          const path = params.path as string | undefined;
          if (path === undefined) return; // unparseable URL → no path at all, also safe
          expect(path).not.toContain(SECRET);
          expect(path).not.toContain('?');
          expect(path).not.toContain('#');
          expect(path).toBe(new URL(url).pathname);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reports the SAME error object, whatever args it is handed, and never throws', () => {
    fc.assert(
      fc.property(anyArgs, (args) => {
        const client = fakeClient();
        const err = new Error('boom');
        expect(() =>
          createHandleError({ getClient: () => client as never })(err, args as never),
        ).not.toThrow();
        // Never swallowed, never wrapped, never re-ordered into a different mechanism.
        expect(client.logException).toHaveBeenCalledTimes(1);
        expect(client.logException.mock.calls[0]?.[0]).toBe(err);
        expect(client.logException.mock.calls[0]?.[1]).toEqual({ mechanism: 'http-error' });
      }),
      { numRuns: 200 },
    );
  });

  it('reports non-Error thrown values unchanged (Remix surfaces anything a loader threw)', () => {
    fc.assert(
      fc.property(fc.anything(), (thrown) => {
        const client = fakeClient();
        createHandleError({ getClient: () => client as never })(thrown, {
          request: { method: 'GET', url: 'https://a.test/x', signal: { aborted: false } } as never,
        });
        expect(client.logException.mock.calls[0]?.[0]).toBe(thrown);
      }),
      { numRuns: 200 },
    );
  });

  it('reports nothing at all for a cancelled request, whatever else the args carry', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.string(), (url, method) => {
        const client = fakeClient();
        createHandleError({ getClient: () => client as never })(new Error('x'), {
          request: { method, url, signal: { aborted: true } } as unknown as Request,
        });
        expect(client.logException).not.toHaveBeenCalled();
        expect(client.event).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});
