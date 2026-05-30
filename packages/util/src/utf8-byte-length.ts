/**
 * UTF-8 byte length of a string, computed allocation-free (no `TextEncoder` / `Uint8Array`) so it
 * can run on the capture hot path where the stores measure each serialized record to enforce the
 * `maxDataSize` byte bound. Semantics match `TextEncoder.encode(s).length`:
 *  - code points < 0x80 → 1 byte, < 0x800 → 2 bytes, the rest of the BMP → 3 bytes;
 *  - a valid surrogate pair → one 4-byte code point;
 *  - a lone surrogate (unpaired high, or a low) → 3 bytes (the U+FFFD replacement an encoder emits).
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a following low surrogate makes one 4-byte code point (consume both);
      // otherwise it is unpaired and counts as the 3-byte replacement character.
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      // 0x800..0xFFFF, including unpaired low surrogates (→ 3-byte replacement).
      bytes += 3;
    }
  }
  return bytes;
}
