import type { ReportingRequest, UploadResult } from '@bugsee/core';
import { encodeReport } from './protocol';

// The renderer report path (docs/design/electron-renderer-incident-convergence.md §4.1, slice R2). A
// `triggerPipeline` for the core Client: the Client routes EVERY report — detected uncaught error /
// unhandledrejection, and explicit `logException` — here instead of assembling a bundle and uploading it.
//
// WHY. A renderer's capture store is the STREAMING store: entries go UP to main over IPC and the local store
// holds nothing. So a renderer that assembled locally produced a bundle whose `stream()` yielded nothing,
// uploaded under the renderer client's OWN session id, while the main session — which holds every one of that
// renderer's entries — recorded no incident at all. Two sessions: one with an issue and no data, one with the
// data and no issue, at exactly the moment that matters (docs/review/electron.md SEV1 #2).
//
// Main owns delivery from here: it submits the incident against its own session, and assembles the bundle
// from the store that actually has the capture.
//
// Modelled on `@bugsee/webview`'s `webview-report-pipeline.ts`, with one deliberate difference: WebView always
// ALSO streams a timeline `crash` entry (its D5), because native is the bundler and wants the marker. Here
// main is the bundler and the forwarded report already carries `report.crash`, so streaming a second copy as
// a capture entry would put an array-shaped duplicate `crash.json` in the bundle (design review SEV1-1).

export interface ElectronRendererReportPipelineOptions {
  /** Post a wire string to the main process (the renderer→main bridge). */
  post: (raw: string) => void;
  /**
   * Whether the bridge is usable — i.e. the preload exposed it and the handshake completed. When it is not,
   * the incident cannot be delivered and `report` resolves `{ ok: false }` rather than claiming success for
   * something nothing received (design review: honest failure semantics).
   */
  canDeliver: () => boolean;
  /** Wall-clock ms source. Default `Date.now`. */
  wallNow?: () => number;
  /** Internal-error sink; a post failure must never propagate into the host app's error handling. */
  onError?: (error: unknown) => void;
}

export interface ElectronRendererReportPipeline {
  /** Forward an incident to main. Resolves once handed to the bridge — main owns delivery. */
  report(request: ReportingRequest): Promise<UploadResult>;
}

/** Build the renderer trigger pipeline: forward incidents UP, never upload locally. */
export function createElectronRendererReportPipeline(
  options: ElectronRendererReportPipelineOptions,
): ElectronRendererReportPipeline {
  const wallNow = options.wallNow ?? ((): number => Date.now());
  return {
    report(request: ReportingRequest): Promise<UploadResult> {
      if (!options.canDeliver()) {
        // No bridge: say so. Reporting `{ok:true}` here would tell an app awaiting `logException` that its
        // incident was delivered when nothing received it.
        return Promise.resolve({ ok: false });
      }
      try {
        // `source` carries the mechanism (uncaught / unhandledrejection / programmatic), which main preserves
        // — that attribution is the whole point, and re-filing through `logException` on the main side would
        // destroy it (design review SEV1-2).
        options.post(encodeReport(request.source, request.report, wallNow()));
      } catch (error) {
        options.onError?.(error);
        return Promise.resolve({ ok: false });
      }
      return Promise.resolve({ ok: true });
    },
  };
}
