import {
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  type LogEvent,
} from '@bugsee/core';

// Runtime-agnostic log capture CONSUMER (design §16.1): subscribes to a log SOURCE and routes each
// LogEvent to the aggregator as a `log` capture entry. The source is any emitter with a 'log' stage —
// the shared consoleInterceptor, or a platform log source — so this single provider serves every
// runtime; only the sources vary. Subscribing also drives the source's subscriber-presence activation
// (the console interceptor patches `console` while the provider is started, and unpatches on stop).

/** A source of log events — any emitter exposing a `log` stage (e.g. the console interceptor). */
export type LogSource = EventSubscribable<{ log: LogEvent }>;

class LogCaptureProvider extends CaptureProviderBase {
  readonly name = 'log';
  readonly controllingOption = 'captureLogs';
  readonly #source: LogSource;
  #off: (() => void) | null = null;

  constructor(source: LogSource) {
    super();
    this.#source = source;
  }

  protected onStart(): void {
    this.#off = this.#source.on('log', (event) => {
      this.capture('log', event.timestamp, event);
    });
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
  }
}

/** The shared log capture provider: consumes a log source → `log` entries. Gated by `captureLogs`. */
export function createLogCaptureProvider(source: LogSource): CaptureProvider {
  return new LogCaptureProvider(source);
}
