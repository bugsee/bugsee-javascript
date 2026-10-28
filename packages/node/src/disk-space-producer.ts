import { TraceProducerBase } from '@bugsee/capture';
import { bytesToMegabytes, TraceName } from '@bugsee/protocol';
import {
  type DiskReading,
  type StorageTracker,
  type StorageTrackerEnv,
  storageTrackerFor,
} from '@bugsee/trackers/node';

// `disk_mem_free` / `disk_mem_total` (Android parity, binary integer MB like the environment envelope) for the
// filesystem the SDK's data directory lives on — NOT `/` or the cwd: it is that volume's space. Opt-in and only
// created when there IS a data directory, so an in-memory launch never reports a disk it does not use.
//
// COMPOSITION only: the statfs read, its poll timer, failure-streak reporting and the omit-never-zero rule belong to
// the per-process StorageTracker (`@bugsee/trackers/node`); this producer subscribes to its `disk` stage and maps it
// to the two trace names. Emitted every poll and NOT held (`emit`, hold:false): a held value would be re-recorded by
// the provider for the rest of the session after statfs starts failing (the data dir removed, a dead mount),
// reporting a disk reading that is no longer true.

export type { StatFs } from '@bugsee/trackers/node';

export interface DiskSpaceDeps extends Omit<StorageTrackerEnv, 'dataDir'> {
  /** The directory whose volume is measured (the launch's effective data dir). */
  dataDir: string;
  onError?: (error: unknown) => void;
}

class DiskSpaceProducer extends TraceProducerBase {
  readonly name = 'disk-space';
  #off: (() => void) | undefined;
  constructor(private readonly tracker: StorageTracker) {
    super();
  }
  // Subscribing arms the tracker's stage (an immediate read, then its own timer): no baseline to emit here.
  protected onStart(): void {
    this.#off = this.tracker.on('disk', (d) => this.poll(() => this.publish(d)));
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
  private publish(d: DiskReading): void {
    this.emit(TraceName.DISK_MEM_FREE, bytesToMegabytes(d.freeBytes));
    this.emit(TraceName.DISK_MEM_TOTAL, bytesToMegabytes(d.totalBytes));
  }
}

export function createDiskSpaceProducer(deps: DiskSpaceDeps): TraceProducerBase {
  const { onError, ...env } = deps;
  // The per-process singleton: building the producer hands it THIS launch's data dir and seams (latest launch wins).
  return new DiskSpaceProducer(storageTrackerFor(env, onError));
}
