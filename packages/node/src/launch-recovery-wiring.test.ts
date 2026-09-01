import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BundleStore, LaunchRecoveryOptions } from '@bugsee/core';
import { runLaunchRecovery } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';
import { type BugseeLaunchOptions, launch, type NodeRuntime } from './launch';

// The three arguments `launch()` hands core's `runLaunchRecovery` are pure WIRING: `pipeline` and `shared`
// have no behavioural consequence this tier can observe on its own (see the sibling behavioural test in
// `launch.test.ts` for `pipeline`, and R5-6 for why `shared: true` is unobservable — the own queue's
// namespace is fresh every launch, so holding it back only changes WHEN an empty queue is read). They are
// therefore pinned here directly, against the call. Core's `launch-recovery.test.ts` owns the semantics.
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

const memBundleStore = (): BundleStore => {
  const map = new Map<string, Uint8Array>();
  return {
    put: (id, bytes) => void map.set(id, bytes),
    list: () => [...map.keys()],
    read: (id) => map.get(id),
    remove: (id) => void map.delete(id),
  };
};

const clients: ReturnType<typeof launch>[] = [];
afterEach(async () => {
  // BOUNDED stop. `stop()` with no argument drains without a deadline (`core/src/client.ts:449-457`),
  // and these clients are launched against a collector that never answers, so the control plane retries
  // on its 5s/10s/20s ladder and the drain outlives vitest's 10s hook timeout. A timed-out afterEach
  // never reaches `mockClear()` below, so the NEXT test observed two `runLaunchRecovery` calls instead
  // of one — the failure read as a wiring bug in the test above it, which is what made it look flaky.
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  vi.mocked(runLaunchRecovery).mockClear();
  vi.restoreAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const options = (over: Partial<BugseeLaunchOptions> = {}): BugseeLaunchOptions => ({
  process: fakeProcess(),
  transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  detectCrashes: false,
  ...over,
});

/** The single `runLaunchRecovery` call this launch made. */
const recoveryArgs = (over: Partial<BugseeLaunchOptions>): LaunchRecoveryOptions => {
  clients.push(launch('tok', options(over)));
  expect(runLaunchRecovery).toHaveBeenCalledTimes(1);
  return vi.mocked(runLaunchRecovery).mock.calls[0]?.[0] as LaunchRecoveryOptions;
};

describe('launch — the recovery wiring handed to core', () => {
  it('passes the BASE pipeline, never the durable queue, with an injected bundle store', () => {
    const args = recoveryArgs({ bundleStore: memBundleStore() });

    expect(args.queue).toBeDefined(); // there IS a durable queue to get this wrong with
    expect(args.pipeline).not.toBe(args.queue);
    // Structural, so it also rejects some OTHER durable pipeline: a base pipeline has no `recover`.
    expect((args.pipeline as { recover?: unknown }).recover).toBeUndefined();
  });

  it('passes the BASE pipeline, never the durable queue, with a per-instance dataDir queue', () => {
    const args = recoveryArgs({ dataDir: mkdtempSync(join(tmpdir(), 'bugsee-wiring-')) });

    expect(args.queue).toBeDefined();
    expect(args.pipeline).not.toBe(args.queue);
    expect((args.pipeline as { recover?: unknown }).recover).toBeUndefined();
  });

  it('marks the queue SHARED only when the bundle store is the integrator’s', () => {
    // false is the direction that decides ordering for every default launch: a per-instance queue is
    // this launch's own, fresh, and must be drained up front rather than held back for the scan.
    expect(recoveryArgs({ dataDir: mkdtempSync(join(tmpdir(), 'bugsee-wiring-')) }).shared).toBe(
      false,
    );
  });

  it('marks an INJECTED bundle store as shared, so the dead-sibling scan gets first refusal', () => {
    expect(recoveryArgs({ bundleStore: memBundleStore() }).shared).toBe(true);
  });
});
