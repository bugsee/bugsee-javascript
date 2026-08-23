import os from 'node:os';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import {
  buildNodeEnvironment,
  osPlatformToWire,
  realSystemProbe,
  type SystemProbe,
} from './environment';

const fakeProbe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '24.0.0',
  osType: () => 'Darwin',
  osPlatform: () => 'darwin',
  osRelease: () => '25.5.0',
  osArch: () => 'arm64',
  machine: () => 'arm64',
  cpuCount: () => 8,
  totalMemory: () => 17_179_869_184,
  freeMemory: () => 3_221_225_472,
  utcOffsetMinutes: () => 120,
  locale: () => 'en-US',
};

describe('buildNodeEnvironment — platform', () => {
  it('maps the probe into the node platform section (§8.6)', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' }, fakeProbe);
    // platform is the OS, NOT the runtime: `type`/`version` are what the backend indexes as the
    // platform key and `os_version`. They used to carry 'node'/'24.0.0', which made os_version read
    // back as a Node version and left the real OS scattered across kernel_version + hardware.
    expect(env.platform).toEqual({
      type: 'macos',
      version: '25.5.0',
      kernel_version: '25.5.0',
      arch: 'arm64',
      utc_offset: 120,
      // MEGABYTES, not bytes — the unit every SDK puts on the wire and the viewer renders as GB.
      memory_total: 16_384,
      memory_free: 3072,
      locale: 'en-US',
    });
  });

  it('puts the JS runtime in its OWN block, not in platform', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' }, fakeProbe);
    expect(env.runtime).toEqual({ type: 'node', version: '24.0.0' });
    // ...and the two are now independent: neither leaks into the other.
    expect(env.platform.type).not.toBe('node');
    expect(env.platform.version).not.toBe('24.0.0');
  });

  it('drives runtime.type and version FROM the probe (not a hardcoded node identity)', () => {
    // A non-node probe (e.g. the Bun tier injects its own) must surface its own identity verbatim —
    // and only its identity: swapping the RUNTIME must not change the reported OS.
    const env = buildNodeEnvironment(
      { sdkVersion: '1.0.0' },
      { ...fakeProbe, platformType: () => 'bun', runtimeVersion: () => '1.1.0' },
    );
    expect(env.runtime).toEqual({ type: 'bun', version: '1.1.0' });
    expect(env.platform.type).toBe('macos');
    expect(env.platform.version).toBe('25.5.0');
  });

  it('names the OS the way bugsee-rust does, and passes anything else through', () => {
    const typeFor = (osPlatform: string) =>
      buildNodeEnvironment({ sdkVersion: '1.0.0' }, { ...fakeProbe, osPlatform: () => osPlatform })
        .platform.type;
    // The set bugsee-rust's conformance suite asserts for the same hosts.
    expect(typeFor('darwin')).toBe('macos');
    expect(typeFor('win32')).toBe('windows');
    expect(typeFor('linux')).toBe('linux');
    // Anything node can name is still an OS name, and still better than a runtime tag.
    expect(typeFor('freebsd')).toBe('freebsd');
    expect(typeFor('android')).toBe('android');
  });
});

describe('buildNodeEnvironment — memory units', () => {
  // The probe is a raw OS read (os.totalmem/os.freemem are BYTES); the builder owns the wire mapping,
  // exactly as Android's EnvironmentInfoProvider divides before putting the value in the envelope.
  it('converts the probe’s BYTES into wire MEGABYTES', () => {
    const env = buildNodeEnvironment(
      { sdkVersion: '1.0.0' },
      { ...fakeProbe, totalMemory: () => 8 * 1024 ** 3, freeMemory: () => 512 * 1024 ** 2 },
    );
    expect(env.platform.memory_total).toBe(8192);
    expect(env.platform.memory_free).toBe(512);
    expect((env.hardware as { memory_total: number }).memory_total).toBe(8192);
  });

  it('emits memory_free even when the system is nearly full (0 MB free, not an omitted field)', () => {
    const env = buildNodeEnvironment(
      { sdkVersion: '1.0.0' },
      { ...fakeProbe, freeMemory: () => 1024 },
    );
    expect(env.platform.memory_free).toBe(0);
  });

  it('does not put a probe’s NaN/negative reading on the wire', () => {
    const env = buildNodeEnvironment(
      { sdkVersion: '1.0.0' },
      { ...fakeProbe, totalMemory: () => Number.NaN, freeMemory: () => -1 },
    );
    expect(env.platform.memory_total).toBe(0);
    expect(env.platform.memory_free).toBe(0);
  });
});

describe('buildNodeEnvironment — hardware', () => {
  it('maps the probe into the hardware section, with device_id from input', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0', deviceId: 'dev-1' }, fakeProbe);
    expect(env.hardware).toEqual({
      model: 'arm64',
      manufacturer: 'Darwin',
      cpu_count: 8,
      memory_total: 16_384,
      device_id: 'dev-1',
    });
  });

  it('defaults device_id to null when not provided', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' }, fakeProbe);
    expect((env.hardware as { device_id: unknown }).device_id).toBeNull();
  });
});

describe('buildNodeEnvironment — app', () => {
  it('defaults app fields when no app metadata is supplied', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' }, fakeProbe);
    expect(env.app).toEqual({
      package_id: 'unknown',
      version: '0.0.0',
      build: '0',
      debuggable: false,
    });
  });

  it('uses supplied app metadata', () => {
    const env = buildNodeEnvironment(
      {
        sdkVersion: '1.0.0',
        appId: 'com.acme.api',
        appVersion: '2.3.4',
        appBuild: '42',
        debuggable: true,
      },
      fakeProbe,
    );
    expect(env.app).toEqual({
      package_id: 'com.acme.api',
      version: '2.3.4',
      build: '42',
      debuggable: true,
    });
  });
});

describe('buildNodeEnvironment — sdk', () => {
  it('sets sdk version and type, omitting build/options when absent', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.2.3' }, fakeProbe);
    expect(env.sdk).toEqual({ version: '1.2.3', type: 'javascript' });
  });

  it('includes sdk build (git SHA) and wire-translates canonical option keys (dots → colons)', () => {
    const env = buildNodeEnvironment(
      {
        sdkVersion: '1.2.3',
        sdkBuild: 'abc1234',
        options: { 'com.bugsee.option.capture.network': true },
      },
      fakeProbe,
    );
    expect(env.sdk).toEqual({
      version: '1.2.3',
      type: 'javascript',
      build: 'abc1234',
      // dotted canonical key → colon wire form (the server treats dots as nested paths)
      options: { 'com:bugsee:option:capture:network': true },
    });
  });
});

describe('realSystemProbe', () => {
  it('reads real Node/OS values (used by default)', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' });
    expect(env.runtime.type).toBe('node');
    expect(env.runtime.version).toBe(process.versions.node);
    expect(env.platform.type).toBe(osPlatformToWire(os.platform()));
    expect(env.platform.version).toBe(os.release());
    expect(env.platform.arch).toBe(os.arch());
    expect((env.hardware as { cpu_count: number }).cpu_count).toBe(os.cpus().length);
    expect((env.hardware as { memory_total: number }).memory_total).toBe(
      Math.floor(os.totalmem() / 1024 / 1024),
    );
  });

  it('exposes individual probe readers returning the live system values', () => {
    expect(realSystemProbe.platformType()).toBe('node');
    expect(realSystemProbe.runtimeVersion()).toBe(process.versions.node);
    expect(realSystemProbe.osType()).toBe(os.type());
    expect(realSystemProbe.osRelease()).toBe(os.release());
    expect(realSystemProbe.osPlatform()).toBe(os.platform());
    expect(realSystemProbe.osArch()).toBe(os.arch());
    expect(realSystemProbe.machine()).toBe(os.machine());
    expect(realSystemProbe.cpuCount()).toBe(os.cpus().length);
    expect(realSystemProbe.totalMemory()).toBe(os.totalmem()); // BYTES — the raw OS read
    expect(realSystemProbe.freeMemory()).toBeGreaterThan(0);
    expect(realSystemProbe.freeMemory()).toBeLessThanOrEqual(os.totalmem());
    expect(typeof realSystemProbe.utcOffsetMinutes()).toBe('number');
    expect(typeof realSystemProbe.locale()).toBe('string');
  });
});
