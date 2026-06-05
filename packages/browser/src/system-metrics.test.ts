import { describe, expect, it, vi } from 'vitest';
import { type BrowserTracesEnv, createBrowserSystemTracesSampler } from './system-metrics';

const memory = { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sample = (env: BrowserTracesEnv) => createBrowserSystemTracesSampler(env)();

describe('createBrowserSystemTracesSampler', () => {
  it('samples performance.memory as browser_memory_* metrics', () => {
    expect(sample({ performance: { memory } })).toEqual([
      { name: 'browser_memory_used_heap', value: 1 },
      { name: 'browser_memory_total_heap', value: 2 },
      { name: 'browser_memory_heap_limit', value: 3 },
    ]);
  });

  it('samples navigator.connection as a connection trace', () => {
    expect(
      sample({
        navigator: { connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false } },
      }),
    ).toEqual([
      { name: 'connection', value: { type: '4g', downlink: 10, rtt: 50, save_data: false } },
    ]);
  });

  it('samples screen.orientation as an orientation trace', () => {
    expect(sample({ screen: { orientation: { type: 'landscape-primary', angle: 90 } } })).toEqual([
      { name: 'orientation', value: { type: 'landscape-primary', angle: 90 } },
    ]);
  });

  it('samples the cached battery as battery (rounded 0-100) + charging once getBattery resolves', async () => {
    const sampler = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => Promise.resolve({ level: 0.426, charging: true }) },
    });
    expect(sampler()).toEqual([]); // not resolved yet → no battery
    await tick();
    expect(sampler()).toEqual([
      { name: 'battery', value: 43 }, // 0.426 → 42.6 → round → 43 (pins Math.round)
      { name: 'charging', value: true },
    ]);
  });

  it('reads the cached battery manager LIVE — later samples reflect charge changes', async () => {
    const manager = { level: 0.5, charging: false };
    const sampler = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => Promise.resolve(manager) },
    });
    await tick();
    expect(sampler()).toEqual([
      { name: 'battery', value: 50 },
      { name: 'charging', value: false },
    ]);
    manager.level = 0.8; // the real BatteryManager mutates its properties in place
    manager.charging = true;
    expect(sampler()).toEqual([
      { name: 'battery', value: 80 }, // re-read live (not a one-time snapshot)
      { name: 'charging', value: true },
    ]);
  });

  it('omits battery when getBattery rejects (unsupported / denied)', async () => {
    const sampler = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => Promise.reject(new Error('denied')) },
    });
    await tick();
    expect(sampler()).toEqual([]);
  });

  it('yields nothing when no context API is available (empty env)', () => {
    expect(sample({})).toEqual([]);
  });

  it('combines every available source in one sample, in order', async () => {
    const sampler = createBrowserSystemTracesSampler({
      performance: { memory },
      navigator: {
        connection: { effectiveType: '3g' },
        getBattery: () => Promise.resolve({ level: 1, charging: false }),
      },
      screen: { orientation: { type: 'portrait-primary', angle: 0 } },
    });
    await tick();
    expect(sampler().map((s) => s.name)).toEqual([
      'browser_memory_used_heap',
      'browser_memory_total_heap',
      'browser_memory_heap_limit',
      'connection',
      'orientation',
      'battery',
      'charging',
    ]);
  });

  it('defaults to the real globals (performance/navigator/screen)', () => {
    vi.stubGlobal('performance', { memory });
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g' } });
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', angle: 0 } });
    const names = createBrowserSystemTracesSampler()().map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['browser_memory_used_heap', 'connection', 'orientation']),
    );
    vi.unstubAllGlobals();
  });
});
