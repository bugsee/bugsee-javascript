import os from 'node:os';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { buildNodeEnvironment, realSystemProbe, type SystemProbe } from './environment';

const fakeProbe: SystemProbe = {
  nodeVersion: () => '24.0.0',
  osType: () => 'Darwin',
  osRelease: () => '25.5.0',
  machine: () => 'arm64',
  cpuCount: () => 8,
  totalMemory: () => 17_179_869_184,
  utcOffsetMinutes: () => 120,
  locale: () => 'en-US',
};

describe('buildNodeEnvironment — platform', () => {
  it('maps the probe into the node platform section (§8.6)', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' }, fakeProbe);
    expect(env.platform).toEqual({
      type: 'node',
      version: '24.0.0',
      kernel_version: '25.5.0',
      utc_offset: 120,
      memory_total: 17_179_869_184,
      locale: 'en-US',
    });
  });
});

describe('buildNodeEnvironment — hardware', () => {
  it('maps the probe into the hardware section, with device_id from input', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0', deviceId: 'dev-1' }, fakeProbe);
    expect(env.hardware).toEqual({
      model: 'arm64',
      manufacturer: 'Darwin',
      cpu_count: 8,
      memory_total: 17_179_869_184,
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

  it('includes sdk build (git SHA) and sanitized options when provided', () => {
    const env = buildNodeEnvironment(
      { sdkVersion: '1.2.3', sdkBuild: 'abc1234', options: { 'capture.network': true } },
      fakeProbe,
    );
    expect(env.sdk).toEqual({
      version: '1.2.3',
      type: 'javascript',
      build: 'abc1234',
      options: { 'capture.network': true },
    });
  });
});

describe('realSystemProbe', () => {
  it('reads real Node/OS values (used by default)', () => {
    const env = buildNodeEnvironment({ sdkVersion: '1.0.0' });
    expect(env.platform.type).toBe('node');
    expect(env.platform.version).toBe(process.versions.node);
    expect((env.hardware as { cpu_count: number }).cpu_count).toBe(os.cpus().length);
    expect((env.hardware as { memory_total: number }).memory_total).toBe(os.totalmem());
  });

  it('exposes individual probe readers returning the live system values', () => {
    expect(realSystemProbe.nodeVersion()).toBe(process.versions.node);
    expect(realSystemProbe.osType()).toBe(os.type());
    expect(realSystemProbe.osRelease()).toBe(os.release());
    expect(realSystemProbe.machine()).toBe(os.machine());
    expect(realSystemProbe.cpuCount()).toBe(os.cpus().length);
    expect(realSystemProbe.totalMemory()).toBe(os.totalmem());
    expect(typeof realSystemProbe.utcOffsetMinutes()).toBe('number');
    expect(typeof realSystemProbe.locale()).toBe('string');
  });
});
