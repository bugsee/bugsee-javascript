import { describe, expect, it, vi } from 'vitest';
import {
  BugseeCliError,
  resolveBugseeCli,
  runBugseeCli,
  type SpawnFn,
  spawnOptionsFor,
} from './run-cli';

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

// WAVE 7.4 — a hung `bugsee-cli` hung the build, forever.
//
// The promise settled only on the child's `close` or `error`. No timeout, no AbortSignal, no watchdog at
// any layer — so a CLI blocked on a hanging TCP connect (a firewalled or proxied CI network, reachable
// purely through a misconfigured `endpoint`) left `writeBundle` pending until the CI job's own global
// timeout, burning a runner slot and producing no diagnostic. Measured in the review: a 2.5 s child raced
// against a 1.2 s timer, and the timer won — nothing bounded the wait.
describe('the spawned CLI is bounded (Wave 7.4)', () => {
  it('aborts and rejects when the child outlives the timeout', async () => {
    const spawn: SpawnFn = (_c, _a, options) =>
      new Promise((_resolve, reject) => {
        // A child that never settles on its own, but honours the signal — as node:child_process does.
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli', timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });

  it('hands the child an AbortSignal so it can actually be killed', () => {
    // Rejecting the promise without aborting leaves an orphan process holding the port/file handles.
    let seen: AbortSignal | undefined;
    const spawn: SpawnFn = (_c, _a, options) => {
      seen = options.signal;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    return runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli', timeoutMs: 50 }).then(() => {
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(false);
    });
  });

  it('does not abort a child that finishes in time — the canary', async () => {
    const spawn: SpawnFn = () =>
      new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: 'ok', stderr: '' }), 5));
    await expect(
      runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli', timeoutMs: 500 }),
    ).resolves.toMatchObject({ stdout: 'ok' });
  });

  it('clears the timer when the child finishes, so nothing keeps the process alive', async () => {
    // A dangling `setTimeout` would hold the event loop open past the build — the same class of defect as
    // the un-unref'd watchdog worker (Wave 2.4).
    const spawn: SpawnFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });
    const before = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    await runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli', timeoutMs: 60_000 });
    const after = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});

// The spawn OPTIONS are the security surface, and they were `/* v8 ignore */`'d wholesale — which is how
// the review's `shell: true` mutation survived. `shell: true` on a command line built from user-supplied
// values is the single most dangerous change possible in this package, so the options are now a pure
// function that a test can actually assert on, rather than an inline literal inside an ignored adapter.
describe('spawn options (the security surface)', () => {
  it('never enables a shell', () => {
    // Checked at RUNTIME as well as in the type: the return type has no `shell` field, so a `shell: true`
    // would not compile — but a cast or a widened signature would, and this is the one property whose
    // absence actually matters.
    const opts = spawnOptionsFor({ cwd: '/x', env: {} }) as unknown as Record<string, unknown>;
    expect(opts.shell).toBeUndefined();
    expect(Object.keys(opts)).not.toContain('shell');
  });

  it('never gives the child our stdin, and captures both output streams', () => {
    expect(spawnOptionsFor({ cwd: '/x', env: {} }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('forwards cwd, env and the abort signal', () => {
    const signal = new AbortController().signal;
    const opts = spawnOptionsFor({ cwd: '/build', env: { A: '1' }, signal });
    expect(opts).toMatchObject({ cwd: '/build', env: { A: '1' }, signal });
  });
});
