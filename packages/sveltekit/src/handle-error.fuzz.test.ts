// Property tests for the SvelteKit `handleError` bridge.
//
// `HandleServerError` is handed a framework-shaped input whose sub-objects (`event.route`, `event.request`,
// `event.url`) are all optional in practice — a 404 has no matched route, an internal throw during
// `handle` can arrive before `event.url` is populated, and adapters differ. The properties below state the
// two contracts examples keep understating:
//   1. the binding project principle — the adapter must not alter app behaviour: for a reportable error it
//      reports the SAME object, and for ANY input it neither throws back into SvelteKit nor changes what
//      the app's own handler returns;
//   2. attribution is best-effort and additive — losing a sub-object costs a field, never the report, and
//      a blank/absent field is never stamped.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  createHandleServerError,
  handleErrorWithBugsee,
  type SvelteKitServerErrorInput,
} from './handle-error';

function fakeClient() {
  return {
    event: vi.fn<(name: string, params?: Record<string, unknown>) => void>(),
    logException: vi.fn<(error: unknown, options?: unknown) => Promise<{ ok: true }>>(
      async () => ({ ok: true }) as const,
    ),
  };
}

const ATTRIBUTION = ['method', 'path', 'routeId'];

/** Arbitrary SvelteKit error-hook inputs — every sub-object independently present or absent. */
const anyInput = fc.record(
  {
    event: fc.oneof(
      fc.constant(undefined),
      fc.record(
        {
          route: fc.oneof(
            fc.constant(undefined),
            fc.record({ id: fc.oneof(fc.string(), fc.constant(null)) }, { requiredKeys: [] }),
          ),
          request: fc.oneof(
            fc.constant(undefined),
            fc.record({ method: fc.string() }, { requiredKeys: [] }),
          ),
          url: fc.oneof(
            fc.constant(undefined),
            fc.record({ pathname: fc.string() }, { requiredKeys: [] }),
          ),
        },
        { requiredKeys: [] },
      ),
    ),
    message: fc.string(),
  },
  { requiredKeys: [] },
);

/** Statuses SvelteKit treats as a crash worth reporting (>=500, or none at all). */
const reportableStatus = fc.oneof(fc.constant(undefined), fc.integer({ min: 500, max: 599 }));

describe('createHandleServerError — properties', () => {
  it('reports the SAME error for any reportable status + any input shape, and never throws', () => {
    fc.assert(
      fc.property(anyInput, reportableStatus, (rest, status) => {
        const client = fakeClient();
        const err = new Error('boom');
        const input = { ...rest, error: err, status } as SvelteKitServerErrorInput;
        expect(() =>
          createHandleServerError({ getClient: () => client as never })(input),
        ).not.toThrow();
        expect(client.logException).toHaveBeenCalledTimes(1);
        expect(client.logException.mock.calls[0]?.[0]).toBe(err);
        expect(client.logException.mock.calls[0]?.[1]).toEqual({ mechanism: 'http-error' });
      }),
      { numRuns: 300 },
    );
  });

  it('never stamps an attribution key outside method/path/routeId, and never a blank routeId', () => {
    fc.assert(
      fc.property(anyInput, reportableStatus, (rest, status) => {
        const client = fakeClient();
        createHandleServerError({ getClient: () => client as never })({
          ...rest,
          error: new Error('x'),
          status,
        } as SvelteKitServerErrorInput);
        const [name, params] = client.event.mock.calls[0] as [string, Record<string, unknown>];
        expect(name).toBe('sveltekit.server-error');
        for (const k of Object.keys(params)) expect(ATTRIBUTION).toContain(k);
        expect(params.routeId).not.toBe('');
        expect(params.routeId).not.toBe(null);
        expect('routeId' in params).toBe(typeof params.routeId === 'string');
      }),
      { numRuns: 300 },
    );
  });

  it('skips every <500 status, whatever the rest of the input looks like', () => {
    fc.assert(
      fc.property(anyInput, fc.integer({ min: -50, max: 499 }), (rest, status) => {
        const client = fakeClient();
        createHandleServerError({ getClient: () => client as never })({
          ...rest,
          error: new Error('x'),
          status,
        } as SvelteKitServerErrorInput);
        expect(client.logException).not.toHaveBeenCalled();
        expect(client.event).not.toHaveBeenCalled();
      }),
      { numRuns: 200 },
    );
  });
});

describe('handleErrorWithBugsee — properties', () => {
  it("returns the app handler's value verbatim and calls it exactly once, reported or not", () => {
    fc.assert(
      fc.property(
        anyInput,
        fc.integer({ min: -50, max: 599 }),
        fc.anything(),
        (rest, status, ret) => {
          const client = fakeClient();
          const appHandler = vi.fn(() => ret);
          const out = handleErrorWithBugsee(appHandler, { getClient: () => client as never })({
            ...rest,
            error: new Error('x'),
            status,
          } as SvelteKitServerErrorInput);
          expect(appHandler).toHaveBeenCalledTimes(1);
          expect(out).toBe(ret); // the App.Error the app chose, not one Bugsee substituted
        },
      ),
      { numRuns: 300 },
    );
  });

  it("lets the app handler's own throw propagate untouched (Bugsee does not intercept it)", () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        const client = fakeClient();
        const own = new Error(message);
        const run = () =>
          handleErrorWithBugsee(
            () => {
              throw own;
            },
            { getClient: () => client as never },
          )({ error: new Error('x'), status: 500 });
        expect(run).toThrow(own); // same instance — never wrapped, never swallowed
        expect(client.logException).toHaveBeenCalledTimes(1); // and the original was still reported
      }),
      { numRuns: 50 },
    );
  });
});
