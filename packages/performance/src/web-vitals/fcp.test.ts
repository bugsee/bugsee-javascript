import { describe, expect, it } from 'vitest';
import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { onFCP } from './fcp';
import type { Metric } from './metric';

const paintEntry = (name: string, startTime: number): PerformanceEntryLike => ({
  name,
  entryType: 'paint',
  startTime,
  duration: 0,
});

function fakePaintObserver() {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = ['paint'];
    cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    disconnected = false;
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    takeRecords(): PerformanceEntryLike[] {
      return [];
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  return { Ctor: FakePO as never, instances };
}

const env = (
  Ctor: never,
  over: Partial<WebVitalsEnv> = {},
  navEntry?: Record<string, unknown>,
): WebVitalsEnv => ({
  PerformanceObserver: Ctor,
  performance: {
    now: () => 0,
    getEntriesByType: (type) =>
      type === 'navigation' && navEntry
        ? [{ name: '', entryType: 'navigation', startTime: 0, duration: 0, ...navEntry }]
        : [],
  },
  queueMicrotask: (cb) => cb(),
  document: { visibilityState: 'visible', addEventListener: () => {} } as never,
  window: { addEventListener: () => {} } as never,
  ...over,
});

describe('onFCP', () => {
  it('reports the first-contentful-paint startTime, ignoring first-paint, and disconnects (report-once)', () => {
    const { Ctor, instances } = fakePaintObserver();
    const seen: Metric[] = [];
    onFCP(env(Ctor), (m) => seen.push(m));
    instances[0]?.emit([paintEntry('first-paint', 100), paintEntry('first-contentful-paint', 250)]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'FCP', value: 250, rating: 'good' });
    expect(instances[0]?.disconnected).toBe(true);
  });

  it('subtracts activationStart (prerender), clamped to >= 0', () => {
    const { Ctor, instances } = fakePaintObserver();
    const seen: Metric[] = [];
    onFCP(env(Ctor, {}, { activationStart: 100 }), (m) => seen.push(m));
    instances[0]?.emit([paintEntry('first-contentful-paint', 250)]);
    expect(seen[0]?.value).toBe(150);
  });

  it('drops an FCP that occurs after the page was first hidden (background tab)', () => {
    const { Ctor, instances } = fakePaintObserver();
    const seen: Metric[] = [];
    // hidden at creation → firstHiddenTime 0 → any FCP (startTime >= 0) is dropped
    onFCP(
      env(Ctor, { document: { visibilityState: 'hidden', addEventListener: () => {} } as never }),
      (m) => seen.push(m),
    );
    instances[0]?.emit([paintEntry('first-contentful-paint', 250)]);
    expect(seen).toEqual([]);
    expect(instances[0]?.disconnected).toBe(true); // still disconnects (report-once semantics)
  });

  it('does nothing (no throw) when PerformanceObserver is unavailable', () => {
    const seen: Metric[] = [];
    expect(() => onFCP({}, (m) => seen.push(m))).not.toThrow();
    expect(seen).toEqual([]);
  });
});
