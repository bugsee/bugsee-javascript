import type { StreamingCaptureEntry } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { decodeStreamEntry, encodeStreamEntry } from './protocol';

const streamEntry = (over: Partial<StreamingCaptureEntry> = {}): StreamingCaptureEntry => ({
  type: 'network' as StreamingCaptureEntry['type'],
  seq: 7,
  timestamp: 1000,
  mono: 12.5,
  timeOrigin: 999,
  redacted: false,
  payload: '{"url":"x"}',
  ...over,
});

describe('encodeStreamEntry', () => {
  it('produces a valid JSON envelope with the payload spliced in verbatim (not double-escaped)', () => {
    const raw = encodeStreamEntry(streamEntry());
    const parsed = JSON.parse(raw);
    expect(parsed.k).toBe('entry');
    expect(parsed.t).toBe('network');
    expect(parsed.s).toBe(7);
    expect(parsed.ts).toBe(1000);
    expect(parsed.mono).toBe(12.5);
    expect(parsed.o).toBe(999);
    expect(parsed.red).toBe(false);
    expect(parsed.p).toEqual({ url: 'x' }); // spliced as a JSON object, not a string
  });
});

describe('decodeStreamEntry', () => {
  it('round-trips an encoded entry (payload re-serialized for StoredEntry.serialized)', () => {
    const decoded = decodeStreamEntry(encodeStreamEntry(streamEntry({ redacted: true })));
    expect(decoded).toEqual({
      type: 'network',
      seq: 7,
      timestamp: 1000,
      mono: 12.5,
      timeOrigin: 999,
      redacted: true,
      payload: '{"url":"x"}',
    });
  });

  it('returns undefined for invalid JSON', () => {
    expect(decodeStreamEntry('<<not json>>')).toBeUndefined();
  });

  it('returns undefined for a non-entry message or one missing the type', () => {
    expect(decodeStreamEntry(JSON.stringify({ k: 'control' }))).toBeUndefined();
    expect(decodeStreamEntry(JSON.stringify({ k: 'entry' }))).toBeUndefined();
    // a non-entry kind is rejected even when it carries a `t` (the kind, not just the type, must match)
    expect(decodeStreamEntry(JSON.stringify({ k: 'control', t: 'log', p: {} }))).toBeUndefined();
  });

  it('defaults absent numeric/flag fields', () => {
    const decoded = decodeStreamEntry(JSON.stringify({ k: 'entry', t: 'log', p: { m: 1 } }));
    expect(decoded).toMatchObject({
      type: 'log',
      seq: 0,
      timestamp: 0,
      mono: 0,
      timeOrigin: 0,
      redacted: false,
    });
  });
});
