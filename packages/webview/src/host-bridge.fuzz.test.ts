import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createHostBridge, DEFAULT_MAX_BUFFER } from './host-bridge';

/**
 * Property-based tests for the host bridge — the JS→native transport.
 *
 * Three behaviours here are load-bearing and were unasserted:
 *
 *  - the capture NONCE is stamped onto every envelope, because native rejects anything unstamped (D-A11),
 *    and it is spliced by STRING surgery rather than a parse/re-encode, so the guard that makes that safe
 *    has to hold for every input;
 *  - `available` is a PURE read. It used to call `resolve()`, so merely asking "is the bridge there?"
 *    pinned the sink as a side effect — a getter that mutates is a trap, and it moved the pin to an
 *    arbitrary read instead of the first message;
 *  - the pre-attach buffer is BOUNDED, so a page that never gets a native sink cannot grow it without
 *    limit.
 */

/** A native sink that records what it received. */
const recordingGlobal = () => {
  const posted: string[] = [];
  return {
    posted,
    global: { BugseeBridge: { post: (raw: string) => posted.push(raw) } } as object,
  };
};

/** An envelope shaped the way `encode` produces them — the only shape stamping may touch. */
const envelope = fc
  .record({ k: fc.constantFrom('entry', 'secure', 'report'), s: fc.integer({ min: 0, max: 1e6 }) })
  .map(({ k, s }) => `{"b":1,"k":"${k}","s":${s}}`);

describe('host bridge nonce stamping (fuzz)', () => {
  it('stamps every envelope, keeping it valid JSON with the original members intact', () => {
    fc.assert(
      fc.property(envelope, fc.stringMatching(/^[A-Za-z0-9_-]{8,32}$/), (raw, nonce) => {
        const { posted, global } = recordingGlobal();
        const bridge = createHostBridge({ global, transport: 'android', nonce });
        bridge.post(raw);

        expect(posted).toHaveLength(1);
        const stamped = posted[0] as string;
        const parsed = JSON.parse(stamped) as Record<string, unknown>;
        expect(parsed.n, 'the nonce was not stamped').toBe(nonce);
        // Every original member survives, unchanged.
        for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          expect(parsed[key], `member ${key} was lost or altered`).toEqual(value);
        }
      }),
      { numRuns: 400 },
    );
  });

  /**
   * A nonce needing JSON escaping must not break the envelope. The stamp is string surgery, so a nonce
   * carrying a quote or a backslash would otherwise produce something that no longer parses — and native
   * drops what it cannot parse, i.e. the whole capture stream.
   */
  it('survives a nonce that needs escaping', () => {
    fc.assert(
      fc.property(
        envelope,
        fc.constantFrom('a"b', 'a\\b', 'a\nb', '"', '\\', 'a b'),
        (raw, nonce) => {
          const { posted, global } = recordingGlobal();
          createHostBridge({ global, transport: 'android', nonce }).post(raw);
          const parsed = JSON.parse(posted[0] as string) as Record<string, unknown>;
          expect(parsed.n).toBe(nonce);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * Anything that is NOT an envelope passes through untouched rather than being corrupted.
   *
   * The `{"b":` guard is what makes the splice safe: it guarantees there is a member to precede. Without
   * it, stamping an empty object would emit `{"n":"…",}` — invalid JSON, silently dropped by native.
   */
  it('never corrupts a payload that is not an envelope', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('{}', '[]', '', 'null', 'not json at all', '{"a":1}', '{ "b":1}'),
          fc.string({ maxLength: 60 }).filter((s) => !s.startsWith('{"b":')),
        ),
        fc.stringMatching(/^[A-Za-z0-9]{8,16}$/),
        (raw, nonce) => {
          const { posted, global } = recordingGlobal();
          createHostBridge({ global, transport: 'android', nonce }).post(raw);
          expect(posted[0], 'a non-envelope payload was rewritten').toBe(raw);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('passes envelopes through unchanged when there is no nonce', () => {
    fc.assert(
      fc.property(envelope, (raw) => {
        const { posted, global } = recordingGlobal();
        createHostBridge({ global, transport: 'android' }).post(raw);
        expect(posted[0]).toBe(raw);
      }),
      { numRuns: 300 },
    );
  });
});

describe('host bridge availability + buffering (fuzz)', () => {
  /**
   * `available` is a PURE read: asking must not pin the sink, or the pin happens at an arbitrary caller's
   * read rather than at the first message.
   */
  it('asking whether the bridge is available does not pin the sink', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (asks) => {
        // Start with NO sink, ask repeatedly, then install one: the first post must still find it.
        const holder: { BugseeBridge?: { post: (raw: string) => void } } = {};
        const posted: string[] = [];
        const bridge = createHostBridge({ global: holder as object, transport: 'android' });
        for (let i = 0; i < asks; i += 1) {
          expect(bridge.available).toBe(false);
        }
        holder.BugseeBridge = { post: (raw) => posted.push(raw) };
        expect(bridge.available).toBe(true);
        bridge.post('{"b":1,"k":"entry"}');
        expect(posted, 'a sink installed after an availability check was never used').toHaveLength(
          1,
        );
      }),
      { numRuns: 300 },
    );
  });

  /**
   * The pin happens at the FIRST MESSAGE, not at an availability read — which is only observable when the
   * sink CHANGES in between.
   *
   * My first version of the property above missed this: with no sink installed, a `resolve()`-calling
   * getter pins nothing, so the outcome looked identical. The distinguishing case is a sink that is
   * REPLACED after the read — native attaching its own handler over a transitional one — where pinning
   * early sends every message to the sink that is no longer there.
   */
  it('pins at the first message, so a sink replaced after an availability read still receives', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (asks) => {
        const first: string[] = [];
        const second: string[] = [];
        const holder = {
          BugseeBridge: { post: (raw: string) => first.push(raw) },
        };
        const bridge = createHostBridge({ global: holder as object, transport: 'android' });

        for (let i = 0; i < asks; i += 1) {
          expect(bridge.available).toBe(true); // a PURE read — must not pin
        }
        holder.BugseeBridge = { post: (raw: string) => second.push(raw) };
        bridge.post('{"b":1,"k":"entry"}');

        expect(second, 'the message went to the sink that was replaced').toHaveLength(1);
        expect(first, 'an availability read pinned the old sink').toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });

  // The pre-attach buffer is bounded: a page that never gets a sink must not grow it without limit, and
  // when a sink appears the SURVIVING messages are the most recent ones.
  it('bounds the pre-attach buffer and flushes the newest on attach', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (extra) => {
        const holder: { BugseeBridge?: { post: (raw: string) => void } } = {};
        const posted: string[] = [];
        const bridge = createHostBridge({ global: holder as object, transport: 'android' });

        const total = DEFAULT_MAX_BUFFER + extra;
        for (let i = 0; i < total; i += 1) {
          bridge.post(`{"b":1,"k":"entry","s":${i}}`);
        }
        holder.BugseeBridge = { post: (raw) => posted.push(raw) };
        bridge.post('{"b":1,"k":"entry","s":-1}'); // triggers the flush

        expect(posted.length).toBeLessThanOrEqual(DEFAULT_MAX_BUFFER + 1);
        // The OLDEST were evicted, so the first delivered is not sequence 0.
        const sequences = posted.map((raw) => (JSON.parse(raw) as { s: number }).s);
        expect(sequences[0], 'the buffer kept the oldest instead of the newest').toBeGreaterThan(0);
        expect(sequences.at(-1)).toBe(-1);
      }),
      { numRuns: 200 },
    );
  });
});
