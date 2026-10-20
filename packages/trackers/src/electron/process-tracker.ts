import { InterceptorBase } from '../interceptor-base';
import type { ProcessTimers } from '../node/process-tracker';
import { createTrackerRegistry } from '../tracker-registry';
import { type ElectronGpu, mapGpuInfo } from './gpu-info';

// Electron MAIN-process PROCESS tracker (domain tracker, design §15.2/§15.4 TR9; Android reference:
// BugseeTrackerProcess). It owns what Electron's `app` can say about the app's processes, as THREE independent
// stages. `electron` is never imported: the app object is INJECTED as a structural {@link ElectronAppSource}.
//
//   appMetrics       app.getAppMetrics() polled on one timer     -> { processes: [{ type, pid, cpuPct?, workingSetBytes?, ... }] }
//   childProcessGone app.on('child-process-gone')                -> { type, reason, exitCode?, name? }
//   gpu              app.getGPUInfo(type), kept once usable      -> { vendor?, renderer?, gl_version?, gl_extensions? }
//
// `render-process-gone` is deliberately NOT here: it is an INCIDENT path (a renderer that died is reported, with its
// capture and minidump, by `@bugsee/electron`'s renderer-gone handler) and shares no behaviour with these stages.
//
// PER-STAGE ACTIVATION. Nothing runs at construction. `appMetrics` arms (one unref'd timer) only while it has a
// listener; `childProcessGone` attaches its single `app` listener only while it has a listener and removes THAT
// listener when the last one leaves (a tracker with no subscriber leaves no handler on the host's `app`). `gpu` is
// not listener-driven: it is a one-shot read requested with {@link ElectronProcessTracker.requestGpuInfo} and its
// result is served through `current('gpu')` (and the `gpu` stage fires each time a usable result settles).
//
// ABSENCE IS NEVER ZERO / NO FABRICATED START SAMPLES. `percentCPUUsage` is "since the previous getAppMetrics call"
// and Chromium returns 0 on the FIRST CPU-usage call per process (Electron keeps one metrics object per child
// process), so a CPU figure exists only for a pid the PREVIOUS read already listed: arming makes one PRIMING read
// whose values are discarded (its pids are remembered), the first emission is the first tick, and a process that
// appears later (a new renderer, a restarted GPU/utility process: same type, new pid) reports no `cpuPct` on its first
// tick. Where Electron reports `cpu.cumulativeCPUUsage`, a process without it has no `cpuPct` either (Electron sends 0
// "for compatibility" when it cannot read CPU). A field Electron
// did not supply (or supplied as a non-finite/negative number) is omitted from its process entry, a process with no
// usable metric is dropped, an empty result emits nothing, and a rejected/throwing/hostile GPU read leaves the GPU
// absent. `appMetrics` is a WINDOWED stage (a live read would consume the CPU window), so `current('appMetrics')`
// answers the last emitted sample of the current run: undefined until the first tick and while unarmed.
//
// SINGLETON per key object (`electronProcessTrackerFor`: the `app` object by default). SEAMS MERGE, NEVER DROP: a later
// launch that omits `scheduler`/`onError` keeps the previous launch's (it can replace a seam, never shed one).
// RETENTION rule — what survives a stage's last unsubscribe: ONLY the merged seams and a usable GPU result
// (static hardware description that a late report still needs; re-requested only for a different type or when nothing usable settled). Everything windowed starts
// FRESH on the next subscription: the priming read is repeated and the last sample is dropped. `reset()` drops
// everything including the GPU result. Every timer callback is guarded by the run that armed it, so a timer whose
// clear failed can never emit; a source that fails to arm is reported and left unarmed (retried on the next listener
// change or rebind); a throwing/async reporter never escapes into the host.

export type GpuInfoType = 'basic' | 'complete';

/** The slice of Electron's `app` this tracker reads. Every member is optional: an absent one just means the stage is absent. */
export interface ElectronAppSource {
  getAppMetrics?(): unknown;
  getGPUInfo?(type: GpuInfoType): Promise<unknown>;
  on?(event: 'child-process-gone', listener: (event: unknown, details: unknown) => void): unknown;
  removeListener?(
    event: 'child-process-gone',
    listener: (event: unknown, details: unknown) => void,
  ): unknown;
  off?(event: 'child-process-gone', listener: (event: unknown, details: unknown) => void): unknown;
}

/** One process of `app.getAppMetrics()`. Sizes are BYTES (Electron reports kilobytes); every metric is omitted when unknown. */
export interface AppProcessMetric {
  /** Electron's process type, verbatim (`Browser`, `Tab`, `GPU`, `Utility`, …). */
  type: string;
  pid: number;
  /** Share of the WHOLE machine used since the previous read, 0-100, as Electron reports it (it divides by the processor count). */
  cpuPct?: number;
  workingSetBytes?: number;
  peakWorkingSetBytes?: number;
  /** Windows only (Electron omits it elsewhere). */
  privateBytes?: number;
}

export interface ChildProcessGone {
  /** Electron's child process type (`GPU`, `Utility`, …), verbatim. */
  type: string;
  /** Electron's reason (`crashed`, `oom`, `killed`, `clean-exit`, …), verbatim. */
  reason: string;
  exitCode?: number;
  /** The utility's service name (`Network Service`, …) when Electron supplies it. */
  name?: string;
}

export interface ElectronProcessEvents {
  appMetrics: { processes: AppProcessMetric[] };
  childProcessGone: ChildProcessGone;
  gpu: ElectronGpu;
}

/** What the tracker needs from a launch. */
export interface ElectronProcessEnv {
  /** Electron's `app` (or a structural fake). */
  app?: ElectronAppSource;
  /** Drives the metrics timer; default the global timers, unref'd so the tracker never holds a process alive. */
  scheduler?: ProcessTimers;
  /** `getAppMetrics` period in ms (default 1000). */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;

const defaultScheduler: ProcessTimers = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const SEAM_KEYS = [
  'app',
  'scheduler',
  'intervalMs',
] as const satisfies readonly (keyof ElectronProcessEnv)[];

const KIB = 1024;

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const kibToBytes = (value: unknown): number | undefined => {
  const kib = finiteNonNegative(value);
  return kib === undefined ? undefined : kib * KIB;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const hasCumulative = (p: Record<string, unknown>): boolean =>
  finiteNonNegative(record(p.cpu)?.cumulativeCPUUsage) !== undefined;

interface MappedMetrics {
  /** Undefined when nothing usable came back. */
  metrics: { processes: AppProcessMetric[] } | undefined;
  /** Every pid this read listed (usable or not): the next read's "already seen" set. */
  pids: Set<number>;
}

/**
 * Maps `app.getAppMetrics()` defensively. `cpuPct` is only reported for a pid that `seen` already listed in the
 * PREVIOUS read: Chromium returns 0 on the first CPU-usage call per process (and Electron keeps one metrics object per
 * child process), so a process that appeared since (a new renderer, a restarted GPU/utility process) has no true CPU
 * figure yet. On an Electron that reports `cpu.cumulativeCPUUsage` for some processes, a process lacking it also has no
 * `cpuPct` (Electron sends 0 "for compatibility" when it cannot read CPU).
 */
function mapAppMetrics(raw: unknown, seen: ReadonlySet<number>): MappedMetrics {
  const pids = new Set<number>();
  if (!Array.isArray(raw)) return { metrics: undefined, pids };
  const entries = raw.map(record);
  const reportsCumulative = entries.some((p) => p !== undefined && hasCumulative(p));
  const processes: AppProcessMetric[] = [];
  for (const p of entries) {
    if (p === undefined) continue;
    const { type, pid } = p;
    if (
      typeof type !== 'string' ||
      type === '' ||
      typeof pid !== 'number' ||
      !Number.isFinite(pid)
    ) {
      continue;
    }
    pids.add(pid);
    const cpuPct =
      seen.has(pid) && (!reportsCumulative || hasCumulative(p))
        ? finiteNonNegative(record(p.cpu)?.percentCPUUsage)
        : undefined;
    const memory = record(p.memory);
    const workingSetBytes = kibToBytes(memory?.workingSetSize);
    const peakWorkingSetBytes = kibToBytes(memory?.peakWorkingSetSize);
    const privateBytes = kibToBytes(memory?.privateBytes);
    if (
      cpuPct === undefined &&
      workingSetBytes === undefined &&
      peakWorkingSetBytes === undefined &&
      privateBytes === undefined
    ) {
      continue; // a process we know nothing measurable about is not a sample
    }
    processes.push({
      type,
      pid,
      ...(cpuPct !== undefined ? { cpuPct } : {}),
      ...(workingSetBytes !== undefined ? { workingSetBytes } : {}),
      ...(peakWorkingSetBytes !== undefined ? { peakWorkingSetBytes } : {}),
      ...(privateBytes !== undefined ? { privateBytes } : {}),
    });
  }
  return { metrics: processes.length > 0 ? { processes } : undefined, pids };
}

const copyMetrics = (m: { processes: AppProcessMetric[] }): { processes: AppProcessMetric[] } => ({
  processes: m.processes.map((p) => ({ ...p })),
});

/** Maps a `child-process-gone` details object. Undefined unless Electron gave a type and a reason. */
function mapChildGone(details: unknown): ChildProcessGone | undefined {
  const d = record(details);
  if (d === undefined) return undefined;
  const { type, reason, exitCode, name } = d;
  if (typeof type !== 'string' || type === '' || typeof reason !== 'string' || reason === '') {
    return undefined;
  }
  return {
    type,
    reason,
    ...(typeof exitCode === 'number' && Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {}),
  };
}

type GoneListener = (event: unknown, details: unknown) => void;

export class ElectronProcessTracker extends InterceptorBase<ElectronProcessEvents> {
  readonly name = 'electron-process';
  #env: ElectronProcessEnv;
  /** The metrics run: armed once its priming read succeeded. */
  #metricsArmed = false;
  #last: { processes: AppProcessMetric[] } | undefined;
  /** The pids the previous read listed (the priming read seeds it). */
  #seenPids: ReadonlySet<number> = new Set();
  #timer: { handle: unknown; scheduler: ProcessTimers } | null = null;
  /** Bumped whenever the timer is torn down: a callback of an older run never emits. */
  #gen = 0;
  /** The attached `child-process-gone` listener, with the app it is attached to (so removal hits the right one). */
  #gone: { app: ElectronAppSource; listener: GoneListener } | undefined;
  // GPU: `#gpuGen` invalidates an in-flight read; `#gpuType` is the type the kept value was read with.
  #gpuGen = 0;
  #gpuType: GpuInfoType | undefined;
  /** True from the request until it settles (or is cancelled). */
  #gpuPending = false;
  #gpu: ElectronGpu | undefined;
  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => unknown) | undefined };

  constructor(env: ElectronProcessEnv = {}, onError?: (error: unknown) => unknown) {
    const report = { fn: onError };
    // A throwing reporter must not escape into the emitter's dispatch (which runs inside the host's events).
    super((error) => reportTo(report, error));
    this.#report = report;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker. A defined `onError` replaces the reporter (undefined keeps
   * it); every defined seam REPLACES ours, an undefined one never clobbers an earlier one. When a seam actually
   * changed, the metrics run and the `child-process-gone` listener are torn down with the seams they were ARMED with,
   * then the merged seams are swapped in and whatever still has listeners starts again (fresh baseline). An unchanged
   * relaunch restarts nothing.
   */
  rebind(env: ElectronProcessEnv, onError?: (error: unknown) => unknown): void {
    if (onError !== undefined) this.#report.fn = onError;
    const merged: Record<string, unknown> = {};
    let changed = false;
    for (const key of SEAM_KEYS) {
      const next = env[key] ?? this.#env[key];
      if (next !== undefined) merged[key] = next;
      if (next !== this.#env[key]) changed = true;
    }
    if (!changed) return;
    this.#stopMetrics(); // OLD seams
    this.#detachGone();
    this.#env = merged as ElectronProcessEnv;
    this.#sync();
  }

  /**
   * Request the one-shot `app.getGPUInfo(type)` read. A no-op while one is in flight, and while a USABLE value of the
   * SAME type is already settled (static hardware description: it is kept). It asks again when nothing usable was
   * settled (the earlier read rejected, threw, or returned nothing mappable) or when a different `type` is requested
   * (`'complete'` after `'basic'`); a failed re-ask keeps the earlier usable value. Never throws, never leaves a
   * rejected Promise unhandled (a Linux host without GPU acceleration rejects, and the session owner's own
   * unhandled-rejection detection would report it); a failure is reported and the GPU stays as it was.
   */
  requestGpuInfo(type: GpuInfoType = 'basic'): void {
    if (this.#gpuPending) return;
    if (this.#gpuType === type) return; // a usable value of this type is kept
    const app = this.#env.app;
    if (app === undefined || typeof app.getGPUInfo !== 'function') return;
    this.#gpuPending = true;
    const mine = ++this.#gpuGen;
    try {
      Promise.resolve(app.getGPUInfo(type)).then(
        (info) => {
          if (mine !== this.#gpuGen) return; // cancelled (or reset) since: never write
          this.#gpuPending = false;
          try {
            const gpu = mapGpuInfo(info);
            if (gpu === undefined) return;
            this.#gpu = gpu;
            this.#gpuType = type;
            this.emit('gpu', { ...gpu });
          } catch (error) {
            this.#onError(error);
          }
        },
        (error: unknown) => {
          if (mine !== this.#gpuGen) return;
          this.#gpuPending = false;
          this.#onError(error);
        },
      );
    } catch (error) {
      this.#gpuPending = false;
      this.#onError(error); // getGPUInfo threw synchronously
    }
  }

  /**
   * Abort an IN-FLIGHT GPU read: a late resolve/reject is ignored and a later request starts afresh. A value that
   * already settled is kept (reports still draining on stop need it).
   */
  cancelGpuInfo(): void {
    if (!this.#gpuPending) return;
    this.#gpuGen++;
    this.#gpuPending = false;
  }

  /**
   * The latest reading of `stage`. `gpu` is the settled result. `appMetrics` is windowed (a live read would
   * consume the CPU window), so it answers the last sample of the current run: undefined until the first tick and while
   * unarmed. Always a copy.
   */
  current(stage: 'appMetrics'): { processes: AppProcessMetric[] } | undefined;
  current(stage: 'gpu'): ElectronGpu | undefined;
  current(stage: 'appMetrics' | 'gpu'): unknown {
    if (stage === 'gpu') return this.#gpu === undefined ? undefined : { ...this.#gpu };
    return this.#metricsArmed && this.#last !== undefined ? copyMetrics(this.#last) : undefined;
  }

  /** Test/teardown: drop EVERY listener (releasing the timer and the `app` listener) and forget the GPU result. */
  reset(): void {
    this.removeAllListeners();
    this.#gpuGen++;
    this.#gpuPending = false;
    this.#gpuType = undefined;
    this.#gpu = undefined;
  }

  // Activation is per stage (onListenersChanged); the whole-tracker hook has nothing to do.
  protected onActivate(): void {}

  protected override onListenersChanged(): void {
    this.#sync();
  }

  #onError(error: unknown): void {
    reportTo(this.#report, error);
  }

  #sync(): void {
    if (this.listenerCount('appMetrics') === 0) this.#stopMetrics();
    else if (!this.#metricsArmed) this.#startMetrics();
    if (this.listenerCount('childProcessGone') === 0) this.#detachGone();
    else if (this.#gone === undefined) this.#attachGone();
  }

  #startMetrics(): void {
    const app = this.#env.app;
    if (app === undefined || typeof app.getAppMetrics !== 'function') return;
    try {
      // PRIMING read: CPU is "since the previous call", so this opens the window for the processes that exist now; its
      // values are discarded, only the pids are remembered
      this.#seenPids = mapAppMetrics(app.getAppMetrics(), new Set()).pids;
    } catch (error) {
      this.#onError(error); // left unarmed: retried on the next listener change / rebind
      return;
    }
    const scheduler = this.#env.scheduler ?? defaultScheduler;
    const gen = ++this.#gen;
    try {
      const handle = scheduler.setInterval(() => {
        if (gen === this.#gen) this.#tick(app);
      }, this.#env.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.#timer = { handle, scheduler };
      this.#metricsArmed = true;
    } catch (error) {
      this.#gen += 1;
      this.#onError(error); // nothing would ever read it: stay unarmed
    }
  }

  #stopMetrics(): void {
    const timer = this.#timer;
    this.#timer = null;
    this.#metricsArmed = false;
    this.#last = undefined;
    this.#gen += 1;
    if (timer === null) return;
    try {
      timer.scheduler.clearInterval(timer.handle);
    } catch (error) {
      this.#onError(error);
    }
  }

  #tick(app: ElectronAppSource): void {
    let metrics: MappedMetrics['metrics'];
    try {
      const mapped = mapAppMetrics(app.getAppMetrics?.(), this.#seenPids);
      metrics = mapped.metrics;
      this.#seenPids = mapped.pids;
    } catch (error) {
      this.#onError(error); // this tick only; the stage stays armed
      return;
    }
    if (metrics === undefined) return; // absence, never zero
    this.#last = metrics;
    // Emitted payloads are copies: a subscriber cannot mutate the retained sample.
    this.emit('appMetrics', copyMetrics(metrics));
  }

  #attachGone(): void {
    const app = this.#env.app;
    if (app === undefined || typeof app.on !== 'function') return;
    // A listener that cannot be removed again would outlive `client.stop()`: only attach when it can be released.
    if (typeof app.removeListener !== 'function' && typeof app.off !== 'function') return;
    const listener: GoneListener = (_event, details) => {
      const gone = mapChildGone(details);
      if (gone !== undefined) this.emit('childProcessGone', gone);
    };
    try {
      app.on('child-process-gone', listener);
      this.#gone = { app, listener };
    } catch (error) {
      this.#onError(error); // left unattached: retried on the next listener change / rebind
    }
  }

  #detachGone(): void {
    const gone = this.#gone;
    this.#gone = undefined;
    if (gone === undefined) return;
    try {
      if (typeof gone.app.removeListener === 'function') {
        gone.app.removeListener('child-process-gone', gone.listener);
      } else {
        gone.app.off?.('child-process-gone', gone.listener);
      }
    } catch (error) {
      this.#onError(error);
    }
  }
}

/** Calls the reporter; it may throw or return a rejecting Promise (both are absorbed: the tracker is silent toward the host). */
function reportTo(report: { fn: ((error: unknown) => unknown) | undefined }, error: unknown): void {
  try {
    const result = report.fn?.(error);
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    /* the reporter itself failed */
  }
}

const registry = createTrackerRegistry<ElectronProcessTracker>();

/** A {@link ElectronProcessEnv} plus the object the singleton is keyed on (default: the `app` object). */
export interface ElectronProcessTrackerEnv extends ElectronProcessEnv {
  key?: object;
}

function seamsOf(env: ElectronProcessTrackerEnv): ElectronProcessEnv {
  const seams: Record<string, unknown> = {};
  for (const key of SEAM_KEYS) {
    const value = env[key];
    if (value !== undefined) seams[key] = value;
  }
  return seams as ElectronProcessEnv;
}

/**
 * The singleton ElectronProcessTracker for the env's key (the `app` object by default; with neither a `key` nor an
 * `app` there is nothing to key on and the call throws, because a shared anonymous tracker would be a global with no
 * owner). Every call (a relaunch included) hands the shared tracker the latest launch's `onError` and seams (see
 * {@link ElectronProcessTracker.rebind}); nothing else of the env is kept.
 */
export function electronProcessTrackerFor(
  env: ElectronProcessTrackerEnv,
  onError?: (error: unknown) => unknown,
): ElectronProcessTracker {
  const key = env.key ?? env.app;
  if (key === undefined) throw new TypeError('electronProcessTrackerFor needs an `app` or a `key`');
  const seams = seamsOf(env);
  return registry.for(
    key,
    () => new ElectronProcessTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the key's tracker (resetting it, so its timer, listener and GPU result are released). */
export function resetElectronProcessTracker(key: object): void {
  registry.reset(key);
}
