import { describe, expect, it, vi } from 'vitest';
import { BugseeCliError, resolveBugseeCli, runBugseeCli, type SpawnFn } from './run-cli';

/** A fake spawn that records its call and returns a scripted result. */
function fakeSpawn(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ command: string; args: string[]; options: Parameters<SpawnFn>[2] }> = [];
  const spawn: SpawnFn = vi.fn(async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  return { spawn, calls };
}

describe('resolveBugseeCli', () => {
  it('prefers the BUGSEE_CLI_PATH override', () => {
    expect(resolveBugseeCli({ BUGSEE_CLI_PATH: '/opt/bugsee-cli' })).toBe('/opt/bugsee-cli');
  });

  it('ignores an empty/whitespace override', () => {
    expect(resolveBugseeCli({ BUGSEE_CLI_PATH: '   ' })).toBe('bugsee-cli');
  });

  it('defaults to `bugsee-cli` (resolved from PATH / node_modules/.bin)', () => {
    expect(resolveBugseeCli({})).toBe('bugsee-cli');
  });
});

describe('runBugseeCli', () => {
  it('resolves the binary and spawns it with the given args, returning the result on exit 0', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, stdout: 'ok' });
    const result = await runBugseeCli(['sourcemaps', 'inject', './dist'], { spawn, env: {} });
    expect(result).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    expect(calls[0]?.command).toBe('bugsee-cli');
    expect(calls[0]?.args).toEqual(['sourcemaps', 'inject', './dist']);
  });

  it('passes the token/endpoint via env vars (never on argv)', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    await runBugseeCli(['debug-files', 'upload', './dist'], {
      spawn,
      env: {},
      token: 'secret-tok',
      endpoint: 'https://api.custom.test',
    });
    expect(calls[0]?.args).not.toContain('secret-tok'); // never in argv (process list safety)
    expect(calls[0]?.options.env?.BUGSEE_APP_TOKEN).toBe('secret-tok');
    expect(calls[0]?.options.env?.BUGSEE_ENDPOINT).toBe('https://api.custom.test');
  });

  it('does NOT set the token env var when no token is given (keeps the base env)', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    await runBugseeCli(['x'], { spawn, env: { EXISTING: '1' } });
    expect(calls[0]?.options.env?.EXISTING).toBe('1');
    expect('BUGSEE_APP_TOKEN' in (calls[0]?.options.env ?? {})).toBe(false);
  });

  it('honours the BUGSEE_CLI_PATH override + cwd', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    await runBugseeCli(['x'], { spawn, env: { BUGSEE_CLI_PATH: '/opt/bc' }, cwd: '/build' });
    expect(calls[0]?.command).toBe('/opt/bc');
    expect(calls[0]?.options.cwd).toBe('/build');
  });

  it('throws BugseeCliError (with exit code + stderr) on a non-zero exit', async () => {
    const { spawn } = fakeSpawn({ code: 2, stderr: 'boom: bad token' });
    await expect(runBugseeCli(['x'], { spawn, env: {} })).rejects.toBeInstanceOf(BugseeCliError);
    await expect(runBugseeCli(['x'], { spawn, env: {} })).rejects.toMatchObject({
      code: 2,
      stderr: 'boom: bad token',
    });
  });

  it('uses an injected binary resolver when provided', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    await runBugseeCli(['x'], { spawn, env: {}, resolveBinary: () => '/custom/bin' });
    expect(calls[0]?.command).toBe('/custom/bin');
  });

  it('really spawns via the default child_process wrapper (no injected spawn/env)', async () => {
    // Exercises the default `process.env` + `defaultSpawn` fallbacks against a trivial real process.
    const result = await runBugseeCli(['--version'], { resolveBinary: () => process.execPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\./); // `node --version` → vX.Y.Z
  });
});
