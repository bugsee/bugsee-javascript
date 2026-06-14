import process from 'node:process';
import { realSystemProbe } from '@bugsee/node';
import { describe, expect, it } from 'vitest';
import { bunSystemProbe, createBunSystemProbe } from './environment';

describe('createBunSystemProbe — runtime identity', () => {
  it('reports platform.type "bun"', () => {
    expect(createBunSystemProbe({ node: '22.0.0' }).platformType()).toBe('bun');
  });

  it('uses process.versions.bun as the runtime version when present', () => {
    expect(createBunSystemProbe({ bun: '1.1.34', node: '22.0.0' }).runtimeVersion()).toBe('1.1.34');
  });

  it('falls back to the node-compat version when bun is absent (e.g. run under Node)', () => {
    expect(createBunSystemProbe({ node: '22.0.0' }).runtimeVersion()).toBe('22.0.0');
  });
});

describe('bunSystemProbe — defaults + reuse', () => {
  it('defaults its versions to the live process.versions', () => {
    // Under Node/Vitest `process.versions.bun` is undefined → falls back to the node-compat version.
    expect(bunSystemProbe.platformType()).toBe('bun');
    expect(bunSystemProbe.runtimeVersion()).toBe(process.versions.bun ?? process.versions.node);
  });

  it("reuses node's real OS/CPU/memory/locale readers (Bun is node-API-compatible)", () => {
    expect(bunSystemProbe.osType()).toBe(realSystemProbe.osType());
    expect(bunSystemProbe.osRelease()).toBe(realSystemProbe.osRelease());
    expect(bunSystemProbe.machine()).toBe(realSystemProbe.machine());
    expect(bunSystemProbe.cpuCount()).toBe(realSystemProbe.cpuCount());
    expect(bunSystemProbe.totalMemory()).toBe(realSystemProbe.totalMemory());
    expect(typeof bunSystemProbe.utcOffsetMinutes()).toBe('number');
    expect(typeof bunSystemProbe.locale()).toBe('string');
  });
});
