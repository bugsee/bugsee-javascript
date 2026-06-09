import type { Clock } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createPerformanceController } from './controller';
import { collectPageLoadVitals } from './page-load';
import { createTransactionStore } from './transaction-store';
import type { PerformanceEntryLike, WebVitalsEnv } from './web-vitals/env';

const entry = (
  over: Partial<PerformanceEntryLike> & Record<string, unknown>,
): PerformanceEntryLike =>
  ({ name: '', entryType: 'x', startTime: 0, duration: 0, ...over }) as never;

// A multi-type PerformanceObserver fake: instances tracked by entry type + durationThreshold.
function fakeObservers() {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = [
      'paint',
      'largest-contentful-paint',
      'layout-shift',
      'event',
      'first-input',
    ];
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    observed: { type: string; durationThreshold?: number } | undefined;
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe(o: { type: string; durationThreshold?: number }) {
      this.observed = o;
    }
    disconnect() {}
    takeRecords(): PerformanceEntryLike[] {
      return [];
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  const emit = (type: string, entries: PerformanceEntryLike[], threshold?: number) =>
    instances
      .find(
        (i) =>
          i.observed?.type === type &&
          (threshold === undefined || i.observed?.durationThreshold === threshold),
      )
      ?.emit(entries);
  return { Ctor: FakePO as never, emit };
}

function fakeTarget(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    addEventListener: (type: string, l: () => void) => {
      (listeners.get(type) ?? listeners.set(type, []).get(type))?.push(l);
    },
    emit: (type: string) => {
      for (const l of listeners.get(type) ?? []) l();
    },
    ...extra,
  };
}

const clock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

describe('collectPageLoadVitals', () => {
  it('collects all five vitals into a finished pageload transaction', () => {
    const { Ctor, emit } = fakeObservers();
    const win = fakeTarget();
    const doc = fakeTarget({ visibilityState: 'visible' });
    const env: WebVitalsEnv = {
      PerformanceObserver: Ctor,
      performance: {
        now: () => 100_000, // well past responseStart so TTFB validates (responseStart < now)
        interactionCount: 1, // native counter → no INP polyfill observer
        getEntriesByType: (type: string) =>
          type === 'navigation'
            ? [entry({ entryType: 'navigation', type: 'navigate', responseStart: 300 })]
            : [],
      } as never,
      queueMicrotask: (cb) => cb(),
      document: doc as never,
      window: win as never,
    };
    const store = createTransactionStore();
    const api = createPerformanceController({ clock, store, appVersion: '1.0' });

    collectPageLoadVitals(env, api, { name: '/checkout' });

    // TTFB is read immediately; the paint metric reports at paint; LCP/CLS/INP stream then finalize.
    emit('paint', [entry({ entryType: 'paint', name: 'first-contentful-paint', startTime: 800 })]);
    emit('largest-contentful-paint', [
      entry({ entryType: 'largest-contentful-paint', startTime: 1500 }),
    ]);
    emit('layout-shift', [
      entry({ entryType: 'layout-shift', startTime: 0, value: 0.05, hadRecentInput: false }),
    ]);
    emit(
      'event',
      [entry({ entryType: 'event', startTime: 0, duration: 90, interactionId: 1 })],
      40,
    );
    expect(store.size()).toBe(0); // nothing buffered until the page is hidden

    win.emit('pagehide'); // LCP/CLS/INP finalize, then the transaction finishes

    const [txn] = store.drain();
    expect(txn).toMatchObject({ name: '/checkout', operation: 'pageload', appVersion: '1.0' });
    expect(txn?.attributes).toMatchObject({
      'web_vital.ttfb.value': 300,
      'web_vital.ttfb.rating': 'good',
      'web_vital.fcp.value': 800,
      'web_vital.lcp.value': 1500,
      'web_vital.lcp.rating': 'good',
      'web_vital.cls.value': 0.05,
      'web_vital.inp.value': 90,
      'web_vital.inp.rating': 'good',
    });
  });

  it('still finishes the pageload transaction even where the vitals APIs are absent', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock, store });
    const win = fakeTarget();
    collectPageLoadVitals({ window: win as never }, api, { name: '/' });
    expect(store.size()).toBe(0);
    win.emit('pagehide');
    const [txn] = store.drain();
    expect(txn).toMatchObject({ name: '/', operation: 'pageload' });
    expect(txn?.attributes).toBeUndefined(); // no vitals collected → no attributes
  });
});
