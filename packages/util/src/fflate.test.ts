import { describe, expect, it } from 'vitest';
import {
  gunzipSync,
  gzipSync,
  strFromU8,
  strToU8,
  unzipSync,
  Zip,
  ZipDeflate,
  zipSync,
} from './fflate';

// Integration test across the @bugsee/util -> fflate boundary: the round-trips
// fail if any re-exported binding is wrong or missing.
describe('fflate re-export', () => {
  it('round-trips gzip', () => {
    const data = strToU8('hello bugsee');
    expect(strFromU8(gunzipSync(gzipSync(data)))).toBe('hello bugsee');
  });

  it('round-trips a zip archive', () => {
    const zipped = zipSync({ 'a.txt': strToU8('content') });
    const out = unzipSync(zipped);
    expect(strFromU8(out['a.txt'] ?? new Uint8Array())).toBe('content');
  });
});

describe('streaming zip (the export path depends on this fflate behaviour)', () => {
  it('accepts pushes to several members in INTERLEAVED order and still writes a valid archive', () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, data) => {
      if (error) throw error;
      chunks.push(data);
    });
    const a = new ZipDeflate('a.json');
    const b = new ZipDeflate('b.json');
    zip.add(a);
    zip.add(b);
    b.push(strToU8('B1'), false); // the later member is pushed first
    a.push(strToU8('A1'), false);
    b.push(strToU8('B2'), true);
    a.push(strToU8('A2'), true);
    zip.end();
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    const files = unzipSync(out);
    expect(strFromU8(files['a.json'] as Uint8Array)).toBe('A1A2');
    expect(strFromU8(files['b.json'] as Uint8Array)).toBe('B1B2');
  });
});
