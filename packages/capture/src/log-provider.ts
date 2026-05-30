import {
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  getFilters,
  type LogEvent,
  runFilter,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';

// Runtime-agnostic log capture CONSUMER (design §16.1): subscribes to a log SOURCE and routes each
// LogEvent to the aggregator as a `log` capture entry. The source is any emitter with a 'log' stage —
// the shared consoleInterceptor, or a platform log source — so this single provider serves every
// runtime; only the sources vary. Subscribing also drives the source's subscriber-presence activation
// (the console interceptor patches `console` while the provider is started, and unpatches on stop).

/** A source of log events — any emitter exposing a `log` stage (e.g. the console interceptor). */
export type LogSource = EventSubscribable<{ log: LogEvent }>;

class LogCaptureProvider extends CaptureProviderBase {
  readonly name = 'log';
  readonly controllingOption = BugseeOption.CaptureLogs;
  readonly #source: LogSource;
  #off: (() => void) | null = null;

  constructor(source: LogSource) {
    super();
    this.#source = source;
  }

  protected onStart(): void {
    this.#off = this.#source.on('log', (event) => {
      // Live per-event log filter (from the carrier's client); may mutate or DROP the entry.
      const filters = getFilters();
      if (filters?.log) {
        const out = runFilter(filters.log, event, filters.onError);
        if (out !== null) {
          this.capture('log', out.timestamp, out);
        }
      } else {
        this.capture('log', event.timestamp, event);
      }
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
