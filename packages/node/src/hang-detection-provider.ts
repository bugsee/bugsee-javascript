import { type DetectionProvider, DetectionProviderBase, type Scheduler } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import {
  createEventLoopWatchdog,
  type EventLoopWatchdog,
  type EventLoopWatchdogDeps,
  type HangLevel,
  type HangThresholds,
} from './event-loop-watchdog';

// The hang detection provider (node diagnostics, A2 — Android `BugseeDetectionHang` parity). Wraps the
// event-loop watchdog (A1) as a DetectionProvider: on each newly-crossed hang level it submits an ERROR
// report "Main thread hang detected" carrying the Android-canonical domain `AppHang::{Fair|Medium|Severe}`
// (as a label + signature for grouping) and the stall duration. The BLOCKING STACK is not captured here —
// it comes from the CPU profile in the same bundle (when profiling is on), since V8 keeps sampling during a
// synchronous block. Gated by `detect.hang`; node-specific (worker_threads), so it degrades to a no-op
// where the watchdog cannot spawn a worker.

const DOMAIN: Record<HangLevel, string> = {
  fair: 'AppHang::Fair',
  medium: 'AppHang::Medium',
  severe: 'AppHang::Severe',
};

export interface HangDetectionProviderDeps {
  thresholds: HangThresholds;
  /** Heartbeat write interval (ms). Default the watchdog's (1000). */
  heartbeatIntervalMs?: number;
  /** Heartbeat timer; the launch passes the client's scheduler. Default global timers. */
  scheduler?: Scheduler;
  /** Watchdog factory — tests inject a fake to drive onHang without a real worker. Default the real one. */
  createWatchdog?: (deps: EventLoopWatchdogDeps) => EventLoopWatchdog;
}

class HangDetectionProvider extends DetectionProviderBase {
  readonly name = 'node-hang';
  readonly controllingOption = BugseeOption.DetectHang;
  readonly #watchdog: EventLoopWatchdog;

  constructor(deps: HangDetectionProviderDeps) {
    super();
    const create = deps.createWatchdog ?? createEventLoopWatchdog;
    this.#watchdog = create({
      thresholds: deps.thresholds,
      onHang: (level, durationMs) => this.#report(level, durationMs),
      ...(deps.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: deps.heartbeatIntervalMs }
        : {}),
      ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {}),
    });
  }

  protected onStart(): void {
    this.#watchdog.start();
  }

  protected override onStop(): void {
    this.#watchdog.stop();
  }

  #report(level: HangLevel, durationMs: number): void {
    const domain = DOMAIN[level];
    this.handleReportingRequest(
      this.createErrorReport({
        mechanism: 'hang',
        summary: 'Main thread hang detected',
        description: `Event loop blocked for ${durationMs}ms (${domain})`,
        labels: [domain],
        signatures: [domain],
      }),
    );
  }
}

export function createHangDetectionProvider(deps: HangDetectionProviderDeps): DetectionProvider {
  return new HangDetectionProvider(deps);
}
