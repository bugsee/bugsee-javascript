// Readers for the node runtime-depth traces (V8 heap, cgroup memory cap, available memory). Each answers
// `undefined` when this runtime cannot give a TRUE reading, so its trace is omitted rather than invented.
// The process/os/v8 sources are injected: the defaults are wired in trace-producers.ts.

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

/** `process.availableMemory()` (Node ≥20.13, feature-detected). */
export function createAvailableMemoryReader(proc: {
  availableMemory?: () => number;
}): () => number | undefined {
  return () => {
    if (typeof proc.availableMemory !== 'function') return undefined;
    const value: unknown = proc.availableMemory();
    return isCount(value) && value >= 0 ? value : undefined;
  };
}
