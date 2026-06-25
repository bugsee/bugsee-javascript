import { describe, expect, it } from 'vitest';
import { buildEdgeEnvironment } from './environment';

describe('buildEdgeEnvironment', () => {
  it('builds a minimal envelope with the edge platform type + sdk + app (no hardware)', () => {
    const env = buildEdgeEnvironment({
      sdkVersion: '1.2.3',
      platformType: 'edge-light',
      appId: 'com.acme.api',
      appVersion: '4.5.6',
      appBuild: '789',
      utcOffsetMinutes: 120,
      locale: 'en-US',
    });
    expect(env.platform.type).toBe('edge-light');
    expect(env.platform.utc_offset).toBe(120);
    expect(env.platform.locale).toBe('en-US');
    expect(env.hardware).toBeUndefined(); // edge has no os/cpu/memory access
    expect(env.app).toMatchObject({
      package_id: 'com.acme.api',
      version: '4.5.6',
      build: '789',
      debuggable: false,
    });
    expect(env.sdk).toMatchObject({ version: '1.2.3', type: 'javascript' });
  });

  it('supports the `workers` platform type', () => {
    expect(buildEdgeEnvironment({ sdkVersion: '1', platformType: 'workers' }).platform.type).toBe(
      'workers',
    );
  });

  it('defaults the runtime version to empty + app fields to the design defaults', () => {
    const env = buildEdgeEnvironment({ sdkVersion: '1', platformType: 'edge-light', locale: 'x' });
    expect(env.platform.version).toBe(''); // edge runtimes expose no clean version
    expect(env.app).toMatchObject({ package_id: 'unknown', version: '0.0.0', build: '0' });
  });

  it('carries the runtime version + sdk build when provided', () => {
    const env = buildEdgeEnvironment({
      sdkVersion: '1',
      platformType: 'edge-light',
      runtimeVersion: 'edge-runtime/3.0.0',
      sdkBuild: 'abc123',
      locale: 'x',
    });
    expect(env.platform.version).toBe('edge-runtime/3.0.0');
    expect(env.sdk.build).toBe('abc123');
  });

  it('omits sdk.build + sdk.options when not provided', () => {
    const env = buildEdgeEnvironment({ sdkVersion: '1', platformType: 'edge-light', locale: 'x' });
    expect('build' in env.sdk).toBe(false);
    expect('options' in env.sdk).toBe(false);
  });

  it('wire-translates canonical dotted option keys to colon form (sdk.options)', () => {
    const env = buildEdgeEnvironment({
      sdkVersion: '1',
      platformType: 'edge-light',
      locale: 'x',
      options: { 'com.bugsee.option.MaxDataSize': 10 },
    });
    expect(env.sdk.options).toEqual({ 'com:bugsee:option:MaxDataSize': 10 });
  });

  it('falls back to the real timezone offset + locale when not injected', () => {
    const env = buildEdgeEnvironment({ sdkVersion: '1', platformType: 'edge-light' });
    expect(typeof env.platform.utc_offset).toBe('number');
    expect(typeof env.platform.locale).toBe('string');
  });
});
