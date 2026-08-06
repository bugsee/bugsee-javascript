import {
  type CaptureProvider,
  CaptureProviderBase,
  type EventSubscribable,
  getFilters,
  type LogEvent,
  runFilter,
} from '@bugsee/core';
import { BugseeOption, logLevelToWire } from '@bugsee/protocol';

// Runtime-agnostic log capture CONSUMER (design §16.1): subscribes to a log SOURCE and routes each
// LogEvent to the aggregator as a `log` capture entry. The source is any emitter with a 'log' stage —
// the shared consoleInterceptor, or a platform log source — so this single provider serves every
// runtime; only the sources vary. Subscribing also drives the source's subscriber-presence activation
// (the console interceptor patches `console` while the provider is started, and unpatches on stop).

/** A source of log events — any emitter exposing a `log` stage (e.g. the console interceptor). */
export type LogSource = EventSubscribable<{ log: LogEvent }>;

/**
 * Encode the log level to its NUMERIC wire value (design §8.9, mobile parity).
 *
 * `LogEvent.level` is `LogLevelName | LogLevel`, sources emit the friendly NAME, and nothing converted — so
 * every console-captured line reached the backend as `"error"` where the viewer expects `1`.
 * `logLevelToWire` had existed in @bugsee/protocol, exported and unit-tested, with zero callers outside its
 * own test (Wave 5.1).
 *
 * Applied HERE because the provider is the single point every log entry passes through, and AFTER the user
 * filter: a `logFilter` is customer code written against the documented string levels, so converting first
 * would silently break every filter matching on `'error'`. Returns a COPY — the hub event other subscribers
 * observe stays exactly as it was emitted.
 */
const toWire = (event: LogEvent): LogEvent =>
  typeof event.level === 'string' ? { ...event, level: logLevelToWire(event.level) } : event;

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
          this.capture('log', out.timestamp, toWire(out));
        }
      } else {
        this.capture('log', event.timestamp, toWire(event));
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
