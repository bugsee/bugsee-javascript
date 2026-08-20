// Property tests for the EDGE handle. The SvelteKit `RequestEvent` it reads is framework/adapter-supplied
// and differs per deploy target (adapter-cloudflare has `platform.context`, adapter-vercel does not, a unit
// test may pass a bare object), so the attribute/ctx probes are exercised against arbitrary shapes.
//
// The invariant under test is the binding project principle: an interceptor must not alter app behaviour.
// Whatever the event looks like, the handle must call `resolve` exactly once and hand back its result
// untouched — never throw, never swallow, never double-resolve.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

const { launchEdge, runInEdgeContext } = vi.hoisted(() => ({
  launchEdge: vi.fn(),
  runInEdgeContext: vi.fn((_client: unknown, _opts: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@bugsee/vercel-edge', () => ({ launchEdge, runInEdgeContext }));
const { getCarrierClient } = vi.hoisted(() => ({ getCarrierClient: vi.fn() }));
vi.mock('@bugsee/core', () => ({
  getCarrierClient,
  ContextProviderToken: Symbol.for('bugsee.context-provider'),
}));

import { createEdgeHandle } from './edge';

const ALLOWED = ['http.method', 'http.target', 'http.route'];

/** Arbitrary events, weighted towards realistic SvelteKit `RequestEvent` shapes. */
const anyEvent = fc.oneof(
  fc.anything(),
  fc.record(
    {
      request: fc.record({ method: fc.string() }, { requiredKeys: [] }),
      url: fc.record({ pathname: fc.string() }, { requiredKeys: [] }),
      route: fc.record({ id: fc.oneof(fc.string(), fc.constant(null)) }, { requiredKeys: [] }),
      platform: fc.record({ context: fc.record({ waitUntil: fc.func(fc.constant(undefined)) }) }),
    },
    { requiredKeys: [] },
  ),
);

describe('createEdgeHandle — properties over arbitrary SvelteKit events', () => {
  it('always resolves exactly once and returns the resolve result untouched', () => {
    fc.assert(
      fc.property(anyEvent, fc.boolean(), (event, launched) => {
        runInEdgeContext.mockClear();
        getCarrierClient.mockReturnValue(launched ? { id: 'c' } : undefined);
        const sentinel = { body: 'response' };
        const resolve = vi.fn((_event: unknown, _opts?: unknown) => sentinel);
        const out = createEdgeHandle()({ event, resolve });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(out).toBe(sentinel);
        expect(resolve.mock.calls[0]?.[0]).toBe(event); // the event is forwarded, not rebuilt
      }),
      { numRuns: 300 },
    );
  });

  it('never stamps an attribute outside the http.method / http.target / http.route set', () => {
    fc.assert(
      fc.property(anyEvent, (event) => {
        runInEdgeContext.mockClear();
        const resolve = vi.fn(() => ({}));
        createEdgeHandle({ getClient: () => ({ id: 'c' }) as never })({ event, resolve });
        const opts = runInEdgeContext.mock.calls[0]?.[1] as {
          attributes: Record<string, unknown>;
        };
        for (const k of Object.keys(opts.attributes)) expect(ALLOWED).toContain(k);
        // A blank or unmatched route id is never stamped — no attribution beats empty attribution.
        expect(opts.attributes['http.route']).not.toBe('');
        expect(opts.attributes['http.route']).not.toBe(null);
      }),
      { numRuns: 300 },
    );
  });

  it('renders the page even when the app-supplied getClient throws for every request', () => {
    fc.assert(
      fc.property(anyEvent, fc.string(), (event, message) => {
        runInEdgeContext.mockClear();
        const resolve = vi.fn(() => ({ body: 'ok' }));
        const handle = createEdgeHandle({
          getClient: () => {
            throw new Error(message);
          },
        });
        expect(() => handle({ event, resolve })).not.toThrow();
        expect(runInEdgeContext).not.toHaveBeenCalled();
        const transform = (
          resolve.mock.calls[0] as unknown as [
            unknown,
            { transformPageChunk: (i: { html: string }) => string },
          ]
        )[1].transformPageChunk;
        expect(transform({ html: '<head></head>' })).toBe('<head></head>');
      }),
      { numRuns: 100 },
    );
  });
});
