import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaptureStoreToken,
  ChunkStorageToken,
  createMemoryCaptureStore,
  DiskPressureToken,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// C7 WIRING through the real node launch: a DURABLE store (a data dir, no explicit captureStore) builds one DiskPressure BY
// DEFAULT (iOS runs the protection always; `diskProtection: false` opts out), feeds it from the shared StorageTracker's
// `statfs`, hands it to the file capture store, and wires every writer's health hooks to it. `captureDiskSpace` is only
// the telemetry. The real fs medium is used; only `statfs` and the poll timer are injected.
const { batchedSpy, ringSpy, fileStoreSpy } = vi.hoisted(() => ({
  batchedSpy: vi.fn(),
  ringSpy: vi.fn(),
  fileStoreSpy: vi.fn(),
}));
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return {
    ...actual,
    createFileCaptureStore: (...args: Parameters<typeof actual.createFileCaptureStore>) => {
      fileStoreSpy(args[1]);
      return actual.createFileCaptureStore(...args);
    },
  };
});
vi.mock('@bugsee/node-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/node-utils')>();
  return {
    ...actual,
    createBatchedFsChunkStorage: (
      ...args: Parameters<typeof actual.createBatchedFsChunkStorage>
    ) => {
      batchedSpy(args[1]);
      return actual.createBatchedFsChunkStorage(...args);
    },
    createCaptureRingWriter: (...args: Parameters<typeof actual.createCaptureRingWriter>) => {
      ringSpy(args[1]);
      return actual.createCaptureRingWriter(...args);
    },
  };
});

import { resetStorageTracker } from '@bugsee/trackers/node';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

const MB = 1024 * 1024;
const fakeProc = (): NodeRuntime => ({
  on: () => undefined as never,
  off: () => undefined as never,
  exit: () => {},
});
const okTransport = (): HttpTransport =>
  vi.fn<HttpTransport>(
    async () => ({ status: 200, headers: {}, body: new Uint8Array() }) as HttpResponse,
  );
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const dirs: string[] = [];
const clients: Array<ReturnType<typeof launch>> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop(50)));
  for (const dir of dirs.splice(0)) {
    resetStorageTracker(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  vi.clearAllMocks();
});

function setup(over: Partial<BugseeLaunchOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-pressure-'));
  dirs.push(dir);
  let freeBytes = 500 * MB;
  let tick: (() => void) | undefined;
  const statfs = vi.fn(async () => ({ bsize: 1, bavail: freeBytes, blocks: 10_000 * MB }));
  const client = launch('tok', {
    process: fakeProc(),
    transport: okTransport(),
    captureNetwork: false,
    captureSystemTraces: false,
    captureSystemEvents: false,
    detectCrashes: false,
    systemMetricsSampler: () => [],
    dataDir: dir,
    diskStatfs: statfs,
    scheduler: {
      setInterval: (cb: () => void, ms: number) => {
        if (ms === 5000) tick = cb;
        return 'h';
      },
      clearInterval: () => {},
    },
    ...over,
  });
  clients.push(client);
  return {
    client,
    dir,
    statfs,
    setFree: async (bytes: number) => {
      freeBytes = bytes;
      tick?.();
      await settle();
    },
    pressure: () => client.getService(DiskPressureToken),
    store: () => client.getService(CaptureStoreToken),
    storage: () => client.getService(ChunkStorageToken),
  };
}

const entry = (type: 'log' | 'traces.system', timestamp: number, serialized: string) => ({
  type,
  timestamp,
  serialized,
});

describe('launch — captureDiskSpace disk-pressure protection (C7)', () => {
  it('registers a DiskPressure fed by statfs of the data dir (every 5 s) with the iOS thresholds', async () => {
    const h = setup();
    await settle();
    expect(h.statfs).toHaveBeenCalledWith(h.dir);
    expect(h.pressure().level()).toBe('normal');
    await h.setFree(49 * MB);
    expect(h.pressure().level()).toBe('low');
    await h.setFree(9 * MB);
    expect(h.pressure().level()).toBe('none');
    await h.setFree(59 * MB);
    expect(h.pressure().level()).toBe('low'); // none -> low at 20 MB, not normal until 60 MB
    await h.setFree(60 * MB);
    expect(h.pressure().level()).toBe('normal');
  });

  it('LOW: log stops reaching disk, traces keep going, and the live window is still complete', async () => {
    const h = setup();
    await settle();
    h.store().add(entry('log', Date.now(), 'before'));
    await h.setFree(30 * MB);
    h.store().add(entry('log', Date.now() + 1, 'during-pressure'));
    h.store().add(entry('traces.system', Date.now() + 2, 'trace'));
    h.storage()?.flushSync?.();
    const storage = h.storage();
    const files = (storage?.generations() ?? []).flatMap((g) =>
      (storage?.chunks(g) ?? []).flatMap((c) =>
        (storage?.files(g, c) ?? []).map((f) => ({ f, text: storage?.read(g, c, f) ?? '' })),
      ),
    );
    const onDisk = (name: string) => files.find((x) => x.f === name)?.text ?? '';
    expect(onDisk('log')).toContain('before');
    expect(onDisk('log')).not.toContain('during-pressure');
    expect(onDisk('traces.system')).toContain('trace');
    const snap = h.store().snapshot();
    const all = await snap.drainAll();
    snap.release();
    expect(all.get('log')?.map((r) => r.serialized)).toEqual(['before', 'during-pressure']);
  });

  it('is ON by default, with no captureDiskSpace (the opt-in is only telemetry)', async () => {
    const h = setup();
    await settle();
    expect(h.pressure().level()).toBe('normal');
    expect(h.statfs).toHaveBeenCalled();
  });

  it('diskProtection:false opts out (no pressure, no polling)', () => {
    const off = setup({ diskProtection: false });
    expect(() => off.pressure()).toThrow();
    expect(off.statfs).not.toHaveBeenCalled();
  });

  it.each([
    'false',
    0,
    null,
    'no',
  ])('diskProtection %j is not a boolean false: the protection stays ON', async (v) => {
    const h = setup({ diskProtection: v as unknown as boolean, onError: () => {} });
    expect(h.pressure()).toBeDefined();
    await h.client.stop(50);
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('is absent with no durable store: an in-memory launch, or an explicit captureStore, persists nothing to protect', () => {
    const memory = setup({ dataDir: undefined, capturedDataStore: 'memory' });
    expect(() => memory.pressure()).toThrow();
    expect(memory.statfs).not.toHaveBeenCalled();
    const explicit = setup({ captureStore: createMemoryCaptureStore() });
    expect(() => explicit.pressure()).toThrow();
    expect(explicit.statfs).not.toHaveBeenCalled();
  });

  const noDirReports = (onError: ReturnType<typeof vi.fn>): unknown[] =>
    onError.mock.calls.filter((c) =>
      /captureDiskSpace needs an on-disk data directory/.test(String((c[0] as Error).message)),
    );

  it('captureDiskSpace without any data directory says so ONCE through onError', () => {
    const onError = vi.fn();
    setup({ dataDir: undefined, capturedDataStore: 'memory', captureDiskSpace: true, onError });
    expect(noDirReports(onError)).toHaveLength(1);
  });

  it('captureDiskSpace without a data directory and without onError stays silent (never throws)', () => {
    expect(() =>
      setup({ dataDir: undefined, capturedDataStore: 'memory', captureDiskSpace: true }),
    ).not.toThrow();
  });

  it('an in-memory launch that did not ask for the telemetry is not told anything', () => {
    const onError = vi.fn();
    setup({ dataDir: undefined, capturedDataStore: 'memory', onError });
    expect(noDirReports(onError)).toHaveLength(0);
  });

  it('a failing or impossible statfs never creates pressure', async () => {
    const h = setup({ onError: () => {} });
    await settle();
    h.statfs.mockRejectedValue(new Error('EIO'));
    await h.setFree(0);
    expect(h.pressure().level()).toBe('normal');
    h.statfs.mockResolvedValue({ bsize: 0, bavail: 0, blocks: 0 });
    await h.setFree(0);
    expect(h.pressure().level()).toBe('normal');
  });

  const hooksOf = () =>
    batchedSpy.mock.calls.at(-1)?.[0] as {
      onError?: (e: unknown) => void;
      onWriteFailure: (e: unknown) => void;
      onWriteRecovered: () => void;
    };

  it('wires the chunk writer health hooks: every out-of-space failure pins none, a healthy reading does not undo it, a successful write does', async () => {
    const onError = vi.fn();
    const h = setup({ onError });
    await settle();
    const hooks = hooksOf();
    const full = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    hooks.onWriteFailure(full);
    expect(h.pressure().level()).toBe('none');
    expect(h.pressure().pinned()).toBe(true);
    await h.setFree(500 * MB);
    expect(h.pressure().level()).toBe('none'); // the size reading is a different instrument
    hooks.onWriteFailure(new Error('EPERM')); // not out-of-space: ignored
    hooks.onWriteRecovered();
    expect(h.pressure().level()).toBe('normal');
    expect(hooks.onError).toBe(onError); // host reporting is untouched
  });

  it("wires the OFF-THREAD ring writer's health hooks the same way (captureWriter: 'worker')", async () => {
    const h = setup({ captureWriter: 'worker' });
    await settle();
    const hooks = ringSpy.mock.calls.at(-1)?.[0] as {
      onWriteFailure: (e: unknown) => void;
      onWriteRecovered: () => void;
    };
    hooks.onWriteFailure({ code: 'ENOSPC' });
    expect(h.pressure().level()).toBe('none');
    hooks.onWriteRecovered();
    expect(h.pressure().level()).toBe('normal');
  });

  it('passes the host onError to the writer unwrapped, and works without one', async () => {
    const h = setup();
    await settle();
    expect(hooksOf().onError).toBeUndefined();
    hooksOf().onWriteFailure({ code: 'ENOSPC' });
    expect(h.pressure().level()).toBe('none');
  });

  it('gives the file store an onDiskWriteError that pins none and still tells the host', async () => {
    const onError = vi.fn();
    const h = setup({ onError });
    await settle();
    const given = fileStoreSpy.mock.calls.at(-1)?.[0] as {
      diskPressure?: unknown;
      onDiskWriteError: (e: unknown) => void;
    };
    expect(given.diskPressure).toBe(h.pressure());
    const full = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    given.onDiskWriteError(full);
    expect(h.pressure().level()).toBe('none');
    expect(onError).toHaveBeenCalledWith(full);
  });

  it('uses the DiskPressure a platform injects, so the platform can follow the same state', async () => {
    const { createDiskPressure } = await import('@bugsee/core');
    const injected = createDiskPressure();
    const h = setup({ diskPressure: injected });
    await settle();
    expect(h.pressure()).toBe(injected);
    await h.setFree(30 * MB);
    expect(injected.level()).toBe('low');
  });

  it('stop() releases the poll: later ticks no longer move the state', async () => {
    const h = setup();
    await settle();
    await h.client.stop(50);
    await h.setFree(5 * MB);
    expect(h.pressure().level()).toBe('normal');
  });
});
