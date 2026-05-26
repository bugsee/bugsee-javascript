import type { FileType } from '@bugsee/protocol';
import type { CaptureAggregator, CaptureDataEntry, CaptureProvider, Client } from './contracts';

// Base class for capture data providers (Android BugseeCaptureDataProviderBase parity). Concrete
// providers extend this, subscribe to their hub in onStart(), and on each event call
// `this.capture(type, timestamp, data)` (or `this.addEntry(entry)`) — the base routes the entry to
// the aggregator wired at start() (the proper target), mirroring Android's mDataAggregator.addEntry.
//
// Android's entry object-pool (borrow/return) is a GC optimization that JS doesn't need, so it's
// omitted; entries are plain objects.

export abstract class CaptureProviderBase implements CaptureProvider {
  abstract readonly name: string;
  // `controllingOption` is optional on CaptureProvider; subclasses declare it when they gate on a
  // launch option (no base field, so subclasses needn't write `override`).

  #aggregator: CaptureAggregator | null = null;

  /** Wired by the capture coordinator: captures the aggregator and starts the subclass's hooks. */
  start(client: Client): void {
    this.#aggregator = client.captureAggregator;
    this.onStart(client);
  }

  /** Stops the subclass's hooks and detaches the aggregator. */
  stop(): void {
    this.onStop();
    this.#aggregator = null;
  }

  /** Subclasses subscribe to their hub / install hooks here. */
  protected abstract onStart(client: Client): void;

  /** Subclasses unsubscribe / release hooks here (optional). */
  protected onStop(): void {}

  /** Route a captured entry to the aggregator; a no-op before start() or after stop(). */
  protected addEntry(entry: CaptureDataEntry): void {
    this.#aggregator?.addEntry(entry);
  }

  /** Build a capture entry and route it in one call. */
  protected capture(type: FileType, timestamp: number, data: unknown): void {
    this.addEntry({ type, timestamp, data });
  }
}
