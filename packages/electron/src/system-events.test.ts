import type { SystemEvent } from '@bugsee/capture';
import { type EventSubscribable, InterceptorBase } from '@bugsee/core';
import { createNodeSystemEventsSource } from '@bugsee/node';
import {
  ElectronApplicationTracker,
  ElectronDisplayTracker,
  ElectronPowerTracker,
  ElectronProcessTracker,
} from '@bugsee/trackers/electron';
import { describe, expect, it, vi } from 'vitest';
import { createElectronSystemEventsSource } from './system-events';

type Events = { event: SystemEvent };

/** Stands in for the node events source: emits process_started on activation, tracks active/idle. */
class FakeInner extends InterceptorBase<Events> {
  readonly name = 'fake-inner';
  activations = 0;
  deactivations = 0;
  protected onActivate(): void {
    this.activations++;
    this.emit('event', { name: 'process_started' });
  }
  protected override onDeactivate(): void {
    this.deactivations++;
  }
  fire(event: SystemEvent): void {
    this.emit('event', event);
  }
}

function setup() {
  const listeners: Array<(event: unknown, details: unknown) => void> = [];
  const app = {
    on: vi.fn((_e: string, l: (event: unknown, details: unknown) => void) => {
      listeners.push(l);
    }),
    removeListener: vi.fn((_e: string, l: (event: unknown, details: unknown) => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    }),
  };
  const onError = vi.fn();
  const tracker = new ElectronProcessTracker({ app }, onError);
  const inner = new FakeInner();
  const mux = createElectronSystemEventsSource(inner, { process: tracker }, onError);
  return { app, listeners, tracker, inner, mux, onError };
}

const names = (seen: ReturnType<typeof vi.fn>) =>
  seen.mock.calls.map((c) => (c[0] as SystemEvent).name);

describe('createElectronSystemEventsSource (lazy mux)', () => {
  it('attaches NOTHING at construction: no inner subscription, no app listener', () => {
    const { app, inner, mux, tracker } = setup();
    expect(inner.activations).toBe(0);
    expect(app.on).not.toHaveBeenCalled();
    expect(mux).toBeDefined();
    tracker.reset();
  });

  it('on subscribe: attaches the inner source AND child-process-gone; process_started arrives exactly once', () => {
    const { app, inner, mux, listeners, tracker } = setup();
    const seen = vi.fn();
    mux.on('event', seen);
    expect(inner.activations).toBe(1);
    expect(app.on).toHaveBeenCalledExactlyOnceWith('child-process-gone', expect.any(Function));
    expect(names(seen)).toEqual(['process_started']);
    inner.fire({ name: 'process_exiting', params: { code: 0 } });
    expect(names(seen)).toEqual(['process_started', 'process_exiting']);
    expect(listeners).toHaveLength(1);
    tracker.reset();
  });

  it('forwards the inner events untouched, params included', () => {
    const { inner, mux, tracker } = setup();
    const seen = vi.fn();
    mux.on('event', seen);
    inner.fire({ name: 'process_signal', params: { signal: 'SIGTERM' } });
    expect(seen).toHaveBeenLastCalledWith({
      name: 'process_signal',
      params: { signal: 'SIGTERM' },
    });
    tracker.reset();
  });

  it('records child_process_gone with {type, reason, exitCode?, name?} and no undefined keys', () => {
    const { mux, listeners, tracker } = setup();
    const seen = vi.fn();
    mux.on('event', seen);
    listeners[0]?.({}, { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' });
    listeners[0]?.({}, { type: 'Utility', reason: 'oom' });
    listeners[0]?.(
      {},
      { type: 'Utility', reason: 'killed', serviceName: 'network.mojom.NetworkService' },
    );
    expect(seen.mock.calls.slice(1, 3).map((c) => c[0])).toEqual([
      {
        name: 'child_process_gone',
        params: { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' },
      },
      { name: 'child_process_gone', params: { type: 'Utility', reason: 'oom' } },
    ]);
    expect(seen.mock.calls[3]?.[0]).toEqual({
      name: 'child_process_gone',
      params: { type: 'Utility', reason: 'killed', serviceName: 'network.mojom.NetworkService' },
    });
    expect(Object.keys((seen.mock.calls[2]?.[0] as SystemEvent).params ?? {})).toEqual([
      'type',
      'reason',
    ]);
    tracker.reset();
  });

  it('the last unsubscribe releases BOTH: inner deactivated, the very same app listener removed', () => {
    const { app, inner, mux, listeners, tracker } = setup();
    const off1 = mux.on('event', vi.fn());
    const off2 = mux.on('event', vi.fn());
    expect(inner.activations).toBe(1); // one attach however many subscribers
    off1();
    expect(inner.deactivations).toBe(0);
    expect(listeners).toHaveLength(1);
    off2();
    expect(inner.deactivations).toBe(1);
    expect(listeners).toHaveLength(0);
    expect(app.removeListener).toHaveBeenCalledExactlyOnceWith(
      'child-process-gone',
      app.on.mock.calls[0]?.[1],
    );
    tracker.reset();
  });

  it('re-subscribing after release attaches again (and process_started fires again with the inner source)', () => {
    const { app, inner, mux, tracker } = setup();
    mux.on('event', vi.fn())();
    const seen = vi.fn();
    mux.on('event', seen);
    expect(inner.activations).toBe(2);
    expect(app.on).toHaveBeenCalledTimes(2);
    expect(names(seen)).toEqual(['process_started']);
    tracker.reset();
  });

  it('a failing release of one side cannot strand the other (reported)', () => {
    const { app, inner, mux, listeners, onError, tracker } = setup();
    const off = mux.on('event', vi.fn());
    const boom = new Error('inner off');
    const innerOff = vi.spyOn(inner, 'off').mockImplementation(() => {
      throw boom;
    });
    off();
    expect(innerOff).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(listeners).toHaveLength(0);
    expect(app.removeListener).toHaveBeenCalledTimes(1);
    tracker.reset();
  });

  it('a throwing inner release AND a throwing reporter still release child-process-gone (and an async reporter is silent)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const sink of [
        () => {
          throw new Error('sink');
        },
        async () => {
          throw new Error('async sink');
        },
      ]) {
        const listeners: Array<(event: unknown, details: unknown) => void> = [];
        const app = {
          on: (_e: string, l: (event: unknown, details: unknown) => void) => {
            listeners.push(l);
          },
          removeListener: vi.fn(() => {
            listeners.length = 0;
          }),
        };
        const tracker = new ElectronProcessTracker({ app }, () => {});
        const inner = new FakeInner();
        const mux = createElectronSystemEventsSource(inner, { process: tracker }, sink);
        const off = mux.on('event', vi.fn());
        vi.spyOn(inner, 'off').mockImplementation(() => {
          throw new Error('inner off');
        });
        expect(() => off()).not.toThrow();
        expect(app.removeListener).toHaveBeenCalledTimes(1);
        expect(listeners).toHaveLength(0);
        tracker.reset();
      }
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a throwing subscriber cannot break the other side (isolated + reported)', () => {
    const { mux, listeners, onError, tracker } = setup();
    const ok = vi.fn();
    const boom = new Error('subscriber');
    mux.on('event', () => {
      throw boom;
    });
    mux.on('event', ok);
    listeners[0]?.({}, { type: 'GPU', reason: 'killed' });
    expect(names(ok)).toContain('child_process_gone');
    expect(onError).toHaveBeenCalledWith(boom);
    tracker.reset();
  });

  it('exposes the standard subscribable surface', () => {
    const { mux, tracker } = setup();
    const sub: EventSubscribable<Events> = mux;
    expect(typeof sub.on).toBe('function');
    tracker.reset();
  });
});

// ---- domain trackers (power / display / application windows) -------------------------------------------------

type L = (...a: unknown[]) => void;
class FakeEmitter {
  table = new Map<string, L[]>();
  on = vi.fn((e: string, l: L) => {
    this.table.set(e, [...(this.table.get(e) ?? []), l]);
  });
  removeListener = vi.fn((e: string, l: L) => {
    this.table.set(
      e,
      (this.table.get(e) ?? []).filter((x) => x !== l),
    );
  });
  emit(e: string, ...a: unknown[]) {
    for (const l of [...(this.table.get(e) ?? [])]) l({}, ...a);
  }
  total() {
    return [...this.table.values()].reduce((n, l) => n + l.length, 0);
  }
}
class FakeWebContents extends FakeEmitter {
  constructor(public id: number) {
    super();
  }
  isDestroyed = () => false;
}
class FakeWindow extends FakeEmitter {
  webContents: FakeWebContents;
  constructor(public id: number) {
    super();
    this.webContents = new FakeWebContents(id + 100);
    // Electron's BrowserWindow RE-EMITS its webContents' hang pair: recording both would double every hang
    this.webContents.on('unresponsive', () => this.emit('unresponsive'));
    this.webContents.on('responsive', () => this.emit('responsive'));
  }
  isDestroyed = () => false;
}
const display = (id: number) => ({ id, size: { width: 800, height: 600 }, scaleFactor: 2 });

function domains(existing: FakeWindow[] = []) {
  const powerMonitor = new FakeEmitter();
  const screen = Object.assign(new FakeEmitter(), { getAllDisplays: () => [display(1)] });
  const app = new FakeEmitter();
  const BrowserWindow = { getAllWindows: () => existing };
  const onError = vi.fn();
  const power = new ElectronPowerTracker({ powerMonitor }, onError);
  const disp = new ElectronDisplayTracker({ screen }, onError);
  const application = new ElectronApplicationTracker({ app, BrowserWindow }, onError);
  const inner = new FakeInner();
  const mux = createElectronSystemEventsSource(
    inner,
    { power, display: disp, application },
    onError,
  );
  const seen = vi.fn();
  return {
    powerMonitor,
    screen,
    app,
    inner,
    mux,
    seen,
    onError,
    subscribe: () => mux.on('event', seen),
    events: () => seen.mock.calls.map((c) => c[0] as SystemEvent),
    total: () => powerMonitor.total() + screen.total() + app.total(),
  };
}

describe('createElectronSystemEventsSource: domain trackers', () => {
  it('attaches NOTHING at construction, everything on the first subscriber, nothing after the last leaves', () => {
    const d = domains([new FakeWindow(1)]);
    expect(d.total()).toBe(0);
    const off = d.subscribe();
    expect(d.powerMonitor.total()).toBe(6);
    expect(d.screen.total()).toBe(3);
    expect(d.app.total()).toBe(3); // browser-window-created x2 (focus, visibility) + web-contents-created
    off();
    expect(d.total()).toBe(0);
    expect(d.inner.deactivations).toBe(1);
  });

  it('records the six power events with no params', () => {
    const d = domains();
    d.subscribe();
    for (const e of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery']) {
      d.powerMonitor.emit(e);
    }
    expect(d.events().slice(1)).toEqual([
      { name: 'power_suspend' },
      { name: 'power_resume' },
      { name: 'power_lock' },
      { name: 'power_unlock' },
      { name: 'power_ac' },
      { name: 'power_battery' },
    ]);
  });

  it('records display_added / display_removed / display_metrics_changed with the mapped display', () => {
    const d = domains();
    d.subscribe();
    d.screen.emit('display-added', display(2));
    d.screen.emit('display-removed', display(3));
    d.screen.emit('display-metrics-changed', display(4), ['bounds']);
    expect(d.events().slice(1)).toEqual([
      // ids are the position in the CURRENT list (only display 1 is listed; an unlisted display takes the next number),
      // device pixels, camelCase
      {
        name: 'display_added',
        params: { id: 1, nativeId: 2, width: 1600, height: 1200, scale: 2 },
      },
      {
        name: 'display_removed',
        params: { id: 1, nativeId: 3, width: 1600, height: 1200, scale: 2 },
      },
      {
        name: 'display_metrics_changed',
        params: { id: 1, nativeId: 4, width: 1600, height: 1200, scale: 2, changed: ['bounds'] },
      },
    ]);
  });

  it('display events carry the full mobile key set in camelCase: maxFps rounded, rotation in quarter turns, type, natural size (real Electron: 59.996700286865234)', () => {
    const d = domains();
    d.subscribe();
    d.screen.emit('display-added', {
      ...display(2),
      displayFrequency: 59.996700286865234,
      rotation: 90,
      internal: false,
    });
    expect(d.events()[1]).toEqual({
      name: 'display_added',
      params: {
        id: 1,
        nativeId: 2,
        width: 1600,
        height: 1200,
        naturalWidth: 1200,
        naturalHeight: 1600,
        scale: 2,
        maxFps: 60,
        rotation: 1,
        type: 'external',
      },
    });
    expect(Object.keys((d.events()[1] as { params: object }).params)).not.toContain('state');
  });

  it('a window created AFTER the mux attached still records focus; existing windows too; ids included', () => {
    const early = new FakeWindow(1);
    const d = domains([early]);
    d.subscribe();
    early.emit('focus');
    const late = new FakeWindow(2);
    d.app.emit('browser-window-created', late);
    late.emit('focus');
    late.emit('blur');
    late.emit('hide');
    late.emit('show');
    expect(d.events().slice(1)).toEqual([
      { name: 'window_focus', params: { windowId: 1 } },
      { name: 'window_focus', params: { windowId: 2 } },
      { name: 'window_blur', params: { windowId: 2 } },
      { name: 'window_hide', params: { windowId: 2 } },
      { name: 'window_show', params: { windowId: 2 } },
    ]);
  });

  it('webContents.emit("unresponsive") records ONCE although the window re-emits it; win.emit alone records nothing', () => {
    const win = new FakeWindow(1);
    const d = domains([win]);
    d.subscribe();
    win.emit('unresponsive');
    win.emit('responsive');
    expect(d.events()).toHaveLength(1); // only process_started
    win.webContents.emit('unresponsive');
    win.webContents.emit('responsive');
    expect(d.events().slice(1)).toEqual([
      { name: 'renderer_unresponsive', params: { webContentsId: 101 } },
      { name: 'renderer_responsive', params: { webContentsId: 101 } },
    ]);
  });

  it('a web contents without a window (BrowserView) created later is recorded', () => {
    const d = domains();
    d.subscribe();
    const view = new FakeWebContents(9);
    d.app.emit('web-contents-created', view);
    view.emit('unresponsive');
    expect(d.events().slice(1)).toEqual([
      { name: 'renderer_unresponsive', params: { webContentsId: 9 } },
    ]);
  });

  it('omits the id param when the object has none (never a made-up id)', () => {
    const d = domains();
    d.subscribe();
    const noId = new FakeWindow(1);
    (noId as { id: unknown }).id = undefined;
    (noId.webContents as { id: unknown }).id = undefined;
    d.app.emit('browser-window-created', noId);
    d.app.emit('web-contents-created', noId.webContents);
    noId.emit('focus');
    noId.webContents.emit('unresponsive');
    expect(d.events().slice(1)).toEqual([
      { name: 'window_focus' },
      { name: 'renderer_unresponsive' },
    ]);
  });

  it('release removes the listeners from existing and late windows and webContents too', () => {
    const early = new FakeWindow(1);
    const d = domains([early]);
    const off = d.subscribe();
    const late = new FakeWindow(2);
    d.app.emit('browser-window-created', late);
    d.app.emit('web-contents-created', late.webContents);
    off();
    expect(early.total()).toBe(0);
    expect(late.total()).toBe(0);
    expect(d.app.total()).toBe(0);
    // only the test fake's own re-emit hook is left on the webContents
    expect(early.webContents.total()).toBe(2);
    d.app.emit('browser-window-created', new FakeWindow(3));
    early.emit('focus');
    expect(d.events()).toHaveLength(1);
  });

  it('with no domain trackers (only the process one or none) the mux attaches only the inner source', () => {
    const inner = new FakeInner();
    const mux = createElectronSystemEventsSource(inner, {});
    const seen = vi.fn();
    mux.on('event', seen)();
    expect(names(seen)).toEqual(['process_started']);
    expect(inner.deactivations).toBe(1);
  });
});

describe('conformance: every emitted event param key is camelCase', () => {
  // Keys are DERIVED from the events the real mux emits for every Electron signal (never a hand-copied list). Event params
  // are camelCase with no exception; trace-value keys are the snake_case ones.
  const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

  it('child_process_gone, display_*, window_* and renderer_* events carry only camelCase keys', () => {
    const win = new FakeWindow(1);
    const powerMonitor = new FakeEmitter();
    const screen = Object.assign(new FakeEmitter(), { getAllDisplays: () => [display(1)] });
    const app = new FakeEmitter();
    const onError = vi.fn();
    const mux = createElectronSystemEventsSource(
      new FakeInner(),
      {
        process: new ElectronProcessTracker({ app }, onError),
        power: new ElectronPowerTracker({ powerMonitor }, onError),
        display: new ElectronDisplayTracker({ screen }, onError),
        application: new ElectronApplicationTracker(
          { app, BrowserWindow: { getAllWindows: () => [win] } },
          onError,
        ),
      },
      onError,
    );
    const seen = vi.fn();
    mux.on('event', seen);
    app.emit('child-process-gone', {
      type: 'Utility',
      reason: 'crashed',
      exitCode: 1,
      name: 'Network Service',
      serviceName: 'network.mojom.NetworkService',
    });
    for (const e of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery']) {
      powerMonitor.emit(e);
    }
    screen.emit('display-added', {
      ...display(2),
      displayFrequency: 60,
      rotation: 90,
      internal: true,
    });
    screen.emit('display-removed', display(3));
    screen.emit('display-metrics-changed', display(4), ['bounds', 'scaleFactor']);
    for (const e of ['focus', 'blur', 'hide', 'show']) win.emit(e);
    win.webContents.emit('unresponsive');
    win.webContents.emit('responsive');

    const events = seen.mock.calls.map((c) => c[0] as SystemEvent);
    const keys = new Set(events.flatMap((e) => Object.keys(e.params ?? {})));
    expect(events.map((e) => e.name)).toEqual(
      expect.arrayContaining(['child_process_gone', 'display_metrics_changed', 'window_focus']),
    );
    // the EXACT key surface (a dropped key must fail, not just a renamed one)
    expect([...keys].sort()).toEqual([
      'changed',
      'exitCode',
      'height',
      'id',
      'maxFps',
      'name',
      'nativeId',
      'naturalHeight',
      'naturalWidth',
      'reason',
      'rotation',
      'scale',
      'serviceName',
      'type',
      'webContentsId',
      'width',
      'windowId',
    ]);
    expect([...keys].filter((k) => !CAMEL.test(k))).toEqual([]);
  });
});

describe('createElectronSystemEventsSource: a throwing domain subscription', () => {
  it('is reported, does not abort the other domains, and stop() still releases the inner source and the rest', () => {
    const powerMonitor = new FakeEmitter();
    const app = new FakeEmitter();
    const onError = vi.fn();
    const power = new ElectronPowerTracker({ powerMonitor }, onError);
    const application = new ElectronApplicationTracker({ app }, onError);
    const display = {
      on: () => {
        throw new Error('display subscribe');
      },
    } as unknown as ElectronDisplayTracker;
    const inner = new FakeInner();
    const mux = createElectronSystemEventsSource(inner, { power, display, application }, onError);
    const seen = vi.fn();
    let off: () => void = () => {};
    expect(() => {
      off = mux.on('event', seen);
    }).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'display subscribe' }));
    // the domains AFTER the throwing one still work
    app.emit(
      'browser-window-created',
      Object.assign(new FakeEmitter(), { id: 1, isDestroyed: () => false }),
    );
    powerMonitor.emit('suspend');
    expect(names(seen)).toEqual(['process_started', 'power_suspend']);
    off();
    expect(inner.deactivations).toBe(1);
    expect(powerMonitor.total()).toBe(0);
    expect(app.total()).toBe(0);
  });

  it('a throwing inner subscription is reported and the Electron domains still attach', () => {
    const powerMonitor = new FakeEmitter();
    const onError = vi.fn();
    const power = new ElectronPowerTracker({ powerMonitor }, onError);
    const inner = {
      on: () => {
        throw new Error('inner');
      },
    } as unknown as FakeInner;
    const mux = createElectronSystemEventsSource(inner, { power }, onError);
    const seen = vi.fn();
    expect(() => mux.on('event', seen)).not.toThrow();
    powerMonitor.emit('on-ac');
    expect(names(seen)).toEqual(['power_ac']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'inner' }));
  });
});

describe('the node `gc` event through the mux (C15)', () => {
  it('passes through exactly once, untouched; the mux adds no second GC subscription; release is complete', () => {
    const gcListeners: Array<(g: { count: number; pauseMs: number; maxPauseMs: number }) => void> =
      [];
    const processTracker = {
      on: (_stage: 'gc', l: (typeof gcListeners)[number]) => {
        gcListeners.push(l);
        return () => void gcListeners.splice(gcListeners.indexOf(l), 1);
      },
    };
    const proc = { on: () => undefined, off: () => undefined, listeners: () => [] };
    const inner = createNodeSystemEventsSource(proc as never, {
      processTracker: processTracker as never,
    });
    const mux = createElectronSystemEventsSource(inner, {});
    expect(gcListeners).toHaveLength(0); // lazy
    const seen = vi.fn();
    const off = mux.on('event', seen);
    expect(gcListeners).toHaveLength(1); // ONE gc subscription: the node source's, none added by the mux
    for (const l of gcListeners) l({ count: 2, pauseMs: 7.5, maxPauseMs: 5 });
    expect(seen.mock.calls.filter((c) => (c[0] as SystemEvent).name === 'gc')).toEqual([
      [{ name: 'gc', params: { count: 2, pauseMs: 7.5, maxPauseMs: 5 } }],
    ]);
    off();
    expect(gcListeners).toHaveLength(0);
  });
});
