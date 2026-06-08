import { describe, expect, it } from 'vitest';
import {
  bindReporter,
  generateUniqueID,
  getRating,
  initMetric,
  type Metric,
  THRESHOLDS,
} from './metric';

describe('getRating', () => {
  it('buckets strictly by > threshold (a value equal to a threshold is the better bucket)', () => {
    expect(getRating(2500, [2500, 4000])).toBe('good'); // == good-threshold → still good
    expect(getRating(2500.1, [2500, 4000])).toBe('needs-improvement');
    expect(getRating(4000, [2500, 4000])).toBe('needs-improvement'); // == poor-threshold → not poor
    expect(getRating(4000.1, [2500, 4000])).toBe('poor');
    expect(getRating(0, [2500, 4000])).toBe('good');
  });
});

describe('THRESHOLDS', () => {
  it('match the Core Web Vitals good/poor cutoffs', () => {
    expect(THRESHOLDS).toEqual({
      LCP: [2500, 4000],
      CLS: [0.1, 0.25],
      INP: [200, 500],
      FCP: [1800, 3000],
      TTFB: [800, 1800],
    });
  });
});

describe('generateUniqueID', () => {
  it('produces a v1-<timestamp>-<random> id', () => {
    expect(generateUniqueID()).toMatch(/^v1-\d+-\d+$/);
    expect(generateUniqueID()).not.toBe(generateUniqueID()); // random component differs
  });
});

describe('initMetric', () => {
  it('creates a fresh metric with the -1 sentinel value, an id, and the navigation type', () => {
    const m = initMetric('LCP', 'reload');
    expect(m).toMatchObject({
      name: 'LCP',
      value: -1,
      rating: 'good',
      delta: 0,
      navigationType: 'reload',
      entries: [],
    });
    expect(m.id).toMatch(/^v1-\d+-\d+$/);
  });
});

describe('bindReporter', () => {
  const collect = (m: Metric, thresholds: [number, number], reportAllChanges?: boolean) => {
    const seen: { value: number; delta: number; rating: string }[] = [];
    const report = bindReporter(
      (x) => seen.push({ value: x.value, delta: x.delta, rating: x.rating }),
      m,
      thresholds,
      reportAllChanges,
    );
    return { seen, report };
  };

  it('never reports while the value is the -1 sentinel', () => {
    const m = initMetric('LCP', 'navigate');
    const { seen, report } = collect(m, [2500, 4000]);
    report(true); // forceReport, but value is -1 → suppressed
    expect(seen).toEqual([]);
  });

  it('reports on forceReport once a value is set, with the rating + delta (first delta = value)', () => {
    const m = initMetric('LCP', 'navigate');
    const { seen, report } = collect(m, [2500, 4000]);
    m.value = 3000;
    report(true);
    expect(seen).toEqual([{ value: 3000, delta: 3000, rating: 'needs-improvement' }]);
  });

  it('without reportAllChanges, streaming (non-force) calls are suppressed until a forceReport', () => {
    const m = initMetric('LCP', 'navigate');
    const { seen, report } = collect(m, [2500, 4000]);
    m.value = 2000;
    report(); // not forced, not reportAllChanges → suppressed
    expect(seen).toEqual([]);
    report(true);
    expect(seen).toEqual([{ value: 2000, delta: 2000, rating: 'good' }]);
  });

  it('with reportAllChanges, streams each change (delta = increment), suppressing no-change', () => {
    const m = initMetric('CLS', 'navigate');
    const { seen, report } = collect(m, [0.1, 0.25], true);
    m.value = 1;
    report();
    m.value = 1;
    report(); // no change → delta 0, prevValue defined → suppressed
    m.value = 3;
    report();
    expect(seen).toEqual([
      { value: 1, delta: 1, rating: 'poor' },
      { value: 3, delta: 2, rating: 'poor' },
    ]);
  });

  it('reports a genuine 0 value exactly once (the prevValue-undefined clause)', () => {
    const m = initMetric('CLS', 'navigate');
    const { seen, report } = collect(m, [0.1, 0.25], true);
    m.value = 0;
    report(); // value 0, delta 0, but prevValue undefined → reports once
    report(); // now prevValue is 0 → delta 0 → suppressed
    expect(seen).toEqual([{ value: 0, delta: 0, rating: 'good' }]);
  });
});
