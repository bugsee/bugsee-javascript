import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { FrozenPart } from './chunk-backend';
import { createChunkCaptureStore } from './chunk-capture-store';
import type { Clock } from './clock';
import type { StoredEntry } from './contracts';
import { createMemoryChunkBackend } from './memory-chunk-backend';

// These pin the STORE → BACKEND protocol (durable metadata effects the memory store's own public API
// doesn't observe): part opening, closePart on tick, removePart on eviction, removeGeneration on clear.
// The store's observable capture behavior is covered by memory-capture-store.test.ts.

const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });
const recBytes = (bytes: number, type: FileType = 'log'): StoredEntry => ({
  type,
  timestamp: 0,
  serialized: 'x'.repeat(bytes),
});

describe('createChunkCaptureStore — backend protocol', () => {
  it('opens part 0 at the clock time on construction', async () => {
    const backend = createMemoryChunkBackend();
    createChunkCaptureStore(backend, { clock: clockAt(1000) });
    expect(await backend.listParts(0)).toEqual([
      { generation: 0, number: 0, start: 1000, end: undefined, byteSize: 0 },
    ]);
  });

  it('closes the current part (end + byteSize) and opens a fresh one on tick', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, { clock: clockAt(1000) });
    store.add(recBytes(5));
    store.tick(2000);
    expect(await backend.listParts(0)).toEqual([
      { generation: 0, number: 0, start: 1000, end: 2000, byteSize: 5 },
      { generation: 0, number: 1, start: 2000, end: undefined, byteSize: 0 },
    ]);
  });

  it('removes a time-evicted part from the backend', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, {
      clock: clockAt(10_000),
      maxRecordingTimeMs: 2000,
    });
    store.add(recBytes(5)); // part 0
    store.tick(11_000); // part 0 closes @11000
    store.tick(15_000); // cutting 12000 → part 0 (end 11000) evicted → removePart
    expect((await backend.listParts(0)).map((p) => p.number)).toEqual([1, 2]); // part 0 gone
  });

  describe('anchored time eviction', () => {
    // One replay record per second labelled by that second; `anchorAt` lists the seconds that open a base.
    // Returns the first second whose replay record is still held after `nowS` seconds with a 2 s window.
    async function firstKeptSecond(anchorAt: number[], nowS: number): Promise<number | undefined> {
      const store = createChunkCaptureStore(createMemoryChunkBackend(), {
        clock: clockAt(0),
        maxRecordingTimeMs: 2000,
      });
      for (let s = 0; s < nowS; s++) {
        store.add({
          type: 'replay',
          timestamp: s * 1000,
          serialized: `s${s}`,
          ...(anchorAt.includes(s) ? { anchor: true } : {}),
        });
        store.tick((s + 1) * 1000);
      }
      const replay = (await store.snapshot().drainAll()).get('replay') ?? [];
      return replay.length === 0 ? undefined : Number(replay[0]?.serialized.slice(1));
    }

    it('keeps the only anchor part past the window instead of evicting it', async () => {
      expect(await firstKeptSecond([0], 10)).toBe(0); // window start = 8000; second 0 is the base
    });

    it('evicts everything older than the newest anchor at or before the window start', async () => {
      expect(await firstKeptSecond([0, 5], 10)).toBe(5); // anchor@5 (5000 <= 8000) supersedes anchor@0
    });

    it('treats an anchor that starts exactly at the window start as the base', async () => {
      // anchor@8 starts at 8000 == window start, so second 0 is no longer needed. Plain time eviction still keeps
      // one part of slack (cutting = 7000), hence the first kept second is 6, not 8; a `<` boundary would keep 0.
      expect(await firstKeptSecond([0, 8], 10)).toBe(6);
    });

    it('keeps an older anchor while the newer one is still inside the window', async () => {
      expect(await firstKeptSecond([0, 9], 10)).toBe(0); // anchor@9 starts at 9000 > 8000: seconds 8.. need the base at 0
    });

    it('evicts exactly as before when no anchor was ever recorded', async () => {
      expect(await firstKeptSecond([], 10)).toBe(6); // cutting 7000 keeps one part of slack
    });
  });

  describe('byte cap sheds the visual lane (replay) before the data lane', () => {
    // A labelled record of exactly `bytes` serialized bytes, so a test can tell WHICH records survived.
    const rec = (type: FileType, label: string, bytes: number, anchor = false): StoredEntry => ({
      type,
      timestamp: 0,
      serialized: label.padEnd(bytes, '.'),
      ...(anchor ? { anchor: true } : {}),
    });
    const labels = async (store: ReturnType<typeof createChunkCaptureStore>, type: FileType) =>
      ((await store.snapshot().drainAll()).get(type) ?? []).map((e) =>
        e.serialized.replace(/\.+$/, ''),
      );
    const mk = (cap: number, onVisualReset?: () => void) =>
      createChunkCaptureStore(createMemoryChunkBackend(), {
        clock: clockAt(0),
        maxRecordingTimeMs: 1_000_000,
        maxDataSizeBytes: cap,
        ...(onVisualReset !== undefined ? { onVisualReset } : {}),
      });

    it('drops the oldest base segment of the replay and keeps every log', async () => {
      const store = mk(100);
      store.add(rec('log', 'L0', 10));
      store.add(rec('replay', 'A0', 30, true));
      store.tick(1000);
      store.add(rec('log', 'L1', 10));
      store.add(rec('replay', 'I1', 30));
      store.tick(2000);
      store.add(rec('log', 'L2', 10));
      store.add(rec('replay', 'A2', 30, true));
      store.tick(3000);
      store.add(rec('log', 'L3', 10));
      store.add(rec('replay', 'I3', 30)); // 160 bytes > 100: the segment A0+I1 (60) goes, never a log
      expect(await labels(store, 'log')).toEqual(['L0', 'L1', 'L2', 'L3']);
      expect(await labels(store, 'replay')).toEqual(['A2', 'I3']);
    });

    it('sheds replay records that precede the first base before anything else', async () => {
      const store = mk(100);
      store.add(rec('replay', 'O0', 40)); // an orphan: no base before it
      store.tick(1000);
      store.add(rec('replay', 'A1', 30, true));
      store.tick(2000);
      store.add(rec('log', 'L2', 10));
      store.add(rec('replay', 'I2', 30)); // 110 > 100 → the orphan (40) is shed, the base stays
      expect(await labels(store, 'replay')).toEqual(['A1', 'I2']);
      expect(await labels(store, 'log')).toEqual(['L2']);
    });

    it('drops the whole replay (and asks for a fresh base) when one base segment alone exceeds the cap', async () => {
      const reset = vi.fn();
      const store = mk(100, reset);
      store.add(rec('replay', 'A0', 60, true));
      store.tick(1000);
      store.add(rec('log', 'L1', 20));
      store.add(rec('replay', 'I1', 40)); // 120 > 100 and only one segment: nothing valid to keep
      store.tick(2000);
      store.add(rec('log', 'L2', 20));
      expect(await labels(store, 'log')).toEqual(['L1', 'L2']);
      // The base is gone; the incremental that depended on it is still in the open part until a fresh base arrives
      // (export trims leading records that precede a base), so the store makes no claim beyond "no A0".
      expect(await labels(store, 'replay')).toEqual(['I1']);
      expect(reset).toHaveBeenCalledTimes(1);
    });

    it('evicts the oldest data parts only once there is no replay left to shed', async () => {
      const store = mk(30);
      store.add(rec('log', 'L0', 20));
      store.tick(1000);
      store.add(rec('log', 'L1', 20)); // logs alone: 40 > 30 → the oldest closed data part goes
      expect(await labels(store, 'log')).toEqual(['L1']);
    });

    it('drops only the oldest segment when a newer base is already closed, and asks for no reset', async () => {
      const reset = vi.fn();
      const store = mk(100, reset);
      store.add(rec('replay', 'A0', 30, true));
      store.tick(1000);
      store.add(rec('replay', 'A1', 30, true));
      store.tick(2000);
      store.add(rec('log', 'L2', 50)); // 110 > 100 → only the segment before the next base (A0) goes
      await Promise.resolve();
      await Promise.resolve();
      expect(await labels(store, 'replay')).toEqual(['A1']);
      expect(reset).not.toHaveBeenCalled();
    });

    it('never sheds the open visual part, even when it alone exceeds the cap', async () => {
      const store = mk(50);
      store.add(rec('replay', 'A0', 60, true)); // still open: not eligible
      expect(await labels(store, 'replay')).toEqual(['A0']);
    });

    it('keeps every closed log when the excess is the OPEN replay part (evicting logs could not make room)', async () => {
      const store = mk(100);
      store.add(rec('log', 'L0', 20));
      store.tick(1000);
      store.add(rec('log', 'L1', 20));
      store.tick(2000);
      store.add(rec('replay', 'A2', 150, true)); // one second of replay bigger than the whole cap, still open
      expect(await labels(store, 'log')).toEqual(['L0', 'L1']);
      expect(await labels(store, 'replay')).toEqual(['A2']);
    });

    it('still evicts closed data when doing so does make room', async () => {
      const store = mk(100);
      store.add(rec('log', 'L0', 40));
      store.tick(1000);
      store.add(rec('log', 'L1', 40));
      store.tick(2000);
      store.add(rec('replay', 'A2', 60, true)); // 140 > 100; dropping L0 (40) fits
      expect(await labels(store, 'log')).toEqual(['L1']);
    });

    it('swallows a throwing onVisualReset (a host callback must never break capture)', async () => {
      const store = mk(100, () => {
        throw new Error('host');
      });
      store.add(rec('replay', 'A0', 60, true));
      store.tick(1000);
      store.add(rec('log', 'L1', 60)); // sheds the lone base: reset fires and throws
      await Promise.resolve();
      await Promise.resolve();
      expect(await labels(store, 'log')).toEqual(['L1']);
    });

    it('closes the visual part with the tick end and its own byte size, opened at the data part start', async () => {
      const backend = createMemoryChunkBackend();
      const store = createChunkCaptureStore(backend, { clock: clockAt(1000) });
      store.add(rec('replay', 'A0', 30, true));
      store.add(rec('log', 'L0', 10));
      store.tick(2000);
      expect(await backend.listParts(0)).toEqual([
        { generation: 0, number: 0, start: 1000, end: 2000, byteSize: 10 },
        { generation: 0, number: 1, start: 1000, end: 2000, byteSize: 30 },
        { generation: 0, number: 2, start: 2000, end: undefined, byteSize: 0 },
      ]);
    });

    it('does not let an anchor flag on a data record extend that record past the window', async () => {
      const store = createChunkCaptureStore(createMemoryChunkBackend(), {
        clock: clockAt(0),
        maxRecordingTimeMs: 2000,
      });
      store.add({ type: 'log', timestamp: 0, serialized: 'old', anchor: true });
      for (let s = 1; s <= 10; s++) {
        store.tick(s * 1000);
      }
      expect((await store.snapshot().drainAll()).get('log') ?? []).toEqual([]);
    });

    it('forgets the open visual part on clear', async () => {
      const store = mk(1_000_000);
      store.add(rec('replay', 'A0', 10, true));
      store.clear();
      store.add(rec('replay', 'A1', 10, true));
      expect(await labels(store, 'replay')).toEqual(['A1']);
    });

    it('a store that never sees a visual record behaves exactly as before', async () => {
      const backend = createMemoryChunkBackend();
      const store = createChunkCaptureStore(backend, { clock: clockAt(0), maxDataSizeBytes: 10 });
      store.add(rec('log', 'a', 8));
      store.tick(1000);
      store.add(rec('log', 'b', 8));
      expect((await backend.listParts(0)).map((p) => p.number)).toEqual([1]);
    });
  });

  it('removes a byte-cap-evicted part from the backend', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, { clock: clockAt(0), maxDataSizeBytes: 10 });
    store.add(recBytes(8)); // part 0
    store.tick(1000); // close part 0
    store.add(recBytes(8)); // part 1 → total 16 > 10 → evict part 0 (closed) → removePart
    expect((await backend.listParts(0)).map((p) => p.number)).toEqual([1]); // part 0 gone
  });

  it('removes the whole generation on clear, then opens a fresh part', async () => {
    const backend = createMemoryChunkBackend();
    const store = createChunkCaptureStore(backend, { clock: clockAt(5000) });
    store.add(recBytes(5));
    store.tick(6000); // two parts now
    store.clear();
    // The prior parts (0,1) are removed; a single fresh part remains.
    const parts = await backend.listParts(0);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.end).toBeUndefined();
    expect(parts[0]?.byteSize).toBe(0);
    expect(parts[0]?.start).toBe(5000); // reopened at the clock time
  });
});

// WAVE 6.2 — the flush seam a page-hide needs.
//
// A durable backend keeps `add()` non-blocking by queueing the physical write, which means at any instant
// some records are captured but not yet committed. Node closes that window on `'exit'` and on a signal;
// the browser had nothing at all. The store forwards the backend's flush so a platform can commit at the
// last moment it is alive, and omits it entirely when the backend has no such notion (a memory backend
// has nothing pending, and advertising a flush that does nothing would read as a guarantee).
describe('flush', () => {
  it('delegates to the backend’s flush', async () => {
    const flush = vi.fn(() => Promise.resolve());
    const backend = Object.assign(createMemoryChunkBackend(), { flush });
    const store = createChunkCaptureStore(backend, { clock: clockAt(1000) });
    await store.flush?.();
    expect(flush).toHaveBeenCalled();
  });

  it('is ABSENT when the backend has no flush — no false guarantee', () => {
    const store = createChunkCaptureStore(createMemoryChunkBackend(), { clock: clockAt(1000) });
    expect(store.flush).toBeUndefined();
  });
});

describe('createChunkCaptureStore — snapshot time range', () => {
  const mutableClock = (start: number): { clock: Clock; set: (now: number) => void } => {
    let now = start;
    return { clock: { wallNow: () => now, monotonicNow: () => 0 }, set: (v) => (now = v) };
  };

  it('reports the window ending now when the store has been recording for longer than the window', () => {
    const { clock, set } = mutableClock(1000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 5000,
    });
    set(20_000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 15_000, end: 20_000 });
  });

  it('starts at the store epoch (first part start) while the store is younger than the window', () => {
    const { clock, set } = mutableClock(1000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 60_000,
    });
    set(4000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 1000, end: 4000 });
  });

  it('moves the epoch back to a record stamped before the store started, so the report keeps it (nothing in the window is trimmed)', () => {
    const { clock, set } = mutableClock(10_000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 60_000,
    });
    store.add({ type: 'log', timestamp: 4000, serialized: 'early' }); // e.g. an early-buffered pre-launch log
    store.add({ type: 'log', timestamp: 9000, serialized: 'later' });
    set(12_000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 4000, end: 12_000 });
  });

  it('an old record never pulls the start before the window', () => {
    const { clock, set } = mutableClock(100_000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 5000,
    });
    store.add({ type: 'log', timestamp: 4000, serialized: 'ancient' });
    set(120_000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 115_000, end: 120_000 });
  });

  it('forgets the early record on clear() along with the rest of the epoch', () => {
    const { clock, set } = mutableClock(10_000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 60_000,
    });
    store.add({ type: 'log', timestamp: 4000, serialized: 'early' });
    set(11_000);
    store.clear();
    set(12_000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 11_000, end: 12_000 });
  });

  it('restarts the epoch on clear()', () => {
    const { clock, set } = mutableClock(1000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 60_000,
    });
    set(9000);
    store.clear();
    set(10_000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 9000, end: 10_000 });
  });

  it('never reports start after end when the wall clock steps backwards', () => {
    const { clock, set } = mutableClock(5000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), { clock });
    set(2000);
    expect(store.snapshot().timeRange?.()).toEqual({ start: 2000, end: 2000 });
  });

  it('fixes the range at snapshot time', () => {
    const { clock, set } = mutableClock(1000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 5000,
    });
    set(20_000);
    const snapshot = store.snapshot();
    set(30_000);
    expect(snapshot.timeRange?.()).toEqual({ start: 15_000, end: 20_000 });
  });

  it('keeps the wrapped snapshot working: stream, drainAll, release', async () => {
    const { clock } = mutableClock(1000);
    const store = createChunkCaptureStore(createMemoryChunkBackend(), { clock });
    store.add({ type: 'log', timestamp: 1, serialized: 'a' });
    const snapshot = store.snapshot();
    const streamed: StoredEntry[] = [];
    for await (const record of snapshot.stream()) {
      streamed.push(record);
    }
    expect(streamed.map((r) => r.serialized)).toEqual(['a']);
    expect((await snapshot.drainAll()).get('log')?.length).toBe(1);
    snapshot.release();
    expect(await snapshot.drainAll()).toEqual(new Map());
  });

  it('forwards unpin and inMemory only when the backend snapshot has them', () => {
    const calls: string[] = [];
    const base = createMemoryChunkBackend();
    const backend = {
      ...base,
      snapshot: (frozen: Parameters<typeof base.snapshot>[0]) => ({
        ...base.snapshot(frozen),
        unpin: () => calls.push('unpin'),
        inMemory: () => new Map([['log' as FileType, []]]),
      }),
    };
    const store = createChunkCaptureStore(backend, { clock: clockAt(0) });
    const snapshot = store.snapshot();
    snapshot.unpin?.();
    expect(calls).toEqual(['unpin']);
    expect(snapshot.inMemory?.()).toEqual(new Map([['log', []]]));
    const plain = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock: clockAt(0),
    }).snapshot();
    expect(plain.unpin).toBeUndefined();
    expect(plain.inMemory).toBeUndefined();
  });

  it('delegates to a snapshot whose methods depend on `this`', async () => {
    class ThisSnapshot {
      private readonly items = [{ type: 'log' as FileType, timestamp: 1, serialized: 'a' }];
      released = false;
      async *stream(): AsyncIterableIterator<StoredEntry> {
        yield* this.items;
      }
      async drainAll(): Promise<Map<FileType, StoredEntry[]>> {
        return new Map([['log', [...this.items]]]);
      }
      release(): void {
        this.released = true;
      }
      unpin(): void {
        this.released = true;
      }
      inMemory(): Map<FileType, StoredEntry[]> {
        return new Map([['log', [...this.items]]]);
      }
    }
    const inner = new ThisSnapshot();
    const base = createMemoryChunkBackend();
    const store = createChunkCaptureStore(
      { ...base, snapshot: () => inner as never },
      { clock: clockAt(0) },
    );
    const snapshot = store.snapshot();
    const seen: string[] = [];
    for await (const r of snapshot.stream()) seen.push(r.serialized);
    expect(seen).toEqual(['a']);
    expect((await snapshot.drainAll()).get('log')?.length).toBe(1);
    expect(snapshot.inMemory?.().get('log')?.length).toBe(1);
    snapshot.unpin?.();
    expect(inner.released).toBe(true);
    inner.released = false;
    snapshot.release();
    expect(inner.released).toBe(true);
  });
});

describe('createChunkCaptureStore — one visual lane per source key (per-window replay)', () => {
  // A replay record of `bytes` serialized bytes, labelled, in the lane `lane` (a window), at second `s`.
  const rec = (
    lane: string | undefined,
    label: string,
    s: number,
    anchor = false,
    bytes = 10,
  ): StoredEntry => ({
    type: 'replay',
    timestamp: s * 1000,
    serialized: label.padEnd(bytes, '.'),
    ...(lane !== undefined ? { lane } : {}),
    ...(anchor ? { anchor: true } : {}),
  });
  const held = async (store: ReturnType<typeof createChunkCaptureStore>) => {
    const out: Record<string, string[]> = {};
    for (const e of (await store.snapshot().drainAll()).get('replay') ?? []) {
      const name = e.lane ?? '';
      out[name] = [...(out[name] ?? []), e.serialized.replace(/\.+$/, '')];
    }
    return out;
  };

  it('time eviction keeps the newest base at or before the window start PER lane', async () => {
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock: clockAt(0),
      maxRecordingTimeMs: 2000,
    });
    // Window a opens a base at 0 and again at 5; window b opens one at 1 only. At t=10 the window starts at 8.
    const plan: Array<[string, string, number, boolean]> = [
      ['a', 'a0', 0, true],
      ['b', 'b1', 1, true],
      ['b', 'b2', 2, false],
      ['a', 'a5', 5, true],
      ['a', 'a6', 6, false],
    ];
    for (let s = 0; s < 10; s++) {
      for (const [lane, label, at, anchor] of plan) {
        if (at === s) {
          store.add(rec(lane, label, s, anchor));
        }
      }
      store.tick((s + 1) * 1000);
    }
    const kept = await held(store);
    expect(kept.a).toEqual(['a5', 'a6']); // a's older base is superseded
    expect(kept.b).toEqual(['b1', 'b2']); // b's only base survives even though it is older than the window
  });

  it('the byte cap resets the lane whose bases are all gone, by name', async () => {
    const reset = vi.fn();
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock: clockAt(0),
      maxRecordingTimeMs: 1_000_000,
      maxDataSizeBytes: 50,
      onVisualReset: reset,
    });
    store.add(rec('a', 'A', 0, true, 30)); // a: one base segment
    store.tick(1000);
    store.add(rec('b', 'B', 1, true, 15)); // b: one base segment, newer
    store.tick(2000);
    store.add(rec('b', 'b', 2, false, 15)); // 60 bytes > 50: the OLDEST visual bytes (a's lone base) go
    await Promise.resolve();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith('a');
    expect(await held(store)).toEqual({ b: ['B', 'b'] });
  });

  it('an unkeyed record resets without an argument (the single-lane contract)', async () => {
    const reset = vi.fn();
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock: clockAt(0),
      maxRecordingTimeMs: 1_000_000,
      maxDataSizeBytes: 20,
      onVisualReset: reset,
    });
    store.add(rec(undefined, 'A', 0, true, 30));
    store.tick(1000);
    store.add(rec(undefined, 'x', 1, false, 5));
    await Promise.resolve();
    expect(reset).toHaveBeenCalledWith();
  });

  it('the snapshot hands every record back with its lane', async () => {
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock: clockAt(0),
      maxRecordingTimeMs: 1_000_000,
    });
    store.add(rec('a', 'a0', 0, true));
    store.add(rec('b', 'b0', 0, true));
    store.add(rec(undefined, 'u0', 0, true));
    expect(await held(store)).toEqual({ a: ['a0'], b: ['b0'], '': ['u0'] });
  });

  it('freezes each visual part with its lane, and the data part without one', () => {
    const inner = createMemoryChunkBackend();
    const seen: Array<readonly FrozenPart[]> = [];
    const store = createChunkCaptureStore(
      { ...inner, snapshot: (parts) => (seen.push(parts), inner.snapshot(parts)) },
      { clock: clockAt(0), maxRecordingTimeMs: 1_000_000 },
    );
    store.add(rec('a', 'a0', 0, true));
    store.add(rec(undefined, 'u0', 0, true));
    store.add({ type: 'log', timestamp: 0, serialized: 'l' });
    store.snapshot().release();
    expect((seen[0] ?? []).map((part) => part.lane)).toEqual([undefined, 'a', undefined]);
  });

  it('opens a visual part on the backend with its lane, and every other part without one', () => {
    const inner = createMemoryChunkBackend();
    const opened: unknown[][] = [];
    const store = createChunkCaptureStore(
      { ...inner, openPart: (...args) => (opened.push(args.slice(2)), inner.openPart(...args)) },
      { clock: clockAt(0), maxRecordingTimeMs: 1_000_000 },
    );
    store.add(rec('a', 'a0', 0, true));
    store.add(rec(undefined, 'u0', 0, true));
    // [0] is the store's own first data part; then a's part, then the unkeyed visual part
    expect(opened).toEqual([[], ['a'], []]);
  });
});
