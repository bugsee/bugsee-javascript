import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from './utf8-byte-length';

// The capture stores measure a serialized record's footprint with this helper to enforce the
// maxDataSize byte bound; it must match UTF-8 encoding exactly (incl. surrogate handling) and never
// allocate on the hot path. Expected counts are hand-derived from the UTF-8 byte ranges. Strings are
// built from explicit code points (String.fromCharCode / fromCodePoint) so the source stays ASCII.
const cc = (...units: number[]): string => String.fromCharCode(...units);

describe('utf8ByteLength', () => {
  it('returns 0 for the empty string', () => {
    expect(utf8ByteLength('')).toBe(0);
  });

  it('counts each ASCII (< 0x80) code point as 1 byte', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('a')).toBe(1);
    // 0x7F (DEL) is the last 1-byte code point.
    expect(utf8ByteLength(cc(0x7f))).toBe(1);
  });

  it('counts code points in [0x80, 0x7FF] as 2 bytes', () => {
    expect(utf8ByteLength(cc(0x80))).toBe(2); // first 2-byte
    expect(utf8ByteLength(cc(0x00e9))).toBe(2); // é
    expect(utf8ByteLength(cc(0x07ff))).toBe(2); // last 2-byte
  });

  it('counts code points in [0x800, 0xFFFF] as 3 bytes', () => {
    expect(utf8ByteLength(cc(0x0800))).toBe(3); // first 3-byte
    expect(utf8ByteLength(cc(0x20ac))).toBe(3); // euro
    expect(utf8ByteLength(cc(0x4e2d))).toBe(3); // CJK
    expect(utf8ByteLength(cc(0xffff))).toBe(3); // last BMP code unit
  });

  it('counts a valid surrogate pair as a single 4-byte code point', () => {
    // U+1F600 grinning face = high 0xD83D + low 0xDE00.
    expect(utf8ByteLength(String.fromCodePoint(0x1f600))).toBe(4);
    expect(utf8ByteLength(cc(0xd83d, 0xde00))).toBe(4);
    // First astral code point U+10000 = the boundary surrogates 0xD800 + 0xDC00.
    expect(utf8ByteLength(cc(0xd800, 0xdc00))).toBe(4);
  });

  it('counts a lone high surrogate (no valid low surrogate follows) as 3 bytes', () => {
    expect(utf8ByteLength(cc(0xd83d))).toBe(3); // end of string after high surrogate
    expect(utf8ByteLength(cc(0xd83d, 0x78))).toBe(4); // high surrogate + 'x' (ASCII): 3 + 1
    expect(utf8ByteLength(cc(0xd83d, 0xd83d))).toBe(6); // high + high: 3 + 3
    // high surrogate followed by a BMP char above the low-surrogate range (not a pair): 3 + 3.
    expect(utf8ByteLength(cc(0xd83d, 0xffff))).toBe(6);
  });

  it('counts a lone low surrogate as 3 bytes', () => {
    expect(utf8ByteLength(cc(0xde00))).toBe(3);
    // Two low surrogates are each unpaired replacements (a low can never start a pair): 3 + 3.
    expect(utf8ByteLength(cc(0xde00, 0xde00))).toBe(6);
    // First low surrogate 0xDC00 (just past the high-surrogate range) also never starts a pair.
    expect(utf8ByteLength(cc(0xdc00, 0xdc00))).toBe(6);
  });

  it('sums mixed-width content', () => {
    // 'a' (1) + euro (3) + grinning face (4) = 8.
    expect(utf8ByteLength(`a${cc(0x20ac)}${String.fromCodePoint(0x1f600)}`)).toBe(8);
  });

  it('matches the platform TextEncoder across varied content', () => {
    const TextEncoderCtor = (
      globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }
    ).TextEncoder;
    const oracle = (s: string): number => new TextEncoderCtor().encode(s).length;
    const samples = [
      '',
      'plain ascii 123',
      `caf${cc(0x00e9)} ${cc(0x2014)} r${cc(0x00e9)}sum${cc(0x00e9)}`,
      `mixed ${cc(0x4e2d, 0x6587)} and ${cc(0x20ac)}uro`,
      `emoji ${String.fromCodePoint(0x1f600)}${String.fromCodePoint(0x1f389)} text`,
      cc(0xd83d), // lone high surrogate
      cc(0xde00), // lone low surrogate
      `a${cc(0xd83d)}z`, // high surrogate, non-low follower
      cc(0x07ff, 0x0800, 0xffff),
    ];
    for (const s of samples) {
      expect(utf8ByteLength(s)).toBe(oracle(s));
    }
  });
});
