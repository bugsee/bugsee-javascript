import type { CaptureStore, StoredEntry } from '@bugsee/core';
import type { AsyncBlobStore } from './idb';

// A persistent CaptureStore: the rolling capture buffer survives a reload. The sync CaptureStore
// contract (add/tick/snapshot/clear) is served by an in-memory `mirror` (a normal memory store), while
// each PART closed by tick() is flushed to IndexedDB and parts outside the recording window are evicted
// — the same windowing the mirror applies, in parallel. On open the persisted parts hydrate back into
// the mirror, so a report assembled after a reload still includes pre-reload capture. Persistence and
// hydration failures route to onError and never throw; the open (not-yet-ticked) part is in-memory only
// until it closes, so at most ~one tick of data is unpersisted (the bundle store covers crash delivery).

/** A {@link CaptureStore} whose closed parts are persisted to an async blob store. */
export interface PersistentCaptureStore extends CaptureStore {
  /** Resolves once persisted parts have hydrated back into the mirror. */
  readonly whenReady: Promise<void>;
}

export interface PersistentCaptureStoreOptions {
  /**
   * Recording window in ms — persisted parts older than this are evicted on tick. This approximately
   * matches the mirror's own window eviction (the persisted set trails the live window by ≤1 part).
   */
  maxRecordingTimeMs: number;
  /** Failure sink for persistence/hydration. Default no-op. */
  onError?: (error: unknown) => void;
  /**
   * Run-unique prefix for this launch's part ids, so a tick during hydration can never collide with a
   * part id a prior run persisted. Default a timestamp; injectable for deterministic tests.
   */
  idPrefix?: string;
}

interface SerializedPart {
  records: StoredEntry[];
  closedAt: number;
}

const encodePart = (part: SerializedPart): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(part));
const decodePart = (bytes: Uint8Array): SerializedPart =>
  JSON.parse(new TextDecoder().decode(bytes)) as SerializedPart;

/**
 * Adapt an async {@link AsyncBlobStore} into a persistent {@link CaptureStore} over an in-memory
 * `mirror`. `add`/`tick`/`snapshot`/`clear` stay synchronous; closed parts persist through
 * asynchronously; `whenReady` re-applies persisted parts to the mirror on open.
 */
export function createPersistentCaptureStore(
  blob: AsyncBlobStore,
  mirror: CaptureStore,
  options: PersistentCaptureStoreOptions,
): PersistentCaptureStore {
  const onError = options.onError ?? (() => {});
  const idPrefix = options.idPrefix ?? String(Date.now());
  let counter = 0;
  let currentPart: StoredEntry[] = [];
  // Persisted part id → its closedAt, so eviction can match the mirror's window without reading IDB.
  const partCloseTimes = new Map<string, number>();

  const whenReady = blob.loadAll().then((entries) => {
    // Re-apply persisted parts to the mirror oldest-first (by closedAt) so ordering is preserved.
    const parts: Array<{ id: string; part: SerializedPart }> = [];
    for (const [id, bytes] of entries) {
      try {
        parts.push({ id, part: decodePart(bytes) });
      } catch (error) {
        onError(error);
        blob.remove(id).catch(onError); // purge an unparseable leftover
      }
    }
    parts.sort((a, b) => a.part.closedAt - b.part.closedAt);
    for (const { id, part } of parts) {
      for (const record of part.records) {
        mirror.add(record);
      }
      partCloseTimes.set(id, part.closedAt);
    }
  }, onError);

  return {
    whenReady,
    add(record) {
      mirror.add(record);
      currentPart.push(record);
    },
    tick(nowMs) {
      mirror.tick(nowMs);
      if (currentPart.length > 0) {
        const id = `${idPrefix}-${counter}`;
        counter += 1;
        const records = currentPart;
        currentPart = [];
        partCloseTimes.set(id, nowMs);
        blob.put(id, encodePart({ records, closedAt: nowMs })).catch(onError);
      }
      const cutoff = nowMs - options.maxRecordingTimeMs;
      for (const [id, closedAt] of partCloseTimes) {
        if (closedAt < cutoff) {
          partCloseTimes.delete(id);
          blob.remove(id).catch(onError);
        }
      }
    },
    snapshot() {
      return mirror.snapshot();
    },
    clear() {
      mirror.clear();
      currentPart = [];
      for (const id of [...partCloseTimes.keys()]) {
        blob.remove(id).catch(onError);
      }
      partCloseTimes.clear();
    },
  };
}
