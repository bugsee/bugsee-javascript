import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mintControlToken } from './control-token';

/**
 * Property-based tests for the control token (webview-bridge-auth.md D-A1).
 *
 * The attacker here is a script in the SAME REALM as the SDK, so every decision in this function is a
 * security decision, and the module's own header explains why each one is load-bearing:
 *
 *  - `crypto.getRandomValues`, not `randomId()`, because that helper falls back to `Math.random()` — whose
 *    generator state a same-realm script can recover — and `crypto.randomUUID` is secure-context only,
 *    while Android WebViews routinely host `http://`, `content://` and `loadDataWithBaseURL(null, …)`.
 *  - `undefined` rather than a weak token, because a FORGEABLE token is worse than none: a
 *    forged-but-correct one passes the check, arms the one-way latch, and thereafter gets NATIVE's own
 *    control rejected — the defence inverted into a lockout.
 *
 * Mutation testing found every one of those decisions unasserted.
 */

/** A CSPRNG stand-in that fills deterministically, so the encoding can be checked exactly. */
const fillingCrypto = (fill: (i: number) => number) => ({
  crypto: {
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = fill(i) & 0xff;
      }
      return array;
    },
  },
});

describe('mintControlToken (fuzz)', () => {
  it('mints exactly 128 bits as lowercase hex when a CSPRNG is available', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 255 }), (seed) => {
        const token = mintControlToken(fillingCrypto((i) => seed + i));
        expect(token).toMatch(/^[0-9a-f]{32}$/); // 16 bytes × 2 hex chars
      }),
      { numRuns: 400 },
    );
  });

  /**
   * The ENCODING is exact, byte for byte.
   *
   * Dropping the `padStart(2, '0')` renders a byte below 0x10 as a single character, which both shortens
   * the token and makes two different draws collide (0x0a,0xbc and 0xab,0xc0 both spell "abc"). The
   * regex above would still pass for many draws, so the encoding is pinned against an independent one.
   */
  it('encodes every byte as two hex digits, including bytes below 0x10', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 16, maxLength: 16 }),
        (bytes) => {
          fc.pre(bytes.some((b) => b !== 0)); // an all-zero draw is refused by design, tested separately
          const token = mintControlToken(fillingCrypto((i) => bytes[i] as number));
          const expected = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
          expect(token).toBe(expected);
          expect(token).toHaveLength(32);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('produces a different token for a different draw', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.integer({ min: 1, max: 200 }), (a, b) => {
        fc.pre(a !== b);
        expect(mintControlToken(fillingCrypto(() => a))).not.toBe(
          mintControlToken(fillingCrypto(() => b)),
        );
      }),
      { numRuns: 300 },
    );
  });

  /**
   * No CSPRNG → NO token. Every shape of "no CSPRNG" must reach the same answer, because the alternative
   * is a token the page can predict.
   */
  it('returns undefined whenever no usable CSPRNG is present', () => {
    // NOT `undefined`: that triggers the DEFAULT parameter, so the function reads the real `globalThis`,
    // which does have a CSPRNG. Passing it asserts the opposite of what it looks like.
    const unusable = fc.constantFrom<unknown>(
      null,
      {},
      { crypto: undefined },
      { crypto: null },
      { crypto: {} },
      { crypto: { getRandomValues: undefined } },
      { crypto: { getRandomValues: 'not-a-function' } },
      { crypto: { getRandomValues: 42 } },
    );
    fc.assert(
      fc.property(unusable, (globalObject) => {
        expect(mintControlToken(globalObject)).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });

  /**
   * The `catch` is the load-bearing defence, not the `typeof` guard.
   *
   * Deleting the `typeof crypto?.getRandomValues !== 'function'` check is an EQUIVALENT mutation: calling
   * a missing method throws a TypeError that the catch below already turns into `undefined`, so every
   * input reaches the same answer. Recorded because the inverse is NOT equivalent — removing the catch
   * on the assumption that the guard covers it turns a hostile `crypto` into a thrown `launch()`, which
   * the next test pins.
   */
  // A hostile or exotic `crypto` must degrade to "no token", never to a thrown `launch()`.
  it('returns undefined, without throwing, when getRandomValues throws', () => {
    const hostile = {
      crypto: {
        getRandomValues: () => {
          throw new Error('getRandomValues exploded');
        },
      },
    };
    let token: string | undefined;
    expect(() => {
      token = mintControlToken(hostile);
    }).not.toThrow();
    expect(token).toBeUndefined();
  });

  /**
   * THE page-supplied-CSPRNG defence: a script can install its own `crypto.getRandomValues`. One that
   * returns the buffer untouched yields '00…0' — correctly formatted, completely guessable — so an
   * all-zero draw is refused. A real CSPRNG produces it with probability 2^-128.
   */
  it('refuses an all-zero draw, however it is produced', () => {
    for (const fake of [
      { crypto: { getRandomValues: (a: Uint8Array) => a } }, // returns the buffer untouched
      { crypto: { getRandomValues: (a: Uint8Array) => a.fill(0) } }, // explicitly zeroed
      { crypto: { getRandomValues: () => new Uint8Array(16) } }, // ignores the buffer entirely
    ]) {
      expect(mintControlToken(fake), 'a guessable all-zero token was minted').toBeUndefined();
    }
  });

  // ...but a draw that is merely MOSTLY zero is fine: refusing those would throw away real entropy, and
  // the rule is specifically about the degenerate constant a no-op filler produces.
  it('accepts a draw with a single non-zero byte', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 1, max: 255 }),
        (at, value) => {
          const token = mintControlToken(fillingCrypto((i) => (i === at ? value : 0)));
          expect(token).toMatch(/^[0-9a-f]{32}$/);
        },
      ),
      { numRuns: 300 },
    );
  });
});
