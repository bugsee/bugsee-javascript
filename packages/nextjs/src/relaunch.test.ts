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
  attachBugseeOtelProvider: vi.fn<(processor: unknown) => Promise<'registered'>>(
    async () => 'registered',
  ),
}));
vi.mock('./otel-provider', () => ({ attachBugseeOtelProvider }));

import {
  type Bugsee,
  type BugseeSpanProcessor,
  type NextjsServerOptions,
  registerServer,
  relaunch,
} from './server';

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
    // The provider slot is first-wins and already ours: it is NOT registered a second time (R3P-2).
    expect(attachBugseeOtelProvider).toHaveBeenCalledTimes(1);
    // ... and what the user's own provider got is the SAME stable processor, now bound to the new client.
    expect(onSpanProcessor.mock.calls[0]?.[0]).toBe(attachBugseeOtelProvider.mock.calls[0]?.[0]);
  });

  it('spans ended on the processor registered at FIRST launch reach the NEW client (R3P-2)', async () => {
    const carrier = {};
    const mk = () => {
      let tick: (() => void) | undefined;
      const scheduler = {
        setInterval: (cb: () => void, ms: number) => {
          if (ms === 7777) tick = cb;
          return 'h';
        },
        clearInterval: () => {},
      };
      const transport = vi.fn(
        async (_url: string, _options?: { body?: unknown }): Promise<HttpResponse> => ({
          status: 200,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({
              access_token: 'a',
              endpoint: 'https://s3.test/put',
              issueId: 'i',
              recordingId: 'r',
            }),
          ),
        }),
      );
      const names = () =>
        transport.mock.calls
          .filter(([url]) => url.endsWith('/v2/performance/transactions'))
          .flatMap(([, o]) => JSON.parse(String(o?.body)).transactions as { name: string }[])
          .map((t) => t.name);
      return {
        transport: transport as unknown as HttpTransport,
        scheduler,
        fire: async () => {
          tick?.();
          await new Promise((r) => setTimeout(r, 0));
        },
        names,
      };
    };
    const a = mk();
    const b = mk();
    const common = { performanceFlushIntervalMs: 7777, appStartTimeMs: 1000 };
    started.push(
      registerServer(
        'tok',
        opts(carrier, { ...common, transport: a.transport, scheduler: a.scheduler }),
      ),
    );
    // What the zero-config provider registered with OpenTelemetry at first launch: it can never be swapped.
    const registered = attachBugseeOtelProvider.mock
      .calls[0]?.[0] as unknown as BugseeSpanProcessor;
    started.push(
      await relaunch(opts(carrier, { ...common, transport: b.transport, scheduler: b.scheduler })),
    );

    registered.onEnd({
      spanContext: () => ({
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: 'aaaaaaaaaaaaaaaa',
      }),
      name: 'GET /after-relaunch',
      startTime: [1, 0],
      endTime: [2, 0],
      status: { code: 1 },
    });
    await b.fire();
    await a.fire();
    expect(b.names()).toContain('GET /after-relaunch');
    expect(a.names()).not.toContain('GET /after-relaunch');
  });
});
