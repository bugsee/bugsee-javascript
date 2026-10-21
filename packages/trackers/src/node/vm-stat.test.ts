import { describe, expect, it } from 'vitest';
import { createVmStatSampler, type ExecFileLike, parseVmStat } from './vm-stat';

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
