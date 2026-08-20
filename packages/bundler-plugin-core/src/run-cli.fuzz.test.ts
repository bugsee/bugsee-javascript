import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BugseeCliError,
  type EnvRecord,
  resolveBugseeCli,
  runBugseeCli,
  type SpawnFn,
  spawnOptionsFor,
} from './run-cli';

/**
 * Property-based tests for the `bugsee-cli` invocation layer.
 *
 * This is a CLI/argument builder driven by user configuration: arbitrary output paths, arbitrary tokens,
 * arbitrary endpoints, and whatever environment a CI runner happens to have. That is a natural fuzz
 * target, and two of its invariants are security ones — the token must never reach argv (it would show up
 * in every `ps` on the machine), and the child must never be run through a shell. The rest are
 * "the caller's environment is passed through UNCHANGED except for the keys we deliberately set", which
 * example tests only ever sample at one or two points.
 */

/** Env keys that are not the two this layer owns — so a generated base env can be checked for pass-through. */
const envKey = fc
  .stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/)
  .filter((k) => k !== 'BUGSEE_APP_TOKEN' && k !== 'BUGSEE_ENDPOINT' && k !== 'BUGSEE_CLI_PATH');
const baseEnv = fc.dictionary(envKey, fc.string({ maxLength: 12 }), { maxKeys: 6 });
const argv = fc.array(fc.string({ maxLength: 20 }), { maxLength: 6 });

/** Records the single spawn call and returns a scripted result. */
function recordingSpawn(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ command: string; args: string[]; options: Parameters<SpawnFn>[2] }> = [];
  const spawn: SpawnFn = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { spawn, calls };
}

describe('resolveBugseeCli — properties', () => {
  it('uses the override exactly when it carries something other than whitespace', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (override) => {
        const expected = override.trim() === '' ? 'bugsee-cli' : override;
        expect(resolveBugseeCli({ BUGSEE_CLI_PATH: override })).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('falls back to the bare name for any env that does not set the override', () => {
    fc.assert(
      fc.property(baseEnv, (env) => {
        expect(resolveBugseeCli(env as EnvRecord)).toBe('bugsee-cli');
      }),
      { numRuns: 200 },
    );
  });
});

describe('spawnOptionsFor — properties', () => {
  it('never enables a shell and always fixes stdio, whatever it is handed', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        baseEnv,
        fc.boolean(),
        (cwd, env, withSignal) => {
          const signal = withSignal ? new AbortController().signal : undefined;
          const opts = spawnOptionsFor({ cwd, env: env as EnvRecord, signal });
          expect(Object.keys(opts)).not.toContain('shell');
          expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
          expect(opts.cwd).toBe(cwd);
          expect(opts.env).toBe(env);
          // the signal is carried through iff one was given — a dropped signal leaves an orphan child
          expect('signal' in opts).toBe(withSignal);
          expect(opts.signal).toBe(signal);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('runBugseeCli — properties', () => {
  it('passes the caller’s environment through UNCHANGED apart from the keys it owns', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseEnv,
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        async (env, token, endpoint) => {
          const { spawn, calls } = recordingSpawn({ code: 0 });
          await runBugseeCli(['x'], { spawn, env: env as EnvRecord, token, endpoint });
          const childEnv = calls[0]?.options.env ?? {};
          for (const [k, v] of Object.entries(env)) expect(childEnv[k]).toBe(v);
          // Present ONLY when supplied. Setting them unconditionally would write `undefined` over an
          // inherited BUGSEE_ENDPOINT / BUGSEE_APP_TOKEN and silently un-configure the CLI.
          expect('BUGSEE_APP_TOKEN' in childEnv).toBe(token !== undefined);
          expect('BUGSEE_ENDPOINT' in childEnv).toBe(endpoint !== undefined);
          expect(childEnv.BUGSEE_APP_TOKEN).toBe(token);
          expect(childEnv.BUGSEE_ENDPOINT).toBe(endpoint);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never puts the token or the endpoint on argv, whatever the args are', async () => {
    await fc.assert(
      fc.asyncProperty(
        argv,
        fc.string({ minLength: 8, maxLength: 20 }),
        fc.string({ minLength: 8, maxLength: 30 }),
        async (args, token, endpoint) => {
          const { spawn, calls } = recordingSpawn({ code: 0 });
          await runBugseeCli(args, { spawn, env: {}, token, endpoint });
          expect(calls[0]?.args).toEqual(args); // forwarded verbatim, nothing appended
          expect(calls[0]?.args).not.toContain(token);
          expect(calls[0]?.args).not.toContain(endpoint);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects on ANY non-zero exit, carrying the code, the stderr and a naming message', async () => {
    await fc.assert(
      fc.asyncProperty(
        argv,
        fc.integer({ min: -128, max: 255 }).filter((c) => c !== 0),
        fc.string({ maxLength: 40 }),
        async (args, code, stderr) => {
          const { spawn } = recordingSpawn({ code, stderr });
          const error = (await runBugseeCli(args, { spawn, env: {} }).catch(
            (e: unknown) => e,
          )) as BugseeCliError;
          expect(error).toBeInstanceOf(BugseeCliError);
          expect(error.name).toBe('BugseeCliError');
          expect(error.code).toBe(code);
          expect(error.stderr).toBe(stderr);
          // the message must identify BOTH the command that failed and how — a bare "failed" in a build
          // log is unactionable
          expect(error.message).toBe(`bugsee-cli ${args.join(' ')} failed (exit ${code})`);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('resolves with the child’s result verbatim on exit 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        argv,
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        async (args, stdout, stderr) => {
          const { spawn } = recordingSpawn({ code: 0, stdout, stderr });
          await expect(runBugseeCli(args, { spawn, env: {} })).resolves.toEqual({
            code: 0,
            stdout,
            stderr,
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
