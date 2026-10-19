// launchMain -> the REAL @bugsee/node launch -> a really assembled + uploaded bundle: `request.json`'s
// environment.hardware.gpu appears once the (fake) app.getGPUInfo settles, and is absent before it.

import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import { createMemoryCaptureStore } from '@bugsee/core';
import { type NodeRuntime, realSystemProbe } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';

const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, puts };
}

const fakeProcess = (): NodeRuntime => {
  const proc = { on: () => proc, off: () => proc, exit: () => {} } as unknown as NodeRuntime;
  return proc;
};

const ipcMain = { on: () => {}, removeListener: () => {} };

const bundleOf = (put: Uint8Array) => unzipSync(put);
const hardwareOf = (put: Uint8Array) =>
  (
    JSON.parse(strFromU8(bundleOf(put)['request.json'] as Uint8Array)) as {
      environment: { hardware: Record<string, unknown> };
    }
  ).environment.hardware;

function launchWith(app: { on: () => void; getGPUInfo?: (t: 'basic') => Promise<unknown> }) {
  const { fn: transport, puts } = recordingTransport();
  const client = launchMain('tok', {
    ipcMain,
    app,
    transport,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    captureNetwork: false,
    capturedDataStore: 'memory',
    detectHangs: false,
    process: fakeProcess(),
    systemProbe: realSystemProbe,
    systemMetricsSampler: () => [{ name: 'process_memory_rss', value: 42 }],
    onError: vi.fn(),
    carrier: {},
  });
  return { client, puts };
}

describe('Electron GPU -> real node launch -> assembled report', () => {
  it('carries hardware.gpu on a report assembled after getGPUInfo resolves, and not before', async () => {
    let resolve!: (v: unknown) => void;
    const { client, puts } = launchWith({
      on: () => {},
      getGPUInfo: () => new Promise<unknown>((r) => (resolve = r)),
    });

    await client.logException(new Error('before'));
    expect(puts).toHaveLength(1);
    expect(hardwareOf(puts[0] as Uint8Array)).not.toHaveProperty('gpu');

    resolve({ gpuDevice: [{ active: true, vendorString: 'NVIDIA', deviceString: 'RTX' }] });
    await flush();
    await client.logException(new Error('after'));
    expect(puts).toHaveLength(2);
    expect(hardwareOf(puts[1] as Uint8Array).gpu).toEqual({ vendor: 'NVIDIA', renderer: 'RTX' });
    await client.stop();
  });

  it('a rejected getGPUInfo: launch succeeds, no unhandledRejection, node traces still emit, no gpu', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { client, puts } = launchWith({
        on: () => {},
        getGPUInfo: () => Promise.reject(new Error('no acceleration')),
      });
      await flush();
      await flush();
      await client.logException(new Error('x'));
      expect(puts).toHaveLength(1);
      expect(hardwareOf(puts[0] as Uint8Array)).not.toHaveProperty('gpu');
      const files = bundleOf(puts[0] as Uint8Array);
      const traces = JSON.parse(strFromU8(files['traces.system.json'] as Uint8Array)) as Array<{
        name: string;
      }>;
      expect(traces.map((t) => t.name)).toContain('process_memory_rss');
      expect(unhandled).not.toHaveBeenCalled();
      await client.stop();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
