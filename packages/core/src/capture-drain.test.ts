import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { drainReified } from './capture-drain';
import { defaultEntryFactory } from './capture-data-entry';
import type { CaptureEntryFactory, CaptureSnapshot, StoredEntry } from './contracts';

/** A fake snapshot over a fixed grouped record set that records its release. */
function fakeSnapshot(
  grouped: Map<FileType, StoredEntry[]>,
): CaptureSnapshot & { released: boolean } {
  const snap = {
    released: false,
    drainAll: () => Promise.resolve(grouped),
    stream: async function* () {},
    release() {
      snap.released = true;
    },
  } as CaptureSnapshot & { released: boolean };
  return snap;
}

/** A stored record whose `serialized` carries a real `{timestamp, data}` envelope (the base entry codec). */
function stored(type: FileType, data: unknown): StoredEntry {
  return { type, timestamp: 1, serialized: JSON.stringify({ timestamp: 1, data }) } as StoredEntry;
}

/** A stored record whose serialized payload is deliberately un-parseable (a torn trailing frame). */
function tornStored(type: FileType): StoredEntry {
  return { type, timestamp: 1, serialized: 'NOT-JSON' } as StoredEntry;
}

describe('drainReified', () => {
  it('reifies each stored record via the factory, grouped by file type', async () => {
    const grouped = new Map<FileType, StoredEntry[]>([
      ['log', [stored('log', { m: 1 }), stored('log', { m: 2 })]],
      ['network', [stored('network', { u: '/a' })]],
    ]);
    const snap = fakeSnapshot(grouped);

    const out = await drainReified(snap, defaultEntryFactory, () => {});

    expect(out.get('log')?.map((e) => e.data)).toEqual([{ m: 1 }, { m: 2 }]);
    expect(out.get('network')?.map((e) => e.data)).toEqual([{ u: '/a' }]);
  });

  it('releases the snapshot even when draining succeeds', async () => {
    const snap = fakeSnapshot(new Map());
    await drainReified(snap, defaultEntryFactory, () => {});
    expect(snap.released).toBe(true);
  });

  it('skips a torn record (routes to onError) but keeps the rest of the group', async () => {
    const grouped = new Map<FileType, StoredEntry[]>([
      ['log', [stored('log', { m: 1 }), tornStored('log'), stored('log', { m: 3 })]],
    ]);
    const onError = vi.fn();

    const out = await drainReified(fakeSnapshot(grouped), defaultEntryFactory, onError);

    expect(out.get('log')?.map((e) => e.data)).toEqual([{ m: 1 }, { m: 3 }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('releases the snapshot even if drainAll rejects', async () => {
    const snap = {
      released: false,
      drainAll: () => Promise.reject(new Error('boom')),
      stream: async function* () {},
      release() {
        (snap as { released: boolean }).released = true;
      },
    } as unknown as CaptureSnapshot & { released: boolean };

    await expect(drainReified(snap, defaultEntryFactory, () => {})).rejects.toThrow('boom');
    expect(snap.released).toBe(true);
  });

  it('uses the provided factory for every record (custom factory observed)', async () => {
    const factory: CaptureEntryFactory = vi.fn(defaultEntryFactory);
    const grouped = new Map<FileType, StoredEntry[]>([['log', [stored('log', { m: 1 })]]]);
    await drainReified(fakeSnapshot(grouped), factory, () => {});
    expect(factory).toHaveBeenCalledWith('log');
  });
});
