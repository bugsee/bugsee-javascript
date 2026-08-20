// Property-based (fast-check) audit of the `onRequestError` bridge.
//
// Everything this handler sees is EXTERNAL input produced by Next.js: the thrown value is whatever the app
// threw (not necessarily an Error), and `request`/`context` are Next's own structures, whose runtime shape
// is only as good as the Next version installed — the declared TypeScript types are a promise, not a
// guarantee. The bridge sits directly in Next's error path, so the binding project principle applies at its
// sharpest: it must never throw, never swallow, and never alter what the app threw.

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOnRequestError,
  type NextRequestErrorContext,
  type NextRequestErrorRequest,
} from './on-request-error';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn(async () => ({ ok: true }) as const),
  };
}

/** Arbitrary Next `context` — every field Next declares, with the optionals genuinely optional. */
const contextArb: fc.Arbitrary<NextRequestErrorContext> = fc.record(
  {
    routerKind: fc.constantFrom('Pages Router' as const, 'App Router' as const),
    routePath: fc.string(),
    routeType: fc.constantFrom(
      'render' as const,
      'route' as const,
      'action' as const,
      'middleware' as const,
    ),
    renderSource: fc.constantFrom(
      'react-server-components' as const,
      'react-server-components-payload' as const,
      'server-rendering' as const,
    ),
    revalidateReason: fc.constantFrom('on-demand' as const, 'stale' as const),
    renderType: fc.constantFrom('dynamic' as const, 'dynamic-resume' as const),
  },
  { requiredKeys: ['routerKind', 'routePath', 'routeType'] },
);

const requestArb: fc.Arbitrary<NextRequestErrorRequest> = fc.record({
  path: fc.string(),
  method: fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'),
  headers: fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.array(fc.string()))),
});

/** Anything an app can `throw` — Next hands the raw value straight through. */
const thrownArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string().map((m) => new Error(m)),
  fc.string(),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
  fc.array(fc.anything()),
);

describe('createOnRequestError — properties', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports the thrown value BY IDENTITY, never wrapped or replaced', () => {
    fc.assert(
      fc.property(thrownArb, requestArb, contextArb, (thrown, request, context) => {
        const client = fakeClient();
        createOnRequestError({ getClient: () => client as never })(thrown, request, context);
        expect(client.logException).toHaveBeenCalledTimes(1);
        const [reported, opts] = client.logException.mock.calls[0] as unknown as [unknown, unknown];
        // Object.is, not toEqual: a wrapped/cloned error would break stack-trace symbolication and the
        // backend's issue grouping.
        expect(Object.is(reported, thrown)).toBe(true);
        expect(opts).toEqual({ mechanism: 'http-error' });
      }),
    );
  });

  it('mirrors the route attribution exactly: the three required fields always, renderSource iff Next set it', () => {
    fc.assert(
      fc.property(thrownArb, requestArb, contextArb, (thrown, request, context) => {
        const client = fakeClient();
        createOnRequestError({ getClient: () => client as never })(thrown, request, context);
        const [name, params] = client.event.mock.calls[0] as unknown as [
          string,
          Record<string, unknown>,
        ];
        expect(name).toBe('next.request-error');
        // The exact key set — nothing invented, nothing dropped, and no `renderSource: undefined` hole when
        // Next omitted it (an absent key and a present-but-undefined one are different on the wire).
        const expectedKeys = ['routerKind', 'routePath', 'routeType', 'method', 'path'];
        if (context.renderSource !== undefined) expectedKeys.push('renderSource');
        expect(Object.keys(params).sort()).toEqual(expectedKeys.sort());
        expect(params.routerKind).toBe(context.routerKind);
        expect(params.routePath).toBe(context.routePath);
        expect(params.routeType).toBe(context.routeType);
        expect(params.method).toBe(request.method);
        expect(params.path).toBe(request.path);
      }),
    );
  });

  // The binding principle: an interceptor must not alter app behaviour. Next calls this hook from inside its
  // own error handling; if the bridge throws, Bugsee has replaced the app's failure with its own.
  it('never throws out of Next’s hook — for any input, and however the client misbehaves', () => {
    const hostileClient = fc.constantFrom(
      // A client whose capture surface throws (a full disk on the node tier is a real production path).
      () => ({
        event: () => {
          throw new Error('event failed');
        },
        logException: () => {
          throw new Error('report failed');
        },
      }),
      // A client resolver that itself blows up.
      () => {
        throw new Error('resolver failed');
      },
      // Not launched.
      () => undefined,
      // A structurally incomplete client (an older/patched SDK on the carrier).
      () => ({}) as never,
    );

    fc.assert(
      fc.property(thrownArb, requestArb, contextArb, hostileClient, (t, req, ctx, getClient) => {
        expect(() =>
          createOnRequestError({ getClient: getClient as never })(t, req, ctx),
        ).not.toThrow();
      }),
    );
  });
});
