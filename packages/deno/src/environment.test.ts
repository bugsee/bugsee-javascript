import process from 'node:process';
import { realSystemProbe } from '@bugsee/node';
import { afterEach, describe, expect, it } from 'vitest';
import { createDenoSystemProbe, denoSystemProbe } from './environment';

afterEach(() => {
  delete (globalThis as { Deno?: unknown }).Deno;
});

describe('createDenoSystemProbe — runtime identity', () => {
  it('reports platform.type "deno"', () => {
    expect(createDenoSystemProbe('2.1.4', '22.0.0').platformType()).toBe('deno');
  });

  it('uses the Deno version when present', () => {
    expect(createDenoSystemProbe('2.1.4', '22.0.0').runtimeVersion()).toBe('2.1.4');
  });

  it('falls back to the node-compat version when Deno is absent (e.g. run under Node)', () => {
    expect(createDenoSystemProbe(undefined, '22.0.0').runtimeVersion()).toBe('22.0.0');
  });

  it('reads the live Deno.version.deno when the global is present', () => {
    (globalThis as { Deno?: unknown }).Deno = { version: { deno: '2.0.0' } };
    expect(createDenoSystemProbe(undefined, '22.0.0').runtimeVersion()).toBe('2.0.0');
  });
});

describe('denoSystemProbe — defaults + reuse', () => {
  it('defaults its version to the live Deno / node-compat fallback', () => {
    // Under Node/Vitest the `Deno` global is absent → falls back to the node-compat version.
    expect(denoSystemProbe.platformType()).toBe('deno');
    expect(denoSystemProbe.runtimeVersion()).toBe(process.versions.node);
  });

  it("reuses node's real OS/CPU/memory/locale readers (Deno is node-API-compatible)", () => {
    expect(denoSystemProbe.osType()).toBe(realSystemProbe.osType());
    expect(denoSystemProbe.osRelease()).toBe(realSystemProbe.osRelease());
    expect(denoSystemProbe.machine()).toBe(realSystemProbe.machine());
    expect(denoSystemProbe.cpuCount()).toBe(realSystemProbe.cpuCount());
    expect(denoSystemProbe.totalMemory()).toBe(realSystemProbe.totalMemory());
    expect(typeof denoSystemProbe.utcOffsetMinutes()).toBe('number');
    expect(typeof denoSystemProbe.locale()).toBe('string');
  });
});
