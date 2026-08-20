import type { NetworkEvent } from '@bugsee/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { collectHttpSpans, type NetworkSource } from './http-spans';
import type { RecordChildSpanOptions } from './span';

/**
 * Property-based tests for the BE→FE return-header reader.
 *
 * `traceresponse` and `Server-Timing` arrive from THE BACKEND — any backend, not only ours, and over the
 * network. The span id read out of them is stamped onto the client span as `bugsee.server_span_id`, so a
 * value that should have been rejected either breaks the FE↔BE join or plants backend-chosen data in our
 * telemetry.
 *
 * The module validates strictly on purpose (its comment says "validated like parseTraceparent"), but the
 * anchors carrying that strictness all survived mutation: `/^[0-9a-f]{32}$/` could lose either anchor and
 * every test still passed, because no test supplied a segment that was hex but the WRONG LENGTH. Nor did
 * anything exercise the documented case tolerance, or a `Server-Timing` that simply has no traceparent in
 * it — which is the overwhelmingly common shape of that header in the wild (`cache;desc="hit"`).
 */

const netEvent = (over: Partial<NetworkEvent>): NetworkEvent =>
  ({
    timestamp: 0,
    id: '',
    sequence: '',
    mechanism: 'fetch',
    url: '',
    method: 'GET',
    type: 'before',
    ...over,
  }) as NetworkEvent;

function harness() {
  const listeners = new Map<string, Set<(e: NetworkEvent) => void>>();
  const source = {
    on: (name: string, fn: (e: NetworkEvent) => void) => {
      (listeners.get(name) ?? listeners.set(name, new Set()).get(name))?.add(fn);
      return () => {
        listeners.get(name)?.delete(fn);
      };
    },
    onAny: () => () => {},
  } as unknown as NetworkSource;
  const emit = (name: string, e: NetworkEvent) => {
    for (const l of listeners.get(name) ?? []) l(e);
  };
  const calls: { op: string; opts: RecordChildSpanOptions }[] = [];
  const span = {
    recordChildSpan: (op: string, opts: RecordChildSpanOptions) => calls.push({ op, opts }),
  };
  collectHttpSpans({ source, getActiveSpan: () => span as never });
  return { emit, calls };
}

/** Run one request whose response carries `headers`, and return the stamped backend span id (if any). */
function serverSpanIdFor(headers: Record<string, string>): unknown {
  const { emit, calls } = harness();
  emit('before', netEvent({ id: 'r', timestamp: 1, method: 'GET', url: 'https://x/a' }));
  emit('complete', netEvent({ id: 'r', timestamp: 2, custom: { headers } as never }));
  return calls[0]?.opts.attributes?.['bugsee.server_span_id'];
}

const HEX = '0123456789abcdef';
const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));

/** A conformant `traceparent`-format value, the thing the reader is supposed to accept. */
const validTraceparent = fc
  .record({ traceId: hex(32), spanId: hex(16), flags: hex(2) })
  .filter((p) => p.traceId !== '0'.repeat(32) && p.spanId !== '0'.repeat(16))
  .map((p) => ({ ...p, value: `00-${p.traceId}-${p.spanId}-${p.flags}` }));

describe('backend return-header reader (fuzz)', () => {
  it('accepts a conformant traceparent and returns exactly its span id', () => {
    fc.assert(
      fc.property(validTraceparent, ({ value, spanId }) => {
        expect(serverSpanIdFor({ traceresponse: value })).toBe(spanId);
      }),
      { numRuns: 400 },
    );
  });

  /**
   * Whatever comes back, the stamped value is either absent or exactly 16 lowercase hex characters. This
   * is the invariant that holds even if every individual validation rule were wrong.
   */
  it('never stamps anything that is not a 16-character lowercase hex span id', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 120 }),
          validTraceparent.map((p) => p.value),
          fc.constantFrom(
            '',
            '-',
            '--',
            '00',
            '00-',
            'not-a-trace-parent-at-all',
            `00-${'a'.repeat(32)}-${'b'.repeat(16)}`, // no flags — deliberately tolerated
          ),
        ),
        (value) => {
          const stamped = serverSpanIdFor({ traceresponse: value });
          if (stamped === undefined) return;
          expect(stamped, `stamped ${JSON.stringify(stamped)}`).toMatch(/^[0-9a-f]{16}$/);
        },
      ),
      { numRuns: 1000 },
    );
  });

  /**
   * The LENGTH of each segment is load-bearing, and this is where the missing anchors would show.
   * Corrupt a valid header by growing or shrinking one segment with more hex — still hex, still in the
   * right position, just the wrong size. An unanchored test would accept every one of these.
   */
  it('rejects a segment that is hex but the wrong length', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom(0, 1, 2), // version / traceId / spanId
        fc.constantFrom(-1, 1, 2, 8),
        fc.constantFrom('a', 'f', '0', '9'),
        ({ value }, index, delta, pad) => {
          const parts = value.split('-');
          const segment = parts[index] as string;
          parts[index] =
            delta < 0
              ? segment.slice(0, Math.max(0, segment.length - 1))
              : segment + pad.repeat(delta);
          expect(
            serverSpanIdFor({ traceresponse: parts.join('-') }),
            `a ${['version', 'traceId', 'spanId'][index]} of length ${(parts[index] as string).length} was accepted`,
          ).toBeUndefined();
        },
      ),
      { numRuns: 600 },
    );
  });

  it('rejects a non-hex character anywhere in a segment', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom(0, 1, 2),
        fc.nat(),
        fc.constantFrom('g', 'z', ' ', '+', '/', 'Z', 'é'),
        ({ value }, index, at, bad) => {
          const parts = value.split('-');
          const segment = parts[index] as string;
          const position = at % segment.length;
          parts[index] = segment.slice(0, position) + bad + segment.slice(position + 1);
          expect(serverSpanIdFor({ traceresponse: parts.join('-') })).toBeUndefined();
        },
      ),
      { numRuns: 600 },
    );
  });

  /**
   * The reader normalizes case and trims — its comment says so, precisely so a third-party backend that
   * emits uppercase hex is handled and not just our own conformant one. A differential property: the
   * decorated value must produce the same id as the canonical one.
   */
  it('reads an uppercased or padded header the same as the canonical one', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom('', ' ', '  ', '\t', '\n'),
        fc.constantFrom('', ' ', '\t'),
        ({ value, spanId }, before, after) => {
          expect(
            serverSpanIdFor({ traceresponse: `${before}${value.toUpperCase()}${after}` }),
            'an uppercase or padded traceresponse was not normalized',
          ).toBe(spanId);
        },
      ),
      { numRuns: 400 },
    );
  });

  /** The header NAME match is case-insensitive — backends and proxies spell headers however they like. */
  it('finds the header whatever its case', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom('traceresponse', 'Traceresponse', 'TraceResponse', 'TRACERESPONSE'),
        ({ value, spanId }, name) => {
          expect(serverSpanIdFor({ [name]: value })).toBe(spanId);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('Server-Timing fallback (fuzz)', () => {
  it('reads the traceparent metric out of a Server-Timing value', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom('', 'cache;desc="hit", ', 'db;dur=53, ', 'cdn-cache;desc="MISS",'),
        fc.constantFrom('', ', app;dur=47', ', cache;desc="hit"'),
        ({ value, spanId }, prefix, suffix) => {
          expect(
            serverSpanIdFor({ 'server-timing': `${prefix}traceparent;desc="${value}"${suffix}` }),
          ).toBe(spanId);
        },
      ),
      { numRuns: 400 },
    );
  });

  /**
   * `Server-Timing` almost never contains a traceparent — `cache`, `db`, `cdn` and friends are the norm,
   * and this reader runs on EVERY completed request that carries the header. A non-matching value must
   * yield nothing and, above all, must not throw: the regex returns null and the capture read that
   * follows it is what the optional chain is protecting.
   */
  it('yields nothing, and never throws, for a Server-Timing with no traceparent metric', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 80 }),
          fc.constantFrom(
            'cache;desc="hit"',
            'db;dur=53, app;dur=47.2',
            'miss, db;dur=53',
            'cdn-cache; desc="HIT"',
            'traceparent', // the name with no desc
            'traceparent;desc=', // a desc with no quoted value
            'traceparent;desc=""', // an EMPTY quoted value
            'xtraceparent;desc="00-aa-bb-01"', // the name as a suffix of another metric
            'my-traceparent;desc="00-aa-bb-01"',
          ),
        ),
        (value) => {
          let stamped: unknown;
          expect(
            () => {
              stamped = serverSpanIdFor({ 'server-timing': value });
            },
            `threw on Server-Timing: ${JSON.stringify(value)}`,
          ).not.toThrow();
          if (stamped !== undefined) {
            expect(stamped).toMatch(/^[0-9a-f]{16}$/);
          }
        },
      ),
      { numRuns: 800 },
    );
  });

  /**
   * The metric NAME must be `traceparent` exactly, not merely start with it.
   *
   * Only a VALID desc can show this: with an invalid one both the strict and the loose form yield nothing,
   * so a suffixed name paired with junk proves nothing. `traceparentfoo;desc="<a real traceparent>"` is
   * the case that separates them.
   */
  it('does not treat a metric whose name merely STARTS with traceparent as one', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom('foo', '-id', '2', '_v2', 'x'),
        ({ value }, suffix) => {
          expect(
            serverSpanIdFor({ 'server-timing': `traceparent${suffix};desc="${value}"` }),
            `the metric traceparent${suffix} was read as a traceparent`,
          ).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });

  /** `traceresponse` is the primary; `Server-Timing` is only consulted when it yields nothing. */
  it('prefers traceresponse over Server-Timing', () => {
    fc.assert(
      fc.property(validTraceparent, validTraceparent, (primary, fallback) => {
        fc.pre(primary.spanId !== fallback.spanId);
        expect(
          serverSpanIdFor({
            traceresponse: primary.value,
            'server-timing': `traceparent;desc="${fallback.value}"`,
          }),
        ).toBe(primary.spanId);
        // …but an UNUSABLE traceresponse falls through rather than blocking the fallback.
        expect(
          serverSpanIdFor({
            traceresponse: 'garbage',
            'server-timing': `traceparent;desc="${fallback.value}"`,
          }),
        ).toBe(fallback.spanId);
      }),
      { numRuns: 300 },
    );
  });

  it('rejects the forbidden ff version and the all-zero ids from either source', () => {
    const zeroTrace = '0'.repeat(32);
    const zeroSpan = '0'.repeat(16);
    const good = 'a'.repeat(32);
    const goodSpan = 'b'.repeat(16);
    for (const value of [
      `ff-${good}-${goodSpan}-01`,
      `FF-${good}-${goodSpan}-01`,
      `00-${zeroTrace}-${goodSpan}-01`,
      `00-${good}-${zeroSpan}-01`,
    ]) {
      expect(serverSpanIdFor({ traceresponse: value }), `${value} was accepted`).toBeUndefined();
      expect(
        serverSpanIdFor({ 'server-timing': `traceparent;desc="${value}"` }),
        `${value} was accepted via Server-Timing`,
      ).toBeUndefined();
    }
    expect(HEX).toContain('f'); // guard against the generator alphabet drifting
  });
});
