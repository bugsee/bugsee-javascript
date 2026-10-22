// launchMain -> the REAL @bugsee/node launch (real providers, real tracker, real events mux) -> a really assembled +
// uploaded bundle: `app_metrics` rides traces.system next to the node traces, `child_process_gone` lands on
// events.system, and the lazy mux attaches/releases exactly with `captureSystemEvents` / `client.stop()`.

import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import { createMemoryCaptureStore } from '@bugsee/core';
import { type NodeRuntime, realSystemProbe, resetProcessTracker } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';

const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));

function recordingTransport() {
  const puts: Uint8Array[] = [];
  const fn = vi.fn<HttpTransport>(async (url: string, options: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'access' }) };
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      };
    }
    if (url === 'https://s3.test/put') puts.push(options.body as Uint8Array);
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, puts };
}

/** A process whose listener table is observable (the node events source registers on it). */
function fakeProcess() {
  const table = new Map<string, Array<(...a: unknown[]) => void>>();
  const proc = {
    on: (e: string, l: (...a: unknown[]) => void) => {
      table.set(e, [...(table.get(e) ?? []), l]);
      return proc;
    },
    off: (e: string, l: (...a: unknown[]) => void) => {
      table.set(
        e,
        (table.get(e) ?? []).filter((x) => x !== l),
      );
      return proc;
    },
    listeners: (e: string) => [...(table.get(e) ?? [])],
    exit: () => {},
    kill: () => {},
    stderr: { write: () => true },
    pid: process.pid,
  } as unknown as NodeRuntime;
  return { proc, count: (e: string) => table.get(e)?.length ?? 0 };
}

/** Fires EVERY armed interval on `tick()` (the provider refresh and the tracker poll share it). */
function manualScheduler() {
  const armed = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (cb: () => void) => {
      const id = next++;
      armed.set(id, cb);
      return id;
    },
    clearInterval: (id: unknown) => {
      armed.delete(id as number);
    },
    tick: () => {
      for (const cb of [...armed.values()]) cb();
    },
    get armed() {
      return armed.size;
    },
  };
}

type GoneL = (event: unknown, details: unknown) => void;
function fakeApp(getAppMetrics?: () => unknown) {
  const gone: GoneL[] = [];
  const app = {
    on: vi.fn((event: string, l: GoneL) => {
      if (event === 'child-process-gone') gone.push(l);
    }),
    removeListener: vi.fn((event: string, l: GoneL) => {
      const i = gone.indexOf(l);
      if (event === 'child-process-gone' && i >= 0) gone.splice(i, 1);
    }),
    ...(getAppMetrics !== undefined ? { getAppMetrics } : {}),
  };
  return { app, gone };
}

const metric = {
  pid: 7,
  type: 'GPU',
  cpu: { percentCPUUsage: 4 },
  memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 },
};

function launchWith(
  over: {
    app?: ReturnType<typeof fakeApp>['app'];
    captureSystemEvents?: boolean;
    scheduler?: ReturnType<typeof manualScheduler>;
    carrier?: object;
    onError?: (error: unknown) => void;
    captureSystemTraces?: boolean;
    powerMonitor?: object;
    screen?: object;
    BrowserWindow?: { getAllWindows(): unknown };
  },
  fp = fakeProcess(),
) {
  const { fn: transport, puts } = recordingTransport();
  const client = launchMain('tok', {
    ipcMain: { on: () => {}, removeListener: () => {} },
    ...(over.app !== undefined ? { app: over.app } : {}),
    transport,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    captureNetwork: false,
    capturedDataStore: 'memory',
    detectHangs: false,
    process: fp.proc,
    systemProbe: realSystemProbe,
    onError: over.onError ?? vi.fn(),
    carrier: over.carrier ?? {},
    ...(over.powerMonitor !== undefined ? { powerMonitor: over.powerMonitor } : {}),
    ...(over.screen !== undefined ? { screen: over.screen } : {}),
    ...(over.BrowserWindow !== undefined ? { BrowserWindow: over.BrowserWindow } : {}),
    ...(over.captureSystemTraces !== undefined
      ? { captureSystemTraces: over.captureSystemTraces }
      : {}),
    ...(over.captureSystemEvents !== undefined
      ? { captureSystemEvents: over.captureSystemEvents }
      : {}),
    ...(over.scheduler !== undefined ? { scheduler: over.scheduler } : {}),
  });
  return { client, puts, fp };
}

const fileOf = <T>(put: Uint8Array, name: string): T[] =>
  JSON.parse(strFromU8(unzipSync(put)[name] as Uint8Array)) as T[];

afterEach(() => {
  resetProcessTracker();
});

describe('render-process-gone listener (real launch)', () => {
  it('is released on client.stop() and does not stack across a relaunch', async () => {
    const renderGone: Array<(...a: unknown[]) => void> = [];
    const { app } = fakeApp();
    const base = app.on;
    const baseRemove = app.removeListener;
    app.on = vi.fn((event: string, l: GoneL) => {
      if (event === 'render-process-gone') renderGone.push(l);
      else base(event, l);
    });
    app.removeListener = vi.fn((event: string, l: GoneL) => {
      if (event === 'render-process-gone') renderGone.splice(renderGone.indexOf(l), 1);
      else baseRemove(event, l);
    });
    const first = launchWith({ app, carrier: {} }).client;
    expect(renderGone).toHaveLength(1);
    await first.stop();
    expect(renderGone).toHaveLength(0);
    const second = launchWith({ app, carrier: {} }).client;
    expect(renderGone).toHaveLength(1);
    await second.stop();
    expect(renderGone).toHaveLength(0);
  });
});

describe('Electron main telemetry -> real node launch -> assembled report', () => {
  it('app_metrics rides traces.system NEXT TO the node traces, once, with the documented shape', async () => {
    const scheduler = manualScheduler();
    const { app } = fakeApp(() => [metric]);
    const { client, puts } = launchWith({ app, scheduler });
    scheduler.tick(); // first poll: the priming read happened at arm, so this is the first sample
    scheduler.tick();
    await client.logException(new Error('x'));
    const traces = fileOf<{ name: string; value: unknown }>(
      puts[0] as Uint8Array,
      'traces.system.json',
    );
    const names = traces.map((t) => t.name);
    expect(names).toContain('process_memory_rss'); // the node set still emits
    expect(names).toContain('app_metrics');
    const metrics = traces.find((t) => t.name === 'app_metrics');
    expect(metrics?.value).toEqual({
      processes: [
        { type: 'GPU', pid: 7, cpu_percent: 4, working_set_mb: 2, peak_working_set_mb: 4 },
      ],
    });
    await client.stop();
  });

  it('a getAppMetrics that throws: node traces still emit, no app_metrics', async () => {
    const scheduler = manualScheduler();
    const { app } = fakeApp(() => {
      throw new Error('metrics');
    });
    const { client, puts } = launchWith({ app, scheduler });
    scheduler.tick();
    await client.logException(new Error('x'));
    const names = fileOf<{ name: string }>(puts[0] as Uint8Array, 'traces.system.json').map(
      (t) => t.name,
    );
    expect(names).toContain('process_memory_rss');
    expect(names).not.toContain('app_metrics');
    await client.stop();
  });

  it('captureSystemEvents ON: node handlers AND the child-process-gone listener attach; child_process_gone lands on events.system; process_started once', async () => {
    const { app, gone } = fakeApp();
    const { client, puts, fp } = launchWith({ app });
    expect(fp.count('warning')).toBe(1); // the node source is live
    expect(gone).toHaveLength(1);
    gone[0]?.({}, { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' });
    await client.logException(new Error('x'));
    const events = fileOf<{ name: string; params?: unknown }>(
      puts[0] as Uint8Array,
      'events.system.json',
    );
    expect(events.filter((e) => e.name === 'process_started')).toHaveLength(1);
    expect(events.find((e) => e.name === 'child_process_gone')?.params).toEqual({
      type: 'GPU',
      reason: 'crashed',
      exitCode: 139,
      name: 'GPU Process',
    });
    await client.stop();
  });

  it('captureSystemEvents OFF: NO node handlers and NO child-process-gone listener', async () => {
    const { app, gone } = fakeApp();
    const { client, fp } = launchWith({ app, captureSystemEvents: false });
    expect(fp.count('warning')).toBe(0);
    expect(fp.count('beforeExit')).toBe(0);
    // launch itself keeps a SIGTERM hook for flush-on-signal; the node EVENTS source must add none on top of it
    const bare = launchWith({ captureSystemEvents: false });
    expect(fp.count('SIGTERM')).toBe(bare.fp.count('SIGTERM'));
    expect(fp.count('SIGINT')).toBe(bare.fp.count('SIGINT'));
    await bare.client.stop();
    expect(app.on).not.toHaveBeenCalledWith('child-process-gone', expect.anything());
    expect(gone).toHaveLength(0);
    await client.stop();
  });

  it("a REPEAT launchMain leaves the running launch's onError/scheduler/listener untouched", async () => {
    const carrier = {};
    const firstScheduler = manualScheduler();
    const firstOnError = vi.fn();
    let broken = false;
    const { app, gone } = fakeApp(() => {
      if (broken) throw new Error('metrics');
      return [metric];
    });
    const first = launchWith({ app, scheduler: firstScheduler, onError: firstOnError, carrier });
    const armed = firstScheduler.armed;
    const listeners = gone.length;
    const secondScheduler = manualScheduler();
    const secondOnError = vi.fn();
    const second = launchWith({ app, scheduler: secondScheduler, onError: secondOnError, carrier });
    expect(second.client).toBe(first.client);
    // the repeat touched nothing: same timers on the FIRST scheduler, none on the second, same app listener
    expect(firstScheduler.armed).toBe(armed);
    expect(secondScheduler.armed).toBe(0);
    expect(gone).toHaveLength(listeners);
    broken = true;
    firstScheduler.tick();
    expect(firstOnError).toHaveBeenCalledWith(expect.objectContaining({ message: 'metrics' }));
    expect(secondOnError).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'metrics' }));
    await first.client.stop();
  });

  it('client.stop() releases the node handlers, the child-process-gone listener and the metrics timer', async () => {
    const scheduler = manualScheduler();
    const { app, gone } = fakeApp(() => [metric]);
    const { client, fp } = launchWith({ app, scheduler });
    expect(gone).toHaveLength(1);
    expect(fp.count('warning')).toBe(1);
    const armedBefore = scheduler.armed;
    expect(armedBefore).toBeGreaterThan(0);
    await client.stop();
    expect(gone).toHaveLength(0);
    expect(app.removeListener).toHaveBeenCalledWith('child-process-gone', expect.any(Function));
    expect(fp.count('warning')).toBe(0);
    expect(scheduler.armed).toBe(0);
  });
});

// ---- TR9 part 2: power / display / application-window domain trackers -------------------------------------------

type EL = (...a: unknown[]) => void;
class Emitter {
  table = new Map<string, EL[]>();
  on = vi.fn((e: string, l: EL) => {
    this.table.set(e, [...(this.table.get(e) ?? []), l]);
  });
  removeListener = vi.fn((e: string, l: EL) => {
    this.table.set(
      e,
      (this.table.get(e) ?? []).filter((x) => x !== l),
    );
  });
  emit(e: string, ...a: unknown[]) {
    for (const l of [...(this.table.get(e) ?? [])]) l({}, ...a);
  }
  count(e: string) {
    return this.table.get(e)?.length ?? 0;
  }
  total() {
    return [...this.table.values()].reduce((n, l) => n + l.length, 0);
  }
}
class Contents extends Emitter {
  constructor(public id: number) {
    super();
  }
  isDestroyed = () => false;
}
class Win extends Emitter {
  webContents: Contents;
  constructor(public id: number) {
    super();
    this.webContents = new Contents(id + 100);
    // like Electron's BrowserWindow, re-emit the webContents' hang pair
    this.webContents.on('unresponsive', () => this.emit('unresponsive'));
  }
  isDestroyed = () => false;
}
const displayOf = (id: number) => ({
  id,
  size: { width: 1440, height: 900 },
  scaleFactor: 2,
  internal: true,
});

function domainWorld(existing: Win[] = []) {
  const powerMonitor = new Emitter();
  const displays = [displayOf(1)];
  const screen = Object.assign(new Emitter(), {
    getAllDisplays: () => [...displays],
    getPrimaryDisplay: () => displays[0],
  });
  const app = new Emitter();
  const BrowserWindow = { getAllWindows: () => existing };
  return { powerMonitor, screen, app, BrowserWindow, displays };
}
const domainListeners = (w: ReturnType<typeof domainWorld>) =>
  w.powerMonitor.total() +
  w.screen.total() +
  w.app.count('browser-window-created') +
  w.app.count('web-contents-created');

describe('Electron domain trackers -> real node launch -> assembled report', () => {
  const launchDomains = (
    w: ReturnType<typeof domainWorld>,
    over: Parameters<typeof launchWith>[0] = {},
    fp = fakeProcess(),
  ) =>
    launchWith(
      {
        app: w.app as never,
        powerMonitor: w.powerMonitor,
        screen: w.screen,
        BrowserWindow: w.BrowserWindow,
        ...over,
      },
      fp,
    );

  it('power, display and window events AND the displays trace land in the uploaded bundle', async () => {
    const early = new Win(1);
    const w = domainWorld([early]);
    const { client, puts } = launchDomains(w);
    // activity after launch: power, a display plugged in, an existing window focused, a window created LATER
    w.powerMonitor.emit('suspend');
    w.powerMonitor.emit('resume');
    w.powerMonitor.emit('on-battery');
    w.displays.push(displayOf(2));
    w.screen.emit('display-added', displayOf(2));
    early.emit('focus');
    const late = new Win(2);
    w.app.emit('browser-window-created', late);
    late.emit('blur');
    late.emit('hide');
    // the hang pair: the webContents records ONCE although the window re-emits it; the window alone records nothing
    late.webContents.emit('unresponsive');
    w.app.emit('web-contents-created', late.webContents);
    late.webContents.emit('unresponsive');
    late.emit('unresponsive');
    await client.logException(new Error('x'));
    const events = fileOf<{ name: string; params?: Record<string, unknown> }>(
      puts[0] as Uint8Array,
      'events.system.json',
    );
    const byName = (n: string) => events.filter((e) => e.name === n);
    expect(byName('process_started')).toHaveLength(1);
    expect(byName('power_suspend')).toHaveLength(1);
    expect(byName('power_resume')).toHaveLength(1);
    expect(byName('power_battery')).toHaveLength(1);
    expect(byName('display_added')[0]?.params).toEqual({
      id: 1,
      nativeId: 2,
      width: 2880,
      height: 1800,
      scale: 2,
      type: 'internal',
    });
    expect(byName('window_focus')[0]?.params).toEqual({ windowId: 1 });
    expect(byName('window_blur')[0]?.params).toEqual({ windowId: 2 });
    expect(byName('window_hide')[0]?.params).toEqual({ windowId: 2 });
    // the very first unresponsive fired before the webContents was announced (not watched yet): exactly ONE recorded
    expect(byName('renderer_unresponsive')).toEqual([
      expect.objectContaining({ params: { webContentsId: 102 } }),
    ]);
    const traces = fileOf<{ name: string; value: unknown }>(
      puts[0] as Uint8Array,
      'traces.system.json',
    ).filter((t) => t.name === 'displays');
    expect(traces.map((t) => (t.value as unknown[]).length)).toEqual([1, 2]);
    expect(traces[0]?.value).toEqual([
      { id: 0, native_id: 1, state: 'on', type: 'internal', width: 2880, height: 1800, scale: 2 },
    ]);
    await client.stop();
  });

  it('captureSystemEvents OFF: no power/window/display-event listeners (the displays TRACE keeps only its own); both off: none at all', async () => {
    const w = domainWorld([new Win(1)]);
    const { client } = launchDomains(w, { captureSystemEvents: false });
    expect(w.powerMonitor.total()).toBe(0);
    // no window/renderer EVENTS, but the displays trace follows the key window: windowFocus + windowMoved only
    expect(w.app.count('browser-window-created')).toBe(2);
    expect(w.app.count('web-contents-created')).toBe(0);
    expect(w.screen.total()).toBe(3); // the displays trace producer, not the events
    await client.stop();
    expect(w.screen.total()).toBe(0);

    const w2 = domainWorld([new Win(1)]);
    const both = launchDomains(w2, { captureSystemEvents: false, captureSystemTraces: false });
    expect(domainListeners(w2)).toBe(0);
    await both.client.stop();
  });

  it('client.stop() releases every power, display and window listener', async () => {
    const win = new Win(1);
    const w = domainWorld([win]);
    const { client } = launchDomains(w);
    expect(w.powerMonitor.total()).toBe(6);
    expect(w.screen.total()).toBe(6); // events (3) + the displays trace (3)
    expect(w.app.count('browser-window-created')).toBe(3); // focus, visibility, moved (the displays trace's key window)
    expect(w.app.count('web-contents-created')).toBe(1);
    expect(win.total()).toBe(8); // focus, blur, show, hide, moved + closed x3
    await client.stop();
    expect(domainListeners(w)).toBe(0);
    expect(win.total()).toBe(0);
    expect(win.webContents.count('responsive')).toBe(0);
    expect(win.webContents.count('destroyed')).toBe(0);
  });

  it("a REPEAT launchMain leaves the running launch's power/display/application trackers (reporter, listeners) untouched", async () => {
    const carrier = {};
    const win = new Win(1);
    const w = domainWorld([win]);
    const firstOnError = vi.fn();
    const secondOnError = vi.fn();
    const first = launchDomains(w, { carrier, onError: firstOnError });
    const attached = domainListeners(w);
    const second = launchDomains(w, { carrier, onError: secondOnError });
    expect(second.client).toBe(first.client);
    expect(domainListeners(w)).toBe(attached);
    // every removal now fails: the tracker that reports it must still be the FIRST launch's
    for (const e of [w.powerMonitor, w.screen, win]) {
      e.removeListener.mockImplementation(() => {
        throw new Error(`remove-${e === win ? 'win' : 'x'}`);
      });
    }
    await first.client.stop();
    const messages = (fn: ReturnType<typeof vi.fn>) =>
      fn.mock.calls.map((c) => (c[0] as Error).message);
    expect(messages(firstOnError)).toEqual(expect.arrayContaining(['remove-x', 'remove-win']));
    expect(messages(secondOnError).filter((m) => m.startsWith('remove-'))).toEqual([]);
  });

  const notReady = (message: string) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(message);
        },
      },
    );

  it.each([
    ['screen', 'screen not ready'],
    ['powerMonitor', 'power not ready'],
    ['BrowserWindow', 'window class not ready'],
  ] as const)('an Electron %s whose property reads THROW (not ready) turns only that domain off: reported, other domains work, and stop() leaves NOTHING attached', async (which, message) => {
    const w = domainWorld([]);
    const onError = vi.fn();
    const fp = fakeProcess();
    const hostile = notReady(message);
    const { client, puts } = launchDomains(
      { ...w, [which]: hostile } as ReturnType<typeof domainWorld>,
      { onError },
      fp,
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message }));
    // the node source is live and every healthy domain still records
    expect(fp.count('warning')).toBe(1);
    if (which !== 'powerMonitor') w.powerMonitor.emit('suspend');
    const win = new Win(3);
    w.app.emit('browser-window-created', win);
    win.emit('focus');
    await client.logException(new Error('x'));
    const names = fileOf<{ name: string }>(puts[0] as Uint8Array, 'events.system.json').map(
      (e) => e.name,
    );
    expect(names).toContain('window_focus');
    if (which !== 'powerMonitor') expect(names).toContain('power_suspend');
    await client.stop();
    expect(fp.count('warning')).toBe(0);
    expect(fp.count('beforeExit')).toBe(0);
    expect(w.app.count('child-process-gone')).toBe(0);
    expect(domainListeners(w)).toBe(0);
    expect(win.total()).toBe(0);
    if (which !== 'screen') expect(w.screen.total()).toBe(0);
    if (which !== 'powerMonitor') expect(w.powerMonitor.total()).toBe(0);
  });

  it('a throwing powerMonitor/screen/BrowserWindow never fails launch; the other domains still work', async () => {
    const w = domainWorld([]);
    const onError = vi.fn();
    const boom = () => {
      throw new Error('electron');
    };
    w.powerMonitor.on.mockImplementation(boom);
    (w.screen as { getAllDisplays: () => unknown }).getAllDisplays = boom;
    w.BrowserWindow.getAllWindows = boom;
    const { client, puts } = launchDomains(w, { onError });
    const win = new Win(5);
    w.app.emit('browser-window-created', win);
    win.emit('focus');
    await client.logException(new Error('x'));
    const names = fileOf<{ name: string }>(puts[0] as Uint8Array, 'events.system.json').map(
      (e) => e.name,
    );
    expect(names).toContain('window_focus');
    expect(names).not.toContain('power_suspend');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'electron' }));
    await client.stop();
  });
});
