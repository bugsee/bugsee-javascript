import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaptureProviderBase,
  CaptureStoreToken,
  ChunkStorageToken,
  DiskPressureToken,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// C7 WIRING through the real node launch: `captureDiskSpace` + a data dir builds one DiskPressure, feeds it from the
// shared StorageTracker's `statfs`, hands it to the file capture store, and routes every writer's error sink through
// `noteWriteError`. The real fs medium is used; only `statfs` and the poll timer are injected.
const { batchedSpy } = vi.hoisted(() => ({ batchedSpy: vi.fn() }));
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
  };
});

import { resetStorageTracker } from '@bugsee/trackers/node';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

const MB = 1_000_000;
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
    captureDiskSpace: true,
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

  it('is absent without the opt-in, and for a non-boolean-true value', () => {
    for (const v of [undefined, false, 'true', 1, null]) {
      const h = setup({ captureDiskSpace: v as unknown as boolean });
      expect(() => h.pressure(), String(v)).toThrow();
      expect(h.statfs, String(v)).not.toHaveBeenCalled();
    }
  });

  it('is absent without a data dir (an in-memory launch has nothing it persists to)', () => {
    const h = setup({ dataDir: undefined, capturedDataStore: 'memory' });
    expect(() => h.pressure()).toThrow();
    expect(h.statfs).not.toHaveBeenCalled();
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

  it('routes the chunk writer error sink through noteWriteError, and still tells the host', async () => {
    const onError = vi.fn();
    const h = setup({ onError });
    await settle();
    const sink = batchedSpy.mock.calls.at(-1)?.[0]?.onError as (e: unknown) => void;
    const full = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    sink(full);
    expect(h.pressure().level()).toBe('none');
    expect(onError).toHaveBeenCalledWith(full);
    await h.setFree(500 * MB); // the next sane reading ends it
    expect(h.pressure().level()).toBe('normal');
    sink(new Error('EPERM'));
    expect(h.pressure().level()).toBe('normal');
  });

  it('routes an error the capture funnel itself reports (a store that refuses a write) through noteWriteError too', async () => {
    const onError = vi.fn();
    const h = setup({ onError });
    await settle();
    class Probe extends CaptureProviderBase {
      readonly name = 'probe';
      protected onStart(): void {}
      refuse(error: Error): void {
        this.capture('log', Date.now(), {
          toJSON() {
            throw error;
          },
        });
      }
    }
    const probe = new Probe();
    h.client.addCaptureProvider(probe);
    const full = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    probe.refuse(full);
    expect(h.pressure().level()).toBe('none');
    expect(onError).toHaveBeenCalledWith(full);
  });

  it('works without a host onError (the sink still pins and nothing throws)', async () => {
    const h = setup();
    await settle();
    const sink = batchedSpy.mock.calls.at(-1)?.[0]?.onError as (e: unknown) => void;
    expect(() => sink({ code: 'ENOSPC' })).not.toThrow();
    expect(h.pressure().level()).toBe('none');
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
