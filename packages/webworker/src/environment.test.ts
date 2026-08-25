import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkerEnvironment, realWorkerProbe, type WorkerProbe } from './environment';

afterEach(() => vi.restoreAllMocks());

// A real Chrome-on-Windows agent: the builder derives the OS and the browser from this now, so a
// synthetic string would make the platform assertions meaningless.
const CHROME_WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const probe = (over: Partial<WorkerProbe> = {}): WorkerProbe => ({
  userAgent: () => CHROME_WIN_UA,
  uaDataPlatform: () => 'Windows',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 120,
  deviceMemoryBytes: () => 8 * 1024 ** 3,
  cpuCount: () => 4,
  ...over,
});

describe('buildWorkerEnvironment', () => {
  it('builds the worker envelope: platform identity + navigator hardware (NO screen)', () => {
    const env = buildWorkerEnvironment(
      {
        sdkVersion: '1.2.3',
        platformType: 'web-worker',
        appId: 'com.acme.worker',
        appVersion: '4.5.6',
        appBuild: '789',
      },
      probe(),
    );
    // The OS, exactly as the browser tier reports it. `platform` used to carry the WORKER tag and the
    // raw user agent — the same F-X20 conflation, and a worker's `navigator` is just as readable.
    expect(env.platform).toMatchObject({
      type: 'windows',
      version: '10',
      utc_offset: 120,
      locale: 'en-US',
      memory_total: 8192, // MB on the wire
    });
    expect(env.platform.version).not.toContain('Mozilla');
    // The worker variant keeps its own slot, which is what `runtime` is for.
    expect(env.runtime).toEqual({ type: 'web-worker', version: '120.0.0.0' });
    expect(env.browser).toEqual({ type: 'Chrome', version: '120.0.0.0' });
    expect(env.hardware).toEqual({
      device_id: null,
      cpu_count: 4,
      memory_total: 8192, // MB on the wire
    });
    expect(env.hardware).not.toHaveProperty('screen_width'); // a worker has no screen
    expect(env.app).toMatchObject({
      package_id: 'com.acme.worker',
      version: '4.5.6',
      build: '789',
      debuggable: false,
    });
    expect(env.sdk).toMatchObject({ version: '1.2.3', type: 'javascript' });
  });

  it('supports the service-worker runtime type, without disturbing the OS', () => {
    const env = buildWorkerEnvironment(
      { sdkVersion: '1', platformType: 'service-worker' },
      probe(),
    );
    expect(env.runtime.type).toBe('service-worker');
    expect(env.platform.type).toBe('windows'); // still the OS — the worker kind does not overwrite it
  });

  it('omits cpu_count + memory_total when the probe does not expose them', () => {
    const env = buildWorkerEnvironment(
      { sdkVersion: '1', platformType: 'web-worker' },
      probe({ deviceMemoryBytes: () => undefined, cpuCount: () => undefined }),
    );
    expect(env.platform).not.toHaveProperty('memory_total');
    // toStrictEqual, not toEqual: `toEqual` ignores keys whose value is `undefined`, so it passed just as
    // happily when the conditional spreads degraded into unconditional ones and the envelope carried
    // `cpu_count: undefined` / `memory_total: undefined` — i.e. it did not check the omission its name
    // claims. Mutating both spreads to unconditional survived the whole suite.
    expect(env.hardware).toStrictEqual({ device_id: null }); // only the device id remains
  });

  it('carries the device id, sdk build, and wire-translated options', () => {
    const env = buildWorkerEnvironment(
      {
        sdkVersion: '1',
        platformType: 'web-worker',
        deviceId: 'dev-abc',
        sdkBuild: 'sha123',
        options: { 'com.bugsee.option.MaxDataSize': 10 },
      },
      probe(),
    );
    expect((env.hardware as { device_id: string }).device_id).toBe('dev-abc');
    expect(env.sdk.build).toBe('sha123');
    expect(env.sdk.options).toEqual({ 'com:bugsee:option:MaxDataSize': 10 });
  });

  it('omits sdk.build + sdk.options + defaults app fields when not provided', () => {
    const env = buildWorkerEnvironment({ sdkVersion: '1', platformType: 'web-worker' }, probe());
    expect('build' in env.sdk).toBe(false);
    expect('options' in env.sdk).toBe(false);
    expect(env.app).toMatchObject({ package_id: 'unknown', version: '0.0.0', build: '0' });
  });

  it('realWorkerProbe reads navigator / Intl / Date (negated offset, deviceMemory → bytes)', () => {
    vi.stubGlobal('navigator', { userAgent: 'UA/worker', hardwareConcurrency: 8, deviceMemory: 4 });
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-60); // UTC+1
    expect(realWorkerProbe.userAgent()).toBe('UA/worker');
    expect(realWorkerProbe.cpuCount()).toBe(8);
    expect(realWorkerProbe.deviceMemoryBytes()).toBe(4 * 1024 ** 3);
    expect(realWorkerProbe.utcOffsetMinutes()).toBe(60); // negated → positive-east
    expect(typeof realWorkerProbe.locale()).toBe('string');
  });

  it('realWorkerProbe deviceMemoryBytes is undefined when navigator.deviceMemory is absent (non-Chromium)', () => {
    vi.stubGlobal('navigator', { userAgent: 'UA', hardwareConcurrency: 2 });
    expect(realWorkerProbe.deviceMemoryBytes()).toBeUndefined();
    expect(realWorkerProbe.cpuCount()).toBe(2);
  });
});
