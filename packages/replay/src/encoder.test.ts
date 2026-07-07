import { gunzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodeReplay } from './encoder';

/** Decode a replay.bin back to the rrweb event array (what the dashboard player does). */
function decode(bytes: Uint8Array): unknown {
  return JSON.parse(strFromU8(gunzipSync(bytes)));
}

describe('encodeReplay', () => {
  it('gzips the rrweb event stream (replay.bin) and round-trips back to the events', () => {
    const events = [
      { type: 2, data: { node: 'full-snapshot' }, timestamp: 1000 },
      { type: 3, data: { source: 0 }, timestamp: 1016 },
    ];
    const bytes = encodeReplay(events);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decode(bytes)).toEqual(events); // gunzip → JSON.parse recovers the exact stream
  });

  it('emits a real gzip stream (magic bytes 0x1f 0x8b)', () => {
    const bytes = encodeReplay([{ type: 4 }]);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it('compresses (repetitive events → output smaller than the raw JSON)', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      type: 3,
      data: { x: i % 5 },
      timestamp: i,
    }));
    const bytes = encodeReplay(events);
    const raw = JSON.stringify(events).length;
    expect(bytes.length).toBeLessThan(raw);
  });

  it('handles an empty stream (valid gzip of [])', () => {
    expect(decode(encodeReplay([]))).toEqual([]);
  });
});
