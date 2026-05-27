import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createRecordSnapshot, groupByType } from './capture-snapshot';
import type { StoredEntry } from './contracts';

const rec = (type: FileType, timestamp: number, serialized = '{}'): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

describe('groupByType', () => {
  it('groups records by file type, preserving order within a type', () => {
    const a = rec('log', 1);
    const b = rec('network', 2);
    const c = rec('log', 3);
    expect(groupByType([a, b, c])).toEqual(
      new Map([
        ['log', [a, c]],
        ['network', [b]],
      ]),
    );
  });

  it('returns an empty map for no records', () => {
    expect(groupByType([]).size).toBe(0);
  });
});

describe('createRecordSnapshot', () => {
  it('streams the records one-by-one in order', async () => {
    const snap = createRecordSnapshot([rec('log', 1), rec('network', 2)]);
    const seen: string[] = [];
    for await (const r of snap.stream()) {
      seen.push(`${r.type}:${r.timestamp}`);
    }
    expect(seen).toEqual(['log:1', 'network:2']);
  });

  it('drainAll groups by file type', async () => {
    const snap = createRecordSnapshot([rec('log', 1), rec('log', 2), rec('network', 3)]);
    const map = await snap.drainAll();
    expect(map.get('log')?.map((e) => e.timestamp)).toEqual([1, 2]);
    expect(map.get('network')?.map((e) => e.timestamp)).toEqual([3]);
  });

  it('release() empties the snapshot', async () => {
    const snap = createRecordSnapshot([rec('log', 1)]);
    snap.release();
    expect((await snap.drainAll()).size).toBe(0);
    const seen: unknown[] = [];
    for await (const r of snap.stream()) {
      seen.push(r);
    }
    expect(seen).toEqual([]);
  });
});
