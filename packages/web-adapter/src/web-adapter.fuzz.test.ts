import type { Bugsee } from '@bugsee/browser';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { reportError, setRouteName } from './adapter';
import {
  RENDER_DURATION_ATTRIBUTE,
  RENDER_PHASE_ATTRIBUTE,
  RENDER_SPAN_OP,
  type RenderSpanInput,
  recordRenderSpan,
} from './render-span';

/**
 * Property-based tests for the SHARED foundation under every web framework adapter
 * (@bugsee/react | vue | svelte | angular | solid). Two invariant families, both of which an example test
 * can only sample:
 *
 *  1. CONTAINMENT — the binding project principle that an interceptor must not alter host behaviour. These
 *     three entry points all run inside a host seam (a framework error handler, a router subscription, a
 *     render hook), so for ANY hostile client shape they must not throw, and for a shape that merely means
 *     "no SDK / no performance extension" they must not even report an SDK-internal error.
 *  2. THE RENDER-SPAN MAPPING — `RenderSpanInput` → the `recordChildSpan` call is a pure transformation,
 *     so it is checked against a model rather than against remembered outputs.
 */

/** Every way a resolved "client" can be useless or hostile, WITHOUT meaning a real failure. */
const benignlyUselessClient = (): fc.Arbitrary<() => Bugsee | undefined> =>
  fc.oneof(
    fc.constant(() => undefined), // no SDK launched
    fc.constant(
      () =>
        ({
          ext: () => {
            throw new Error('extension performance not registered');
          },
        }) as unknown as Bugsee, // launched, performanceMonitoring off
    ),
    fc.constant(() => ({ ext: () => undefined }) as unknown as Bugsee), // ext resolves to nothing
    fc.constant(
      () =>
        ({
          // a REAL performance extension (both seam methods) that simply has no active transaction
          ext: () => ({ getActiveSpan: () => undefined, setRouteName: () => {} }),
        }) as unknown as Bugsee,
    ),
  );

/** Every way the SDK can be genuinely BROKEN — containment must still hold, `onError` may fire. */
const hostileClient = (): fc.Arbitrary<() => Bugsee | undefined> =>
  fc.oneof(
    fc.constant(() => {
      throw new Error('broken carrier');
    }),
    fc.constant(() => null as unknown as Bugsee),
    fc.constant(() => 42 as unknown as Bugsee),
    fc.constant(
      () =>
        new Proxy({} as Bugsee, {
          get() {
            throw new Error('hostile proxy');
          },
        }),
    ),
  );

describe('web-adapter host boundaries (fuzz)', () => {
  it('never throws out of reportError / setRouteName / recordRenderSpan, for ANY client shape', () => {
    fc.assert(
      fc.property(
        fc.oneof(benignlyUselessClient(), hostileClient()),
        fc.anything(),
        fc.string(),
        (getClient, thrown, name) => {
          // `onError` itself throwing is the last place a throw could escape — pin that too.
          const onError = () => {
            throw new Error('the error sink is broken as well');
          };
          expect(() => reportError(thrown, { getClient, onError })).not.toThrow();
          expect(() => setRouteName(name, { getClient, onError })).not.toThrow();
          expect(() =>
            recordRenderSpan(
              { name, startTimestampMs: 0, endTimestampMs: 1 },
              { getClient, onError },
            ),
          ).not.toThrow();
        },
      ),
    );
  });

  it('reports NO SDK-internal error for the ordinary "no SDK / no performance ext" shapes', () => {
    // The distinction that matters in production: "Bugsee is not doing anything here" must be silent,
    // not a swallowed TypeError routed to the host's onError on every navigation and every render.
    fc.assert(
      fc.property(benignlyUselessClient(), fc.string(), (getClient, name) => {
        const onError = vi.fn();
        setRouteName(name, { getClient, onError });
        recordRenderSpan({ name, startTimestampMs: 0, endTimestampMs: 1 }, { getClient, onError });
        expect(onError).not.toHaveBeenCalled();
      }),
    );
  });
});

describe('recordRenderSpan mapping (fuzz)', () => {
  const attributeValue = fc.oneof(fc.string(), fc.double({ noNaN: true }), fc.boolean());

  const spanInput = fc.record(
    {
      name: fc.string(),
      startTimestampMs: fc.double({ noNaN: true, noDefaultInfinity: true }),
      endTimestampMs: fc.double({ noNaN: true, noDefaultInfinity: true }),
      phase: fc.string(),
      durationMs: fc.double({ noNaN: true, noDefaultInfinity: true }),
      attributes: fc.dictionary(
        // deliberately include the canonical keys in the generated extras so the "canonical wins"
        // precedence rule is exercised, not just non-colliding merges
        fc.oneof(fc.string(), fc.constantFrom(RENDER_DURATION_ATTRIBUTE, RENDER_PHASE_ATTRIBUTE)),
        attributeValue,
      ),
    },
    { requiredKeys: ['name', 'startTimestampMs', 'endTimestampMs'] },
  );

  it('maps the input to the child span exactly (canonical duration/phase always authoritative)', () => {
    fc.assert(
      fc.property(spanInput, (span: RenderSpanInput) => {
        const recordChildSpan = vi.fn();
        const client = {
          ext: () => ({ getActiveSpan: () => ({ recordChildSpan }) }),
        } as unknown as Bugsee;

        recordRenderSpan(span, { getClient: () => client });

        expect(recordChildSpan).toHaveBeenCalledTimes(1);
        const [op, opts] = recordChildSpan.mock.calls[0] as [
          string,
          {
            startTimestampMs: number;
            endTimestampMs: number;
            description: string;
            attributes: Record<string, unknown>;
          },
        ];
        expect(op).toBe(RENDER_SPAN_OP);
        expect(opts.startTimestampMs).toBe(span.startTimestampMs);
        expect(opts.endTimestampMs).toBe(span.endTimestampMs);
        expect(opts.description).toBe(span.name);

        // The model: extras first, then the canonical duration, then the phase when present.
        const expected: Record<string, unknown> = { ...span.attributes };
        expected[RENDER_DURATION_ATTRIBUTE] =
          span.durationMs ?? span.endTimestampMs - span.startTimestampMs;
        if (span.phase !== undefined) expected[RENDER_PHASE_ATTRIBUTE] = span.phase;
        expect(opts.attributes).toStrictEqual(expected);

        // …and the absent-vs-present-and-undefined distinction the model's `toStrictEqual` relies on:
        // the phase key exists only when a phase was given (or a framework extra already carried it).
        expect(RENDER_PHASE_ATTRIBUTE in opts.attributes).toBe(
          span.phase !== undefined || RENDER_PHASE_ATTRIBUTE in (span.attributes ?? {}),
        );
      }),
    );
  });
});

describe('reportError options mapping (fuzz)', () => {
  it('defaults the mechanism to `uncaught` and OMITS the labels key unless labels were given', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.option(fc.constantFrom('uncaught', 'programmatic', 'http-error'), { nil: undefined }),
        fc.option(fc.array(fc.string()), { nil: undefined }),
        (thrown, mechanism, labels) => {
          const logException = vi.fn(() => Promise.resolve());
          const client = { logException } as unknown as Bugsee;
          reportError(thrown, {
            getClient: () => client,
            ...(mechanism !== undefined ? { mechanism: mechanism as never } : {}),
            ...(labels !== undefined ? { labels } : {}),
          });
          expect(logException).toHaveBeenCalledTimes(1);
          const [reported, opts] = logException.mock.calls[0] as unknown as [
            unknown,
            { mechanism: string; labels?: string[] },
          ];
          // the error is forwarded UNCHANGED — the adapter must never substitute or wrap it
          expect(reported).toBe(thrown);
          expect(opts.mechanism).toBe(mechanism ?? 'uncaught');
          expect('labels' in opts).toBe(labels !== undefined);
          if (labels !== undefined) expect(opts.labels).toStrictEqual(labels);
        },
      ),
    );
  });
});
