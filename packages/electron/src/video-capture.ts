// Opt-in pixel video capture. Two pluggable sources, each a report-time snapshot that yields the
// buffered video as ONE `video` bundle entry (the CPU-profile pattern — pulled at report assembly, never
// streamed). Both take their runtime specifics as injected seams so @bugsee/electron needs no electron/DOM
// dependency and everything is hermetically testable:
//   • createCapturePageVideoSource — MAIN process, periodic `webContents.capturePage()` → a bounded frame
//     ring → an injected `encode` muxer. Captures the app's OWN window content (no macOS Screen-Recording
//     permission).
//   • createMediaRecorderVideoSource — RENDERER, a `MediaRecorder` over a MediaStream (getDisplayMedia for
//     full fidelity, or a canvas.captureStream fed by capturePage frames — the "capturePage + MediaRecorder"
//     combination) → an encoded video blob.
// The two can run together (the controller composes them); each emits an independent `video` entry.
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
  /**
   * Discard EVERYTHING buffered, including any frame or chunk still in flight (blackout: the span's video
   * must not exist, and neither may the frames just before it). Required, not optional: a custom source
   * that cannot forget would silently keep a blacked-out screen, so the compiler must force the question.
   */
  clear(): void;
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
  // Bumped by clear(): a grab that began before it is discarded when it resolves.
  let epoch = 0;

  const tick = async (): Promise<void> => {
    const started = epoch;
    try {
      const bytes = await options.capturePage();
      if (started !== epoch) {
        return; // cleared (blackout) while this grab was in flight
      }
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
      handle = options.scheduler.setInterval(
        () => {
          void tick();
        },
        Math.round(1000 / fps),
      );
    },
    stop(): void {
      if (handle !== undefined) {
        options.scheduler.clearInterval(handle);
        handle = undefined;
      }
    },
    clear(): void {
      epoch += 1;
      ring.length = 0;
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
  // Bumped by clear(): a recorder started before it (and its late `stop` flush) can no longer add chunks.
  let epoch = 0;

  return {
    start(): void {
      recorder = options.recorderFactory();
      const started = epoch;
      recorder.ondataavailable = (event): void => {
        if (started === epoch) {
          chunks.push(event.data);
        }
      };
      recorder.start(options.timeslice);
    },
    stop(): void {
      recorder?.stop();
    },
    clear(): void {
      epoch += 1;
      chunks.length = 0;
    },
    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      if (chunks.length === 0) {
        return [];
      }
      return [videoEntry(now, await options.toBytes(chunks))];
    },
  };
}

/** A rectangle in desktop (DIP) coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One display: its id (`displays` trace order: 0 = the key window's display) and its desktop bounds. */
export interface DisplayInfo {
  id: number;
  bounds: Rect;
}

/** One visible window that overlaps a display: where it is, and a grab of its own pixels. */
export interface WindowLayer {
  bounds: Rect;
  capture: () => Promise<Uint8Array>;
}

export interface DisplayVideoSourceOptions {
  /** The displays present now (real: `screen.getAllDisplays()`). */
  displays: () => readonly DisplayInfo[];
  /** The visible windows that overlap `display`, BACK TO FRONT (real: the app's `BrowserWindow`s by z-order). */
  layers: (display: DisplayInfo) => readonly WindowLayer[];
  /**
   * Paint the windows onto one frame the size of the display and encode it (real: an offscreen canvas or an image
   * library; an injected seam, like `encode`). Layers arrive back to front with their grabbed bytes and bounds.
   */
  compose: (
    display: DisplayInfo,
    layers: ReadonlyArray<{ bytes: Uint8Array; bounds: Rect }>,
  ) => Promise<Uint8Array>;
  /** Mux one display's frame ring into the container bytes (as for {@link CapturePageVideoSourceOptions}). */
  encode: (frames: readonly VideoFrame[], fps: number) => Uint8Array;
  scheduler: Scheduler;
  /** Frames per second (default 1). */
  fps?: number;
  /** Max frames retained PER DISPLAY (drop-oldest). Default 300. */
  maxFrames?: number;
  now: () => number;
  /** Sink for a failed grab or compose — the timer never throws. */
  onError?: (error: unknown) => void;
}

/**
 * A MAIN-process pixel-video source that follows the mobile model: the windows of one display are composed into ONE frame, and
 * a report carries one `video` per display (entry lane = the display id; the bundle names the member and sets
 * `attrs.displayId`). A display with no visible window records nothing for that tick.
 */
export function createDisplayVideoSource(options: DisplayVideoSourceOptions): VideoCaptureSource {
  const fps = options.fps ?? 1;
  const maxFrames = options.maxFrames ?? 300;
  const rings = new Map<number, VideoFrame[]>();
  let handle: unknown;
  let epoch = 0; // bumped by clear(): a frame that began before it is discarded
  let busy = false; // a slow compose must not overlap the next tick

  const grab = async (
    layers: readonly WindowLayer[],
  ): Promise<Array<{ bytes: Uint8Array; bounds: Rect }>> => {
    const grabbed = await Promise.all(
      layers.map(async (layer) => {
        try {
          return { bytes: await layer.capture(), bounds: layer.bounds };
        } catch (error) {
          options.onError?.(error);
          return undefined; // one window failing does not cost the display its frame
        }
      }),
    );
    return grabbed.filter((layer) => layer !== undefined);
  };

  const frameOf = async (display: DisplayInfo, started: number): Promise<void> => {
    try {
      const layers = await grab(options.layers(display));
      if (layers.length === 0) {
        return;
      }
      const bytes = await options.compose(display, layers);
      if (started !== epoch) {
        return;
      }
      const ring = rings.get(display.id) ?? [];
      rings.set(display.id, ring);
      ring.push({ timestamp: options.now(), bytes });
      if (ring.length > maxFrames) {
        ring.shift();
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  const tick = async (): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    const started = epoch;
    try {
      await Promise.all(options.displays().map((display) => frameOf(display, started)));
      // A display that is gone keeps its frames only as long as the ring covers: after that nothing of it is in the window.
      const cutoff = options.now() - (maxFrames / fps) * 1000;
      for (const [id, ring] of rings) {
        if ((ring[ring.length - 1]?.timestamp ?? 0) < cutoff) {
          rings.delete(id);
        }
      }
    } finally {
      busy = false;
    }
  };

  return {
    start(): void {
      if (handle !== undefined) {
        return;
      }
      // The promise is returned (it never rejects: every failure is caught inside), so a scheduler or a test can await a tick.
      handle = options.scheduler.setInterval(() => tick(), Math.round(1000 / fps));
    },
    stop(): void {
      if (handle !== undefined) {
        options.scheduler.clearInterval(handle);
        handle = undefined;
      }
    },
    clear(): void {
      epoch += 1;
      rings.clear();
    },
    async snapshot(now: number): Promise<CaptureDataEntry[]> {
      return [...rings.entries()]
        .filter(([, ring]) => ring.length > 0)
        .sort(([a], [b]) => a - b)
        .map(([id, ring]) => {
          const entry = videoEntry(now, options.encode([...ring], fps));
          entry.lane = String(id);
          return entry;
        });
    },
  };
}
