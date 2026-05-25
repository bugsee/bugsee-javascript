/**
 * SHA-256 hex digest via the global WebCrypto `crypto.subtle` (available on browsers, Node >=20,
 * Bun, Deno, and Workers). Async. Used for bundle checksums (design §8.3) and the storage-dir
 * hash (§3.4).
 */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
