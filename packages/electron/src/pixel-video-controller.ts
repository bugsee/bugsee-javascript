// The pixel-video controller (E8d) — wraps a VideoCaptureSource behind a permission gate and exposes the
// report-time snapshot the bundle assembler pulls. The source is a single VideoCaptureSource; the
// "capturePage + MediaRecorder" combination is composed INTO one source by the adapter (capturePage frames
// → canvas → MediaRecorder → webm), so the controller stays source-agnostic. `snapshot` is the
// ReportSnapshotSource contract: given the report's wall-clock time, return the buffered `video` entries.
import type { CaptureDataEntry } from '@bugsee/core';
import type { VideoCaptureSource } from './video-capture';

export interface PixelVideoControllerOptions {
  /** The (possibly composed) pixel-video source to drive. */
  source: VideoCaptureSource;
  /**
   * macOS Screen-Recording (TCC) permission gate — resolves false → the controller stays inert (own-window
   * `capturePage` needs no permission; `getDisplayMedia` does). Default: always granted.
   */
  hasPermission?: () => boolean | Promise<boolean>;
  /** Sink for a failing report-time snapshot — a missing video must never block the report. */
  onError?: (error: unknown) => void;
}

export interface PixelVideoController {
  /** Check permission, then start capture (idempotent). */
  start(): Promise<void>;
  stop(): void;
  /** The ReportSnapshotSource: the buffered video as `video` entries (or [] when inert / empty). */
  snapshot(now: number): Promise<CaptureDataEntry[]>;
}

/** Build the permission-gated pixel-video controller over a single capture source. */
export function createPixelVideoController(
  options: PixelVideoControllerOptions,
): PixelVideoController {
  let active = false;

  return {
    async start(): Promise<void> {
      if (active) {
        return; // idempotent
      }
      const granted = (await options.hasPermission?.()) ?? true;
      if (!granted) {
        return; // no permission → stay inert (no capture, snapshots return [])
      }
      active = true;
      options.source.start();
    },
    stop(): void {
      if (!active) {
        return;
      }
      active = false;
      options.source.stop();
    },
    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      if (!active) {
        return [];
      }
      try {
        return await options.source.snapshot(now);
      } catch (error) {
        options.onError?.(error);
        return [];
      }
    },
  };
}

/**
 * The `video` file encoder: the source already produced encoded container bytes, so the common single-entry
 * case is verbatim. Multiple `video` entries (belt-and-braces — there is only one `video.webm`) are
 * concatenated.
 */
export function encodePixelVideo(payloads: readonly unknown[]): Uint8Array {
  const parts = payloads as readonly Uint8Array[];
  if (parts.length === 1) {
    return parts[0] as Uint8Array;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
