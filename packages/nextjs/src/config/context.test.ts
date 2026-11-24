import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBugseeContext } from './context';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugsee-ctx-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '4.5.6' }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__;
});

describe('createBugseeContext', () => {
  it('takes the token from the option, then the environment', () => {
    expect(createBugseeContext({ appToken: 'opt' }, dir, { env: {} }).resolved.appToken).toBe(
      'opt',
    );
    expect(
      createBugseeContext({}, dir, { env: { BUGSEE_APP_TOKEN: 'from-env' } }).resolved,
    ).toMatchObject({ appToken: 'from-env', enabled: true });
  });

  it('is disabled without a token, and with disabled: true', () => {
    expect(createBugseeContext({}, dir, { env: {} }).resolved.enabled).toBe(false);
    expect(
      createBugseeContext({ appToken: 't', disabled: true }, dir, { env: {} }).resolved.enabled,
    ).toBe(false);
  });

  it('reads the token from .env.bugsee-build-plugin in the project directory', () => {
    // The shared test setup hides this file from every test; opt in, as the core's env-file tests do.
    (globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__ = true;
    writeFileSync(join(dir, '.env.bugsee-build-plugin'), 'BUGSEE_APP_TOKEN=from-file\n');
    expect(createBugseeContext({}, dir, { env: {} }).resolved).toMatchObject({
      appToken: 'from-file',
      enabled: true,
    });
  });

  it('does not read the env file at all when disabled', () => {
    (globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__ = true;
    writeFileSync(join(dir, '.env.bugsee-build-plugin'), 'BUGSEE_APP_TOKEN=from-file\n');
    expect(createBugseeContext({ disabled: true }, dir, { env: {} }).resolved.appToken).toBe('');
  });

  it('says once when the env file was found but gave nothing', () => {
    (globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__ = true;
    writeFileSync(join(dir, '.env.bugsee-build-plugin'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    const notices: string[] = [];
    createBugseeContext({ onNotice: (m) => notices.push(m) }, dir, { env: {} });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^\[bugsee\] /);
  });

  it('resolves the identity from the project directory, option first', () => {
    expect(createBugseeContext({ appToken: 't' }, dir, { env: {} }).resolved).toMatchObject({
      appVersion: '4.5.6',
      identityDefines: expect.objectContaining({ __BUGSEE_APP_VERSION__: '"4.5.6"' }),
    });
    expect(
      createBugseeContext({ appToken: 't', appVersion: '9.9.9', appBuild: '7' }, dir, { env: {} })
        .resolved,
    ).toMatchObject({ appVersion: '9.9.9', appBuild: '7' });
  });

  it('points the VCS root at the project unless told otherwise', () => {
    expect(createBugseeContext({}, dir, { env: {} }).resolved.projectRoot).toBe(dir);
    expect(
      createBugseeContext({ projectRoot: '/repo' }, dir, { env: {} }).resolved.projectRoot,
    ).toBe('/repo');
  });

  it('defaults the Next policy: server maps on, server maps kept', () => {
    const context = createBugseeContext({}, dir, { env: {} });
    expect(context.serverSourceMaps).toBe(true);
    expect(context.deleteServerMaps).toBe(false);
    const custom = createBugseeContext({ serverSourceMaps: false, deleteServerMaps: true }, dir, {
      env: {},
    });
    expect(custom.serverSourceMaps).toBe(false);
    expect(custom.deleteServerMaps).toBe(true);
  });

  it('sends notices to onNotice with one [bugsee] prefix, de-duplicated', () => {
    const notices: string[] = [];
    const context = createBugseeContext({ onNotice: (m) => notices.push(m) }, dir, { env: {} });
    context.say('hello');
    context.say('hello');
    context.resolved.onNotice?.('[bugsee] from core');
    expect(notices).toEqual(['[bugsee] hello', '[bugsee] from core']);
  });

  it('warns on the console by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createBugseeContext({}, dir, { env: {} }).say('careful');
    expect(warn).toHaveBeenCalledWith('[bugsee] careful');
    warn.mockRestore();
  });

  it('says nothing when silent', () => {
    const onNotice = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = createBugseeContext({ silent: true, onNotice }, dir, { env: {} });
    context.say('quiet');
    context.resolved.onNotice?.('[bugsee] quiet too');
    expect(onNotice).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives a throwing notice sink', () => {
    const context = createBugseeContext(
      {
        onNotice: () => {
          throw new Error('logger down');
        },
      },
      dir,
      { env: {} },
    );
    expect(() => context.say('x')).not.toThrow();
  });

  it('reads process.env when no environment is injected', () => {
    vi.stubEnv('BUGSEE_APP_TOKEN', 'ambient');
    expect(createBugseeContext({}, dir).resolved.appToken).toBe('ambient');
    vi.unstubAllEnvs();
  });
});
