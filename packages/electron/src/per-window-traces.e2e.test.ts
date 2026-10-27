// Acceptance test for the per-window rule (spec platforms/javascript.md "Several windows in one session", C26): one session,
// SEVERAL Electron windows, and only the KEY window writes the per-window traces (`url`, `orientation`, `app_state`, `fps`, ...).
// Before the rule every window wrote its own `url`, so the windows' addresses interleaved into main's one `traces.system`.
//
// Nothing on the path that matters is faked: the REAL @bugsee/node main (launchMain, with the real application tracker
// resolving the key window from the fake Electron `BrowserWindow`), three REAL renderers (launchRenderer -> the real
// @bugsee/browser launch and its real `url` producer over an injected window with a working `history.pushState`), the real
// preload bridge, the real handshake and key-window control messages, and the bundle main uploads. Only Electron itself
// (IPC bus, windows) and the page's window are fakes. Headless by construction: no Electron, no browser, no display.
import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import { createMemoryCaptureStore } from '@bugsee/core';
import { type NodeRuntime, realSystemProbe } from '@bugsee/node';
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

type L = (...a: unknown[]) => void;
class Emitter {
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

/** Fake Electron: the IPC bus plus the windows. Each window owns the webContents its renderer talks through. */
function fakeElectron() {
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
  const app = new Emitter();
  const windows: Window[] = [];
  let focused: Window | null = null;

  class Window extends Emitter {
    gone = false;
    visible = true;
    readonly webContents: {
      id: number;
      send(channel: string, raw: string): void;
      once(event: string, listener: () => void): void;
      isDestroyed(): boolean;
    };
    readonly rendererListeners = new Map<
      string,
      Array<(event: unknown, ...args: unknown[]) => void>
    >();
    constructor(readonly id: number) {
      super();
      this.webContents = {
        id: id + 100,
        send: (channel, raw) => {
          for (const l of this.rendererListeners.get(channel) ?? []) l({}, raw);
        },
        once: () => {},
        isDestroyed: () => this.gone,
      };
    }
    isDestroyed = () => this.gone;
    isVisible = () => this.visible;
    getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
    /** The user focuses this window (the previous one blurs first, as Electron does). */
    focus(): void {
      focused?.emit('blur');
      focused = this;
      this.emit('focus');
    }
    close(): void {
      this.gone = true;
      if (focused === this) focused = null;
      this.emit('closed');
    }
  }

  const BrowserWindow = {
    getAllWindows: () => windows.filter((w) => !w.gone),
    getFocusedWindow: () => focused,
    fromWebContents: (contents: unknown) =>
      windows.find((w) => (w.webContents as unknown) === contents) ?? null,
  };

  function openWindow() {
    const win = new Window(windows.length + 1);
    windows.push(win);
    app.emit('browser-window-created', win);
    const ipcRenderer = {
      send(channel: string, ...args: unknown[]): void {
        const event: IpcMainControlEventLike = { sender: win.webContents };
        for (const l of mainListeners.get(channel) ?? []) l(event, ...args);
      },
      on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
        win.rendererListeners.set(channel, [
          ...(win.rendererListeners.get(channel) ?? []),
          listener,
        ]);
      },
    };
    return { win, ipcRenderer };
  }
  return { ipcMain, app, BrowserWindow, openWindow };
}

/** A page's window: a working location + history.pushState, so the real `url` producer sees real navigations. */
function pageWindow(href: string) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const location = { pathname: new URL(href).pathname, href };
  const history = {
    pushState(_s: unknown, _t: string, next: string) {
      const u = new URL(next, location.href);
      location.href = u.href;
      location.pathname = u.pathname;
    },
    replaceState() {},
  };
  const win = {
    navigator: { onLine: true },
    performance: { now: () => 1 },
    screen: { width: 800, height: 600 },
    devicePixelRatio: 1,
    location,
    history,
    addEventListener(type: string, listener: (event: Event) => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return { win, navigate: (to: string) => history.pushState({}, '', to) };
}

async function bootWindow(electron: ReturnType<typeof fakeElectron>, href: string) {
  const { win, ipcRenderer } = electron.openWindow();
  let bridge: BugseeElectronBridge | undefined;
  registerBugseePreload({
    contextBridge: { exposeInMainWorld: (_k, api) => (bridge = api as BugseeElectronBridge) },
    ipcRenderer,
  });
  // Each call stands for a SEPARATE renderer page: the one-instance-per-page slot is per JS realm.
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('bugsee.electron.renderer')];
  const page = pageWindow(href);
  await launchRenderer('tok', {
    bridge,
    carrier: {},
    window: page.win as never,
    replay: false,
    captureNetwork: false,
    onError: vi.fn(),
  } as never);
  return { win, navigate: page.navigate };
}

const urlsIn = (zip: Uint8Array): string[] =>
  (
    JSON.parse(strFromU8(unzipSync(zip)['traces.system.json'] as Uint8Array)) as Array<{
      name: string;
      value: unknown;
    }>
  )
    .filter((t) => t.name === 'url')
    .map((t) => t.value as string);

function launch(electron: ReturnType<typeof fakeElectron>) {
  const { fn: transport, puts } = recordingTransport();
  const onError = vi.fn();
  const client = launchMain('tok', {
    ipcMain: electron.ipcMain,
    app: electron.app as never,
    BrowserWindow: electron.BrowserWindow,
    transport,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    captureNetwork: false,
    capturedDataStore: 'memory',
    detectHangs: false,
    process: fakeProcess(),
    systemProbe: realSystemProbe,
    onError,
  });
  return { client, puts, onError };
}

describe('per-window traces: only the key window writes them (C26)', () => {
  it('three windows write ONE interleave-free `url` curve that follows the key window', async () => {
    const electron = fakeElectron();
    const { client, puts, onError } = launch(electron);
    const w1 = await bootWindow(electron, 'https://app.test/one');
    const w2 = await bootWindow(electron, 'https://app.test/two');
    const w3 = await bootWindow(electron, 'https://app.test/three');

    // nothing focused yet: the key window is the first created, so only its address is in the session
    w2.navigate('/two/b'); // a non-key window navigates: nothing written
    w3.navigate('/three/b');
    // the user focuses window 2: its CURRENT address is re-recorded at the switch (it navigated while it was not key)
    w2.win.focus();
    w2.navigate('/two/c'); // now key: written
    w1.navigate('/one/b'); // window 1 lost the key: nothing
    // focus moves to window 3 (re-recorded), then back to window 1 (its held address, which moved while it was silent)
    w3.win.focus();
    w1.win.focus();

    await client.logException(new Error('report'));
    expect(puts).toHaveLength(1);
    expect(urlsIn(puts[0] as Uint8Array)).toEqual([
      'https://app.test/one', // window 1 is the key at start
      'https://app.test/two/b', // window 2 gains the key: its held address, as it is NOW
      'https://app.test/two/c', // and follows it while it is key
      'https://app.test/three/b', // window 3 gains the key
      'https://app.test/one/b', // window 1 gains it back
    ]);
    expect(onError).not.toHaveBeenCalled();
    await client.stop();
  });

  it('closing the key window hands the key to the next one, whose address is re-recorded', async () => {
    const electron = fakeElectron();
    const { client, puts } = launch(electron);
    const w1 = await bootWindow(electron, 'https://app.test/one');
    await bootWindow(electron, 'https://app.test/two');
    w1.win.focus();
    w1.win.close();
    await client.logException(new Error('report'));
    expect(urlsIn(puts[0] as Uint8Array)).toEqual(['https://app.test/one', 'https://app.test/two']);
    await client.stop();
  });
});
