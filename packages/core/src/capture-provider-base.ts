import type { FileType } from '@bugsee/protocol';
import { CaptureDataEntryBase } from './capture-data-entry';
import type {
  CaptureDataEntry,
  CaptureProvider,
  CaptureProviderInit,
  OptionsContainer,
} from './contracts';

// Base class for capture data providers (Android BugseeCaptureDataProviderBase parity). Lifecycle
// splits dependency wiring from per-launch configuration (Android BugseeCaptureDataProviderInit):
//   init(init)      — ONCE at registration: store the capture-pipeline deps (hubs/operations/aggregator).
//   start(options)  — per launch: onStart(options) (re)configures + subscribes to the hub.
//   stop()          — onStop() unsubscribes; the subscription, not a detached aggregator, is the gate.
// Subclasses read deps via `this.pipeline` and, on each event, call `this.capture(type, ts, data)`
// (or `this.addEntry(entry)`) — the base routes the entry to the aggregator, mirroring Android's
// mDataAggregator.addEntry.
//
// Android's entry object-pool (borrow/return) is a GC optimization JS doesn't need, so it's omitted.
// `capture()` builds the default JSON entry (CaptureDataEntryBase); a provider needing a custom
// serialization passes its own CaptureDataEntry to `addEntry()`.

export abstract class CaptureProviderBase implements CaptureProvider {
  abstract readonly name: string;
  // `controllingOption` is optional on CaptureProvider; subclasses declare it when they gate on a
  // launch option (no base field, so subclasses needn't write `override`).

  #init: CaptureProviderInit | null = null;

  /** One-time: capture the pipeline dependencies (Android constructor-init); called at registration. */
  init(init: CaptureProviderInit): void {
    this.#init = init;
  }

  /** (Re)configure from launch options and start the subclass's hooks. */
  start(options: OptionsContainer): void {
    this.onStart(options);
  }

  /** Stop the subclass's hooks (it unsubscribes); deps stay wired for a later start. */
  stop(): void {
    this.onStop();
  }

  /** The capture-pipeline dependencies, available from init() onward (throws if used before init). */
  protected get pipeline(): CaptureProviderInit {
    if (this.#init === null) {
      throw new Error(`Capture provider "${this.name}" used before init()`);
    }
    return this.#init;
  }

  /** Subclasses (re)configure from `options`, subscribe to `this.pipeline.hubs`, install hooks here. */
  protected abstract onStart(options: OptionsContainer): void;

  /** Subclasses unsubscribe / release hooks here (optional). */
  protected onStop(): void {}

  /** Route a captured entry to the aggregator. */
  protected addEntry(entry: CaptureDataEntry): void {
    this.pipeline.captureAggregator.addEntry(entry);
  }

  /** Build the default JSON capture entry and route it in one call. */
  protected capture(type: FileType, timestamp: number, data: unknown): void {
    this.addEntry(new CaptureDataEntryBase(type, timestamp, data));
  }
}
