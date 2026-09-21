import {
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  type VideoAuxEvent,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';

// Runtime-agnostic GEOMETRY provider — the `video.aux` stream (`video.aux.json`), version 2 of the
// contract in bugsee/specs `sdk/reporting/bundle/video-aux.md`. One entry says what the frame looked
// like at a moment in time; `input`'s coordinates are meaningless without it, because a consumer with
// no frame falls back to `environment.hardware.screen` — the whole monitor, captured once at launch —
// and draws clicks off the frame.
//
// The shell is runtime-agnostic and deliberately dumb: WHICH geometry exists, when it changed, and the
// dedup/coalescing that keeps a pinch from flooding the stream are the runtime source's job (the
// browser's `viewport-source.ts`), exactly as with `input`. This provider only stamps and routes.
//
// Gated by `captureInteractions`, the same option as `input`: the stream exists to place that stream's
// coordinates, so there is no reason to record geometry for a build that records no interactions.

/**
 * What a source emits: a `VideoAuxEvent` whose `timestamp` is optional. A live DOM source has no
 * wall-clock reading to hand (`Event.timeStamp` is relative to the time origin), so the provider stamps
 * it; a source that DOES know when the geometry changed keeps its own value.
 */
export type VideoAuxEventDetail = Omit<VideoAuxEvent, 'timestamp'> & { timestamp?: number };

/** A source of geometry events — any emitter exposing a `viewport` channel. */
export type VideoAuxSource = EventSubscribable<{ viewport: VideoAuxEventDetail }>;

export interface VideoAuxProviderOptions {
  /** Wall-clock source for the entry timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
}

class VideoAuxProvider extends CaptureProviderBase {
  readonly name = 'video.aux';
  readonly controllingOption = BugseeOption.CaptureInteractions;
  readonly #source: VideoAuxSource;
  readonly #now: () => number;
  #off: (() => void) | null = null;

  constructor(source: VideoAuxSource, options: VideoAuxProviderOptions = {}) {
    super();
    this.#source = source;
    this.#now = options.now ?? (() => Date.now());
  }

  protected onStart(): void {
    this.#off = this.#source.on('viewport', (event) => {
      const timestamp = event.timestamp ?? this.#now();
      // `timestamp` written LAST so the resolved value always wins, including over a detail that
      // carries an explicit `timestamp: undefined` (which the spread would otherwise reinstate). An
      // entry with no timestamp is a frame no coordinate can be matched to.
      this.capture('video.aux', timestamp, { ...event, timestamp });
    });
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
  }
}

export function createVideoAuxProvider(
  source: VideoAuxSource,
  options?: VideoAuxProviderOptions,
): CaptureProvider {
  return new VideoAuxProvider(source, options);
}
