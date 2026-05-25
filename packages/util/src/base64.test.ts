import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('toBase64', () => {
  it('encodes empty input to an empty string', () => {
    expect(toBase64(new Uint8Array([]))).toBe('');
  });

  it('encodes 3-byte groups without padding', () => {
    expect(toBase64(enc('Man'))).toBe('TWFu');
  });

  it('encodes a 2-byte remainder with single padding', () => {
    expect(toBase64(enc('Ma'))).toBe('TWE=');
  });

  it('encodes a 1-byte remainder with double padding', () => {
    expect(toBase64(enc('M'))).toBe('TQ==');
  });
});

describe('fromBase64', () => {
  it('decodes to the original bytes', () => {
    expect(Array.from(fromBase64('TWFu'))).toEqual([77, 97, 110]);
  });

  it('decodes single-padded input', () => {
    expect(Array.from(fromBase64('TWE='))).toEqual([77, 97]);
  });
});

describe('base64 round trip', () => {
  it('preserves arbitrary byte values including 0 and 255', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
