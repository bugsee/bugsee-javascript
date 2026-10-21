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

/** The slice of Electron's `process.getSystemMemoryInfo()` we read. Sizes are KILOBYTES (KiB). */
export interface ElectronMemoryInfoLike {
  getSystemMemoryInfo?: () => {
    free?: unknown;
    fileBacked?: unknown;
    purgeable?: unknown;
    available?: unknown;
  };
}

const KIB = 1024;

/**
 * Memory available to new work from Electron's `process.getSystemMemoryInfo()` (KiB -> bytes), per platform:
 *  - macOS: `free + fileBacked + purgeable` (free pages plus memory the OS can take back without paging out: the
 *    closest native analogue of Android's `availMem`; Electron's `free` alone is only never-used pages);
 *  - Linux: `available` (the kernel's MemAvailable);
 *  - Windows: `free` (Electron fills it from `avail_phys`, standby cache included).
 * Field semantics are from Electron 44.9.3's `SystemMemoryInfo` typings (platform tags: `fileBacked` and `purgeable`
 * are macOS, `available` is Linux, `free` on Windows is avail_phys). Verified live on macOS only: a real run gave
 * {total: 67108864, free: 1236912, fileBacked: 10428768, purgeable: 388784} KB, i.e. about 11.5 GB by this formula
 * against 1.2 GB for `free` alone. Linux and Windows semantics are from the typings, not a live run.
 * Undefined on any other platform, when the API is absent, or when a needed field is not a finite non-negative number.
 * The caller still bounds the result by total RAM.
 */
export function createElectronMemoryReader(
  proc: ElectronMemoryInfoLike,
  platform: string,
): () => number | undefined {
  return () => {
    if (typeof proc.getSystemMemoryInfo !== 'function') return undefined;
    const info = proc.getSystemMemoryInfo();
    let kib: number | undefined;
    if (platform === 'darwin') {
      const { free, fileBacked, purgeable } = info;
      kib =
        isCount(free) && isCount(fileBacked) && isCount(purgeable)
          ? free + fileBacked + purgeable
          : undefined;
    } else if (platform === 'linux') {
      kib = isCount(info.available) ? info.available : undefined;
    } else if (platform === 'win32') {
      kib = isCount(info.free) ? info.free : undefined;
    }
    return kib === undefined || kib < 0 ? undefined : kib * KIB;
  };
}

/** The slice of Deno's namespace we read. `systemMemoryInfo()` reports BYTES. */
export interface DenoMemoryInfoLike {
  systemMemoryInfo?: () => { available?: unknown };
}

/**
 * `Deno.systemMemoryInfo().available`, on macOS ONLY (free + inactive pages: the quantity `os.freemem()` lacks there).
 * (If it is unavailable, the `vm_stat` source covers macOS.)
 * On Linux and Windows Deno's `os.freemem()` is already the available figure, so this source is not consulted.
 */
export function createDenoMemoryReader(
  deno: DenoMemoryInfoLike | undefined,
  platform: string,
): () => number | undefined {
  return () => {
    if (platform !== 'darwin' || typeof deno?.systemMemoryInfo !== 'function') return undefined;
    const value = deno.systemMemoryInfo().available;
    return isCount(value) && value >= 0 ? value : undefined;
  };
}

/** The first of several optional readers that answers; a reader that throws is skipped. */
export function firstAnswer(
  readers: readonly (() => number | undefined)[],
): () => number | undefined {
  return () => {
    for (const read of readers) {
      try {
        const value = read();
        if (value !== undefined) return value;
      } catch {
        // an unusable runtime API is the same as no answer
      }
    }
    return undefined;
  };
}

export interface SystemFreeSources {
  /** `process.platform`. On `darwin` `os.freemem()` is NOT a source (see {@link createSystemFreeReader}). */
  platform: string;
  /** A runtime-native "available to new work" figure in BYTES (Electron, Deno on macOS), tried first. */
  native?: () => number | undefined;
  /** Raw `/proc/meminfo` text, only supplied for a runtime whose `os.freemem()` is not MemAvailable (Bun < 1.3.13). */
  meminfo?: () => string | undefined;
  /** macOS only: `vm_stat`-derived bytes (see ./vm-stat). Never consulted on another platform. */
  vmStat?: () => number | undefined;
  /** `os.freemem()`. */
  freemem: () => number;
  total: () => number;
}

/**
 * `ram_system_free`: memory available to new work, as Android reports it (`availMem`), never merely free pages.
 * Sources in order, first plausible value (finite, >= 0, <= total) wins:
 *  1. `native`: Electron `process.getSystemMemoryInfo()`; Deno `systemMemoryInfo().available` on macOS.
 *  2. `meminfo`: `MemAvailable` from `/proc/meminfo` (Bun only).
 *  3. `vmStat`, on macOS only: free + file-backed + purgeable pages from a RARE async `/usr/bin/vm_stat` read (the
 *     same definition as Electron's `getSystemMemoryInfo`; see ./vm-stat). When it has no fresh value the trace is
 *     omitted for that tick, it never falls back to `os.freemem()`.
 *  4. `os.freemem()`, except on macOS. libuv reads `MemAvailable` on Linux (since 1.43, Node >= 16.14; Deno since
 *     2023) and `ullAvailPhys` on Windows. On macOS it is only free pages (measured 0.2-0.7% of RAM on a 64 GB Mac
 *     while the vm_stat available estimate was ~29%), so it is not a source there.
 * `process.availableMemory()` is never used: it equals `os.freemem()` without a cgroup limit, reads lower inside one,
 * is 0 on Windows Deno and includes inactive pages on macOS Deno. Inside a container the value is the HOST's
 * figure; the cgroup cap is carried by `process_memory_limit`.
 * A source that throws or answers an implausible value is skipped; none answering means undefined (omitted).
 */
export function createSystemFreeReader(src: SystemFreeSources): () => number | undefined {
  const sources: (() => number | undefined)[] = [];
  if (src.native !== undefined) sources.push(src.native);
  const { meminfo } = src;
  if (meminfo !== undefined) {
    sources.push(() => {
      const text = meminfo();
      return text === undefined ? undefined : parseMemAvailable(text);
    });
  }
  if (src.platform === 'darwin') {
    if (src.vmStat !== undefined) sources.push(src.vmStat);
  } else {
    sources.push(src.freemem);
  }
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
