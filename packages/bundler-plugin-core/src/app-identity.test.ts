import { describe, expect, it } from 'vitest';
import {
  appIdentityDefines,
  CI_COMMIT_ENV_VARS,
  findAppIdentity,
  findPackageVersion,
  fixedIdentityFromDefines,
  UNBAKEABLE_IDENTITY,
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

  it('starts at the given root when there is one, not at cwd', () => {
    const read = files({ '/root/package.json': '{"version":"7.0.0"}' });
    const cwd = () => {
      throw new Error('no cwd');
    };
    expect(findAppIdentity({}, {}, { readFile: read, cwd }, '/root/app').version).toBe('7.0.0');
  });

  it('treats blank and whitespace-only options exactly like unset ones', () => {
    const deps = { readFile: files({ '/p/package.json': '{"version":"1.0.0"}' }), cwd: () => '/p' };
    for (const blank of ['', '   ', '\t\n']) {
      const found = findAppIdentity(
        { appVersion: blank, appBuild: blank },
        { BUGSEE_APP_VERSION: '4.0.0', BUGSEE_APP_BUILD: '8' },
        deps,
      );
      expect(found).toEqual({ version: '4.0.0', build: '8' });
    }
    expect(findAppIdentity({ appVersion: ' ' }, {}, deps).version).toBe('1.0.0');
    expect(findAppIdentity({ appBuild: ' ' }, { GITHUB_SHA: 'abc' }, deps).build).toBe('abc');
    expect(findAppIdentity({ appBuild: ' ' }, {}, deps).build).toBeUndefined();
  });

  it('trims a real option value', () => {
    expect(findAppIdentity({ appVersion: ' 2.0.0 ', appBuild: ' 5 ' }, {}).version).toBe('2.0.0');
    expect(findAppIdentity({ appVersion: '1', appBuild: ' 5 ' }, {}).build).toBe('5');
  });

  it('stops at a versionless nearest package.json instead of adopting a workspace version', () => {
    const read = files({
      '/ws/package.json': '{"version":"0.0.0"}',
      '/ws/apps/web/package.json': '{"name":"web"}',
    });
    expect(findAppIdentity({}, {}, { readFile: read }, '/ws/apps/web').version).toBeUndefined();
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

describe("fixedIdentityFromDefines: what the app's OWN define says the runtime will read", () => {
  it('is empty when the user defined neither key (both are free to detect)', () => {
    expect(fixedIdentityFromDefines(undefined)).toEqual({});
    expect(fixedIdentityFromDefines({ OTHER: '1' })).toEqual({});
  });

  it('reads a JSON string literal as the value the app will report', () => {
    expect(
      fixedIdentityFromDefines({
        __BUGSEE_APP_VERSION__: JSON.stringify('2.4.1'),
        __BUGSEE_APP_BUILD__: JSON.stringify('abc'),
      }),
    ).toEqual({ version: '2.4.1', build: 'abc' });
  });

  it('marks an expression, a non-string, a non-string literal or a blank literal as unreadable (null)', () => {
    for (const value of ['process.env.V', "'2.4.1'", '1', '{"a":1}', '""', '"  "', 5, null, {}]) {
      expect(fixedIdentityFromDefines({ __BUGSEE_APP_VERSION__: value })).toEqual({
        version: null,
      });
      expect(fixedIdentityFromDefines({ __BUGSEE_APP_BUILD__: value })).toEqual({ build: null });
    }
  });

  it('a key that is present with an undefined value still counts as defined (unreadable)', () => {
    expect(fixedIdentityFromDefines({ __BUGSEE_APP_VERSION__: undefined })).toEqual({
      version: null,
    });
  });

  it('keeps the two keys independent', () => {
    expect(fixedIdentityFromDefines({ __BUGSEE_APP_BUILD__: '"7"' })).toEqual({ build: '7' });
  });

  it('UNBAKEABLE_IDENTITY fixes both as unreadable', () => {
    expect(UNBAKEABLE_IDENTITY).toEqual({ version: null, build: null });
  });
});

describe('findAppIdentity with a fixed identity', () => {
  const read = files({ '/app/package.json': '{"version":"1.0.0"}' });
  const env = { BUGSEE_APP_VERSION: 'env-v', BUGSEE_APP_BUILD: 'env-b', GITHUB_SHA: 'sha' };

  it('a literal wins over the option, the environment, package.json and the CI commit', () => {
    expect(
      findAppIdentity({ appVersion: 'opt', appBuild: 'optb' }, env, { readFile: read }, '/app', {
        version: '9.9.9',
        build: 'fixed-b',
      }),
    ).toEqual({ version: '9.9.9', build: 'fixed-b' });
  });

  it('an unreadable fixed value uses ONLY explicit values (option, then BUGSEE_* env)', () => {
    const fixed = { version: null, build: null };
    expect(findAppIdentity({ appVersion: 'opt' }, env, { readFile: read }, '/app', fixed)).toEqual({
      version: 'opt',
      build: 'env-b',
    });
    expect(findAppIdentity({}, env, { readFile: read }, '/app', fixed)).toEqual({
      version: 'env-v',
      build: 'env-b',
    });
  });

  it('an unreadable fixed value never falls back to package.json or the CI commit', () => {
    expect(
      findAppIdentity({}, { GITHUB_SHA: 'sha' }, { readFile: read }, '/app', {
        version: null,
        build: null,
      }),
    ).toEqual({ version: undefined, build: undefined });
  });

  it('only the fixed field changes; the other is still detected', () => {
    expect(
      findAppIdentity({}, { GITHUB_SHA: 'sha' }, { readFile: read }, '/app', { version: null }),
    ).toEqual({ version: undefined, build: 'sha' });
    expect(findAppIdentity({}, {}, { readFile: read }, '/app', { build: null })).toEqual({
      version: '1.0.0',
      build: undefined,
    });
  });
});
