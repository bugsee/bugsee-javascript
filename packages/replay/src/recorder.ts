// @bugsee/replay — the rrweb recorder capture-provider. Mirrors @bugsee/capture's
// log-provider: it subscribes to a SOURCE (rrweb `record`) and routes each event to the aggregator as a
// `replay` capture entry — so replay events flow through the existing rolling ring / redaction / bounding
// pipeline for free (one uniform data model). `checkoutEveryNms` (a full snapshot cadence) bounds the ring
// window; `startBlackout()` pauses VISUAL capture only.
//
// The `record` fn is INJECTED (the real one from `@bugsee/rrweb`, or a fake in tests), so this unit needs no
// real DOM.
import { type BlackoutGate, type CaptureProvider, CaptureProviderBase } from '@bugsee/core';
import type { eventWithTime, listenerHandler, recordOptions } from '@bugsee/rrweb';
import type { ResolvedReplayMasking } from './masking';

/** The rrweb `record` function shape (from `@bugsee/rrweb`). */
export type ReplayRecordFn = (options: recordOptions<eventWithTime>) => listenerHandler | undefined;

/**
 * Opt-in canvas-recording options, produced by `@bugsee/replay-canvas` and spread into the rrweb
 * `record()` call. rrweb 2.1.0 records canvas by options alone (`recordCanvas` + `sampling.canvas` fps +
 * `dataURLOptions`) — the canvas recorder is already inside the fork's `record` bundle, so there is no
 * manager to inject. `undefined` ⇒ DOM-only replay (unchanged).
 */
export interface CanvasRecordConfig {
  recordCanvas: true;
  /** Canvas sampling: a frames-per-second number, or `'all'` for every frame. */
  sampling: { canvas: 'all' | number };
  /** Snapshot image encoding, e.g. `{ type: 'image/webp', quality: 0.6 }`. */
  dataURLOptions: { type: string; quality: number };
}

export interface ReplayCaptureProviderOptions {
  /** The rrweb record function (`@bugsee/rrweb` `record`). */
  record: ReplayRecordFn;
  /** Fail-closed masking/blocking config. */
  masking: ResolvedReplayMasking;
  /** Full-snapshot cadence (ms) — bounds the retained ring window to one interval. Default 60000. */
  checkoutEveryNms?: number;
  /** Opt-in canvas recording (from `@bugsee/replay-canvas`); `undefined` ⇒ DOM-only (unchanged). */
  canvas?: CanvasRecordConfig;
  /**
   * The client's blackout gate. The recorder follows it (pause on start, FRESH-SNAPSHOT resume on end),
   * and a blackout already in force when the recorder starts means it never records at all — which matters
   * because replay is lazy-loaded and can resolve after the app called `startBlackout()`.
   */
  blackout?: BlackoutGate;
  /** Sink for a recorder-level degradation (canvas recording given up after repeated restarts). */
  onError?: (error: unknown) => void;
}

/** A capture provider that also exposes blackout controls (wired to the client `startBlackout`). */
export interface ReplayRecorder extends CaptureProvider {
  /**
   * Suspend replay capture (errors/network/logs continue). The rrweb recorder is STOPPED through its stop
   * handle, not merely muted: its DOM observers (mutation, input, scroll, ...) are disconnected for the whole
   * window, so nothing from it is emitted or buffered. LIMIT: rrweb's own canvas recorder does not release
   * everything on stop (an image-bitmap Worker per FPS-sampled start and two requestAnimationFrame loops per
   * `sampling: 'all'` start stay alive in the fork); they emit nothing into the stream because the stopped
   * session's `emit` is dead, but they are why canvas restarts are bounded (see `MAX_CANVAS_STARTS`).
   */
  startBlackout(): void;
  /**
   * Resume replay capture by restarting the recorder, which opens with a fresh Meta + FullSnapshot. The
   * intermediate mutations were never recorded, so none of them can be replayed.
   *
   * CAVEAT (privacy): the fresh snapshot is taken from the LIVE DOM at the moment blackout ends, so it
   * contains whatever the DOM holds then. With `maskAllInputs: false` (or an unmasked field) that includes
   * values the user typed DURING the blackout, if the sensitive view is still on screen. Integrators must
   * call `endBlackout()` only after the sensitive view is gone. A pair of `bugsee.blackout` custom events
   * brackets the span in the stream.
   */
  stopBlackout(): void;
  /**
   * Restart the recorder so the stream continues from a fresh Meta + FullSnapshot, WITHOUT any blackout marker. Used
   * when part of the stream was not persisted (disk pressure): a durable replay that resumes with incremental events
   * the player never saw their base for cannot be replayed, a fresh snapshot makes the resumed tail self-contained.
   * A no-op while blacked out (the end of the blackout restarts it anyway) or when not started.
   */
  checkout(): void;
}

/**
 * How many times the recorder may START with canvas recording on (the first start counts). The Bugsee rrweb
 * fork's canvas recorder leaks a Worker and rAF loops on every start/stop cycle and exposes no way to
 * release or pause them, so each blackout restart would add more. Past the bound the recorder restarts
 * DOM-only (canvas contents stop being recorded; the DOM replay and the privacy guarantees are unaffected)
 * and says so once through `onError`.
 */
export const MAX_CANVAS_STARTS = 4;

/** rrweb `EventType.Custom`. */
const CUSTOM_EVENT_TYPE = 5;
/**
 * The tag of the rrweb custom events the recorder emits at the start (`payload.active: true`) and end
 * (`false`) of a blackout, so a player can show "blacked out" instead of a frozen pre-blackout screen.
 * Backwards compatible: players that do not know the tag ignore custom events. The viewer rendering is a
 * follow-up.
 */
export const BLACKOUT_MARKER_TAG = 'bugsee.blackout';

class ReplayCaptureProvider extends CaptureProviderBase implements ReplayRecorder {
  readonly name = 'replay';
  readonly #record: ReplayRecordFn;
  readonly #masking: ResolvedReplayMasking;
  readonly #checkoutEveryNms: number;
  readonly #canvas: CanvasRecordConfig | undefined;
  readonly #blackout: BlackoutGate | undefined;
  #stop: listenerHandler | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #blackedOut = false;
  #started = false;
  // Whether the opening `bugsee.blackout {active:true}` marker of the CURRENT blackout was emitted; the
  // closing marker is only ever emitted for a blackout that has one, so there is never an orphan `false`.
  #markedStart = false;
  #canvasStarts = 0;
  #canvasDropped = false;
  // Bumped whenever a recording session ends. An `emit` closure belongs to ONE session and is dead after
  // it: a late callback of a stopped session (rrweb throttles scroll/input sampling, and its canvas worker
  // answers asynchronously) is dropped here, so it cannot land in the stream after the blackout began or
  // after the recorder was restarted. This guards OUR stream only; it does not make rrweb release a
  // stopped session's canvas Worker / rAF loops (see MAX_CANVAS_STARTS).
  #session = 0;
  #offBlackout: (() => void) | undefined;

  constructor(options: ReplayCaptureProviderOptions) {
    super();
    this.#record = options.record;
    this.#masking = options.masking;
    this.#checkoutEveryNms = options.checkoutEveryNms ?? 60_000;
    this.#canvas = options.canvas;
    this.#blackout = options.blackout;
    this.#onError = options.onError;
  }

  protected onStart(): void {
    this.#started = true;
    if (this.#blackout !== undefined) {
      // Read the gate BEFORE recording: a blackout begun before the lazy replay chunk resolved must never
      // see even the opening snapshot.
      this.#blackedOut = this.#blackout.isActive();
      this.#offBlackout = this.#blackout.onChange((active) => {
        if (active) {
          this.startBlackout();
        } else {
          this.stopBlackout();
        }
      });
    }
    if (!this.#blackedOut) {
      this.#begin();
    }
  }

  #canvasForThisStart(): CanvasRecordConfig | undefined {
    if (this.#canvas === undefined || this.#canvasDropped) {
      return undefined;
    }
    if (this.#canvasStarts >= MAX_CANVAS_STARTS) {
      this.#canvasDropped = true;
      // `onError` is host code: a throw here must not stop the recorder from starting (replay would stay off).
      try {
        this.#onError?.(
          new Error(
            `replay: canvas recording stopped after ${MAX_CANVAS_STARTS} recorder starts (rrweb cannot release canvas resources on stop); DOM replay continues`,
          ),
        );
      } catch {
        /* a throwing sink is the host's problem, never the recording's */
      }
      return undefined;
    }
    this.#canvasStarts += 1;
    return this.#canvas;
  }

  #begin(): void {
    const session = this.#session;
    this.#stop = this.#record({
      ...this.#masking,
      // Opt-in canvas options (recordCanvas / sampling.canvas / dataURLOptions); nothing when DOM-only.
      ...this.#canvasForThisStart(),
      checkoutEveryNms: this.#checkoutEveryNms,
      // Cross-origin iframes are never recorded (privacy); same-origin iframes are blocked via the masking
      // blockSelector (fail-closed).
      recordCrossOriginIframes: false,
      emit: (event) => {
        // Blackout suspends VISUAL capture only (see startBlackout); a stale session is dead.
        if (session === this.#session && !this.#blackedOut) {
          this.capture('replay', event.timestamp, event);
        }
      },
    });
  }

  #halt(): void {
    this.#session += 1;
    this.#stop?.();
    this.#stop = undefined;
  }

  protected override onStop(): void {
    this.#started = false;
    this.#offBlackout?.();
    this.#offBlackout = undefined;
    this.#halt();
  }

  startBlackout(): void {
    // Mark the span in the stream FIRST (only if this provider was actually recording): the recorder is
    // about to stop, and without a marker the player would show the last pre-blackout frame as if it were
    // still live. It is an rrweb custom event (type 5), ignored by players that do not know the tag.
    if (this.#stop !== undefined) {
      this.#mark(true);
      this.#markedStart = true;
    }
    this.#blackedOut = true;
    this.#halt();
  }

  #mark(active: boolean): void {
    const timestamp = Date.now();
    this.capture('replay', timestamp, {
      type: CUSTOM_EVENT_TYPE,
      data: { tag: BLACKOUT_MARKER_TAG, payload: { active } },
      timestamp,
    });
  }

  checkout(): void {
    if (!this.#started || this.#blackedOut) {
      return;
    }
    this.#halt();
    this.#begin();
  }

  stopBlackout(): void {
    if (!this.#blackedOut) {
      return;
    }
    this.#blackedOut = false;
    if (this.#started) {
      if (this.#markedStart) {
        this.#mark(false); // before the restarted recorder's fresh Meta + FullSnapshot
      }
      this.#markedStart = false;
      this.#begin(); // a restarted recorder opens with a fresh full snapshot
    }
  }
}

/** Build the rrweb recorder capture-provider. */
export function createReplayCaptureProvider(options: ReplayCaptureProviderOptions): ReplayRecorder {
  return new ReplayCaptureProvider(options);
}
