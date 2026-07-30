import { CaptureDataEntryBase, CaptureStoreToken } from '@bugsee/core';
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';
import type { IpcMainEventLike, IpcMainListener } from './main-receiver';
import { encodePixelVideo } from './pixel-video-controller';
import {
  BUGSEE_CONTROL_CHANNEL,
  BUGSEE_HELLO_CHANNEL,
  BUGSEE_STREAM_CHANNEL,
} from './preload-bridge';
import { decodeControl, encodeHello, encodeStreamEntry } from './protocol';
import type { VideoCaptureSource } from './video-capture';

function fakeIpcMain() {
  const listeners = new Map<string, IpcMainListener>();
  return {
    ipcMain: {
      on: vi.fn((c: string, l: IpcMainListener) => listeners.set(c, l)),
      removeListener: vi.fn((c: string) => listeners.delete(c)),
    },
    emit: (c: string, e: IpcMainEventLike, raw: unknown) => listeners.get(c)?.(e, raw),
    has: (c: string) => listeners.has(c),
  };
}

/** A fake renderer webContents sender that records the control it receives DOWN. */
function fakeSender(id = 1) {
  const sent: Array<{ channel: string; raw: string }> = [];
  return { id, send: vi.fn((channel: string, raw: string) => sent.push({ channel, raw })), sent };
}

/** A fake node launch: a client that resolves a recording store from getService + stop/flush spies. */
function fakeLaunch(options: { internals?: boolean } = {}) {
  const added: unknown[] = [];
  const stop = vi.fn(() => Promise.resolve(true));
  const flush = vi.fn(() => Promise.resolve(true));
  const store = { add: (e: unknown) => added.push(e) };
  const client = {
    getService: vi.fn((token: unknown) => (token === CaptureStoreToken ? store : undefined)),
    // The real client has this (client.ts:493); the fake lacked it, which is why wiring R3's detection
    // provider surfaced here rather than in production.
    addDetectionProvider: vi.fn(),
    stop,
    flush,
  } as unknown as Bugsee;
  const internals =
    options.internals === false
      ? undefined
      : { baseUrl: 'https://api.test', api: { sessionId: 'sess-xyz' } };
  let received: { appToken: string; options: BugseeLaunchOptions } | undefined;
  const launch = vi.fn((appToken: string, launchOptions: BugseeLaunchOptions) => {
    received = { appToken, options: launchOptions };
    return { client, internals };
  });
  return {
    launch: launch as never,
    client,
    stop,
    flush,
    added,
    get received() {
      return received;
    },
  };
}

describe('launchMain', () => {
  it('runs node launch (options minus ipcMain/launch) and starts the receiver on the stream channel', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      appVersion: '1.2.3',
    });

    expect(client).toBe(f.client);
    expect(f.received?.appToken).toBe('tok');
    expect(f.received?.options.appVersion).toBe('1.2.3');
    expect('ipcMain' in (f.received?.options ?? {})).toBe(false);
    expect('launch' in (f.received?.options ?? {})).toBe(false);
    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(true);
  });

  it("merges a renderer's streamed entry into the main store (resolved via getService)", () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });

    const wire = encodeStreamEntry({
      type: 'log' as never,
      seq: 1,
      timestamp: 9,
      mono: 0,
      timeOrigin: 0,
      redacted: false,
      payload: '{"m":1}',
    });
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, wire);

    expect(f.added).toEqual([{ type: 'log', timestamp: 9, serialized: '{"m":1}' }]);
  });

  it('stopping the client removes the IPC listeners, broadcasts stop, AND calls node stop', async () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const client = launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    // A renderer registers via hello so the stop broadcast has a target.
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    r.sent.length = 0;

    await client.stop();

    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(false); // receiver stopped
    expect(ipc.has(BUGSEE_HELLO_CHANNEL)).toBe(false); // control listener removed
    expect(r.sent.map((m) => decodeControl(m.raw)?.command)).toEqual(['stop']); // renderer told to stop
    expect(f.stop).toHaveBeenCalledTimes(1); // original node stop still runs
  });

  it('replies to a renderer hello with the owner session id (the handshake)', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    expect(r.sent[0]?.channel).toBe(BUGSEE_CONTROL_CHANNEL);
    expect(decodeControl((r.sent[0] as { raw: string }).raw)).toEqual({
      command: 'session',
      sessionId: 'sess-xyz',
    });
  });

  it('flushing the client broadcasts flush to renderers AND calls node flush', async () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const client = launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    r.sent.length = 0;

    await client.flush();

    expect(r.sent.map((m) => decodeControl(m.raw)?.command)).toEqual(['flush']);
    expect(f.flush).toHaveBeenCalledTimes(1);
  });

  it('starts Electron crashReporter in harvest mode (uploadToServer:false, session-correlated)', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const crashReporter = { start: vi.fn() };
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, crashReporter });
    expect(crashReporter.start).toHaveBeenCalledTimes(1);
    expect(crashReporter.start.mock.calls[0]?.[0]).toMatchObject({
      uploadToServer: false, // Bugsee harvests + bundles the dump; no direct Crashpad upload
      extra: { session_id: 'sess-xyz', app_token: 'tok' },
    });
  });

  it('forwards crashReporterExtra under the session correlation', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const crashReporter = { start: vi.fn() };
    launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      crashReporter,
      crashReporterExtra: { app_version: '2.0' },
    });
    expect(crashReporter.start.mock.calls[0]?.[0]?.extra).toEqual({
      app_version: '2.0',
      session_id: 'sess-xyz',
      app_token: 'tok',
    });
  });

  it('wires nativeCrash (source + Crashpad dump dir) into the node launch when a crashReporter is given', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const crashReporter = {
      start: vi.fn(),
      getCrashesDirectory: vi.fn(() => '/tmp/Crashpad'),
    };
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, crashReporter });

    const opts = f.received?.options as BugseeLaunchOptions;
    expect(opts.nativeCrash?.dumpDir).toBe('/tmp/Crashpad');
    expect(typeof opts.nativeCrash?.source.harvest).toBe('function');
    expect(typeof opts.nativeCrash?.source.claim).toBe('function');
  });

  it('omits nativeCrash when the crashReporter exposes no crash-dumps directory', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const crashReporter = { start: vi.fn() }; // no getCrashesDirectory
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, crashReporter });
    expect((f.received?.options as BugseeLaunchOptions).nativeCrash).toBeUndefined();
  });

  it('does NOT start a crashReporter when none is provided', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    // (nothing to assert beyond no throw; covered by the absence of a crashReporter)
    expect(f.received?.appToken).toBe('tok');
  });

  it('skips the crashReporter on a repeat launch (internals undefined — installed once)', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch({ internals: false });
    const crashReporter = { start: vi.fn() };
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, crashReporter });
    expect(crashReporter.start).not.toHaveBeenCalled();
  });

  it('wires opt-in pixel video: starts the source + forwards its snapshot & encoder to node launch', async () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const source: VideoCaptureSource & { started: boolean; stopped: boolean } = {
      started: false,
      stopped: false,
      start() {
        source.started = true;
      },
      stop() {
        source.stopped = true;
      },
      snapshot: vi.fn(async (now: number) => [
        new CaptureDataEntryBase('video', now, new Uint8Array([1])),
      ]),
    };
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      video: { source, hasPermission: () => true },
    });
    await Promise.resolve(); // let the async permission check + start() settle
    expect(source.started).toBe(true);

    // The controller's snapshot is forwarded as a report snapshot source, and the video encoder is wired.
    const opts = f.received?.options as BugseeLaunchOptions;
    expect(opts.reportSnapshots).toHaveLength(1);
    expect(await opts.reportSnapshots?.[0]?.(5)).toHaveLength(1); // pulls the source (active)
    expect(opts.fileEncoders?.video).toBe(encodePixelVideo);
    expect('video' in (f.received?.options ?? {})).toBe(false); // stripped before node launch

    await client.stop();
    expect(source.stopped).toBe(true); // client.stop stops pixel capture
  });

  it('client.stop still runs the node stop even if an Electron cleanup step throws', async () => {
    const ipc = fakeIpcMain();
    // A malformed ipcMain whose removeListener throws — the real shutdown must still complete.
    ipc.ipcMain.removeListener = (() => {
      throw new Error('removeListener boom');
    }) as unknown as typeof ipc.ipcMain.removeListener;
    const onError = vi.fn();
    const f = fakeLaunch();
    f.stop.mockResolvedValue(false); // the node stop reports "not fully drained" — the wrapper must return it
    const client = launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, onError });

    const result = await client.stop(); // does not throw

    expect(result).toBe(false); // the wrapper returns the REAL node stop's result, not a fabricated one
    expect(f.stop).toHaveBeenCalledTimes(1); // the real node stop ALWAYS runs
    expect(onError).toHaveBeenCalled(); // the cleanup error was routed, not propagated
  });

  it('omits pixel-video wiring entirely when no video option is given', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    const opts = f.received?.options as BugseeLaunchOptions;
    expect(opts.reportSnapshots).toBeUndefined();
    expect(opts.fileEncoders).toBeUndefined();
  });

  it('wires nothing on a repeat launch (no receiver, no control) — returns the client untouched', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch({ internals: false });
    const client = launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    expect(client).toBe(f.client);
    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(false); // no second receiver
    expect(ipc.has(BUGSEE_HELLO_CHANNEL)).toBe(false); // no second control manager
    expect(client.stop).toBe(f.stop); // stop NOT re-wrapped (the first launch owns the wiring)
  });
});

describe('launchMain — renderer incidents are WIRED end to end', () => {
  // The code review's SEV1-1: R2 stopped renderers uploading, but nothing on the main side received or
  // submitted the forwarded incident, so renderer incidents were silently DESTROYED while the app was told
  // `{ok:true}` — strictly worse than the defect being fixed. These tests exist so that cannot recur: they
  // fail if launchMain stops passing `onReport`, or stops registering the provider that submits it.
  it('registers a detection provider that renderer incidents are submitted through', () => {
    const h = fakeLaunch();
    const { launch, client } = h;
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch });
    expect(client.addDetectionProvider).toHaveBeenCalledTimes(1);
    const provider = (client.addDetectionProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      name: string;
    };
    expect(provider.name).toBe('electron-renderer-incident');
  });

  it('a forwarded incident reaches the provider and becomes a reporting request', () => {
    const h = fakeLaunch();
    const { launch, client } = h;
    const ipc = fakeIpcMain();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch });
    const provider = (client.addDetectionProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      start: (c: unknown, report: (r: unknown) => void) => void;
    };
    const submitted: unknown[] = [];
    provider.start(client, (r) => submitted.push(r));

    ipc.emit(
      BUGSEE_STREAM_CHANNEL,
      {},
      JSON.stringify({
        k: 'report',
        p: {
          source: { type: 'crash', mechanism: 'uncaught' },
          report: { summary: 'renderer boom' },
        },
        ts: 1,
      }),
    );

    expect(submitted).toHaveLength(1);
    expect(JSON.stringify(submitted[0])).toContain('renderer boom');
    // The mechanism must survive — re-filing it as a handled error is the defect the design forbids.
    expect(JSON.stringify(submitted[0])).toContain('uncaught');
  });

  it('watches render-process-gone when an app is supplied', () => {
    const { launch } = fakeLaunch();
    const on = vi.fn();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch, app: { on } as never });
    expect(on).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
  });
});

describe('launchMain — render-process-gone wiring detail', () => {
  const goneOf = (over: Partial<Parameters<typeof launchMain>[1]> = {}) => {
    const { launch, client } = fakeLaunch();
    let listener:
      | ((e: unknown, c: { id?: number }, d: { reason: string; exitCode?: number }) => void)
      | undefined;
    launchMain('tok', {
      launch,
      app: { on: (_e: string, l: never) => (listener = l) } as never,
      ipcMain: fakeIpcMain().ipcMain,
      ...over,
    });
    return { client, fire: (id: number, reason: string) => listener?.({}, { id }, { reason }) };
  };

  it('submits a gone incident through the provider (no crashReporter → no dump to claim)', async () => {
    const { client, fire } = goneOf();
    const provider = (client.addDetectionProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      start: (c: unknown, r: (x: unknown) => void) => void;
    };
    const submitted: unknown[] = [];
    provider.start(client, (r) => submitted.push(r));
    fire(11, 'oom');
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(JSON.stringify(submitted[0])).toContain('oom');
    expect(JSON.stringify(submitted[0])).toContain('11'); // the faulting window id
  });

  it('ignores clean-exit rather than manufacturing a crash', async () => {
    const { client, fire } = goneOf();
    const provider = (client.addDetectionProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      start: (c: unknown, r: (x: unknown) => void) => void;
    };
    const submitted: unknown[] = [];
    provider.start(client, (r) => submitted.push(r));
    fire(11, 'clean-exit');
    await new Promise((r) => setTimeout(r, 10));
    expect(submitted).toEqual([]);
  });

  it('defaults a missing webContents id to -1 rather than throwing', async () => {
    const { launch, client } = fakeLaunch();
    let listener: ((e: unknown, c: undefined, d: { reason: string }) => void) | undefined;
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch,
      app: { on: (_e: string, l: never) => (listener = l) } as never,
    });
    const provider = (client.addDetectionProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      start: (c: unknown, r: (x: unknown) => void) => void;
    };
    const submitted: unknown[] = [];
    provider.start(client, (r) => submitted.push(r));
    expect(() => listener?.({}, undefined, { reason: 'oom' })).not.toThrow();
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
  });
});

describe('launchMain — gone handling without a crashReporter', () => {
  it('uses an inert dump source for a dump-producing reason, and still submits', async () => {
    // No crashReporter → no Crashpad dir → nothing to claim. The handler must fall back to capture + reason
    // rather than failing, which exercises the inert source's harvest/claim.
    const { launch, client } = fakeLaunch();
    let listener: ((e: unknown, c: { id?: number }, d: { reason: string }) => void) | undefined;
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch,
      app: { on: (_e: string, l: never) => (listener = l) } as never,
    });
    const provider = (client.addDetectionProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as {
      start: (c: unknown, r: (x: unknown) => void) => void;
    };
    const submitted: unknown[] = [];
    provider.start(client, (r) => submitted.push(r));
    listener?.({}, { id: 4 }, { reason: 'crashed' }); // a DUMP reason, so the source is consulted
    await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 5000 });
    expect(JSON.stringify(submitted[0])).toContain('crashed');
  }, 10_000);
});
