import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import { bytesToMegabytes } from '@bugsee/protocol';
import type {
  AppProcessMetric,
  DisplayInfo,
  ElectronDisplayTracker,
  ElectronProcessTracker,
} from '@bugsee/trackers/electron';

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
// `electron_displays` (JS-SPECIFIC name, deliberately NOT Android's `displays`: that name is reserved until an
// Android-shaped display list is specified and confirmed against the viewer, Q5; nothing in the JS protocol defines it):
//
//   electron_displays = { displays: [{ id, width, height, scale_factor?, rotation?, internal?, refresh_rate_hz? }] }
//
// `width`/`height` are Electron's device-independent pixels (`Display.size`), `rotation` is 0/90/180/270, `refresh_rate_hz`
// is `displayFrequency`; a key is omitted when Electron did not supply it, a display with no id/size (or id -1) is dropped, and
// the trace is never `{displays: []}`. It is a HELD step trace (`emitIfChanged`): the list when the producer starts, then
// the fresh list after every display added/removed/metrics-changed. HELD-VALUE CAVEAT: it is absent only BEFORE its first
// emit. A later refresh that cannot read a usable list emits nothing and cannot retract, so the previous list stays held and
// is re-recorded every refreshMs (same open owner decision as storage_estimate / user_idle_state, docs/PROGRESS.md).

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
      this.emit('app_metrics', { processes: m.processes.map(wireProcess) }),
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
    width: d.width,
    height: d.height,
    ...(d.scaleFactor !== undefined ? { scale_factor: round2(d.scaleFactor) } : {}),
    ...(d.rotation !== undefined ? { rotation: d.rotation } : {}),
    ...(d.internal !== undefined ? { internal: d.internal } : {}),
    ...(d.refreshRate !== undefined ? { refresh_rate_hz: round2(d.refreshRate) } : {}),
  };
}

class DisplaysProducer extends TraceProducerBase {
  readonly name = 'electron-displays';
  #off: (() => void) | undefined;
  constructor(private readonly tracker: ElectronDisplayTracker) {
    super();
  }
  protected onStart(): void {
    // subscribe FIRST (arming the tracker's listeners), then the baseline read: no change can fall between the two
    this.#off = this.tracker.on('displays', (list) => this.#publish(list));
    const list = this.tracker.current('displays');
    if (list !== undefined) this.#publish(list);
  }
  protected override onStop(): void {
    this.#off?.();
    this.#off = undefined;
  }
  #publish(list: { displays: DisplayInfo[] }): void {
    this.emitIfChanged('electron_displays', { displays: list.displays.map(wireDisplay) });
  }
}

/** The trackers the Electron producers read; a domain whose tracker is absent is simply off. */
export interface ElectronTraceTrackers {
  process?: ElectronProcessTracker;
  display?: ElectronDisplayTracker;
}

/** The Electron producers, each subscribed to ONE stage of a shared tracker. */
export function createElectronSystemTraceProducers(
  trackers: ElectronTraceTrackers,
): TraceProducer[] {
  return [
    ...(trackers.process !== undefined ? [new AppMetricsProducer(trackers.process)] : []),
    ...(trackers.display !== undefined ? [new DisplaysProducer(trackers.display)] : []),
  ];
}
