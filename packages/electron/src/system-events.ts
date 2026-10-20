import type { SystemEvent, SystemEventSource } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type {
  ElectronApplicationTracker,
  ElectronDisplayTracker,
  ElectronPowerTracker,
  ElectronProcessTracker,
} from '@bugsee/trackers/electron';
import { reportGuarded } from '@bugsee/util';

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
// DOMAIN TRACKERS. Besides the process tracker's `childProcessGone` it forwards the stages of the Power, Display and
// Application (window) domain trackers, each of which arms its own Electron listeners only while the mux is subscribed:
//
//   power_suspend / power_resume / power_lock / power_unlock / power_ac / power_battery    (no params)
//   display_added / display_removed   params { id, width, height, scaleFactor?, rotation?, internal?, refreshRate? }
//   display_metrics_changed           params { ...display, changed: string[] }   (`changed` = Electron's changedMetrics)
//   window_focus / window_blur / window_show / window_hide      params { windowId? }
//   renderer_unresponsive / renderer_responsive                 params { webContentsId? }   (webContents ONLY: see the
//                                                               application tracker, a window re-emits the pair)
//
// Event names are snake_case like the existing `process_*`/`child_process_gone`; params stay camelCase like `exitCode`.
// A domain whose tracker is absent (no `powerMonitor`/`screen`/`app` injected) is simply off.
//
// The mux forwards the inner events untouched and NEVER emits `process_started` itself (the inner source already does).
// `child_process_gone` params are `{ type, reason, exitCode?, name? }` (Electron's strings verbatim; absent keys omitted;
// `exitCode` stays camelCase like the other multi-word event params, e.g. the browser's `previousLanguage`).

type Events = { event: SystemEvent };

class ElectronSystemEventsSource extends InterceptorBase<Events> {
  readonly name = 'electron-system-events';
  #offs: Array<() => void> = [];

  constructor(
    private readonly inner: SystemEventSource,
    private readonly trackers: ElectronEventTrackers,
    private readonly onError: ((error: unknown) => void) | undefined,
  ) {
    super(onError);
  }

  #send(name: string, params?: Record<string, unknown>): void {
    this.emit('event', params === undefined ? { name } : { name, params });
  }

  protected onActivate(): void {
    // inner FIRST: its `process_started` marker precedes anything the Electron side can say
    this.#offs = [this.inner.on('event', (event) => this.emit('event', event))];
    const { process, power, display, application } = this.trackers;
    if (process !== undefined) {
      this.#offs.push(
        process.on('childProcessGone', (gone) => this.#send('child_process_gone', { ...gone })),
      );
    }
    if (power !== undefined) {
      this.#offs.push(
        power.on('suspendResume', (p) => this.#send(`power_${p.state}`)),
        power.on('lockScreen', (p) => this.#send(`power_${p.state}`)),
        power.on('powerSource', (p) => this.#send(`power_${p.source}`)),
      );
    }
    if (display !== undefined) {
      this.#offs.push(
        display.on('displayAdded', (d) => this.#send('display_added', { ...d })),
        display.on('displayRemoved', (d) => this.#send('display_removed', { ...d })),
        display.on('displayMetricsChanged', (m) =>
          this.#send('display_metrics_changed', { ...m.display, changed: [...m.changed] }),
        ),
      );
    }
    if (application !== undefined) {
      this.#offs.push(
        application.on('windowFocus', (w) =>
          this.#send(w.focused ? 'window_focus' : 'window_blur', ids(w, 'windowId')),
        ),
        application.on('windowVisibility', (w) =>
          this.#send(w.visible ? 'window_show' : 'window_hide', ids(w, 'windowId')),
        ),
        application.on('rendererResponsiveness', (r) =>
          this.#send(
            r.responsive ? 'renderer_responsive' : 'renderer_unresponsive',
            ids(r, 'webContentsId'),
          ),
        ),
      );
    }
  }

  protected override onDeactivate(): void {
    const offs = this.#offs;
    this.#offs = [];
    for (const off of offs) {
      try {
        off();
      } catch (error) {
        reportGuarded(this.onError, error); // a throwing reporter must not skip the other releases
      }
    }
  }
}

/** The id param only when the tracker had one (`{}` otherwise: never a made-up id). */
const ids = (
  source: { windowId?: number; webContentsId?: number },
  key: 'windowId' | 'webContentsId',
): Record<string, unknown> | undefined =>
  source[key] === undefined ? undefined : { [key]: source[key] };

/** The domain trackers the mux forwards; a domain whose tracker is absent is off. */
export interface ElectronEventTrackers {
  process?: ElectronProcessTracker;
  power?: ElectronPowerTracker;
  display?: ElectronDisplayTracker;
  application?: ElectronApplicationTracker;
}

/** The mux. `inner` is the node `events.system` source handed to `wrapSystemEventsSource`. */
export function createElectronSystemEventsSource(
  inner: SystemEventSource,
  trackers: ElectronEventTrackers,
  onError?: (error: unknown) => void,
): Interceptor<Events> {
  return new ElectronSystemEventsSource(inner, trackers, onError);
}
