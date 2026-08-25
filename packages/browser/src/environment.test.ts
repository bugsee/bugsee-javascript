import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserProbe, buildBrowserEnvironment, realBrowserProbe } from './environment';

// A probe with every reader populated (the Chromium-rich case).
const CHROME_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

const fullProbe: BrowserProbe = {
  userAgent: () => CHROME_MAC_UA,
  uaDataPlatform: () => 'macOS',
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

describe('buildBrowserEnvironment — platform is the OS, not the runtime', () => {
  it('reports the host OS and its version, not the sandbox tag and the user agent', () => {
    // The defect this replaced (samples/FINDINGS.md F-X20): the web tier sent `type: 'web'` and the
    // WHOLE user-agent string as `version` — the field the backend indexes as `os_version` — so a
    // browser session was the only kind of Bugsee session that named no operating system at all.
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, fullProbe);
    expect(env.platform).toEqual({
      type: 'macos',
      version: '10.15.7',
      utc_offset: -480,
      locale: 'en-GB',
      memory_total: 8192, // MB on the wire, from an 8 GiB deviceMemory reading
    });
    expect(env.platform.version).not.toContain('Mozilla'); // never the UA string again
  });

  it('omits memory_total when deviceMemory is unsupported', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, minimalProbe);
    expect(env.platform).toEqual({
      type: 'macos',
      version: '10.15.7',
      utc_offset: -480,
      locale: 'en-GB',
    });
    expect('memory_total' in env.platform).toBe(false);
  });

  it('falls back to the parsed user agent when UA-CH is unavailable (Firefox/Safari)', () => {
    const firefoxProbe: BrowserProbe = {
      ...fullProbe,
      userAgent: () =>
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      uaDataPlatform: () => undefined,
    };
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, firefoxProbe);
    expect(env.platform.type).toBe('windows');
    expect(env.platform.version).toBe('10');
  });

  it('survives a probe with NO uaDataPlatform at all, falling back to the user agent', () => {
    // `systemProbe` is a PUBLIC launch option (packages/browser/src/launch.ts:212), so a caller can
    // hand us a probe built against an older shape of this interface. Calling a method it does not
    // have threw a TypeError inside the environment build — which happens during report ASSEMBLY, so
    // the symptom was every report silently vanishing, not a visible crash. Found by the replay e2e,
    // whose fixture was cast `as never` and so escaped the compiler entirely.
    const { uaDataPlatform: _omitted, ...withoutUaData } = fullProbe;
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, withoutUaData as BrowserProbe);
    expect(env.platform.type).toBe('macos'); // parsed from the UA instead
    expect(env.platform.version).toBe('10.15.7');
  });

  it('prefers the browser’s DECLARED platform over a disagreeing user agent', () => {
    const spoofed: BrowserProbe = { ...fullProbe, uaDataPlatform: () => 'Windows' };
    expect(buildBrowserEnvironment({ sdkVersion: '1.0.0' }, spoofed).platform.type).toBe('windows');
  });
});

describe('buildBrowserEnvironment — browser identity', () => {
  it('fills the browser block the backend has always declared', () => {
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, fullProbe);
    expect(env.browser).toEqual({ type: 'Chrome', version: '119.0.0.0' });
  });

  it('puts the BROWSER version in runtime.version, which used to be empty', () => {
    // `runtime.type` stays 'web' (it is a closed enum the schema pins); its version had nowhere to
    // come from while the browser identity was unparsed, so every web session shipped ''.
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, fullProbe);
    expect(env.runtime).toEqual({ type: 'web', version: '119.0.0.0' });
  });

  it('omits the browser block entirely when the agent cannot be identified', () => {
    // A half-filled `{type: '', version: ''}` would render as an empty, icon-less Browser section in
    // the viewer. Absent is better than blank.
    const unknown: BrowserProbe = { ...fullProbe, userAgent: () => 'SomeRobot/1.0' };
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' }, unknown);
    expect(env.browser).toBeUndefined();
    expect('browser' in env).toBe(false);
    expect(env.runtime).toEqual({ type: 'web', version: '' });
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

  it('reads navigator.userAgentData.platform where the browser exposes it', () => {
    // The reader is OPTIONAL on the interface (a caller's own probe may predate it), but the REAL
    // probe must implement it — asserted explicitly, so `?.()` below cannot pass by short-circuiting
    // if the method were ever dropped.
    expect(typeof realBrowserProbe.uaDataPlatform).toBe('function');
    vi.stubGlobal('navigator', { userAgent: 'UA/9', userAgentData: { platform: 'macOS' } });
    expect(realBrowserProbe.uaDataPlatform?.()).toBe('macOS');
  });

  it('returns undefined for uaDataPlatform on a browser without UA-CH', () => {
    expect(typeof realBrowserProbe.uaDataPlatform).toBe('function');
    vi.stubGlobal('navigator', { userAgent: 'UA/9' });
    expect(realBrowserProbe.uaDataPlatform?.()).toBeUndefined();
    // ...and when userAgentData exists but carries no platform (a partial/polyfilled shim).
    vi.stubGlobal('navigator', { userAgent: 'UA/9', userAgentData: {} });
    expect(realBrowserProbe.uaDataPlatform?.()).toBeUndefined();
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
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    });
    vi.stubGlobal('screen', { width: 1024, height: 768 });
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const env = buildBrowserEnvironment({ sdkVersion: '1.0.0' });
    expect(env.platform.type).toBe('linux');
    expect(env.browser).toEqual({ type: 'Chrome', version: '119.0.0.0' });
    expect((env.hardware as { screen_width: number }).screen_width).toBe(1024);
  });
});
