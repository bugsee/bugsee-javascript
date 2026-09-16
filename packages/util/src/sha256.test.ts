import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './sha256';

// FIPS 180-2 / RFC test vectors.
describe('sha256Hex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hashes a string ("abc" vector)', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes raw bytes identically to the equivalent string', async () => {
    expect(await sha256Hex(new Uint8Array([97, 98, 99]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('encodes a string as UTF-8 before hashing (multi-byte input)', async () => {
    // "é" is U+00E9: UTF-8 bytes C3 A9. A Latin-1 encoding would hash the single byte E9 instead.
    const utf8 = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c';
    expect(await sha256Hex('\u00e9')).toBe(utf8);
    expect(await sha256Hex(new Uint8Array([0xc3, 0xa9]))).toBe(utf8);
  });

  it('hashes every byte value 0x00-0xff (binary input)', async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(await sha256Hex(bytes)).toBe(
      '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880',
    );
  });

  it('zero-pads every byte to two hex digits', async () => {
    // sha256("abc") contains the bytes 0x01 ("8f01"), 0x03 ("b003") and 0x00 ("f200"); dropping the pad shortens it.
    const hex = await sha256Hex('abc');
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes through the global WebCrypto subtle.digest with SHA-256', async () => {
    const real = (
      globalThis as unknown as {
        crypto: { subtle: { digest(a: string, d: Uint8Array): Promise<ArrayBuffer> } };
      }
    ).crypto.subtle;
    const digest = vi.fn((algorithm: string, data: Uint8Array) => real.digest(algorithm, data));
    vi.stubGlobal('crypto', { subtle: { digest } });
    const bytes = new Uint8Array([1, 2, 3]);
    await sha256Hex(bytes);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledWith('SHA-256', bytes);
  });

  // No fallback: @bugsee/util is tier-0 and reachable from every browser/edge bundle, so it must not name
  // `node:crypto` in any form. A runtime without WebCrypto (Node 18 unflagged) gets its digest injected by
  // the platform (@bugsee/node → core's upload-pipeline `sha256` seam); here it is a defined rejection.
  it('rejects with a clear error when there is no global crypto (no node:crypto fallback)', async () => {
    vi.stubGlobal('crypto', undefined);
    await expect(sha256Hex('abc')).rejects.toThrow(
      /SHA-256 unavailable: this runtime has no WebCrypto `crypto\.subtle`/,
    );
  });

  it('rejects with the same error when global crypto exists but lacks subtle (insecure context)', async () => {
    vi.stubGlobal('crypto', {});
    const error = await sha256Hex(new Uint8Array([97])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('NotSupportedError');
    expect((error as Error).message).toMatch(/crypto\.subtle/);
  });

  it('rejects rather than throwing synchronously when subtle is absent', () => {
    vi.stubGlobal('crypto', undefined);
    let result: Promise<string> | undefined;
    expect(() => {
      result = sha256Hex('abc');
    }).not.toThrow();
    return expect(result).rejects.toBeInstanceOf(Error);
  });
});
