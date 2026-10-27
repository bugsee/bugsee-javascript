import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import type { Scheduler } from '@bugsee/core';
import { bytesToMegabytes, TraceName } from '@bugsee/protocol';
import type {
  AppProcessMetric,
  DisplayInfo,
  ElectronApplicationTracker,
  ElectronDisplayTracker,
  ElectronPowerTracker,
  ElectronProcessTracker,
} from '@bugsee/trackers/electron';
import { thermalStateWire } from './thermal-state-wire';

// Electron-main `traces.system` producers. COMPOSITION only: `launchMain` appends these to the node producer set (the
// node set keeps `process_memory_*`/`cpu_*`/`event_loop_*` for the process that owns the session; nothing here emits a
// name the node set does), and every Electron read, timer and omit-never-zero rule belongs to the shared
// ElectronProcessTracker (`@bugsee/trackers/electron`). A producer only subscribes to a tracker stage in `onStart` and
// releases it in `onStop`, so one that is never started costs nothing and a throwing `getAppMetrics` is the tracker's
// to report (it drops that tick only, never another producer's values).
//
// WIRE SHAPE (JS-specific name; Android has no per-process-type trace and the viewer table has no entry for it, so the
// value is an OPEN object the viewer renders as detail, like `storage_estimate`/`connection`):
//
//   app_metrics = { processes: [{ type, pid, cpu_percent?, working_set_mb?, peak_working_set_mb?, private_mb? }] }
//
// `type` is Electron's process type verbatim (`Browser`, `Tab`, `GPU`, `Utility`, …). Sizes are integer binary MB
// (`bytesToMegabytes`, like `disk_mem_*`/`storage_estimate`; Electron reports KiB). `cpu_percent` is Electron's
// `percentCPUUsage`: the share of the WHOLE machine (Electron divides by the processor count), 0-100, since the
// previous read, rounded to at most 2 decimals. A key is omitted when Electron did not supply it, and `cpu_percent` is
// also omitted for a process's first sighting (Chromium reports 0 on the first CPU call per process; see the tracker).
// The viewer's support for this trace (Q5) is UNCONFIRMED; flat per-type totals are the alternative shape.
// Emitted every tick and NOT held: a failing read leaves a gap rather than a frozen line.
//
// `displays` (the MOBILE name and list shape, spec bundle/traces.md `displays`; it replaces the retired JS-specific
// `electron_displays`): a bare ARRAY, one entry per display,
//
//   [{ id, native_id, state?, type?, width, height, natural_width?, natural_height?, scale?, max_fps?, rotation? }]
//
// `id` `0` is the display showing the KEY window (focused window, else most recently focused, else first created; the primary
// display when there is none), the others follow in ascending order of Electron's id; `native_id` is Electron's own id,
// `width`/`height` DEVICE pixels in the current orientation, `rotation` quarter turns, `state:'on'` on id 0 only (see the
// tracker). `displayId` is never written. The numbering moves with the key window, so the list is ALSO re-read when a window
// gains/loses focus or has moved (debounced 200 ms: macOS fires `moved` throughout a drag) (the application tracker's `windowFocus` / `windowMoved` stages, armed only while
// this producer runs); a re-read that changes nothing is dropped by `emitIfChanged`. Windows on other displays are not recorded.
// A key is omitted when Electron did not supply it, a display with no id/size (or id -1) is dropped, and the trace is never
// `[]`. It is a HELD step trace (`emitIfChanged`): the list when the producer starts, then the fresh list after every display
// added/removed/metrics-changed. HELD-VALUE CAVEAT: it is absent only BEFORE its first emit. A later refresh that cannot read
// a usable list emits nothing and cannot retract, so the previous list stays held and is re-recorded every refreshMs (same open
// owner decision as storage_estimate / user_idle_state, docs/PROGRESS.md).

/** At most two decimals: Electron's float noise is not information. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

const mb = (bytes: number | undefined): number | undefined =>
  bytes === undefined ? undefined : bytesToMegabytes(bytes);

function wireProcess(p: AppProcessMetric): Record<string, unknown> {
  const workingSet = mb(p.workingSetBytes);
  const peak = mb(p.peakWorkingSetBytes);
  const priv = mb(p.privateBytes);
  return {
    type: p.type,
    pid: p.pid,
    ...(p.cpuPct !== undefined ? { cpu_percent: round2(p.cpuPct) } : {}),
    ...(workingSet !== undefined ? { working_set_mb: workingSet } : {}),
    ...(peak !== undefined ? { peak_working_set_mb: peak } : {}),
    ...(priv !== undefined ? { private_mb: priv } : {}),
  };
}

class AppMetricsProducer extends TraceProducerBase {
  readonly name = 'electron-app-metrics';
  #off: (() => void) | undefined;
  constructor(private readonly tracker: ElectronProcessTracker) {
    super();
  }
  // Subscribing arms the tracker's stage (a priming read, then its own timer): there is NO start sample, because the
  // first CPU window has not elapsed.
  protected onStart(): void {
    this.#off = this.tracker.on('appMetrics', (m) =>
      this.emit(TraceName.APP_METRICS, { processes: m.processes.map(wireProcess) }),
    );
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

function wireDisplay(d: DisplayInfo): Record<string, unknown> {
  return {
    id: d.id,
    native_id: d.nativeId,
    ...(d.state !== undefined ? { state: d.state } : {}),
    ...(d.type !== undefined ? { type: d.type } : {}),
    width: d.width,
    height: d.height,
    ...(d.naturalWidth !== undefined ? { natural_width: d.naturalWidth } : {}),
    ...(d.naturalHeight !== undefined ? { natural_height: d.naturalHeight } : {}),
    ...(d.scale !== undefined ? { scale: d.scale } : {}),
    ...(d.maxFps !== undefined ? { max_fps: d.maxFps } : {}),
    ...(d.rotation !== undefined ? { rotation: d.rotation } : {}),
  };
}

/** A window drag re-reads the display list once it has been still this long (trailing debounce). */
export const MOVE_SETTLE_MS = 200;
const timers = globalThis as unknown as {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};
const globalScheduler: Scheduler = {
  setInterval: (cb, ms) => timers.setInterval(cb, ms),
  clearInterval: (h) => timers.clearInterval(h),
};

class DisplaysProducer extends TraceProducerBase {
  readonly name = 'displays';
  #off: (() => void) | undefined;
  #offKey: Array<() => void> = [];
  #moveTimer: unknown;
  #movePending = false;
  constructor(
    private readonly tracker: ElectronDisplayTracker,
    private readonly application?: ElectronApplicationTracker,
    private readonly scheduler: Scheduler = globalScheduler,
  ) {
    super();
  }
  protected onStart(): void {
    // subscribe FIRST (arming the tracker's listeners), then the baseline read: no change can fall between the two
    this.#off = this.tracker.on('displays', (list) => this.#publish(list));
    // the key window can change display without any screen event: re-read when focus or position changes
    if (this.application !== undefined) {
      const reread = (): void => {
        const list = this.tracker.current('displays');
        if (list !== undefined) this.#publish(list);
      };
      // `moved` is an alias of `move` on macOS (fires throughout a drag): re-read once the window has been still
      const rereadSoon = (): void => {
        this.#cancelMove();
        this.#movePending = true;
        this.#moveTimer = this.scheduler.setInterval(() => {
          this.#cancelMove();
          reread();
        }, MOVE_SETTLE_MS);
      };
      this.#offKey = [
        this.application.on('windowFocus', reread),
        this.application.on('windowMoved', rereadSoon),
      ];
    }
    const list = this.tracker.current('displays');
    if (list !== undefined) this.#publish(list);
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
    for (const off of this.#offKey) off();
    this.#offKey = [];
    this.#cancelMove();
  }
  #cancelMove(): void {
    if (this.#movePending) this.scheduler.clearInterval(this.#moveTimer);
    this.#movePending = false;
    this.#moveTimer = undefined;
  }
  #publish(list: { displays: DisplayInfo[] }): void {
    this.emitIfChanged(TraceName.DISPLAYS, list.displays.map(wireDisplay));
  }
}

// `thermal_state` and `cpu_speed_limit` (C13): both come from the Power domain tracker's `powerMonitor` stages and are
// SAMPLED / event-driven (never held, spec javascript.md "Electron main traces"): a state the OS stops reporting leaves
// a gap rather than a frozen line.
//
//   thermal_state    the wire value is decided by `thermal-state-wire.ts` (OPEN OWNER QUESTION, bugsee-cocoa#288; today the
//                    iOS int 0-3). Written at start (a live read of `getCurrentThermalState()`) and on every
//                    `thermal-state-change`. macOS only: elsewhere the method is absent / answers `unknown`, which writes
//                    nothing (omit, never zero).
//                    A transition from a known state to `unknown` therefore leaves the previous value as the last sample (the
//                    spec: sampled, never held, omit never zero): a consumer that draws the last point of the series should not
//                    read it as "still that hot".
//   cpu_speed_limit  int percent 0-100 from `speed-limit-change` ONLY (macOS and Windows): there is no initial value and no
//                    value until the OS reports a limit. A measured 0 is a real limit and is written.
class ThermalStateProducer extends TraceProducerBase {
  readonly name = 'thermal_state';
  #off: (() => void) | undefined;
  constructor(private readonly tracker: ElectronPowerTracker) {
    super();
  }
  #publish(state: Parameters<typeof thermalStateWire>[0]): void {
    const wire = thermalStateWire(state);
    if (wire !== undefined) this.emit('thermal_state', wire);
  }
  protected onStart(): void {
    // subscribe FIRST (arming the listener), then the baseline read: no change can fall between the two
    this.#off = this.tracker.on('thermalState', (e) => this.#publish(e.state));
    const current = this.tracker.current('thermalState');
    if (current !== undefined) this.#publish(current.state);
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

class CpuSpeedLimitProducer extends TraceProducerBase {
  readonly name = 'cpu_speed_limit';
  #off: (() => void) | undefined;
  constructor(private readonly tracker: ElectronPowerTracker) {
    super();
  }
  protected onStart(): void {
    this.#off = this.tracker.on('speedLimit', (e) => this.emit('cpu_speed_limit', e.limit));
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
}

/** The trackers the Electron producers read; a domain whose tracker is absent is simply off. */
export interface ElectronTraceTrackers {
  process?: ElectronProcessTracker;
  display?: ElectronDisplayTracker;
  /** Feeds `thermal_state` and `cpu_speed_limit` (the `powerMonitor` stages). */
  power?: ElectronPowerTracker;
  /** Resolves the key window; without it the `displays` list follows the primary display (and no focus changes). */
  application?: ElectronApplicationTracker;
  /** Timer source for the window-move debounce (default: the global timers). */
  scheduler?: Scheduler;
}

/** The Electron producers, each subscribed to ONE stage of a shared tracker. */
export function createElectronSystemTraceProducers(
  trackers: ElectronTraceTrackers,
): TraceProducer[] {
  return [
    ...(trackers.process !== undefined ? [new AppMetricsProducer(trackers.process)] : []),
    ...(trackers.display !== undefined
      ? [new DisplaysProducer(trackers.display, trackers.application, trackers.scheduler)]
      : []),
    ...(trackers.power !== undefined
      ? [new ThermalStateProducer(trackers.power), new CpuSpeedLimitProducer(trackers.power)]
      : []),
  ];
}
