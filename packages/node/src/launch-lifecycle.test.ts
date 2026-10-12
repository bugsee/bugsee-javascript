import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BugseeStatus,
  createCaptureExporter,
  createMemoryCaptureStore,
  getCarrier,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  getStatus,
  launch,
  type NodeRuntime,
  relaunch,
} from './launch';

// Lifecycle (launch -> stop -> launch) behaviour of the Node composition root: status, relaunch, the
// introspectable launch options, and that repeated cycles leave nothing behind.

const probe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osPlatform: () => 'darwin',
  osRelease: () => '6.0',
  osArch: () => 'arm64',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  freeMemory: () => 4_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

// A process fake that counts live listeners per event.
function fakeProcess() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const proc = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return proc;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    listeners: (event: string) => [...(listeners.get(event) ?? [])],
    stderr: { write: () => true },
    exit: vi.fn(),
    kill: vi.fn(),
    pid: process.pid,
  } as unknown as NodeRuntime;
  return {
    proc,
    total: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
}

const okTransport = (): HttpTransport =>
  vi.fn(
    async (_url: string, _options: HttpRequestOptions = {}): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
    }),
  );

let nonce = 0;
const dirs: string[] = [];
const opts = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProcess().proc,
  transport: okTransport(),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  detectHangs: false,
  ...over,
});

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const track = (token: string, options: BugseeLaunchOptions) => {
  const client = launch(token, options);
  live.push(client);
  return client;
};

describe('status', () => {
  it('is Stopped before any launch, Launched after, Stopping while draining, Stopped after', async () => {
    expect(getStatus()).toBe(BugseeStatus.Stopped);
    const client = track('tok', opts());
    expect(getStatus()).toBe(BugseeStatus.Launched);
    expect(client.getStatus()).toBe(BugseeStatus.Launched);

    const stopping = client.stop();
    expect(getStatus()).toBe(BugseeStatus.Stopping);
    expect(client.getStatus()).toBe(BugseeStatus.Stopping);
    await stopping;
    expect(getStatus()).toBe(BugseeStatus.Stopped);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('a repeat launch while launched returns the singleton and keeps Launched', () => {
    const first = track('tok', opts());
    const onError = vi.fn();
    expect(launch('tok', opts({ onError }))).toBe(first);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getStatus()).toBe(BugseeStatus.Launched);
  });

  it('a repeat or late stop() neither tears down twice nor evicts a relaunched client', async () => {
    const first = track('tok', opts());
    await first.stop();
    const second = track('tok', opts());
    await first.stop(); // stale, repeated
    expect(getStatus()).toBe(BugseeStatus.Launched);
    expect(launch('tok', opts({ onError: () => {} }))).toBe(second); // still the singleton
  });

  it('a repeat stop() tears the instrumentation down exactly once', async () => {
    const uninstall = vi.fn();
    const client = track(
      'tok',
      opts({
        serverInstrumentations: [{ install: () => {}, uninstall }],
        instrumentIncomingRequests: true,
      }),
    );
    await client.stop();
    const after = uninstall.mock.calls.length;
    await client.stop();
    expect(uninstall).toHaveBeenCalledTimes(after);
  });

  it('stopping a client that no longer owns the slot does not evict the newer one', async () => {
    const stale = track('tok', opts());
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
    const newer = track('tok', opts());
    await stale.stop();
    expect(getCarrier().client).toBe(newer);
    expect(getStatus()).toBe(BugseeStatus.Launched);
  });

  it('stopping a client that no longer owns the slot leaves the newer client and its status alone', async () => {
    const stale = track('tok', opts());
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__; // the slot is reset under it
    const hang: HttpTransport = () => new Promise(() => {});
    const newer = track('tok', opts({ transport: hang }));
    void newer.logException(new Error('in flight')); // keeps newer's stop() draining
    void newer.stop();
    expect(getStatus()).toBe(BugseeStatus.Stopping);
    await stale.stop();
    expect(getStatus()).toBe(BugseeStatus.Stopping); // the stale stop settled without touching it
  });

  it('a relaunch while the previous stop is still draining keeps its own status', async () => {
    const first = track('tok', opts());
    const stopping = first.stop();
    const second = track('tok', opts());
    await stopping;
    expect(getStatus()).toBe(BugseeStatus.Launched);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
  });

  it('stop() on a client that is no longer launched (killed) reports Stopped and frees the slot', async () => {
    const client = track('tok', opts());
    vi.spyOn(client, 'isLaunched').mockReturnValue(false);
    expect(await client.stop()).toBe(true);
    expect(getStatus()).toBe(BugseeStatus.Stopped);
    expect(getCarrier().client).toBeUndefined();
  });
});

describe('launch -> stop -> launch cycles leave nothing behind', () => {
  it('3 cycles: process listeners, console, the http server patch and the data dir all return to baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-cycle-'));
    dirs.push(dir);
    const originalLog = console.log;
    const originalEmit = http.Server.prototype.emit;
    const proc = fakeProcess();
    const options = (): BugseeLaunchOptions =>
      opts({
        process: proc.proc,
        dataDir: dir,
        instanceIdentity: { pid: process.pid, threadId: 0, nonce: () => `n${nonce++}` },
        instrumentIncomingRequests: true,
      });

    let running = -1;
    for (let cycle = 0; cycle < 3; cycle++) {
      const client = launch('tok', options());
      expect(client.getStatus()).toBe(BugseeStatus.Launched);
      expect(console.log).not.toBe(originalLog); // patched once…
      expect(http.Server.prototype.emit).not.toBe(originalEmit);
      expect(proc.total()).toBeGreaterThan(0);
      if (running === -1) running = proc.total();
      expect(proc.total()).toBe(running); // no accumulation across cycles

      await client.stop();
      expect(getStatus()).toBe(BugseeStatus.Stopped);
      expect(proc.total()).toBe(0);
      expect(console.log).toBe(originalLog); // …and fully restored
      expect(http.Server.prototype.emit).toBe(originalEmit);
      expect(getCarrier().client).toBeUndefined();
    }
    // Each cycle wrote its own subtree; none is left half-owned by a still-live writer (stop() closed it).
    // Every stopped cycle's subtree was recovered and removed by the next launch; only the last remains.
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1));
  });

  it('a log line is captured exactly once per cycle (no stacked interceptor)', async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
      const client = track('tok', opts({ captureStore: store }));
      console.log(`marker-${cycle}`);
      const logs = (await createCaptureExporter(store).drain()).get('log') ?? [];
      const hits = logs.filter((e) => JSON.stringify(e.data).includes(`marker-${cycle}`));
      expect(hits).toHaveLength(1);
      await client.stop();
    }
  });
});

describe('a clean stop marks its on-disk subtree recoverable, an unclean one does not', () => {
  const FIXED = { pid: process.pid, threadId: 0, nonce: () => 'fixed' };
  const dirFor = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-release-'));
    dirs.push(dir);
    return dir;
  };
  const subtree = (dir: string) => join(dir, `${process.pid}-0-fixed`);
  const stopped = (dir: string) => existsSync(join(subtree(dir), '.stopped'));

  it('marks the subtree after a fully drained stop', async () => {
    const dir = dirFor();
    const client = launch('tok', opts({ dataDir: dir, instanceIdentity: FIXED }));
    expect(stopped(dir)).toBe(false); // a running instance is never marked
    expect(await client.stop()).toBe(true);
    expect(stopped(dir)).toBe(true);
  });

  it('does NOT mark the subtree when the drain timed out (the upload may still be running)', async () => {
    const dir = dirFor();
    const transport: HttpTransport = () => new Promise(() => {});
    const client = launch('tok', opts({ dataDir: dir, instanceIdentity: FIXED, transport }));
    void client.logException(new Error('in flight'));
    expect(await client.stop(20)).toBe(false);
    expect(stopped(dir)).toBe(false);
  });

  it('routes a failure writing the marker to onError and still resolves the stop', async () => {
    const dir = dirFor();
    const onError = vi.fn();
    const client = launch('tok', opts({ dataDir: dir, instanceIdentity: FIXED, onError }));
    // Replace the marker path by a directory so the write fails.
    mkdirSync(join(subtree(dir), '.stopped'));
    expect(await client.stop()).toBe(true);
    expect(onError).toHaveBeenCalled();
    expect(getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('the NEXT launch in the same process recovers the stopped instance and removes its subtree', async () => {
    const dir = dirFor();
    let n = 0;
    const identity = { pid: process.pid, threadId: 0, nonce: () => `c${n++}` };
    const first = launch('tok', opts({ dataDir: dir, instanceIdentity: identity }));
    await first.stop();
    expect(readdirSync(dir)).toHaveLength(1);
    track('tok', opts({ dataDir: dir, instanceIdentity: identity }));
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([`${process.pid}-0-c1`]));
  });
});

describe('launch options introspection', () => {
  it('getLaunchOptions is host over defaults by canonical key; getHostLaunchOptions only what the host set', () => {
    const client = track('tok', opts({ captureLogs: false, maxRecordingTime: 30 }));
    const effective = client.getLaunchOptions();
    expect(effective[BugseeOption.CaptureLogs]).toBe(false);
    expect(effective[BugseeOption.Duration]).toBe(30);
    expect(effective[BugseeOption.CaptureSystemEvents]).toBe(true); // default
    expect(effective[BugseeOption.MaxDataSize]).toBe(50); // node default
    expect(client.getHostLaunchOptions()).toMatchObject({
      [BugseeOption.CaptureLogs]: false,
      [BugseeOption.Duration]: 30,
    });
    expect(client.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureSystemEvents]);
  });

  it('never exposes secrets: no token, no transport/headers, only registered canonical keys', () => {
    const client = track('SECRET-APP-TOKEN', opts({ endpoint: 'https://x.test' }));
    for (const view of [client.getLaunchOptions(), client.getHostLaunchOptions()]) {
      expect(JSON.stringify(view)).not.toContain('SECRET-APP-TOKEN');
      for (const key of Object.keys(view)) expect(key).toMatch(/^com\.bugsee\.option\./);
    }
  });

  it('the host options are replaced on each launch, not merged', async () => {
    const first = launch('tok', opts({ captureLogs: false }));
    expect(first.getHostLaunchOptions()).toHaveProperty([BugseeOption.CaptureLogs], false);
    await first.stop();
    const second = track('tok', opts());
    expect(second.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureLogs]);
    expect(second.getLaunchOptions()[BugseeOption.CaptureLogs]).toBe(true);
  });
});

describe('relaunch', () => {
  it('rejects before any launch', async () => {
    await expect(relaunch()).rejects.toThrow(/before launch/);
  });

  it('stops the current client, then launches a FRESH one with the same token and options', async () => {
    const first = launch('tok-1', opts({ captureLogs: false }));
    const second = await relaunch();
    live.push(second);
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
    expect(getStatus()).toBe(BugseeStatus.Launched);
    expect(second.getHostLaunchOptions()).toHaveProperty([BugseeOption.CaptureLogs], false);
  });

  it('uses NEW options when given (they replace the previous host options)', async () => {
    launch('tok', opts({ captureLogs: false }));
    const second = await relaunch(opts({ maxRecordingTime: 15 }));
    live.push(second);
    expect(second.getHostLaunchOptions()).not.toHaveProperty([BugseeOption.CaptureLogs]);
    expect(second.getLaunchOptions()[BugseeOption.Duration]).toBe(15);
  });

  it('3 relaunches in a row leave exactly one live client and no accumulated process listeners', async () => {
    const proc = fakeProcess();
    launch('tok', opts({ process: proc.proc }));
    const baseline = proc.total();
    for (let i = 0; i < 3; i++) {
      live.push(await relaunch());
      expect(proc.total()).toBe(baseline);
    }
  });
});
