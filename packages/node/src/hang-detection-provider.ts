import {
  type CrashJson,
  type DetectionProvider,
  DetectionProviderBase,
  type Scheduler,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import type { CpuProfile } from './cpu-profiler';
import {
  createEventLoopWatchdog,
  type EventLoopWatchdog,
  type EventLoopWatchdogDeps,
  type HangLevel,
  type HangThresholds,
} from './event-loop-watchdog';
import { hangCrashFromProfile } from './hang-stack';

// The hang detection provider (node diagnostics, A2 — Android `BugseeDetectionHang` parity). Wraps the
// event-loop watchdog (A1) as a DetectionProvider: on each newly-crossed hang level it submits an ERROR
// report "Main thread hang detected" carrying the Android-canonical domain `AppHang::{Fair|Medium|Severe}`
// (as a label + signature for grouping) and the stall duration. The BLOCKING STACK is not captured here —
// it comes from the CPU profile (when profiling is on), since V8 keeps sampling during a synchronous block:
// the profile's hottest stack in the stall window becomes the report's `crash.json` frames, so hangs group by
// where they block. Without a profile the report keeps its fixed `AppHang::*` signature. Gated by `detect.hang`; node-specific (worker_threads), so it degrades to a no-op
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
  /**
   * The CPU profile covering the stall, when profiling is on. Resolving undefined (or an unusable profile, or
   * rejecting) keeps the plain hang report: a crash.json with no frames would make every hang one issue.
   */
  blockingProfile?: () => Promise<CpuProfile | undefined>;
  /** Watchdog factory — tests inject a fake to drive onHang without a real worker. Default the real one. */
  createWatchdog?: (deps: EventLoopWatchdogDeps) => EventLoopWatchdog;
}

class HangDetectionProvider extends DetectionProviderBase {
  readonly name = 'node-hang';
  readonly controllingOption = BugseeOption.DetectHang;
  readonly #watchdog: EventLoopWatchdog;
  readonly #blockingProfile: HangDetectionProviderDeps['blockingProfile'];
  // Escalation reports (fair → medium → severe) arrive together; chaining keeps them in order while each
  // awaits its profile.
  #pending: Promise<unknown> = Promise.resolve();

  constructor(deps: HangDetectionProviderDeps) {
    super();
    this.#blockingProfile = deps.blockingProfile;
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
    const source = this.#blockingProfile;
    if (source === undefined) {
      this.#submit(domain, durationMs);
      return;
    }
    this.#pending = this.#pending.then(async () => {
      let crash: CrashJson | undefined;
      try {
        const profile = await source();
        crash =
          profile !== undefined
            ? hangCrashFromProfile(profile, {
                windowMs: durationMs,
                domain,
                reason: `Event loop blocked for ${durationMs}ms`,
              })
            : undefined;
      } catch {
        crash = undefined; // no stack is better than no report
      }
      this.#submit(domain, durationMs, crash);
    });
  }

  #submit(domain: string, durationMs: number, crash?: CrashJson): void {
    this.handleReportingRequest(
      this.createErrorReport({
        mechanism: 'hang',
        summary: 'Main thread hang detected',
        description: `Event loop blocked for ${durationMs}ms (${domain})`,
        labels: [domain],
        // With frames the backend derives the signature from them; the fixed one would override it.
        ...(crash !== undefined ? { crash } : { signatures: [domain] }),
      }),
    );
  }
}

export function createHangDetectionProvider(deps: HangDetectionProviderDeps): DetectionProvider {
  return new HangDetectionProvider(deps);
}
