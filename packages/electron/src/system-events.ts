import type { SystemEvent, SystemEventSource } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import { EventName } from '@bugsee/protocol';
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
//   display_added / display_removed   params { id, nativeId, width, height, naturalWidth?, naturalHeight?, scale?, maxFps?, rotation?, type? }
//                                     (a `displays` entry in camelCase: `id` is the display's position in the CURRENT `displays` list (0 = the key window's display; a removed display is no longer listed and takes the next number, so correlate by `nativeId`), device pixels, rotation in quarter turns)
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

/** The power tracker's `state` (suspend/resume, lock/unlock) and `source` (ac/battery) values -> the registered event. */
const POWER_EVENT = {
  suspend: EventName.POWER_SUSPEND,
  resume: EventName.POWER_RESUME,
  lock: EventName.POWER_LOCK,
  unlock: EventName.POWER_UNLOCK,
  ac: EventName.POWER_AC,
  battery: EventName.POWER_BATTERY,
} as const;

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

  #send(name: EventName, params?: Record<string, unknown>): void {
    this.emit('event', params === undefined ? { name } : { name, params });
  }

  /**
   * Subscribe once, isolated: a throwing subscription (a hostile Electron object) is reported and costs only itself.
   * `onActivate` therefore never throws, so the provider always receives its unsubscribe and `stop()` always releases
   * everything that DID attach (the inner node source's signal handlers included).
   */
  #sub(subscribe: () => () => void): void {
    try {
      this.#offs.push(subscribe());
    } catch (error) {
      reportGuarded(this.onError, error);
    }
  }

  protected onActivate(): void {
    this.#offs = [];
    // inner FIRST: its `process_started` marker precedes anything the Electron side can say
    this.#sub(() => this.inner.on('event', (event) => this.emit('event', event)));
    const { process, power, display, application } = this.trackers;
    if (process !== undefined) {
      this.#sub(() =>
        process.on('childProcessGone', (gone) =>
          this.#send(EventName.CHILD_PROCESS_GONE, { ...gone }),
        ),
      );
    }
    if (power !== undefined) {
      this.#sub(() => power.on('suspendResume', (p) => this.#send(POWER_EVENT[p.state])));
      this.#sub(() => power.on('lockScreen', (p) => this.#send(POWER_EVENT[p.state])));
      this.#sub(() => power.on('powerSource', (p) => this.#send(POWER_EVENT[p.source])));
    }
    if (display !== undefined) {
      this.#sub(() =>
        display.on('displayAdded', (d) => this.#send(EventName.DISPLAY_ADDED, { ...d })),
      );
      this.#sub(() =>
        display.on('displayRemoved', (d) => this.#send(EventName.DISPLAY_REMOVED, { ...d })),
      );
      this.#sub(() =>
        display.on('displayMetricsChanged', (m) =>
          this.#send(EventName.DISPLAY_METRICS_CHANGED, { ...m.display, changed: [...m.changed] }),
        ),
      );
    }
    if (application !== undefined) {
      this.#sub(() =>
        application.on('windowFocus', (w) =>
          this.#send(
            w.focused ? EventName.WINDOW_FOCUS : EventName.WINDOW_BLUR,
            ids(w, 'windowId'),
          ),
        ),
      );
      this.#sub(() =>
        application.on('windowVisibility', (w) =>
          this.#send(w.visible ? EventName.WINDOW_SHOW : EventName.WINDOW_HIDE, ids(w, 'windowId')),
        ),
      );
      this.#sub(() =>
        application.on('rendererResponsiveness', (r) =>
          this.#send(
            r.responsive ? EventName.RENDERER_RESPONSIVE : EventName.RENDERER_UNRESPONSIVE,
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
