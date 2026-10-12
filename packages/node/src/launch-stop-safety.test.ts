import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BugseeStatus,
  createReportingRequest,
  getCarrier,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  LifecycleEvents,
  serializeBundle,
} from '@bugsee/core';
import { createNodeBundleStore, ensureDir, writeFileSecure } from '@bugsee/node-utils';
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

// group (node): a stopped client stays stopped, a repeat stop() is the same drain
// and RelaunchedAfterCrash only on honest evidence.

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

const dirs: string[] = [];
const dirFor = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-stopsafe-'));
  dirs.push(dir);
  return dir;
};
const FIXED = { pid: process.pid, threadId: 0, nonce: () => 'fixed' };
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
const track = (token: string, options: BugseeLaunchOptions): Bugsee => {
  const client = launch(token, options);
  live.push(client);
  return client;
};
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(50)));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('R2L-3 — launch() on a stopped client is refused; a new client comes from launch(token)', () => {
  it('does not restart core WITHOUT the platform teardown (handlers, carrier slot), and says so', async () => {
    const onError = vi.fn();
    const proc = fakeProcess();
    const client = launch('tok', opts({ process: proc.proc, onError }));
    expect(proc.total()).toBeGreaterThan(0);
    await client.stop();
    expect(proc.total()).toBe(0);
    client.launch();
    // Before the fix core came back to life here: capture on, no exit/signal handlers, no carrier slot.
    expect(client.isLaunched()).toBe(false);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
    expect(getStatus()).toBe(BugseeStatus.Stopped);
    expect(getCarrier().client).toBeUndefined();
    expect(proc.total()).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/) }),
    );
  });

  it('a refused launch() leaves the clean-stop marker alone: the subtree is still recoverable', async () => {
    const dir = dirFor();
    const client = launch(
      'tok',
      opts({ dataDir: dir, instanceIdentity: FIXED, onError: () => {} }),
    );
    await client.stop();
    const marker = join(dir, `${process.pid}-0-fixed`, '.stopped');
    expect(existsSync(marker)).toBe(true);
    client.launch();
    expect(existsSync(marker)).toBe(true);
  });

  it('the two-clients scenario: after stop(), launch(token) builds a NEW singleton and the old handle stays dead', async () => {
    const first = launch('tok', opts({ onError: () => {} }));
    await first.stop();
    first.launch(); // refused
    const second = track('tok', opts());
    expect(second).not.toBe(first);
    expect(getCarrier().client).toBe(second);
    expect(first.isLaunched()).toBe(false);
    expect(second.isLaunched()).toBe(true);
    first.launch(); // still refused while another client owns the process
    expect(first.isLaunched()).toBe(false);
    expect(getCarrier().client).toBe(second);
  });

  it('a stop() followed by relaunch() is the supported way back', async () => {
    launch('tok', opts());
    const second = await relaunch();
    live.push(second);
    expect(second.isLaunched()).toBe(true);
    expect(getStatus()).toBe(BugseeStatus.Launched);
  });
});

describe('R2L-14 — a killed client: stop() marks the subtree, a later launch() changes nothing', () => {
  it('leaves the clean-stop marker alone (core launch is a no-op on a killed client)', async () => {
    const dir = dirFor();
    const kill: HttpTransport = async () => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify({ ok: false, error: { type: 'KillSdk', message: 'off', code: 99099 } }),
      ),
    });
    const client = launch('tok', opts({ dataDir: dir, instanceIdentity: FIXED, transport: kill }));
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(client.isLaunched()).toBe(false)); // the collector killed the SDK
    await client.stop();
    const marker = join(dir, `${process.pid}-0-fixed`, '.stopped');
    expect(existsSync(marker)).toBe(true);
    client.launch();
    expect(client.isLaunched()).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('R2L-1 — a repeat stop() is the same drain: no .stopped marker while the upload still runs', () => {
  it('a hung upload: stop(timeout) is false, a REPEAT stop(timeout) is false too, and nothing is marked', async () => {
    const dir = dirFor();
    const transport: HttpTransport = () => new Promise(() => {});
    const client = launch('tok', opts({ dataDir: dir, instanceIdentity: FIXED, transport }));
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    const marker = join(dir, `${process.pid}-0-fixed`, '.stopped');
    expect(existsSync(marker)).toBe(false);
    // Before the fix this answered `true` at once, and the marker was written under the running upload.
    expect(await client.stop(30)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('a stop() while the first is draining waits for it, then marks once', async () => {
    const dir = dirFor();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: HttpTransport = async () => {
      await gate; // every request waits: the upload is in flight until released
      return {
        status: 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
      };
    };
    const client = launch('tok', opts({ dataDir: dir, instanceIdentity: FIXED, transport }));
    void client.logException(new Error('in flight'));
    const marker = join(dir, `${process.pid}-0-fixed`, '.stopped');
    const first = client.stop();
    let secondDone = false;
    const second = client.stop().then((drained) => {
      secondDone = true;
      return drained;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondDone).toBe(false);
    expect(existsSync(marker)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('R2D-2 — RelaunchedAfterCrash needs evidence that the previous run did not stop cleanly', () => {
  const plantDeadSibling = (
    dir: string,
    sub: string,
    withBundle: boolean,
    stopped = false,
  ): void => {
    ensureDir(join(dir, sub));
    writeFileSecure(
      join(dir, sub, 'owner.json'),
      JSON.stringify({
        instanceId: sub,
        pid: 999_999,
        threadId: 0,
        startedAt: Date.now(),
        version: '0',
      }),
    );
    if (withBundle) {
      const request = createReportingRequest({ source: { type: 'crash' }, id: 'inc-1' });
      createNodeBundleStore(join(dir, sub, 'pending')).put(
        'b1',
        serializeBundle({
          request: {
            type: 'crash',
            summary: 'left behind',
            severity: 3,
            source: { type: 'crash', mechanism: 'uncaught' },
            created_on: '2026-05-29T00:00:00Z',
            environment: {
              platform: { type: 'node', version: '1' },
              runtime: { type: 'node', version: '' },
              sdk: { version: '0', type: 'javascript' },
            },
            id: request.id,
          } as never,
          body: new Uint8Array([1, 2, 3]),
          fileName: 'p.zip',
        }),
      );
    }
    if (stopped) writeFileSecure(join(dir, sub, '.stopped'), '');
  };

  const run = async (dir: string): Promise<string[]> => {
    const seen: string[] = [];
    const client = track(
      'tok',
      opts({
        dataDir: dir,
        instanceIdentity: { pid: process.pid, threadId: 0, nonce: () => 'me' },
        lifecycleEventsListener: (type) => seen.push(type),
      }),
    );
    await vi.waitFor(() => expect(readdirSync(dir)).not.toContain('9-9-dead'));
    await client.flush();
    return seen;
  };

  it('is emitted, after Launched, when a dead sibling left an undelivered bundle', async () => {
    const dir = dirFor();
    plantDeadSibling(dir, '9-9-dead', true);
    const seen = await run(dir);
    expect(seen).toEqual([
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
      LifecycleEvents.RelaunchedAfterCrash,
    ]);
  });

  it('is NOT emitted for a cleanly stopped sibling, nor when there is nothing to recover', async () => {
    const dir = dirFor();
    plantDeadSibling(dir, '9-9-dead', true, true);
    expect(await run(dir)).not.toContain(LifecycleEvents.RelaunchedAfterCrash);
    const empty = dirFor();
    expect(await run(empty).catch(() => [])).not.toContain(LifecycleEvents.RelaunchedAfterCrash);
  });
});

describe('R2L-11 — relaunch() with NO options means defaults, with the seams kept', () => {
  it('drops a host Bugsee option and keeps the transport, process and error sink', async () => {
    const transport = okTransport();
    const proc = fakeProcess();
    const onError = vi.fn();
    launch('tok', opts({ transport, process: proc.proc, onError, captureLogs: false }));
    const second = await relaunch();
    live.push(second);
    expect(second.getHostLaunchOptions()).toEqual({});
    expect(second.getLaunchOptions()[BugseeOption.CaptureLogs]).toBe(true);
    // the kept process fake is the one the new client armed its handlers on
    expect(proc.total()).toBeGreaterThan(0);
    vi.mocked(transport).mockClear();
    await second.upload({ summary: 's' });
    expect(transport).toHaveBeenCalled();
  });
});
