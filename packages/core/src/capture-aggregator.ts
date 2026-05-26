import type { FileType } from '@bugsee/protocol';
import type { CaptureAggregator, CaptureDataEntry } from './contracts';
import { createRingBuffer, type RingBuffer } from './ring-buffer';

// The single capture data adapter (Android BugseeCaptureAggregator parity, design §7.7). Every
// provider pushes its filtered/sanitized entries here; the aggregator routes each entry to the ring
// buffer for its file-type (the in-memory store in bundle mode) and, at trigger, atomically drains
// all buffers grouped by type (snapshot-copy + clear for the next bundle).

export interface CaptureAggregatorOptions {
  /** Ring-buffer capacity for a file-type with no explicit override. Default 1000. */
  defaultCapacity?: number;
  /** Per-file-type capacity overrides (e.g. breadcrumbs: maxBreadcrumbs). */
  capacities?: Partial<Record<FileType, number>>;
}

export function createCaptureAggregator(options?: CaptureAggregatorOptions): CaptureAggregator {
  const defaultCapacity = options?.defaultCapacity ?? 1000;
  const capacities = options?.capacities ?? {};
  const buffers = new Map<FileType, RingBuffer<CaptureDataEntry>>();

  const bufferFor = (type: FileType): RingBuffer<CaptureDataEntry> => {
    let buffer = buffers.get(type);
    if (buffer === undefined) {
      buffer = createRingBuffer<CaptureDataEntry>(capacities[type] ?? defaultCapacity);
      buffers.set(type, buffer);
    }
    return buffer;
  };

  return {
    addEntry(entry: CaptureDataEntry): void {
      bufferFor(entry.type).push(entry);
    },

    addEntries(entries: readonly CaptureDataEntry[]): void {
      for (const entry of entries) {
        bufferFor(entry.type).push(entry);
      }
    },

    snapshot(): Map<FileType, CaptureDataEntry[]> {
      const result = new Map<FileType, CaptureDataEntry[]>();
      for (const [type, buffer] of buffers) {
        const entries = buffer.drain();
        if (entries.length > 0) {
          result.set(type, entries);
        }
      }
      return result;
    },

    clear(): void {
      for (const buffer of buffers.values()) {
        buffer.clear();
      }
    },
  };
}
