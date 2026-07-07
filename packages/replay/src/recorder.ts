// @bugsee/replay — the rrweb recorder capture-provider (RP4, design D7). Mirrors @bugsee/capture's
// log-provider: it subscribes to a SOURCE (rrweb `record`) and routes each event to the aggregator as a
// `replay` capture entry — so replay events flow through the existing rolling ring / redaction / bounding
// pipeline for free (one uniform data model). `checkoutEveryNms` (a full snapshot cadence) bounds the ring
// window; `startBlackout()` pauses VISUAL capture only.
//
// The `record` fn is INJECTED (the real one from `@bugsee/rrweb`, or a fake in tests), so this unit needs no
// real DOM.
import { type CaptureProvider, CaptureProviderBase } from '@bugsee/core';
import type { eventWithTime, listenerHandler, recordOptions } from '@bugsee/rrweb';
import type { ResolvedReplayMasking } from './masking';

/** The rrweb `record` function shape (from `@bugsee/rrweb`). */
export type ReplayRecordFn = (options: recordOptions<eventWithTime>) => listenerHandler | undefined;

export interface ReplayCaptureProviderOptions {
  /** The rrweb record function (`@bugsee/rrweb` `record`). */
  record: ReplayRecordFn;
  /** Fail-closed masking/blocking config (RP1). */
  masking: ResolvedReplayMasking;
  /** Full-snapshot cadence (ms) — bounds the retained ring window to one interval. Default 60000. */
  checkoutEveryNms?: number;
}

/** A capture provider that also exposes blackout controls (wired to the client `startBlackout`). */
export interface ReplayRecorder extends CaptureProvider {
  /** Pause replay capture (errors/network/logs continue). */
  startBlackout(): void;
  /** Resume replay capture. */
  stopBlackout(): void;
}

class ReplayCaptureProvider extends CaptureProviderBase implements ReplayRecorder {
  readonly name = 'replay';
  readonly #record: ReplayRecordFn;
  readonly #masking: ResolvedReplayMasking;
  readonly #checkoutEveryNms: number;
  #stop: listenerHandler | undefined;
  #blackedOut = false;

  constructor(options: ReplayCaptureProviderOptions) {
    super();
    this.#record = options.record;
    this.#masking = options.masking;
    this.#checkoutEveryNms = options.checkoutEveryNms ?? 60_000;
  }

  protected onStart(): void {
    this.#stop = this.#record({
      ...this.#masking,
      checkoutEveryNms: this.#checkoutEveryNms,
      // Cross-origin iframes are never recorded (privacy); same-origin iframes are blocked via the masking
      // blockSelector (fail-closed, RP1).
      recordCrossOriginIframes: false,
      emit: (event) => {
        // Blackout pauses VISUAL capture only (design §401 / startBlackout).
        if (!this.#blackedOut) {
          this.capture('replay', event.timestamp, event);
        }
      },
    });
  }

  protected override onStop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  startBlackout(): void {
    this.#blackedOut = true;
  }

  stopBlackout(): void {
    this.#blackedOut = false;
  }
}

/** Build the rrweb recorder capture-provider. */
export function createReplayCaptureProvider(options: ReplayCaptureProviderOptions): ReplayRecorder {
  return new ReplayCaptureProvider(options);
}
