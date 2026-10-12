import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpTransport, runLaunchRecovery } from '@bugsee/core';
import { writeFileSecure } from '@bugsee/node-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  launch,
  type NodeRuntime,
  relaunch,
} from './launch';
import { isCleanlyStopped } from './liveness';

// node half: (the shared stop drain marks the subtree from whichever stop observes it
// settle, exactly once) and (a relaunch into a pinned subtree is live, not recoverable).
vi.mock('@bugsee/node-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/node-utils')>();
  return { ...actual, writeFileSecure: vi.fn(actual.writeFileSecure) };
});
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});

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
const fakeProcess = (): NodeRuntime =>
  ({
    on() {
      return this;
    },
    off() {
      return this;
    },
    listeners: () => [],
    stderr: { write: () => {} },
    exit: () => {},
    kill: () => {},
    pid: process.pid,
  }) as unknown as NodeRuntime;

const FIXED = { pid: process.pid, threadId: 0, nonce: () => 'fixed' };
const dirs: string[] = [];
const dirFor = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-shared-drain-'));
  dirs.push(dir);
  return dir;
};
const opts = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProcess(),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  detectCrashes: false,
  detectHangs: false,
  instanceIdentity: FIXED,
  ...over,
});
const ok = (): { status: number; headers: Record<string, string>; body: Uint8Array } => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
});
/** A transport whose every request waits for `release()`. */
const gated = (): { transport: HttpTransport; release: () => void } => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    transport: async () => {
      await gate;
      return ok();
    },
    release: () => release(),
  };
};
const subtree = (dir: string): string => join(dir, `${process.pid}-0-fixed`);
const marker = (dir: string): string => join(subtree(dir), '.stopped');
const markerWrites = (): number =>
  vi.mocked(writeFileSecure).mock.calls.filter(([file]) => String(file).endsWith('.stopped'))
    .length;
const live: Bugsee[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(20)));
  vi.mocked(writeFileSecure).mockClear();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('the.stopped marker follows the shared drain, whichever stop observes it settle', () => {
  it('stop() then stop(20): the 20 ms call times out, the first still marks when the drain finishes', async () => {
    const dir = dirFor();
    const { transport, release } = gated();
    const client = launch('tok', opts({ dataDir: dir, transport }));
    live.push(client);
    void client.logException(new Error('in flight'));
    const first = client.stop();
    expect(await client.stop(20)).toBe(false);
    expect(existsSync(marker(dir))).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(existsSync(marker(dir))).toBe(true);
    expect(markerWrites()).toBe(1);
  });

  it('stop(30) times out, the upload then finishes: the marker is written without any further stop()', async () => {
    const dir = dirFor();
    const { transport, release } = gated();
    const client = launch('tok', opts({ dataDir: dir, transport }));
    live.push(client);
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    expect(existsSync(marker(dir))).toBe(false);
    release();
    await vi.waitFor(() => expect(existsSync(marker(dir))).toBe(true));
    // …and a repeat stop() now answers true, without writing a second marker
    expect(await client.stop()).toBe(true);
    expect(markerWrites()).toBe(1);
  });

  it('stop(30) times out, then stop() waits for the real drain, marks, and returns true', async () => {
    const dir = dirFor();
    const { transport, release } = gated();
    const client = launch('tok', opts({ dataDir: dir, transport }));
    live.push(client);
    void client.logException(new Error('in flight'));
    expect(await client.stop(30)).toBe(false);
    const again = client.stop();
    release();
    expect(await again).toBe(true);
    expect(existsSync(marker(dir))).toBe(true);
    expect(markerWrites()).toBe(1);
  });

  it('a stop() during the launch recovery: the marker waits for the recovery, then appears with no further stop', async () => {
    let finish: () => void = () => {};
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const dir = dirFor();
    const client = launch('tok', opts({ dataDir: dir, transport: async () => ok() }));
    live.push(client);
    expect(await client.stop(20)).toBe(true); // drained, but the recovery is still running
    expect(existsSync(marker(dir))).toBe(false);
    finish();
    await vi.waitFor(() => expect(existsSync(marker(dir))).toBe(true));
    expect(markerWrites()).toBe(1);
  });

  it('a killed client is marked exactly once, however many stops follow', async () => {
    const dir = dirFor();
    const kill: HttpTransport = async () => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify({ ok: false, error: { type: 'KillSdk', message: 'off', code: 99099 } }),
      ),
    });
    const client = launch('tok', opts({ dataDir: dir, transport: kill }));
    live.push(client);
    await client.logException(new Error('boom'));
    await vi.waitFor(() => expect(client.isLaunched()).toBe(false));
    await client.stop();
    await client.stop();
    expect(existsSync(marker(dir))).toBe(true);
    expect(markerWrites()).toBe(1);
  });

  it('a hung upload is never marked, however often stop() is called', async () => {
    const dir = dirFor();
    const client = launch('tok', opts({ dataDir: dir, transport: () => new Promise(() => {}) }));
    live.push(client);
    void client.logException(new Error('in flight'));
    expect(await client.stop(20)).toBe(false);
    expect(await client.stop(20)).toBe(false);
    expect(existsSync(marker(dir))).toBe(false);
    expect(markerWrites()).toBe(0);
  });

  it('an old client finishing its drain AFTER a relaunch into the same pinned subtree does not mark the live one', async () => {
    const dir = dirFor();
    const { transport, release } = gated();
    const old = launch('tok', opts({ dataDir: dir, transport }));
    void old.logException(new Error('in flight'));
    expect(await old.stop(20)).toBe(false); // still draining
    const fresh = await relaunch({
      dataDir: dir,
      transport: async () => ok(),
      process: fakeProcess(),
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
      detectCrashes: false,
      detectHangs: false,
      instanceIdentity: FIXED, // an explicit pin: the same subtree
      stopTimeoutMs: 20,
    } as BugseeLaunchOptions);
    live.push(fresh);
    release(); // the old drain finishes now
    expect(await old.stop()).toBe(true); // resolves when the shared drain (and the marker decision) is done
    expect(existsSync(marker(dir))).toBe(false);
    expect(isCleanlyStopped(subtree(dir))).toBe(false);
  });

  it('two live launches pinned to ONE subtree (separate carriers): stopping one never marks it, stopping the last does', async () => {
    const dir = dirFor();
    const a = launch('tok', opts({ dataDir: dir, transport: async () => ok(), carrier: {} }));
    const b = launch('tok', opts({ dataDir: dir, transport: async () => ok(), carrier: {} }));
    live.push(b);
    expect(await a.stop()).toBe(true);
    expect(existsSync(marker(dir))).toBe(false); // b is still writing here
    expect(await b.stop()).toBe(true);
    expect(existsSync(marker(dir))).toBe(true); // nobody is left
  });

  it('an UNPINNED relaunch (fresh subtree) still marks the OLD subtree stopped when its late drain finishes', async () => {
    const dir = dirFor();
    const { transport, release } = gated();
    const unpinned = { instanceIdentity: undefined } as Partial<BugseeLaunchOptions>;
    const old = launch('tok', opts({ dataDir: dir, transport, ...unpinned }));
    void old.logException(new Error('in flight'));
    expect(await old.stop(20)).toBe(false); // still draining
    const fresh = await relaunch({
      dataDir: dir,
      transport: async () => ok(),
      process: fakeProcess(),
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
      detectCrashes: false,
      detectHangs: false,
      stopTimeoutMs: 20,
    } as BugseeLaunchOptions);
    live.push(fresh);
    const roots = readdirSync(dir).filter((name) => /^\d+-\d+-/.test(name));
    expect(roots.length).toBe(2); // the old subtree and the relaunched one are different roots
    release();
    expect(await old.stop()).toBe(true);
    const marked = roots.filter((name) => existsSync(join(dir, name, '.stopped')));
    expect(marked.length).toBe(1); // exactly the OLD subtree is recoverable; the live one is not
    expect(isCleanlyStopped(join(dir, marked[0] as string))).toBe(true);
  });
});

describe('relaunch() does not keep instanceIdentity; a launch always clears a stale marker', () => {
  it('a plain relaunch() gets a NEW subtree even though the first launch pinned its identity', async () => {
    const dir = dirFor();
    const first = launch('tok', opts({ dataDir: dir, transport: async () => ok() }));
    await first.stop();
    const second = await relaunch();
    live.push(second);
    const subtrees = readdirSync(dir).filter((name) => /^\d+-\d+-/.test(name));
    expect(subtrees.some((name) => name !== `${process.pid}-0-fixed`)).toBe(true);
  });

  it('relaunch() into an explicitly pinned subtree removes the stale.stopped, so a sibling cannot claim it', async () => {
    const dir = dirFor();
    const first = launch('tok', opts({ dataDir: dir, transport: async () => ok() }));
    await first.stop();
    expect(isCleanlyStopped(subtree(dir))).toBe(true);
    const second = await relaunch({ instanceIdentity: FIXED } as BugseeLaunchOptions);
    live.push(second);
    expect(existsSync(join(subtree(dir), 'owner.json'))).toBe(true);
    expect(isCleanlyStopped(subtree(dir))).toBe(false);
  });
});

describe('a launch that throws after registering its subtree root does not leak the live count', () => {
  it('a later launch into the same pinned subtree still writes .stopped when it stops', async () => {
    const dir = dirFor();
    const hostile = fakeProcess();
    (hostile as unknown as { on: () => never }).on = () => {
      throw new Error('host process refuses listeners');
    };
    // The owner file is written (and, in the buggy build, the root registered) before the listeners go on.
    expect(() =>
      launch(
        'tok',
        opts({
          dataDir: dir,
          transport: async () => ok(),
          process: hostile,
          detectCrashes: true,
          carrier: {},
        }),
      ),
    ).toThrow('host process refuses listeners');
    expect(existsSync(join(subtree(dir), 'owner.json'))).toBe(true); // the failed launch got that far

    const next = launch('tok', opts({ dataDir: dir, transport: async () => ok(), carrier: {} }));
    expect(await next.stop()).toBe(true);
    expect(existsSync(marker(dir))).toBe(true); // nobody is left in the subtree
  });
});
