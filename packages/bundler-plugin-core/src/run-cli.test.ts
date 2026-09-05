import { existsSync } from 'node:fs';
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
    expect(resolveBugseeCli({ BUGSEE_CLI_PATH: '   ' })).toMatch(/run-bugsee-cli\.js$/);
  });

  it('falls back to the bare name when @bugsee/bugsee-cli is not installed', () => {
    // A consumer who pruned the dependency, or an exotic layout: better to try PATH — where they may
    // have provisioned the binary themselves — than to fail here with a resolution error.
    const missing = (): string => {
      throw new Error('MODULE_NOT_FOUND');
    };
    expect(resolveBugseeCli({}, missing)).toBe('bugsee-cli');
  });

  it('spawns an explicitly-provided non-.js binary directly, with no node wrapper', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, stdout: 'ok' });
    await runBugseeCli(['sourcemaps', 'inject', './dist'], {
      spawn,
      env: { BUGSEE_CLI_PATH: '/opt/bugsee-cli' },
    });
    expect(calls[0]?.command).toBe('/opt/bugsee-cli');
    expect(calls[0]?.args).toEqual(['sourcemaps', 'inject', './dist']);
  });

  it('resolves the launcher inside the installed @bugsee/bugsee-cli package', () => {
    // Not the bare name. `@bugsee/bugsee-cli` is a dependency of THIS package, so under pnpm its bin
    // is never linked into a consuming project's root node_modules/.bin — a real consumer's build
    // failed with ENOENT, and it only ever worked inside this monorepo because the binary happened to
    // be on PATH there. Resolved from the installed package instead, which is package-manager and
    // PATH independent.
    const resolved = resolveBugseeCli({});
    expect(resolved).not.toBe('bugsee-cli');
    expect(resolved).toMatch(/run-bugsee-cli\.js$/);
    expect(existsSync(resolved)).toBe(true);
  });
});

describe('runBugseeCli', () => {
  it('resolves the binary and spawns it with the given args, returning the result on exit 0', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0, stdout: 'ok' });
    const result = await runBugseeCli(['sourcemaps', 'inject', './dist'], { spawn, env: {} });
    expect(result).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    // A `.js` launcher runs through node, not directly: a `.js` file is not spawnable on Windows and
    // a transitive dependency's bin has no `.cmd` shim there.
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args?.[0]).toMatch(/run-bugsee-cli\.js$/);
    expect(calls[0]?.args?.slice(1)).toEqual(['sourcemaps', 'inject', './dist']);
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
    // Exercises the default `process.env` + `spawnProcess` fallbacks against a trivial real process.
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
    //
    // The previous body counted `getActiveResourcesInfo()` Timeouts before/after and asserted
    // `after <= before` — which is VACUOUS here, because the watchdog is `unref`'d and an unref'd timer is
    // not an active resource at all. Deleting `clearTimeout` entirely left the assertion green. Observing
    // the call itself is the only thing that actually discriminates.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const spawn: SpawnFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });
      await runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli', timeoutMs: 60_000 });
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('clears the timer on the FAILURE path too (a rejected child must not leak the watchdog)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const spawn: SpawnFn = () => Promise.reject(new Error('spawn ENOENT'));
      await expect(
        runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli', timeoutMs: 60_000 }),
      ).rejects.toThrow('spawn ENOENT');
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('propagates a NON-timeout spawn failure as itself, not as a timeout', async () => {
    // `timedOut` gates the message. If it were ever pre-set (or the flag inverted), every failure — a
    // missing binary, an EACCES — would be reported as "timed out after 120000ms", sending the user to
    // look at their network instead of their PATH.
    const spawn: SpawnFn = () => Promise.reject(new Error('spawn bugsee-cli ENOENT'));
    await expect(runBugseeCli(['x'], { spawn, resolveBinary: () => 'cli' })).rejects.toThrow(
      'spawn bugsee-cli ENOENT',
    );
  });

  it('names the failed command in the timeout message', async () => {
    const spawn: SpawnFn = (_c, _a, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      runBugseeCli(['sourcemaps', 'inject', './dist'], {
        spawn,
        resolveBinary: () => 'cli',
        timeoutMs: 10,
      }),
    ).rejects.toThrow('bugsee-cli sourcemaps inject ./dist timed out after 10ms');
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

// SEV1 — a `bugsee-cli` KILLED BY A SIGNAL was reported as a successful run.
//
// `node:child_process` emits `close` with `code === null` (and a `signal`) when the child is terminated
// rather than exited: the Linux OOM killer on a big source-map tree, a cancelled CI job's SIGTERM, a
// `kill -9`. `code ?? 0` mapped that straight onto the shell's success code, so `runBugseeCli` resolved,
// `uploadSourcemaps` treated the upload as CONFIRMED, and step 3 deleted the client `.map` files — the
// only copy of the mapping, destroyed for symbols that were never delivered. The build stayed green.
describe('a signal-terminated child is a FAILURE, not an exit 0', () => {
  const nodeBin = () => process.execPath;

  it('rejects when the child is killed by a signal', async () => {
    await expect(
      runBugseeCli(['-e', 'process.kill(process.pid, "SIGKILL")'], { resolveBinary: nodeBin }),
    ).rejects.toBeInstanceOf(BugseeCliError);
  });

  it('reports a non-zero code and names the signal, so the failure is diagnosable', async () => {
    const error = (await runBugseeCli(
      ['-e', 'process.stderr.write("partial upload\\n"); process.kill(process.pid, "SIGKILL")'],
      { resolveBinary: nodeBin },
    ).catch((e: unknown) => e)) as BugseeCliError;
    expect(error).toBeInstanceOf(BugseeCliError);
    // NEGATIVE on purpose: a real process exit status is 0-255, so a caller (or a log reader) can tell
    // "killed by a signal" apart from "exited 1" — which is an ordinary CLI failure code.
    expect(error.code).toBe(-1);
    expect(error.stderr).toContain('partial upload'); // whatever the CLI managed to say is kept
    expect(error.stderr).toContain('SIGKILL');
    // NAMES THE COMMAND THAT DIED. This adapter is also the one the VCS dirtiness probe runs `git`
    // through, so a hard-coded "bugsee-cli" here fabricated a line blaming the wrong binary.
    expect(error.stderr).toContain(`${process.execPath} was terminated by signal SIGKILL`);
    expect(error.stderr).not.toContain('bugsee-cli was terminated');
  });

  it('still reports a clean exit 0 as success — the canary', async () => {
    const result = await runBugseeCli(['-e', 'process.stdout.write("done")'], {
      resolveBinary: nodeBin,
    });
    expect(result).toEqual({ code: 0, stdout: 'done', stderr: '' });
  });
});

// The DEFAULT spawn adapter — the code that actually runs in a user's build — was `/* v8 ignore */`'d
// wholesale and exercised only by `node --version`. Everything that distinguishes a failed upload from a
// successful one lives in it: the exit code, the captured stderr, the `error` event. These drive it
// against real child processes.
describe('the default child_process adapter (real processes)', () => {
  const nodeBin = () => process.execPath;

  it('captures stderr and the exit code of a real failing child', async () => {
    const error = (await runBugseeCli(
      ['-e', 'process.stderr.write("error: expired token"); process.exit(11);'],
      { resolveBinary: nodeBin },
    ).catch((e: unknown) => e)) as BugseeCliError;
    expect(error).toBeInstanceOf(BugseeCliError);
    expect(error.name).toBe('BugseeCliError');
    expect(error.code).toBe(11);
    expect(error.stderr).toBe('error: expired token');
    expect(error.message).toContain('failed (exit 11)');
  });

  it('captures stdout across MULTIPLE chunks (the accumulation, not just the first write)', async () => {
    const result = await runBugseeCli(
      ['-e', 'process.stdout.write("a"); process.stdout.write("b"); process.stdout.write("c");'],
      { resolveBinary: nodeBin },
    );
    expect(result.stdout).toBe('abc');
    expect(result.stderr).toBe('');
  });

  it('captures stderr across MULTIPLE chunks', async () => {
    const error = (await runBugseeCli(
      ['-e', 'process.stderr.write("x"); process.stderr.write("y"); process.exit(3);'],
      { resolveBinary: nodeBin },
    ).catch((e: unknown) => e)) as BugseeCliError;
    expect(error.stderr).toBe('xy');
  });

  it('rejects with the spawn error when the binary does not exist (never hangs)', async () => {
    await expect(
      runBugseeCli(['x'], { resolveBinary: () => '/definitely/not/a/binary/bugsee-cli' }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills a REAL child that outlives the budget, and reports it as a timeout', async () => {
    // The abort path and the new signal-termination path both fire here — a child killed by our own
    // watchdog must be reported as the timeout it is, not as "terminated by signal SIGTERM".
    await expect(
      runBugseeCli(['-e', 'setTimeout(() => {}, 30000)'], {
        resolveBinary: nodeBin,
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/timed out after 150ms/);
  });

  it('never gives the child our stdin — a CLI that reads stdin sees EOF rather than blocking', async () => {
    const result = await runBugseeCli(
      ['-e', 'process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume();'],
      { resolveBinary: nodeBin, timeoutMs: 10_000 },
    );
    expect(result.stdout).toBe('eof');
  });
});
