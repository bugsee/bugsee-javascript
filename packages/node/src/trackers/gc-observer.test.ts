import { describe, expect, it } from 'vitest';
import { createGcSource, type GcEntry } from './gc-observer';

// A controllable PerformanceObserver: `deliver` runs the callback (async delivery), `queue` is what
// takeRecords() drains (entries not yet delivered).
function fakePerformanceObserver(
  opts: { observeThrows?: boolean; noTakeRecords?: boolean; takeRecordsThrows?: boolean } = {},
) {
  const state = {
    constructed: 0,
    observed: [] as unknown[],
    disconnects: 0,
    queue: [] as GcEntry[],
    cb: undefined as ((list: { getEntries(): GcEntry[] }) => void) | undefined,
  };
  class FakeObserver {
    constructor(cb: (list: { getEntries(): GcEntry[] }) => void) {
      state.constructed += 1;
      state.cb = cb;
    }
    observe(options: unknown) {
      if (opts.observeThrows) throw new Error('unsupported entry type');
      state.observed.push(options);
    }
    disconnect() {
      state.disconnects += 1;
    }
    takeRecords = opts.noTakeRecords
      ? undefined
      : () => {
          if (opts.takeRecordsThrows) throw new Error('takeRecords');
          const q = state.queue;
          state.queue = [];
          return q;
        };
  }
  return {
    state,
    ctor: FakeObserver as never,
    deliver: (...entries: GcEntry[]) => state.cb?.({ getEntries: () => entries }),
  };
}

describe('createGcSource', () => {
  it('constructs and observes NOTHING until start()', () => {
    const fake = fakePerformanceObserver();
    createGcSource(fake.ctor);
    expect(fake.state.constructed).toBe(0);
  });

  it('start() observes the gc entry type, and read() before start() is omitted (never zero)', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    expect(src.read()).toBeUndefined();
    src.start();
    expect(fake.state.observed).toEqual([{ entryTypes: ['gc'] }]);
  });

  it('a started source with no collections answers a TRUE zero interval', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    expect(src.read()).toEqual({ count: 0, pauseMs: 0, maxPauseMs: 0 });
  });

  it('read() sums count/pause and tracks the max, then resets for the next interval', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver({ duration: 2 }, { duration: 7.5 });
    fake.deliver({ duration: 1 });
    expect(src.read()).toEqual({ count: 3, pauseMs: 10.5, maxPauseMs: 7.5 });
    expect(src.read()).toEqual({ count: 0, pauseMs: 0, maxPauseMs: 0 });
  });

  it('read() also drains entries the observer has not delivered yet', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver({ duration: 4 });
    fake.state.queue = [{ duration: 3 }];
    expect(src.read()).toEqual({ count: 2, pauseMs: 7, maxPauseMs: 4 });
    expect(src.read()?.count).toBe(0);
  });

  it('works when the observer has no takeRecords', () => {
    const fake = fakePerformanceObserver({ noTakeRecords: true });
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver({ duration: 5 });
    expect(src.read()).toEqual({ count: 1, pauseMs: 5, maxPauseMs: 5 });
  });

  it('ignores entries with a non-finite or negative duration', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver(
      { duration: Number.NaN },
      { duration: -1 },
      { duration: Number.POSITIVE_INFINITY },
      { duration: 2 },
    );
    expect(src.read()).toEqual({ count: 1, pauseMs: 2, maxPauseMs: 2 });
  });

  it('a zero-length collection still counts', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver({ duration: 0 });
    expect(src.read()).toEqual({ count: 1, pauseMs: 0, maxPauseMs: 0 });
  });

  it('stop() disconnects, and read() after stop is omitted', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    src.stop();
    expect(fake.state.disconnects).toBe(1);
    expect(src.read()).toBeUndefined();
  });

  it('stop() without start() disconnects nothing', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.stop();
    expect(fake.state.disconnects).toBe(0);
  });

  it('restart: observes again and starts from a clean interval', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver({ duration: 9 });
    src.stop();
    src.start();
    expect(fake.state.constructed).toBe(2);
    expect(src.read()).toEqual({ count: 0, pauseMs: 0, maxPauseMs: 0 });
  });

  it('a late delivery from a stopped observer is not counted', () => {
    const fake = fakePerformanceObserver();
    const src = createGcSource(fake.ctor);
    src.start();
    const staleCb = fake.state.cb;
    src.stop();
    src.start();
    staleCb?.({ getEntries: () => [{ duration: 50 }] });
    expect(src.read()).toEqual({ count: 0, pauseMs: 0, maxPauseMs: 0 });
  });

  it('a runtime whose observe() throws degrades to omitted: start() does not throw, nothing is left registered, read() is undefined', () => {
    const fake = fakePerformanceObserver({ observeThrows: true });
    const src = createGcSource(fake.ctor);
    expect(() => src.start()).not.toThrow();
    expect(fake.state.disconnects).toBe(1);
    expect(src.read()).toBeUndefined();
    src.start(); // does not retry a runtime that already refused
    expect(fake.state.constructed).toBe(1);
  });

  it('a throwing disconnect during the unwind or on stop is swallowed', () => {
    const fake = fakePerformanceObserver({ observeThrows: true });
    (fake.ctor as { prototype: { disconnect(): void } }).prototype.disconnect = () => {
      throw new Error('disconnect');
    };
    const src = createGcSource(fake.ctor);
    expect(() => src.start()).not.toThrow();
    const ok = fakePerformanceObserver();
    (ok.ctor as { prototype: { disconnect(): void } }).prototype.disconnect = () => {
      throw new Error('disconnect');
    };
    const s2 = createGcSource(ok.ctor);
    s2.start();
    expect(() => s2.stop()).not.toThrow();
  });

  it('a throwing takeRecords makes that read omitted, not a throw', () => {
    const fake = fakePerformanceObserver({ takeRecordsThrows: true });
    const src = createGcSource(fake.ctor);
    src.start();
    fake.deliver({ duration: 4 });
    expect(src.read()).toBeUndefined();
  });
});
