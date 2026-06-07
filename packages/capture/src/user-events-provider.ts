import { type CaptureProvider, CaptureProviderBase, type EventSubscribable } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';

// Runtime-agnostic USER EVENTS provider (design §16.1, Android events.user / input parity). A user event
// is a discrete interaction the person performed (a click/tap, a control key, a field change, a focus
// move…). While started, the provider subscribes to a user-event SOURCE and routes each event to the
// aggregator as an 'events.user' entry, stamping it from the clock. The shell is runtime-agnostic; WHICH
// interactions exist (DOM pointer/key/change on the browser) is the runtime source's job — and the source
// owns PII masking (it never forwards typed text or input values). Gated by captureInteractions.

/** A discrete user interaction: a name + optional params (mirrors SystemEvent's name/params shape). */
export interface UserEvent {
  name: string;
  params?: Record<string, unknown>;
}

/** A source of user events — any emitter exposing an `event` channel (e.g. a browser DOM input source). */
export type UserEventSource = EventSubscribable<{ event: UserEvent }>;

export interface UserEventsProviderOptions {
  /** Wall-clock source for the entry timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
}

class UserEventsProvider extends CaptureProviderBase {
  readonly name = 'events.user';
  readonly controllingOption = BugseeOption.CaptureInteractions;
  readonly #source: UserEventSource;
  readonly #now: () => number;
  #off: (() => void) | null = null;

  constructor(source: UserEventSource, options: UserEventsProviderOptions = {}) {
    super();
    this.#source = source;
    this.#now = options.now ?? (() => Date.now());
  }

  protected onStart(): void {
    this.#off = this.#source.on('event', (event) => {
      const timestamp = this.#now();
      this.capture('events.user', timestamp, {
        timestamp,
        name: event.name,
        ...(event.params !== undefined ? { params: event.params } : {}),
      });
    });
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
  }
}

export function createUserEventsProvider(
  source: UserEventSource,
  options?: UserEventsProviderOptions,
): CaptureProvider {
  return new UserEventsProvider(source, options);
}
