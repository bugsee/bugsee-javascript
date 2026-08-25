import { describe, expect, it, vi } from 'vitest';
import { type BrowserTracesEnv, createBrowserSystemTracesSampler } from './system-metrics';

const memory = { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sample = (env: BrowserTracesEnv) => createBrowserSystemTracesSampler(env)();

describe('createBrowserSystemTracesSampler', () => {
  it('samples performance.memory as the GROUPED ram_js_heap_* series', () => {
    // Renamed from `browser_memory_*`, which no consumer knew: the viewer had no title and no group
    // for it, so it rendered as three unlabelled, ungrouped lines. `ram_js_heap_*` follows the
    // established `ram_<runtime>_heap_{total,free,used}` convention (cf. ram_jvm_heap on Android) and
    // is rendered as one stacked area.
    //
    // The Android semantics are matched exactly: `total` is the heap CEILING and `free` is
    // total - used. That makes jsHeapSizeLimit the total (Android's heapSize is the max heap), not
    // totalJSHeapSize, which is merely what V8 has committed so far.
    expect(sample({ performance: { memory } })).toEqual([
      { name: 'ram_js_heap_total', value: 3 }, // jsHeapSizeLimit
      { name: 'ram_js_heap_free', value: 2 }, // limit - used
      { name: 'ram_js_heap_used', value: 1 }, // usedJSHeapSize
    ]);
  });

  it('emits none of the old browser_memory_* names', () => {
    // The rename is the point: those three names had no title and no group anywhere in the viewer, so
    // they rendered as unlabelled lines. Nothing may still emit them.
    const named = sample({ performance: { memory } }).map((t) => t.name);
    for (const gone of [
      'browser_memory_used_heap',
      'browser_memory_total_heap',
      'browser_memory_heap_limit',
    ]) {
      expect(named).not.toContain(gone);
    }
  });

  it('does NOT report totalJSHeapSize — deliberately, and this pins that decision', () => {
    // totalJSHeapSize (what V8 has committed so far) sits between used and the limit. It has no
    // Android counterpart, and adding it as a fourth series would break the stacked area, since
    // free + used already equals total. Dropped rather than shoehorned in; revisit only with a
    // viewer group that has somewhere to put it.
    const values = sample({ performance: { memory } }).map((t) => t.value);
    expect(values).toEqual([3, 2, 1]); // limit, limit-used, used — no 'committed' anywhere
  });

  it('samples navigator.deviceMemory as ram_system_advertised, in BYTES', () => {
    // deviceMemory is a rounded, deliberately-coarse bucket — 32 on a 64 GB machine — so it is NOT
    // the environment's `memory_total` (which means real RAM everywhere else). Android already has
    // the right name for a figure like this: `ram_system_advertised`, "the advertised memory of the
    // system, as the end user would encounter in a retail display environment... might be different
    // from getSystemTotalMemory()". The viewer already groups and titles it ("Advertised", under
    // System memory (RAM)), so this needs no viewer or backend change.
    expect(
      sample({ navigator: { onLine: true, deviceMemoryBytes: 8 * 1024 ** 3 } }),
    ).toContainEqual({
      name: 'ram_system_advertised',
      value: 8 * 1024 ** 3, // bytes, matching Android's ram_* traces and the dataSize measure
    });
  });

  it('omits ram_system_advertised where deviceMemory is unsupported (Safari/Firefox)', () => {
    const names = sample({ navigator: { onLine: true } }).map((t) => t.name);
    expect(names).not.toContain('ram_system_advertised');
  });

  it('samples navigator.connection with a TRANSPORT type the viewer can render', () => {
    // `type` must be a CONNECTION_STATES key. It used to carry effectiveType ('4g'), which is in no
    // table, so the row rendered as [object Object]. effectiveType survives as detail.
    expect(
      sample({
        navigator: {
          onLine: true,
          connection: { type: 'wifi', effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
        },
      }),
    ).toEqual([
      {
        name: 'connection',
        value: {
          type: 'wifi',
          effective_type: '4g',
          link_downstream_kbps: 10_000, // downlink is Mbps; Android reports kbps
          rtt: 50,
          save_data: false,
        },
      },
    ]);
  });

  it('reports the connection as not_reachable when the browser says it is offline', () => {
    expect(
      sample({ navigator: { onLine: false, connection: { type: 'wifi' } } })[0]?.value,
    ).toMatchObject({ type: 'not_reachable' });
  });

  it('samples the connection even with NO NetworkInformation, because onLine alone is worth it', () => {
    // Safari and Firefox have no navigator.connection at all. The trace used to be omitted entirely
    // there; online/offline is the fact a reader most wants and every browser reports it.
    expect(sample({ navigator: { onLine: true } })).toEqual([
      { name: 'connection', value: { type: 'unknown' } },
    ]);
  });

  it('samples screen.orientation as the Android-enum INT, not the browser object', () => {
    expect(sample({ screen: { orientation: { type: 'landscape-primary', angle: 90 } } })).toEqual([
      { name: 'orientation', value: 3 }, // Android Orientation.LandscapeLeft — see system-trace-values
    ]);
    expect(sample({ screen: { orientation: { type: 'portrait-primary', angle: 0 } } })).toEqual([
      { name: 'orientation', value: 1 }, // Portrait
    ]);
  });

  it('samples the cached battery as battery (rounded 0-100) + charging once getBattery resolves', async () => {
    const sampler = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => Promise.resolve({ level: 0.426, charging: true }) },
    });
    // Before getBattery resolves: only the connection trace a `navigator` always yields.
    expect(sampler()).toEqual([{ name: 'connection', value: { type: 'unknown' } }]);
    await tick();
    expect(sampler().filter((t) => t.name !== 'connection')).toEqual([
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
    // A `navigator` now always yields a connection trace (onLine alone is worth reporting), so the
    // battery assertions filter to what they are about.
    const batteryOf = () => sampler().filter((t) => t.name !== 'connection');
    expect(batteryOf()).toEqual([
      { name: 'battery', value: 50 },
      { name: 'charging', value: false },
    ]);
    manager.level = 0.8; // the real BatteryManager mutates its properties in place
    manager.charging = true;
    expect(batteryOf()).toEqual([
      { name: 'battery', value: 80 }, // re-read live (not a one-time snapshot)
      { name: 'charging', value: true },
    ]);
  });

  it('omits battery when getBattery rejects (unsupported / denied)', async () => {
    const sampler = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => Promise.reject(new Error('denied')) },
    });
    await tick();
    // Only the connection trace, which a `navigator` always produces — no battery/charging.
    expect(sampler()).toEqual([{ name: 'connection', value: { type: 'unknown' } }]);
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
      'ram_js_heap_total',
      'ram_js_heap_free',
      'ram_js_heap_used',
      'connection',
      'orientation',
      'battery',
      'charging',
    ]);
  });

  it('defaults to the real globals (performance/navigator/screen)', () => {
    vi.stubGlobal('performance', { memory });
    vi.stubGlobal('navigator', { onLine: true, connection: { effectiveType: '4g' } });
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', angle: 0 } });
    const names = createBrowserSystemTracesSampler()().map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['ram_js_heap_used', 'connection', 'orientation']),
    );
    vi.unstubAllGlobals();
  });
});
