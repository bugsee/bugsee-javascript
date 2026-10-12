import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLaunchRecovery } from '@bugsee/core';
import { writeFileSecure } from '@bugsee/node-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

// stop() must wait for the launch-time recovery (which may still be staging bundles into this
// instance's subtree) before it marks the subtree recoverable, and must NOT mark while it still runs.
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
const opts = (dir: string, over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProcess(),
  transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  detectCrashes: false,
  dataDir: dir,
  instanceIdentity: FIXED,
  ...over,
});
const dirFor = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-stoprec-'));
  dirs.push(dir);
  return dir;
};
const stopped = (dir: string): boolean =>
  existsSync(join(dir, `${process.pid}-0-fixed`, '.stopped'));

afterEach(() => {
  vi.mocked(writeFileSecure).mockClear();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('node stop() and the launch-time recovery (L6)', () => {
  it('waits for the recovery, then marks the subtree', async () => {
    let finish: () => void = () => {};
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const dir = dirFor();
    const client = launch('tok', opts(dir));
    let settled = false;
    const stopping = client.stop().then((drained) => {
      settled = true;
      return drained;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // stop() is waiting on the recovery
    expect(stopped(dir)).toBe(false);
    finish();
    expect(await stopping).toBe(true);
    expect(stopped(dir)).toBe(true);
  });

  it('with a deadline, does not mark the subtree while the recovery is still running', async () => {
    vi.mocked(runLaunchRecovery).mockImplementationOnce(() => new Promise<void>(() => {}));
    const dir = dirFor();
    const client = launch('tok', opts(dir));
    await client.stop(40);
    expect(stopped(dir)).toBe(false); // recovery may still be staging bundles into the subtree
  });

  it('a recovery that already settled does not hold stop() up', async () => {
    const dir = dirFor();
    const client = launch('tok', opts(dir));
    await new Promise((r) => setTimeout(r, 30));
    expect(await client.stop(40)).toBe(true);
    expect(stopped(dir)).toBe(true);
  });
});

describe('overlapping stops and the recovery wait', () => {
  it('only the latest of two overlapping stops writes the marker (exactly once)', async () => {
    let finish: () => void = () => {};
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const dir = dirFor();
    const client = launch('tok', opts(dir));
    const first = client.stop();
    client.launch();
    const second = client.stop();
    finish();
    await Promise.all([first, second]);
    const markerWrites = vi
      .mocked(writeFileSecure)
      .mock.calls.filter(([file]) => String(file).endsWith('.stopped'));
    expect(markerWrites).toHaveLength(1);
    expect(stopped(dir)).toBe(true);
  });

  it('releases its deadline timer once the recovery wins the race', async () => {
    vi.mocked(runLaunchRecovery).mockImplementationOnce(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const dir = dirFor();
    const client = launch('tok', opts(dir));
    await client.stop(60_000);
    expect(clear).toHaveBeenCalled();
  });
});
