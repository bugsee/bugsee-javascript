// Readers for the node runtime-depth traces (V8 heap, cgroup memory cap, system free memory). Each answers
// `undefined` when this runtime cannot give a TRUE reading, so its trace is omitted rather than invented.
// The process/os/v8 sources are injected: the defaults are wired in process-tracker.ts.

/** The V8 heap numbers the traces read, from `v8.getHeapStatistics()`. */
export interface V8HeapStats {
  /** `heap_size_limit`: the CEILING the heap may grow to (not the committed size). */
  limit: number;
  used: number;
  available: number;
  malloced: number;
  peakMalloced: number;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

type RawHeapStats = Partial<
  Record<
    | 'heap_size_limit'
    | 'used_heap_size'
    | 'total_available_size'
    | 'malloced_memory'
    | 'peak_malloced_memory',
    unknown
  >
>;

export function createV8HeapReader(getHeapStatistics: () => object): () => V8HeapStats | undefined {
  return () => {
    const s = getHeapStatistics() as RawHeapStats;
    const limit = s.heap_size_limit;
    const used = s.used_heap_size;
    const available = s.total_available_size;
    const malloced = s.malloced_memory;
    const peakMalloced = s.peak_malloced_memory;
    if (
      !isCount(limit) ||
      !isCount(used) ||
      !isCount(available) ||
      !isCount(malloced) ||
      !isCount(peakMalloced)
    ) {
      return undefined;
    }
    return { limit, used, available, malloced, peakMalloced };
  };
}

/**
 * The cgroup memory cap from `process.constrainedMemory()` (absent before Node 18.15 → feature-detected).
 * Reported ONLY for a value that is a real cap: `0` means unconstrained (macOS), Linux answers the 2^64
 * sentinel when there is no limit, and Bun answers total RAM when unconstrained (measured), so anything
 * `>= totalmem` is "no cap" (which also covers the sentinel). Never gate on `!== 0` alone.
 */
export function createMemoryLimitReader(
  proc: { constrainedMemory?: () => number },
  totalMemory: () => number,
): () => number | undefined {
  return () => {
    if (typeof proc.constrainedMemory !== 'function') return undefined;
    const value: unknown = proc.constrainedMemory();
    if (!isCount(value) || value <= 0 || value >= totalMemory()) return undefined;
    return value;
  };
}

/**
 * `MemAvailable` of a `/proc/meminfo` text, in BYTES (the file reports kB, i.e. KiB). This is the kernel's own
 * estimate of memory available to start new work without swapping (free + reclaimable cache), which is the
 * quantity Android's `ram_system_free` carries. Undefined when the field is absent or not a number.
 */
export function parseMemAvailable(text: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  if (match === null) return undefined;
  const kib = Number(match[1]);
  return Number.isFinite(kib) ? kib * 1024 : undefined;
}

/** The raw `/proc/meminfo` text, on Linux only (every other platform has no such file: undefined, no read attempted). */
export function createProcMeminfoReader(
  platform: string,
  readFile: (file: string) => string,
): () => string | undefined {
  return () => {
    if (platform !== 'linux') return undefined;
    try {
      return readFile('/proc/meminfo');
    } catch {
      return undefined;
    }
  };
}

export interface SystemFreeSources {
  /**
   * Prefer `/proc/meminfo` MemAvailable over `os.freemem()`? Only for runtimes whose `os.freemem()` is not known to
   * be MemAvailable-equivalent (Bun < 1.3.13 on Linux).
   */
  preferMeminfo: boolean;
  /** Raw `/proc/meminfo` text (Linux), or undefined. */
  meminfo: () => string | undefined;
  /** `os.freemem()`, the primary source on Node: see {@link createSystemFreeReader}. */
  freemem: () => number;
  total: () => number;
}

/**
 * `ram_system_free`: memory available to new work, as Android reports it (not merely "free" pages).
 *
 * Node: `os.freemem()`. It already is that quantity where the OS can say it: libuv reads `MemAvailable` on Linux
 * since 1.43 (Node >= 16.14) and uses `ullAvailPhys` (standby cache included) on Windows. `process.availableMemory()`
 * is deliberately NOT used: it equals `os.freemem()` without a cgroup limit (measured identical on macOS), and
 * inside a cgroup it counts page cache as used, so it reads LOWER than what is truly available.
 * Known limit: on macOS `os.freemem()` counts only free pages, so it undercounts reclaimable memory.
 *
 * Bun/Deno (`preferMeminfo`): `MemAvailable` from `/proc/meminfo` first (Linux), then `os.freemem()`. Their
 * `process.availableMemory()` is not comparable (Deno: 0 on Windows, includes inactive pages on macOS), so it is
 * never consulted.
 *
 * A source that throws or answers an implausible value (non-finite, negative, > total) is skipped; when none
 * answers, undefined, so the trace is omitted rather than invented.
 */
export function createSystemFreeReader(src: SystemFreeSources): () => number | undefined {
  const meminfo = (): number | undefined => {
    const text = src.meminfo();
    return text === undefined ? undefined : parseMemAvailable(text);
  };
  const sources: (() => number | undefined)[] = src.preferMeminfo
    ? [meminfo, src.freemem]
    : [src.freemem];
  return () => {
    const total = src.total();
    for (const source of sources) {
      let value: unknown;
      try {
        value = source();
      } catch {
        continue;
      }
      if (isCount(value) && value >= 0 && value <= total) return value;
    }
    return undefined;
  };
}
