/// <reference path="./web-globals.d.ts" />
// The reference makes the local `node:crypto` ambient (web-globals.d.ts) travel with this file,
// so a consumer that type-checks @bugsee/util's source (e.g. @bugsee/service) can resolve the
// dynamic import without needing @types/node of its own.

type WebCryptoLike = {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};

type TextEncoderCtor = new () => { encode(input: string): Uint8Array };

/**
 * Computes the SHA-256 digest, preferring the global WebCrypto `crypto.subtle` (browsers, Node
 * >=19/20, Bun, Deno, Workers) and falling back to `node:crypto` when no global `crypto`/`subtle`
 * exists (the Node >=18 baseline without `--experimental-global-webcrypto`); both paths produce
 * identical digests. Matches design §8.3, which routes Node/Bun through `node:crypto`.
 *
 * The `node:crypto` import is dynamic AND marked ignore-for-every-bundler-that-honours-comments (Wave
 * 3b.5). Dynamic alone only defers the LOAD; a bundler still resolves the specifier and pulls it into the
 * graph, which on an edge target is a hard build failure — `@bugsee/util` is tier-0 and reachable from
 * `@bugsee/core`, so this one line broke `next build` for any app whose edge graph touched the SDK at all
 * (reproduced on real Next 15.5: `node:crypto` ← util/sha256 ← core/bugsee-api ← adapter-kit ←
 * nextjs/trace-data). The ignore comments keep the specifier a literal, so no bundler emits a "critical
 * dependency" warning either — measured, not assumed: webpack 5.110 is silent because `webpackIgnore`
 * stops it parsing the import at all.
 *
 * KNOWN LIMITATION, and the alternative was MEASURED AND REJECTED. esbuild honours none of these comments,
 * so a browser- or edge-target esbuild build fails with `Could not resolve "node:crypto"`; the customer's
 * answer is `external: ['node:crypto']`, which is safe in practice because every secure context has
 * `crypto.subtle` and the fallback is unreachable there.
 *
 * Computing the specifier (`['node','crypto'].join(':')`) hides it from every bundler's static graph and
 * DOES fix esbuild — verified, along with vite 8 and webpack 5 staying clean. It was still reverted:
 * **workerd rejects dynamic module specifiers outright** (`ERR_MODULE_DYNAMIC_SPEC: dynamic module
 * specifiers are unsupported`), which took out the real-workerd Durable Object e2e and would break
 * `@bugsee/cloudflare` in production. Trading an esbuild build error for a broken supported runtime is a
 * bad trade.
 *
 * The fix with no downside is a per-runtime `exports` condition on `@bugsee/util` — a node entry that
 * keeps this fallback and a default entry that is WebCrypto-only — so no browser or edge bundle contains
 * the specifier in any form. That needs a second dist build and is not done here.
 *
 * A pure-JS SHA-256 was also considered and rejected: this hashes the whole bundle BODY for the PUT
 * checksum, and bundles run to megabytes.
 */
async function digestSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (webcrypto?.subtle) {
    return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
  }
  const { createHash } = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ 'node:crypto'
  );
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
