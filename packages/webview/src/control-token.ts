// The per-session CONTROL TOKEN (docs/design/webview-bridge-auth.md D-A1).
//
// Deliberately NOT `randomId()` from @bugsee/util, even though it produces the same 32-hex-char shape.
// That helper's own header states "Context/correlation ids are NOT security tokens, so the fallback is
// safe" — true of a correlation id, false of this. Its fallback is `Math.random()`, and it is reached far
// more often here than the helper's Node-only framing suggests: `crypto.randomUUID` is exposed ONLY in
// secure contexts, while Android WebViews routinely host `http://`, `content://` and
// `loadDataWithBaseURL(null, …)` content. The attacker is a script in the SAME REALM, so it can sample
// `Math.random()` and recover V8's generator state.
//
// `crypto.getRandomValues` carries no secure-context gate, which is why it is the primitive used here.
//
// Returning `undefined` when no CSPRNG exists is the load-bearing decision: a FORGEABLE token is worse
// than none, because a forged-but-correct one passes the check, ARMS the one-way latch, and thereafter
// gets native's own control rejected — the defence inverted into a lockout. No CSPRNG must therefore mean
// "no authentication" (the documented pre-upgrade state), never "authentication the page can predict".

/** The token length in bytes — 128 bits, matching what the design doc promises. */
const TOKEN_BYTES = 16;

interface CryptoLike {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * Mint a 128-bit control token as lowercase hex, or `undefined` when no CSPRNG is available.
 *
 * @param globalObject the global to read `crypto` from (injected for tests; default `globalThis`).
 */
export function mintControlToken(globalObject: unknown = globalThis): string | undefined {
  const crypto = (globalObject as { crypto?: CryptoLike } | undefined)?.crypto;
  if (typeof crypto?.getRandomValues !== 'function') {
    return undefined;
  }
  const bytes = new Uint8Array(TOKEN_BYTES);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    return undefined; // a hostile or exotic `crypto` degrades to "no token", never to a thrown launch()
  }
  // A page can supply its own `crypto.getRandomValues`. One that returns the buffer untouched would yield
  // the constant '00…0' — correctly formatted and completely guessable — so an all-zero draw is refused.
  // (A real CSPRNG produces all-zero 128 bits with probability 2^-128.)
  if (bytes.every((b) => b === 0)) {
    return undefined;
  }
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
