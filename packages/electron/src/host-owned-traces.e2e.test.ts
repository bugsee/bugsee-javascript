// Acceptance test for host-owned trace suppression (spec platforms/javascript.md "Host-owned traces in WebViews and Electron
// renderers", C22). NOTHING here is faked on the path that matters: the REAL @bugsee/node main (launchMain), TWO REAL
// renderers (launchRenderer -> the real @bugsee/browser launch with its real trace producers, built over an injected
// window), the real preload bridge, the real handshake, and the bundle that main uploads. Only Electron itself (the IPC bus,
// webContents) and the browser's window are fakes.
//
// Renderer values are DISTINCTIVE (a heap ceiling of 987654321, a battery level of 77 %), so a trace in the uploaded
// `traces.system.json` can be attributed to the process that wrote it: main's heap is real V8 numbers, never the
// renderer's.
import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import { createMemoryCaptureStore } from '@bugsee/core';
import { createNodeSystemTraceProducers, type NodeRuntime, realSystemProbe } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';
import { launchRenderer } from './launch-renderer';
import type { IpcMainControlEventLike, IpcMainControlListener } from './main-control';
import { type BugseeElectronBridge, registerBugseePreload } from './preload-bridge';

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
    if (url === 'https://s3.test/put') {
      puts.push(options.body as Uint8Array);
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, puts };
}

const fakeProcess = (): NodeRuntime => {
  const proc = { on: () => proc, off: () => proc, exit: () => {} } as unknown as NodeRuntime;
  return proc;
};

function fakeElectronBus() {
  const mainListeners = new Map<string, IpcMainControlListener[]>();
  const ipcMain = {
    on(channel: string, listener: IpcMainControlListener): void {
      mainListeners.set(channel, [...(mainListeners.get(channel) ?? []), listener]);
    },
    removeListener(channel: string, listener: IpcMainControlListener): void {
      mainListeners.set(
        channel,
        (mainListeners.get(channel) ?? []).filter((l) => l !== listener),
      );
    },
  };
  function renderer(id: number) {
    const rendererListeners = new Map<
      string,
      Array<(event: unknown, ...args: unknown[]) => void>
    >();
    const webContents = {
      id,
      send(channel: string, raw: string): void {
        for (const l of rendererListeners.get(channel) ?? []) l({}, raw);
      },
    };
    const ipcRenderer = {
      send(channel: string, ...args: unknown[]): void {
        const event: IpcMainControlEventLike = { sender: webContents };
        for (const l of mainListeners.get(channel) ?? []) l(event, ...args);
      },
      on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
        rendererListeners.set(channel, [...(rendererListeners.get(channel) ?? []), listener]);
      },
    };
    return { webContents, ipcRenderer };
  }
  return { ipcMain, renderer };
}

/** A renderer page's window: distinctive device/heap values so its traces are recognisable in the bundle. */
function rendererWindow(batteryLevel: number) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const navigator = {
    onLine: true,
    deviceMemory: 4,
    connection: { type: 'wifi', effectiveType: '4g' },
    getBattery: () =>
      Promise.resolve({
        level: batteryLevel,
        charging: false,
        chargingTime: Number.POSITIVE_INFINITY,
        dischargingTime: Number.POSITIVE_INFINITY,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
  };
  const win = {
    navigator,
    performance: {
      now: () => 1,
      memory: {
        usedJSHeapSize: 1_234_567,
        totalJSHeapSize: 5_000_000,
        jsHeapSizeLimit: 987_654_321,
      },
    },
    screen: { width: 800, height: 600, orientation: { type: 'portrait-primary', angle: 0 } },
    devicePixelRatio: 1,
    location: { href: 'https://app.test/window' },
    addEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return win;
}

async function bootRenderer(
  bus: ReturnType<typeof fakeElectronBus>,
  id: number,
  batteryLevel: number,
  extra: Record<string, unknown> = {},
) {
  const { ipcRenderer } = bus.renderer(id);
  let bridge: BugseeElectronBridge | undefined;
  registerBugseePreload({
    contextBridge: { exposeInMainWorld: (_k, api) => (bridge = api as BugseeElectronBridge) },
    ipcRenderer,
  });
  // Each call stands for a SEPARATE renderer page: the one-instance-per-page slot is per JS realm.
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('bugsee.electron.renderer')];
  const win = rendererWindow(batteryLevel);
  // a manual scheduler: `tick()` runs the renderer's 1 s sampling AFTER the handshake, which the launch-time baseline cannot
  const ticks: Array<() => void> = [];
  const scheduler = {
    setInterval: (cb: () => void, ms: number) => {
      if (ms === 1000) ticks.push(cb);
      return ticks.length;
    },
    clearInterval: () => {},
  };
  const client = await launchRenderer('tok', {
    bridge,
    carrier: {},
    window: win as never,
    replay: false,
    captureNetwork: false,
    onError: vi.fn(),
    scheduler,
    ...extra,
  } as never);
  return {
    client,
    win,
    tick: () => {
      for (const t of ticks) t();
    },
  };
}

const tracesOf = (zip: Uint8Array) =>
  JSON.parse(strFromU8(unzipSync(zip)['traces.system.json'] as Uint8Array)) as Array<{
    name: string;
    value: unknown;
  }>;

describe('host-owned traces: Electron renderers write none of the names main owns (C22)', () => {
  it('main-owned names (ram_js_heap_*) from two renderers never reach the bundle; unlisted renderer traces still do', async () => {
    const bus = fakeElectronBus();
    const { fn: transport, puts } = recordingTransport();
    const onError = vi.fn();
    const mainClient = launchMain('tok', {
      ipcMain: bus.ipcMain,
      transport,
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      captureNetwork: false,
      capturedDataStore: 'memory',
      detectHangs: false,
      process: fakeProcess(),
      systemProbe: realSystemProbe,
      onError,
    });
    await bootRenderer(bus, 1, 0.77);
    await bootRenderer(bus, 2, 0.55);
    await mainClient.logException(new Error('report'));

    expect(puts).toHaveLength(1);
    const traces = tracesOf(puts[0] as Uint8Array);
    const heap = traces.filter((t) => t.name.startsWith('ram_js_heap_'));
    // main's own V8 heap is there (the owner writes its names) ...
    expect(heap.length).toBeGreaterThan(0);
    // ... and NONE of it came from a renderer (the distinctive renderer heap ceiling is nowhere)
    expect(heap.some((t) => t.value === 987_654_321)).toBe(false);
    expect(heap.some((t) => t.value === 1_234_567)).toBe(false);
    // a renderer NEVER writes `displays` or `capture` (spec), whatever main declares: main writes neither here (no screen, no
    // pixel video), so the session has none, rather than each window's own entry interleaving
    expect(traces.some((t) => t.name === 'capture' || t.name === 'displays')).toBe(false);
    // unlisted renderer traces still flow: each renderer's device battery and connection are in the session
    const battery = traces.filter((t) => t.name === 'battery').map((t) => t.value);
    expect(battery).toEqual(expect.arrayContaining([77, 55]));
    expect(traces.some((t) => t.name === 'connection')).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    await mainClient.stop();
  });

  it('with a screen main writes `displays` itself, so the renderers write none', async () => {
    const bus = fakeElectronBus();
    const { fn: transport, puts } = recordingTransport();
    const display = { id: 7, size: { width: 1111, height: 777 }, scaleFactor: 1, internal: true };
    const screen = {
      on: () => {},
      removeListener: () => {},
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
    };
    const mainClient = launchMain('tok', {
      ipcMain: bus.ipcMain,
      screen: screen as never,
      transport,
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      captureNetwork: false,
      capturedDataStore: 'memory',
      detectHangs: false,
      process: fakeProcess(),
      systemProbe: realSystemProbe,
      onError: vi.fn(),
    });
    await bootRenderer(bus, 1, 0.77);
    await mainClient.logException(new Error('report'));
    const displays = tracesOf(puts[0] as Uint8Array).filter((t) => t.name === 'displays');
    // only main's list (width 1111 in device pixels), never a renderer's 800x600 window entry
    expect(displays.length).toBeGreaterThan(0);
    expect(JSON.stringify(displays)).toContain('1111');
    expect(JSON.stringify(displays)).not.toContain('"width":800');
    await mainClient.stop();
  });

  const mainWith = (
    bus: ReturnType<typeof fakeElectronBus>,
    over: Record<string, unknown> = {},
  ) => {
    const { fn: transport, puts } = recordingTransport();
    const client = launchMain('tok', {
      ipcMain: bus.ipcMain,
      transport,
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      captureNetwork: false,
      capturedDataStore: 'memory',
      detectHangs: false,
      process: fakeProcess(),
      systemProbe: realSystemProbe,
      onError: vi.fn(),
      ...over,
    });
    return { client, puts };
  };

  it('a renderer that samples AFTER the handshake still cannot write displays or capture, even when main declares neither', async () => {
    const bus = fakeElectronBus();
    const { client, puts } = mainWith(bus);
    const r = await bootRenderer(bus, 1, 0.77, {
      systemMetricsSampler: () => [
        { name: 'capture', value: { state: 'active' } },
        { name: 'displays', value: [{ id: 0, width: 800, height: 600 }] },
        { name: 'battery', value: 42 },
      ],
    });
    r.tick();
    await client.logException(new Error('report'));
    const traces = tracesOf(puts[0] as Uint8Array);
    expect(traces.some((t) => t.name === 'capture' || t.name === 'displays')).toBe(false);
    expect(traces.filter((t) => t.name === 'battery').map((t) => t.value)).toContain(42); // unlisted still flows
    await client.stop();
  });

  it('the heap: with createNodeSystemTraceProducers() main still writes it and declares it, so a renderer sampling after the handshake writes none', async () => {
    const bus = fakeElectronBus();
    const { client, puts } = mainWith(bus, {
      systemTraceProducers: createNodeSystemTraceProducers(),
    });
    const r = await bootRenderer(bus, 1, 0.77);
    r.tick();
    r.tick();
    await client.logException(new Error('report'));
    const heap = tracesOf(puts[0] as Uint8Array).filter((t) => t.name === 'ram_js_heap_total');
    expect(heap.length).toBeGreaterThan(0); // main's own
    expect(heap.some((t) => t.value === 987_654_321)).toBe(false);
    await client.stop();
  });

  it.each([
    ['a custom producer set without a heap producer', { systemTraceProducers: [] }],
    ['the legacy systemMetricsSampler', { systemMetricsSampler: () => [] }],
    ['system traces off', { captureSystemTraces: false }],
  ])('with %s main writes no heap, and two renderers sampling after the handshake still write none (never two heaps in one curve)', async (_n, over) => {
    const bus = fakeElectronBus();
    const { client, puts } = mainWith(bus, over);
    const r1 = await bootRenderer(bus, 1, 0.77);
    const r2 = await bootRenderer(bus, 2, 0.55);
    r1.tick();
    r2.tick();
    await client.logException(new Error('report'));
    const heap = tracesOf(puts[0] as Uint8Array).filter((t) => t.name.startsWith('ram_js_heap_'));
    expect(heap.some((t) => t.value === 987_654_321 || t.value === 1_234_567)).toBe(false);
    await client.stop();
  });
});
