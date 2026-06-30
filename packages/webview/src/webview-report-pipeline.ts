import type { ReportingRequest, UploadResult } from '@bugsee/core';
import type { HostBridge } from './host-bridge';
import { encode, entryMessage, reportMessage } from './protocol';

// The WebView report path (docs/design/webview-bridge.md §6.2, D5). A `triggerPipeline` for the core Client:
// the Client routes EVERY report (uncaught error / unhandledrejection detection + explicit `logException`) here
// instead of assembling + uploading a bundle. Per D5, capture is NEVER gated — every incident ALWAYS streams up
// as a `crash` ENTRY so native's timeline has it (with the report metadata + stack). The report TRIGGER (telling
// native to OPEN a bug) is emitted ADDITIONALLY only when `reportTrigger` is on (default off; the gate is read
// dynamically so native can toggle it mid-session via the control channel). The bridge owns delivery, so report
// resolves `{ok:true}` (handed off to native). seq is shared with the capture store (one per-session sequence).

export interface WebViewReportPipelineOptions {
  /** The JS→native channel. */
  bridge: HostBridge;
  /** Whether the WebView may emit report triggers right now (D5; read per report). */
  reportTriggerEnabled: () => boolean;
  /** Monotonic-sequence source, SHARED with the capture store. */
  seq: () => number;
  /** Wall-clock ms source. Default `Date.now`. */
  wallNow?: () => number;
  /** `performance.now()` source. Default the ambient `performance`. */
  now?: () => number;
  /** `performance.timeOrigin`. Default the ambient `performance`. */
  timeOrigin?: number;
  /** D3 redaction provenance: did a JS-side report handler (`before`) run before this crossed? Default no. */
  redacted?: () => boolean;
}

export interface WebViewReportPipeline {
  /** Stream an incident as a crash entry (always) + a report trigger (gated). Resolves once handed to native. */
  report(request: ReportingRequest): Promise<UploadResult>;
}

/** Build the WebView trigger pipeline (errors-as-entries-always + the D5-gated report trigger). */
export function createWebViewReportPipeline(
  opts: WebViewReportPipelineOptions,
): WebViewReportPipeline {
  const { bridge, reportTriggerEnabled, seq } = opts;
  const wallNow = opts.wallNow ?? ((): number => Date.now());
  const now = opts.now ?? ((): number => performance.now());
  const timeOrigin = opts.timeOrigin ?? performance.timeOrigin;
  const redacted = opts.redacted ?? ((): boolean => false);

  return {
    report(request: ReportingRequest): Promise<UploadResult> {
      const frame = {
        type: 'crash' as const,
        timestamp: wallNow(),
        mono: now(),
        timeOrigin,
        payload: JSON.stringify({ source: request.source, report: request.report }),
        // D3 provenance: did a JS-side report handler run before this crossed? (native still re-applies).
        redacted: redacted(),
      };
      // Capture is never gated (D5): the incident ALWAYS streams up as a timeline crash entry.
      bridge.post(encode(entryMessage({ ...frame, seq: seq() })));
      // The report TRIGGER (open a native bug) is emitted only when the gate is open.
      if (reportTriggerEnabled()) {
        bridge.post(encode(reportMessage({ ...frame, seq: seq() })));
      }
      return Promise.resolve({ ok: true });
    },
  };
}
