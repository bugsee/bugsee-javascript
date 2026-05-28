import { type CaptureProvider, CaptureProviderBase, type EventSubscribable } from '@bugsee/core';

// Runtime-agnostic SYSTEM EVENTS provider (design §16.1, Android events.system parity). A system event
// is a discrete, auto-captured occurrence (process lifecycle, memory pressure, …). While started, the
// provider subscribes to a system-event SOURCE and routes each event to the aggregator as an
// 'events.system' entry, stamping it from the clock. The shell is runtime-agnostic; WHICH events exist
// (process exit/warning on Node) is the runtime source. Gated by captureSystemEvents.

/** A discrete system event: a name + optional params (Android events.system shape, minus displayId). */
export interface SystemEvent {
  name: string;
  params?: Record<string, unknown>;
}

/** A source of system events — any emitter exposing an `event` channel (e.g. a Node lifecycle source). */
export type SystemEventSource = EventSubscribable<{ event: SystemEvent }>;

export interface SystemEventsProviderOptions {
  /** Wall-clock source for the entry timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
}

class SystemEventsProvider extends CaptureProviderBase {
  readonly name = 'events.system';
  readonly controllingOption = 'captureSystemEvents';
  readonly #source: SystemEventSource;
  readonly #now: () => number;
  #off: (() => void) | null = null;

  constructor(source: SystemEventSource, options: SystemEventsProviderOptions = {}) {
    super();
    this.#source = source;
    this.#now = options.now ?? (() => Date.now());
  }

  protected onStart(): void {
    this.#off = this.#source.on('event', (event) => {
      const timestamp = this.#now();
      this.capture('events.system', timestamp, {
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

export function createSystemEventsProvider(
  source: SystemEventSource,
  options?: SystemEventsProviderOptions,
): CaptureProvider {
  return new SystemEventsProvider(source, options);
}
