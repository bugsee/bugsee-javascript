import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { observe, onBFCacheRestore, onHidden } from './observe';

afterEach(() => vi.unstubAllGlobals());

const entry = (over: Partial<PerformanceEntryLike> = {}): PerformanceEntryLike => ({
  name: '',
  entryType: 'x',
  startTime: 0,
  duration: 0,
  ...over,
});

// A fake PerformanceObserver: records observe()/disconnect()/takeRecords and can emit entries.
function fakePerformanceObserver(supported: string[], throwOnObserve = false) {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = supported;
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    observed: { type: string; buffered?: boolean; durationThreshold?: number } | undefined;
    disconnected = false;
    records: PerformanceEntryLike[] = [];
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe(options: { type: string; buffered?: boolean; durationThreshold?: number }) {
      if (throwOnObserve) throw new Error('unsupported');
      this.observed = options;
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return this.records;
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  return { Ctor: FakePO as never, instances };
}

// A synchronous microtask so the deferred callback runs inline in tests.
const syncEnv = (over: Partial<WebVitalsEnv> = {}): WebVitalsEnv => ({
  queueMicrotask: (cb) => cb(),
  ...over,
});

function fakeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type: string, listener: (event: unknown) => void) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(listener);
    },
    emit: (type: string, event?: unknown) => {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    has: (type: string) => (listeners.get(type)?.size ?? 0) > 0,
  };
}

describe('observe', () => {
  it('returns undefined when PerformanceObserver is absent', () => {
    expect(observe(syncEnv(), 'paint', () => {})).toBeUndefined();
  });

  it('returns undefined when the entry type is not in supportedEntryTypes', () => {
    const { Ctor } = fakePerformanceObserver(['layout-shift']);
    expect(observe(syncEnv({ PerformanceObserver: Ctor }), 'paint', () => {})).toBeUndefined();
  });

  it('observes the type buffered, passing extra options through (durationThreshold)', () => {
    const { Ctor, instances } = fakePerformanceObserver(['event']);
    const po = observe(syncEnv({ PerformanceObserver: Ctor }), 'event', () => {}, {
      durationThreshold: 40,
    });
    expect(po).toBe(instances[0]);
    expect(instances[0]?.observed).toEqual({
      type: 'event',
      buffered: true,
      durationThreshold: 40,
    });
  });

  it('delivers entries + the observer to the callback (deferred via queueMicrotask)', () => {
    const { Ctor, instances } = fakePerformanceObserver(['paint']);
    const seen: { entries: PerformanceEntryLike[]; isObserver: boolean }[] = [];
    const po = observe(syncEnv({ PerformanceObserver: Ctor }), 'paint', (entries, observer) => {
      seen.push({ entries, isObserver: observer === instances[0] });
    });
    const e = entry({ entryType: 'paint', name: 'first-contentful-paint' });
    instances[0]?.emit([e]);
    expect(seen).toEqual([{ entries: [e], isObserver: true }]);
    expect(po).toBe(instances[0]);
  });

  it('defers the callback through the injected queueMicrotask', () => {
    const { Ctor, instances } = fakePerformanceObserver(['paint']);
    const calls: string[] = [];
    const env: WebVitalsEnv = {
      PerformanceObserver: Ctor,
      queueMicrotask: (cb) => {
        calls.push('scheduled');
        cb();
      },
    };
    observe(env, 'paint', () => calls.push('callback'));
    instances[0]?.emit([entry()]);
    expect(calls).toEqual(['scheduled', 'callback']); // went through env.queueMicrotask
  });

  it('falls back to synchronous delivery when no queueMicrotask is provided', () => {
    const { Ctor, instances } = fakePerformanceObserver(['paint']);
    const seen: PerformanceEntryLike[][] = [];
    observe({ PerformanceObserver: Ctor }, 'paint', (entries) => seen.push(entries));
    instances[0]?.emit([entry()]);
    expect(seen).toHaveLength(1); // still delivered, just not deferred
  });

  it('returns undefined (no throw) when observe() throws', () => {
    const { Ctor } = fakePerformanceObserver(['paint'], true);
    expect(observe(syncEnv({ PerformanceObserver: Ctor }), 'paint', () => {})).toBeUndefined();
  });
});

describe('onHidden', () => {
  it('fires when the document transitions to hidden (not when it becomes visible)', () => {
    const doc = fakeTarget();
    const state = { visibility: 'visible' };
    const env: WebVitalsEnv = {
      document: {
        addEventListener: doc.addEventListener,
        get visibilityState() {
          return state.visibility;
        },
      } as never,
    };
    let fired = 0;
    onHidden(env, () => fired++);
    state.visibility = 'visible';
    doc.emit('visibilitychange');
    expect(fired).toBe(0);
    state.visibility = 'hidden';
    doc.emit('visibilitychange');
    expect(fired).toBe(1);
  });

  it('fires on pagehide (page going away)', () => {
    const win = fakeTarget();
    let fired = 0;
    onHidden({ window: win as never }, () => fired++);
    win.emit('pagehide');
    expect(fired).toBe(1);
  });

  it('does not throw when document/window are absent', () => {
    expect(() => onHidden({}, () => {})).not.toThrow();
  });
});

describe('onBFCacheRestore', () => {
  it('fires with the restore timestamp only for a persisted pageshow', () => {
    const win = fakeTarget();
    const restores: number[] = [];
    onBFCacheRestore({ window: win as never }, (t) => restores.push(t));
    win.emit('pageshow', { persisted: false, timeStamp: 5 }); // a normal load → ignored
    win.emit('pageshow', { persisted: true, timeStamp: 1234 }); // a bfcache restore
    expect(restores).toEqual([1234]);
  });

  it('defaults the restore timestamp to 0 when absent, and does not throw without a window', () => {
    const win = fakeTarget();
    const restores: number[] = [];
    onBFCacheRestore({ window: win as never }, (t) => restores.push(t));
    win.emit('pageshow', { persisted: true });
    expect(restores).toEqual([0]);
    expect(() => onBFCacheRestore({}, () => {})).not.toThrow();
  });
});
