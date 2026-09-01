import type { RequestJson } from '@bugsee/protocol';
import { serviceToken } from '@bugsee/service';
import { isThenable, strFromU8, strToU8 } from '@bugsee/util';
import {
  type Bundle,
  isUploadSettled,
  type OutcomeCategory,
  type UploadHint,
  type UploadPipeline,
  type UploadResult,
} from './transport';
import { QUEUE_OVERFLOW_CODE } from './upload-pipeline';

// Durable bundle queue (design §7.8 / crash recovery). A report bundle is written to durable storage
// BEFORE its upload is attempted and removed only once the upload is confirmed; any bundle still on
// disk at the next launch (the process crashed/was killed mid-upload, or the upload kept failing) is
// re-uploaded via recover(). This is what guarantees a crash bundle survives a hard exit — the
// flush-then-exit best-effort delivery alone can lose it if the process dies before the upload lands.
// The pipeline LOGIC is platform-agnostic over a BundleStore blob adapter; the storage (node:fs,
// IndexedDB, …) is the platform's. Wrap a real UploadPipeline; it is itself an UploadPipeline.

/**
 * A {@link Bundle} that still knows which report it was assembled for.
 *
 * `Bundle.request` is the WIRE envelope (`RequestJson`) and deliberately carries no SDK-internal report
 * id, so once a bundle is serialized into the durable queue nothing ties the blob back to the incident
 * that produced it. Recovery needs exactly that link: a dead instance can leave BOTH a staged blob and
 * the still-pending report marker for the SAME incident (the process died between the durable `put` and
 * the upload settling), and the two must be reconciled per INCIDENT — not by any set-level proxy, which
 * cannot tell a redundant blob from one nothing has ever uploaded. So the id rides in the durable FRAME
 * HEADER (below), which is local storage, never the wire.
 *
 * Optional because a frame written by an older SDK has no id, and because bundles that never came from
 * `submitReport` (a synthesized native-crash report) have no marker to reconcile against. Absent ⇒ the
 * blob is treated as unreconcilable, i.e. always replayed and never freed.
 *
 * The consequence for a pre-id frame is exact and worth stating plainly: if that incident's report marker
 * is still pending, the upgrade launch uploads it TWICE — once from the blob, once rebuilt from the marker
 * — with differing payloads (the rebuild carries the recovery timestamp, since `bundle-assembler` sets
 * `created_on` at assembly time), so nothing downstream collapses them. That is accepted rather than
 * fixed: see {@link deserializeBundle}'s frame reader for why no fallback identity is sound.
 */
export interface IdentifiedBundle extends Bundle {
  /** The `ReportingRequest.id` this bundle was assembled for; matches its {@link ReportMarker} key. */
  readonly reportId?: string;
}

// Unref'd, so a pending staging deadline never keeps a process alive on its own.
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const handle = (
      globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }
    ).setTimeout(resolve, ms);
    (handle as { unref?: () => void }).unref?.();
  });

/** A durable blob store for serialized bundles, keyed by an opaque id. */
export interface BundleStore {
  /**
   * Durably write a bundle blob under `id` (replacing any existing one).
   *
   * Return a promise if the write completes asynchronously (IndexedDB, a network-backed store): the
   * queue AWAITS it before claiming {@link UploadResult.retained}, because "the durable queue owns
   * delivery from here" is a promise the caller retires its report marker on. A store that accepts the
   * write and fails later — quota exhaustion on the browser tier is the routine case, not the exotic
   * one — must reject, or the incident is lost. A synchronous store simply returns nothing and throws.
   */
  put(id: string, bytes: Uint8Array): void | Promise<void>;
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

/** How one {@link DurableUploadPipeline.recover} pass should deliver — and choose — the staged bundles. */
export interface DurableRecoverOptions {
  /**
   * Deliver the recovered bundles through THIS pipeline instead of the wrapped one — the seam a caller
   * uses to interpose a reconciling wrapper (`createMarkerAwareBundleReplay`). The durable bookkeeping
   * (the blob is freed once the attempt settles, and never handed over twice) is unchanged.
   */
  via?: UploadPipeline;
  /**
   * Replay only the staged bundles this predicate accepts. The rest are HELD BACK — left staged, and
   * withheld from the completion pump too — until a pass with no `select` releases them. Default: take
   * everything (and release anything a previous selective pass held).
   *
   * This exists because the queue-vs-marker reconciliation is PER DEAD INSTANCE while an injected
   * `bundleStore` is shared by all of them: each dead instance's pass must take only the blobs ITS markers
   * cover (`MarkerAwareBundleReplay.pendingReportIds`), or a blob whose incident a LATER instance's marker
   * leg is still about to rebuild gets uploaded unreconciled — the very duplicate being reconciled away.
   * Holding the others back from the pump is what makes that airtight: the pump fires on every completion
   * and would otherwise pick up the next staged blob mid-scan, through the plain pipeline.
   */
  select?: (bundle: IdentifiedBundle) => boolean;
}

export interface DurableUploadPipeline extends UploadPipeline {
  /**
   * Re-enqueue every bundle left persisted by a prior run (crash / kill / failed upload), applying the
   * retention bounds first. A bundle already handed over in this process is never handed over again, so
   * several selective passes followed by an unfiltered one together replay each blob exactly once.
   */
  recover(options?: DurableRecoverOptions): void;
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
  /**
   * How long to wait for an ASYNCHRONOUS `BundleStore.put` before answering "not staged". Default 5s.
   *
   * A store that never answers must not hold the report open: the returned promise is a `pendingReports`
   * member, so wedging it wedges every unbounded `flush()`/`stop()` too. Timing out answers `false`,
   * which is the fail-safe direction — the client keeps the marker and the next launch rebuilds.
   */
  stagedWaitMs?: number;
  /** Test seam for the {@link stagedWaitMs} deadline. Default an unref'd `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
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
export function serializeBundle(bundle: IdentifiedBundle, firstSeenMs?: number): Uint8Array {
  const header = strToU8(
    JSON.stringify({
      request: bundle.request,
      fileName: bundle.fileName,
      // When the bundle was first staged, so the TTL can be applied at recovery without a `stat` on the
      // BundleStore contract (which IndexedDB would have to fake anyway).
      ...(firstSeenMs !== undefined ? { firstSeenMs } : {}),
      // Which INCIDENT this blob is (see IdentifiedBundle): the only thing that lets recovery tell a blob
      // already covered by a pending report marker from one nothing has ever uploaded. Frame-local — it is
      // not part of `request`, so it never reaches the collector.
      ...(bundle.reportId !== undefined ? { reportId: bundle.reportId } : {}),
    }),
  );
  const out = new Uint8Array(4 + header.length + bundle.body.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(bundle.body, 4 + header.length);
  return out;
}

export function deserializeBundle(bytes: Uint8Array): IdentifiedBundle {
  return readFrame(bytes).bundle;
}

/** Parse a durable frame into its bundle plus the staging metadata the retention policy needs. */
function readFrame(bytes: Uint8Array): { bundle: IdentifiedBundle; firstSeenMs?: number } {
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );
  const header = JSON.parse(strFromU8(bytes.subarray(4, 4 + headerLength))) as {
    request: RequestJson;
    fileName: string;
    firstSeenMs?: number;
    reportId?: string;
  };
  return {
    bundle: {
      request: header.request,
      fileName: header.fileName,
      body: bytes.subarray(4 + headerLength),
      // A frame written before the id existed simply has none, and is therefore never reconciled against a
      // marker. Be precise about the cost: for an incident whose marker is STILL PENDING that is not "a
      // possible duplicate" but a GUARANTEED one, once per such incident, on the single launch that
      // upgrades across this SDK version. Accepted, deliberately, because:
      //   • the only candidate fallback key is the request's content (type/summary/severity/source) —
      //     `created_on` is stamped at assembly time, so a rebuild never matches the blob's — and two
      //     genuinely distinct incidents routinely share all of it (the same bug crashing twice). Keying
      //     on it converts a bounded, one-time duplicate into a SILENT LOSS of a real crash, which is the
      //     one outcome this whole policy exists to prevent;
      //   • the window is a single launch and self-clearing: every frame this SDK writes carries an id;
      //   • a frame with no id also covers bundles that never had a marker at all (a synthesized native
      //     crash), for which replay-and-never-reconcile is simply correct.
      ...(typeof header.reportId === 'string' ? { reportId: header.reportId } : {}),
    },
    ...(typeof header.firstSeenMs === 'number' ? { firstSeenMs: header.firstSeenMs } : {}),
  };
}

export function createDurableUploadPipeline(
  options: DurableUploadPipelineOptions,
): DurableUploadPipeline {
  const { store, pipeline } = options;
  const onError = options.onError ?? (() => {});
  // `onError` is the raw user callback. On the async staging path it is called from a REJECTION handler
  // outside the try, so a throwing sink would turn a completed upload into a rejected `logException` —
  // a behaviour the synchronous path never had. Reporting a failure must not change the outcome.
  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      // a throwing sink must not defeat the guard either
    }
  };
  const now = options.now ?? (() => Date.now());
  const stagedWaitMs = options.stagedWaitMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;
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

  // Every id this process has really ATTEMPTED — i.e. handed to the pipeline and not turned away for
  // want of capacity. The pump skips them, which is what makes it terminate: a bundle that failed for
  // a reason worth retrying (5xx, offline) is exactly what the durable queue carries to the next
  // launch, and retrying it again immediately would only spin.
  const attempted = new Set<string>();

  // Staged ids a SELECTIVE recover() pass is currently HOLDING BACK for a later one (see
  // DurableRecoverOptions.select). Consulted ONLY by the pump, which runs on every completion and would
  // otherwise hand a later instance's blob over unreconciled mid-scan.
  //
  // The invariant is exact, and getting it wrong cost a report: an id is in `deferred` iff it has been
  // held back and NOT YET HANDED OVER. `recover()` itself ignores the set (so the unfiltered pass that
  // closes the scan takes every held-back blob), but it must also RETRACT the id as it hands it over —
  // otherwise a blob released by that pass and then refused for CAPACITY (`attempted.delete` below, so
  // it is eligible again) stays marked deferred, the pump gate `attempted.has(id) || deferred.has(id)`
  // skips it for the rest of the launch, and the starvation fix the pump exists to be is disabled for
  // precisely the blob that needed it.
  const deferred = new Set<string>();

  /**
   * Report a staged bundle's bytes as still held by this queue — but only while they really are.
   *
   * `attempt` frees the blob the moment the result settles, so a settled result must NOT claim to be
   * retained: by then there is nothing left on disk and the caller would release its own last copy of
   * the incident against a promise nobody is keeping.
   */
  const retainedIfPending = (result: UploadResult): UploadResult =>
    isUploadSettled(result) ? result : { ...result, retained: true };

  /** Was this refused for CAPACITY (worth handing back as soon as a slot frees) rather than failed? */
  const refusedForCapacity = (result: UploadResult): boolean =>
    !result.ok && result.error?.code === QUEUE_OVERFLOW_CODE;

  const attempt = (
    id: string,
    bundle: Bundle,
    hint?: UploadHint,
    via: UploadPipeline = pipeline,
  ): Promise<UploadResult> => {
    attempted.add(id);
    return via.enqueue(bundle, hint).then((result) => {
      if (refusedForCapacity(result)) {
        // It never occupied a slot, so nothing has freed and there is nothing to pump — but it was
        // not really attempted either, so it stays eligible for whenever a slot does free.
        attempted.delete(id);
        return result;
      }
      if (isUploadSettled(result)) {
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
    // The store is a PLATFORM component (node:fs, IndexedDB, or one the integrator injected): its list/read
    // can throw on a permission error, a `pending` path that is not a directory, a closed database. The pump
    // runs inside an upload's completion handler, so an escaping throw becomes an unhandled rejection.
    try {
      for (const id of store.list()) {
        if (attempted.has(id) || deferred.has(id)) continue;
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
        replay(id, bundle);
        return;
      }
    } catch (error) {
      onError(error);
    }
  };

  // Re-upload a recovered bundle; drop the durable copy once it is delivered — or refused.
  //
  // The `.catch` is load-bearing: `recover()` and `pump()` are fire-and-forget, so a pipeline that REJECTS
  // (rather than resolving `{ok:false}`) escapes as an UNHANDLED REJECTION out of launch — which on node
  // is a process-level event the host may be configured to treat as fatal. Recovery must never do that.
  // The blob is simply kept, exactly as for a retryable failure, and retried on the next launch.
  const replay = (id: string, bundle: Bundle, via?: UploadPipeline): void => {
    void attempt(id, bundle, undefined, via).catch(onError);
  };

  /** One recovery pass: apply the retention bounds to every staged blob, then hand the survivors over. */
  const recoverPass = (options?: DurableRecoverOptions): void => {
    const at = now();
    const pending: Array<{
      id: string;
      bundle: IdentifiedBundle;
      firstSeenMs: number;
      bytes: number;
    }> = [];

    for (const id of store.list()) {
      const bytes = store.read(id);
      if (bytes === undefined) {
        continue; // removed between list() and read()
      }
      let frame: { bundle: IdentifiedBundle; firstSeenMs?: number };
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
      // The retention pass above deliberately spans EVERY staged blob — it is a global bound, and a
      // bundle this process already tried is exactly the kind that would otherwise sit forever. Only the
      // hand-over is filtered: never twice (the same rule `pump` follows), and never one another pass owns.
      if (attempted.has(item.id)) {
        continue;
      }
      if (options?.select?.(item.bundle) === false) {
        deferred.add(item.id); // another pass's — held back from this one AND from the pump
        continue;
      }
      // Handed over ⇒ no longer held back. Without this the pump's gate keeps skipping it after a
      // capacity refusal hands it back (see `deferred` above).
      deferred.delete(item.id);
      replay(item.id, item.bundle, options?.via);
    }
  };

  return {
    enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
      const id = newId();
      // Whether the durable write ACTUALLY happened. The catch below is deliberate — a full or
      // read-only disk must not stop the upload from being attempted — but it means "the durable queue
      // owns delivery from here" is FALSE for this bundle, and the caller has no other way to find out.
      // See UploadResult.retained.
      // `true`/`false` once known; a promise while an asynchronous store is still writing.
      let staged: boolean | Promise<boolean> = false;
      try {
        const written = store.put(id, serializeBundle(bundle, now())); // durable BEFORE the attempt
        // `Promise.resolve` normalizes a hand-rolled thenable whose `then` returns something other than
        // a promise — otherwise `staged` lands on neither branch below and a working store is silently
        // reported as unstaged forever.
        staged = isThenable(written)
          ? Promise.resolve(written).then(
              () => true,
              (error: unknown) => {
                report(error); // same contract as the synchronous throw below
                return false;
              },
            )
          : true;
      } catch (error) {
        report(error); // best-effort persistence must never block the upload
      }
      // The attempt does NOT wait on the durable write; only the `retained` VERDICT does.
      const result = attempt(id, bundle, hint);
      if (staged === false) {
        return result;
      }
      if (staged === true) {
        return result.then(retainedIfPending);
      }
      const pending = staged;
      return result.then((settled) => {
        // A SETTLED upload makes staging irrelevant — `retainedIfPending` hands a settled result straight
        // back — so there is nothing to wait for, and waiting anyway is what wedged `enqueue` forever on
        // a store whose `put` never settles.
        if (isUploadSettled(settled)) {
          return settled;
        }
        return Promise.race([pending, sleep(stagedWaitMs).then(() => false)]).then((ok) =>
          ok ? retainedIfPending(settled) : settled,
        );
      });
    },

    recover(options?: DurableRecoverOptions): void {
      // Same reason as `pump` above, and it matters more here: recover() is called STRAIGHT FROM LAUNCH, so
      // an unreadable store would throw out of `Bugsee.launch()` and take the host application's startup
      // with it. Recovery is best-effort by contract — it reports and stands down.
      try {
        recoverPass(options);
      } catch (error) {
        onError(error);
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
