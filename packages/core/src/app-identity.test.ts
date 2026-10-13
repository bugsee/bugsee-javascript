import { afterEach, describe, expect, it } from 'vitest';
import { bundledAppIdentity, resolveAppIdentity } from './app-identity';

const globals = globalThis as unknown as Record<string, unknown>;

describe('resolveAppIdentity', () => {
  it('prefers the explicit value over every source', () => {
    const resolved = resolveAppIdentity({ version: '2.0.0', build: '7' }, [
      () => ({ version: '1.0.0', build: '3' }),
    ]);
    expect(resolved).toEqual({ version: '2.0.0', build: '7' });
  });

  it('treats an explicit empty string as an explicit choice and does not warn', () => {
    const warnings: string[] = [];
    const resolved = resolveAppIdentity({ version: '' }, [() => ({ version: '1.0.0' })], (m) =>
      warnings.push(m),
    );
    expect(resolved.version).toBe('');
    expect(warnings).toEqual([]);
  });

  it('takes each field from the first source that has it', () => {
    const resolved = resolveAppIdentity({}, [
      () => ({ version: '1.0.0' }),
      () => ({ version: '9.9.9', build: 'abc' }),
    ]);
    expect(resolved).toEqual({ version: '1.0.0', build: 'abc' });
  });

  it('skips blank and non-string source values', () => {
    const resolved = resolveAppIdentity({}, [
      () => ({ version: '  ', build: 5 as unknown as string }),
      () => ({ version: '1.2.3', build: '8' }),
    ]);
    expect(resolved).toEqual({ version: '1.2.3', build: '8' });
  });

  it('contains a throwing or undefined source and carries on', () => {
    const resolved = resolveAppIdentity({}, [
      () => {
        throw new Error('boom');
      },
      () => undefined,
      () => ({ version: '1.0.0' }),
    ]);
    expect(resolved).toEqual({ version: '1.0.0' });
  });

  it('leaves unresolved fields absent and warns once about the missing version', () => {
    const warnings: string[] = [];
    const resolved = resolveAppIdentity({}, [], (m) => warnings.push(m));
    expect(resolved).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('appVersion');
  });

  it('does not warn when only the build is missing', () => {
    const warnings: string[] = [];
    resolveAppIdentity({ version: '1.0.0' }, [], (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it('contains a throwing warn sink', () => {
    expect(() =>
      resolveAppIdentity({}, [], () => {
        throw new Error('sink');
      }),
    ).not.toThrow();
  });
});

describe('bundledAppIdentity', () => {
  afterEach(() => {
    delete globals.__BUGSEE_APP_VERSION__;
    delete globals.__BUGSEE_APP_BUILD__;
  });

  it('is empty when nothing was injected', () => {
    expect(bundledAppIdentity()).toEqual({});
  });

  it('reads the build-time constants (a bundler define, or a global set by the page)', () => {
    globals.__BUGSEE_APP_VERSION__ = '4.5.6';
    globals.__BUGSEE_APP_BUILD__ = '77';
    expect(bundledAppIdentity()).toEqual({ version: '4.5.6', build: '77' });
  });

  it('ignores a non-string value', () => {
    globals.__BUGSEE_APP_VERSION__ = 12;
    expect(bundledAppIdentity()).toEqual({});
  });
});
