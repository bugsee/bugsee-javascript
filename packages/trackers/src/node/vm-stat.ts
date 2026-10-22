// macOS "memory available to new work" from `/usr/bin/vm_stat`, for the runtimes that have no native figure
// (Node and Bun; Deno when `systemMemoryInfo` is unavailable). On macOS `os.freemem()` is free pages ONLY (measured
// 151-309 MB on a 64 GB Mac while the kernel's available estimate was ~17 GB), so the number is read from the
// kernel's own counters instead. It costs a short-lived system process, therefore it is RARE (one read per
// `intervalMs`, default 10 s), fully ASYNC, single in-flight and time-boxed (2 s; a HUNG child can therefore delay a
// process exit by up to that long: unref() releases the process handle, not the child's stdio pipes), and it spawns NOTHING until
// something asks for the value (so Electron, which has a native figure, never pays for it).
//
// FORMULA (verified against Electron 44.9.3's `process.getSystemMemoryInfo()` on macOS, so Electron, Node and Bun agree):
//   available = (Pages free + File-backed pages + Pages purgeable) * page size
// Electron's `free` is vm_stat's "Pages free" (which already EXCLUDES speculative pages), `fileBacked` is
// "File-backed pages" and `purgeable` is "Pages purgeable": two probes agreed to within 0.5% (file-backed
// 998680 vs 998956 pages, purgeable 37823 vs 37831), and `free` fell inside the range vm_stat showed while Electron
// started (it moves by ~100k pages per second, so only a range is comparable).
import { execFile as nodeExecFile } from 'node:child_process';

const FIELD = (name: string): RegExp => new RegExp(`^${name}:\\s+(\\d+)\\.\\s*$`, 'm');
const PAGE_SIZE = /\(page size of (\d+) bytes\)/;
const FREE = FIELD('Pages free');
const FILE_BACKED = FIELD('File-backed pages');
const PURGEABLE = FIELD('Pages purgeable');

/**
 * Bytes available to new work from `vm_stat` output, or undefined when the output is not recognisable (any field
 * missing or not a number, no page size). Never throws.
 */
export function parseVmStat(text: string): number | undefined {
  const pageSize = Number(PAGE_SIZE.exec(text)?.[1]);
  const free = Number(FREE.exec(text)?.[1]);
  const fileBacked = Number(FILE_BACKED.exec(text)?.[1]);
  const purgeable = Number(PURGEABLE.exec(text)?.[1]);
  if (!(pageSize > 0)) return undefined;
  const bytes = (free + fileBacked + purgeable) * pageSize;
  return Number.isFinite(bytes) ? bytes : undefined; // NaN when a field was absent
}

/** The slice of `child_process.execFile` the sampler uses. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8' },
  callback: (error: Error | null, stdout: string) => void,
) => { kill(): unknown; unref?(): unknown };

export interface VmStatSource {
  /** The latest value (bytes) or undefined. Never blocks; may start the next async read. */
  read(): number | undefined;
  /** The cached value only (same freshness rule as `read`): NEVER starts a read. */
  peek(): number | undefined;
  /** Kill an in-flight read, drop the cached value. A later `read()` starts afresh. */
  stop(): void;
}

export interface VmStatOptions {
  /** Default `child_process.execFile`. */
  execFile?: ExecFileLike;
  /** Milliseconds, default `performance.now`-like monotonic. */
  now?: () => number;
  /** Minimum gap between reads (default 10 000 ms). A value is served for at most two intervals. */
  intervalMs?: number;
  /** Return false to skip spawning (and answer nothing, without an error), e.g. a Deno `run` permission not granted. */
  canSpawn?: () => boolean;
  /** Receives the first failure of each failure streak. */
  onError?: (error: unknown) => void;
}

const VM_STAT = '/usr/bin/vm_stat';
const DEFAULT_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 2000;
const MAX_BUFFER = 64 * 1024; // real output is ~2 KB

export function createVmStatSampler(options: VmStatOptions = {}): VmStatSource {
  const exec = options.execFile ?? (nodeExecFile as unknown as ExecFileLike);
  const now = options.now ?? (() => performance.now());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let child: { kill(): unknown } | undefined;
  let cached: { bytes: number; at: number } | undefined;
  let lastStart: number | undefined;
  let failing = false;
  /** Bumped by stop(): a callback of an older read is ignored. */
  let gen = 0;

  const fail = (error: unknown): void => {
    cached = undefined;
    if (failing) return;
    failing = true;
    try {
      options.onError?.(error);
    } catch {
      /* the reporter itself failed */
    }
  };

  const start = (): void => {
    const myGen = gen;
    lastStart = now();
    try {
      const spawned = exec(
        VM_STAT,
        [],
        { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (error, stdout) => {
          if (myGen !== gen) return;
          child = undefined;
          if (error !== null) return fail(error);
          // Node's execFile timeout can fire on RESUME after a long event-loop block (>= timeout) and kill a child that
          // had already exited: it then answers err === null with EMPTY stdout. That is a missed sample, not a failure:
          // no report, and the cache keeps its (two-interval) lifetime.
          if (stdout.length === 0) return;
          const bytes = parseVmStat(stdout);
          if (bytes === undefined) return fail(new Error('unrecognized vm_stat output'));
          failing = false;
          cached = { bytes, at: now() };
        },
      );
      child = spawned;
      spawned.unref?.();
    } catch (error) {
      child = undefined;
      fail(error);
    }
  };

  const fresh = (t: number): number | undefined =>
    cached !== undefined && t - cached.at <= 2 * intervalMs ? cached.bytes : undefined;

  return {
    read() {
      const t = now();
      if (
        child === undefined &&
        (lastStart === undefined || t - lastStart >= intervalMs) &&
        (options.canSpawn?.() ?? true)
      ) {
        start();
      }
      return fresh(t);
    },
    peek() {
      return fresh(now());
    },
    stop() {
      gen += 1;
      const running = child;
      child = undefined;
      cached = undefined;
      lastStart = undefined;
      failing = false;
      try {
        running?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** The slice of the Deno namespace the vm_stat spawn needs. */
export interface DenoRunLike {
  Command?: new (
    command: string,
    options: {
      args: string[];
      clearEnv: boolean;
      stdin: 'null';
      stdout: 'piped';
      stderr: 'null';
      signal: AbortSignal;
    },
  ) => { output(): Promise<{ success: boolean; code: number; stdout: Uint8Array }> };
  permissions?: {
    querySync?: (descriptor: { name: 'run'; command: string }) => { state?: unknown };
  };
}

/**
 * Is spawning `/usr/bin/vm_stat` already GRANTED on this Deno? `permissions.querySync` never prompts (unlike the
 * node:child_process shim, which would show a blocking interactive prompt). Anything else (prompt, denied, API missing,
 * a throw) is "not granted": the caller falls back to `Deno.systemMemoryInfo()`.
 */
export function denoVmStatGranted(deno: DenoRunLike | undefined): boolean {
  try {
    return (
      typeof deno?.Command === 'function' &&
      deno.permissions?.querySync?.({ name: 'run', command: VM_STAT })?.state === 'granted'
    );
  } catch {
    return false;
  }
}

/**
 * `execFile` over `Deno.Command` (works with only `--allow-run=/usr/bin/vm_stat`; `clearEnv` keeps the spawn from reading
 * any environment variable, which would itself need `--allow-env`). Only call after {@link denoVmStatGranted}.
 */
export function createDenoExecFile(deno: DenoRunLike): ExecFileLike {
  return (file, args, options, callback) => {
    const Command = deno.Command;
    if (typeof Command !== 'function') throw new Error('Deno.Command is unavailable');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeout);
    (timer as { unref?: () => void }).unref?.();
    const finish = (error: Error | null, stdout: string): void => {
      clearTimeout(timer);
      callback(error, stdout);
    };
    new Command(file, {
      args: [...args],
      clearEnv: true,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: abort.signal,
    })
      .output()
      .then(
        (result) =>
          result.success
            ? finish(null, new TextDecoder().decode(result.stdout))
            : finish(new Error(`vm_stat exited with ${result.code}`), ''),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)), ''),
      );
    return { kill: () => abort.abort() };
  };
}
