import type { FileType } from '@bugsee/protocol';
import type { CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';

// Per-tenant partitioned CaptureStore (Wave 0.1 S2, docs/design/cloudflare-tenant-isolation.md).
//
// WHY. Durable Objects for different tenants are hosted in ONE JS isolate, and the carrier enforces one
// client per isolate (launch returns the existing one) while interceptors dedupe globally — so per-DO
// clients are impossible and every tenant's capture lands in one ring. Proven on real workerd: tenant C's
// incident bundle carried tenant A's and B's secrets (docs/review/cloudflare.md SEV1 #2).
//
// HOW. One underlying store per owner, composed rather than reimplemented — each partition is a full chunk
// store with its own window and byte cap, so a noisy tenant can no longer evict a quiet tenant's data from
// a shared ring (a second defect the review did not file). Routing uses `StoredEntry.owner`, which the
// aggregator resolves at write time and passes OUT-OF-BAND, so nothing here deserializes a payload.
//
// SINGLE-TENANT IS UNCHANGED. With no owner ever seen, everything lands in one default partition and an
// unfiltered snapshot returns exactly what it always did.

export interface PartitionedCaptureStoreOptions {
  /** Builds one partition. Called lazily per owner — typically `() => createMemoryCaptureStore(opts)`. */
  createPartition: () => CaptureStore;
  /**
   * Max OWNER partitions retained; the least-recently-used is reclaimed beyond it. Bounds memory when
   * Cloudflare hosts many short-lived Durable Objects in one isolate. The default (unowned) partition is
   * never reclaimed. Default 8.
   */
  maxPartitions?: number;
  /** Internal-error sink. A partition failure must never reach the app. */
  onError?: (error: unknown) => void;
}

/** A CaptureStore that can additionally snapshot a single tenant, and report its partitioning state. */
export interface PartitionedCaptureStore extends CaptureStore {
  snapshot(options?: { owner?: string }): CaptureSnapshot;
  /** Owner keys currently retained (excludes the default partition). */
  owners(): string[];
  ownerCount(): number;
  hasDefaultPartition(): boolean;
}

const DEFAULT_MAX_PARTITIONS = 8;

export function createPartitionedCaptureStore(
  options: PartitionedCaptureStoreOptions,
): PartitionedCaptureStore {
  const maxPartitions = options.maxPartitions ?? DEFAULT_MAX_PARTITIONS;
  const onError = options.onError ?? ((): void => {});
  // Insertion-ordered, and re-inserted on touch — so the first key is the least-recently-used.
  const owned = new Map<string, CaptureStore>();
  let defaultPartition: CaptureStore | undefined;

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      // Capture must never affect the app (the binding rule): a broken partition is reported, not thrown.
      onError(error);
    }
  };

  const partitionFor = (owner: string | undefined): CaptureStore | undefined => {
    if (owner === undefined) {
      defaultPartition ??= options.createPartition();
      return defaultPartition;
    }
    const existing = owned.get(owner);
    if (existing !== undefined) {
      owned.delete(owner); // re-insert to mark most-recently-used
      owned.set(owner, existing);
      return existing;
    }
    const created = options.createPartition();
    owned.set(owner, created);
    while (owned.size > maxPartitions) {
      const lru = owned.keys().next().value as string | undefined;
      if (lru === undefined) {
        break;
      }
      owned.delete(lru);
    }
    return created;
  };

  const allPartitions = (): CaptureStore[] => [
    ...(defaultPartition !== undefined ? [defaultPartition] : []),
    ...owned.values(),
  ];

  /**
   * The partitions a snapshot may read.
   *
   * FAIL CLOSED (§4.4): once ANY owner exists the isolate is known to be multi-tenant, so unattributed
   * entries cannot be attributed to a tenant and are excluded from every owner-scoped snapshot. Including
   * them is precisely the leak this exists to prevent.
   */
  const partitionsFor = (owner: string | undefined): CaptureStore[] => {
    if (owner === undefined) {
      return allPartitions();
    }
    const partition = owned.get(owner);
    return partition !== undefined ? [partition] : [];
  };

  const combinedSnapshot = (sources: CaptureSnapshot[]): CaptureSnapshot => ({
    stream: async function* () {
      for (const source of sources) {
        yield* source.stream();
      }
    },
    drainAll: async () => {
      const merged = new Map<FileType, StoredEntry[]>();
      for (const source of sources) {
        for (const [type, records] of await source.drainAll()) {
          merged.set(type, [...(merged.get(type) ?? []), ...records]);
        }
      }
      return merged;
    },
    release: () => {
      for (const source of sources) {
        try {
          source.release();
        } catch (error) {
          onError(error);
        }
      }
    },
  });

  return {
    add(record: StoredEntry): void {
      guard(() => partitionFor(record.owner)?.add(record));
    },
    tick(nowMs: number): void {
      for (const partition of allPartitions()) {
        guard(() => partition.tick(nowMs));
      }
    },
    clear(): void {
      for (const partition of allPartitions()) {
        guard(() => partition.clear());
      }
    },
    snapshot(snapshotOptions?: { owner?: string }): CaptureSnapshot {
      return combinedSnapshot(partitionsFor(snapshotOptions?.owner).map((p) => p.snapshot()));
    },
    owners: () => [...owned.keys()],
    ownerCount: () => owned.size,
    hasDefaultPartition: () => defaultPartition !== undefined,
  };
}
