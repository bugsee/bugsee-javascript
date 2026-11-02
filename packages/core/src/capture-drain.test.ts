import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { defaultEntryFactory } from './capture-data-entry';
import { drainReified, streamReified } from './capture-drain';
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

/** A fake snapshot whose `stream()` serves the records one by one and counts releases. */
function streamingSnapshot(
  records: StoredEntry[],
  range?: { start: number; end: number },
): CaptureSnapshot & { releases: number } {
  const snap = {
    releases: 0,
    drainAll: () => Promise.resolve(new Map()),
    stream: async function* () {
      yield* records;
    },
    release() {
      snap.releases += 1;
    },
    ...(range !== undefined ? { timeRange: () => range } : {}),
  } as CaptureSnapshot & { releases: number };
  return snap;
}

describe('streamReified', () => {
  it('yields the reified entries in store order and releases the snapshot once it is read through', async () => {
    const snap = streamingSnapshot([stored('log', { m: 1 }), stored('network', { u: '/a' })]);
    const seen: unknown[] = [];
    for await (const entry of streamReified(snap, defaultEntryFactory, () => {})) {
      seen.push([entry.type, entry.data]);
    }
    expect(seen).toEqual([
      ['log', { m: 1 }],
      ['network', { u: '/a' }],
    ]);
    expect(snap.releases).toBe(1);
  });

  it('skips a torn record, reporting it, and keeps the rest', async () => {
    const snap = streamingSnapshot([
      stored('log', { m: 1 }),
      tornStored('log'),
      stored('log', { m: 3 }),
    ]);
    const onError = vi.fn();
    const data: unknown[] = [];
    for await (const entry of streamReified(snap, defaultEntryFactory, onError)) {
      data.push(entry.data);
    }
    expect(data).toEqual([{ m: 1 }, { m: 3 }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('exposes the snapshot time range when the snapshot has one, and none otherwise', () => {
    const range = { start: 5, end: 9 };
    expect(
      streamReified(streamingSnapshot([], range), defaultEntryFactory, () => {}).timeRange,
    ).toEqual(range);
    expect('timeRange' in streamReified(streamingSnapshot([]), defaultEntryFactory, () => {})).toBe(
      false,
    );
  });

  it('releases a snapshot that is abandoned before it was ever read, once', async () => {
    const snap = streamingSnapshot([stored('log', { m: 1 })]);
    const stream = streamReified(snap, defaultEntryFactory, () => {});
    await stream.return?.();
    await stream.return?.();
    expect(snap.releases).toBe(1);
  });

  it('releases the snapshot when a consumer throws into the stream', async () => {
    const snap = streamingSnapshot([stored('log', { m: 1 })]);
    const stream = streamReified(snap, defaultEntryFactory, () => {});
    await expect(stream.throw?.(new Error('stop'))).rejects.toThrow('stop');
    expect(snap.releases).toBe(1);
  });
});

describe('reified entries carry their visual source lane', () => {
  const withLane = (lane?: string): StoredEntry => ({
    ...stored('replay', { e: 1 }),
    ...(lane !== undefined ? { lane } : {}),
  });

  it('streamReified sets the lane of a laned record and leaves an unlaned one without', async () => {
    const snap = streamingSnapshot([withLane('win-3'), withLane()]);
    const lanes: Array<string | undefined> = [];
    for await (const entry of streamReified(snap, defaultEntryFactory, () => {})) {
      lanes.push(entry.lane);
    }
    expect(lanes).toEqual(['win-3', undefined]);
  });

  it('drainReified does the same', async () => {
    const grouped = new Map<FileType, StoredEntry[]>([['replay', [withLane('win-3'), withLane()]]]);
    const entries = (await drainReified(fakeSnapshot(grouped), defaultEntryFactory, () => {})).get(
      'replay',
    );
    expect(entries?.map((e) => e.lane)).toEqual(['win-3', undefined]);
  });
});
