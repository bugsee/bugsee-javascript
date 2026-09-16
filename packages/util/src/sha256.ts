type WebCryptoLike = {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};

type TextEncoderCtor = new () => { encode(input: string): Uint8Array };

/**
 * SHA-256 via the global WebCrypto `crypto.subtle` — and nothing else.
 *
 * `@bugsee/util` is tier-0 and reachable from every browser, worker and edge bundle, so it must not name
 * `node:crypto` in any form. Every runtime the SDK supports has `crypto.subtle` (browsers in a secure
 * context, Node >=19, Bun, Deno, workerd, Vercel Edge) except unflagged Node 18 — and a runtime that needs
 * a different digest gets one INJECTED by its platform: `@bugsee/node` hands a `node:crypto` digest to
 * core's upload-pipeline `sha256` seam when `crypto.subtle` is absent (`@bugsee/node-utils` sha256.ts).
 *
 * Without `subtle` this REJECTS with a `NotSupportedError` rather than guessing. The upload pipeline turns
 * that into an upload WITHOUT a checksum (the checksum is not sent today, so it never gates delivery).
 *
 * History: the `import('node:crypto')` fallback this replaces broke every esbuild browser/edge build, and
 * hiding it behind a computed specifier was rejected because workerd refuses dynamic specifiers
 * (`ERR_MODULE_DYNAMIC_SPEC`). A pure-JS SHA-256 was rejected too: this hashes whole multi-megabyte bundles.
 */
async function digestSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!webcrypto?.subtle) {
    const error = new Error(
      'SHA-256 unavailable: this runtime has no WebCrypto `crypto.subtle` (an insecure browser context, ' +
        'or Node 18 without --experimental-global-webcrypto). Platforms without it must inject a digest.',
    );
    error.name = 'NotSupportedError';
    throw error;
  }
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
}

/** SHA-256 hex digest of a string (UTF-8) or raw bytes. Async; rejects when WebCrypto is unavailable. */
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
