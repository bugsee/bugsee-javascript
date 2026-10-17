import * as fsp from 'node:fs/promises';
import { TraceProducerBase } from '@bugsee/capture';
import type { Scheduler } from '@bugsee/core';
import { bytesToMegabytes } from '@bugsee/protocol';

// `disk_mem_free` / `disk_mem_total` (Android parity, binary integer MB like the environment envelope) for the
// filesystem the SDK's data directory lives on — NOT `/` or the cwd: it is that volume's space. Opt-in and only
// created when there IS a data directory, so an in-memory launch never reports a disk it does not use. Polled
// every few seconds off the event loop (`fs.promises.statfs`), change-driven and held like the other
// change-driven traces so the provider keeps it in a rolling window.

export interface StatFsResult {
  bsize: number;
  bavail: number;
  blocks: number;
}
export type StatFs = (path: string) => Promise<StatFsResult>;

export interface DiskSpaceDeps {
  /** The directory whose volume is measured (the launch's effective data dir). */
  dataDir: string;
  /** Test seam. `null` = the runtime has no statfs (nothing is read). Default: `fs.promises.statfs` when present. */
  statfs?: StatFs | null;
  scheduler?: Scheduler;
  /** Android reads disk every 5 s. */
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

// Unref'd so the producer never keeps a process alive.
const defaultScheduler: Scheduler = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const isCount = (n: number): boolean => Number.isFinite(n) && n >= 0;
const isPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

class DiskSpaceProducer extends TraceProducerBase {
  readonly name = 'disk-space';
  readonly #deps: DiskSpaceDeps;
  readonly #statfs: StatFs | undefined;
  #timer: unknown = null;
  #inFlight = false;
  #generation = 0;

  constructor(deps: DiskSpaceDeps) {
    super();
    this.#deps = deps;
    // Namespace import: a Node without `statfs` (< 18.15) must degrade to "no traces", not fail to load.
    const real = (fsp as { statfs?: StatFs }).statfs;
    this.#statfs = deps.statfs === undefined ? real : (deps.statfs ?? undefined);
  }

  protected onStart(): void {
    if (this.#statfs === undefined) return;
    this.#generation += 1;
    this.#read(this.#generation);
    const generation = this.#generation;
    this.#timer = (this.#deps.scheduler ?? defaultScheduler).setInterval(
      () => this.#read(generation),
      this.#deps.intervalMs ?? 5000,
    );
  }

  protected override onStop(): void {
    // A read still in flight is abandoned: the next start() opens a new generation (so it can never land) and
    // this frees the in-flight latch it would otherwise hold for ever. Until then the base class drops emits.
    this.#inFlight = false;
    if (this.#timer !== null) (this.#deps.scheduler ?? defaultScheduler).clearInterval(this.#timer);
  }

  #read(generation: number): void {
    if (this.#inFlight || this.#statfs === undefined) return;
    this.#inFlight = true;
    let pending: Promise<StatFsResult>;
    try {
      pending = this.#statfs(this.#deps.dataDir);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (s) => {
        if (generation !== this.#generation) return;
        this.#inFlight = false;
        this.#publish(s);
      },
      (error: unknown) => {
        if (generation !== this.#generation) return;
        this.#inFlight = false;
        this.#deps.onError?.(error);
      },
    );
  }

  // Omit, never zero: an unsane reading emits nothing. `bavail` may legitimately be 0 (a full disk).
  #publish(s: StatFsResult): void {
    if (!isPositive(s.bsize) || !isCount(s.bavail) || !isPositive(s.blocks)) return;
    this.emitIfChanged('disk_mem_free', bytesToMegabytes(s.bsize * s.bavail));
    this.emitIfChanged('disk_mem_total', bytesToMegabytes(s.bsize * s.blocks));
  }
}

export function createDiskSpaceProducer(deps: DiskSpaceDeps): TraceProducerBase {
  return new DiskSpaceProducer(deps);
}
