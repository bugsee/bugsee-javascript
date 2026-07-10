// E7 — the fake-Electron e2e. Boots the REAL @bugsee/node main (via launchMain, no launch seam) and TWO
// renderers over a fake Electron IPC bus (fake ipcMain / per-renderer ipcRenderer+webContents / preload
// contextBridge / crashReporter), drives capture from both renderers + the main, fires a report, and asserts:
//   • both renderers learn the SAME owner session via the handshake,
//   • the native crashReporter is started with that same session in `extra` (minidump↔session correlation),
//   • ONE merged bundle is uploaded containing capture from main + renderer-1 + renderer-2,
//   • stop/flush from the main propagate down to both renderers.
// Only @bugsee/browser's renderer internals are faked (we inject capture entries into the real streaming
// store); the renderer→main transport, the merge, and the bundle assembly are all REAL.
import {
  CaptureDataEntryBase,
  type CaptureDataEntry,
  CaptureStoreToken,
  createMemoryCaptureStore,
  type StoredEntry,
} from '@bugsee/core';
import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import { type NodeRuntime, realSystemProbe } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';
import { launchRenderer } from './launch-renderer';
import type { VideoCaptureSource } from './video-capture';
import type { CrashReporterStartOptions } from './crash-reporter';
import type { IpcMainControlEventLike, IpcMainControlListener } from './main-control';
import {
  type BugseeElectronBridge,
  BUGSEE_STREAM_CHANNEL,
  registerBugseePreload,
} from './preload-bridge';

const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));

/** A transport that satisfies the upload path (session → issue → signed PUT) and records the PUT bodies. */
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

/** A hermetic node process seam (no real exit/signal handlers). */
const fakeProcess = (): NodeRuntime => {
  const proc = {
    on: () => proc,
    off: () => proc,
    exit: () => {},
  } as unknown as NodeRuntime;
  return proc;
};

/** A capture entry whose serialized form matches the SDK's log shape (`logs.json` extracts `.data`). */
const logEntry = (timestamp: number, data: unknown): StoredEntry => ({
  type: 'log',
  timestamp,
  serialized: JSON.stringify({ timestamp, data }),
});

/** A fake Electron IPC bus: ipcMain + a factory for per-renderer webContents/ipcRenderer pairs. */
function fakeElectronBus() {
  const mainListeners = new Map<string, IpcMainControlListener[]>();
  const ipcMain = {
    on(channel: string, listener: IpcMainControlListener): void {
      (mainListeners.get(channel) ?? mainListeners.set(channel, []).get(channel)!).push(listener);
    },
    removeListener(channel: string, listener: IpcMainControlListener): void {
      mainListeners.set(channel, (mainListeners.get(channel) ?? []).filter((l) => l !== listener));
    },
  };

  function renderer(id: number) {
    const rendererListeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
    // The renderer's webContents — the main uses its `send` to push control DOWN.
    const webContents = {
      id,
      send(channel: string, raw: string): void {
        for (const l of rendererListeners.get(channel) ?? []) {
          l({}, raw);
        }
      },
    };
    const ipcRenderer = {
      send(channel: string, ...args: unknown[]): void {
        const event: IpcMainControlEventLike = { sender: webContents };
        for (const l of mainListeners.get(channel) ?? []) {
          l(event, ...args);
        }
      },
      on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
        (rendererListeners.get(channel) ?? rendererListeners.set(channel, []).get(channel)!).push(
          listener,
        );
      },
    };
    return { webContents, ipcRenderer };
  }

  return { ipcMain, renderer, mainListeners };
}

/** Boot a renderer through the REAL preload + launchRenderer; return the injected store + spies. */
function bootRenderer(
  bus: ReturnType<typeof fakeElectronBus>,
  id: number,
): { store: { add(e: StoredEntry): void }; sessionId: () => string | undefined; stop: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  const { ipcRenderer } = bus.renderer(id);

  // The real preload exposes the bridge; we capture what it would put on `window.__bugseeElectron`.
  let bridge: BugseeElectronBridge | undefined;
  registerBugseePreload({
    contextBridge: { exposeInMainWorld: (_k, api) => (bridge = api as BugseeElectronBridge) },
    ipcRenderer,
  });

  // Fake ONLY @bugsee/browser's internals: capture the injected streaming store; return a spy client.
  let injectedStore: { add(e: StoredEntry): void } | undefined;
  const stop = vi.fn(() => Promise.resolve(true));
  const flush = vi.fn(() => Promise.resolve(true));
  const fakeBrowserLaunch = ((_token: string, options: { captureStore: { add(e: StoredEntry): void } }) => {
    injectedStore = options.captureStore;
    return { client: { stop, flush }, internals: undefined };
  }) as never;

  let sessionId: string | undefined;
  launchRenderer('tok', {
    launch: fakeBrowserLaunch,
    bridge,
    onSessionId: (id2) => {
      sessionId = id2;
    },
  });

  return {
    store: injectedStore as { add(e: StoredEntry): void },
    sessionId: () => sessionId,
    stop,
    flush,
  };
}

describe('E7 — Electron main + 2 renderers converge into one session/bundle', () => {
  it('handshake, native-crash correlation, ONE merged bundle, and stop/flush propagation', async () => {
    const bus = fakeElectronBus();
    const { fn: transport, puts } = recordingTransport();
    const mainStore = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const crashStarts: CrashReporterStartOptions[] = [];
    const crashReporter = { start: (o: CrashReporterStartOptions) => crashStarts.push(o) };

    // A pixel-video source (fake capturer + encoder) — proves the opt-in D8 path lands a video.webm.
    const videoSource: VideoCaptureSource = {
      start: () => {},
      stop: () => {},
      snapshot: async (now: number): Promise<CaptureDataEntry[]> => [
        new CaptureDataEntryBase('video', now, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
      ],
    };

    // ── Boot the REAL main (real @bugsee/node launch), hermetic ──
    const mainClient = launchMain('tok', {
      ipcMain: bus.ipcMain,
      crashReporter,
      transport,
      captureStore: mainStore,
      captureNetwork: false,
      capturedDataStore: 'memory',
      detectHangs: false,
      process: fakeProcess(),
      systemProbe: realSystemProbe,
      onError: vi.fn(),
      video: { source: videoSource, hasPermission: () => true },
    });

    // ── Boot 2 renderers; each says hello on launch and gets the session back ──
    const r1 = bootRenderer(bus, 1);
    const r2 = bootRenderer(bus, 2);

    // The native crash reporter was started once, session-correlated.
    expect(crashStarts).toHaveLength(1);
    const session = crashStarts[0]?.extra?.session_id;
    expect(typeof session).toBe('string');
    expect(crashStarts[0]?.extra?.app_token).toBe('tok');
    expect(crashStarts[0]?.submitURL).toMatch(/\/v2\/apps\/tok\/minidumps$/);

    // Both renderers learned the SAME owner session via the handshake (== the minidump's session).
    expect(r1.sessionId()).toBe(session);
    expect(r2.sessionId()).toBe(session);

    // ── Drive capture from both renderers (streams UP over IPC) + the main's own ──
    r1.store.add(logEntry(10, { from: 'renderer-1' }));
    r2.store.add(logEntry(20, { from: 'renderer-2' }));
    mainStore.add(logEntry(30, { from: 'main' }));

    // ── Fire a report on the main → ONE merged bundle assembled + uploaded ──
    await mainClient.logException(new Error('renderer crashed'));

    expect(puts).toHaveLength(1); // exactly ONE bundle
    const files = unzipSync(puts[0] as Uint8Array);
    expect(strFromU8(files.apptoken as Uint8Array)).toBe('tok');
    const logs = JSON.parse(strFromU8(files['logs.json'] as Uint8Array));
    expect(logs).toEqual(
      expect.arrayContaining([{ from: 'renderer-1' }, { from: 'renderer-2' }, { from: 'main' }]),
    );
    // The opt-in pixel video rode the report-snapshot path into the SAME bundle (binary, via the encoder).
    expect('video.webm' in files).toBe(true);
    expect([...(files['video.webm'] as Uint8Array)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    // ── Control propagation: flush + stop from the main reach both renderers ──
    await mainClient.flush();
    expect(r1.flush).toHaveBeenCalled();
    expect(r2.flush).toHaveBeenCalled();

    await mainClient.stop();
    expect(r1.stop).toHaveBeenCalled();
    expect(r2.stop).toHaveBeenCalled();
    // The main's stream listener is gone after stop (no more renderer→main capture).
    expect(bus.mainListeners.get(BUGSEE_STREAM_CHANNEL)).toEqual([]);
  });
});
