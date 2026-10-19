import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { createNodeAppIdentitySource } from './app-identity-source';

const files = (map: Record<string, string>) =>
  vi.fn((path: string) => {
    const hit = map[path];
    if (hit === undefined) {
      throw new Error('ENOENT');
    }
    return hit;
  });

const BUILD_VARS = [
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'CI_COMMIT_SHA',
  'CIRCLE_SHA1',
  'BUILDKITE_COMMIT',
  'SOURCE_VERSION',
  'RENDER_GIT_COMMIT',
  'COMMIT_REF',
  'CF_PAGES_COMMIT_SHA',
  'GIT_COMMIT',
];

describe('createNodeAppIdentitySource version', () => {
  it('prefers BUGSEE_APP_VERSION over package.json', () => {
    const readFile = files({ '/app/package.json': '{"version":"3.0.0"}' });
    const source = createNodeAppIdentitySource({
      env: { BUGSEE_APP_VERSION: '1.0.0', npm_package_version: '2.0.0' },
      cwd: () => '/app',
      readFile,
    });
    expect(source()).toEqual({ version: '1.0.0' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('trims padding from environment values (a trailing newline from a shell or CI export)', () => {
    const source = createNodeAppIdentitySource({
      env: { BUGSEE_APP_VERSION: ' 1.0.0\n', BUGSEE_APP_BUILD: '\tabc123 ' },
      cwd: () => '/app',
      readFile: files({}),
    });
    expect(source()).toEqual({ version: '1.0.0', build: 'abc123' });
    const ci = createNodeAppIdentitySource({
      env: { GITHUB_SHA: ' deadbeef\n' },
      cwd: () => '/app',
      readFile: files({}),
    });
    expect(ci()).toEqual({ build: 'deadbeef' });
  });

  it('ignores a blank BUGSEE_APP_VERSION and reads package.json', () => {
    const source = createNodeAppIdentitySource({
      env: { BUGSEE_APP_VERSION: '  ' },
      cwd: () => '/app',
      readFile: files({ '/app/package.json': '{"version":"2.0.0"}' }),
    });
    expect(source()?.version).toBe('2.0.0');
  });

  // npm/pnpm export the version of the package whose SCRIPT is running, and child processes inherit it: a
  // workspace-root `npm start` that spawns apps/api would report the root's version while the bundler
  // plugin labels the maps with the app's own. The package.json walk is the one rule both sides share.
  it('never reads npm_package_version: the app package.json (from appRoot) wins', () => {
    const source = createNodeAppIdentitySource({
      env: { npm_package_version: '0.0.0' },
      cwd: () => '/ws',
      appRoot: '/ws/apps/api',
      readFile: files({
        '/ws/apps/api/package.json': '{"version":"2.4.1"}',
        '/ws/package.json': '{"version":"0.0.0"}',
      }),
    });
    expect(source()).toEqual({ version: '2.4.1' });
  });

  it('never reads npm_package_version: nothing found means no version, not the inherited one', () => {
    const versionless = createNodeAppIdentitySource({
      env: { npm_package_version: '0.0.0' },
      cwd: () => '/ws/apps/api',
      readFile: files({ '/ws/apps/api/package.json': '{"name":"api"}' }),
    });
    expect(versionless()).toEqual({});
    const gone = createNodeAppIdentitySource({
      env: { npm_package_version: '0.0.0' },
      cwd: () => undefined,
      readFile: files({}),
    });
    expect(gone()).toEqual({});
  });

  it('reads the nearest package.json, walking up from the working directory', () => {
    const source = createNodeAppIdentitySource({
      env: {},
      cwd: () => '/app/src/deep',
      readFile: files({ '/app/package.json': '{"version":"4.1.0"}' }),
    });
    expect(source()?.version).toBe('4.1.0');
  });

  it('starts from appRoot when one is given', () => {
    const source = createNodeAppIdentitySource({
      env: {},
      cwd: () => '/elsewhere',
      appRoot: '/proj/dist',
      readFile: files({
        '/proj/package.json': '{"version":"5.0.0"}',
        '/elsewhere/package.json': '{"version":"9.9.9"}',
      }),
    });
    expect(source()?.version).toBe('5.0.0');
  });

  it('treats an empty appRoot as unset', () => {
    const source = createNodeAppIdentitySource({
      env: {},
      cwd: () => '/cwd',
      appRoot: '',
      readFile: files({ '/cwd/package.json': '{"version":"6.0.0"}' }),
    });
    expect(source()?.version).toBe('6.0.0');
  });

  it('skips an unparseable manifest and keeps walking', () => {
    const readFile = files({
      '/a/b/c/d/package.json': '{not json',
      '/a/package.json': '{"version":"0.5.0"}',
    });
    const source = createNodeAppIdentitySource({ env: {}, cwd: () => '/a/b/c/d', readFile });
    expect(source()?.version).toBe('0.5.0');
  });

  it.each([
    ['has no version', '{"name":"x"}'],
    ['has a blank version', '{"version":"  "}'],
    ['has a non-string version', '{"version":7}'],
  ])('stops at a nearest manifest that %s rather than adopting a parent version', (_, nearest) => {
    const readFile = files({
      '/ws/apps/web/package.json': nearest,
      '/ws/package.json': '{"version":"0.0.0"}',
    });
    const source = createNodeAppIdentitySource({ env: {}, cwd: () => '/ws/apps/web', readFile });
    expect(source()).toEqual({});
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('gives up at the filesystem root', () => {
    const readFile = files({});
    const source = createNodeAppIdentitySource({ env: {}, cwd: () => '/a/b', readFile });
    expect(source()).toEqual({});
    expect(readFile.mock.calls.map(([p]) => p)).toEqual([
      '/a/b/package.json',
      '/a/package.json',
      '/package.json',
    ]);
  });

  it('stops after 12 directories', () => {
    const readFile = files({});
    const deep = `/${Array.from({ length: 20 }, (_, i) => `d${i}`).join('/')}`;
    createNodeAppIdentitySource({ env: {}, cwd: () => deep, readFile })();
    expect(readFile).toHaveBeenCalledTimes(12);
  });

  it('reports no version when the working directory is gone', () => {
    const readFile = files({});
    const source = createNodeAppIdentitySource({ env: {}, cwd: () => undefined, readFile });
    expect(source()).toEqual({});
    expect(readFile).not.toHaveBeenCalled();
  });

  it('searches package.json once however often it is asked', () => {
    const readFile = files({ '/app/package.json': '{"version":"1.2.3"}' });
    const source = createNodeAppIdentitySource({ env: {}, cwd: () => '/app', readFile });
    source();
    source();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('reads the real filesystem and process.cwd() by default', () => {
    // Run from a package directory, whose package.json carries a version.
    const identity = createNodeAppIdentitySource({ env: {} })();
    expect(identity?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('survives a deleted working directory with the default cwd', () => {
    const spy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: uv_cwd');
    });
    try {
      expect(createNodeAppIdentitySource({ env: {} })()).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createNodeAppIdentitySource build', () => {
  it('prefers BUGSEE_APP_BUILD', () => {
    const source = createNodeAppIdentitySource({
      env: { BUGSEE_APP_BUILD: '77', GITHUB_SHA: 'abc' },
      cwd: () => undefined,
    });
    expect(source()?.build).toBe('77');
  });

  it.each(BUILD_VARS)('reads %s, and a later variable never beats an earlier one', (name) => {
    const env: Record<string, string> = {};
    for (const later of BUILD_VARS.slice(BUILD_VARS.indexOf(name))) {
      env[later] = `sha-${later}`;
    }
    const source = createNodeAppIdentitySource({ env, cwd: () => undefined });
    expect(source()?.build).toBe(`sha-${name}`);
  });

  it('skips blank values and reports no build when none is set', () => {
    const blank = { GITHUB_SHA: ' ', GIT_COMMIT: 'x' };
    expect(createNodeAppIdentitySource({ env: blank, cwd: () => undefined })()?.build).toBe('x');
    expect(createNodeAppIdentitySource({ env: {}, cwd: () => undefined })()).toEqual({});
  });
});
