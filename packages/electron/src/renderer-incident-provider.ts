import {
  type Client,
  DetectionProviderBase,
  type HarvestedDump,
  type ReportingRequest,
} from '@bugsee/core';
import type { DecodedReport } from './protocol';

// The main-side submit seam for renderer incidents (R3/R4,
// docs/design/electron-renderer-incident-convergence.md §4.3).
//
// A DetectionProvider, which is the design's chosen option: it is the ONE public path that submits a
// ReportingRequest without re-filing it. The alternative — `client.logException` — would turn a renderer
// CRASH into a handled, programmatic error carrying a MAIN-side stack, destroying the attribution this whole
// feature exists to preserve (design review SEV1-2).
//
// It detects nothing itself; it is a conduit. Registering it is what makes R3 and R4 live: without it the
// receiver's `onReport` has nowhere to go, the renderer no longer uploads, and incidents are silently
// destroyed while the app is told they were delivered — strictly worse than the defect being fixed
// (code review SEV1-1).

/** How many renderer incidents to accept per window per minute; beyond that they are dropped. */
const DEFAULT_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

export interface RendererIncidentProviderOptions {
  /** Max incidents accepted per window id per minute. Default 10. */
  rateLimit?: number;
  /** Time source (injectable for tests). */
  now?: () => number;
  /** Internal-error sink. */
  onError?: (error: unknown) => void;
}

/** A synthesised `render-process-gone` incident (R4). */
export interface RendererGoneIncident {
  reason: string;
  exitCode?: number;
  windowId: number;
  dump?: HarvestedDump;
}

export class RendererIncidentProvider extends DetectionProviderBase {
  readonly name = 'electron-renderer-incident';

  #rateLimit: number;
  #now: () => number;
  #onError: (error: unknown) => void;
  /** Per-window sliding-window timestamps, so one hostile or crash-looping renderer cannot flood. */
  #recent = new Map<number, number[]>();

  constructor(options: RendererIncidentProviderOptions = {}) {
    super();
    this.#rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.#now = options.now ?? ((): number => Date.now());
    this.#onError = options.onError ?? ((): void => {});
  }

  protected onStart(_client: Client): void {
    // Nothing to hook: incidents arrive by IPC (submitForwarded) or from render-process-gone (submitGone).
  }

  protected override onStop(): void {
    this.#recent.clear();
  }

  /** True while this window is under its budget; records the acceptance. */
  #allow(windowId: number): boolean {
    const cutoff = this.#now() - RATE_WINDOW_MS;
    const times = (this.#recent.get(windowId) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.#rateLimit) {
      this.#recent.set(windowId, times);
      return false;
    }
    times.push(this.#now());
    this.#recent.set(windowId, times);
    return true;
  }

  /**
   * Submit an incident forwarded by a renderer (R3).
   *
   * The renderer's `source` is preserved verbatim — mechanism and type included — because that attribution is
   * the point. Renderer input is untrusted, so this is rate-limited per window and never throws outward.
   */
  submitForwarded(report: DecodedReport, windowId: number): void {
    try {
      if (!this.#allow(windowId)) {
        return;
      }
      this.handleReportingRequest({
        source: report.source,
        report: { ...report.report, electron_window_id: windowId },
      } as unknown as ReportingRequest);
    } catch (error) {
      this.#onError(error);
    }
  }

  /** Submit an incident synthesised from `render-process-gone` (R4). */
  submitGone(incident: RendererGoneIncident): void {
    try {
      if (!this.#allow(incident.windowId)) {
        return;
      }
      const request = this.createCrashReport({
        summary: `Renderer process gone: ${incident.reason}`,
      });
      const report = request.report as unknown as Record<string, unknown>;
      report.electron_window_id = incident.windowId;
      report.electron_gone_reason = incident.reason;
      if (incident.exitCode !== undefined) {
        report.electron_exit_code = incident.exitCode;
      }
      if (incident.dump !== undefined) {
        // The claimed minidump rides as a report attachment, the same shape the recovery path uses.
        report.attachments = [{ name: incident.dump.name, data: incident.dump.data }];
      }
      this.handleReportingRequest(request);
    } catch (error) {
      this.#onError(error);
    }
  }
}
