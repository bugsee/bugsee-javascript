import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureSnapshot, CaptureStore, HttpResponse, HttpTransport } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Verifies the maxDataSize WIRING through launch: the resolved option (MB) must reach the capture
// store builder as a byte ceiling (MB * 1024 * 1024), for both the in-memory and file-backed paths.
// We wrap the two @bugsee/core store builders so we can assert the exact options launch passes them,
// without flooding megabytes of capture. The wrappers still call through to the real builders, so
// launch composes a fully working client.
const { memSpy, fileSpy } = vi.hoisted(() => ({ memSpy: vi.fn(), fileSpy: vi.fn() }));

vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return {
    ...actual,
    createMemoryCaptureStore: (opts?: Parameters<typeof actual.createMemoryCaptureStore>[0]) => {
      memSpy(opts);
      return actual.createMemoryCaptureStore(opts);
    },
    createFileCaptureStore: (
      adapter: Parameters<typeof actual.createFileCaptureStore>[0],
      opts?: Parameters<typeof actual.createFileCaptureStore>[1],
    ) => {
      fileSpy(opts);
      return actual.createFileCaptureStore(adapter, opts);
    },
  };
});

// Imported AFTER vi.mock (hoisted) so launch resolves the wrapped @bugsee/core builders.
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

const opts = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProc(),
  transport: okTransport(),
  captureNetwork: false,
  captureSystemTraces: false,
  captureSystemEvents: false,
  detectCrashes: false,
  systemMetricsSampler: () => [],
  ...over,
});

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.clearAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__; // fresh interceptor singletons per test
});
const launchTracked = (over?: Partial<BugseeLaunchOptions>) => {
  const c = launch('tok', opts(over));
  clients.push(c);
  return c;
};

describe('launch — maxDataSize byte-bound wiring', () => {
  it('builds the in-memory store with a 50 MB byte cap and a 60 s window by default', () => {
    launchTracked({ capturedDataStore: 'memory' }); // disk is the default now (D3); pin the in-memory path
    expect(memSpy).toHaveBeenCalledTimes(1);
    expect(memSpy.mock.calls[0]?.[0]).toMatchObject({
      maxDataSizeBytes: 50 * MB,
      maxRecordingTimeMs: 60_000,
    });
  });

  it('converts a maxDataSize override (MB) to bytes for the in-memory store', () => {
    launchTracked({ maxDataSize: 1, capturedDataStore: 'memory' });
    expect(memSpy.mock.calls[0]?.[0]).toMatchObject({ maxDataSizeBytes: 1 * MB });
  });

  it('threads both maxDataSize (MB→bytes) and maxRecordingTime (s→ms) together', () => {
    launchTracked({ maxDataSize: 10, maxRecordingTime: 30, capturedDataStore: 'memory' });
    expect(memSpy.mock.calls[0]?.[0]).toMatchObject({
      maxDataSizeBytes: 10 * MB,
      maxRecordingTimeMs: 30_000,
    });
  });

  it('passes the byte cap to the file-backed store when dataDir is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-datasize-'));
    try {
      launchTracked({ dataDir: dir });
      expect(memSpy).not.toHaveBeenCalled();
      expect(fileSpy).toHaveBeenCalledTimes(1);
      expect(fileSpy.mock.calls[0]?.[0]).toMatchObject({ maxDataSizeBytes: 50 * MB });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds no store when an explicit captureStore override is supplied', () => {
    const emptySnapshot: CaptureSnapshot = {
      stream: async function* () {
        // no records
      },
      drainAll: async () => new Map(),
      release: () => {},
    };
    const fakeStore: CaptureStore = {
      add: () => {},
      tick: () => {},
      snapshot: () => emptySnapshot,
      clear: () => {},
    };
    launchTracked({ captureStore: fakeStore });
    expect(memSpy).not.toHaveBeenCalled();
    expect(fileSpy).not.toHaveBeenCalled();
  });
});
