import type { CaptureSnapshot, StoredEntry } from './contracts';

// The storage seam beneath the chunk-based capture store (design: durable-as-captured, metadata-only in
// memory; Android `CaptureFileStorage` analog). The ChunkCaptureStore keeps only a part metadata INDEX
// in RAM and writes every entry through to a ChunkBackend — in-memory (ephemeral), filesystem (node),
// or IndexedDB (browser). Writes are SYNC-ISSUE / async-complete: openPart/appendEntry/closePart return
// immediately so the sync CaptureStore contract holds; a durable backend may complete the write
// asynchronously (routing failures to its own onError), keeping the on-termination loss window to ~one
// entry. Reads are isolated by the backend's snapshot() so the live store keeps rolling + evicting
// during export.

/** Identity of a capture part (chunk) within its generation. */
export interface PartRef {
  readonly generation: number;
  readonly number: number;
}

/** Durable per-part metadata — the recovery index unit (rebuilt into the in-memory index on open). */
export interface PartMeta {
  readonly generation: number;
  readonly number: number;
  readonly start: number;
  /** undefined while the part is open (the current part). */
  readonly end: number | undefined;
  /** Byte size of the part's stored records (in the backend's storage form). */
  readonly byteSize: number;
}

/** A part frozen into a snapshot: its identity + how many of its records the snapshot includes. */
export interface FrozenPart {
  readonly ref: PartRef;
  /** Records to include, oldest-first — the part's entry count at snapshot time (open-part boundary). */
  readonly count: number;
}

export interface ChunkBackend {
  /** This launch's generation id (groups its parts). */
  readonly generation: number;

  /** Begin a new part (and write its initial durable metadata, end = undefined). */
  openPart(part: PartRef, start: number): void;
  /** Append a record to a part; returns the byte size it contributed (for the store's byte cap). */
  appendEntry(part: PartRef, record: StoredEntry): number;
  /** Finalize a part — record its end timestamp + final byte size durably. */
  closePart(part: PartRef, end: number, byteSize: number): void;

  /** Remove a part's data + metadata (eviction). */
  removePart(part: PartRef): void;
  /** Remove an entire generation's data + metadata (clear / clean prior generation). */
  removeGeneration(generation: number): void;

  /**
   * Freeze the given parts into an ISOLATED snapshot — each part read up to its `count` records,
   * oldest-first, unaffected by subsequent add/evict on the live store. `release()` drops it.
   */
  snapshot(parts: readonly FrozenPart[]): CaptureSnapshot;

  /** Durable part metadata for a generation (recovery; empty for a fresh backend). */
  listParts(generation: number): PartMeta[] | Promise<PartMeta[]>;
  /** Every generation with persisted parts (recovery). */
  listGenerations(): number[] | Promise<number[]>;
}
