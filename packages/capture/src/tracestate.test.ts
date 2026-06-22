import { describe, expect, it } from 'vitest';
import {
  type BugseeTraceState,
  decodeBugseeState,
  encodeBugseeState,
  parseTracestate,
  serializeTracestate,
  setTracestateEntry,
} from './tracestate';

describe('parseTracestate', () => {
  it('parses a comma-separated list, preserving order', () => {
    expect(parseTracestate('foo=1,bar=2,bugsee=r1')).toEqual([
      { key: 'foo', value: '1' },
      { key: 'bar', value: '2' },
      { key: 'bugsee', value: 'r1' },
    ]);
  });

  it('trims optional whitespace around members (W3C OWS)', () => {
    expect(parseTracestate('  foo=1 , bar=2 ')).toEqual([
      { key: 'foo', value: '1' },
      { key: 'bar', value: '2' },
    ]);
  });

  it('splits each member on the FIRST = only (values may contain nothing illegal, key is before)', () => {
    // a value with no '=' is the norm; the key is everything before the first '='.
    expect(parseTracestate('vendor=a:b:c')).toEqual([{ key: 'vendor', value: 'a:b:c' }]);
  });

  it('skips malformed members (no =, empty key, empty value) without throwing', () => {
    expect(parseTracestate('foo=1,garbage,=novalue,nokey=,bar=2')).toEqual([
      { key: 'foo', value: '1' },
      { key: 'bar', value: '2' },
    ]);
  });

  it('dedupes by key, keeping the FIRST occurrence (most-recent-first wins)', () => {
    expect(parseTracestate('bugsee=new,foo=1,bugsee=old')).toEqual([
      { key: 'bugsee', value: 'new' },
      { key: 'foo', value: '1' },
    ]);
  });

  it('caps at 32 entries (drops the excess oldest)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `k${i}=v${i}`).join(',');
    const parsed = parseTracestate(many);
    expect(parsed).toHaveLength(32);
    expect(parsed[0]).toEqual({ key: 'k0', value: 'v0' });
    expect(parsed[31]).toEqual({ key: 'k31', value: 'v31' });
  });

  it('returns [] for undefined / empty / whitespace', () => {
    expect(parseTracestate(undefined)).toEqual([]);
    expect(parseTracestate('')).toEqual([]);
    expect(parseTracestate('   ')).toEqual([]);
  });
});

describe('serializeTracestate', () => {
  it('joins key=value members with commas', () => {
    expect(
      serializeTracestate([
        { key: 'bugsee', value: 'r1' },
        { key: 'foo', value: '1' },
      ]),
    ).toBe('bugsee=r1,foo=1');
  });

  it('round-trips with parseTracestate', () => {
    const header = 'bugsee=r1:sabc,vendor=xyz';
    expect(serializeTracestate(parseTracestate(header))).toBe(header);
  });

  it('serializes [] to an empty string', () => {
    expect(serializeTracestate([])).toBe('');
  });
});

describe('setTracestateEntry', () => {
  it('prepends a new vendor entry (most-recent-first)', () => {
    expect(setTracestateEntry([{ key: 'foo', value: '1' }], 'bugsee', 'r1')).toEqual([
      { key: 'bugsee', value: 'r1' },
      { key: 'foo', value: '1' },
    ]);
  });

  it('REPLACES an existing entry for the key AND moves it to the front', () => {
    expect(
      setTracestateEntry(
        [
          { key: 'foo', value: '1' },
          { key: 'bugsee', value: 'old' },
          { key: 'bar', value: '2' },
        ],
        'bugsee',
        'new',
      ),
    ).toEqual([
      { key: 'bugsee', value: 'new' },
      { key: 'foo', value: '1' },
      { key: 'bar', value: '2' },
    ]);
  });

  it('caps at 32 entries, dropping the oldest (the new entry is always kept)', () => {
    const full = Array.from({ length: 32 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    const out = setTracestateEntry(full, 'bugsee', 'r1');
    expect(out).toHaveLength(32);
    expect(out[0]).toEqual({ key: 'bugsee', value: 'r1' }); // kept, at the front
    expect(out.some((e) => e.key === 'k31')).toBe(false); // the oldest was dropped
  });

  it('caps the SERIALIZED header at 512 bytes (Profile v1 §12), dropping oldest but keeping ours', () => {
    // 14 entries × ~46 bytes ≈ 640 bytes > 512 (well under the 32-entry cap, so this exercises the byte cap).
    const big = Array.from({ length: 14 }, (_, i) => ({ key: `key${i}`, value: 'v'.repeat(40) }));
    const out = setTracestateEntry(big, 'bugsee', 'r1');
    expect(serializeTracestate(out).length).toBeLessThanOrEqual(512);
    expect(out[0]).toEqual({ key: 'bugsee', value: 'r1' }); // ours kept at the front
    expect(out.length).toBeLessThan(15); // oldest dropped to fit the byte cap
    expect(out.length).toBeGreaterThan(1); // but not over-pruned
  });

  it('keeps OUR own front entry intact even when it ALONE exceeds 512 bytes (the >1 guard never empties to [])', () => {
    // A pathological single bugsee= value larger than the whole 512-byte budget: the byte-cap loop must STOP
    // at length 1 (the `next.length > 1` guard) rather than drop our own front entry, leaving [].
    const huge = `r1:s${'a'.repeat(600)}`;
    const out = setTracestateEntry([], 'bugsee', huge);
    expect(out).toEqual([{ key: 'bugsee', value: huge }]); // exactly our one entry — NOT emptied
  });
});

describe('encodeBugseeState / decodeBugseeState', () => {
  const round = (s: BugseeTraceState) => decodeBugseeState(encodeBugseeState(s));

  it('encodes the record flag (r1 / r0)', () => {
    expect(encodeBugseeState({ record: true })).toBe('r1');
    expect(encodeBugseeState({ record: false })).toBe('r0');
  });

  it('encodes the session-correlation id (s<id>)', () => {
    expect(encodeBugseeState({ sessionId: 'abc123' })).toBe('sabc123');
  });

  it('encodes both fields in order: r then s', () => {
    expect(encodeBugseeState({ record: true, sessionId: 'abc' })).toBe('r1:sabc');
  });

  it('omits absent fields (empty state → empty string)', () => {
    expect(encodeBugseeState({})).toBe('');
  });

  it('round-trips record + sessionId', () => {
    expect(round({ record: true, sessionId: 'deadbeef' })).toEqual({
      record: true,
      sessionId: 'deadbeef',
    });
    expect(round({ record: false })).toEqual({ record: false });
    expect(round({ sessionId: 'x' })).toEqual({ sessionId: 'x' });
  });

  it('decodes defensively: ignores unknown fields, tolerates empties', () => {
    expect(decodeBugseeState('r1:zsomething:sabc')).toEqual({ record: true, sessionId: 'abc' });
    expect(decodeBugseeState('')).toEqual({});
    expect(decodeBugseeState('r')).toEqual({ record: false }); // 'r' with no '1' → not recording
  });
});
