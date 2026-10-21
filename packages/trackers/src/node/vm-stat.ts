// macOS "memory available to new work" from `/usr/bin/vm_stat`, for the runtimes that have no native figure
// (Node and Bun; Deno when `systemMemoryInfo` is unavailable). On macOS `os.freemem()` is free pages ONLY (measured
// 151-309 MB on a 64 GB Mac while the kernel's available estimate was ~17 GB), so the number is read from the
// kernel's own counters instead. It costs a short-lived system process, therefore it is RARE (one read per
// `intervalMs`, default 10 s), fully ASYNC, single in-flight, unref'd and time-boxed, and it spawns NOTHING until
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

  return {
    read() {
      const t = now();
      if (child === undefined && (lastStart === undefined || t - lastStart >= intervalMs)) start();
      return cached !== undefined && t - cached.at <= 2 * intervalMs ? cached.bytes : undefined;
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
