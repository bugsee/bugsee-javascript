type WebCryptoLike = {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};

type TextEncoderCtor = new () => { encode(input: string): Uint8Array };

/**
 * Computes the SHA-256 digest, preferring the global WebCrypto `crypto.subtle` (browsers, Node
 * >=19/20, Bun, Deno, Workers) and falling back to `node:crypto` when no global `crypto`/`subtle`
 * exists (the Node >=18 baseline without `--experimental-global-webcrypto`); both paths produce
 * identical digests. Matches design §8.3, which routes Node/Bun through `node:crypto`. The
 * `node:crypto` import is dynamic so it never loads on runtimes that have global WebCrypto.
 */
async function digestSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (webcrypto?.subtle) {
    return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
  }
  const { createHash } = await import('node:crypto');
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/** SHA-256 hex digest of a string (UTF-8) or raw bytes. Async. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string'
      ? new (globalThis as unknown as { TextEncoder: TextEncoderCtor }).TextEncoder().encode(data)
      : data;
  let hex = '';
  for (const byte of await digestSha256(bytes)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
