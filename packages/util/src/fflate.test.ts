import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from './fflate';

// Integration test across the @bugsee/util -> fflate boundary (standards §3): the round-trips
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
