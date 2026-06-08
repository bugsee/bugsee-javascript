import { afterEach, describe, expect, it, vi } from 'vitest';
import { realWebVitalsEnv } from './env';

afterEach(() => vi.unstubAllGlobals());

describe('realWebVitalsEnv', () => {
  it('resolves the browser globals (PerformanceObserver/performance/document/window/queueMicrotask)', () => {
    const PerformanceObserver = function fake() {};
    const performance = { now: () => 1, getEntriesByType: () => [] };
    const document = { visibilityState: 'visible' };
    const win = {};
    const queueMicrotask = () => {};
    vi.stubGlobal('PerformanceObserver', PerformanceObserver);
    vi.stubGlobal('performance', performance);
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', win);
    vi.stubGlobal('queueMicrotask', queueMicrotask);

    const env = realWebVitalsEnv();
    expect(env.PerformanceObserver).toBe(PerformanceObserver);
    expect(env.performance).toBe(performance);
    expect(env.document).toBe(document);
    expect(env.window).toBe(win);
    expect(env.queueMicrotask).toBe(queueMicrotask);
  });
});
