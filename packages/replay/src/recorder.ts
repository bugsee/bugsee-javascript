// @bugsee/replay — the rrweb recorder capture-provider (RP4, design D7). Mirrors @bugsee/capture's
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
  /** Fail-closed masking/blocking config (RP1). */
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
}

/** A capture provider that also exposes blackout controls (wired to the client `startBlackout`). */
export interface ReplayRecorder extends CaptureProvider {
  /**
   * Suspend replay capture (errors/network/logs continue). The rrweb recorder is STOPPED, not merely
   * muted: no DOM mutation, input value or scroll is observed, buffered or computed for the whole window.
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
}

/** rrweb `EventType.Custom`. */
const CUSTOM_EVENT_TYPE = 5;
/**
 * The tag of the rrweb custom events the recorder emits at the start (`payload.active: true`) and end
 * (`false`) of a blackout, so a player can show "blacked out" instead of a frozen pre-blackout screen.
 * Backwards compatible: players that do not know the tag ignore custom events. The viewer rendering is a
 * follow-up (see docs/design/blackout.md).
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
  #blackedOut = false;
  #started = false;
  // Bumped whenever a recording session ends. An `emit` closure belongs to ONE session and is dead after
  // it: a throttled rrweb callback that fires late from a stopped session (scroll/input sampling) must not
  // land in the stream after the blackout began — or after the recorder was restarted.
  #session = 0;
  #offBlackout: (() => void) | undefined;

  constructor(options: ReplayCaptureProviderOptions) {
    super();
    this.#record = options.record;
    this.#masking = options.masking;
    this.#checkoutEveryNms = options.checkoutEveryNms ?? 60_000;
    this.#canvas = options.canvas;
    this.#blackout = options.blackout;
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

  #begin(): void {
    const session = this.#session;
    this.#stop = this.#record({
      ...this.#masking,
      // Opt-in canvas options (recordCanvas / sampling.canvas / dataURLOptions); nothing when DOM-only.
      ...this.#canvas,
      checkoutEveryNms: this.#checkoutEveryNms,
      // Cross-origin iframes are never recorded (privacy); same-origin iframes are blocked via the masking
      // blockSelector (fail-closed, RP1).
      recordCrossOriginIframes: false,
      emit: (event) => {
        // Blackout suspends VISUAL capture only (design §401 / startBlackout); a stale session is dead.
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

  stopBlackout(): void {
    if (!this.#blackedOut) {
      return;
    }
    this.#blackedOut = false;
    if (this.#started) {
      this.#mark(false); // before the restarted recorder's fresh Meta + FullSnapshot
      this.#begin(); // a restarted recorder opens with a fresh full snapshot
    }
  }
}

/** Build the rrweb recorder capture-provider. */
export function createReplayCaptureProvider(options: ReplayCaptureProviderOptions): ReplayRecorder {
  return new ReplayCaptureProvider(options);
}
