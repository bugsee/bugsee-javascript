import { describe, expect, it, vi } from 'vitest';
import {
  createDenoExecFile,
  createVmStatSampler,
  type DenoRunLike,
  denoVmStatGranted,
  type ExecFileLike,
  parseVmStat,
} from './vm-stat';

const OUTPUT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                           1177809.
Pages inactive:                         1150902.
Pages speculative:                        26487.
Pages throttled:                              0.
Pages wired down:                        400000.
Pages purgeable:                           2000.
"Translation faults":                 123456789.
File-backed pages:                        5000.
Anonymous pages:                        900000.
`;
const PAGE = 16384;

describe('parseVmStat', () => {
  it('free + file-backed + purgeable pages, times the page size, in bytes (Electron getSystemMemoryInfo mapping)', () => {
    expect(parseVmStat(OUTPUT)).toBe((3000 + 5000 + 2000) * PAGE);
  });

  it('honours the page size on the first line (4 KiB pages on Intel)', () => {
    expect(parseVmStat(OUTPUT.replace('16384', '4096'))).toBe(10_000 * 4096);
  });

  it('does not mix up Pages free with speculative / inactive / active', () => {
    const text = OUTPUT.replace(
      'Pages free:                                3000.',
      'Pages free: 1.',
    );
    expect(parseVmStat(text)).toBe((1 + 5000 + 2000) * PAGE);
  });

  it.each([
    ['empty', ''],
    ['garbage', 'command not found'],
    ['no page size', OUTPUT.replace(/\(page size of 16384 bytes\)/, '')],
    ['zero page size', OUTPUT.replace('16384', '0')],
    ['missing free', OUTPUT.replace(/^Pages free:.*$/m, '')],
    ['missing file-backed', OUTPUT.replace(/^File-backed pages:.*$/m, '')],
    ['missing purgeable', OUTPUT.replace(/^Pages purgeable:.*$/m, '')],
    ['non-numeric', OUTPUT.replace('3000.', 'many.')],
  ])('answers undefined for %s output', (_n, text) => {
    expect(parseVmStat(text)).toBeUndefined();
  });

  it('answers undefined for a non-finite product', () => {
    expect(parseVmStat(OUTPUT.replace('3000.', `${'9'.repeat(400)}.`))).toBeUndefined();
  });
});

interface Call {
  file: string;
  args: readonly string[];
  options: { timeout: number; maxBuffer: number; encoding: string };
  cb: (error: Error | null, stdout: string) => void;
  killed: boolean;
  unref: number;
}

function harness(over: { intervalMs?: number } = {}) {
  const calls: Call[] = [];
  const errors: unknown[] = [];
  let now = 0;
  let throwOnSpawn: Error | undefined;
  const execFile: ExecFileLike = (file, args, options, cb) => {
    if (throwOnSpawn) throw throwOnSpawn;
    const call: Call = { file, args, options, cb, killed: false, unref: 0 };
    calls.push(call);
    return {
      kill: () => {
        call.killed = true;
        return true;
      },
      unref: () => {
        call.unref += 1;
      },
    };
  };
  const sampler = createVmStatSampler({
    execFile,
    now: () => now,
    intervalMs: over.intervalMs ?? 10_000,
    onError: (e) => errors.push(e),
  });
  return {
    sampler,
    calls,
    errors,
    advance: (ms: number) => {
      now += ms;
    },
    failSpawn: (e: Error | undefined) => {
      throwOnSpawn = e;
    },
  };
}

describe('createVmStatSampler', () => {
  it('first read starts one async read and answers undefined; the value arrives with the callback', () => {
    const h = harness();
    expect(h.sampler.read()).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    h.calls[0]?.cb(null, OUTPUT);
    expect(h.sampler.read()).toBe(10_000 * PAGE);
    expect(h.calls).toHaveLength(1);
  });

  it('spawns the absolute vm_stat path with no arguments, a timeout, a small maxBuffer, utf8, and unrefs the child', () => {
    const h = harness();
    h.sampler.read();
    const call = h.calls[0];
    expect(call?.file).toBe('/usr/bin/vm_stat');
    expect(call?.args).toEqual([]);
    expect(call?.options).toEqual({ timeout: 2000, maxBuffer: 64 * 1024, encoding: 'utf8' });
    expect(call?.unref).toBe(1);
  });

  it('never overlaps: reads while one is in flight do not spawn another, even past the interval', () => {
    const h = harness();
    h.sampler.read();
    h.advance(60_000);
    h.sampler.read();
    expect(h.calls).toHaveLength(1);
  });

  it('respects the cadence: no new read before one interval, one after', () => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    h.advance(9_999);
    h.sampler.read();
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    h.sampler.read();
    expect(h.calls).toHaveLength(2);
  });

  it('serves the last good value for at most two intervals, then omits (never stale)', () => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    h.advance(20_000);
    expect(h.sampler.read()).toBe(10_000 * PAGE); // exactly 2 intervals old, refresh in flight
    expect(h.calls).toHaveLength(2);
    h.advance(1);
    expect(h.sampler.read()).toBeUndefined();
  });

  it('a refresh replaces the cached value', () => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    h.advance(10_000);
    h.sampler.read();
    h.calls[1]?.cb(null, OUTPUT.replace('3000.', '4000.'));
    expect(h.sampler.read()).toBe(11_000 * PAGE);
  });

  it.each([
    ['a non-zero exit', new Error('exit 1'), ''],
    ['unparseable output', null, 'nope'],
  ])('%s: omits, drops the cache, and reports once per failure streak', (_n, error, out) => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    expect(h.sampler.read()).toBeDefined();
    h.advance(10_000);
    h.sampler.read();
    h.calls[1]?.cb(error, out);
    expect(h.sampler.read()).toBeUndefined();
    expect(h.errors).toHaveLength(1);
    h.advance(10_000);
    h.sampler.read();
    h.calls[2]?.cb(error, out);
    expect(h.errors).toHaveLength(1); // same streak: silent
    h.advance(10_000);
    h.sampler.read();
    h.calls[3]?.cb(null, OUTPUT); // recovery ends the streak
    expect(h.sampler.read()).toBeDefined();
    h.advance(10_000);
    h.sampler.read();
    h.calls[4]?.cb(error, out);
    expect(h.errors).toHaveLength(2); // a new streak reports again
  });

  it('a spawn that throws (missing binary, denied permission) is an omission, reported once, never thrown', () => {
    const h = harness();
    h.failSpawn(new Error('ENOENT'));
    expect(() => h.sampler.read()).not.toThrow();
    expect(h.sampler.read()).toBeUndefined();
    h.advance(10_000);
    expect(h.sampler.read()).toBeUndefined();
    expect(h.errors).toHaveLength(1);
    h.failSpawn(undefined);
    h.advance(10_000);
    h.sampler.read();
    expect(h.calls).toHaveLength(1); // spawning works again after the streak
  });

  it('a throwing reporter never escapes', () => {
    const calls: Call[] = [];
    const sampler = createVmStatSampler({
      execFile: (file, args, options, cb) => {
        calls.push({ file, args, options, cb, killed: false, unref: 0 });
        return { kill: () => true };
      },
      now: () => 0,
      onError: () => {
        throw new Error('reporter');
      },
    });
    sampler.read();
    expect(() => calls[0]?.cb(new Error('x'), '')).not.toThrow();
  });

  it('stop() kills the in-flight child, drops the cache, and ignores its late callback', () => {
    const h = harness();
    h.sampler.read();
    h.sampler.stop();
    expect(h.calls[0]?.killed).toBe(true);
    h.calls[0]?.cb(null, OUTPUT); // late result of a torn-down run
    expect(h.sampler.read()).toBeUndefined();
    expect(h.calls).toHaveLength(2); // a fresh read starts (no longer in flight)
  });

  it('stop() drops a cached value and is safe to call twice or when idle', () => {
    const h = harness();
    h.sampler.stop();
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    h.sampler.stop();
    h.sampler.stop();
    expect(h.calls[0]?.killed).toBe(false); // already finished: nothing to kill
    expect(h.sampler.read()).toBeUndefined();
  });

  it('a throwing kill does not escape stop()', () => {
    const sampler = createVmStatSampler({
      execFile: () => ({
        kill: () => {
          throw new Error('kill');
        },
      }),
      now: () => 0,
    });
    sampler.read();
    expect(() => sampler.stop()).not.toThrow();
  });

  it('works without an onError and uses the real clock and child_process by default', () => {
    const sampler = createVmStatSampler({
      execFile: () => {
        throw new Error('x');
      },
    });
    expect(sampler.read()).toBeUndefined();
  });
});

describe('createVmStatSampler: cadence, streaks, silent misses', () => {
  it('the DEFAULT interval is 10 s (and the default freshness window 20 s)', () => {
    const calls: Call[] = [];
    let now = 0;
    const sampler = createVmStatSampler({
      execFile: (file, args, options, cb) => {
        calls.push({ file, args, options, cb, killed: false, unref: 0 });
        return { kill: () => true };
      },
      now: () => now,
    });
    sampler.read();
    calls[0]?.cb(null, OUTPUT);
    now = 9_999;
    sampler.read();
    expect(calls).toHaveLength(1);
    now = 10_000;
    sampler.read();
    expect(calls).toHaveLength(2);
    calls[1]?.cb(null, OUTPUT);
    now = 30_000;
    expect(sampler.read()).toBe(10_000 * PAGE); // 20 s after the second value: still served
    now = 30_001;
    expect(sampler.peek()).toBeUndefined();
  });

  it('spawns exactly once per interval over several intervals, ticking every second', () => {
    const h = harness();
    for (let second = 0; second < 50; second += 1) {
      h.sampler.read();
      h.calls.at(-1)?.cb(null, OUTPUT);
      h.advance(1000);
    }
    expect(h.calls).toHaveLength(5);
  });

  it('a failure streak is reported again after stop() and a restart', () => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(new Error('x'), '');
    expect(h.errors).toHaveLength(1);
    h.sampler.stop();
    h.sampler.read();
    h.calls[1]?.cb(new Error('x'), '');
    expect(h.errors).toHaveLength(2);
  });

  it('empty stdout with no error (a resumed execFile timeout killed an exited child) is a silent miss: no report, cache kept', () => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    h.advance(10_000);
    h.sampler.read();
    h.calls[1]?.cb(null, '');
    expect(h.errors).toEqual([]);
    expect(h.sampler.read()).toBe(10_000 * PAGE); // still inside its two-interval life
    h.advance(10_001);
    expect(h.sampler.read()).toBeUndefined(); // and never beyond it
    expect(h.errors).toEqual([]);
  });

  it('empty stdout does not end an ongoing failure streak (no re-report)', () => {
    const h = harness();
    h.sampler.read();
    h.calls[0]?.cb(new Error('x'), '');
    h.advance(10_000);
    h.sampler.read();
    h.calls[1]?.cb(null, '');
    h.advance(10_000);
    h.sampler.read();
    h.calls[2]?.cb(new Error('y'), '');
    expect(h.errors).toHaveLength(1);
  });

  it('peek() answers the fresh cache and NEVER spawns', () => {
    const h = harness();
    expect(h.sampler.peek()).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    h.sampler.read();
    h.calls[0]?.cb(null, OUTPUT);
    h.advance(10_000);
    expect(h.sampler.peek()).toBe(10_000 * PAGE);
    expect(h.calls).toHaveLength(1);
  });

  it('canSpawn:false neither spawns nor reports; true spawns', () => {
    let allowed = false;
    const calls: unknown[] = [];
    const errors: unknown[] = [];
    const sampler = createVmStatSampler({
      execFile: () => {
        calls.push(1);
        return { kill: () => true };
      },
      canSpawn: () => allowed,
      onError: (e) => errors.push(e),
      now: () => 0,
    });
    expect(sampler.read()).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(0);
    allowed = true;
    sampler.read();
    expect(calls).toHaveLength(1);
  });
});

describe('Deno spawn (never prompts)', () => {
  const deno = (state: unknown): DenoRunLike & { asked: unknown[] } => {
    const asked: unknown[] = [];
    return {
      asked,
      Command: class {} as never,
      permissions: {
        querySync: (d) => {
          asked.push(d);
          return { state };
        },
      },
    };
  };

  it('granted only: queries exactly the run permission for /usr/bin/vm_stat via querySync', () => {
    const granted = deno('granted');
    expect(denoVmStatGranted(granted)).toBe(true);
    expect(granted.asked).toEqual([{ name: 'run', command: '/usr/bin/vm_stat' }]);
    expect(denoVmStatGranted(deno('prompt'))).toBe(false);
    expect(denoVmStatGranted(deno('denied'))).toBe(false);
    expect(denoVmStatGranted(deno(undefined))).toBe(false);
  });

  it('not granted when Deno, Command, permissions or querySync is missing, or querySync throws', () => {
    expect(denoVmStatGranted(undefined)).toBe(false);
    expect(denoVmStatGranted({ permissions: { querySync: () => ({ state: 'granted' }) } })).toBe(
      false,
    );
    expect(denoVmStatGranted({ Command: class {} as never })).toBe(false);
    expect(denoVmStatGranted({ Command: class {} as never, permissions: {} })).toBe(false);
    expect(
      denoVmStatGranted({
        Command: class {} as never,
        permissions: {
          querySync: () => {
            throw new Error('nope');
          },
        },
      }),
    ).toBe(false);
  });

  interface Made {
    command: string;
    options: Record<string, unknown>;
  }
  const fakeCommand = (
    behave: (
      signal: AbortSignal,
    ) => Promise<{ success: boolean; code: number; stdout: Uint8Array }>,
  ) => {
    const made: Made[] = [];
    const Command = class {
      constructor(command: string, options: Record<string, unknown>) {
        made.push({ command, options });
        this.options = options;
      }
      options: Record<string, unknown>;
      output() {
        return behave(this.options.signal as AbortSignal);
      }
    };
    return { made, deno: { Command } as unknown as DenoRunLike };
  };
  const opts = { timeout: 2000, maxBuffer: 1, encoding: 'utf8' } as const;

  it('runs Deno.Command with clearEnv, no stdin/stderr and the abort signal, and decodes stdout', async () => {
    const f = fakeCommand(async () => ({
      success: true,
      code: 0,
      stdout: new TextEncoder().encode(OUTPUT),
    }));
    const got = await new Promise<[Error | null, string]>((resolve) =>
      createDenoExecFile(f.deno)('/usr/bin/vm_stat', [], opts, (e, o) => resolve([e, o])),
    );
    expect(got).toEqual([null, OUTPUT]);
    expect(f.made[0]?.command).toBe('/usr/bin/vm_stat');
    expect(f.made[0]?.options).toMatchObject({
      args: [],
      clearEnv: true,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    });
  });

  it('a non-zero exit and a rejected spawn become errors; the callback fires once', async () => {
    const exit = fakeCommand(async () => ({ success: false, code: 3, stdout: new Uint8Array() }));
    const e1 = await new Promise<Error | null>((resolve) =>
      createDenoExecFile(exit.deno)('/usr/bin/vm_stat', [], opts, (e) => resolve(e)),
    );
    expect(e1?.message).toContain('3');
    const rejected = fakeCommand(async () => {
      throw new Error('NotCapable');
    });
    const e2 = await new Promise<Error | null>((resolve) =>
      createDenoExecFile(rejected.deno)('/usr/bin/vm_stat', [], opts, (e) => resolve(e)),
    );
    expect(e2?.message).toBe('NotCapable');
    const strange = fakeCommand(async () => Promise.reject('plain'));
    const e3 = await new Promise<Error | null>((resolve) =>
      createDenoExecFile(strange.deno)('/usr/bin/vm_stat', [], opts, (e) => resolve(e)),
    );
    expect(e3?.message).toBe('plain');
  });

  it('clears its timeout once the command settles (no timer left behind)', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeCommand(async () => ({ success: true, code: 0, stdout: new Uint8Array([65]) }));
      let called = false;
      createDenoExecFile(f.deno)('/usr/bin/vm_stat', [], opts, () => {
        called = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(called).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill() aborts the signal, and the timeout aborts it too', async () => {
    const hang = (signal: AbortSignal) =>
      new Promise<never>((_r, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const a = fakeCommand(hang);
    let err: Error | null = null;
    const child = createDenoExecFile(a.deno)('/usr/bin/vm_stat', [], opts, (e) => {
      err = e;
    });
    child.kill();
    await new Promise((r) => setTimeout(r, 5));
    expect((err as Error | null)?.message).toBe('aborted');
    const b = fakeCommand(hang);
    const timed = await new Promise<Error | null>((resolve) =>
      createDenoExecFile(b.deno)('/usr/bin/vm_stat', [], { ...opts, timeout: 5 }, (e) =>
        resolve(e),
      ),
    );
    expect(timed?.message).toBe('aborted');
  });

  it('throws (so the sampler reports a miss) when Deno.Command is absent', () => {
    expect(() => createDenoExecFile({})('/x', [], opts, () => {})).toThrow('Deno.Command');
  });
});
