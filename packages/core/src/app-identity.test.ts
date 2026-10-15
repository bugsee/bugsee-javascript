import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledAppIdentity,
  findNearestPackageVersion,
  PACKAGE_VERSION_MAX_DEPTH,
  resolveAppIdentity,
} from './app-identity';

const globals = globalThis as unknown as Record<string, unknown>;

describe('resolveAppIdentity warning hint', () => {
  it('ends the warning with the runtime hint it is given', () => {
    const warnings: string[] = [];
    resolveAppIdentity({}, [], (m) => warnings.push(m), 'Use the plugin.');
    expect(warnings).toEqual([
      'Bugsee: the app version could not be detected, so reports will show 0.0.0. Use the plugin.',
    ]);
  });

  it('has a runtime-neutral default hint that names only launch options', () => {
    const warnings: string[] = [];
    resolveAppIdentity({}, [], (m) => warnings.push(m));
    expect(warnings[0]).toContain('Pass `appVersion` (and `appBuild`) to launch().');
    expect(warnings[0]).not.toContain('BUGSEE_APP_VERSION');
  });
});

describe('findNearestPackageVersion', () => {
  const io = (map: Record<string, string>) => ({
    readFile: (path: string): string => {
      const hit = map[path];
      if (hit === undefined) {
        throw new Error('ENOENT');
      }
      return hit;
    },
    dirname: (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/',
    join: (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`),
  });

  it('walks up past missing manifests and trims the version', () => {
    expect(
      findNearestPackageVersion('/a/b/c', io({ '/a/package.json': '{"version":" 1.2.3 "}' })),
    ).toBe('1.2.3');
  });

  it('stops at a versionless nearest manifest instead of adopting an ancestor version', () => {
    const files = io({
      '/a/package.json': '{"version":"9.9.9"}',
      '/a/b/package.json': '{"name":"app"}',
    });
    expect(findNearestPackageVersion('/a/b/c', files)).toBeUndefined();
  });

  it('treats a blank or non-string version as none and stops', () => {
    for (const version of ['"  "', '3']) {
      const files = io({
        '/a/package.json': '{"version":"9.9.9"}',
        '/a/b/package.json': `{"version":${version}}`,
      });
      expect(findNearestPackageVersion('/a/b', files)).toBeUndefined();
    }
  });

  it('keeps walking past an unparseable or non-object manifest', () => {
    const files = io({
      '/a/package.json': '{"version":"2.0.0"}',
      '/a/b/package.json': '{nope',
      '/a/b/c/package.json': 'null',
    });
    expect(findNearestPackageVersion('/a/b/c', files)).toBe('2.0.0');
  });

  it('returns undefined at the root when nothing is found', () => {
    expect(findNearestPackageVersion('/a/b', io({}))).toBeUndefined();
  });

  it('gives up after the depth cap', () => {
    const files = io({ '/package.json': '{"version":"1.0.0"}' });
    const deep = `/${Array.from({ length: PACKAGE_VERSION_MAX_DEPTH }, () => 'd').join('/')}`;
    expect(findNearestPackageVersion(deep, files)).toBeUndefined();
    const ok = `/${Array.from({ length: PACKAGE_VERSION_MAX_DEPTH - 1 }, () => 'd').join('/')}`;
    expect(findNearestPackageVersion(ok, files)).toBe('1.0.0');
  });
});

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

  it('treats a whitespace-only explicit value as unset (a stray newline is not a choice)', () => {
    const resolved = resolveAppIdentity({ version: ' \n', build: '\t' }, [
      () => ({ version: '1.0.0', build: '3' }),
    ]);
    expect(resolved).toEqual({ version: '1.0.0', build: '3' });
    const none = resolveAppIdentity({ version: '  ' }, []);
    expect(none.version).toBeUndefined();
  });

  it('keeps a padded but non-blank explicit value exactly as given', () => {
    expect(resolveAppIdentity({ version: ' 2.0.0 ' }, [() => ({ version: '1.0.0' })]).version).toBe(
      ' 2.0.0 ',
    );
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
