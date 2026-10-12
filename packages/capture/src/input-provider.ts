import {
  type BlackoutGate,
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  type InputEvent,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';

// Runtime-agnostic INPUT provider (Android `input` / `input.json` parity). An input event is
// one press or release the SDK OBSERVED a device make: a touch/mouse/pen pointer going down or up, a key
// going down. While started, the provider subscribes to an input SOURCE and routes each event to the
// aggregator as an `input` entry, stamping it from the clock when the source did not.
//
// WHY IT IS NOT `events.user` (architecture, not preference): `events.user` / `traces.user` carry ONLY what
// the APPLICATION supplied through `client.event()` / `client.trace()`. SDK code must not write into a
// `user.*` stream — mixing SDK-captured interactions into it made an app's own analytics stream
// unreadable and unfilterable. This provider replaced `createUserEventsProvider`, which did exactly that.
//
// The shell is runtime-agnostic; WHICH interactions exist (DOM pointer/key on the browser) is the runtime
// source's job — and the source owns PII masking (it never forwards typed text, input values, or any
// keystroke aimed at a sensitive field). Gated by `captureInteractions`.

/**
 * What a source emits: an `InputEvent` whose `timestamp` is optional. A live DOM source has no wall-clock
 * reading to hand (`Event.timeStamp` is relative to the time origin), so the provider stamps it; a source
 * that DOES know when the event happened (a replayed or buffered one) keeps its own value.
 */
export type InputEventDetail = Omit<InputEvent, 'timestamp'> & { timestamp?: number };

/** A source of input events — any emitter exposing an `input` channel (e.g. the browser DOM input source). */
export type InputSource = EventSubscribable<{ input: InputEventDetail }>;

export interface InputProviderOptions {
  /** Wall-clock source for the entry timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
  /**
   * The blackout gate. While a blackout is in force every input event is dropped (interaction capture is
   * visual capture — see `startBlackout`). Read per event, so a blackout already active at start, or
   * begun at any later point, is honoured with no subscription to leak.
   */
  blackout?: BlackoutGate;
}

class InputProvider extends CaptureProviderBase {
  readonly name = 'input';
  readonly controllingOption = BugseeOption.CaptureInteractions;
  readonly #source: InputSource;
  readonly #now: () => number;
  readonly #blackout: BlackoutGate | undefined;
  #off: (() => void) | null = null;

  constructor(source: InputSource, options: InputProviderOptions = {}) {
    super();
    this.#source = source;
    this.#now = options.now ?? (() => Date.now());
    this.#blackout = options.blackout;
  }

  protected onStart(): void {
    this.#off = this.#source.on('input', (event) => {
      if (this.#blackout?.isActive() === true) {
        return; // blackout: interactions are not recorded
      }
      const timestamp = event.timestamp ?? this.#now();
      // `timestamp` written LAST so the resolved value always wins, including over a detail that
      // carries an explicit `timestamp: undefined` (which the spread would otherwise reinstate).
      this.capture('input', timestamp, { ...event, timestamp });
    });
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
  }
}

export function createInputProvider(
  source: InputSource,
  options?: InputProviderOptions,
): CaptureProvider {
  return new InputProvider(source, options);
}
