// launchMain -> the REAL @bugsee/node launch (real providers, real tracker, real events mux) -> a really assembled +
// uploaded bundle: `app_metrics` rides traces.system next to the node traces, `child_process_gone` lands on
// events.system, and the lazy mux attaches/releases exactly with `captureSystemEvents` / `client.stop()`.

import type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import { createMemoryCaptureStore } from '@bugsee/core';
import { type NodeRuntime, realSystemProbe, resetProcessTracker } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';

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
    if (url === 'https://s3.test/put') puts.push(options.body as Uint8Array);
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, puts };
}

/** A process whose listener table is observable (the node events source registers on it). */
function fakeProcess() {
  const table = new Map<string, Array<(...a: unknown[]) => void>>();
  const proc = {
    on: (e: string, l: (...a: unknown[]) => void) => {
      table.set(e, [...(table.get(e) ?? []), l]);
      return proc;
    },
    off: (e: string, l: (...a: unknown[]) => void) => {
      table.set(
        e,
        (table.get(e) ?? []).filter((x) => x !== l),
      );
      return proc;
    },
    listeners: (e: string) => [...(table.get(e) ?? [])],
    exit: () => {},
    kill: () => {},
    stderr: { write: () => true },
    pid: process.pid,
  } as unknown as NodeRuntime;
  return { proc, count: (e: string) => table.get(e)?.length ?? 0 };
}

/** Fires EVERY armed interval on `tick()` (the provider refresh and the tracker poll share it). */
function manualScheduler() {
  const armed = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (cb: () => void) => {
      const id = next++;
      armed.set(id, cb);
      return id;
    },
    clearInterval: (id: unknown) => {
      armed.delete(id as number);
    },
    tick: () => {
      for (const cb of [...armed.values()]) cb();
    },
    get armed() {
      return armed.size;
    },
  };
}

type GoneL = (event: unknown, details: unknown) => void;
function fakeApp(getAppMetrics?: () => unknown) {
  const gone: GoneL[] = [];
  const app = {
    on: vi.fn((event: string, l: GoneL) => {
      if (event === 'child-process-gone') gone.push(l);
    }),
    removeListener: vi.fn((event: string, l: GoneL) => {
      const i = gone.indexOf(l);
      if (event === 'child-process-gone' && i >= 0) gone.splice(i, 1);
    }),
    ...(getAppMetrics !== undefined ? { getAppMetrics } : {}),
  };
  return { app, gone };
}

const metric = {
  pid: 7,
  type: 'GPU',
  cpu: { percentCPUUsage: 4 },
  memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 },
};

function launchWith(
  over: {
    app: ReturnType<typeof fakeApp>['app'];
    captureSystemEvents?: boolean;
    scheduler?: ReturnType<typeof manualScheduler>;
  },
  fp = fakeProcess(),
) {
  const { fn: transport, puts } = recordingTransport();
  const client = launchMain('tok', {
    ipcMain: { on: () => {}, removeListener: () => {} },
    app: over.app,
    transport,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    captureNetwork: false,
    capturedDataStore: 'memory',
    detectHangs: false,
    process: fp.proc,
    systemProbe: realSystemProbe,
    onError: vi.fn(),
    carrier: {},
    ...(over.captureSystemEvents !== undefined
      ? { captureSystemEvents: over.captureSystemEvents }
      : {}),
    ...(over.scheduler !== undefined ? { scheduler: over.scheduler } : {}),
  });
  return { client, puts, fp };
}

const fileOf = <T>(put: Uint8Array, name: string): T[] =>
  JSON.parse(strFromU8(unzipSync(put)[name] as Uint8Array)) as T[];

afterEach(() => {
  resetProcessTracker();
});

describe('Electron main telemetry -> real node launch -> assembled report', () => {
  it('app_metrics rides traces.system NEXT TO the node traces, once, with the documented shape', async () => {
    const scheduler = manualScheduler();
    const { app } = fakeApp(() => [metric]);
    const { client, puts } = launchWith({ app, scheduler });
    scheduler.tick(); // first poll: the priming read happened at arm, so this is the first sample
    scheduler.tick();
    await client.logException(new Error('x'));
    const traces = fileOf<{ name: string; value: unknown }>(
      puts[0] as Uint8Array,
      'traces.system.json',
    );
    const names = traces.map((t) => t.name);
    expect(names).toContain('process_memory_rss'); // the node set still emits
    expect(names).toContain('app_metrics');
    const metrics = traces.find((t) => t.name === 'app_metrics');
    expect(metrics?.value).toEqual({
      processes: [
        { type: 'GPU', pid: 7, cpu_percent: 4, working_set_mb: 2, peak_working_set_mb: 4 },
      ],
    });
    await client.stop();
  });

  it('a getAppMetrics that throws: node traces still emit, no app_metrics', async () => {
    const scheduler = manualScheduler();
    const { app } = fakeApp(() => {
      throw new Error('metrics');
    });
    const { client, puts } = launchWith({ app, scheduler });
    scheduler.tick();
    await client.logException(new Error('x'));
    const names = fileOf<{ name: string }>(puts[0] as Uint8Array, 'traces.system.json').map(
      (t) => t.name,
    );
    expect(names).toContain('process_memory_rss');
    expect(names).not.toContain('app_metrics');
    await client.stop();
  });

  it('captureSystemEvents ON: node handlers AND the child-process-gone listener attach; child_process_gone lands on events.system; process_started once', async () => {
    const { app, gone } = fakeApp();
    const { client, puts, fp } = launchWith({ app });
    expect(fp.count('warning')).toBe(1); // the node source is live
    expect(gone).toHaveLength(1);
    gone[0]?.({}, { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' });
    await client.logException(new Error('x'));
    const events = fileOf<{ name: string; params?: unknown }>(
      puts[0] as Uint8Array,
      'events.system.json',
    );
    expect(events.filter((e) => e.name === 'process_started')).toHaveLength(1);
    expect(events.find((e) => e.name === 'child_process_gone')?.params).toEqual({
      type: 'GPU',
      reason: 'crashed',
      exitCode: 139,
      name: 'GPU Process',
    });
    await client.stop();
  });

  it('captureSystemEvents OFF: NO node handlers and NO child-process-gone listener', async () => {
    const { app, gone } = fakeApp();
    const { client, fp } = launchWith({ app, captureSystemEvents: false });
    expect(fp.count('warning')).toBe(0);
    expect(fp.count('beforeExit')).toBe(0);
    expect(app.on).not.toHaveBeenCalledWith('child-process-gone', expect.anything());
    expect(gone).toHaveLength(0);
    await client.stop();
  });

  it('client.stop() releases the node handlers, the child-process-gone listener and the metrics timer', async () => {
    const scheduler = manualScheduler();
    const { app, gone } = fakeApp(() => [metric]);
    const { client, fp } = launchWith({ app, scheduler });
    expect(gone).toHaveLength(1);
    expect(fp.count('warning')).toBe(1);
    const armedBefore = scheduler.armed;
    expect(armedBefore).toBeGreaterThan(0);
    await client.stop();
    expect(gone).toHaveLength(0);
    expect(app.removeListener).toHaveBeenCalledWith('child-process-gone', expect.any(Function));
    expect(fp.count('warning')).toBe(0);
    expect(scheduler.armed).toBe(0);
  });
});
