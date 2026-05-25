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

  it('falls back to node:crypto when global crypto.subtle is unavailable (Node 18 baseline)', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
