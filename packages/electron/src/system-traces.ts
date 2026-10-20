import { type TraceProducer, TraceProducerBase } from '@bugsee/capture';
import { bytesToMegabytes } from '@bugsee/protocol';
import type { AppProcessMetric, ElectronProcessTracker } from '@bugsee/trackers/electron';

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

/** The Electron producers, each subscribed to ONE stage of the shared tracker. */
export function createElectronSystemTraceProducers(
  tracker: ElectronProcessTracker,
): TraceProducer[] {
  return [new AppMetricsProducer(tracker)];
}
