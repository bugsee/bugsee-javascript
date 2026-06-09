import { describe, expect, it } from 'vitest';
import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { type INPReportOptions, onINP } from './inp';
import type { Metric } from './metric';

const ev = (
  interactionId: number | undefined,
  duration: number,
  entryType = 'event',
): PerformanceEntryLike =>
  ({ name: '', entryType, startTime: 0, duration, interactionId }) as never;

function fakeObservers() {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = ['event', 'first-input'];
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    observed: { type: string; durationThreshold?: number } | undefined;
    pending: PerformanceEntryLike[] = [];
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe(options: { type: string; durationThreshold?: number }) {
      this.observed = options;
    }
    disconnect() {}
    takeRecords(): PerformanceEntryLike[] {
      const p = this.pending;
      this.pending = [];
      return p;
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  const find = (type: string, threshold?: number) =>
    instances.find(
      (i) =>
        i.observed?.type === type &&
        (threshold === undefined || i.observed?.durationThreshold === threshold),
    );
  return { Ctor: FakePO as never, instances, find };
}

function fakeWindow() {
  const listeners = new Map<string, (() => void)[]>();
  return {
    addEventListener: (type: string, l: () => void) => {
      (listeners.get(type) ?? listeners.set(type, []).get(type))?.push(l);
    },
    emit: (type: string) => {
      for (const l of listeners.get(type) ?? []) l();
    },
  };
}

function setup(interactionCount?: number, opts?: INPReportOptions) {
  const { Ctor, find } = fakeObservers();
  const win = fakeWindow();
  const env: WebVitalsEnv = {
    PerformanceObserver: Ctor,
    performance: {
      now: () => 0,
      getEntriesByType: () => [],
      ...(interactionCount !== undefined ? { interactionCount } : {}),
    } as never,
    queueMicrotask: (cb) => cb(),
    window: win as never,
  };
  const seen: Metric[] = [];
  onINP(env, (m) => seen.push(m), opts);
  return { find, win, seen, inp: () => seen.at(-1)?.value };
}

describe('onINP', () => {
  it('reports the interaction latency, finalizing on hidden', () => {
    const { find, win, inp } = setup(1);
    find('event', 40)?.emit([ev(1, 120)]);
    win.emit('pagehide');
    expect(inp()).toBe(120);
  });

  it('groups entries by interactionId, taking the MAX duration as the latency', () => {
    const { find, win, inp } = setup(1);
    find('event', 40)?.emit([ev(7, 100), ev(7, 180), ev(7, 90)]); // one interaction (pointerdown/up/...)
    win.emit('pagehide');
    expect(inp()).toBe(180);
  });

  it('keeps the 10 LONGEST interactions and estimates p98 by floor(count / 50)', () => {
    // 10 interactions, latencies 10..100 (ids 1..10); native count 100 → index floor(100/50)=2 →
    // the 3rd-worst of [100,90,80,...] = 80.
    const { find, win, inp } = setup(100);
    const events = Array.from({ length: 10 }, (_, i) => ev(i + 1, (i + 1) * 10));
    find('event', 40)?.emit(events);
    win.emit('pagehide');
    expect(inp()).toBe(80);
  });

  it('drops interactions beyond the 10 longest', () => {
    // 12 interactions, latencies 10..120; count 1 → index 0 → the single worst = 120; the buffer holds 10.
    const { find, win, inp } = setup(1);
    find('event', 40)?.emit(Array.from({ length: 12 }, (_, i) => ev(i + 1, (i + 1) * 10)));
    win.emit('pagehide');
    expect(inp()).toBe(120);
  });

  it('trimming to 10 longest changes the p98 index at high counts', () => {
    // 15 interactions (latencies 10..150); count 600 → index floor(600/50)=12.
    // Trimmed to the 10 longest [150..60] → length 10 → index min(9,12)=9 → 60.
    // (If NOT trimmed, length 15 → index 12 → 30 — so this pins the splice.)
    const { find, win, inp } = setup(600);
    find('event', 40)?.emit(Array.from({ length: 15 }, (_, i) => ev(i + 1, (i + 1) * 10)));
    win.emit('pagehide');
    expect(inp()).toBe(60);
  });

  it('falls back to first-input (no interactionId) so a single small interaction still reports', () => {
    const { find, win, inp } = setup(1);
    find('first-input')?.emit([ev(undefined, 64, 'first-input')]);
    win.emit('pagehide');
    expect(inp()).toBe(64);
  });

  it('drops an implausible (>60s) interaction', () => {
    const { find, win, inp } = setup(1);
    find('event', 40)?.emit([ev(1, 70_000), ev(2, 90)]); // the 70s outlier is ignored
    win.emit('pagehide');
    expect(inp()).toBe(90);
  });

  it('passes the configured durationThreshold to the event observer', () => {
    const { find } = setup(1, { durationThreshold: 200 });
    expect(find('event')?.observed?.durationThreshold).toBe(200);
  });

  it('polyfills interactionCount from the interactionId range when there is no native counter', () => {
    // No native count → a second event observer (threshold 0) tracks the id range.
    const { find, win, inp } = setup(undefined);
    const polyfill = find('event', 0);
    expect(polyfill).toBeDefined();
    // ids 1..701 → count = (701-1)/7 + 1 = 101 → index floor(101/50) = 2
    polyfill?.emit([ev(1, 5), ev(701, 5)]);
    find('event', 40)?.emit([ev(1, 50), ev(8, 40), ev(15, 30), ev(22, 20), ev(29, 10)]);
    win.emit('pagehide');
    expect(inp()).toBe(30); // 3rd worst of [50,40,30,20,10]
  });

  it('does NOT create the polyfill observer when a native interactionCount exists', () => {
    const { find } = setup(5);
    expect(find('event', 0)).toBeUndefined();
  });

  it('ignores a non-interaction event (no interactionId, not first-input)', () => {
    const { find, win, inp } = setup(1);
    find('event', 40)?.emit([ev(undefined, 999), ev(7, 50)]); // the id-less 999 is not an interaction
    win.emit('pagehide');
    expect(inp()).toBe(50);
  });

  it('polyfill ignores id-less events and treats an empty range as count 0', () => {
    const { find, win, inp } = setup(undefined);
    find('event', 0)?.emit([ev(undefined, 5)]); // no interactionId → not counted in the range
    find('event', 40)?.emit([ev(7, 90)]); // range still empty → count 0 → index 0 → INP 90
    win.emit('pagehide');
    expect(inp()).toBe(90);
  });

  it('does nothing (no throw) without PerformanceObserver support', () => {
    const seen: Metric[] = [];
    expect(() => onINP({ window: fakeWindow() as never }, (m) => seen.push(m))).not.toThrow();
    expect(seen).toEqual([]);
  });
});
