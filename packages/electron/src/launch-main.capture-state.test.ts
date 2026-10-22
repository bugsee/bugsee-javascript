import type { TraceProducer, TraceSink } from '@bugsee/capture';
import {
  BlackoutToken,
  CaptureStoreToken,
  createBlackoutState,
  setCarrierClient,
} from '@bugsee/core';
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';
import { resetProcessTracker } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';
import type { VideoCaptureSource } from './video-capture';

// C7 in the Electron MAIN: the `capture` trace exists only while pixel video is configured, writes active/blackout
// once the controller is really running, and shares the disk pressure the node launch feeds under `captureDiskSpace`.
afterEach(() => resetProcessTracker());

const MB = 1024 * 1024;
const ipcMain = { on: vi.fn(), removeListener: vi.fn() };

function fakeLaunch(opts: { internals?: boolean } = {}) {
  const blackout = createBlackoutState();
  const client = {
    getService: vi.fn((token: unknown) => {
      if (token === CaptureStoreToken) return { add: () => {} };
      if (token === BlackoutToken) return blackout;
      return undefined;
    }),
    addDetectionProvider: vi.fn(),
    stop: vi.fn(() => Promise.resolve(true)),
    flush: vi.fn(() => Promise.resolve(true)),
  } as unknown as Bugsee;
  let received: BugseeLaunchOptions | undefined;
  const launch = vi.fn((_t: string, o: BugseeLaunchOptions) => {
    received = o;
    return { client, internals: opts.internals === false ? undefined : { baseUrl: 'u', api: {} } };
  });
  return {
    launch: launch as never,
    blackout,
    client,
    get options() {
      return received as BugseeLaunchOptions;
    },
  };
}

const source = (): VideoCaptureSource => ({
  start() {},
  stop() {},
  clear() {},
  snapshot: async () => [],
});
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function startProducers(f: ReturnType<typeof fakeLaunch>) {
  const emitted: string[] = [];
  const sink: TraceSink = {
    emit: (name, value) => {
      if (name === 'capture') emitted.push((value as { state: string }).state);
    },
  };
  const producer = (f.options.systemTraceProducers as readonly TraceProducer[]).find(
    (p) => p.name === 'capture-state',
  );
  producer?.start(sink);
  return { emitted, producer };
}

describe('launchMain — the capture trace producer (C7)', () => {
  it('is added only with pixel video, and writes active once the controller runs, then follows blackout', async () => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain, launch: f.launch, video: { source: source() } });
    const { emitted, producer } = startProducers(f);
    expect(producer).toBeDefined();
    await settle();
    f.blackout.start();
    f.blackout.end();
    expect(emitted).toEqual(['active', 'blackout', 'active']);
  });

  it('does not claim active before the controller has started', () => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain, launch: f.launch, video: { source: source() } });
    const { emitted } = startProducers(f); // the permission check has not settled yet
    expect(emitted).toEqual([]);
  });

  it('does not claim active when the permission gate says no', async () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain,
      launch: f.launch,
      video: { source: source(), hasPermission: () => false },
    });
    const { emitted } = startProducers(f);
    await settle();
    f.blackout.start();
    expect(emitted).toEqual([]);
  });

  it('is absent without pixel video (a renderer replay does not make main claim a capture)', () => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain, launch: f.launch });
    expect(f.options.systemTraceProducers).toBeUndefined();
  });

  it('is absent under the legacy sampler, which replaces the producer list', () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain,
      launch: f.launch,
      video: { source: source() },
      systemMetricsSampler: () => [],
    });
    expect(f.options.systemTraceProducers).toBeUndefined();
  });

  it('is added to a caller-supplied producer list, not replacing it', () => {
    const f = fakeLaunch();
    const own: TraceProducer = { name: 'own', start() {}, stop() {} };
    launchMain('tok', {
      ipcMain,
      launch: f.launch,
      video: { source: source() },
      systemTraceProducers: [own],
    });
    expect((f.options.systemTraceProducers as TraceProducer[]).map((p) => p.name)).toEqual([
      'own',
      'capture-state',
    ]);
  });

  it('is not built on a repeat launch (nothing would ever start it, and the pressure would be orphaned)', () => {
    const carrier = {};
    const running = fakeLaunch();
    setCarrierClient(running.client as never, carrier);
    const repeat = fakeLaunch({ internals: false });
    launchMain('tok', {
      ipcMain,
      launch: repeat.launch,
      carrier,
      captureDiskSpace: true,
      video: { source: source() },
    });
    expect(repeat.options.systemTraceProducers).toBeUndefined();
    expect(repeat.options.diskPressure).toBeUndefined();
  });

  it('writes nothing after stop (the controller is down: no new claim)', async () => {
    const f = fakeLaunch();
    const client = launchMain('tok', { ipcMain, launch: f.launch, video: { source: source() } });
    const { emitted } = startProducers(f);
    await settle();
    await client.stop();
    f.blackout.start();
    expect(emitted).toEqual(['active']);
  });
});

describe('launchMain — disk pressure (C7)', () => {
  it('hands node ONE DiskPressure under captureDiskSpace:true, and the producer follows it', async () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain,
      launch: f.launch,
      captureDiskSpace: true,
      video: { source: source() },
    });
    const pressure = f.options.diskPressure;
    expect(pressure).toBeDefined();
    const { emitted } = startProducers(f);
    await settle();
    pressure?.observe(30 * MB);
    pressure?.observe(5 * MB);
    pressure?.observe(100 * MB);
    expect(emitted).toEqual(['active', 'low_disk_space', 'no_disk_space', 'active']);
  });

  it('still hands node the pressure without video (the store protection applies, no trace)', () => {
    const f = fakeLaunch();
    launchMain('tok', { ipcMain, launch: f.launch, captureDiskSpace: true });
    expect(f.options.diskPressure).toBeDefined();
    expect(f.options.systemTraceProducers).toBeUndefined();
  });

  it('passes none when the protection is switched off (the node launch would not create one either)', () => {
    const f = fakeLaunch();
    launchMain('tok', {
      ipcMain,
      launch: f.launch,
      captureDiskSpace: true,
      diskProtection: false,
      video: { source: source() },
    });
    expect(f.options.diskPressure).toBeUndefined();
  });

  it('passes none without the opt-in, or for a non-boolean-true value', () => {
    for (const v of [undefined, false, 'true', 1, null]) {
      const f = fakeLaunch();
      launchMain('tok', {
        ipcMain,
        launch: f.launch,
        video: { source: source() },
        ...(v === undefined ? {} : { captureDiskSpace: v as unknown as boolean }),
      });
      expect(f.options.diskPressure, String(v)).toBeUndefined();
    }
  });
});
