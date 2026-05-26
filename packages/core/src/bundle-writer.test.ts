import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { writeBundleZip } from './bundle-writer';

describe('writeBundleZip', () => {
  it('returns a Uint8Array', () => {
    expect(writeBundleZip([{ name: 'a.txt', data: 'hi' }])).toBeInstanceOf(Uint8Array);
  });

  it('round-trips a single string file as UTF-8', () => {
    const zip = writeBundleZip([{ name: 'request.json', data: '{"ok":true}' }]);
    const out = unzipSync(zip);
    expect(Object.keys(out)).toEqual(['request.json']);
    expect(strFromU8(out['request.json'] as Uint8Array)).toBe('{"ok":true}');
  });

  it('UTF-8 encodes non-ASCII string content', () => {
    const zip = writeBundleZip([{ name: 'n.txt', data: 'café — 日本' }]);
    expect(strFromU8(unzipSync(zip)['n.txt'] as Uint8Array)).toBe('café — 日本');
  });

  it('stores Uint8Array content byte-for-byte', () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 42]);
    const zip = writeBundleZip([{ name: 'replay.bin', data: bytes }]);
    expect(Array.from(unzipSync(zip)['replay.bin'] as Uint8Array)).toEqual([0, 255, 13, 10, 42]);
  });

  it('packs multiple mixed files, preserving every entry', () => {
    const zip = writeBundleZip([
      { name: 'request.json', data: '{"a":1}' },
      { name: 'manifest.json', data: '{"version":2}' },
      { name: 'apptoken', data: 'tok_123' },
      { name: 'replay.bin', data: new Uint8Array([1, 2, 3]) },
    ]);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(
      ['apptoken', 'manifest.json', 'replay.bin', 'request.json'].sort(),
    );
    expect(strFromU8(out.apptoken as Uint8Array)).toBe('tok_123');
    expect(Array.from(out['replay.bin'] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('produces a valid empty zip for no files', () => {
    const out = unzipSync(writeBundleZip([]));
    expect(Object.keys(out)).toEqual([]);
  });

  it('throws on a duplicate file name', () => {
    expect(() =>
      writeBundleZip([
        { name: 'dup.json', data: 'a' },
        { name: 'dup.json', data: 'b' },
      ]),
    ).toThrow(/duplicate file name: dup\.json/);
  });

  it('rejects a "__proto__" file name (unsupportable by the zip writer) without polluting', () => {
    expect(() => writeBundleZip([{ name: '__proto__', data: 'x' }])).toThrow(/__proto__/);
    // the prototype stays intact regardless
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).x).toBeUndefined();
  });
});
