import type { ContextProvider, RequestContext } from '@bugsee/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getTraceparent, traceMetaEntries, traceMetaTag } from './trace-data';

/**
 * Property-based tests for the trace-data primitive (P5) — the BE→FE continuation capstone. Its output
 * leaves the SDK twice over: as a W3C `traceparent` a peer parser must accept, and as raw HTML injected
 * into an SSR `<head>`. Both are "for any trace" claims, so both are checked as properties:
 *
 *  1. ROUND-TRIP against an independent, spec-literal W3C parser (a MODEL, not a restatement of the
 *     formatter): whatever `getTraceparent` emits must parse back to exactly the trace it was given.
 *  2. HTML SAFETY of `traceMetaTag`, whose doc comment justifies skipping attribute escaping on the
 *     grounds that a traceparent has "no HTML-special chars". Nothing tested that claim; this does.
 */

const hex = (n: number) =>
  fc
    .stringMatching(new RegExp(`^[0-9a-f]{${n}}$`), { size: 'small' })
    .filter((s) => s.length === n);

/** Realistic trace contexts: ids as `@bugsee/capture`'s `parseTraceparent` validates them (lowercase hex,
 *  non-zero) — the ONLY shapes that reach `RequestContext.trace` from an inbound header or a minted id. */
const traceArb = fc
  .record({ traceId: hex(32), spanId: hex(16), sampled: fc.boolean() })
  .filter((t) => !/^0+$/.test(t.traceId) && !/^0+$/.test(t.spanId));

function clientWithTrace(trace: RequestContext['trace']) {
  const provider: ContextProvider = {
    getCurrent: () => (trace === undefined ? undefined : { contextId: 'c1', trace }),
  };
  return { getServiceProvider: () => ({ getImmediate: () => provider }) } as never;
}

/**
 * An INDEPENDENT W3C trace-context parser, written from the spec text rather than from the formatter:
 * `traceparent = version "-" trace-id "-" parent-id "-" trace-flags`, all lowercase hex, sampled = bit 0.
 */
function parseTraceparentModel(
  header: string,
): { version: string; traceId: string; spanId: string; sampled: boolean } | undefined {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header);
  if (m === null) return undefined;
  const [, version = '', traceId = '', spanId = '', flags = ''] = m;
  return { version, traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

describe('getTraceparent (fuzz)', () => {
  it('emits a header that an independent W3C parser reads back as the SAME trace', () => {
    fc.assert(
      fc.property(traceArb, (trace) => {
        const header = getTraceparent({ getClient: () => clientWithTrace(trace) });
        expect(header).toBeDefined();
        const parsed = parseTraceparentModel(header as string);
        expect(parsed).toStrictEqual({
          version: '00',
          traceId: trace.traceId,
          spanId: trace.spanId,
          sampled: trace.sampled,
        });
      }),
    );
  });

  it('is undefined — never a partial/garbage header — for ANY unusable client or provider', () => {
    const brokenClients = fc.oneof(
      fc.constant(() => undefined),
      fc.constant(() => ({ getServiceProvider: () => ({ getImmediate: () => null }) }) as never),
      fc.constant(
        () =>
          ({
            getServiceProvider: () => ({ getImmediate: () => ({ getCurrent: () => undefined }) }),
          }) as never,
      ),
      fc.constant(
        () =>
          ({
            getServiceProvider: () => ({
              getImmediate: () => ({ getCurrent: () => ({ contextId: 'c1' }) }), // context, no trace
            }),
          }) as never,
      ),
      fc.constant(() => {
        throw new Error('broken carrier');
      }),
      fc.constant(
        () =>
          new Proxy({} as never, {
            get() {
              throw new Error('hostile client');
            },
          }),
      ),
    );
    fc.assert(
      fc.property(brokenClients, (getClient) => {
        expect(getTraceparent({ getClient })).toBeUndefined();
        expect(traceMetaTag({ getClient })).toBe('');
        const entries = traceMetaEntries({ getClient });
        expect(entries).toStrictEqual({});
        expect('traceparent' in entries).toBe(false);
      }),
    );
  });
});

describe('traceMetaTag (fuzz)', () => {
  it('injects HTML that cannot break out of the content attribute (the no-escaping claim)', () => {
    fc.assert(
      fc.property(traceArb, (trace) => {
        const tag = traceMetaTag({ getClient: () => clientWithTrace(trace) });
        // exactly one tag, closed, with the content attribute quoted…
        expect(tag).toMatch(/^<meta name="traceparent" content="[^"<>&]*">$/);
        // …and the attribute value is EXACTLY the header (nothing dropped, nothing escaped away)
        const content = /content="([^"]*)"/.exec(tag)?.[1];
        expect(content).toBe(getTraceparent({ getClient: () => clientWithTrace(trace) }));
      }),
    );
  });

  it('agrees with traceMetaEntries — the two surfaces never disagree about the active trace', () => {
    fc.assert(
      fc.property(fc.option(traceArb, { nil: undefined }), (trace) => {
        const getClient = () => clientWithTrace(trace);
        const header = getTraceparent({ getClient });
        const entries = traceMetaEntries({ getClient });
        const tag = traceMetaTag({ getClient });
        if (header === undefined) {
          expect(entries).toStrictEqual({});
          expect(tag).toBe('');
        } else {
          expect(entries).toStrictEqual({ traceparent: header });
          expect(tag).toBe(`<meta name="traceparent" content="${header}">`);
        }
      }),
    );
  });
});
