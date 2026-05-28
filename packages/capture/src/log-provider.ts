import { type CaptureProvider, CaptureProviderBase } from '@bugsee/core';

// Runtime-agnostic log capture CONSUMER (design §16.1): subscribes to the log hub and routes each
// LogEvent to the aggregator as a `log` capture entry. The hub is fed by sources — the shared
// consoleInterceptor, the manual client.log(), or any platform-specific log source — so this single
// provider serves every runtime; only the SOURCES vary. Uses the init()/start(options) lifecycle
// (init supplies the pipeline at registration; start subscribes).

class LogCaptureProvider extends CaptureProviderBase {
  readonly name = 'log';
  readonly controllingOption = 'captureLogs';
  #off: (() => void) | null = null;

  protected onStart(): void {
    this.#off = this.pipeline.hubs.log.subscribe((event) => {
      this.capture('log', event.timestamp, event);
    });
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
  }
}

/** The shared log capture provider (consumes the log hub → `log` entries). Gated by `captureLogs`. */
export function createLogCaptureProvider(): CaptureProvider {
  return new LogCaptureProvider();
}
