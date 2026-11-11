import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILD_PLUGIN_ENV_FILE,
  FILE_KEYS,
  loadBuildPluginEnv,
  mergeBuildPluginEnv,
  parseEnvFile,
} from './env-file';

// The test setup hides the file from every test; this one exercises the lookup itself.
(globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__ = true;

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, comments, blanks, export prefixes, quotes and a BOM', () => {
    const parsed = parseEnvFile(
      [
        '﻿# a comment',
        '',
        'BUGSEE_APP_TOKEN=abc123',
        'export BUGSEE_APP_VERSION = "1.2.3"',
        "BUGSEE_APP_BUILD='42'",
      ].join('\r\n'),
    );
    expect(parsed).toEqual({
      BUGSEE_APP_TOKEN: 'abc123',
      BUGSEE_APP_VERSION: '1.2.3',
      BUGSEE_APP_BUILD: '42',
    });
  });

  it('keeps a BOM-prefixed first line', () => {
    expect(parseEnvFile('﻿BUGSEE_APP_TOKEN=t')).toEqual({ BUGSEE_APP_TOKEN: 't' });
  });

  it('strips an inline comment from an unquoted value only', () => {
    expect(
      parseEnvFile('BUGSEE_APP_TOKEN="a #b"\nBUGSEE_APP_BUILD=a#b\nBUGSEE_APP_VERSION=1.0 # note'),
    ).toEqual({ BUGSEE_APP_TOKEN: 'a #b', BUGSEE_APP_BUILD: 'a#b', BUGSEE_APP_VERSION: '1.0' });
  });

  it('reads ONLY the token, version and build: never the endpoint, CLI path or commit', () => {
    expect([...FILE_KEYS].sort()).toEqual([
      'BUGSEE_APP_BUILD',
      'BUGSEE_APP_TOKEN',
      'BUGSEE_APP_VERSION',
    ]);
    expect(
      parseEnvFile(
        [
          'BUGSEE_ENDPOINT=https://evil.test',
          'BUGSEE_CLI_PATH=/tmp/x',
          'BUGSEE_BUILD_COMMIT=abcdef1',
          'NODE_ENV=production',
          'BUGSEE_APP_TOKEN=ok',
        ].join('\n'),
      ),
    ).toEqual({ BUGSEE_APP_TOKEN: 'ok' });
  });

  it('skips malformed lines, never throws', () => {
    expect(parseEnvFile('garbage\n=novalue\n1BAD=x\nBUGSEE_APP_TOKEN=ok\n\u0001')).toEqual({
      BUGSEE_APP_TOKEN: 'ok',
    });
  });

  it('treats an unterminated quote as the raw remainder', () => {
    expect(parseEnvFile('BUGSEE_APP_TOKEN="abc')).toEqual({ BUGSEE_APP_TOKEN: '"abc' });
  });
});

describe('loadBuildPluginEnv', () => {
  let base: string;
  const file = (dir: string, text: string) => writeFileSync(join(dir, BUILD_PLUGIN_ENV_FILE), text);
  const mk = (...parts: string[]) => {
    const dir = join(base, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  // A home directory that is NOT an ancestor of anything under `base`.
  const home = () => '/nonexistent-home';

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bugsee-envfile-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads the file in the project dir (no repo root needed)', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_APP_TOKEN=tok\n');
    expect(loadBuildPluginEnv(proj, { home })).toEqual({
      values: { BUGSEE_APP_TOKEN: 'tok' },
      path: join(proj, BUILD_PLUGIN_ENV_FILE),
    });
  });

  it('walks up to the repo root, nearest file first', () => {
    const repo = mk('repo');
    mkdirSync(join(repo, '.git'));
    file(repo, 'BUGSEE_APP_TOKEN=outer\n');
    const app = mk('repo', 'apps', 'web');
    expect(loadBuildPluginEnv(app, { home }).values).toEqual({ BUGSEE_APP_TOKEN: 'outer' });
    file(app, 'BUGSEE_APP_BUILD=7\n');
    expect(loadBuildPluginEnv(app, { home }).values).toEqual({ BUGSEE_APP_BUILD: '7' });
  });

  it('treats a pnpm workspace root and a `.git` FILE (worktree) as boundaries too', () => {
    const ws = mk('ws');
    writeFileSync(join(ws, 'pnpm-workspace.yaml'), 'packages: []\n');
    file(ws, 'BUGSEE_APP_TOKEN=ws\n');
    expect(loadBuildPluginEnv(mk('ws', 'a'), { home }).values).toEqual({ BUGSEE_APP_TOKEN: 'ws' });
    const wt = mk('wt');
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n');
    file(wt, 'BUGSEE_APP_TOKEN=wt\n');
    expect(loadBuildPluginEnv(mk('wt', 'a'), { home }).values).toEqual({ BUGSEE_APP_TOKEN: 'wt' });
  });

  it('does NOT read a stray file ABOVE the repo root', () => {
    file(base, 'BUGSEE_APP_TOKEN=stray\n');
    const repo = mk('repo');
    mkdirSync(join(repo, '.git'));
    expect(loadBuildPluginEnv(mk('repo', 'app'), { home })).toEqual({ values: {} });
  });

  it('with no repo/workspace root, reads only the project dir, never its parents', () => {
    file(base, 'BUGSEE_APP_TOKEN=parent\n');
    expect(loadBuildPluginEnv(mk('plain', 'app'), { home })).toEqual({ values: {} });
  });

  it('never reads in, or above, the home directory', () => {
    // A dotfiles repo: the home dir is itself a repo root holding a stray file.
    const h = mk('home');
    mkdirSync(join(h, '.git'));
    file(h, 'BUGSEE_APP_TOKEN=home\n');
    const proj = mk('home', 'work', 'proj');
    expect(loadBuildPluginEnv(proj, { home: () => h })).toEqual({ values: {} });
    // ...and a project that IS the home directory (a container WORKDIR of /root) reads nothing, but says why.
    const atHome = loadBuildPluginEnv(h, { home: () => h });
    expect(atHome.values).toEqual({});
    expect(atHome.problem).toContain('home directory');
    expect(atHome.problem).not.toContain('home\n');
    // With no file there, nothing is said.
    expect(loadBuildPluginEnv(mk('home2'), { home: () => join(base, 'home2') })).toEqual({
      values: {},
    });
    // A project directory ABOVE home (home inside it) reads nothing.
    expect(loadBuildPluginEnv(base, { home: () => h })).toEqual({ values: {} });
  });

  it('a project below home may still use its own file', () => {
    const h = mk('home');
    const proj = mk('home', 'proj');
    file(proj, 'BUGSEE_APP_TOKEN=own\n');
    expect(loadBuildPluginEnv(proj, { home: () => h }).values).toEqual({ BUGSEE_APP_TOKEN: 'own' });
  });

  it('stops at the filesystem root', () => {
    expect(loadBuildPluginEnv('/', { home })).toEqual({ values: {} });
  });

  it('reports a found file that holds nothing usable, without echoing its contents', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_ENDPOINT=https://secret.test\n# nothing else\n');
    const result = loadBuildPluginEnv(proj, { home });
    expect(result.values).toEqual({});
    expect(result.problem).toContain('holds no usable');
    expect(result.problem).toContain(join(proj, BUILD_PLUGIN_ENV_FILE));
    expect(result.problem).not.toContain('secret.test');
  });

  it('reports a file whose only entry has an EMPTY value (it would silently disable the plugin)', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_APP_TOKEN=\nBUGSEE_APP_BUILD=   \n');
    const result = loadBuildPluginEnv(proj, { home });
    expect(result.problem).toContain('non-empty value');
    file(proj, 'BUGSEE_APP_TOKEN=\nBUGSEE_APP_BUILD=5\n');
    expect(loadBuildPluginEnv(proj, { home }).problem).toBeUndefined();
  });

  it('reports a UTF-16 / binary file as such', () => {
    const proj = mk('proj');
    writeFileSync(
      join(proj, BUILD_PLUGIN_ENV_FILE),
      Buffer.from('BUGSEE_APP_TOKEN=abc', 'utf16le'),
    );
    const result = loadBuildPluginEnv(proj, { home });
    expect(result.values).toEqual({});
    expect(result.problem).toContain('not UTF-8');
    writeFileSync(join(proj, BUILD_PLUGIN_ENV_FILE), Buffer.from([0xff, 0xfe, 0xfd]));
    expect(loadBuildPluginEnv(proj, { home }).problem).toContain('not UTF-8');
  });

  it('reports an unreadable file (here: a directory) with its error code, and stops there', () => {
    const repo = mk('repo');
    mkdirSync(join(repo, '.git'));
    file(repo, 'BUGSEE_APP_TOKEN=outer\n');
    const app = mk('repo', 'app');
    mkdirSync(join(app, BUILD_PLUGIN_ENV_FILE));
    const result = loadBuildPluginEnv(app, { home });
    expect(result.values).toEqual({});
    expect(result.problem).toMatch(/could not be read \(EISDIR\)/);
  });

  it.skipIf(process.getuid?.() === 0)('reports a permission-denied file', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_APP_TOKEN=x\n');
    chmodSync(join(proj, BUILD_PLUGIN_ENV_FILE), 0o000);
    expect(loadBuildPluginEnv(proj, { home }).problem).toMatch(/could not be read \(EACCES\)/);
  });

  it('a clean file has no problem', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_APP_TOKEN=x\n');
    expect(loadBuildPluginEnv(proj, { home }).problem).toBeUndefined();
  });

  it('returns nothing when the working directory is gone and no root is given', () => {
    const gone = () => {
      throw new Error('ENOENT uncwd');
    };
    expect(loadBuildPluginEnv(undefined, { cwd: gone })).toEqual({ values: {} });
  });

  it('returns nothing when the home directory cannot be determined', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_APP_TOKEN=x\n');
    const noHome = () => {
      throw new Error('no home');
    };
    expect(loadBuildPluginEnv(proj, { home: noHome })).toEqual({ values: {} });
  });

  it('defaults to the cwd and the real home directory', () => {
    const proj = mk('proj');
    file(proj, 'BUGSEE_APP_TOKEN=cwd\n');
    expect(loadBuildPluginEnv(undefined, { cwd: () => proj, home }).values).toEqual({
      BUGSEE_APP_TOKEN: 'cwd',
    });
    // The real os.homedir() is not an ancestor of the OS temp dir on any supported setup.
    expect(loadBuildPluginEnv(proj).values).toEqual({ BUGSEE_APP_TOKEN: 'cwd' });
  });
});

describe('mergeBuildPluginEnv', () => {
  it('never overrides a variable the environment carries', () => {
    const merged = mergeBuildPluginEnv(
      { BUGSEE_APP_TOKEN: 'from-env', OTHER: 'x' },
      { BUGSEE_APP_TOKEN: 'from-file', BUGSEE_APP_BUILD: '9' },
    );
    expect(merged).toEqual({ BUGSEE_APP_TOKEN: 'from-env', OTHER: 'x', BUGSEE_APP_BUILD: '9' });
  });

  it('a blank or whitespace-only variable counts as unset, as the identity resolver treats it', () => {
    const merged = mergeBuildPluginEnv(
      { BUGSEE_APP_VERSION: '', BUGSEE_APP_BUILD: '  ', BUGSEE_APP_TOKEN: undefined },
      { BUGSEE_APP_VERSION: '2.0.0', BUGSEE_APP_BUILD: '9', BUGSEE_APP_TOKEN: 't' },
    );
    expect(merged).toEqual({
      BUGSEE_APP_VERSION: '2.0.0',
      BUGSEE_APP_BUILD: '9',
      BUGSEE_APP_TOKEN: 't',
    });
  });

  it('does not mutate its inputs', () => {
    const env = { A: '1' };
    mergeBuildPluginEnv(env, { BUGSEE_APP_TOKEN: 't' });
    expect(env).toEqual({ A: '1' });
  });
});
