import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkerEnvironment, realWorkerProbe, type WorkerProbe } from './environment';

afterEach(() => vi.restoreAllMocks());

const probe = (over: Partial<WorkerProbe> = {}): WorkerProbe => ({
  userAgent: () => 'Mozilla/5.0 Worker',
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
    expect(env.platform).toMatchObject({
      type: 'web-worker',
      version: 'Mozilla/5.0 Worker',
      utc_offset: 120,
      locale: 'en-US',
      memory_total: 8 * 1024 ** 3,
    });
    expect(env.hardware).toEqual({
      device_id: null,
      cpu_count: 4,
      memory_total: 8 * 1024 ** 3,
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

  it('supports the service-worker platform type', () => {
    expect(
      buildWorkerEnvironment({ sdkVersion: '1', platformType: 'service-worker' }, probe()).platform
        .type,
    ).toBe('service-worker');
  });

  it('omits cpu_count + memory_total when the probe does not expose them', () => {
    const env = buildWorkerEnvironment(
      { sdkVersion: '1', platformType: 'web-worker' },
      probe({ deviceMemoryBytes: () => undefined, cpuCount: () => undefined }),
    );
    expect(env.platform).not.toHaveProperty('memory_total');
    expect(env.hardware).toEqual({ device_id: null }); // only the device id remains
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
