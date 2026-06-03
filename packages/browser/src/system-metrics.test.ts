import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMemorySampler } from './system-metrics';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBrowserMemorySampler', () => {
  it('samples the three performance.memory heap values', () => {
    const sampler = createBrowserMemorySampler(() => ({
      usedJSHeapSize: 100,
      totalJSHeapSize: 200,
      jsHeapSizeLimit: 300,
    }));
    expect(sampler()).toEqual([
      { name: 'browser_memory_used_heap', value: 100 },
      { name: 'browser_memory_total_heap', value: 200 },
      { name: 'browser_memory_heap_limit', value: 300 },
    ]);
  });

  it('returns no samples when performance.memory is unsupported', () => {
    const sampler = createBrowserMemorySampler(() => undefined);
    expect(sampler()).toEqual([]);
  });

  it('defaults to reading globalThis.performance.memory', () => {
    vi.stubGlobal('performance', {
      memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 },
    });
    expect(createBrowserMemorySampler()()).toEqual([
      { name: 'browser_memory_used_heap', value: 1 },
      { name: 'browser_memory_total_heap', value: 2 },
      { name: 'browser_memory_heap_limit', value: 3 },
    ]);
  });

  it('the default reader yields [] when performance has no memory field', () => {
    vi.stubGlobal('performance', {});
    expect(createBrowserMemorySampler()()).toEqual([]);
  });
});
