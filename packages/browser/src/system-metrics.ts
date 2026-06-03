import type { TraceSample } from '@bugsee/capture';

// Browser system-traces sampler for @bugsee/capture's systemTracesProvider — the performance.memory
// analog of node's memory/cpu sampler. `performance.memory` is non-standard (Chromium only), so the
// reader is optional-chained and the sampler emits [] where it's unavailable (every other browser).

interface BrowserMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Reads `performance.memory` (or undefined where unsupported). Injectable for tests. */
export type MemoryReader = () => BrowserMemory | undefined;

const defaultReader: MemoryReader = () =>
  (globalThis.performance as { memory?: BrowserMemory } | undefined)?.memory;

/** Build a traces sampler over `performance.memory` (default reader); yields [] when unsupported. */
export function createBrowserMemorySampler(
  read: MemoryReader = defaultReader,
): () => TraceSample[] {
  return () => {
    const memory = read();
    if (memory === undefined) {
      return [];
    }
    return [
      { name: 'browser_memory_used_heap', value: memory.usedJSHeapSize },
      { name: 'browser_memory_total_heap', value: memory.totalJSHeapSize },
      { name: 'browser_memory_heap_limit', value: memory.jsHeapSizeLimit },
    ];
  };
}
