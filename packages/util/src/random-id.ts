// A portable correlation/context id: 32 lowercase-hex chars. Prefers the global Web Crypto `randomUUID`
// (browsers, edge runtimes, Node >= 19); falls back to a NON-crypto id where the global `crypto` is absent
// (Node < 19 — `globalThis.crypto` is unflagged only on Node 19+). Context/correlation ids are NOT security
// tokens, so the fallback is safe. Tier-0 + runtime-portable, so it stays a GLOBAL probe — never `node:crypto`,
// which edge runtimes (Cloudflare/Vercel) don't have.

export function randomId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) {
    return webCrypto.randomUUID().replace(/-/g, '');
  }
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += Math.floor(Math.random() * 0x1_0000_0000)
      .toString(16)
      .padStart(8, '0');
  }
  return id;
}
