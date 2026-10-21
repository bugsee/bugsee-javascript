import type { SystemEvent, TraceProducer, TraceSink } from '@bugsee/capture';
import {
  BlackoutToken,
  CaptureDataEntryBase,
  CaptureStoreToken,
  createBlackoutState,
  InterceptorBase,
} from '@bugsee/core';
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';
import { resetProcessTracker } from '@bugsee/node';
import {
  electronApplicationTrackerFor,
  electronDisplayTrackerFor,
  electronPowerTrackerFor,
  electronProcessTrackerFor,
} from '@bugsee/trackers/electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// Wraps (never replaces) the registry accessor so a launch-level test can prove launchMain builds its tracker THROUGH it
// (mutating launchMain to `new ElectronProcessTracker(...)` makes the spy go uncalled). Behaviour is untouched.
vi.mock('@bugsee/trackers/electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/trackers/electron')>();
  return {
    ...actual,
    electronProcessTrackerFor: vi.fn(actual.electronProcessTrackerFor),
    electronPowerTrackerFor: vi.fn(actual.electronPowerTrackerFor),
    electronDisplayTrackerFor: vi.fn(actual.electronDisplayTrackerFor),
    electronApplicationTrackerFor: vi.fn(actual.electronApplicationTrackerFor),
  };
});

afterEach(() => {
  resetProcessTracker(); // the node tracker is a process singleton: a test's fake scheduler must not leak
});

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
  const blackout = createBlackoutState();
  const client = {
    getService: vi.fn((token: unknown) => {
      if (token === CaptureStoreToken) return store;
      if (token === BlackoutToken) return blackout;
      return undefined;
    }),
    // The real client has this (client.ts:493); the fake lacked it, which is why wiring the detection
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
    blackout,
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
      blackout: false, // main's blackout state rides every handshake reply
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
      clear() {},
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
  // The code review found stopped renderers uploading, but nothing on the main side received or
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

describe('launchMain - blackout is forwarded to every renderer (privacy)', () => {
  const commands = (r: { sent: Array<{ raw: string }> }) =>
    r.sent.map((m) => decodeControl(m.raw)?.command);

  it('the main blackout starting / ending is broadcast to every registered renderer', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    const a = fakeSender(1);
    const b = fakeSender(2);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: a }, encodeHello());
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: b }, encodeHello());
    f.blackout.start();
    f.blackout.end();
    expect(commands(a)).toEqual(['session', 'blackout-start', 'blackout-end']);
    expect(commands(b)).toEqual(['session', 'blackout-start', 'blackout-end']);
  });

  it('a renderer that says hello DURING a blackout is told so in its session reply', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    f.blackout.start();
    const late = fakeSender(3);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: late }, encodeHello());
    expect(decodeControl((late.sent[0] as { raw: string }).raw)?.blackout).toBe(true);
  });

  it('stopping the client unsubscribes from the blackout (no broadcast after stop)', async () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const client = launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    await client.stop();
    r.sent.length = 0;
    f.blackout.start();
    expect(r.sent).toEqual([]);
  });

  it('gates the opt-in pixel video: the source is stopped and CLEARED when the blackout begins', async () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const calls: string[] = [];
    const source: VideoCaptureSource = {
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
      clear: () => void calls.push('clear'),
      snapshot: vi.fn(async () => [new CaptureDataEntryBase('video', 1, new Uint8Array([1]))]),
    };
    launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      video: { source, hasPermission: () => true },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['start']);
    f.blackout.start();
    expect(calls).toEqual(['start', 'stop', 'clear']);
    const snapshotSource = (f.received?.options.reportSnapshots ?? [])[0] as (
      now: number,
    ) => Promise<unknown[]>;
    expect(await snapshotSource(5)).toEqual([]);
    f.blackout.end();
    expect(calls).toEqual(['start', 'stop', 'clear', 'start']);
  });
});

describe('launchMain — GPU info as environment.hardware.gpu (ST6a)', () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const gpuInfo = {
    gpuDevice: [
      { vendorId: 4318, deviceId: 1, active: true, vendorString: 'NVIDIA', deviceString: 'RTX' },
    ],
  };
  const extrasOf = (f: ReturnType<typeof fakeLaunch>) =>
    (f.received as { options: BugseeLaunchOptions }).options.hardwareExtras as () => unknown;
  const appWith = (getGPUInfo?: (t: 'basic') => Promise<unknown>) => ({
    on: vi.fn(),
    ...(getGPUInfo !== undefined ? { getGPUInfo } : {}),
  });

  it('a resolved getGPUInfo shows up on the NEXT environment assemble, not before', async () => {
    let resolve!: (v: unknown) => void;
    const getGPUInfo = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(getGPUInfo),
    });
    expect(getGPUInfo).toHaveBeenCalledExactlyOnceWith('basic');
    expect(extrasOf(f)()).toBeUndefined();
    resolve(gpuInfo);
    await flush();
    expect(extrasOf(f)()).toEqual({ gpu: { vendor: 'NVIDIA', renderer: 'RTX' } });
  });

  it('a rejected getGPUInfo: launch succeeds, no unhandledRejection, no gpu, error reported', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const boom = new Error('no acceleration');
      const onError = vi.fn();
      const f = fakeLaunch();
      const client = launchMain('tok', {
        ipcMain: fakeIpcMain().ipcMain,
        launch: f.launch,
        app: appWith(() => Promise.reject(boom)),
        onError,
      });
      await flush();
      await flush();
      expect(client).toBe(f.client);
      expect(extrasOf(f)()).toBeUndefined();
      expect(onError).toHaveBeenCalledWith(boom);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a late resolve after client.stop() is ignored', async () => {
    let resolve!: (v: unknown) => void;
    const f = fakeLaunch();
    const client = launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(() => new Promise<unknown>((r) => (resolve = r))),
    });
    await client.stop();
    resolve(gpuInfo);
    await flush();
    expect(extrasOf(f)()).toBeUndefined();
  });

  it('the wrapper keeps serving an already-resolved GPU after client.stop() (reports still draining)', async () => {
    const f = fakeLaunch();
    const client = launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(async () => gpuInfo),
    });
    await flush();
    await client.stop();
    expect(extrasOf(f)()).toEqual({ gpu: { vendor: 'NVIDIA', renderer: 'RTX' } });
  });

  it('an app without getGPUInfo (older Electron / bare fake) just omits, no error', async () => {
    const onError = vi.fn();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(),
      onError,
    });
    await flush();
    expect(extrasOf(f)()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('no app at all: hardwareExtras is still wired and answers undefined', () => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch });
    expect(extrasOf(f)()).toBeUndefined();
  });

  it('a caller gpu overrides the cache FIELD-WISE: its non-empty fields win, the rest come from the cache', async () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(async () => gpuInfo),
      hardwareExtras: () => ({ gpu: { vendor: 'Mine', gl_version: ' 3.0 ' } }),
    });
    await flush();
    expect(extrasOf(f)()).toEqual({
      gpu: { vendor: 'Mine', renderer: 'RTX', gl_version: '3.0' },
    });
  });

  it('a caller gpu that is the ONLY source (cache unsettled) is reported as given', () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(() => new Promise<unknown>(() => {})),
      hardwareExtras: () => ({ gpu: { vendor: 'Mine' } }),
    });
    expect(extrasOf(f)()).toEqual({ gpu: { vendor: 'Mine' } });
  });

  it.each([
    ['no gpu', {}],
    ['an empty gpu', { gpu: {} }],
    ['a null gpu', { gpu: null }],
    ['a blank vendor', { gpu: { vendor: '' } }],
    ['a whitespace vendor', { gpu: { vendor: '  ' } }],
    ['undefined', undefined],
  ])('a caller extra returning %s does NOT hide the cache GPU', async (_n, value) => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(async () => gpuInfo),
      hardwareExtras: () => value as never,
    });
    await flush();
    expect(extrasOf(f)()).toEqual({ gpu: { vendor: 'NVIDIA', renderer: 'RTX' } });
  });

  it('a throwing caller extra falls back to the cache and is reported (a throwing sink is survived)', async () => {
    const boom = new Error('caller');
    const onError = vi.fn();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(async () => gpuInfo),
      hardwareExtras: () => {
        throw boom;
      },
      onError,
    });
    await flush();
    expect(extrasOf(f)()).toEqual({ gpu: { vendor: 'NVIDIA', renderer: 'RTX' } });
    expect(onError).toHaveBeenCalledWith(boom);
    // polled on every report build: the same failure reaches the sink ONCE, a different one is still reported
    extrasOf(f)();
    extrasOf(f)();
    expect(onError).toHaveBeenCalledTimes(1);

    const f2 = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f2.launch,
      app: appWith(async () => gpuInfo),
      hardwareExtras: () => {
        throw boom;
      },
      onError: () => {
        throw new Error('sink');
      },
    });
    await flush();
    expect(extrasOf(f2)()).toEqual({ gpu: { vendor: 'NVIDIA', renderer: 'RTX' } });
  });

  it("passes gpuInfoType to getGPUInfo (default 'basic') and does not forward it to node launch", () => {
    const getGPUInfo = vi.fn(() => new Promise<unknown>(() => {}));
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(getGPUInfo),
      gpuInfoType: 'complete',
    });
    expect(getGPUInfo).toHaveBeenCalledExactlyOnceWith('complete');
    expect('gpuInfoType' in (f.received?.options ?? {})).toBe(false);
  });

  it('a throwing onError sink cannot stop client.stop() from running', async () => {
    const ipc = fakeIpcMain();
    ipc.ipcMain.removeListener.mockImplementation(() => {
      throw new Error('ipc broke');
    });
    const f = fakeLaunch();
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      onError: () => {
        throw new Error('sink');
      },
    });
    await expect(client.stop()).resolves.toBe(true);
    expect(f.stop).toHaveBeenCalled();
  });

  it('an async onError that rejects during stop leaves NO unhandledRejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ipc = fakeIpcMain();
      ipc.ipcMain.removeListener.mockImplementation(() => {
        throw new Error('ipc broke');
      });
      const f = fakeLaunch();
      const client = launchMain('tok', {
        ipcMain: ipc.ipcMain,
        launch: f.launch,
        onError: async () => {
          throw new Error('async sink');
        },
      });
      await expect(client.stop()).resolves.toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a repeat launch (no internals) does not start the GPU read', () => {
    const getGPUInfo = vi.fn(async () => gpuInfo);
    const f = fakeLaunch({ internals: false });
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: appWith(getGPUInfo),
    });
    expect(getGPUInfo).not.toHaveBeenCalled();
  });
});

describe('launchMain — app identity', () => {
  const identityOf = (over: Partial<Parameters<typeof launchMain>[1]>) => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, ...over });
    return f.received?.options.appIdentitySource;
  };
  const appWith = (getVersion: () => string) => ({ on: vi.fn(), getVersion }) as never;

  it('offers app.getVersion() as the version source', () => {
    expect(identityOf({ app: appWith(() => '4.2.0') })?.()).toEqual({ version: '4.2.0' });
  });

  it('passes no source when the app cannot report a version', () => {
    expect(identityOf({ app: { on: vi.fn() } as never })).toBeUndefined();
    expect(identityOf({})).toBeUndefined();
  });

  it('keeps a caller-supplied source untouched when there is no app version', () => {
    const own = () => ({ version: '1.0.0' });
    expect(identityOf({ appIdentitySource: own })).toBe(own);
  });

  it('asks the caller-supplied source first and fills the gaps from app.getVersion()', () => {
    const app = appWith(() => '4.2.0');
    expect(identityOf({ app, appIdentitySource: () => ({ version: '9.0.0' }) })?.()).toEqual({
      version: '9.0.0',
    });
    expect(identityOf({ app, appIdentitySource: () => ({ build: '12' }) })?.()).toEqual({
      version: '4.2.0',
      build: '12',
    });
    expect(identityOf({ app, appIdentitySource: () => ({ version: ' ' }) })?.()).toEqual({
      version: '4.2.0',
    });
    expect(identityOf({ app, appIdentitySource: () => undefined })?.()).toEqual({
      version: '4.2.0',
    });
  });

  it('lets a throwing caller source fall through to app.getVersion()', () => {
    const source = identityOf({
      app: appWith(() => '4.2.0'),
      appIdentitySource: () => {
        throw new Error('boom');
      },
    });
    expect(source?.()).toEqual({ version: '4.2.0' });
  });

  it('reports nothing, rather than throwing, when app.getVersion() throws', () => {
    const app = appWith(() => {
      throw new Error('not ready');
    });
    expect(identityOf({ app })?.()).toEqual({});
  });

  it('ignores an app.getVersion() that returns something other than text', () => {
    expect(identityOf({ app: appWith(() => 5 as never) })?.()).toEqual({});
  });
});

describe('launchMain — Electron process tracker composition (TR9, part 1)', () => {
  const optsOf = (f: ReturnType<typeof fakeLaunch>) =>
    (f.received as { options: BugseeLaunchOptions }).options;

  function fakeScheduler() {
    const armed = new Map<number, () => void>();
    let next = 1;
    return {
      setInterval: (callback: () => void) => {
        const id = next++;
        armed.set(id, callback);
        return id;
      },
      clearInterval: (id: unknown) => {
        armed.delete(id as number);
      },
      tick: () => {
        for (const cb of [...armed.values()]) cb();
      },
    };
  }

  type GoneL = (event: unknown, details: unknown) => void;
  function appWith(getAppMetrics?: () => unknown) {
    // `render-process-gone` is registered on this app by launchMain itself: only the child-process-gone ones are tracked
    const listeners: GoneL[] = [];
    return {
      listeners,
      app: {
        on: vi.fn((event: string, l: GoneL) => {
          if (event === 'child-process-gone') listeners.push(l);
        }),
        removeListener: vi.fn((event: string, l: GoneL) => {
          const i = listeners.indexOf(l);
          if (event === 'child-process-gone' && i >= 0) listeners.splice(i, 1);
        }),
        ...(getAppMetrics !== undefined ? { getAppMetrics } : {}),
      },
    };
  }
  const metric = {
    pid: 1,
    type: 'Browser',
    cpu: { percentCPUUsage: 2 },
    memory: { workingSetSize: 1024 },
  };

  const sinkOf = () => {
    const emitted: Array<{ name: string; value: unknown }> = [];
    const sink: TraceSink = { emit: (name, value) => emitted.push({ name, value }) };
    return { emitted, sink };
  };

  it('builds the tracker THROUGH the registry accessor, keyed on the injected app, with the launch scheduler/onError', () => {
    const accessor = vi.mocked(electronProcessTrackerFor);
    accessor.mockClear();
    const { app } = appWith();
    const scheduler = fakeScheduler();
    const onError = vi.fn();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      scheduler,
      onError,
    });
    expect(accessor).toHaveBeenCalledExactlyOnceWith({ app, scheduler }, onError);
  });

  it('builds no tracker, no producers and no events wrapper without an app', () => {
    const accessor = vi.mocked(electronProcessTrackerFor);
    accessor.mockClear();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch });
    expect(accessor).not.toHaveBeenCalled();
    expect(optsOf(f).systemTraceProducers).toBeUndefined();
    expect(optsOf(f).wrapSystemEventsSource).toBeUndefined();
  });

  it('passes node producers PLUS app_metrics, with no producer or trace name twice', () => {
    const { app } = appWith(() => [metric]);
    const f = fakeLaunch();
    const scheduler = fakeScheduler();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, app, scheduler });
    const producers = optsOf(f).systemTraceProducers as readonly TraceProducer[];
    const names = producers.map((p) => p.name);
    expect(names).toContain('process-memory');
    expect(names).toContain('event-loop-lag');
    expect(names).toContain('electron-app-metrics');
    expect(new Set(names).size).toBe(names.length);
    // Which TRACE names does each producer emit? Start them one at a time so the owner of every name is known.
    const owners = new Map<string, string[]>();
    for (const p of producers) {
      const { emitted, sink } = sinkOf();
      p.start(sink);
      scheduler.tick(); // every producer's tracker is tick-driven on the launch scheduler
      scheduler.tick();
      p.stop();
      for (const name of new Set(emitted.map((e) => e.name))) {
        owners.set(name, [...(owners.get(name) ?? []), p.name]);
      }
    }
    expect(owners.get('app_metrics')).toEqual(['electron-app-metrics']); // really emitted (after the first tick)
    expect(owners.get('process_memory_rss')).toEqual(['process-memory']);
    expect(owners.get('cpu_usage_process')).toEqual(['cpu']);
    const twice = [...owners].filter(([, by]) => by.length > 1).map(([name]) => name);
    expect(twice).toEqual([]);
  });

  it('a caller-supplied systemTraceProducers is kept and the Electron producer is ADDED to it', () => {
    const own: TraceProducer = { name: 'mine', start: () => {}, stop: () => {} };
    const { app } = appWith();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      systemTraceProducers: [own],
    });
    expect((optsOf(f).systemTraceProducers as readonly TraceProducer[]).map((p) => p.name)).toEqual(
      ['mine', 'electron-app-metrics'],
    );
  });

  it('a legacy systemMetricsSampler is left alone: no producer list is built', () => {
    const { app } = appWith();
    const f = fakeLaunch();
    const sampler = () => [];
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      systemMetricsSampler: sampler,
    });
    expect(optsOf(f).systemTraceProducers).toBeUndefined();
    expect(optsOf(f).systemMetricsSampler).toBe(sampler);
  });

  it('the app_metrics producer reads the SAME tracker the accessor returned (shared per app)', () => {
    const accessor = vi.mocked(electronProcessTrackerFor);
    accessor.mockClear();
    const getAppMetrics = vi.fn(() => [metric]);
    const { app } = appWith(getAppMetrics);
    const scheduler = fakeScheduler();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, app, scheduler });
    const producer = (optsOf(f).systemTraceProducers as readonly TraceProducer[]).find(
      (p) => p.name === 'electron-app-metrics',
    ) as TraceProducer;
    const { emitted, sink } = sinkOf();
    producer.start(sink);
    scheduler.tick();
    // the tracker the accessor returned holds the very sample the producer just published
    expect(accessor.mock.results[0]?.value.current('appMetrics')).toEqual({
      processes: [{ type: 'Browser', pid: 1, cpuPct: 2, workingSetBytes: 1024 * 1024 }],
    });
    expect(emitted).toEqual([
      {
        name: 'app_metrics',
        value: { processes: [{ type: 'Browser', pid: 1, cpu_percent: 2, working_set_mb: 1 }] },
      },
    ]);
    producer.stop();
  });

  it('a getAppMetrics that throws drops only app_metrics: the node producers still start and emit', () => {
    const onError = vi.fn();
    const { app } = appWith(() => {
      throw new Error('metrics');
    });
    const scheduler = fakeScheduler();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      scheduler,
      onError,
    });
    const producers = optsOf(f).systemTraceProducers as readonly TraceProducer[];
    const { emitted, sink } = sinkOf();
    expect(() => {
      for (const p of producers) p.start(sink);
    }).not.toThrow();
    scheduler.tick();
    for (const p of producers) p.stop();
    expect(emitted.map((e) => e.name)).toContain('process_memory_rss');
    expect(emitted.map((e) => e.name)).not.toContain('app_metrics');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'metrics' }));
  });

  describe('the events wrapper handed to node', () => {
    class Inner extends InterceptorBase<{ event: SystemEvent }> {
      readonly name = 'inner';
      protected onActivate(): void {
        this.emit('event', { name: 'process_started' });
      }
    }

    it('wraps lazily: nothing is attached until subscribed, and everything is released on unsubscribe', () => {
      const { app, listeners } = appWith();
      const f = fakeLaunch();
      launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, app });
      const wrap = optsOf(f).wrapSystemEventsSource as NonNullable<
        BugseeLaunchOptions['wrapSystemEventsSource']
      >;
      const inner = new Inner();
      const mux = wrap(inner);
      expect(app.on).not.toHaveBeenCalledWith('child-process-gone', expect.anything());
      const seen = vi.fn();
      const off = mux.on('event', seen);
      expect(listeners).toHaveLength(1);
      expect(seen.mock.calls.map((c) => (c[0] as SystemEvent).name)).toEqual(['process_started']);
      listeners[0]?.({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
      expect((seen.mock.calls[1]?.[0] as SystemEvent).name).toBe('child_process_gone');
      off();
      expect(listeners).toHaveLength(0);
    });

    it('composes with a caller wrapper: the caller sees the plain source, ours wraps its result', () => {
      const { app } = appWith();
      const f = fakeLaunch();
      const seenInner: unknown[] = [];
      const callerResult = new Inner();
      launchMain('tok', {
        ipcMain: fakeIpcMain().ipcMain,
        launch: f.launch,
        app,
        wrapSystemEventsSource: (inner) => {
          seenInner.push(inner);
          return callerResult;
        },
      });
      const wrap = optsOf(f).wrapSystemEventsSource as NonNullable<
        BugseeLaunchOptions['wrapSystemEventsSource']
      >;
      const plain = new Inner();
      const mux = wrap(plain);
      const seen = vi.fn();
      mux.on('event', seen);
      expect(seenInner).toEqual([plain]);
      expect(seen).toHaveBeenCalledWith({ name: 'process_started' }); // came through the caller's source
    });
  });
});

describe('launchMain — Electron domain trackers: power, display, application windows (TR9, part 2)', () => {
  const optsOf = (f: ReturnType<typeof fakeLaunch>) =>
    (f.received as { options: BugseeLaunchOptions }).options;
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
  const accessors = () => ({
    power: vi.mocked(electronPowerTrackerFor),
    display: vi.mocked(electronDisplayTrackerFor),
    application: vi.mocked(electronApplicationTrackerFor),
  });
  const clear = () => {
    for (const a of Object.values(accessors())) a.mockClear();
  };
  class Inner extends InterceptorBase<{ event: SystemEvent }> {
    readonly name = 'inner';
    protected onActivate(): void {}
  }
  const wrapOf = (f: ReturnType<typeof fakeLaunch>) =>
    optsOf(f).wrapSystemEventsSource as NonNullable<BugseeLaunchOptions['wrapSystemEventsSource']>;
  const producersOf = (f: ReturnType<typeof fakeLaunch>) =>
    (optsOf(f).systemTraceProducers ?? []).map((p: TraceProducer) => p.name);

  it('builds each tracker THROUGH its registry accessor, keyed on the injected object, with the launch onError', () => {
    clear();
    const powerMonitor = new FakeEmitter();
    const screen = Object.assign(new FakeEmitter(), { getAllDisplays: () => [] });
    const app = new FakeEmitter();
    const BrowserWindow = { getAllWindows: () => [] };
    const onError = vi.fn();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      powerMonitor,
      screen,
      BrowserWindow,
      onError,
    });
    const a = accessors();
    expect(a.power).toHaveBeenCalledExactlyOnceWith({ powerMonitor }, onError);
    expect(a.display).toHaveBeenCalledExactlyOnceWith({ screen }, onError);
    expect(a.application).toHaveBeenCalledExactlyOnceWith({ app, BrowserWindow }, onError);
  });

  it('the application tracker is built without a BrowserWindow key when none was injected', () => {
    clear();
    const app = new FakeEmitter();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, app });
    expect(accessors().application).toHaveBeenCalledExactlyOnceWith({ app }, undefined);
  });

  it('absent Electron objects mean those domains are simply off: no accessor, no producer, no wrapper', () => {
    clear();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch });
    for (const a of Object.values(accessors())) expect(a).not.toHaveBeenCalled();
    expect(optsOf(f).systemTraceProducers).toBeUndefined();
    expect(optsOf(f).wrapSystemEventsSource).toBeUndefined();
  });

  it('a powerMonitor alone is enough for the events mux (no app needed) and adds no trace producer', () => {
    const powerMonitor = new FakeEmitter();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, powerMonitor });
    expect(optsOf(f).systemTraceProducers).toBeUndefined();
    const mux = wrapOf(f)(new Inner());
    expect(powerMonitor.total()).toBe(0); // lazy
    const seen = vi.fn();
    mux.on('event', seen);
    powerMonitor.emit('suspend');
    expect(seen).toHaveBeenCalledWith({ name: 'power_suspend' });
  });

  it('a screen adds the displays producer next to the node set, once', () => {
    const screen = Object.assign(new FakeEmitter(), { getAllDisplays: () => [] });
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, screen });
    const names = producersOf(f);
    expect(names).toContain('process-memory');
    expect(names.filter((n: string) => n === 'displays')).toHaveLength(1);
    expect(names).not.toContain('electron-app-metrics');
  });

  it('an app adds app_metrics but not displays; a screen without app adds displays but not app_metrics', () => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: f.launch, app: new FakeEmitter() });
    expect(producersOf(f)).toContain('electron-app-metrics');
    expect(producersOf(f)).not.toContain('displays');
  });

  it('a legacy systemMetricsSampler with only a screen builds no producer list', () => {
    const screen = Object.assign(new FakeEmitter(), { getAllDisplays: () => [] });
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      screen,
      systemMetricsSampler: () => [],
    });
    expect(optsOf(f).systemTraceProducers).toBeUndefined();
  });

  it('NEVER forwards the Electron objects or captureWindowEvents to the node launch', () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: new FakeEmitter(),
      powerMonitor: new FakeEmitter(),
      screen: new FakeEmitter(),
      BrowserWindow: { getAllWindows: () => [] },
      captureWindowEvents: true,
    });
    const keys = Object.keys(optsOf(f));
    for (const key of [
      'app',
      'powerMonitor',
      'screen',
      'BrowserWindow',
      'captureWindowEvents',
      'ipcMain',
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  it('captureWindowEvents:false turns the window domain off (no application tracker, no app listeners); the others stay', () => {
    clear();
    const app = new FakeEmitter();
    const powerMonitor = new FakeEmitter();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      powerMonitor,
      captureWindowEvents: false,
    });
    expect(accessors().application).not.toHaveBeenCalled();
    expect(accessors().power).toHaveBeenCalledOnce();
    const mux = wrapOf(f)(new Inner());
    mux.on('event', () => {});
    expect(app.table.get('browser-window-created')).toBeUndefined();
    expect(app.table.get('web-contents-created')).toBeUndefined();
    expect(powerMonitor.total()).toBe(6);
  });

  it.each([
    null,
    0,
    '',
    'false',
    'true',
    1,
    {},
  ])('an invalid captureWindowEvents (%j) is OFF and reported (fail closed)', (value) => {
    clear();
    const onError = vi.fn();
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app: new FakeEmitter(),
      onError,
      captureWindowEvents: value as never,
    });
    expect(accessors().application).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining('captureWindowEvents') }),
    );
  });

  it('captureWindowEvents:true and undefined keep the window domain on, without a report', () => {
    for (const value of [true, undefined]) {
      clear();
      const onError = vi.fn();
      launchMain('tok', {
        ipcMain: fakeIpcMain().ipcMain,
        launch: fakeLaunch().launch,
        app: new FakeEmitter(),
        onError,
        ...(value !== undefined ? { captureWindowEvents: value } : {}),
      });
      expect(accessors().application).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    }
  });

  it('the mux handed to node is LAZY: until subscribed no domain listener exists; subscribing attaches all, unsubscribing releases all', () => {
    const powerMonitor = new FakeEmitter();
    const screen = Object.assign(new FakeEmitter(), { getAllDisplays: () => [] });
    const app = new FakeEmitter();
    const win = Object.assign(new FakeEmitter(), {
      id: 1,
      isDestroyed: () => false,
      webContents: Object.assign(new FakeEmitter(), { id: 11, isDestroyed: () => false }),
    });
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      powerMonitor,
      screen,
      BrowserWindow: { getAllWindows: () => [win] },
    });
    const mux = wrapOf(f)(new Inner());
    const owned = () =>
      powerMonitor.total() + screen.total() + win.total() + win.webContents.total();
    // launchMain itself registers render-process-gone on app; the domain listeners are the REST
    const appBefore = app.total();
    expect(owned()).toBe(0);
    const off = mux.on('event', () => {});
    expect(powerMonitor.total()).toBe(6);
    expect(screen.total()).toBe(3);
    expect(win.total()).toBe(6); // focus, blur, show, hide + one `closed` per window stage
    off();
    expect(owned()).toBe(0);
    expect(app.total()).toBe(appBefore);
  });
});

describe('launchMain — render-process-gone listener lifecycle', () => {
  type Gone = (e: unknown, c: { id?: number }, d: { reason: string }) => void;
  function countingApp(mode: 'removeListener' | 'off' | 'none') {
    const listeners: Gone[] = [];
    const app: Record<string, unknown> = {
      on: (event: string, l: Gone) => {
        if (event === 'render-process-gone') listeners.push(l);
      },
    };
    const remove = (event: string, l: Gone) => {
      const i = listeners.indexOf(l);
      if (event === 'render-process-gone' && i >= 0) listeners.splice(i, 1);
    };
    if (mode !== 'none') app[mode] = remove;
    return { app: app as never, listeners };
  }

  it.each(['removeListener', 'off'] as const)('releases the handler on stop via %s', (mode) => {
    const { launch } = fakeLaunch();
    const { app, listeners } = countingApp(mode);
    const client = launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch, app });
    expect(listeners).toHaveLength(1);
    void client.stop();
    expect(listeners).toHaveLength(0);
  });

  it('stop twice removes once and does not throw', () => {
    const { launch } = fakeLaunch();
    const remove = vi.fn();
    const client = launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch,
      app: { on: vi.fn(), removeListener: remove } as never,
    });
    void client.stop();
    void client.stop();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
  });

  it('prefers removeListener over off when both exist (one removal only)', () => {
    const { launch } = fakeLaunch();
    const removeListener = vi.fn();
    const off = vi.fn();
    const client = launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch,
      app: { on: vi.fn(), removeListener, off } as never,
    });
    void client.stop();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
  });

  it('a missing remover does not throw and stop still runs', () => {
    const f = fakeLaunch();
    const { app, listeners } = countingApp('none');
    const onError = vi.fn();
    const client = launchMain('tok', {
      ipcMain: fakeIpcMain().ipcMain,
      launch: f.launch,
      app,
      onError,
    });
    expect(() => client.stop()).not.toThrow();
    expect(f.stop).toHaveBeenCalledTimes(1); // the real shutdown ran
    expect(listeners).toHaveLength(1); // nothing could remove it, and nothing pretended to
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    'removeListener',
    'off',
  ] as const)('a throwing %s is reported and every other cleanup step still runs on the FIRST stop', (mode) => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const onError = vi.fn();
    const boom = new Error('remover boom');
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      onError,
      app: {
        on: vi.fn(),
        [mode]: () => {
          throw boom;
        },
      } as never,
    });
    const r = fakeSender(1);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    r.sent.length = 0;
    void client.stop();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(ipc.has(BUGSEE_HELLO_CHANNEL)).toBe(false); // control.stop() ran
    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(false); // receiver.stop() ran
    expect(r.sent.map((m) => decodeControl(m.raw)?.command)).toContain('stop'); // renderers told to stop
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('relaunch after stop leaves exactly one listener; a repeat launch adds none', () => {
    const { app, listeners } = countingApp('removeListener');
    const a = fakeLaunch();
    const c1 = launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: a.launch, app });
    void c1.stop();
    const b = fakeLaunch();
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: b.launch, app });
    expect(listeners).toHaveLength(1);
    const rep = fakeLaunch({ internals: false });
    launchMain('tok', { ipcMain: fakeIpcMain().ipcMain, launch: rep.launch, app });
    expect(listeners).toHaveLength(1);
  });
});

describe('launchMain — a gone renderer is forgotten by the control channel', () => {
  it('stops addressing the webContents after render-process-gone, and re-addresses it after a re-hello', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    let gone: ((e: unknown, c: { id?: number }, d: { reason: string }) => void) | undefined;
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      app: { on: (_e: string, l: never) => (gone = l) } as never,
    });
    const r = fakeSender(5);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    r.sent.length = 0;
    gone?.({}, { id: 5 }, { reason: 'killed' });
    void client.flush();
    expect(r.sent).toEqual([]);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello()); // the reloaded frame
    r.sent.length = 0;
    void client.flush();
    expect(r.sent).toHaveLength(1);
  });

  it('an id-less gone event forgets nothing even with other senders registered; a shared id forgets every match', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    let gone: ((e: unknown, c: unknown, d: { reason: string }) => void) | undefined;
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      app: { on: (_e: string, l: never) => (gone = l) } as never,
    });
    const noId = { ...fakeSender(1), id: undefined as number | undefined };
    const a = fakeSender(5);
    const b = fakeSender(5);
    for (const s of [noId, a, b]) ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: s }, encodeHello());
    for (const s of [noId, a, b]) s.sent.length = 0;
    gone?.({}, {}, { reason: 'killed' }); // contents without an id
    void client.flush();
    expect([noId.sent.length, a.sent.length, b.sent.length]).toEqual([1, 1, 1]);
    for (const s of [noId, a, b]) s.sent.length = 0;
    gone?.({}, { id: 5 }, { reason: 'killed' });
    void client.flush();
    expect([noId.sent.length, a.sent.length, b.sent.length]).toEqual([1, 0, 0]);
  });

  it('a gone event without a contents id forgets nothing', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    let gone: ((e: unknown, c: unknown, d: { reason: string }) => void) | undefined;
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      app: { on: (_e: string, l: never) => (gone = l) } as never,
    });
    const r = fakeSender(5);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r }, encodeHello());
    r.sent.length = 0;
    gone?.({}, undefined, { reason: 'killed' });
    void client.flush();
    expect(r.sent).toHaveLength(1);
  });
});
