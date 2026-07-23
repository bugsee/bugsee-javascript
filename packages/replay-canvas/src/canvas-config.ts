// @bugsee/replay-canvas — the opt-in canvas-replay add-on's option resolver (RPC2). rrweb 2.1.0 records
// <canvas> content by OPTIONS alone (`recordCanvas` + `sampling.canvas` fps + `dataURLOptions`) — the canvas
// recorder is already inside the fork's `record` bundle — so this package is a small, PURE options-builder:
// it resolves friendly canvas options into the `CanvasRecordConfig` seam that @bugsee/replay spreads into
// rrweb `record()`. No rrweb import, no DOM. See docs/design/replay-canvas.md.
import type { CanvasRecordConfig } from '@bugsee/replay';

/** Friendly, cheap-by-default canvas-recording options. */
export interface CanvasReplayOptions {
  /** Canvas capture rate: a number = snapshot frames-per-second (default 2; clamped to [1, 60], rounded to a
   *  whole frame); `'all'` = record EVERY canvas draw call (full fidelity for animation/WebGL, heavier). */
  fps?: number | 'all';
  /** Snapshot image quality 0..1. Default 0.6; clamped to [0, 1]. */
  quality?: number;
  /** Snapshot image encoding. Default 'image/webp' (smaller); 'image/jpeg' for broader support. */
  imageType?: 'image/webp' | 'image/jpeg';
}

const DEFAULT_FPS = 2;
const DEFAULT_QUALITY = 0.6;
const DEFAULT_IMAGE_TYPE = 'image/webp';

/** Clamp fps to a prod-safe [1, 60] whole-frame rate; missing / non-finite → the cheap default. */
function resolveFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) {
    return DEFAULT_FPS;
  }
  return Math.min(60, Math.max(1, Math.round(fps)));
}

/** Clamp quality to [0, 1]; missing / non-finite → the default. */
function resolveQuality(quality: number | undefined): number {
  if (quality === undefined || !Number.isFinite(quality)) {
    return DEFAULT_QUALITY;
  }
  return Math.min(1, Math.max(0, quality));
}

/** Only the two supported encodings; anything else (incl. an out-of-contract value) → the webp default. */
function resolveImageType(imageType: string | undefined): 'image/webp' | 'image/jpeg' {
  return imageType === 'image/jpeg' ? 'image/jpeg' : DEFAULT_IMAGE_TYPE;
}

/** Resolve rrweb's `sampling.canvas`: `'all'` records every draw call (full fidelity); otherwise the
 *  snapshot fps (clamped). */
function resolveSamplingCanvas(fps: number | 'all' | undefined): 'all' | number {
  return fps === 'all' ? 'all' : resolveFps(fps);
}

/**
 * Resolve friendly {@link CanvasReplayOptions} into the {@link CanvasRecordConfig} seam consumed by
 * `@bugsee/replay` (spread into the rrweb `record()` call). Pure; cheap defaults; every value clamped.
 */
export function createCanvasRecordConfig(options: CanvasReplayOptions = {}): CanvasRecordConfig {
  return {
    recordCanvas: true,
    sampling: { canvas: resolveSamplingCanvas(options.fps) },
    dataURLOptions: {
      type: resolveImageType(options.imageType),
      quality: resolveQuality(options.quality),
    },
  };
}
