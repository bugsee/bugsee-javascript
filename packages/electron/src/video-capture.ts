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
import { reportGuarded } from '@bugsee/util';

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
  /**
   * A key that names the PHYSICAL display and does not change when the ids are renumbered (focus moving between monitors
   * renumbers `id`, since 0 is the key window's display). Frames are kept per key, so a ring never mixes two monitors.
   * Default: `id`.
   */
  key?: string | number;
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
   * A window whose grab failed or timed out arrives with `bytes: undefined`, in its place in the order: paint an opaque
   * placeholder over its bounds, so the window behind it does not show through where it was.
   */
  compose: (
    display: DisplayInfo,
    layers: ReadonlyArray<{ bytes: Uint8Array | undefined; bounds: Rect }>,
  ) => Promise<Uint8Array>;
  /** Mux one display's frame ring into the container bytes (as for {@link CapturePageVideoSourceOptions}). */
  encode: (frames: readonly VideoFrame[], fps: number) => Uint8Array;
  scheduler: Scheduler;
  /** Frames per second (default 1). */
  fps?: number;
  /** Max frames retained PER DISPLAY (drop-oldest). Default 300. */
  maxFrames?: number;
  /**
   * A tick that has not finished after this many ms (a `capturePage` of an occluded or hung window never answers) is
   * abandoned, so capture resumes at the next tick; its late result is discarded. 1 to 2147483647. Default 10000.
   */
  stuckMs?: number;
  /**
   * One window's `capture()` that has not answered after this many ms is dropped from its display's frame (the other windows
   * still compose, and the other displays are not held up). 1 to 2147483647. Default half of `stuckMs`.
   */
  layerTimeoutMs?: number;
  /** One-shot timer: calls `fn` after `ms` and returns its canceller. Default the global `setTimeout`. */
  after?: (ms: number, fn: () => void) => () => void;
  now: () => number;
  /** Sink for a failed grab or compose — the timer never throws, whatever the sink does. */
  onError?: (error: unknown) => void;
}

/**
 * A MAIN-process pixel-video source that follows the mobile model: the windows of one display are composed into ONE frame, and
 * a report carries one `video` per display (entry lane = the display id; the bundle names the member and sets
 * `attrs.displayId`). A display with no visible window records nothing for that tick.
 */
export function createDisplayVideoSource(options: DisplayVideoSourceOptions): VideoCaptureSource {
  const fps = options.fps ?? 1;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`fps must be a positive finite number, got ${fps}`);
  }
  const maxFrames = options.maxFrames ?? 300;
  const stuckMs = options.stuckMs ?? 10_000;
  const layerTimeoutMs = options.layerTimeoutMs ?? Math.floor(stuckMs / 2);
  for (const [name, ms] of [
    ['stuckMs', stuckMs],
    ['layerTimeoutMs', layerTimeoutMs],
  ] as const) {
    // The default timer runs a delay outside 1..2147483647 ms as 1 ms, which would abandon every grab at once.
    if (!(ms >= 1 && ms <= 2_147_483_647)) {
      throw new RangeError(`${name} must be from 1 to 2147483647 ms, got ${ms}`);
    }
  }
  const after =
    options.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const timers = globalThis as unknown as {
        setTimeout(cb: () => void, ms: number): unknown;
        clearTimeout(handle: unknown): void;
      };
      const handle = timers.setTimeout(fn, ms);
      return () => timers.clearTimeout(handle);
    });
  const report = (error: unknown): void => reportGuarded(options.onError, error);
  // `work` settles with its own result, or the call fails once `ms` have passed (the work itself cannot be cancelled).
  const bounded = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let cancel: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancel = after(ms, () => reject(new Error(`${what} did not answer in ${ms} ms`)));
    });
    return Promise.race([work, timeout]).finally(() => cancel?.());
  };
  // Per PHYSICAL display (its key); `id` is the number it has now, refreshed every tick.
  const rings = new Map<string | number, { id: number; frames: VideoFrame[] }>();
  let handle: unknown;
  let epoch = 0; // bumped by clear(): a frame that began before it is discarded
  const composing = new Set<string | number>(); // displays whose compose call has been started and has not yet settled
  let busy = false; // a slow compose must not overlap the next tick
  let busySince = 0;
  let token = 0; // identifies the running tick: an abandoned one is told apart from the current one

  const grab = async (
    layers: readonly WindowLayer[],
  ): Promise<Array<{ bytes: Uint8Array | undefined; bounds: Rect }>> => {
    const grabbed = await Promise.all(
      layers.map(async (layer) => {
        try {
          // A window that never answers must not hold the whole display (and, through the tick, every display) hostage.
          return {
            bytes: await bounded(layer.capture(), layerTimeoutMs, 'window capture'),
            bounds: layer.bounds,
          };
        } catch (error) {
          report(error);
          // One window failing does not cost the display its frame, but it keeps its place as a placeholder.
          return { bytes: undefined, bounds: layer.bounds };
        }
      }),
    );
    return grabbed;
  };

  const frameOf = async (display: DisplayInfo, started: number, mine: number): Promise<void> => {
    try {
      // Refreshed now, even when this display shows no window: its ring must not keep a number another display holds.
      const known = rings.get(display.key ?? display.id);
      if (known !== undefined) {
        known.id = display.id;
      }
      const layers = await grab(options.layers(display));
      if (!layers.some((layer) => layer.bytes !== undefined)) {
        return; // no window, or none that could be grabbed: nothing real to show
      }
      const key = display.key ?? display.id;
      if (composing.has(key)) {
        return; // an earlier compose for this display has not settled (a hung compositor): do not pile another on it
      }
      const work = options.compose(display, layers);
      composing.add(key);
      const release = (): void => {
        composing.delete(key);
      };
      work.then(release, release);
      // A compositor that never settles must not keep this tick for ever either.
      const bytes = await bounded(work, stuckMs, 'compose');
      if (started !== epoch || mine !== token) {
        return; // cleared (blackout) or abandoned while this frame was in flight
      }
      const ring = rings.get(key) ?? { id: display.id, frames: [] };
      ring.id = display.id;
      rings.set(key, ring);
      ring.frames.push({ timestamp: options.now(), bytes });
      if (ring.frames.length > maxFrames) {
        ring.frames.shift();
      }
    } catch (error) {
      report(error);
    }
  };

  const tick = async (): Promise<void> => {
    try {
      if (busy) {
        if (options.now() - busySince < stuckMs) {
          return;
        }
        // The running tick has not answered for stuckMs: abandon it (its result is ignored via the token).
      }
      busy = true;
      busySince = options.now();
      token += 1;
      const mine = token;
      const started = epoch;
      try {
        await Promise.all(options.displays().map((display) => frameOf(display, started, mine)));
        if (mine !== token) {
          return;
        }
        // A display that is gone keeps its frames only as long as the ring covers: after that nothing of it is in the window.
        const cutoff = options.now() - (maxFrames / fps) * 1000;
        for (const [key, ring] of rings) {
          while (ring.frames.length > 0 && (ring.frames[0] as VideoFrame).timestamp < cutoff) {
            ring.frames.shift();
          }
          if (ring.frames.length === 0) {
            rings.delete(key);
          }
        }
      } finally {
        if (mine === token) {
          busy = false;
        }
      }
    } catch (error) {
      report(error); // a screen that is not ready, a throwing clock or sink: the timer must never see a rejection
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
      const out: CaptureDataEntry[] = [];
      for (const { id, frames } of [...rings.values()].sort((a, b) => a.id - b.id)) {
        try {
          const entry = videoEntry(now, options.encode([...frames], fps)); // a ring exists only with its first frame
          entry.lane = String(id);
          out.push(entry);
        } catch (error) {
          report(error); // one display's muxer failing costs only that display's video
        }
      }
      return out;
    },
  };
}
