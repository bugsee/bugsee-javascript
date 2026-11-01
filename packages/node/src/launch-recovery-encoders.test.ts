import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileStreamEncoder, LaunchRecoveryOptions } from '@bugsee/core';
import { runLaunchRecovery } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';
import { recoverInstances } from './recover-instances';

// A recovered bundle is assembled with the context `launch()` hands the dead-sibling scan. It must carry the stream encoders
// of the live export, or a recovered multi-window replay is merged into one member (a lane is split only when an encoder
// exists for the type).
vi.mock('@bugsee/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/core')>();
  return { ...actual, runLaunchRecovery: vi.fn(actual.runLaunchRecovery) };
});
vi.mock('./recover-instances', () => ({ recoverInstances: vi.fn(async () => {}) }));

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

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  vi.mocked(runLaunchRecovery).mockClear();
  vi.mocked(recoverInstances).mockClear();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const options = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProcess(),
  transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  detectCrashes: false,
  dataDir: mkdtempSync(join(tmpdir(), 'bugsee-recovery-enc-')),
  ...over,
});

const recoveryContext = async (over: Partial<BugseeLaunchOptions>) => {
  clients.push(launch('tok', options(over)));
  const args = vi.mocked(runLaunchRecovery).mock.calls[0]?.[0] as LaunchRecoveryOptions;
  await args.scan?.();
  const scanOptions = vi.mocked(recoverInstances).mock.calls[0]?.[0];
  return scanOptions?.context();
};

describe('launch — the recovery context carries the stream encoders', () => {
  it('hands the replay stream encoder to the dead-sibling scan', async () => {
    const replay: FileStreamEncoder = { begin: () => ({ write: () => [], end: () => [] }) };
    const context = await recoveryContext({ streamEncoders: { replay } });
    expect(context?.streamEncoders?.replay).toBe(replay);
  });

  it('adds none when the host gave none', async () => {
    const context = await recoveryContext({});
    expect(context).not.toHaveProperty('streamEncoders');
  });
});
