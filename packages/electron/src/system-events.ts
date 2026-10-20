import type { SystemEvent, SystemEventSource } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { ElectronProcessTracker } from '@bugsee/trackers/electron';

// Electron-main `events.system` source: a LAZY MUX over the node events source plus the ElectronProcessTracker's
// `childProcessGone` stage. A second `events.system` provider is rejected (unique provider name), so `launchMain` hands
// this to @bugsee/node's `wrapSystemEventsSource` seam and the ONE provider subscribes to the mux.
//
// LAZY. Nothing is attached when the mux is built. `onActivate` (the first subscriber, i.e. the events provider
// starting, which only happens while `captureSystemEvents` is on) subscribes to the inner node source (which is what
// installs its SIGTERM/SIGINT/`exit`/`beforeExit`/`warning` handlers and emits `process_started`) AND to the tracker's
// `childProcessGone` stage (which is what adds the `app` listener); `onDeactivate` (the last subscriber leaving, i.e.
// `client.stop()`) releases both, each in its own guard so one failing release cannot strand the other. Subscribing at
// construction would, with `captureSystemEvents:false`, still activate the node source's handlers (they suppress
// default signal termination) and keep a `child-process-gone` listener with nowhere to go, surviving `client.stop()`.
//
// The mux forwards the inner events untouched and NEVER emits `process_started` itself (the inner source already does).
// `child_process_gone` params are `{ type, reason, exitCode?, name? }` (Electron's strings verbatim; absent keys omitted).

type Events = { event: SystemEvent };

class ElectronSystemEventsSource extends InterceptorBase<Events> {
  readonly name = 'electron-system-events';
  #offInner: (() => void) | undefined;
  #offGone: (() => void) | undefined;

  constructor(
    private readonly inner: SystemEventSource,
    private readonly tracker: ElectronProcessTracker,
    private readonly onError: ((error: unknown) => void) | undefined,
  ) {
    super(onError);
  }

  protected onActivate(): void {
    // inner FIRST: its `process_started` marker precedes anything the Electron side can say
    this.#offInner = this.inner.on('event', (event) => this.emit('event', event));
    this.#offGone = this.tracker.on('childProcessGone', (gone) =>
      this.emit('event', { name: 'child_process_gone', params: { ...gone } }),
    );
  }

  protected override onDeactivate(): void {
    const offInner = this.#offInner;
    const offGone = this.#offGone;
    for (const off of [offInner, offGone]) {
      try {
        off?.();
      } catch (error) {
        this.onError?.(error);
      }
    }
  }
}

/** The mux. `inner` is the node `events.system` source handed to `wrapSystemEventsSource`. */
export function createElectronSystemEventsSource(
  inner: SystemEventSource,
  tracker: ElectronProcessTracker,
  onError?: (error: unknown) => void,
): Interceptor<Events> {
  return new ElectronSystemEventsSource(inner, tracker, onError);
}
