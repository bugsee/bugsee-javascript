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
// How many EVICTED owner keys to remember, as a multiple of the partition bound. Enough that a tenant
// cycling in and out is still diagnosable; small enough that the set can never become a memory problem.
const EVICTED_TRACKING_FACTOR = 4;

/**
 * Coerce a requested partition bound to a usable integer.
 *
 * EXPORTED because the per-partition byte budget is derived from the same number somewhere else
 * (`@bugsee/vercel-edge`'s launch divides `maxDataSize` by `bound + 1`). When only the store coerced,
 * the two disagreed: `maxPartitions: 0` left the divisor at 0 → full budget per partition, resurrecting
 * the 90 MB blow-up the division exists to prevent, and `NaN` produced a NaN budget that disabled the byte
 * cap entirely (both proven empirically — docs/review/pass2-fixes-review.md SEV2 #1). One function, one
 * answer, used by both sides.
 */
export function resolveMaxPartitions(requested: number | undefined): number {
  const value = requested ?? DEFAULT_MAX_PARTITIONS;
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_PARTITIONS;
}

export function createPartitionedCaptureStore(
  options: PartitionedCaptureStoreOptions,
): PartitionedCaptureStore {
  const maxPartitions = resolveMaxPartitions(options.maxPartitions);
  const onError = options.onError ?? ((): void => {});
  // Insertion-ordered, and re-inserted on touch — so the first key is the least-recently-used.
  const owned = new Map<string, CaptureStore>();
  // Owners whose partition was reclaimed by the LRU bound. Keys only — the ring itself is freed — so a later
  // incident in that tenant can be diagnosed rather than silently producing an empty bundle.
  //
  // BOUNDED, deliberately. An unbounded set here is a monotone leak on an isolate churning through
  // short-lived per-user Durable Objects: ~101 B of heap per distinct owner, forever, against the same
  // 128 MB ceiling this whole partitioning effort exists to respect (review pass 2, SEV2 #1 — a leak the
  // first round of fixes introduced while removing another). Beyond the cap the oldest key is dropped: the
  // only loss is diagnostic precision for a long-departed tenant, which is worth far less than the memory.
  const evicted = new Set<string>();
  const maxEvictedTracked = Math.max(1, maxPartitions) * EVICTED_TRACKING_FACTOR;
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
    evicted.delete(owner);
    owned.set(owner, created);
    while (owned.size > maxPartitions) {
      const lru = owned.keys().next().value as string | undefined;
      if (lru === undefined) {
        break;
      }
      owned.delete(lru);
      evicted.add(lru);
      while (evicted.size > maxEvictedTracked) {
        const oldest = evicted.values().next().value as string | undefined;
        if (oldest === undefined) break;
        evicted.delete(oldest);
      }
    }
    return created;
  };

  const allPartitions = (): CaptureStore[] => [
    ...(defaultPartition !== undefined ? [defaultPartition] : []),
    ...owned.values(),
  ];

  /**
   * The partitions a snapshot may read. **Fail closed in BOTH directions** (§4.4).
   *
   * - A tenant-scoped snapshot sees ONLY that tenant: never another's, and never the unattributed default
   *   (which, on a multi-tenant isolate, may hold any tenant's capture).
   * - An UNSCOPED snapshot sees only the default partition — never any tenant's.
   *
   * The second half was originally missing, and it was the whole bug: an owner-less report — `withBugsee`'s
   * fetch wrapper and the on-by-default `unhandledrejection` safety net both produce one — took the unscoped
   * branch and merged every tenant partition, so a front-handler incident on a multi-tenant isolate still
   * carried every Durable Object's secrets. Reproduced on real workerd before this fix.
   *
   * On a single-tenant isolate no owners exist, so "default only" IS everything and behaviour is unchanged.
   */
  const partitionsFor = (owner: string | undefined): CaptureStore[] => {
    if (owner === undefined) {
      return defaultPartition !== undefined ? [defaultPartition] : [];
    }
    if (!owned.has(owner) && evicted.has(owner)) {
      // The tenant existed but its partition was reclaimed (LRU). Surface it: an empty bundle is otherwise
      // indistinguishable from a tenant that captured nothing.
      onError(
        new Error(
          `Bugsee: capture for tenant "${owner}" was evicted before its incident was assembled; ` +
            `the bundle will contain no capture. Raise maxPartitions (currently ${maxPartitions}).`,
        ),
      );
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
