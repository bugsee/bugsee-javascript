import { describe, expect, it } from 'vitest';
import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { onLCP } from './lcp';
import type { Metric } from './metric';

const lcpEntry = (startTime: number): PerformanceEntryLike => ({
  name: '',
  entryType: 'largest-contentful-paint',
  startTime,
  duration: 0,
});

function fakeLcpObserver() {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = ['largest-contentful-paint'];
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    disconnected = false;
    pending: PerformanceEntryLike[] = [];
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      const p = this.pending;
      this.pending = [];
      return p;
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  return { Ctor: FakePO as never, instances };
}

function fakeTarget(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  return {
    addEventListener: (type: string, l: (event: unknown) => void) => {
      (listeners.get(type) ?? listeners.set(type, []).get(type))?.push(l);
    },
    emit: (type: string, event?: unknown) => {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    types: () => [...listeners.keys()],
    ...extra,
  };
}

const makeEnv = (
  Ctor: never,
  win: ReturnType<typeof fakeTarget>,
  doc: ReturnType<typeof fakeTarget>,
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
  document: doc as never,
  window: win as never,
});

const setup = (navEntry?: Record<string, unknown>, visibility = 'visible') => {
  const { Ctor, instances } = fakeLcpObserver();
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: visibility });
  const seen: Metric[] = [];
  onLCP(makeEnv(Ctor, win, doc, navEntry), (m) => seen.push(m));
  return { po: () => instances[0], win, doc, seen };
};

describe('onLCP', () => {
  it('takes the LAST candidate and finalizes on a trusted click (disconnect + report)', () => {
    const { po, win, seen } = setup();
    po()?.emit([lcpEntry(100), lcpEntry(300)]); // candidate = the last (300)
    expect(seen).toEqual([]); // streaming suppressed until finalize
    win.emit('click', { isTrusted: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'LCP', value: 300, rating: 'good' });
    expect(po()?.disconnected).toBe(true);
  });

  it('finalizes on a trusted keydown and drains takeRecords() first', () => {
    const { po, win, seen } = setup();
    po()?.emit([lcpEntry(100)]);
    const observer = po();
    if (observer) observer.pending = [lcpEntry(420)]; // an entry not yet delivered
    win.emit('keydown', { isTrusted: true });
    expect(seen[0]?.value).toBe(420); // the drained record won
  });

  it('finalizes when the page becomes hidden', () => {
    const { po, doc, seen } = setup(undefined, 'visible');
    po()?.emit([lcpEntry(250)]);
    (doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    doc.emit('visibilitychange');
    expect(seen[0]?.value).toBe(250);
  });

  it('ignores an UNTRUSTED keydown/click (programmatic), and never listens for scroll', () => {
    const { po, win, seen } = setup();
    po()?.emit([lcpEntry(200)]);
    win.emit('keydown', { isTrusted: false });
    win.emit('click', {}); // isTrusted undefined
    expect(seen).toEqual([]);
    expect(win.types()).not.toContain('scroll'); // scroll is deliberately not a stop signal
  });

  it('finalizes exactly once across multiple triggers', () => {
    const { po, win, doc, seen } = setup();
    po()?.emit([lcpEntry(200)]);
    win.emit('keydown', { isTrusted: true });
    (doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    doc.emit('visibilitychange');
    win.emit('click', { isTrusted: true });
    expect(seen).toHaveLength(1);
  });

  it('subtracts activationStart (prerender), and drops a candidate after the page was first hidden', () => {
    expect(setupAndFinalize({ activationStart: 100 }, 'visible', 250)).toBe(150);
    // hidden at creation → firstHiddenTime 0 → candidate (startTime 250) dropped → no value reported
    expect(setupAndFinalize(undefined, 'hidden', 250)).toBeUndefined();
  });

  it('with reportAllChanges, streams every candidate (not just the last)', () => {
    const { Ctor, instances } = fakeLcpObserver();
    const win = fakeTarget();
    const doc = fakeTarget({ visibilityState: 'visible' });
    const values: number[] = [];
    // capture value at report time — bindReporter passes the SAME (mutated) metric object each call
    onLCP(makeEnv(Ctor, win, doc), (m) => values.push(m.value), { reportAllChanges: true });
    instances[0]?.emit([lcpEntry(100), lcpEntry(300)]);
    expect(values).toEqual([100, 300]); // both processed + streamed
  });

  it('does nothing (no throw) without a PerformanceObserver', () => {
    const seen: Metric[] = [];
    expect(() => onLCP({ window: fakeTarget() as never }, (m) => seen.push(m))).not.toThrow();
    expect(seen).toEqual([]);
  });
});

function setupAndFinalize(
  navEntry: Record<string, unknown> | undefined,
  visibility: string,
  candidate: number,
): number | undefined {
  const { po, win, seen } = setup(navEntry, visibility);
  po()?.emit([lcpEntry(candidate)]);
  win.emit('click', { isTrusted: true });
  return seen[0]?.value;
}
