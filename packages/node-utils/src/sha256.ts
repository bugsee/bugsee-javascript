import { createHash } from 'node:crypto';

// The node-family upload-checksum digest.
//
// `@bugsee/util`'s `sha256Hex` is WebCrypto-only, because util ships inside every browser and
// edge bundle, where any `node:crypto` specifier breaks the build. The one supported runtime without global
// `crypto.subtle` is unflagged Node 18 (and Electron mains built on it), so the node platform supplies this
// digest to core's upload-pipeline `sha256` seam — the same shape as `httpRequest` for its transport seam.

export type Sha256Digest = (body: Uint8Array) => Promise<string>;

/** Hex SHA-256 of `body` via `node:crypto`; byte-identical to the WebCrypto digest. */
export async function nodeSha256Hex(body: Uint8Array): Promise<string> {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The digest a node-family launch should inject into core's upload pipeline: `nodeSha256Hex` only when the
 * runtime lacks WebCrypto `crypto.subtle`, otherwise `undefined` so core keeps its default.
 *
 * Conditional on purpose. Every modern runtime (Node >=19, Bun, Deno, browsers, edge) then hashes through
 * ONE path, and on Node that path is `subtle.digest`, which runs off the event loop — `createHash` would
 * hash a multi-megabyte bundle synchronously on the application's main thread.
 */
export function nodeSha256Fallback(
  runtime: { crypto?: { subtle?: unknown } } = globalThis as { crypto?: { subtle?: unknown } },
): Sha256Digest | undefined {
  return runtime.crypto?.subtle ? undefined : nodeSha256Hex;
}

/**
 * Hex SHA-256 of a body read as a stream, hashed incrementally: the digest a bundle that is NOT held in memory (a temp
 * file) gets, which WebCrypto's one-shot `digest` cannot give without reading the whole file into the heap first. Hashing
 * runs chunk by chunk between reads, so a large bundle never blocks the event loop for its whole length either.
 */
export async function nodeSha256Stream(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
