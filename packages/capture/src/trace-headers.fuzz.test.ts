import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createTraceparentDecorator, parseTraceparent } from './traceparent';
import {
  encodeBugseeState,
  parseTracestate,
  serializeTracestate,
  setTracestateEntry,
} from './tracestate';

/**
 * Property-based tests for the W3C trace-context codec.
 *
 * This is the SDK's clearest untrusted-input boundary: `traceparent` / `tracestate` arrive from a remote
 * peer we do not control, and the modules' own comments commit to parsing them "defensively ... never
 * throw — we're reading headers minted by others". A total-function guarantee against adversarial input
 * is exactly the kind of claim example-based tests cannot make, so it is asserted here over generated
 * input instead.
 */

/** Header-shaped noise: the separators and hex alphabet, so generated input lands near the grammar. */
const headerish = fc.stringMatching(/^[0-9a-fA-F\-=,:@*/_ \t]{0,80}$/);

const hex = (n: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: n, maxLength: n })
    .map((cs) => cs.join(''));

const validTraceparent = fc
  .tuple(hex(32), hex(16), hex(2))
  .filter(([t, s]) => t !== '0'.repeat(32) && s !== '0'.repeat(16))
  .map(([t, s, f]) => ({ header: `00-${t}-${s}-${f}`, traceId: t, spanId: s, flags: f }));

/**
 * A VALID header with exactly one field corrupted.
 *
 * Purely random strings almost never land inside a grammar this rigid — the odds of randomly emitting
 * four dash-separated fields whose third is exactly 16 hex characters are negligible — so a random-only
 * generator exercises the reject path and nothing else. It demonstrably missed an implementation that
 * accepted ANY non-empty trace id. Corrupting one field of an otherwise valid header puts the input
 * exactly on the boundary each individual check defends.
 */
const nearMissTraceparent = fc
  .tuple(
    validTraceparent,
    fc.constantFrom('version', 'traceId', 'spanId', 'flags', 'extra'),
    fc.constantFrom('zz', '', '0', 'g'.repeat(32), '0'.repeat(32), '0'.repeat(16), 'ff', 'GG'),
  )
  .map(([valid, field, corruption]) => {
    const parts = valid.header.split('-');
    if (field === 'version') {
      parts[0] = corruption;
    } else if (field === 'traceId') {
      parts[1] = corruption;
    } else if (field === 'spanId') {
      parts[2] = corruption;
    } else if (field === 'flags') {
      parts[3] = corruption;
    } else {
      parts.push(corruption);
    }
    return parts.join('-');
  });

describe('parseTraceparent (fuzz)', () => {
  // The header is attacker-controllable in full. A throw here propagates into whatever server hook is
  // adopting the trace — an adapter's request path — so totality is the load-bearing property, not a nicety.
  it('never throws, for any string whatsoever', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 200 }), headerish, nearMissTraceparent),
        (header) => {
          expect(() => parseTraceparent(header)).not.toThrow();
        },
      ),
      { numRuns: 1000 },
    );
  });

  // Whatever it accepts must be usable downstream without re-validation: the ids are spliced straight
  // into an outgoing `traceparent`, so a malformed id accepted here becomes a malformed header we emit.
  it('only ever returns well-formed, non-zero ids', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 200 }), headerish, nearMissTraceparent),
        (header) => {
          const parsed = parseTraceparent(header);
          if (parsed === undefined) {
            return;
          }
          expect(parsed.traceId).toMatch(/^[0-9a-f]{32}$/);
          expect(parsed.spanId).toMatch(/^[0-9a-f]{16}$/);
          expect(parsed.traceId).not.toBe('0'.repeat(32));
          expect(parsed.spanId).not.toBe('0'.repeat(16));
          expect(typeof parsed.sampled).toBe('boolean');
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('accepts every well-formed header and recovers its ids exactly', () => {
    fc.assert(
      fc.property(validTraceparent, ({ header, traceId, spanId, flags }) => {
        const parsed = parseTraceparent(header);
        expect(parsed).toBeDefined();
        expect(parsed?.traceId).toBe(traceId);
        expect(parsed?.spanId).toBe(spanId);
        expect(parsed?.sampled).toBe((Number.parseInt(flags, 16) & 1) === 1);
      }),
      { numRuns: 500 },
    );
  });

  // Shape properties alone cannot see this: `ff` carries perfectly well-formed ids, so an implementation
  // that stopped rejecting it produced valid-looking output and passed everything above. The spec forbids
  // the version outright, and a reserved value is exactly the kind of check a later refactor drops.
  it('always rejects the forbidden version ff and any non-hex version', () => {
    fc.assert(
      fc.property(
        validTraceparent,
        fc.constantFrom('ff', 'FF', 'zz', '', '0', '000'),
        ({ header }, version) => {
          const parts = header.split('-');
          parts[0] = version;
          expect(parseTraceparent(parts.join('-'))).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });

  // W3C: a version-00 header has exactly four fields, and a parser MUST reject one with extra fields.
  // The tolerance this module documents is for FUTURE versions ("future versions with extra fields"),
  // where the spec asks parsers to be permissive — applying it to 00 as well means adopting a trace id
  // from a peer whose header the spec says is invalid.
  it('rejects a version-00 header carrying extra fields, but tolerates them on future versions', () => {
    fc.assert(
      fc.property(validTraceparent, fc.stringMatching(/^[0-9a-f]{1,8}$/), ({ header }, extra) => {
        expect(parseTraceparent(`${header}-${extra}`)).toBeUndefined();
        const future = `01-${header.split('-').slice(1).join('-')}-${extra}`;
        expect(parseTraceparent(future)).toBeDefined();
      }),
      { numRuns: 300 },
    );
  });

  // Documented leniencies, pinned so they stay deliberate: surrounding whitespace and uppercase hex are
  // tolerated. If either is ever tightened, that is a decision to make explicitly, not to discover.
  it('is insensitive to surrounding whitespace and hex case', () => {
    fc.assert(
      fc.property(validTraceparent, fc.constantFrom('', ' ', '\t', '  \t '), ({ header }, pad) => {
        expect(parseTraceparent(`${pad}${header}${pad}`)).toEqual(parseTraceparent(header));
        expect(parseTraceparent(header.toUpperCase())).toEqual(parseTraceparent(header));
      }),
      { numRuns: 300 },
    );
  });
});

describe('tracestate codec (fuzz)', () => {
  // Reached through globalThis: this tier is runtime-portable and compiles without the DOM/Node libs, so
  // `TextEncoder` and `URL` are not in its type space even though every target runtime provides them.
  const { TextEncoder: Encoder } = globalThis as unknown as {
    TextEncoder: new () => { encode(input: string): Uint8Array };
  };
  const byteLength = (s: string): number => new Encoder().encode(s).length;

  it('never throws on arbitrary header input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 300 }), headerish), (header) => {
        expect(() => parseTracestate(header)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });

  // Parsing is the only gate between a peer's header and our in-memory list, so its own caps must hold
  // regardless of what arrives.
  it('caps the entry count and never emits a malformed or duplicate entry', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 400 }), headerish), (header) => {
        const entries = parseTracestate(header);
        expect(entries.length).toBeLessThanOrEqual(32);
        const keys = entries.map((e) => e.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const entry of entries) {
          expect(entry.key).toMatch(/^[a-z0-9][a-z0-9_\-*/@]*$/);
          expect(entry.value.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1000 },
    );
  });

  // The codec's fixed point: whatever survives one parse must survive serialization unchanged. A value
  // that re-splits on the way back out (an embedded comma, say) would silently rewrite another vendor's
  // entry — this is the property that catches it.
  it('round-trips: parse(serialize(parse(x))) === parse(x)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 400 }), headerish), (header) => {
        const once = parseTracestate(header);
        const twice = parseTracestate(serializeTracestate(once));
        expect(twice).toEqual(once);
      }),
      { numRuns: 1000 },
    );
  });

  /**
   * The normative cross-SDK cap: "cap at 32 entries AND 512 bytes ... pinned so every Bugsee SDK
   * truncates to identical bytes".
   *
   * Measured here in BYTES, deliberately, because that is what the contract says and what a peer SDK
   * measuring bytes will compare against. `tracestate` values are not charset-validated on the way in
   * (the key is, the value is not), so a remote peer can put multibyte characters in a value and any
   * cap counting UTF-16 code units will let the emitted header past the byte limit.
   */
  it('keeps a mutated tracestate within the 512-byte cap', () => {
    const entryArb = fc.record({
      key: fc.stringMatching(/^[a-z][a-z0-9_\-*/@]{0,10}$/),
      value: fc.oneof(
        fc.stringMatching(/^[a-zA-Z0-9:._-]{1,60}$/),
        // Multibyte values: legal to arrive, and the case where characters and bytes diverge.
        //
        // Built from an explicit multibyte alphabet rather than a general unicode generator. The first
        // version of this used `fc.string({unit:'grapheme'})`, which produced overwhelmingly ASCII values
        // and passed against an implementation that emitted 934 bytes for a 512-byte cap — the property
        // was right and the generator was too weak to reach the defect. A generator that cannot construct
        // the failure is indistinguishable from a passing implementation.
        fc
          .array(fc.constantFrom('😀', '日', 'é', '→', '𝄞'), { minLength: 10, maxLength: 40 })
          .map((cs) => cs.join('')),
      ),
    });
    fc.assert(
      // minLength, not just maxLength: fast-check biases toward SMALL arrays, so a bare `maxLength: 40`
      // spent almost every run on 0-5 entries — far under the cap, making the property vacuously true.
      // A cap can only be tested by inputs that exceed it.
      fc.property(fc.array(entryArb, { minLength: 20, maxLength: 40 }), (entries) => {
        const deduped = parseTracestate(serializeTracestate(entries));
        const result = setTracestateEntry(deduped, 'bugsee', encodeBugseeState({ record: true }));
        const serialized = serializeTracestate(result);
        expect(result.length).toBeLessThanOrEqual(32);
        // A single entry may legitimately exceed the cap (ours is never dropped); anything more must fit.
        if (result.length > 1) {
          expect(byteLength(serialized)).toBeLessThanOrEqual(512);
        }
      }),
      { numRuns: 500 },
    );
  });

  // Our entry is the one the backend joins on, so it must survive every mutation and lead the list.
  it('always places the bugsee entry first and keeps it', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 300 }), headerish),
        fc.stringMatching(/^[a-zA-Z0-9:._-]{1,40}$/),
        (header, value) => {
          const result = setTracestateEntry(parseTracestate(header), 'bugsee', value);
          expect(result[0]).toEqual({ key: 'bugsee', value });
          expect(result.filter((e) => e.key === 'bugsee').length).toBe(1);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('traceparent decorator cross-origin guarantee (fuzz)', () => {
  const { URL: URLCtor } = globalThis as unknown as {
    URL: new (url: string, base?: string) => { origin: string };
  };
  const span = {
    getTraceId: () => 'a'.repeat(32),
    getSpanId: () => 'b'.repeat(16),
  };

  /**
   * The module's stated SECURITY property: "CROSS-ORIGIN requests are propagated ONLY when the URL
   * matches an explicit allowlist — injecting `traceparent` to a third party would leak the trace
   * topology."
   *
   * Asserted over generated URLs rather than a handful of examples, because the leak that matters is the
   * one nobody wrote a case for.
   */
  it('never injects traceparent cross-origin when no allowlist is configured', () => {
    const decorate = createTraceparentDecorator({
      getActiveSpan: () => span,
      origin: 'https://app.example.com',
      resolveOrigin: (url, base) => {
        try {
          return new URLCtor(url, base).origin;
        } catch {
          return undefined;
        }
      },
    });
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const result = decorate({ url, method: 'GET', headers: {} });
        const sameOrigin = (() => {
          try {
            return new URLCtor(url, 'https://app.example.com').origin === 'https://app.example.com';
          } catch {
            return false;
          }
        })();
        if (!sameOrigin) {
          expect(result?.traceparent).toBeUndefined();
        }
      }),
      { numRuns: 1000 },
    );
  });

  // An upstream trace context is authoritative: overwriting it would fork the distributed trace.
  it('never overwrites an existing traceparent, whatever the header casing', () => {
    const decorate = createTraceparentDecorator({
      getActiveSpan: () => span,
      origin: 'https://app.example.com',
      allowlist: [/.*/],
      resolveOrigin: () => 'https://app.example.com',
    });
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.constantFrom('traceparent', 'Traceparent', 'TRACEPARENT', 'TraceParent'),
        fc.string({ minLength: 1, maxLength: 60 }),
        (url, headerName, existing) => {
          const result = decorate({ url, method: 'GET', headers: { [headerName]: existing } });
          expect(result?.traceparent).toBeUndefined();
        },
      ),
      { numRuns: 500 },
    );
  });
});
