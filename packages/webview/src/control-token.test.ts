import { describe, expect, it, vi } from 'vitest';
import { mintControlToken } from './control-token';

// WAVE 0.3 review round 1, SEV1 — the control token was minted with `randomId()` from @bugsee/util, whose
// own header says: "Context/correlation ids are NOT security tokens, so the fallback is safe". It is safe
// for what it was built for and wrong here, for a reason specific to this runtime:
//
//   `crypto.randomUUID` is exposed only in SECURE CONTEXTS. Android WebViews routinely host `http://`,
//   `content://` and `loadDataWithBaseURL(null, …)` content, where it is undefined — so `randomId()` fell
//   through to four `Math.random()` draws. The attacker in this threat model is a script in the SAME
//   REALM: it can sample `Math.random()` itself, recover V8's xorshift128+ state, and run it back to the
//   draws that produced the token.
//
// A forged-but-correct token is worse than no token: it passes `admits`, ARMS the one-way latch, and from
// then on native's own control is rejected too. The defence would invert into a lockout of native.
//
// `crypto.getRandomValues` is NOT secure-context-gated, which is why it is the right primitive here.
describe('mintControlToken', () => {
  const withCrypto = (crypto: unknown): { crypto?: unknown } => ({ crypto });

  it('mints 32 hex chars (128 bits) from getRandomValues', () => {
    const token = mintControlToken(
      withCrypto({
        getRandomValues: (a: Uint8Array) => {
          a.fill(0xab);
          return a;
        },
      }),
    );
    expect(token).toBe('ab'.repeat(16));
  });

  it('draws exactly 16 bytes — the 128 bits the design claims', () => {
    // The doc says "128-bit random". Asserting the LENGTH of the request, not just the output, so a
    // narrowed draw (e.g. 8 bytes hex-doubled) cannot satisfy the format check while halving the entropy.
    const getRandomValues = vi.fn((a: Uint8Array) => a);
    mintControlToken(withCrypto({ getRandomValues }));
    expect((getRandomValues.mock.calls[0]?.[0] as Uint8Array).byteLength).toBe(16);
  });

  it('never returns the same token twice', () => {
    let n = 0;
    const crypto = {
      getRandomValues: (a: Uint8Array) => {
        a.fill(n++);
        return a;
      },
    };
    expect(mintControlToken(withCrypto(crypto))).not.toBe(mintControlToken(withCrypto(crypto)));
  });

  it('returns undefined when there is NO CSPRNG, rather than a guessable token', () => {
    // The whole point. A weak token is worse than none: it can be forged, and forging it arms the latch
    // and locks native out. No CSPRNG must mean "no authentication", which is the documented
    // pre-upgrade state, not "authentication with a token the page can predict".
    expect(mintControlToken({})).toBeUndefined();
    expect(mintControlToken(withCrypto({}))).toBeUndefined();
    expect(mintControlToken(withCrypto({ randomUUID: () => 'x' }))).toBeUndefined();
  });

  it('does not fall back to Math.random even when it is available', () => {
    // Guards the exact regression: `Math.random` is always present, so any fallback that reaches for it
    // silently restores the defect on every non-secure-context page.
    const spy = vi.spyOn(Math, 'random');
    expect(mintControlToken({})).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns undefined when getRandomValues throws instead of propagating', () => {
    // Capture must never alter app behaviour: a hostile or exotic `crypto` must degrade to "no token",
    // not take `launch()` down with it.
    expect(
      mintControlToken(
        withCrypto({
          getRandomValues: () => {
            throw new Error('denied');
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('rejects a getRandomValues that does not actually fill the buffer', () => {
    // A page can define its own `crypto.getRandomValues`. One that returns the (all-zero) buffer untouched
    // would otherwise yield the constant token '00…0' — perfectly formatted and perfectly guessable.
    expect(mintControlToken(withCrypto({ getRandomValues: (a: Uint8Array) => a }))).toBeUndefined();
  });
});
