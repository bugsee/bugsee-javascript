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

  it('a blocked host global (getter that throws) is absent from the env, never thrown', () => {
    const keys = ['PerformanceObserver', 'performance', 'document', 'window', 'queueMicrotask'];
    const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    for (const k of keys) {
      Object.defineProperty(globalThis, k, {
        configurable: true,
        get(): never {
          throw new Error(`${k} blocked`);
        },
      });
    }
    try {
      let env: ReturnType<typeof realWebVitalsEnv> | undefined;
      expect(() => {
        env = realWebVitalsEnv();
      }).not.toThrow();
      expect(Object.values(env ?? {}).filter((v) => v !== undefined)).toEqual([]);
    } finally {
      for (const [k, d] of saved) {
        if (d !== undefined) Object.defineProperty(globalThis, k, d);
        else delete (globalThis as Record<string, unknown>)[k];
      }
    }
  });
});
