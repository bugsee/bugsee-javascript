// Opt-in pixel video capture (E8 / D8). Two pluggable sources, each a report-time snapshot that yields the
// buffered video as ONE `video` bundle entry (the CPU-profile pattern — pulled at report assembly, never
// streamed). Both take their runtime specifics as injected seams so @bugsee/electron needs no electron/DOM
// dependency and everything is hermetically testable:
//   • createCapturePageVideoSource — MAIN process, periodic `webContents.capturePage()` → a bounded frame
//     ring → an injected `encode` muxer. Captures the app's OWN window content (no macOS Screen-Recording
//     permission).
//   • createMediaRecorderVideoSource — RENDERER, a `MediaRecorder` over a MediaStream (getDisplayMedia for
//     full fidelity, or a canvas.captureStream fed by capturePage frames — the "capturePage + MediaRecorder"
//     combination) → an encoded video blob.
// The two can run together (the controller composes them, E8d); each emits an independent `video` entry.
import { type CaptureDataEntry, CaptureDataEntryBase, type Scheduler } from '@bugsee/core';

/** A single captured frame: the encoded image bytes (e.g. a JPEG/PNG from `capturePage`) + its capture time. */
export interface VideoFrame {
  timestamp: number;
  bytes: Uint8Array;
}

/** A pixel-video source: start/stop capture; `snapshot(now)` pulls the buffered video as `video` entries. */
export interface VideoCaptureSource {
  start(): void;
  stop(): void;
  snapshot(now: number): Promise<CaptureDataEntry[]>;
}

/** Wrap already-encoded video bytes as the single report-time `video` bundle entry. */
function videoEntry(now: number, bytes: Uint8Array): CaptureDataEntry {
  return new CaptureDataEntryBase('video', now, bytes);
}

export interface CapturePageVideoSourceOptions {
  /** Grab ONE encoded frame (real: `webContents.capturePage().then((img) => img.toJPEG(q))`). */
  capturePage: () => Promise<Uint8Array>;
  /** Periodic sampler (real: the node global-timer scheduler). */
  scheduler: Scheduler;
  /** Mux the frame ring into the final container bytes (real: a webm/mjpeg muxer; injected seam). */
  encode: (frames: readonly VideoFrame[], fps: number) => Uint8Array;
  /** Frames per second (default 1). */
  fps?: number;
  /** Max frames retained in the rolling ring (drop-oldest). Default 300. */
  maxFrames?: number;
  /** Wall clock for frame timestamps. */
  now: () => number;
  /** Sink for a failed grab — the timer never throws. */
  onError?: (error: unknown) => void;
}

/** A MAIN-process pixel-video source: periodic `capturePage` into a bounded ring, encoded at report time. */
export function createCapturePageVideoSource(
  options: CapturePageVideoSourceOptions,
): VideoCaptureSource {
  const fps = options.fps ?? 1;
  const maxFrames = options.maxFrames ?? 300;
  const ring: VideoFrame[] = [];
  let handle: unknown;

  const tick = async (): Promise<void> => {
    try {
      const bytes = await options.capturePage();
      ring.push({ timestamp: options.now(), bytes });
      if (ring.length > maxFrames) {
        ring.shift(); // drop-oldest — a rolling incident window
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    start(): void {
      if (handle !== undefined) {
        return; // idempotent
      }
      handle = options.scheduler.setInterval(() => {
        void tick();
      }, Math.round(1000 / fps));
    },
    stop(): void {
      if (handle !== undefined) {
        options.scheduler.clearInterval(handle);
        handle = undefined;
      }
    },
    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      if (ring.length === 0) {
        return [];
      }
      return [videoEntry(now, options.encode([...ring], fps))];
    },
  };
}

/** The subset of the DOM `MediaRecorder` we use. */
export interface MediaRecorderLike {
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: unknown }) => void) | null;
}

export interface MediaRecorderVideoSourceOptions {
  /** Build a `MediaRecorder` over the capture stream (real: `() => new MediaRecorder(stream, { mimeType })`). */
  recorderFactory: () => MediaRecorderLike;
  /** Concatenate the recorded chunks into the final bytes (real: join Blob `arrayBuffer()`s). */
  toBytes: (chunks: unknown[]) => Uint8Array | Promise<Uint8Array>;
  /** Wall clock for the entry timestamp. */
  now: () => number;
  /** `MediaRecorder.start` timeslice (ms) — emit a chunk every N ms so a report has recent data. */
  timeslice?: number;
}

/** A RENDERER-side pixel-video source: a `MediaRecorder` over a MediaStream, encoded at report time. */
export function createMediaRecorderVideoSource(
  options: MediaRecorderVideoSourceOptions,
): VideoCaptureSource {
  const chunks: unknown[] = [];
  let recorder: MediaRecorderLike | undefined;

  return {
    start(): void {
      recorder = options.recorderFactory();
      recorder.ondataavailable = (event): void => {
        chunks.push(event.data);
      };
      recorder.start(options.timeslice);
    },
    stop(): void {
      recorder?.stop();
    },
    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      if (chunks.length === 0) {
        return [];
      }
      return [videoEntry(now, await options.toBytes(chunks))];
    },
  };
}
