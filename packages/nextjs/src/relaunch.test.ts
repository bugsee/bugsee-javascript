import {
  BugseeStatus,
  type Clock,
  getCarrierClient,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import type { NodeRuntime, SystemProbe } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The zero-config OTel provider self-registration is mocked (as in server.test.ts) so a real launch never
// stands up a global TracerProvider; relaunch.test only asserts that a relaunch goes through registerServer.
const { attachBugseeOtelProvider } = vi.hoisted(() => ({
  attachBugseeOtelProvider: vi.fn(async () => 'registered' as const),
}));
vi.mock('./otel-provider', () => ({ attachBugseeOtelProvider }));

import { type Bugsee, type NextjsServerOptions, registerServer, relaunch } from './server';

function fakeProcess(): NodeRuntime {
  const proc: NodeRuntime = {
    on: () => proc,
    off: () => proc,
    exit: () => {},
  };
  return proc;
}
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
const fixedClock: Clock = { wallNow: () => 5000, monotonicNow: () => 0 };
const okTransport = (): HttpTransport =>
  vi.fn(
    async (): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
    }),
  );
const opts = (carrier: object, over: Partial<NextjsServerOptions> = {}): NextjsServerOptions => ({
  process: fakeProcess(),
  systemProbe: probe,
  systemMetricsSampler: () => [],
  captureNetwork: false,
  capturedDataStore: 'memory',
  clock: fixedClock,
  recover: false,
  transport: okTransport(),
  carrier,
  ...over,
});

const started: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  attachBugseeOtelProvider.mockClear();
});

describe('@bugsee/nextjs/server relaunch', () => {
  it('rejects while nothing has been launched', async () => {
    await expect(relaunch(opts({}))).rejects.toThrow(/before launch/);
  });

  it('re-runs registerServer: the Next defaults (OTel consume + span-processor seam) are re-applied', async () => {
    const carrier = {};
    const first = registerServer('tok', opts(carrier));
    started.push(first);
    expect(attachBugseeOtelProvider).toHaveBeenCalledTimes(1);

    const onSpanProcessor = vi.fn();
    const second = await relaunch(opts(carrier, { onSpanProcessor }));
    started.push(second);

    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
    expect(getCarrierClient(carrier)).toBe(second);
    // The plain umbrella relaunch would NOT have wired the processor again: registerServer did.
    expect(onSpanProcessor).toHaveBeenCalledTimes(1);
    expect(attachBugseeOtelProvider).toHaveBeenCalledTimes(2);
  });
});
