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

// Every processor the umbrella builds, with its ORIGINAL shutdown spied before the adapter wraps it (R4H-9).
const { created } = vi.hoisted(() => ({
  created: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock('@bugsee/bugsee/node', async (importActual) => {
  const actual = await importActual<typeof import('@bugsee/bugsee/node')>();
  return {
    ...actual,
    launch: (...[token, options]: Parameters<typeof actual.launch>) =>
      actual.launch(token, {
        ...options,
        onOtelSpanProcessor: (processor) => {
          const spy = vi.fn(processor.shutdown.bind(processor));
          processor.shutdown = spy as typeof processor.shutdown;
          created.push(spy);
          options?.onOtelSpanProcessor?.(processor);
        },
      }),
  };
});

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
  created.length = 0;
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

  it('spans ended on the processor registered at FIRST launch reach the NEW client', async () => {
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

  // --- R4H-3 / R4H-9: delegate lifetime --------------------------------------------------------
  const DELEGATE = Symbol.for('@bugsee/nextjs.spanProcessorDelegate');
  const targetOf = (carrier: object) =>
    (carrier as Record<symbol, { target?: BugseeSpanProcessor } | undefined>)[DELEGATE]?.target;
  const span = {
    spanContext: () => ({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'aaaaaaaaaaaaaaaa',
    }),
    name: 'x',
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: 1 },
  } as unknown as Parameters<BugseeSpanProcessor['onEnd']>[0];

  it('forceFlush and shutdown on the registered processor reach the NEW client after a relaunch', async () => {
    const carrier = {};
    started.push(registerServer('tok', opts(carrier)));
    const registered = attachBugseeOtelProvider.mock
      .calls[0]?.[0] as unknown as BugseeSpanProcessor;
    const oldTarget = targetOf(carrier) as BugseeSpanProcessor;
    started.push(await relaunch(opts(carrier)));
    const newTarget = targetOf(carrier) as BugseeSpanProcessor;
    expect(newTarget).not.toBe(oldTarget);
    const oldFlush = vi.spyOn(oldTarget, 'forceFlush');
    const oldShutdown = vi.spyOn(oldTarget, 'shutdown');
    const newFlush = vi.spyOn(newTarget, 'forceFlush');
    const newShutdown = vi.spyOn(newTarget, 'shutdown');
    await registered.forceFlush();
    await registered.shutdown();
    expect(newFlush).toHaveBeenCalledTimes(1);
    expect(newShutdown).toHaveBeenCalledTimes(1);
    expect(oldFlush).not.toHaveBeenCalled();
    expect(oldShutdown).not.toHaveBeenCalled();
  });

  it('stop() with no relaunch drops the stopped client from the delegate; late spans are dropped', async () => {
    const carrier = {};
    const client = registerServer('tok', opts(carrier));
    const registered = attachBugseeOtelProvider.mock
      .calls[0]?.[0] as unknown as BugseeSpanProcessor;
    const target = targetOf(carrier) as BugseeSpanProcessor;
    const onEnd = vi.spyOn(target, 'onEnd');
    await client.stop();
    expect(targetOf(carrier)).toBeUndefined(); // nothing retains the stopped client's processor
    // The client's own teardown of its processor still ran (the wrapper delegates, it does not replace).
    expect(created).toHaveLength(1);
    expect(created[0]).toHaveBeenCalledTimes(1);
    expect(() => {
      registered.onStart();
      registered.onEnd(span);
    }).not.toThrow();
    expect(onEnd).not.toHaveBeenCalled();
    await expect(registered.forceFlush()).resolves.toBeUndefined();
    await expect(registered.shutdown()).resolves.toBeUndefined();
  });

  it('a late shutdown of the OLD client does not drop the relaunched client', async () => {
    const carrier = {};
    started.push(registerServer('tok', opts(carrier)));
    const oldTarget = targetOf(carrier) as BugseeSpanProcessor;
    started.push(await relaunch(opts(carrier)));
    const newTarget = targetOf(carrier);
    expect(newTarget).toBeDefined();
    await oldTarget.shutdown(); // the old client's teardown running late
    expect(targetOf(carrier)).toBe(newTarget);
  });

  it('a relaunch after stop() binds the new client again', async () => {
    const carrier = {};
    const first = registerServer('tok', opts(carrier));
    await first.stop();
    expect(targetOf(carrier)).toBeUndefined();
    started.push(await relaunch(opts(carrier)));
    expect(targetOf(carrier)).toBeDefined();
  });

  it.each([
    ['otelConsume: false', { otelConsume: false }],
    ['performance monitoring off', { performanceMonitoring: false }],
  ])('creates no delegate and registers nothing when OTel is off (%s) (R4H-9)', (_n, over) => {
    const carrier = {};
    started.push(registerServer('tok', opts(carrier, over as Partial<NextjsServerOptions>)));
    expect(targetOf(carrier)).toBeUndefined();
    expect((carrier as Record<symbol, unknown>)[DELEGATE]).toBeUndefined();
    expect(attachBugseeOtelProvider).not.toHaveBeenCalled();
  });
});
