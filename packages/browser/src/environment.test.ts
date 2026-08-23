import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserProbe, buildBrowserEnvironment, realBrowserProbe } from './environment';

// A probe with every reader populated (the Chromium-rich case).
const fullProbe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 (Test) Browser/1.0',
  locale: () => 'en-GB',
  utcOffsetMinutes: () => -480,
  screenWidth: () => 1920,
  screenHeight: () => 1080,
  pixelRatio: () => 2,
  deviceMemoryBytes: () => 8 * 1024 ** 3,
  cpuCount: () => 16,
};

// The non-Chromium case: deviceMemory + hardwareConcurrency unsupported.
const minimalProbe: BrowserProbe = {
  ...fullProbe,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

// A defined-but-zero case: the omit guards are `!== undefined`, NOT truthiness, so a real 0 is kept.
const zeroProbe: BrowserProbe = {
  ...fullProbe,
  deviceMemoryBytes: () => 0,
  cpuCount: () => 0,
};

describe('buildBrowserEnvironment — platform', () => {
  it('maps the probe into the web platform section', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, fullProbe);
    expect(env.platform).toEqual({
      type: 'web',
      version: 'Mozilla/5.0 (Test) Browser/1.0',
      utc_offset: -480,
      locale: 'en-GB',
      memory_total: 8192, // MB on the wire, from an 8 GiB deviceMemory reading
    });
  });

  it('omits memory_total when deviceMemory is unsupported', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, minimalProbe);
    expect(env.platform).toEqual({
      type: 'web',
      version: 'Mozilla/5.0 (Test) Browser/1.0',
      utc_offset: -480,
      locale: 'en-GB',
    });
    expect('memory_total' in env.platform).toBe(false);
  });
});

describe('buildBrowserEnvironment — hardware', () => {
  it('maps screen/pixel/cpu/memory, with device_id from input', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0', deviceId: 'dev-1' }, fullProbe);
    expect(env.hardware).toEqual({
      screen_width: 1920,
      screen_height: 1080,
      pixel_ratio: 2,
      device_id: 'dev-1',
      cpu_count: 16,
      memory_total: 8192, // MB on the wire, from an 8 GiB deviceMemory reading
    });
  });

  it('omits cpu_count and memory_total when unsupported, defaults device_id to null', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, minimalProbe);
    expect(env.hardware).toEqual({
      screen_width: 1920,
      screen_height: 1080,
      pixel_ratio: 2,
      device_id: null,
    });
    // The keys must be truly ABSENT, not present-with-undefined (which toEqual silently ignores).
    expect('cpu_count' in (env.hardware as object)).toBe(false);
    expect('memory_total' in (env.hardware as object)).toBe(false);
  });

  it('keeps a defined-but-zero memory_total / cpu_count (omit guard is !== undefined, not falsy)', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, zeroProbe);
    expect('memory_total' in env.platform).toBe(true);
    expect(env.platform.memory_total).toBe(0);
    expect((env.hardware as { memory_total: unknown }).memory_total).toBe(0);
    expect((env.hardware as { cpu_count: unknown }).cpu_count).toBe(0);
  });
});

describe('buildBrowserEnvironment — app', () => {
  it('defaults app fields when no app metadata is supplied', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, fullProbe);
    expect(env.app).toEqual({
      package_id: 'unknown',
      version: '0.0.0',
      build: '0',
      debuggable: false,
    });
  });

  it('preserves explicit empty-string identity fields (?? keeps "", does not substitute defaults)', () => {
    const env = buildBrowserEnvironment(
      { sdkVersion: '1.0.0', deviceId: '', appId: '', appVersion: '', appBuild: '' },
      fullProbe,
    );
    expect((env.hardware as { device_id: unknown }).device_id).toBe('');
    expect(env.app).toEqual({ package_id: '', version: '', build: '', debuggable: false });
  });

  it('uses supplied app metadata', () => {
    const env = buildBrowserEnvironment(
      {
        sdkVersion: '1.0.0',
        appId: 'com.acme.web',
        appVersion: '2.3.4',
        appBuild: '42',
        debuggable: true,
      },
      fullProbe,
    );
    expect(env.app).toEqual({
      package_id: 'com.acme.web',
      version: '2.3.4',
      build: '42',
      debuggable: true,
    });
  });
});

describe('buildBrowserEnvironment — sdk', () => {
  it('sets sdk version and type, omitting build/options when absent', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.2.3' }, fullProbe);
    expect(env.sdk).toEqual({ version: '1.2.3', type: 'javascript' });
    // Truly ABSENT, not present-with-undefined (which toEqual silently ignores).
    expect('build' in env.sdk).toBe(false);
    expect('options' in env.sdk).toBe(false);
  });

  it('keeps a defined-but-empty sdk build (omit guard is !== undefined, not falsy)', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.2.3', sdkBuild: '' }, fullProbe);
    expect('build' in env.sdk).toBe(true);
    expect(env.sdk.build).toBe('');
  });

  it('includes sdk build and wire-translates canonical option keys (dots → colons)', () => {
    const env = buildBrowserEnvironment(
      {
        sdkVersion: '1.2.3',
        sdkBuild: 'abc1234',
        options: { 'com.bugsee.option.capture.network': true },
      },
      fullProbe,
    );
    expect(env.sdk).toEqual({
      version: '1.2.3',
      type: 'javascript',
      build: 'abc1234',
      options: { 'com:bugsee:option:capture:network': true },
    });
  });
});

describe('realBrowserProbe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads navigator / screen / window values (used by default)', () => {
    vi.stubGlobal('navigator', { userAgent: 'UA/9', hardwareConcurrency: 12, deviceMemory: 4 });
    vi.stubGlobal('screen', { width: 800, height: 600 });
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(realBrowserProbe.userAgent()).toBe('UA/9');
    expect(realBrowserProbe.screenWidth()).toBe(800);
    expect(realBrowserProbe.screenHeight()).toBe(600);
    expect(realBrowserProbe.pixelRatio()).toBe(3);
    expect(realBrowserProbe.cpuCount()).toBe(12);
    expect(realBrowserProbe.deviceMemoryBytes()).toBe(4 * 1024 ** 3);
  });

  it('locale comes from Intl resolvedOptions (host-independent)', () => {
    // Control the Intl source so a constant-string mutant is caught regardless of the host locale.
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ locale: 'zz-ZZ' } as Intl.ResolvedDateTimeFormatOptions);
    expect(realBrowserProbe.locale()).toBe('zz-ZZ');
    spy.mockRestore();
  });

  it('utcOffsetMinutes negates getTimezoneOffset (positive east), robust to the host TZ', () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300); // UTC-5
    expect(realBrowserProbe.utcOffsetMinutes()).toBe(-300); // a dropped `-` would yield 300
    spy.mockRestore();
  });

  it('returns undefined for deviceMemory/cpuCount when the navigator lacks them', () => {
    vi.stubGlobal('navigator', { userAgent: 'UA' });
    expect(realBrowserProbe.deviceMemoryBytes()).toBeUndefined();
    expect(realBrowserProbe.cpuCount()).toBeUndefined();
  });

  it('is the default probe used by buildBrowserEnvironment', () => {
    vi.stubGlobal('navigator', { userAgent: 'Default-UA' });
    vi.stubGlobal('screen', { width: 1024, height: 768 });
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' });
    expect(env.platform.type).toBe('web');
    expect(env.platform.version).toBe('Default-UA');
    expect((env.hardware as { screen_width: number }).screen_width).toBe(1024);
  });
});
