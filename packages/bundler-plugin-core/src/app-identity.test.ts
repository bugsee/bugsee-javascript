import { describe, expect, it } from 'vitest';
import {
  appIdentityDefines,
  CI_COMMIT_ENV_VARS,
  findAppIdentity,
  findPackageVersion,
} from './app-identity';

const files = (map: Record<string, string>) => (path: string) => {
  const content = map[path];
  if (content === undefined) {
    throw new Error('ENOENT');
  }
  return content;
};

describe('findPackageVersion', () => {
  it('reads the nearest package.json version, walking up past missing ones', () => {
    const read = files({ '/a/package.json': '{"version":" 1.2.3 "}' });
    expect(findPackageVersion('/a/b/c', read)).toBe('1.2.3');
  });

  it('prefers the nearest package.json even over a versioned ancestor', () => {
    const read = files({
      '/a/package.json': '{"version":"9.9.9"}',
      '/a/b/package.json': '{"name":"app"}',
    });
    expect(findPackageVersion('/a/b', read)).toBeUndefined();
  });

  it('skips an unparseable or non-object package.json and keeps walking', () => {
    const read = files({
      '/a/package.json': '{"version":"2.0.0"}',
      '/a/b/package.json': '{nope',
      '/a/b/c/package.json': 'null',
    });
    expect(findPackageVersion('/a/b/c', read)).toBe('2.0.0');
  });

  it('treats a blank or non-string version as none', () => {
    expect(findPackageVersion('/a', files({ '/a/package.json': '{"version":"  "}' }))).toBe(
      undefined,
    );
    expect(findPackageVersion('/a', files({ '/a/package.json': '{"version":3}' }))).toBe(undefined);
  });

  it('returns undefined at the filesystem root when nothing is found', () => {
    expect(findPackageVersion('/a/b', files({}))).toBeUndefined();
  });

  it('reads the real filesystem by default', () => {
    expect(findPackageVersion(__dirname)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('findAppIdentity', () => {
  const noRead = () => {
    throw new Error('should not be read');
  };

  it('option beats env beats package.json for the version', () => {
    const read = files({ '/p/package.json': '{"version":"1.0.0"}' });
    const deps = { readFile: read, cwd: () => '/p' };
    expect(
      findAppIdentity({ appVersion: '5.0.0' }, { BUGSEE_APP_VERSION: '4.0.0' }, deps).version,
    ).toBe('5.0.0');
    expect(findAppIdentity({}, { BUGSEE_APP_VERSION: '4.0.0' }, deps).version).toBe('4.0.0');
    expect(findAppIdentity({}, {}, deps).version).toBe('1.0.0');
  });

  it('does not touch the filesystem or cwd when option or env answered', () => {
    const deps = {
      readFile: noRead,
      cwd: () => {
        throw new Error('no cwd');
      },
    };
    expect(findAppIdentity({ appVersion: '1' }, {}, deps).version).toBe('1');
    expect(findAppIdentity({}, { BUGSEE_APP_VERSION: '2' }, deps).version).toBe('2');
  });

  it('starts at projectRoot when given, not cwd', () => {
    const read = files({ '/root/package.json': '{"version":"7.0.0"}' });
    const cwd = () => {
      throw new Error('no cwd');
    };
    expect(findAppIdentity({ projectRoot: '/root/app' }, {}, { readFile: read, cwd }).version).toBe(
      '7.0.0',
    );
  });

  it('a throwing process.cwd() means not found, never an exception', () => {
    const cwd = () => {
      throw new Error('ENOENT uv_cwd');
    };
    expect(findAppIdentity({}, {}, { cwd, readFile: noRead }).version).toBeUndefined();
  });

  it('build: option, then BUGSEE_APP_BUILD, then CI commit variables in priority order', () => {
    expect(findAppIdentity({ appBuild: '9' }, { BUGSEE_APP_BUILD: '8' }).build).toBe('9');
    expect(findAppIdentity({}, { BUGSEE_APP_BUILD: '8', GITHUB_SHA: 'abc' }).build).toBe('8');
    expect(findAppIdentity({}, { GIT_COMMIT: 'z', GITHUB_SHA: 'abc' }).build).toBe('abc');
  });

  it('every CI variable is honoured, and blank ones are skipped', () => {
    for (const name of CI_COMMIT_ENV_VARS) {
      expect(findAppIdentity({}, { [name]: 'sha1' }).build).toBe('sha1');
    }
    expect(findAppIdentity({}, { GITHUB_SHA: '  ', GIT_COMMIT: ' c ' }).build).toBe('c');
  });

  it('build is undefined when nothing supplies it, and never read from package.json', () => {
    expect(findAppIdentity({ appVersion: '1' }, {}).build).toBeUndefined();
  });
});

describe('appIdentityDefines', () => {
  it('JSON-encodes only the values that were found', () => {
    expect(appIdentityDefines({ version: '1.0.0', build: 'a"b' })).toEqual({
      __BUGSEE_APP_VERSION__: '"1.0.0"',
      __BUGSEE_APP_BUILD__: '"a\\"b"',
    });
    expect(appIdentityDefines({ version: '1.0.0', build: undefined })).toEqual({
      __BUGSEE_APP_VERSION__: '"1.0.0"',
    });
    expect(appIdentityDefines({ version: undefined, build: '5' })).toEqual({
      __BUGSEE_APP_BUILD__: '"5"',
    });
    expect(appIdentityDefines({ version: undefined, build: undefined })).toEqual({});
  });
});
