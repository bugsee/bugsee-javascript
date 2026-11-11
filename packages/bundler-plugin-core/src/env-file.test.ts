import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILD_PLUGIN_ENV_FILE,
  loadBuildPluginEnv,
  mergeBuildPluginEnv,
  parseEnvFile,
} from './env-file';

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, comments, blanks, export prefixes and quotes', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'BUGSEE_APP_TOKEN=abc123',
        'export BUGSEE_ENDPOINT = "https://x.test"',
        "BUGSEE_APP_BUILD='42'",
        'BUGSEE_APP_VERSION=1.2.3 # trailing',
        'BUGSEE_EMPTY=',
      ].join('\r\n'),
    );
    expect(parsed).toEqual({
      BUGSEE_APP_TOKEN: 'abc123',
      BUGSEE_ENDPOINT: 'https://x.test',
      BUGSEE_APP_BUILD: '42',
      BUGSEE_APP_VERSION: '1.2.3',
      BUGSEE_EMPTY: '',
    });
  });

  it('keeps a # inside a quoted value and a # without preceding space in an unquoted one', () => {
    expect(parseEnvFile('BUGSEE_APP_TOKEN="a #b"\nBUGSEE_APP_BUILD=a#b')).toEqual({
      BUGSEE_APP_TOKEN: 'a #b',
      BUGSEE_APP_BUILD: 'a#b',
    });
  });

  it('skips malformed lines and non-BUGSEE keys, never throws', () => {
    expect(
      parseEnvFile(
        'garbage\n=novalue\n1BAD=x\nNODE_ENV=production\nBUGSEE_APP_TOKEN=ok\n\u0000\u0001',
      ),
    ).toEqual({ BUGSEE_APP_TOKEN: 'ok' });
  });

  it('treats an unterminated quote as the raw remainder', () => {
    expect(parseEnvFile('BUGSEE_APP_TOKEN="abc')).toEqual({ BUGSEE_APP_TOKEN: '"abc' });
  });
});

describe('loadBuildPluginEnv', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bugsee-envfile-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the file in the project dir', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=tok\n');
    expect(loadBuildPluginEnv(root)).toEqual({ BUGSEE_APP_TOKEN: 'tok' });
  });

  it('finds the NEAREST file walking up, and stops at the first one found', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=outer\n');
    const app = join(root, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    expect(loadBuildPluginEnv(app)).toEqual({ BUGSEE_APP_TOKEN: 'outer' });
    writeFileSync(join(app, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_BUILD=7\n');
    expect(loadBuildPluginEnv(app)).toEqual({ BUGSEE_APP_BUILD: '7' });
  });

  it('returns {} when there is no file, or the path is a directory', () => {
    // A directory with the file's name is unreadable as a file: skipped, never thrown. The walk then
    // reaches the filesystem root, where no such file is expected.
    mkdirSync(join(root, BUILD_PLUGIN_ENV_FILE));
    expect(loadBuildPluginEnv(root)).toEqual({});
  });

  it('survives a malformed (binary) file', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), Buffer.from([0xff, 0xfe, 0x00, 0x3d, 0x3d]));
    expect(loadBuildPluginEnv(root)).toEqual({});
  });

  it('returns {} when the working directory is gone and no root is given', () => {
    const gone = () => {
      throw new Error('ENOENT uncwd');
    };
    expect(loadBuildPluginEnv(undefined, gone)).toEqual({});
  });

  it('defaults to the cwd', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=cwd\n');
    expect(loadBuildPluginEnv(undefined, () => root)).toEqual({ BUGSEE_APP_TOKEN: 'cwd' });
  });
});

describe('mergeBuildPluginEnv', () => {
  it('never overrides a variable already set, even to an empty string', () => {
    const merged = mergeBuildPluginEnv(
      { BUGSEE_APP_TOKEN: 'from-env', BUGSEE_APP_BUILD: '', OTHER: 'x' },
      { BUGSEE_APP_TOKEN: 'from-file', BUGSEE_APP_BUILD: '9', BUGSEE_ENDPOINT: 'e' },
    );
    expect(merged).toEqual({
      BUGSEE_APP_TOKEN: 'from-env',
      BUGSEE_APP_BUILD: '',
      OTHER: 'x',
      BUGSEE_ENDPOINT: 'e',
    });
  });

  it('does not mutate its inputs', () => {
    const env = { A: '1' };
    mergeBuildPluginEnv(env, { BUGSEE_APP_TOKEN: 't' });
    expect(env).toEqual({ A: '1' });
  });
});
