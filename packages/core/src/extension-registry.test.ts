import { describe, expect, it } from 'vitest';
import { createExtensionRegistry } from './extension-registry';

// Merge test extensions into the registry's typing target so registerExt/ext are exercised through
// their real typed path (NameExtensionMapping is empty in core otherwise).
declare module '@bugsee/types' {
  interface NameExtensionMapping {
    perf: { startSpan(name: string): number };
    flags: { isOn(key: string): boolean };
  }
}

const perfApi = { startSpan: (_name: string) => 1 };
const flagsApi = { isOn: (_key: string) => true };

describe('createExtensionRegistry', () => {
  it('retrieves a registered extension API by name', () => {
    const reg = createExtensionRegistry();
    reg.registerExt('perf', perfApi);
    expect(reg.ext('perf')).toBe(perfApi);
  });

  it('returns the live API so its methods are callable', () => {
    const reg = createExtensionRegistry();
    reg.registerExt('perf', perfApi);
    expect(reg.ext('perf').startSpan('x')).toBe(1);
  });

  it('keeps distinct extensions independent', () => {
    const reg = createExtensionRegistry();
    reg.registerExt('perf', perfApi);
    reg.registerExt('flags', flagsApi);
    expect(reg.ext('perf')).toBe(perfApi);
    expect(reg.ext('flags')).toBe(flagsApi);
  });

  it('throws when retrieving an unregistered extension', () => {
    const reg = createExtensionRegistry();
    expect(() => reg.ext('perf')).toThrow(/Extension "perf" is not registered/);
  });

  it('throws when registering the same name twice', () => {
    const reg = createExtensionRegistry();
    reg.registerExt('perf', perfApi);
    expect(() => reg.registerExt('perf', perfApi)).toThrow(
      /Extension "perf" is already registered/,
    );
  });

  it('hasExt reflects registration state', () => {
    const reg = createExtensionRegistry();
    expect(reg.hasExt('perf')).toBe(false);
    reg.registerExt('perf', perfApi);
    expect(reg.hasExt('perf')).toBe(true);
    expect(reg.hasExt('flags')).toBe(false);
  });

  it('separate registries do not share state', () => {
    const a = createExtensionRegistry();
    const b = createExtensionRegistry();
    a.registerExt('perf', perfApi);
    expect(b.hasExt('perf')).toBe(false);
  });
});
