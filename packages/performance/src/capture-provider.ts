import { type CaptureProvider, CaptureProviderBase } from '@bugsee/core';
import { PerformanceOption } from './options';
import type { TransactionWire } from './span';

// The `performance` capture provider (design §75): routes FINISHED transactions into the capture ring —
// the time-windowed data the crash bundle's `performance.json` is assembled from — alongside the
// continuous /v2/performance/transactions upload (+ OTLP tee) the TransactionStore feeds. Unlike other
// providers it is NOT subscription-driven; the controller pushes each finished sampled transaction via
// `record()`, gated by start/stop (subscriber-presence parity).

export interface PerformanceCaptureProvider extends CaptureProvider {
  /** Route a finished transaction into the capture ring (built into the bundle's `performance.json`). */
  record(transaction: TransactionWire): void;
}

class PerformanceCaptureProviderImpl
  extends CaptureProviderBase
  implements PerformanceCaptureProvider
{
  readonly name = 'performance';
  // Declares the gate for parity with other providers, but the AUTHORITATIVE monitoring gate is upstream:
  // `wirePerformance` returns early when monitoring is off, so this provider is never created/added then.
  // (The core coordinator's gate also passes by default for keys outside its option set — see options.)
  readonly controllingOption = PerformanceOption.Monitoring;
  #started = false;

  protected onStart(): void {
    this.#started = true;
  }

  protected override onStop(): void {
    this.#started = false;
  }

  record(transaction: TransactionWire): void {
    if (this.#started) {
      this.capture('performance', transaction.startTimestampMs, transaction);
    }
  }
}

export function createPerformanceCaptureProvider(): PerformanceCaptureProvider {
  return new PerformanceCaptureProviderImpl();
}
