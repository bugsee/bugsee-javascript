import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeSha256Fallback, nodeSha256Hex } from './sha256';

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** The WebCrypto digest @bugsee/util's `sha256Hex` uses — the reference the node digest must agree with. */
async function webCryptoHex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Buffer.from(digest).toString('hex');
}

describe('nodeSha256Hex', () => {
  it('matches the FIPS 180-2 "abc" vector', async () => {
    expect(await nodeSha256Hex(new TextEncoder().encode('abc'))).toBe(ABC);
  });

  it('hashes the empty body', async () => {
    expect(await nodeSha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes multi-byte UTF-8 and every binary byte value identically to WebCrypto', async () => {
    const multibyte = new TextEncoder().encode('😀 multibyte ✓');
    expect(await nodeSha256Hex(multibyte)).toBe(
      'fa340bacb83951bc71394e381142fd3defead8b857e3432e1a39186d0df6cc77',
    );
    expect(await nodeSha256Hex(multibyte)).toBe(await webCryptoHex(multibyte));
    const allBytes = new Uint8Array(256).map((_, i) => i);
    expect(await nodeSha256Hex(allBytes)).toBe(
      '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880',
    );
  });

  it('hashes only the view, not the whole backing buffer of a subarray', async () => {
    // Bundle bodies can be views into a larger buffer; hashing `.buffer` would checksum foreign bytes.
    const backing = new TextEncoder().encode('xxabcxx');
    expect(await nodeSha256Hex(backing.subarray(2, 5))).toBe(ABC);
  });

  it('returns lowercase 64-char hex', async () => {
    expect(await nodeSha256Hex(new Uint8Array([0]))).toMatch(/^[0-9a-f]{64}$/);
  });

  // The differential that used to live in @bugsee/util, between its WebCrypto path and its node:crypto
  // fallback. The two digests are interchangeable by contract: the collector cannot know which one ran.
  it('agrees with WebCrypto on arbitrary binary input (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
        expect(await nodeSha256Hex(bytes)).toBe(await webCryptoHex(bytes));
      }),
      { numRuns: 200 },
    );
  });
});

describe('nodeSha256Fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is undefined when the runtime has WebCrypto subtle — core keeps its single WebCrypto path', () => {
    expect(nodeSha256Fallback({ crypto: { subtle: {} } })).toBeUndefined();
  });

  it('is the node:crypto digest when the runtime has no global crypto (Node 18 unflagged)', () => {
    expect(nodeSha256Fallback({})).toBe(nodeSha256Hex);
    expect(nodeSha256Fallback({ crypto: undefined })).toBe(nodeSha256Hex);
  });

  it('is the node:crypto digest when global crypto exists but lacks subtle', () => {
    expect(nodeSha256Fallback({ crypto: {} })).toBe(nodeSha256Hex);
  });

  it('probes the real globalThis by default', () => {
    expect(nodeSha256Fallback()).toBeUndefined(); // this Node has WebCrypto
    vi.stubGlobal('crypto', undefined);
    expect(nodeSha256Fallback()).toBe(nodeSha256Hex);
  });
});
