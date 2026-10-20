import * as fsp from 'node:fs/promises';
import { resolve } from 'node:path';
import nodeProcess from 'node:process';
import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';

// Node/Bun/Deno STORAGE tracker (domain tracker, design §15.2; Android reference: BugseeTrackerStorage). It owns the
// disk-space read for ONE directory's volume (the launch's effective data dir, NOT `/` or the cwd) through
// `fs.promises.statfs`, and polls it sparsely off the event loop. One stage:
//
//   disk -> { freeBytes, totalBytes }     free = bsize * bavail (what an unprivileged process can use), total = bsize * blocks
//
// PER-LISTENER ACTIVATION. Nothing runs at construction. While the stage has a listener the tracker reads the volume
// at once and then on its own unref'd timer (default 5 s, Android parity); with no listener there is no timer and no
// read. A tracker with no data dir, or a runtime without `statfs` (`statfs: null`, or Node < 18.15), stays inert.
//
// ABSENCE IS NEVER ZERO. A read that fails, or answers numbers that are not sane (non-positive block size or total,
// negative/non-finite free), emits nothing. `freeBytes` may be a true 0 (a full disk). FAILURES are reported once
// per failure streak (a removed data dir fails on every poll and must not flood `onError`); a success starts a new
// streak.
//
// SINGLETON per VOLUME IDENTITY (see `storageTrackerFor`): the key is the resolved data dir, so two launches over
// the same directory share one tracker and two launches over different directories get DIFFERENT trackers (a running
// launch can never be redirected to another launch's directory, nor have its failures reported to another launch's
// `onError`). A launch without a data dir gets the inert `process`-keyed tracker; an explicit `key` overrides (tests).
// Within one key, SEAMS MERGE, NEVER DROP: a later launch that omits `onError`/`scheduler`/`statfs` KEEPS the previous
// launch's (it can replace one, never shed one), and the LATEST launch's wins. A change to any seam while a listener
// is attached tears the poll down (the timer is cleared on the scheduler that armed it) and starts it again at once on
// the merged seams; an unchanged relaunch restarts nothing. Tests that inject fakes must use a private `key` or call
// `resetStorageTracker()`.
//
// RETENTION rule — what survives the last unsubscribe: ONLY the merged seams. The last reading does not survive
// (`current()` is undefined with no listener attached): free space is a live number and a retained one would be a lie
// by the next subscriber. It is also dropped on a failed/unsane read and on a path change. Every read and timer
// callback is guarded by the generation that armed it, so a read still in flight when the tracker stops, or when the
// path/seams change, can neither report nor emit when it settles, and a timer whose clear failed never reads.

export interface StatFsResult {
  bsize: number;
  bavail: number;
  blocks: number;
}
export type StatFs = (path: string) => Promise<StatFsResult>;

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
}
export interface StorageEvents {
  disk: DiskReading;
}

export interface StorageTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** What the tracker needs from a launch. Every member is optional; an absent one keeps the earlier launch's. */
export interface StorageEnv {
  /** The directory whose volume is measured. Without one the tracker is inert. */
  dataDir?: string;
  /** Test seam. `null` = the runtime has no statfs (nothing is read). Default: `fs.promises.statfs` when present. */
  statfs?: StatFs | null;
  /** Drives the poll; default the global timers, unref'd so the tracker never holds a process alive. */
  scheduler?: StorageTimers;
  /** Poll period in ms (default 5000; Android reads disk every 5 s). */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5000;

const defaultScheduler: StorageTimers = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const SEAM_KEYS = [
  'dataDir',
  'statfs',
  'scheduler',
  'intervalMs',
] as const satisfies readonly (keyof StorageEnv)[];

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const isPositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

export class StorageTracker extends InterceptorBase<StorageEvents> {
  readonly name = 'node-storage';
  #env: StorageEnv;
  #active = false;
  #timer: { handle: unknown; scheduler: StorageTimers } | null = null;
  #inFlight = false;
  #failing = false;
  /** Bumped by every teardown/restart: a read or timer callback of an older run never reports or emits. */
  #gen = 0;
  #last: DiskReading | undefined;
  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(env: StorageEnv = {}, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    // A throwing reporter must not escape into the emitter's dispatch (which runs inside the host's timers).
    super((error) => {
      try {
        report.fn?.(error);
      } catch {
        /* the reporter itself failed */
      }
    });
    this.#report = report;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker. A defined `onError` replaces the reporter (undefined keeps
   * it). Every defined seam REPLACES ours (`statfs: null` is defined: it switches the read off); an undefined one never
   * clobbers an earlier one. When a seam actually changed and a listener is attached, the poll is torn down with the
   * seams it was armed with and started again at once on the merged ones (a new path is read immediately).
   */
  rebind(env: StorageEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const merged: Record<string, unknown> = {};
    let changed = false;
    for (const key of SEAM_KEYS) {
      const given = (env as Record<string, unknown>)[key];
      const kept = (this.#env as Record<string, unknown>)[key];
      const next = given !== undefined ? given : kept;
      if (next !== undefined) merged[key] = next;
      if (next !== kept) changed = true;
    }
    if (!changed) return;
    if (this.#active) this.#end(); // OLD seams
    this.#env = merged as StorageEnv;
    if (this.#active) this.#begin();
  }

  /** The last reading of the current run; undefined with no listener, before the first read, and after a failed read. */
  current(): DiskReading | undefined {
    return this.#last === undefined ? undefined : { ...this.#last };
  }

  /** Test/teardown: drop EVERY listener (which releases the timer and ignores anything in flight). */
  reset(): void {
    this.removeAllListeners();
  }

  protected onActivate(): void {
    this.#active = true;
    this.#begin();
  }

  protected override onDeactivate(): void {
    this.#active = false;
    this.#end();
  }

  #onError(error: unknown): void {
    try {
      this.#report.fn?.(error);
    } catch {
      /* the reporter itself failed */
    }
  }

  #statfs(): StatFs | undefined {
    const seam = this.#env.statfs;
    if (seam !== undefined) return seam ?? undefined;
    // Namespace import: a Node without `statfs` (< 18.15) must degrade to "no reading", not fail to load.
    return (fsp as { statfs?: StatFs }).statfs;
  }

  /** Arms the timer and reads once, against the CURRENT seams. Inert without a data dir or a statfs. */
  #begin(): void {
    if (this.#env.dataDir === undefined || this.#statfs() === undefined) return;
    const scheduler = this.#env.scheduler ?? defaultScheduler;
    const gen = ++this.#gen;
    try {
      const handle = scheduler.setInterval(() => {
        if (gen === this.#gen) this.#read(gen);
      }, this.#env.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.#timer = { handle, scheduler };
    } catch (error) {
      this.#onError(error); // nothing would ever poll again: stay inert (retried on the next activation/rebind)
      return;
    }
    this.#read(gen);
  }

  /** Releases the timer (on the scheduler that armed it) and abandons any read in flight. */
  #end(): void {
    this.#gen += 1;
    this.#inFlight = false;
    this.#failing = false;
    this.#last = undefined;
    const timer = this.#timer;
    this.#timer = null;
    if (timer === null) return;
    try {
      timer.scheduler.clearInterval(timer.handle);
    } catch (error) {
      this.#onError(error);
    }
  }

  #read(gen: number): void {
    const statfs = this.#statfs();
    const dataDir = this.#env.dataDir;
    if (this.#inFlight || statfs === undefined || dataDir === undefined) return;
    this.#inFlight = true;
    let pending: Promise<StatFsResult>;
    try {
      pending = Promise.resolve(statfs(dataDir));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (s) => {
        if (gen !== this.#gen) return;
        this.#inFlight = false;
        this.#failing = false;
        this.#publish(s);
      },
      (error: unknown) => {
        if (gen !== this.#gen) return;
        this.#inFlight = false;
        this.#last = undefined; // an unreadable volume is a gap, never the previous number
        // One report per failure streak: a removed data dir fails on every poll.
        if (!this.#failing) this.#onError(error);
        this.#failing = true;
      },
    );
  }

  // Omit, never zero: an unsane reading emits nothing. `bavail` may legitimately be 0 (a full disk).
  #publish(s: StatFsResult): void {
    const { bsize, bavail, blocks } = (s ?? {}) as Partial<Record<keyof StatFsResult, unknown>>;
    if (!isPositive(bsize) || !isCount(bavail) || !isPositive(blocks)) {
      this.#last = undefined;
      return;
    }
    const freeBytes = bsize * bavail;
    const totalBytes = bsize * blocks;
    if (!isCount(freeBytes) || !isPositive(totalBytes)) {
      this.#last = undefined; // the product overflowed
      return;
    }
    this.#last = { freeBytes, totalBytes };
    this.emit('disk', { ...this.#last });
  }
}

const registry = createTrackerRegistry<StorageTracker>();

/** A {@link StorageEnv} plus an explicit object to key the singleton on (overrides the data-dir identity; for tests). */
export interface StorageTrackerEnv extends StorageEnv {
  key?: object;
}

function seamsOf(env: StorageTrackerEnv): StorageEnv {
  const seams: Record<string, unknown> = {};
  for (const key of SEAM_KEYS) {
    const value = env[key];
    if (value !== undefined) seams[key] = value;
  }
  // The same normalised spelling the key uses: `/d` and `/d/` are one volume, so an equivalent relaunch is unchanged.
  if (env.dataDir !== undefined) seams.dataDir = resolve(env.dataDir);
  return seams as StorageEnv;
}

// One interned key object per resolved data dir (the registry is a WeakMap over objects). The map holds one small
// object per distinct directory ever launched with; `resetStorageTracker` drops them.
const dirKeys = new Map<string, object>();

function keyOf(env: StorageTrackerEnv): object {
  if (env.key !== undefined) return env.key;
  if (env.dataDir === undefined) return nodeProcess;
  const dir = resolve(env.dataDir);
  let key = dirKeys.get(dir);
  if (key === undefined) {
    key = {};
    dirKeys.set(dir, key);
  }
  return key;
}

/**
 * The singleton StorageTracker for the env's volume identity (the resolved `dataDir`; an explicit `key` overrides;
 * no data dir means the shared inert `process`-keyed tracker). Every call (a relaunch on the same directory included)
 * hands the shared tracker the latest launch's `onError` and seams (see {@link StorageTracker.rebind}); nothing else of
 * the env is kept.
 */
export function storageTrackerFor(
  env: StorageTrackerEnv = {},
  onError?: (error: unknown) => void,
): StorageTracker {
  const seams = seamsOf(env);
  return registry.for(
    keyOf(env),
    () => new StorageTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/**
 * Test/teardown: drop trackers (resetting them, so timers are released and in-flight reads ignored). With an object
 * key: that key's tracker. With a string: the tracker of that data dir. With nothing: EVERY tracker (all data dirs and
 * the `process`-keyed one).
 */
export function resetStorageTracker(key?: object | string): void {
  if (typeof key === 'string') {
    const dir = resolve(key);
    const interned = dirKeys.get(dir);
    dirKeys.delete(dir);
    if (interned !== undefined) registry.reset(interned);
    return;
  }
  if (key !== undefined) {
    registry.reset(key);
    return;
  }
  for (const interned of dirKeys.values()) registry.reset(interned);
  dirKeys.clear();
  registry.reset(nodeProcess);
}
