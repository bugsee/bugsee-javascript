import type { Client, DetectionProvider } from './contracts';
import {
  createReportingRequest,
  type ReportingRequest,
  type ReportingRequestInit,
} from './reporting';

// Base class for detection providers (Android BugseeDetectionProviderBase parity). Concrete
// detectors extend this, install their hooks in onStart(), and on detection call
// `this.handleReportingRequest(this.createCrashReport(...))` — the base routes the request to the
// report sink wired by the coordinator at start() (the proper target). Mirrors Android's base, where
// handleReportingRequest forwards to the injected BugseeDetectionDataHandler.

export abstract class DetectionProviderBase implements DetectionProvider {
  abstract readonly name: string;
  // `controllingOption` is optional on DetectionProvider; subclasses declare it when they gate on
  // a launch option (no base field, so subclasses needn't write `override`).

  #report: ((request: ReportingRequest) => void) | null = null;

  /** Wired by the detection coordinator: stores the report sink and starts the subclass's hooks. */
  start(client: Client, report: (request: ReportingRequest) => void): void {
    this.#report = report;
    this.onStart(client);
  }

  /** Stops the subclass's hooks and detaches the report sink. */
  stop(): void {
    this.onStop();
    this.#report = null;
  }

  /** Subclasses install their detection hooks here. */
  protected abstract onStart(client: Client): void;

  /** Subclasses release their detection hooks here (optional). */
  protected onStop(): void {}

  /** Route a reporting request to the wired sink; a no-op before start() or after stop(). */
  protected handleReportingRequest(request: ReportingRequest): void {
    this.#report?.(request);
  }

  /** Build a crash report (source `crash`). */
  protected createCrashReport(init?: Omit<ReportingRequestInit, 'source'>): ReportingRequest {
    return createReportingRequest({ ...init, source: { type: 'crash' } });
  }

  /** Build an error report (source `error`). */
  protected createErrorReport(init?: Omit<ReportingRequestInit, 'source'>): ReportingRequest {
    return createReportingRequest({ ...init, source: { type: 'error' } });
  }
}
