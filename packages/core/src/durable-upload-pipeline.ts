import type { RequestJson } from '@bugsee/protocol';
import { serviceToken } from '@bugsee/service';
import { strFromU8, strToU8 } from '@bugsee/util';
import type {
  Bundle,
  OutcomeCategory,
  UploadHint,
  UploadPipeline,
  UploadResult,
} from './transport';
import { QUEUE_OVERFLOW_CODE } from './upload-pipeline';

// Durable bundle queue (design §7.8 / crash recovery). A report bundle is written to durable storage
// BEFORE its upload is attempted and removed only once the upload is confirmed; any bundle still on
// disk at the next launch (the process crashed/was killed mid-upload, or the upload kept failing) is
// re-uploaded via recover(). This is what guarantees a crash bundle survives a hard exit — the
// flush-then-exit best-effort delivery alone can lose it if the process dies before the upload lands.
// The pipeline LOGIC is platform-agnostic over a BundleStore blob adapter; the storage (node:fs,
// IndexedDB, …) is the platform's. Wrap a real UploadPipeline; it is itself an UploadPipeline.

/** A durable blob store for serialized bundles, keyed by an opaque id. */
export interface BundleStore {
  /** Durably write a bundle blob under `id` (replacing any existing one). */
  put(id: string, bytes: Uint8Array): void;
  /** Ids of every bundle still pending (written and not yet removed). */
  list(): string[];
  /** Read a bundle blob, or undefined if it is absent. */
  read(id: string): Uint8Array | undefined;
  /** Remove a bundle blob; a no-op if absent. */
  remove(id: string): void;
}

// Service token for the durable bundle store. Present only in file-backed mode (a dataDir / explicit
// store); the platform registers it so it is resolvable.
export const BundleStoreToken = serviceToken<BundleStore>('bundleStore');

export interface DurableUploadPipeline extends UploadPipeline {
  /** Re-enqueue every bundle left persisted by a prior run (crash / kill / failed upload). */
  recover(): void;
}

export interface DurableUploadPipelineOptions {
  /** Where bundles are durably staged. */
  store: BundleStore;
  /** The underlying upload pipeline that actually delivers a bundle. */
  pipeline: UploadPipeline;
  /** Per-bundle id generator. Default: timestamp + monotonic counter. */
  newId?: () => string;
  /** Sink for non-fatal persistence/cleanup/parse failures. Default no-op. */
  onError?: (error: unknown) => void;
  /** Wall clock, for the retention TTL. Default `Date.now`. */
  now?: () => number;
  /** Retention bounds for the on-disk queue. Each field defaults as documented on the interface. */
  retention?: DurableQueueRetention;
}

/**
 * Bounds on the pending on-disk queue (Wave 6.4).
 *
 * Without these the queue grows forever on a customer's production server: `sweep-instances` reaps only
 * subtrees whose OWNING PROCESS IS DEAD, so a long-lived server's own pending directory is never swept,
 * while the rate limiter admits 100 reports/minute and `maxDataSize` is MB-scale.
 *
 * Android's report queue has no such bound either — but its SIBLING queues do, and they are the idiom
 * followed here: `NotificationRelayStorage.java:47-49` caps at 1 MB / 500 entries / 72 h, and
 * `PerformanceUploadStorage.java:35` at 5 MB. Eviction is oldest-first: a fresh crash report is worth more
 * than a week-old one that has already failed to upload many times.
 */
export interface DurableQueueRetention {
  /** Max pending bundles. Default 32. */
  maxBundles?: number;
  /** Max total pending bytes. Default 64 MiB. */
  maxBytes?: number;
  /** Max age of a pending bundle. Default 7 days — the same TTL the node instance sweep already uses. */
  maxAgeMs?: number;
}

const DEFAULT_RETENTION: Required<DurableQueueRetention> = {
  maxBundles: 32,
  maxBytes: 64 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

// Durable frame: [4-byte LE header length][header JSON (utf8)][bundle body bytes]. The header carries
// the request.json + fileName so the full Bundle can be reconstructed for re-upload from the blob.
export function serializeBundle(bundle: Bundle, firstSeenMs?: number): Uint8Array {
  const header = strToU8(
    JSON.stringify({
      request: bundle.request,
      fileName: bundle.fileName,
      // When the bundle was first staged, so the TTL can be applied at recovery without a `stat` on the
      // BundleStore contract (which IndexedDB would have to fake anyway).
      ...(firstSeenMs !== undefined ? { firstSeenMs } : {}),
    }),
  );
  const out = new Uint8Array(4 + header.length + bundle.body.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(bundle.body, 4 + header.length);
  return out;
}

export function deserializeBundle(bytes: Uint8Array): Bundle {
  return readFrame(bytes).bundle;
}

/** Parse a durable frame into its bundle plus the staging metadata the retention policy needs. */
function readFrame(bytes: Uint8Array): { bundle: Bundle; firstSeenMs?: number } {
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );
  const header = JSON.parse(strFromU8(bytes.subarray(4, 4 + headerLength))) as {
    request: RequestJson;
    fileName: string;
    firstSeenMs?: number;
  };
  return {
    bundle: {
      request: header.request,
      fileName: header.fileName,
      body: bytes.subarray(4 + headerLength),
    },
    ...(typeof header.firstSeenMs === 'number' ? { firstSeenMs: header.firstSeenMs } : {}),
  };
}

export function createDurableUploadPipeline(
  options: DurableUploadPipelineOptions,
): DurableUploadPipeline {
  const { store, pipeline } = options;
  const onError = options.onError ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const retention = { ...DEFAULT_RETENTION, ...options.retention };
  let counter = 0;
  const newId =
    options.newId ??
    (() => {
      counter += 1;
      return `${Date.now()}-${counter}`;
    });

  const removeSafe = (id: string): void => {
    try {
      store.remove(id);
    } catch (error) {
      onError(error);
    }
  };

  /**
   * Whether the durable copy should be dropped after an upload attempt.
   *
   * Delivered → nothing left to keep. REFUSED → keeping it means uploading it again at the next launch,
   * getting the same refusal, and repeating for the life of the installation: a self-DoS against our own
   * collector that no amount of retention TTL fixes, because the bundle is re-staged every time. Anything
   * else (5xx, timeout, offline) is exactly what the durable queue exists to carry forward.
   *
   * Android parity: `CommunicationErrorClassifier.java:14-33` + `ReportUploadExecutor.java:182-199`.
   */
  const settled = (result: UploadResult): boolean => result.ok || result.permanent === true;

  // Every id this process has really ATTEMPTED — i.e. handed to the pipeline and not turned away for
  // want of capacity. The pump skips them, which is what makes it terminate: a bundle that failed for
  // a reason worth retrying (5xx, offline) is exactly what the durable queue carries to the next
  // launch, and retrying it again immediately would only spin.
  const attempted = new Set<string>();

  /** Was this refused for CAPACITY (worth handing back as soon as a slot frees) rather than failed? */
  const refusedForCapacity = (result: UploadResult): boolean =>
    !result.ok && result.error?.code === QUEUE_OVERFLOW_CODE;

  const attempt = (id: string, bundle: Bundle, hint?: UploadHint): Promise<UploadResult> => {
    attempted.add(id);
    return pipeline.enqueue(bundle, hint).then((result) => {
      if (refusedForCapacity(result)) {
        // It never occupied a slot, so nothing has freed and there is nothing to pump — but it was
        // not really attempted either, so it stays eligible for whenever a slot does free.
        attempted.delete(id);
        return result;
      }
      if (settled(result)) {
        removeSafe(id); // delivered, or refused — either way there is nothing left to retry
      }
      // This upload held a slot and has now released it: hand the next staged bundle over.
      //
      // Two things bound this loop, and both are load-bearing. Pumping ONLY here means no attempt can
      // happen without an upload having completed first; and `attempted` means each staged bundle is
      // handed over at most once per completion. Remove either and the pump becomes a synchronous
      // microtask spin that starves the event loop rather than failing an assertion — which is how
      // the mutation check for both of them shows up.
      pump();
      return result;
    });
  };

  /**
   * Hand ONE staged-but-not-yet-attempted bundle to the pipeline, after every completion.
   *
   * The upload pipeline admits a bounded number of concurrent uploads and REFUSES the rest
   * (`queue_overflow`). The durable copy survived that refusal, but nothing re-tried it in-process —
   * `recover()` runs only at launch — so a server that failed a burst of requests reported the first
   * few and left the rest waiting for a restart. Measured before this: 20 concurrent reports produced
   * 10 bundles and then stopped, permanently.
   *
   * One at a time, driven by completions rather than a timer, so draining cannot outrun the pipeline's
   * own admission limit.
   */
  const pump = (): void => {
    for (const id of store.list()) {
      if (attempted.has(id)) continue;
      const bytes = store.read(id);
      if (bytes === undefined) continue; // removed between list() and read()
      let bundle: Bundle;
      try {
        bundle = readFrame(bytes).bundle;
      } catch (error) {
        onError(error);
        removeSafe(id); // unparseable leftover — purge so it can't wedge the pump forever
        continue;
      }
      void attempt(id, bundle);
      return;
    }
  };

  // Re-upload a recovered bundle; drop the durable copy once it is delivered — or refused.
  const replay = (id: string, bundle: Bundle): void => {
    void attempt(id, bundle);
  };

  return {
    enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
      const id = newId();
      try {
        store.put(id, serializeBundle(bundle, now())); // durable BEFORE the upload attempt
      } catch (error) {
        onError(error); // best-effort persistence must never block the upload
      }
      return attempt(id, bundle, hint);
    },

    recover(): void {
      const at = now();
      const pending: Array<{ id: string; bundle: Bundle; firstSeenMs: number; bytes: number }> = [];

      for (const id of store.list()) {
        const bytes = store.read(id);
        if (bytes === undefined) {
          continue; // removed between list() and read()
        }
        let frame: { bundle: Bundle; firstSeenMs?: number };
        try {
          frame = readFrame(bytes);
        } catch (error) {
          onError(error);
          removeSafe(id); // unparseable leftover — purge so it can't wedge recovery forever
          continue;
        }
        // A blob written before `firstSeenMs` existed reads as "staged now". Treating unknown as the epoch
        // would delete every pending bundle on the upgrade launch — losing exactly the crash reports the
        // user upgraded to get. Such a bundle is still bounded by the count and byte caps.
        pending.push({
          id,
          bundle: frame.bundle,
          firstSeenMs: frame.firstSeenMs ?? at,
          bytes: bytes.length,
        });
      }

      // Oldest first, so eviction takes the least valuable end: a fresh crash report beats a week-old one
      // that has already failed to upload many times.
      pending.sort((a, b) => a.firstSeenMs - b.firstSeenMs);

      let totalBytes = pending.reduce((sum, p) => sum + p.bytes, 0);
      let count = pending.length;
      const kept: typeof pending = [];
      for (const item of pending) {
        const expired = at - item.firstSeenMs > retention.maxAgeMs;
        const overCount = count > retention.maxBundles;
        const overBytes = totalBytes > retention.maxBytes;
        if (expired || overCount || overBytes) {
          // Announced, not silent: a bundle that vanishes without an outcome is indistinguishable from one
          // that was delivered.
          pipeline.drop(
            expired ? 'retention_expired' : overCount ? 'retention_count' : 'retention_bytes',
            'issue',
          );
          removeSafe(item.id);
          count -= 1;
          totalBytes -= item.bytes;
          continue;
        }
        kept.push(item);
      }

      for (const item of kept) {
        replay(item.id, item.bundle);
      }
    },

    flush(timeout?: number): Promise<boolean> {
      return pipeline.flush(timeout);
    },

    drop(reason: string, category: OutcomeCategory): void {
      pipeline.drop(reason, category);
    },
  };
}
