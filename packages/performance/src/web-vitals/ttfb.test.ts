import { describe, expect, it } from 'vitest';
import type { WebVitalsEnv } from './env';
import type { Metric } from './metric';
import { onTTFB } from './ttfb';

const env = (navEntry?: Record<string, unknown>, now = 1000): WebVitalsEnv => ({
  performance: {
    now: () => now,
    getEntriesByType: (type) =>
      type === 'navigation' && navEntry
        ? [{ name: '', entryType: 'navigation', startTime: 0, duration: 0, ...navEntry }]
        : [],
  },
});

const collect = (e: WebVitalsEnv): Metric[] => {
  const seen: Metric[] = [];
  onTTFB(e, (m) => seen.push(m));
  return seen;
};

describe('onTTFB', () => {
  it('reports responseStart as the TTFB value with the rating + navigation type', () => {
    const seen = collect(env({ type: 'navigate', responseStart: 300 }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: 'TTFB',
      value: 300,
      rating: 'good',
      navigationType: 'navigate',
    });
    expect(seen[0]?.entries).toHaveLength(1);
  });

  it('subtracts activationStart (prerender), clamped to >= 0', () => {
    expect(collect(env({ responseStart: 300, activationStart: 100 }))[0]?.value).toBe(200);
    // activationStart beyond responseStart → clamp to 0
    expect(collect(env({ responseStart: 50, activationStart: 100 }))[0]?.value).toBe(0);
  });

  it('does not report an invalid responseStart (0, negative, missing, or >= now)', () => {
    expect(collect(env({ responseStart: 0 }))).toEqual([]);
    expect(collect(env({ responseStart: -5 }))).toEqual([]);
    expect(collect(env({ type: 'navigate' }))).toEqual([]); // no responseStart
    expect(collect(env({ responseStart: 1000 }, 1000))).toEqual([]); // == now → >= now
  });

  it('does not report when there is no navigation entry', () => {
    expect(collect(env())).toEqual([]);
  });
});
